"""Détection d'onsets, de tempo (BPM) et de la grille de beats.

Implémentation numpy pure (flux spectral + autocorrélation + programmation dynamique
façon Ellis 2007), pour ne pas imposer librosa. Suffisant pour caler des coupes et des
SFX sur la musique.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

FRAME = 1024
HOP = 256


@dataclass
class BeatInfo:
    bpm: float
    beats: list[float] = field(default_factory=list)
    onsets: list[float] = field(default_factory=list)
    confidence: float = 0.0

    def to_dict(self) -> dict:
        return {
            "bpm": round(self.bpm, 1),
            "confidence": round(self.confidence, 2),
            "beats": [round(b, 3) for b in self.beats],
            "onsets": [round(o, 3) for o in self.onsets],
        }


def onset_envelope(audio: np.ndarray, sr: int) -> np.ndarray:
    """Flux spectral demi-redressé sur spectre log, normalisé."""
    if audio.size < FRAME:
        return np.zeros(0, dtype=np.float32)
    n_frames = 1 + (audio.size - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = audio[idx] * np.hanning(FRAME)[None, :]
    mag = np.log1p(100.0 * np.abs(np.fft.rfft(frames, axis=1)))
    flux = np.maximum(0.0, np.diff(mag, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    # retrait de la tendance locale pour garder les attaques
    k = max(1, int(0.5 * sr / HOP))
    trend = np.convolve(flux, np.ones(k) / k, mode="same")
    env = np.maximum(0.0, flux - trend)
    peak = env.max()
    return (env / peak).astype(np.float32) if peak > 0 else env.astype(np.float32)


def pick_onsets(env: np.ndarray, sr: int, delta: float = 0.15, min_gap_s: float = 0.08) -> list[float]:
    fps = sr / HOP
    min_gap = max(1, int(min_gap_s * fps))
    out: list[int] = []
    for i in range(1, env.size - 1):
        if env[i] >= delta and env[i] >= env[i - 1] and env[i] > env[i + 1]:
            if out and i - out[-1] < min_gap:
                if env[i] > env[out[-1]]:
                    out[-1] = i
                continue
            out.append(i)
    return [i / fps for i in out]


def estimate_tempo(env: np.ndarray, sr: int, bpm_min: float = 60.0, bpm_max: float = 200.0) -> tuple[float, float]:
    """Retourne (bpm, confiance 0..1) par autocorrélation pondérée autour de 120 BPM."""
    fps = sr / HOP
    if env.size < int(fps * 2):
        return 0.0, 0.0
    x = env - env.mean()
    ac = np.correlate(x, x, mode="full")[x.size - 1 :]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]
    lags = np.arange(ac.size)
    lo, hi = int(fps * 60 / bpm_max), int(fps * 60 / bpm_min)
    hi = min(hi, ac.size - 1)
    if hi <= lo:
        return 0.0, 0.0
    cand = lags[lo : hi + 1]
    bpms = 60.0 * fps / np.maximum(cand, 1)
    # préférence douce pour les tempos "musicaux" (log-gaussienne centrée sur 120)
    weight = np.exp(-0.5 * (np.log2(bpms / 120.0) / 1.0) ** 2)
    score = ac[cand] * weight
    best = int(np.argmax(score))
    lag = cand[best]
    # affinage sub-trame par interpolation parabolique
    if 0 < lag < ac.size - 1:
        a, b, c = ac[lag - 1], ac[lag], ac[lag + 1]
        denom = a - 2 * b + c
        shift = 0.5 * (a - c) / denom if denom != 0 else 0.0
        lag = lag + float(np.clip(shift, -0.5, 0.5))
    return 60.0 * fps / lag, float(np.clip(ac[cand][best], 0.0, 1.0))


def track_beats(env: np.ndarray, sr: int, bpm: float, tightness: float = 100.0) -> list[float]:
    """Suivi de beats par programmation dynamique (Ellis 2007)."""
    fps = sr / HOP
    if bpm <= 0 or env.size == 0:
        return []
    period = 60.0 * fps / bpm
    n = env.size
    score = env.astype(np.float64).copy()
    back = -np.ones(n, dtype=np.int64)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    offsets = np.arange(-hi, -lo + 1)
    penalty = -tightness * np.log(-offsets / period) ** 2 if offsets.size else np.zeros(0)
    for i in range(n):
        prev = i + offsets
        ok = prev >= 0
        if not ok.any():
            continue
        cand = score[prev[ok]] + penalty[ok]
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[i] += cand[j]
            back[i] = prev[ok][j]
    # démarrer depuis le meilleur beat de la fin du morceau
    tail = max(1, int(period))
    i = n - tail + int(np.argmax(score[-tail:]))
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    return [b / fps for b in reversed(beats)]


def analyze_beats(audio: np.ndarray, sr: int) -> BeatInfo:
    env = onset_envelope(audio, sr)
    bpm, conf = estimate_tempo(env, sr)
    return BeatInfo(bpm=bpm, beats=track_beats(env, sr, bpm), onsets=pick_onsets(env, sr), confidence=conf)


def snap(t: float, grid: list[float], tolerance: float) -> float:
    """Aligne `t` sur le point de grille le plus proche s'il est à moins de `tolerance` s."""
    if not grid:
        return t
    arr = np.asarray(grid)
    i = int(np.argmin(np.abs(arr - t)))
    return float(arr[i]) if abs(arr[i] - t) <= tolerance else t
