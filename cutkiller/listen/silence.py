"""Détection des silences / segments de parole par énergie RMS.

Seuil adaptatif par défaut : on estime le bruit de fond (percentile bas) et le niveau
de la voix (percentile haut), puis on place le seuil entre les deux. Ça marche aussi
bien sur un micro-cravate propre que sur une prise de vue bruitée, sans réglage.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

HOP_S = 0.01  # 10 ms
WIN_S = 0.03  # 30 ms


@dataclass(frozen=True)
class Interval:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        return {"start": round(self.start, 3), "end": round(self.end, 3)}


def frame_db(audio: np.ndarray, sr: int, hop_s: float = HOP_S, win_s: float = WIN_S) -> np.ndarray:
    """Niveau RMS en dBFS par trame (une valeur toutes les `hop_s` secondes)."""
    hop = max(1, int(sr * hop_s))
    win = max(hop, int(sr * win_s))
    if audio.size == 0:
        return np.zeros(0, dtype=np.float32)
    n = 1 + max(0, (audio.size - 1) // hop)
    padded = np.concatenate([audio, np.zeros(win, dtype=audio.dtype)])
    sq = np.concatenate([[0.0], np.cumsum(padded.astype(np.float64) ** 2)])
    starts = np.arange(n) * hop
    energy = (sq[starts + win] - sq[starts]) / win
    return (10.0 * np.log10(energy + 1e-12)).astype(np.float32)


def auto_threshold(db: np.ndarray) -> float:
    if db.size == 0:
        return -40.0
    noise = float(np.percentile(db, 10))
    speech = float(np.percentile(db, 90))
    if speech - noise < 6.0:  # dynamique quasi nulle : tout est silence ou tout est son
        return -50.0 if speech < -50.0 else noise - 1.0
    return float(np.clip(noise + 0.35 * (speech - noise), -60.0, -18.0))


def detect_silences(
    audio: np.ndarray,
    sr: int,
    *,
    threshold_db: float | None = None,
    min_silence: float = 0.35,
) -> tuple[list[Interval], float]:
    """Retourne (silences, seuil utilisé). Un silence doit durer au moins `min_silence` s."""
    db = frame_db(audio, sr)
    thr = auto_threshold(db) if threshold_db is None else float(threshold_db)
    total = audio.size / sr
    quiet = db < thr
    silences: list[Interval] = []
    if quiet.size == 0:
        return silences, thr
    edges = np.diff(np.concatenate([[0], quiet.astype(np.int8), [0]]))
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1)
    for s, e in zip(starts, ends):
        start, end = s * HOP_S, min(e * HOP_S, total)
        if end - start >= min_silence:
            silences.append(Interval(start, end))
    return silences, thr


def complement(intervals: list[Interval], total: float) -> list[Interval]:
    """Segments non couverts par `intervals` (supposés triés et disjoints) dans [0, total]."""
    out: list[Interval] = []
    cursor = 0.0
    for iv in intervals:
        if iv.start > cursor:
            out.append(Interval(cursor, iv.start))
        cursor = max(cursor, iv.end)
    if cursor < total:
        out.append(Interval(cursor, total))
    return out
