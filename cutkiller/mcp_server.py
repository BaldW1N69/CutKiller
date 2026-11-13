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
fichier produit et le contenu du fichier de crédits."""

WAIT_DEFAULT = 40.0
WAIT_MAX = 55.0
EXPORT_RX = re.compile(r"^(?:Export|Aperçu|Rapport JSON|Sous-titres|Galerie)\s*:\s*(.+?)\s*$")
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
                       extra_args: list[str] | None = None) -> str:
        """Pipeline complet sur UNE vidéo (face caméra, tuto, podcast filmé) : écoute → coupe silences (et « euh »)
        → transitions → musique de fond avec ducking + SFX → loudness. music et chaque sfx = fichier local OU requête
        texte cherchée sur les banques libres de droits (ex. 'lofi chill', 'whoosh@transitions', 'pop@2.5,8').
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
        a += list(extra_args or [])
        return _dumps(launch(a))

    @tool
    def cutkiller_cut(path: str, output: str | None = None, transition: str | None = None,
                      transition_duration: float = 0.4, transition_every: int = 1, remove_fillers: bool = False,
                      padding: float = 0.08, min_silence: float = 0.35, threshold_db: float | None = None,
                      dry_run: bool = False, seed: int | None = None, jl: float = 0.0, audio_fade: float = 0.03,
                      extra_args: list[str] | None = None) -> str:
        """Jump cuts seuls : supprime silences (et « euh » si remove_fillers) avec marge de respiration, transitions
        optionnelles. dry_run=True liste les segments gardés sans rendre (pour valider avant un long rendu)."""
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
                          extra_args: list[str] | None = None) -> str:
        """Montage de PLUSIEURS vidéos et/ou photos (dans l'ordre donné), chaque coupe calée sur un temps de la
        musique (beats_per_clip=4 → un clip par mesure ; 2 pour plus nerveux). Photos animées (Ken Burns).
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


def main() -> None:
    build_server().run()


if __name__ == "__main__":
    main()
