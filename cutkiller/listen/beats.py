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


@dataclass
class MusicStructure:
    """Lecture musicale de la grille de beats, pour monter « avec » le morceau et pas seulement en mesure."""
    energy_db: list[float]  # niveau RMS de chaque intervalle entre deux beats
    downbeats: list[int]  # indices des premiers temps de mesure (4/4)
    drops: list[int]  # indices où l'énergie monte nettement (entrée du refrain, drop)

    def level(self, i: int, phrase: int = 8, min_range_db: float = 3.0) -> float:
        """Énergie relative de la phrase autour du beat i : 0 = passage le plus calme, 1 = le plus fort.
        Lissée sur `phrase` beats (le rythme suit les sections, pas chaque temps) ; 0.5 partout si le
        morceau n'a pas de vraie dynamique (moins de `min_range_db` entre passages calmes et forts)."""
        e = np.asarray(self.energy_db, dtype=np.float64)
        if e.size == 0:
            return 0.5
        k = min(phrase, e.size)
        smooth = np.convolve(np.pad(e, (k // 2, k - k // 2 - 1), mode="edge"), np.ones(k) / k, mode="valid")
        if np.percentile(smooth, 90) - np.percentile(smooth, 10) < min_range_db:
            return 0.5
        return float((smooth < smooth[min(i, e.size - 1)] - 0.5).mean())

    def strong(self, i: int) -> bool:
        return i in self._strong

    def __post_init__(self):
        self._strong = set(self.downbeats) | set(self.drops)

    def from_beat(self, k: int) -> "MusicStructure":
        """Même structure, indices décalés pour une grille qui commence au beat k."""
        return MusicStructure(self.energy_db[k:], [d - k for d in self.downbeats if d >= k],
                              [d - k for d in self.drops if d >= k])


def music_structure(audio: np.ndarray, sr: int, beats: list[float], *, drop_db: float = 6.0,
                    window: int = 4) -> MusicStructure:
    """Énergie par beat, premiers temps de mesure (phase 4/4 la plus accentuée) et drops (hausse
    d'énergie >= `drop_db` entre les `window` beats d'avant et ceux d'après)."""
    if len(beats) < 2:
        return MusicStructure([], [], [])
    bounds = [int(b * sr) for b in beats] + [min(audio.size, int((2 * beats[-1] - beats[-2]) * sr))]
    energy = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        seg = audio[a:max(b, a + 1)]
        energy.append(float(10 * np.log10(np.mean(seg.astype(np.float64) ** 2) + 1e-10)) if seg.size else -100.0)
    env = onset_envelope(audio, sr)
    fps = sr / HOP
    accent = np.array([env[min(env.size - 1, int(b * fps))] if env.size else 0.0 for b in beats]) + \
        np.array(energy) / 100.0  # attaque + niveau : le premier temps est le plus appuyé
    phase = int(np.argmax([accent[p::4].mean() if accent[p::4].size else -1 for p in range(4)]))
    downbeats = list(range(phase, len(beats), 4))
    e = np.array(energy)
    rise = np.full(len(beats), -np.inf)
    for i in range(window, len(beats) - window + 1):
        rise[i] = e[i:i + window].mean() - e[i - window:i].mean()
    # sommets de la montée (et non premier dépassement du seuil : un seul temps fort tire la moyenne)
    drops = []
    for i in np.argsort(-rise):
        if rise[i] < drop_db:
            break
        if all(abs(int(i) - d) >= window for d in drops):
            drops.append(int(i))
    return MusicStructure(energy, downbeats, sorted(drops))
