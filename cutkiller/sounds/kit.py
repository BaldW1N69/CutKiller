"""Kits de sound design : chaque événement du montage reçoit le son qui lui correspond, calé sur son impact.

Règles du kit `cinematic` (relevées sur les montages cinématiques type « My most used SFX ») :

| Événement du montage                           | Son        | Calage                              |
|------------------------------------------------|------------|-------------------------------------|
| plan d'ouverture (plan d'ensemble)             | focus      | bip d'autofocus au début du plan    |
| transition en mouvement (whip, zoom, slide…)   | whoosh     | le pic du souffle tombe sur la coupe |
| flash blanc / arrêt sur image                  | flash      | le déclic commence sur la coupe     |
| glitch / aberration chromatique                | glitch     | l'attaque commence sur la coupe     |
| coupe sèche sur le temps (montage rythmé)      | click      | l'attaque commence sur la coupe     |
| montée de tension avant le premier gros raccord | riser      | le sommet du riser tombe sur la coupe |
| dernier plan (fin calme)                       | ambience   | nappe d'ambiance en fondu, très bas |

Un fondu, une dissolution ou un volet doux ne reçoit pas de son : un whoosh sur un fondu sonne faux.

Le calage se fait sur le *pic* (ou l'attaque) mesuré dans le fichier, pas sur son début : un whoosh
de 1,2 s dont le souffle culmine à 0,7 s démarre 0,7 s avant la coupe, quel que soit le fichier choisi.
Les sons viennent d'abord du dossier local (CUTKILLER_SOUNDS_DIR : ton propre pack, ex. « Whoosh
Cinematic.wav », « Camera Focus.mp3 »), puis des banques libres de droits (Openverse, Freesound).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from cutkiller.media import ANALYSIS_SR, load_audio


@dataclass(frozen=True)
class Role:
    name: str
    queries: tuple[str, ...]  # essayées dans l'ordre (dossier local d'abord, puis banques)
    align: str  # peak : le maximum d'énergie sur l'événement ; onset : l'attaque ; start : le début du fichier
    gain_db: float
    max_duration: float
    description: str


ROLES: dict[str, Role] = {r.name: r for r in [
    Role("whoosh", ("whoosh cinematic", "whoosh", "swoosh"), "peak", -9.0, 3.0,
         "transitions en mouvement : whip pan, zoom, slide, spin"),
    Role("flash", ("camera flash", "camera shutter", "shutter"), "onset", -8.0, 2.0,
         "flash blanc, arrêt sur image, effet photo"),
    Role("glitch", ("glitch", "digital glitch"), "onset", -12.0, 2.0, "glitch, aberration chromatique"),
    Role("click", ("click",), "onset", -14.0, 1.0, "coupe sèche calée sur le temps"),
    Role("riser", ("riser build up", "riser", "build up"), "peak", -11.0, 8.0,
         "montée de tension qui culmine sur le premier gros raccord"),
    Role("focus", ("camera focus", "autofocus", "focus beep"), "onset", -15.0, 2.0,
         "ouverture : mise au point sur le plan d'ensemble"),
    Role("ambience", ("rain ambience", "city ambience", "room tone"), "start", -24.0, 120.0,
         "nappe d'ambiance sous le dernier plan"),
]}


@dataclass(frozen=True)
class Kit:
    name: str
    description: str
    clicks: bool = False  # un clic sur les coupes sèches (montages rythmés seulement)
    riser: bool = False
    opening: bool = False  # bip de mise au point sur le plan d'ouverture
    ambience: bool = False  # nappe sous le dernier plan
    roles: dict[str, str] = field(default_factory=dict)  # remplacements rôle → source par défaut du kit


KITS: dict[str, Kit] = {k.name: k for k in [
    Kit("cinematic", "focus à l'ouverture, whoosh/flash/glitch sur les transitions, clic sur les coupes sèches, "
                     "riser vers le premier gros raccord, ambiance sur la fin", clicks=True, riser=True,
        opening=True, ambience=True),
    Kit("minimal", "seulement le son de chaque transition (whoosh, flash, glitch) : sûr sur de la parole"),
]}

MOTION_TAGS = {"motion-blur", "zoom", "spin", "slide", "push", "shake", "warp", "bounce", "rotate", "dynamic"}
MOTION_WORDS = ("whip", "zoom", "slide", "push", "spin", "swipe", "swirl", "rotate", "squeeze", "cube", "door")
GLITCH_TAGS = {"glitch", "chromatic", "static", "noise"}
RISER_MIN_TIME = 3.0


def role_for(transition) -> str | None:
    """Rôle sonore d'une transition (None : transition douce, pas de son)."""
    if transition is None:
        return None
    name = transition.name.lower()
    tags = {t.lower() for t in transition.tags}
    if "flash" in name or "flash" in tags:
        return "flash"
    if "glitch" in name or "rgb" in name or tags & GLITCH_TAGS:
        return "glitch"
    if any(w in name for w in MOTION_WORDS) or tags & MOTION_TAGS:
        return "whoosh"
    return None


@dataclass
class Event:
    role: str
    time: float  # instant de l'événement dans la vidéo finale (s)
    length: float | None = None  # pour une nappe : durée à couvrir


def plan_events(kit: Kit, duration: float, cut_times: list[float], transitions: list[tuple[float, object]], *,
                clicks: bool | None = None, min_gap: float = 0.35) -> list[Event]:
    """Place les événements sonores du kit sur le montage. `transitions` = [(instant, Transition)]."""
    events: list[Event] = []
    trans_at = {round(t, 3): tr for t, tr in transitions}
    for t, tr in transitions:
        role = role_for(tr)
        if role:
            events.append(Event(role, t))
    use_clicks = kit.clicks if clicks is None else clicks
    if use_clicks:
        for t in cut_times:
            if round(t, 3) not in trans_at and all(abs(t - e.time) >= min_gap for e in events):
                events.append(Event("click", t))
    if kit.riser and duration >= 6.0:
        # après l'accroche (3 s) : il faut de la place pour que la tension monte
        big = [e.time for e in events if e.role in ("whoosh", "flash", "glitch") and e.time >= RISER_MIN_TIME]
        if big:
            events.append(Event("riser", big[0]))
    if kit.opening and duration >= 3.0:
        events.append(Event("focus", 0.15))
    if kit.ambience and cut_times:
        last = max(cut_times)
        if duration - last >= 1.5:
            events.append(Event("ambience", last, length=duration - last))
    return sorted(events, key=lambda e: (e.time, e.role))


def hit_time(path: str | Path, align: str = "peak", sr: int = ANALYSIS_SR) -> float:
    """Instant (s) du point à caler sur l'événement : maximum d'énergie (peak), attaque (onset) ou 0 (start)."""
    if align == "start":
        return 0.0
    audio = load_audio(path, sr)
    hop = max(1, sr // 100)  # 10 ms
    n = audio.size // hop
    if n < 2:
        return 0.0
    env = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    peak = int(env.argmax())
    if align == "onset":
        above = np.nonzero(env[: peak + 1] >= 0.3 * env[peak])[0]
        idx = int(above[0]) if above.size else peak
    else:
        idx = peak
    return idx * hop / sr


def parse_overrides(specs: list[str] | None) -> dict[str, str]:
    """['whoosh=sons/w.wav', 'riser=epic riser'] → {'whoosh': ..., 'riser': ...}"""
    out: dict[str, str] = {}
    for s in specs or []:
        role, sep, src = s.partition("=")
        role = role.strip().lower()
        if not sep or not src.strip():
            raise ValueError(f"--kit-sound invalide « {s} » : format attendu rôle=fichier_ou_requête")
        if role not in ROLES:
            raise ValueError(f"Rôle inconnu « {role} » (rôles : {', '.join(ROLES)})")
        out[role] = src.strip()
    return out


__all__ = ["ROLES", "KITS", "Role", "Kit", "Event", "role_for", "plan_events", "hit_time", "parse_overrides"]
