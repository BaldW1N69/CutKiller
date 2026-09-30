"""Détection des beats d'une musique (librosa, ISC), raffinés sur les onsets."""

from __future__ import annotations

from typing import Any

import numpy as np

from .audio import load_mono

RATE = 22_050
HOP = 256  # 11.6 ms


def beats(request: dict[str, Any]) -> dict[str, Any]:
    import librosa

    y = load_mono(request["path"], RATE)
    onset_env = librosa.onset.onset_strength(y=y, sr=RATE, hop_length=HOP)
    tempo, frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=RATE, hop_length=HOP, units="frames")
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=RATE, hop_length=HOP, units="frames")
    # Snap each tracked beat to the strongest onset within ±60 ms: the tracker
    # smooths the tempo, the onset marks the actual hit.
    radius = round(0.06 * RATE / HOP)
    refined = []
    for f in frames:
        near = onsets[np.abs(onsets - f) <= radius]
        refined.append(int(near[np.argmax(onset_env[near])]) if len(near) else int(f))
    times = librosa.frames_to_time(np.array(refined, dtype=int), sr=RATE, hop_length=HOP)
    times = [_attack(y, t) for t in times]
    return {
        "tempoBpm": round(float(np.atleast_1d(tempo)[0]), 2),
        "beats": [round(float(t), 3) for t in times],
        "durationS": round(len(y) / RATE, 3),
    }


def _attack(y: np.ndarray, t: float, radius_s: float = 0.04) -> float:
    """Sample-accurate hit: where the 1 ms envelope first crosses half of the
    local rise, around the onset frame (the onset function peaks up to one hop late)."""
    a = max(0, int((t - radius_s) * RATE))
    b = min(len(y), int((t + radius_s) * RATE))
    hop = max(1, RATE // 1000)
    seg = np.abs(y[a:b])
    if len(seg) < hop * 4:
        return t
    env = np.array([seg[i : i + hop].max() for i in range(0, len(seg) - hop, hop)])
    lo, hi = float(np.percentile(env, 10)), float(env.max())
    if hi <= lo * 2:
        return t
    rise = np.argmax(env >= lo + 0.5 * (hi - lo))
    return (a + rise * hop) / RATE
