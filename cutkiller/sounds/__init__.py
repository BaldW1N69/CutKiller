"""Bibliothèque de sons : recherche multi-banques, cache local et crédits."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from cutkiller.sounds.base import USER_AGENT, Kind, Sound
from cutkiller.sounds.providers import all_providers

DEFAULT_ORDER = ["local", "openverse", "freesound", "jamendo"]


def cache_dir() -> Path:
    root = os.environ.get("CUTKILLER_CACHE") or os.path.join(os.environ.get("XDG_CACHE_HOME", "~/.cache"), "cutkiller")
    p = Path(root).expanduser() / "sounds"
    p.mkdir(parents=True, exist_ok=True)
    return p


def search(
    query: str,
    *,
    kind: Kind = "any",
    providers: list[str] | None = None,
    limit: int = 10,
    max_duration: float | None = None,
    min_duration: float | None = None,
    commercial: bool = True,
) -> tuple[list[Sound], dict[str, str]]:
    """Cherche sur toutes les banques disponibles. Retourne (sons, erreurs par provider)."""
    registry = all_providers()
    names = providers or DEFAULT_ORDER
    results: list[Sound] = []
    errors: dict[str, str] = {}
    for name in names:
        p = registry.get(name)
        if p is None:
            errors[name] = "provider inconnu"
            continue
        if not p.available():
            if providers:  # demandé explicitement → on signale pourquoi il ne répond pas
                errors[name] = "non configuré (clé API / dossier manquant)"
            continue
        try:
            results += p.search(query, kind=kind, limit=limit, max_duration=max_duration,
                                min_duration=min_duration, commercial=commercial)
        except Exception as exc:  # noqa: BLE001 - une banque en panne ne doit pas bloquer les autres
            errors[name] = f"{type(exc).__name__}: {exc}"
    return results, errors


def download(sound: Sound, dest_dir: Path | None = None) -> Path:
    """Télécharge (ou réutilise depuis le cache) et retourne le chemin local."""
    if sound.download_url.startswith("file://"):
        return Path(urlparse(sound.download_url).path)
    dest_dir = dest_dir or cache_dir() / sound.provider
    dest_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(sound.ref.encode()).hexdigest()[:12]
    dest = dest_dir / f"{key}.{sound.ext or 'mp3'}"
    meta = dest.with_suffix(".json")
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    req = urllib.request.Request(sound.download_url, headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:  # noqa: S310
        shutil.copyfileobj(resp, fh)
    tmp.replace(dest)
    meta.write_text(json.dumps(sound.to_dict(), ensure_ascii=False, indent=2))
    return dest


def rank_music(candidates: list[Sound], target_duration: float) -> list[Sound]:
    """Classe les morceaux : d'abord ceux assez longs pour couvrir la vidéo sans boucle
    (le plus court d'abord, pour garder sa fin), puis les autres du plus long au plus court."""
    long_enough = sorted((s for s in candidates if s.duration and s.duration >= target_duration), key=lambda s: s.duration)
    rest = sorted((s for s in candidates if s not in long_enough), key=lambda s: -(s.duration or 0))
    return long_enough + rest


def pick_music(candidates: list[Sound], target_duration: float) -> Sound | None:
    ranked = rank_music(candidates, target_duration)
    return ranked[0] if ranked else None


def fetch_first(candidates: list[Sound], on_error=None) -> tuple[Sound, Path] | None:
    """Télécharge le premier candidat disponible (un CDN peut refuser ou être en panne)."""
    for s in candidates:
        try:
            return s, download(s)
        except OSError as exc:  # HTTPError, URLError, timeout…
            if on_error:
                on_error(s, exc)
    return None


class Credits:
    """Accumule les attributions à publier en description (obligatoire pour CC-BY)."""

    def __init__(self) -> None:
        self.items: list[Sound] = []

    def add(self, sound: Sound) -> None:
        if sound.provider == "local":  # tes propres sons / packs achetés : rien à créditer
            return
        if sound.ref not in {s.ref for s in self.items}:
            self.items.append(sound)

    def text(self) -> str:
        if not self.items:
            return ""
        lines = ["Sons et musiques :"] + [f"- {s.attribution()}" for s in self.items]
        nc = [s for s in self.items if not s.commercial_ok]
        if nc:
            lines += ["", "ATTENTION : licence NC/ND, interdit en vidéo monétisée :"] + [f"- {s.title} ({s.license})" for s in nc]
        return "\n".join(lines) + "\n"

    def write(self, path: str | Path) -> Path | None:
        txt = self.text()
        if not txt:
            return None
        path = Path(path)
        path.write_text(txt, encoding="utf-8")
        return path


__all__ = ["Sound", "search", "download", "rank_music", "pick_music", "fetch_first", "Credits", "cache_dir"]
