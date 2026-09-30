"""Décodage audio commun aux workers (via FFmpeg, pour accepter tout conteneur)."""

from __future__ import annotations

import os
import subprocess

import numpy as np


def load_mono(path: str, rate: int = 16_000) -> np.ndarray:
    ffmpeg = os.environ.get("CUTKILLER_FFMPEG", "ffmpeg")
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
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
