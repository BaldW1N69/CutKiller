"""Serveur MCP (stdio) : donne à Claude des outils pour monter des vidéos avec CutKiller.

Lancement :  cutkiller-mcp      (ou : python -m cutkiller.mcp_server)

Le serveur tourne sur TA machine : il lit et écrit tes fichiers locaux, contrairement à un
conteneur cloud. Les rendus sont longs, donc les outils de montage démarrent un job en
arrière-plan, attendent ~40 s, puis rendent soit le résultat, soit un `job_id` à suivre avec
`cutkiller_job`. Ça évite les timeouts du client MCP.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path

INSTRUCTIONS = """\
CutKiller : montage vidéo piloté par l'écoute (silences, loudness, rythme), 280+ transitions,
musique + SFX libres de droits avec crédits, texte incrusté. Démarche : cutkiller_doctor la première
fois, cutkiller_listen pour diagnostiquer, puis cutkiller_auto (une vidéo) ou cutkiller_montage
(plusieurs clips/photos), cutkiller_text pour accroche/prix/appel à l'action. Les rendus renvoient
un job_id si ça dépasse ~40 s : appeler cutkiller_job. Toujours donner à l'utilisateur le chemin du
fichier produit et le contenu du fichier de crédits.
Animations : préréglages via cutkiller_animate ; animation sur mesure → écrire le code (Python frame(t, ctx),
ou page HTML/CSS/JS avec language='html' pour le motion design riche) et cutkiller_animate_code (renvoie les
images clés à regarder), puis cutkiller_overlay. Sound design : sfx_kit='cinematic' (montage) ou 'minimal'
(parole). Face caméra : punch_in=1.15 (jump cut fix). Finition : cutkiller_texture (look cinematic/night/film/
noir/retro, grain, pellicule scannée, dither, bandes cinéma). cutkiller_look montre des images
d'une vidéo pour vérifier le rendu avant de livrer."""

WAIT_DEFAULT = 40.0
WAIT_MAX = 55.0
EXPORT_RX = re.compile(r"^(?:Export|Aperçu|Rapport JSON|Sous-titres|Galerie)\s*:\s*(.+?)\s*$")
ANIM_DIR = Path(os.environ.get("CUTKILLER_ANIM_DIR", Path.home() / "CutKiller" / "animations"))
CREDITS_RX = re.compile(r"^Crédits à mettre en description\s*:\s*(.+?)\s*$")


# ------------------------------------------------------------------ jobs
class Job:
    def __init__(self, argv: list[str]):
        self.id = uuid.uuid4().hex[:8]
        self.argv = argv
        self.started = time.time()
        self.lines: deque[str] = deque(maxlen=800)
        self.lock = threading.Lock()
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "cutkiller", *argv],
            stdin=subprocess.DEVNULL,  # le stdin du serveur transporte le protocole MCP : ne jamais le partager
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
            env=env, creationflags=flags,
        )
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            with self.lock:
                self.lines.append(line.rstrip("\n"))

    @property
    def running(self) -> bool:
        return self.proc.poll() is None

    def wait(self, seconds: float) -> None:
        try:
            self.proc.wait(timeout=max(0.0, seconds))
        except subprocess.TimeoutExpired:
            return
        self.reader.join(timeout=2)

    def snapshot(self, tail: int = 40) -> dict:
        with self.lock:
            lines = list(self.lines)
        code = self.proc.poll()
        outputs, credits_file = [], None
        for ln in lines:
            if m := EXPORT_RX.match(ln):
                outputs.append(m.group(1))
            elif m := CREDITS_RX.match(ln):
                credits_file = m.group(1)
        out: dict = {
            "job_id": self.id,
            "status": "running" if code is None else ("done" if code == 0 else "failed"),
            "elapsed_s": round(time.time() - self.started, 1),
        }
        if code is not None:
            out["exit_code"] = code
        if outputs:
            out["outputs"] = outputs
        if credits_file and Path(credits_file).exists():
            out["credits_file"] = credits_file
            out["credits"] = Path(credits_file).read_text(encoding="utf-8", errors="replace")
        out["log"] = "\n".join(lines[-tail:])
        if code not in (None, 0):
            out["hint"] = "Voir le log. cutkiller_doctor vérifie l'installation (ffmpeg, OpenGL…)."
        return out


class JobRegistry:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}

    def start(self, argv: list[str]) -> Job:
        job = Job(argv)
        self.jobs[job.id] = job
        for old in [k for k, j in self.jobs.items() if not j.running and time.time() - j.started > 3600]:
            del self.jobs[old]
        return job

    def get(self, job_id: str) -> Job:
        if job_id not in self.jobs:
            raise KeyError(f"Job inconnu « {job_id} » (le serveur a peut-être redémarré).")
        return self.jobs[job_id]


JOBS = JobRegistry()


def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1)


def _need_files(paths: list[str]) -> dict | None:
    missing = [p for p in paths if not Path(p).expanduser().exists()]
    if missing:
        return {"status": "failed", "error": "Fichier(s) introuvable(s) : " + ", ".join(missing)
                + " — ce serveur lit les fichiers de la machine où il tourne."}
    return None


def launch(argv: list[str], wait: float = WAIT_DEFAULT, tail: int = 40) -> dict:
    job = JOBS.start(argv)
    job.wait(min(wait, WAIT_MAX))
    return job.snapshot(tail)


# ------------------------------------------------------------------ construction des commandes
def flag(args: list[str], name: str, value) -> None:
    if value is None or value is False or value == "":
        return
    args.append(name)
    if value is not True:
        args.append(str(value))


def repeat(args: list[str], name: str, values) -> None:
    for v in values or []:
        args += [name, str(v)]


def transition_args(a: list[str], transition, duration, every, min_gap, seed, jl, audio_fade) -> None:
    flag(a, "--transition", transition)
    if transition:
        flag(a, "--transition-duration", duration)
        flag(a, "--transition-every", every if every and every > 1 else None)
        flag(a, "--transition-min-gap", min_gap)
    flag(a, "--seed", seed)
    flag(a, "--jl", jl)
    flag(a, "--audio-fade", audio_fade)


def kit_args(a: list[str], sfx_kit, kit_sounds, kit_volume, sfx_align) -> None:
    flag(a, "--sfx-kit", sfx_kit)
    repeat(a, "--kit-sound", [f"{k}={v}" for k, v in (kit_sounds or {}).items()])
    flag(a, "--kit-volume", kit_volume)
    flag(a, "--sfx-align", sfx_align if sfx_align and sfx_align != "start" else None)


def mix_args(a: list[str], music, music_volume, music_start, no_duck, sfx, sfx_volume, target_lufs, no_normalize) -> None:
    flag(a, "--music", music)
    if music:
        flag(a, "--music-volume", music_volume)
        flag(a, "--music-start", music_start)
        flag(a, "--no-duck", no_duck)
    repeat(a, "--sfx", sfx)
    flag(a, "--sfx-volume", sfx_volume)
    flag(a, "--target-lufs", target_lufs)
    flag(a, "--no-normalize", no_normalize)


# ------------------------------------------------------------------ serveur
def build_server():
    try:
        from mcp.server.mcpserver import MCPServer as Server  # mcp >= 2
    except ImportError:
        try:
            from mcp.server.fastmcp import FastMCP as Server  # mcp 1.x
        except ImportError as exc:
            raise SystemExit("Le package 'mcp' est absent : pip install 'cutkiller[mcp]'") from exc
    try:
        server = Server("cutkiller", instructions=INSTRUCTIONS)
    except TypeError:
        server = Server("cutkiller")
    tool = server.tool()

    @tool
    def cutkiller_doctor() -> str:
        """Vérifie l'installation de CutKiller sur cette machine : ffmpeg, OpenGL (transitions GL), transcription,
        banques de sons. À appeler en premier si une commande échoue ou à la première utilisation."""
        from cutkiller.cli import run_doctor

        rows = run_doctor()
        return _dumps({"ok": not any(r["status"] == "fail" for r in rows), "checks": rows})

    @tool
    def cutkiller_listen(path: str, beats: bool = False, transcribe: bool = False, language: str | None = None,
                         threshold_db: float | None = None, min_silence: float = 0.35) -> str:
        """Écoute une vidéo/un audio : silences (part du temps, gain si on coupe), loudness EBU R128 avec alertes
        (trop faible, saturation, bruit), tempo si beats=True, transcription + .srt + « euh » si transcribe=True.
        Écrit <fichier>.listen.json. À faire AVANT de monter pour choisir les réglages."""
        if err := _need_files([path]):
            return _dumps(err)
        a = ["listen", str(Path(path).expanduser())]
        flag(a, "--beats", beats)
        flag(a, "--transcribe", transcribe)
        flag(a, "--language", language)
        flag(a, "--threshold", threshold_db)
        flag(a, "--min-silence", min_silence)
        return _dumps(launch(a, tail=60))

    @tool
    def cutkiller_auto(path: str, output: str | None = None, music: str | None = None, sfx: list[str] | None = None,
                       transition: str | None = None, transition_duration: float = 0.4, transition_every: int = 1,
                       transition_min_gap: float = 0.0, remove_fillers: bool = False, padding: float = 0.08,
                       min_silence: float = 0.35, threshold_db: float | None = None, music_volume: float = -16.0,
                       music_start: float = 0.0, no_duck: bool = False, sfx_volume: float = -8.0,
                       target_lufs: float = -14.0, no_normalize: bool = False, seed: int | None = None,
                       jl: float = 0.0, audio_fade: float = 0.03, language: str | None = None,
                       sfx_kit: str | None = None, kit_sounds: dict[str, str] | None = None, kit_volume: float = 0.0,
                       sfx_align: str = "start", punch_in: float = 0.0, punch_pattern: str | None = None,
                       extra_args: list[str] | None = None) -> str:
        """Pipeline complet sur UNE vidéo (face caméra, tuto, podcast filmé) : écoute → coupe silences (et « euh »)
        → transitions → musique de fond avec ducking + SFX → loudness. music et chaque sfx = fichier local OU requête
        texte cherchée sur les banques libres de droits (ex. 'lofi chill', 'whoosh@transitions', 'pop@2.5,8').
        sfx_kit='minimal' : le bon son par transition (whoosh/flash/glitch), calé sur son pic ; pas de clic sur les
        coupes de parole. kit_sounds={'whoosh': 'mon_whoosh.wav'} remplace un son. sfx_align='peak' cale les sfx sur leur pic.
        punch_in=1.15 : « jump cut fix », alterne plan normal / resserré à chaque coupe avec une micro-rampe de 3 images
        (punch_pattern='1,1.15,1,1.3' pour un motif ; écart ≥ 10 %, max 1.35 conseillé).
        transition : 'fade', 'gl:Cube', 'fx:zoom_punch', 'random:dynamic', 'fade|gl:WhipPan'… (voir cutkiller_transitions).
        Renvoie le fichier produit et les crédits à coller en description."""
        if err := _need_files([path]):
            return _dumps(err)
        a = ["auto", str(Path(path).expanduser())]
        flag(a, "-o", output)
        flag(a, "--remove-fillers", remove_fillers)
        flag(a, "--padding", padding)
        flag(a, "--min-silence", min_silence)
        flag(a, "--threshold", threshold_db)
        flag(a, "--language", language)
        transition_args(a, transition, transition_duration, transition_every, transition_min_gap, seed, jl, audio_fade)
        mix_args(a, music, music_volume, music_start, no_duck, sfx, sfx_volume, target_lufs, no_normalize)
        kit_args(a, sfx_kit, kit_sounds, kit_volume, sfx_align)
        flag(a, "--punch-in", punch_in or None)
        flag(a, "--punch-pattern", punch_pattern)
        a += list(extra_args or [])
        return _dumps(launch(a))

    @tool
    def cutkiller_cut(path: str, output: str | None = None, transition: str | None = None,
                      transition_duration: float = 0.4, transition_every: int = 1, remove_fillers: bool = False,
                      padding: float = 0.08, min_silence: float = 0.35, threshold_db: float | None = None,
                      dry_run: bool = False, seed: int | None = None, jl: float = 0.0, audio_fade: float = 0.03,
                      punch_in: float = 0.0, punch_pattern: str | None = None,
                      extra_args: list[str] | None = None) -> str:
        """Jump cuts seuls : supprime silences (et « euh » si remove_fillers) avec marge de respiration, transitions
        optionnelles. dry_run=True liste les segments gardés sans rendre (pour valider avant un long rendu).
        punch_in=1.15 : alterne plan normal / resserré à chaque coupe (« jump cut fix »)."""
        if err := _need_files([path]):
            return _dumps(err)
        a = ["cut", str(Path(path).expanduser())]
        flag(a, "-o", output)
        flag(a, "--remove-fillers", remove_fillers)
        flag(a, "--padding", padding)
        flag(a, "--min-silence", min_silence)
        flag(a, "--threshold", threshold_db)
        flag(a, "--dry-run", dry_run)
        transition_args(a, transition, transition_duration, transition_every, 0.0, seed, jl, audio_fade)
        flag(a, "--punch-in", punch_in or None)
        flag(a, "--punch-pattern", punch_pattern)
        a += list(extra_args or [])
        return _dumps(launch(a, tail=80 if dry_run else 40))

    @tool
    def cutkiller_mix(path: str, output: str | None = None, music: str | None = None, sfx: list[str] | None = None,
                      cut_points: str | None = None, music_volume: float = -16.0, music_start: float = 0.0,
                      no_duck: bool = False, sfx_volume: float = -8.0, target_lufs: float = -14.0,
                      no_normalize: bool = False, extra_args: list[str] | None = None) -> str:
        """Ajoute seulement musique de fond (ducking sous la voix) + SFX + normalisation loudness à une vidéo déjà
        montée. sfx : 'whoosh@cuts' (avec cut_points='1.2,4.8'), 'pop@2.5,8', 'hit@beats:4'."""
        if err := _need_files([path]):
            return _dumps(err)
        a = ["mix", str(Path(path).expanduser())]
        flag(a, "-o", output)
        flag(a, "--cut-points", cut_points)
        mix_args(a, music, music_volume, music_start, no_duck, sfx, sfx_volume, target_lufs, no_normalize)
        a += list(extra_args or [])
        return _dumps(launch(a))

    @tool
    def cutkiller_montage(inputs: list[str], output: str | None = None, size: str | None = None,
                          music: str | None = None, beats_per_clip: int = 4, clip_duration: float = 2.0,
                          photo_duration: float = 3.0, max_duration: float | None = None,
                          transition: str | None = None, transition_duration: float = 0.4,
                          transition_every: int = 1, sfx: list[str] | None = None, keep_audio: bool = False,
                          fit: str = "crop", fps: float | None = None, music_volume: float = -16.0,
                          music_start: float = 0.0, target_lufs: float = -14.0, seed: int | None = None,
                          sfx_kit: str | None = None, kit_sounds: dict[str, str] | None = None,
                          kit_volume: float = 0.0, sfx_align: str = "start",
                          extra_args: list[str] | None = None) -> str:
        """Montage de PLUSIEURS vidéos et/ou photos (dans l'ordre donné), chaque coupe calée sur un temps de la
        musique (beats_per_clip=4 → un clip par mesure ; 2 pour plus nerveux). Photos animées (Ken Burns).
        sfx_kit='cinematic' : sound design complet calé sur les pics (focus à l'ouverture, whoosh sur whip/zoom,
        déclic sur flash, glitch, clic sur les coupes sèches, riser vers le 1er gros raccord, ambiance de fin).
        size : '1080x1920' vertical (TikTok/Reels/Shorts), '1920x1080' YouTube, '1080x1080' carré.
        Idéal pour pubs, récaps, reels. Pour ajouter accroche/prix/CTA, enchaîner avec cutkiller_text."""
        if err := _need_files(inputs):
            return _dumps(err)
        a = ["montage", *[str(Path(p).expanduser()) for p in inputs]]
        flag(a, "-o", output)
        flag(a, "--size", size)
        flag(a, "--fps", fps)
        flag(a, "--fit", fit if fit != "crop" else None)
        flag(a, "--beats-per-clip", beats_per_clip if beats_per_clip != 4 else None)
        flag(a, "--clip-duration", clip_duration if clip_duration != 2.0 else None)
        flag(a, "--photo-duration", photo_duration if photo_duration != 3.0 else None)
        flag(a, "--max-duration", max_duration)
        flag(a, "--keep-audio", keep_audio)
        transition_args(a, transition, transition_duration, transition_every, 0.0, seed, 0.0, None)
        mix_args(a, music, music_volume, music_start, False, sfx, -8.0, target_lufs, False)
        kit_args(a, sfx_kit, kit_sounds, kit_volume, sfx_align)
        a += list(extra_args or [])
        return _dumps(launch(a))

    @tool
    def cutkiller_text(path: str, texts: list[str] | None = None, srt: str | None = None, output: str | None = None,
                       size: float = 6.0, color: str = "white", box: bool = False, srt_position: str = "bottom",
                       font: str = "Arial", extra_args: list[str] | None = None) -> str:
        """Incruste du texte : accroche, prix, appel à l'action, sous-titres. texts = liste de
        'TEXTE@DÉBUT-FIN[:position[:couleur[:taille%]]]', ex. 'SOLDES -50 %@0-3:center:yellow:9%',
        'Code PUB10\\nlivraison offerte@5-' (fin vide = jusqu'à la fin). srt = fichier de sous-titres à graver.
        Zone sûre réseaux sociaux : texte bas évité sous 10 % de la hauteur (marges déjà gérées)."""
        if err := _need_files([path] + ([srt] if srt else [])):
            return _dumps(err)
        a = ["text", str(Path(path).expanduser())]
        flag(a, "-o", output)
        repeat(a, "--text", texts)
        flag(a, "--srt", srt)
        flag(a, "--srt-position", srt_position if srt else None)
        flag(a, "--size", size if size != 6.0 else None)
        flag(a, "--color", color if color != "white" else None)
        flag(a, "--box", box)
        flag(a, "--font", font if font != "Arial" else None)
        a += list(extra_args or [])
        return _dumps(launch(a))

    @tool
    def cutkiller_text_ass(path: str, ass_code: str, output: str | None = None) -> str:
        """Grave un script ASS écrit à la main (animations libass : \\move, \\t, \\fad, \\k, \\frz, \\blur, dessins \\p…)
        pour des effets de texte précis que les préréglages ne couvrent pas. PlayResX/Y = taille de la vidéo."""
        if err := _need_files([path]):
            return _dumps(err)
        ANIM_DIR.mkdir(parents=True, exist_ok=True)
        ass_path = ANIM_DIR / f"text_{uuid.uuid4().hex[:6]}.ass"
        ass_path.write_text(ass_code, encoding="utf-8")
        a = ["text", str(Path(path).expanduser()), "--ass", str(ass_path)]
        flag(a, "-o", output)
        res = launch(a)
        res["ass_file"] = str(ass_path)
        return _dumps(res)

    @tool
    def cutkiller_captions(path: str, words: str | None = None, transcribe: bool = False, style: str = "tiktok",
                           color: str = "white", active: str | None = None, size: float | None = None,
                           position: str | None = None, max_words: int | None = None, language: str | None = None,
                           output: str | None = None) -> str:
        """Sous-titres animés façon TikTok/Reels : groupes de mots, mot prononcé en couleur et qui « pop ».
        style : tiktok | bold | karaoke | minimal ; position : lower (défaut tiktok) | bottom | center | top.
        Mots horodatés : words=<vidéo>.listen.json (cutkiller_listen transcribe=True) ou transcribe=True."""
        if err := _need_files([path] + ([words] if words else [])):
            return _dumps(err)
        a = ["captions", str(Path(path).expanduser()), "--style", style]
        flag(a, "-o", output)
        flag(a, "--words", words)
        flag(a, "--transcribe", transcribe)
        flag(a, "--language", language)
        flag(a, "--color", color if color != "white" else None)
        flag(a, "--active", active)
        flag(a, "--size", size)
        flag(a, "--position", position)
        flag(a, "--max-words", max_words)
        return _dumps(launch(a))

    @tool
    def cutkiller_animate(name: str, params: dict[str, str] | None = None, output: str | None = None,
                          like: str | None = None, size: str | None = None, duration: float | None = None,
                          fps: float | None = None, font: str | None = None) -> str:
        """Rend une animation PRÉRÉGLÉE à fond transparent (.mov ProRes 4444 par défaut, .webm, .png).
        name : title | slide | typewriter | kinetic | lower_third | counter | cta | progress | logo | confetti |
        circle_highlight | arrow. params ex. {"text": "SOLDES -50 %", "color": "yellow"} ; kinetic : *mot* = accent.
        like=<vidéo> reprend taille et cadence. Puis incruster avec cutkiller_overlay. Pour une animation qui
        n'existe pas en préréglage : écrire le code et utiliser cutkiller_animate_code."""
        a = ["animate", name, *[f"{k}={v}" for k, v in (params or {}).items()]]
        flag(a, "-o", output or str(ANIM_DIR / f"{name}_{uuid.uuid4().hex[:6]}.mov"))
        flag(a, "--like", like)
        flag(a, "--size", size)
        flag(a, "--duration", duration)
        flag(a, "--fps", fps)
        flag(a, "--font", font)
        ANIM_DIR.mkdir(parents=True, exist_ok=True)
        return _dumps(launch(a))

    @tool
    def cutkiller_animate_code(code: str, name: str = "animation", preview_times: list[float] | None = None,
                               render: bool = False, output: str | None = None, like: str | None = None,
                               size: str | None = None, duration: float | None = None, fps: float | None = None,
                               language: str = "python"):
        """Animation SUR MESURE, en Python ou en HTML.
        language='python' : `code` = script définissant frame(t, ctx) → image RGBA (et DURATION, facultatif).
        Outils de ctx : blank(), text(img, txt, (x,y), size=, color=, alpha=, scale=, rotate=, stroke=), rect(), circle()
        (arcs), line(), polygon(), paste(img, 'logo.png', (x,y), scale=), glow(), prog(t, a, b, 'out_back'), in_out(),
        measure()/fit() ; coordonnées en fractions 0..1.
        language='html' : `code` = une page HTML autonome (CSS, JS, canvas, SVG, WebGL), comme les prompts de motion
        design (Prompt Motion…). Fond transparent (body{background:transparent}). Temps : définir
        window.cutkillerSeek(t) (recommandé, déterministe) OU utiliser animations CSS / requestAnimationFrame /
        performance.now (horloge pilotée image par image). Durée : <meta name="duration" content="4"> ou duration.
        window.CUTKILLER = {width, height, fps, duration} est disponible. Le code s'exécute sur cette machine.
        render=False : renvoie les IMAGES CLÉS (à regarder avant de valider). render=True : rend la vidéo à alpha."""
        ANIM_DIR.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w-]", "_", name)[:40] or "animation"
        if language not in ("python", "html"):
            return _dumps({"status": "error", "error": "language : 'python' ou 'html'"})
        script = ANIM_DIR / f"{safe}.{'html' if language == 'html' else 'py'}"
        script.write_text(code, encoding="utf-8")
        out = Path(output) if output else ANIM_DIR / f"{safe}.mov"
        a = ["animate", str(script), "-o", str(out)]
        flag(a, "--like", like)
        flag(a, "--size", size)
        flag(a, "--duration", duration)
        flag(a, "--fps", fps)
        if render:
            res = launch(a)
            res["script"] = str(script)
            return _dumps(res)
        a += ["--preview", ",".join(str(t) for t in preview_times) if preview_times else ""]
        res = launch(a, wait=50)
        res["script"] = str(script)
        return _with_sheet(res, [Path(p) for p in res.get("outputs", [])], ANIM_DIR / f"{safe}_sheet.png",
                           [f"t={Path(p).stem.split('_')[-1]}" for p in res.get("outputs", [])])

    @tool
    def cutkiller_look(path: str, times: list[float] | None = None, width: int = 360):
        """Montre des images d'une vidéo (ou d'une animation) aux instants donnés, sous forme d'image à regarder :
        vérifier cadrage, texte, transitions, incrustations avant de livrer. Défaut : 4 instants répartis."""
        if err := _need_files([path]):
            return _dumps(err)
        from cutkiller.media import probe, run_ffmpeg

        src = Path(path).expanduser()
        dur = probe(src).duration
        times = times or [round(dur * f, 2) for f in (0.1, 0.35, 0.6, 0.85)]
        tmp = ANIM_DIR / "look"
        tmp.mkdir(parents=True, exist_ok=True)
        frames = []
        for t in times:
            f = tmp / f"{src.stem}_{t:07.2f}.png"
            run_ffmpeg(["-ss", f"{max(0.0, min(t, dur - 0.05)):.3f}", "-i", str(src), "-frames:v", "1",
                        "-vf", f"scale={width}:-2", str(f)])
            frames.append(f)
        return _with_sheet({"status": "done", "file": str(src), "duration": round(dur, 2)}, frames,
                           tmp / f"{src.stem}_sheet.png", [f"{t:.2f} s" for t in times])

    @tool
    def cutkiller_texture(path: str, output: str | None = None, look: str | None = None, grade: str | None = None,
                          contrast: float | None = None, sharpen: float | None = None, glow: float | None = None,
                          letterbox: float | None = None, grain: float = 0.0, grain_file: str | None = None,
                          grain_mode: str = "overlay", grain_opacity: float = 0.6, dither: str | None = None,
                          colors: int = 16, pixel: int = 1, vignette: float = 0.0) -> str:
        """Finition : look complet (look = cinematic | night | film | noir | retro), ou réglages séparés : étalonnage
        (grade teal_orange|green_orange|warm|cold|bleach|bw), contrast/sharpen/glow 0..1 (noirs profonds, netteté
        « 4K », lueur « luminescence »), bandes cinéma (letterbox 2.39 ; pas sur du vertical), grain procédural
        (0.25 discret, 0.5 marqué), pellicule scannée bouclée (grain_file ; grain_mode overlay/softlight si fond
        gris, screen si fond noir), dither rétro (bayer|floyd_steinberg, colors 2-256, pixel 3-4), vignettage 0..1.
        Les réglages séparés modifient le look. À appliquer en fin de chaîne, avant le texte/sous-titres."""
        if err := _need_files([path] + ([grain_file] if grain_file else [])):
            return _dumps(err)
        a = ["texture", str(Path(path).expanduser())]
        flag(a, "-o", output)
        flag(a, "--look", look)
        flag(a, "--grade", grade)
        flag(a, "--contrast", contrast)
        flag(a, "--sharpen", sharpen)
        flag(a, "--glow", glow)
        flag(a, "--letterbox", letterbox)
        flag(a, "--grain", grain or None)
        flag(a, "--grain-file", grain_file)
        flag(a, "--grain-mode", grain_mode if grain_file else None)
        flag(a, "--grain-opacity", grain_opacity if grain_file else None)
        flag(a, "--dither", dither)
        if dither:
            flag(a, "--colors", colors)
            flag(a, "--pixel", pixel)
        flag(a, "--vignette", vignette or None)
        return _dumps(launch(a))

    @tool
    def cutkiller_overlay(path: str, layers: list[str], output: str | None = None) -> str:
        """Incruste des calques sur une vidéo : animations à alpha (.mov/.webm de cutkiller_animate), logos/images,
        vidéos fond vert ou fond noir. layers = specs 'SOURCE@DÉBUT[-FIN]?pos=…&scale=…&mode=…&opacity=…'
        ex. 'titre.mov@0.5', 'logo.png@0-3?pos=top-right&scale=0.2', 'leak.mp4@4?mode=screen', 'anim.mov@2?pos=0.5,0.4'."""
        srcs = [spec.partition("?")[0].rpartition("@")[0] or spec.partition("?")[0] for spec in layers]
        if err := _need_files([path] + srcs):
            return _dumps(err)
        a = ["overlay", str(Path(path).expanduser())]
        flag(a, "-o", output)
        repeat(a, "--add", layers)
        return _dumps(launch(a))

    @tool
    def cutkiller_sounds_search(query: str, kind: str = "any", limit: int = 10, max_duration: float | None = None,
                                min_duration: float | None = None, allow_nc: bool = False) -> str:
        """Cherche musiques/SFX dans les banques libres de droits (dossier local, Openverse, Freesound, Jamendo).
        kind : 'sfx' | 'music' | 'any'. Par défaut uniquement les licences compatibles avec une vidéo monétisée.
        Utile pour proposer le choix à l'utilisateur ; cutkiller_auto/montage résolvent aussi les requêtes seuls."""
        from cutkiller import sounds

        res, errors = sounds.search(query, kind=kind, limit=limit, max_duration=max_duration,
                                    min_duration=min_duration, commercial=not allow_nc)
        return _dumps({"results": [s.to_dict() | {"commercial_ok": s.commercial_ok} for s in res], "errors": errors})

    @tool
    def cutkiller_transitions(search: str | None = None, family: str | None = None, tag: str | None = None,
                              limit: int = 60) -> str:
        """Catalogue des 280+ transitions (xfade, gl, fx) filtrable par mot-clé, famille ou thème. Renvoie aussi
        la liste des thèmes utilisables avec transition='random:<thème>' (dynamic, clean, glitch, 3d, zoom…)."""
        from cutkiller.transitions import all_tags, catalog

        items = catalog()
        if family:
            items = [t for t in items if t.family == family]
        if tag:
            items = [t for t in items if tag.lower() in t.tags]
        if search:
            q = search.lower()
            items = [t for t in items if q in t.name.lower() or q in t.description.lower()]
        return _dumps({
            "total": len(items), "shown": min(limit, len(items)),
            "transitions": [{"id": t.id, "description": t.description[:90], "tags": t.tags} for t in items[:limit]],
            "themes": all_tags(),
            "syntax": "fade | gl:Cube | fx:zoom_punch | gl:WhipPan?blur=0.6 | random:dynamic | fade|gl:Cube | "
                      "pack:fichier.mov | luma:masque.png | glsl:shader.glsl",
        })

    @tool
    def cutkiller_transition_preview(name: str, size: str = "480x270", duration: float = 1.0,
                                     output: str | None = None) -> str:
        """Génère un court aperçu vidéo d'une transition (ex. 'gl:Cube') pour la montrer à l'utilisateur."""
        a = ["transitions", "preview", name, "--size", size, "--duration", str(duration)]
        flag(a, "-o", output)
        return _dumps(launch(a, wait=50))

    @tool
    def cutkiller_job(job_id: str, wait_seconds: float = 30.0, tail: int = 40) -> str:
        """Suit un rendu démarré par un autre outil (quand il a répondu status='running'). Attend jusqu'à
        wait_seconds (max 55) puis renvoie l'état, le fichier produit et les crédits."""
        try:
            job = JOBS.get(job_id)
        except KeyError as exc:
            return _dumps({"status": "failed", "error": str(exc)})
        job.wait(min(wait_seconds, WAIT_MAX))
        return _dumps(job.snapshot(tail))

    @tool
    def cutkiller_cancel(job_id: str) -> str:
        """Arrête un rendu en cours."""
        try:
            job = JOBS.get(job_id)
        except KeyError as exc:
            return _dumps({"status": "failed", "error": str(exc)})
        if job.running:
            job.proc.terminate()
            job.wait(5)
        return _dumps(job.snapshot(10))

    return server


def _with_sheet(res: dict, frames: list[Path], sheet: Path, labels: list[str]):
    """Renvoie le JSON + une planche d'images (contenu image MCP) pour que Claude voie le résultat."""
    text = _dumps(res)
    frames = [f for f in frames if f.suffix.lower() == ".png" and f.exists()]
    if not frames:
        return text
    from cutkiller.animate import contact_sheet

    contact_sheet(frames, sheet, labels)
    res["sheet"] = str(sheet)
    try:
        from mcp.types import ImageContent, TextContent
    except ImportError:
        return _dumps(res)
    import base64

    data = base64.b64encode(sheet.read_bytes()).decode()
    return [TextContent(type="text", text=_dumps(res)), ImageContent(type="image", data=data, mimeType="image/png")]


def main() -> None:
    build_server().run()


if __name__ == "__main__":
    main()
