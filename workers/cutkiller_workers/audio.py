"""Décodage audio commun aux workers (via FFmpeg, pour accepter tout conteneur)."""

from __future__ import annotations

import os
import subprocess

import numpy as np

# Same guard as @cutkiller/media (MEDIA_FORMATS): only local files of
# self-contained media formats are opened, never playlists or protocols.
MEDIA_FORMATS = (
    "mov,matroska,webm,avi,mpegts,flv,mxf,wav,w64,mp3,flac,ogg,aac,aiff,caf,"
    "image2,png_pipe,jpeg_pipe,webp_pipe,bmp_pipe,tiff_pipe,gif"
)


def media_input(path: str) -> list[str]:
    """`-i path` for a user media file, restricted to local media formats."""
    return ["-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-i", path]


def load_mono(path: str, rate: int = 16_000) -> np.ndarray:
    ffmpeg = os.environ.get("CUTKILLER_FFMPEG", "ffmpeg")
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        *media_input(path),
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(rate),
        "-f",
        "f32le",
        "-",
    ]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).copy()
