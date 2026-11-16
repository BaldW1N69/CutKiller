"""Accès bas niveau aux médias via ffmpeg / ffprobe."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ANALYSIS_SR = 16_000


class MediaError(RuntimeError):
    pass


def _require(binary: str) -> str:
    path = shutil.which(binary)
    if not path:
        raise MediaError(f"'{binary}' introuvable. Installe ffmpeg (https://ffmpeg.org/download.html).")
    return path


@dataclass(frozen=True)
class MediaInfo:
    path: Path
    duration: float
    has_video: bool
    has_audio: bool
    width: int | None = None
    height: int | None = None
    fps: float | None = None


def probe(path: str | Path) -> MediaInfo:
    path = Path(path)
    if not path.exists():
        raise MediaError(f"Fichier introuvable : {path}")
    out = subprocess.run(
        [_require("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise MediaError(f"ffprobe a échoué sur {path}: {out.stderr.strip()}")
    data = json.loads(out.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and s.get("disposition", {}).get("attached_pic") != 1), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(data.get("format", {}).get("duration") or 0.0)
    fps = None
    if video and video.get("avg_frame_rate", "0/0") != "0/0":
        num, den = video["avg_frame_rate"].split("/")
        fps = float(num) / float(den) if float(den) else None
    return MediaInfo(
        path=path,
        duration=duration,
        has_video=video is not None,
        has_audio=audio is not None,
        width=video.get("width") if video else None,
        height=video.get("height") if video else None,
        fps=fps,
    )


def load_audio(path: str | Path, sr: int = ANALYSIS_SR) -> np.ndarray:
    """Décode la piste audio en mono float32 [-1, 1] à la fréquence `sr`."""
    out = subprocess.run(
        [_require("ffmpeg"), "-nostdin", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
        capture_output=True,
    )
    if out.returncode != 0:
        raise MediaError(f"Décodage audio impossible ({path}): {out.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def run_ffmpeg(args: list[str], *, quiet: bool = True, cwd: str | Path | None = None) -> subprocess.CompletedProcess:
    cmd = [_require("ffmpeg"), "-nostdin", "-y", "-hide_banner"]
    if quiet:
        cmd += ["-v", "error"]
    out = subprocess.run(cmd + args, capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=cwd)
    if out.returncode != 0:
        raise MediaError(f"ffmpeg a échoué :\n{' '.join(cmd + args)[:2000]}\n{out.stderr[-3000:]}")
    return out
