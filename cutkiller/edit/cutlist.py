"""Construction de la liste des segments à garder (jump cuts)."""

from __future__ import annotations

from dataclasses import dataclass

from cutkiller.listen.beats import snap
from cutkiller.listen.silence import Interval


@dataclass(frozen=True)
class CutSettings:
    padding: float = 0.08  # marge de respiration gardée autour de la parole
    min_keep: float = 0.20  # un segment plus court est un bruit parasite (clic, souffle)
    min_gap: float = 0.25  # une coupe plus courte n'est pas rentable visuellement


def merge(intervals: list[Interval], gap: float = 0.0) -> list[Interval]:
    out: list[Interval] = []
    for iv in sorted(intervals, key=lambda i: i.start):
        if out and iv.start - out[-1].end <= gap:
            out[-1] = Interval(out[-1].start, max(out[-1].end, iv.end))
        else:
            out.append(iv)
    return out


def build_keep_segments(
    total: float,
    remove: list[Interval],
    settings: CutSettings = CutSettings(),
) -> list[Interval]:
    """Segments à garder = [0,total] moins les zones à retirer (rétrécies de `padding`)."""
    shrunk = []
    for r in merge(remove):
        start = r.start + (settings.padding if r.start > 0 else 0.0)
        end = r.end - (settings.padding if r.end < total else 0.0)
        if end - start >= settings.min_gap:
            shrunk.append(Interval(max(0.0, start), min(total, end)))
    keep: list[Interval] = []
    cursor = 0.0
    for r in shrunk:
        if r.start > cursor:
            keep.append(Interval(cursor, r.start))
        cursor = max(cursor, r.end)
    if cursor < total:
        keep.append(Interval(cursor, total))
    return [k for k in keep if k.duration >= settings.min_keep]


def snap_segments(segments: list[Interval], grid: list[float], tolerance: float = 0.12) -> list[Interval]:
    """Cale les bords de segments sur une grille (beats, onsets) quand c'est proche."""
    out = []
    for s in segments:
        a, b = snap(s.start, grid, tolerance), snap(s.end, grid, tolerance)
        if b - a > 0.05:
            out.append(Interval(a, b))
    return out


def output_cut_points(segments: list[Interval]) -> list[float]:
    """Instants (dans la vidéo montée) où se trouvent les coupes."""
    t, points = 0.0, []
    for s in segments[:-1]:
        t += s.duration
        points.append(round(t, 3))
    return points


def total_duration(segments: list[Interval]) -> float:
    return sum(s.duration for s in segments)
