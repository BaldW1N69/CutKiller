"""Planners: turn analyses into a render-ready plan (JSON).

* plan_cut     -> edit decision list (EDL) for cutting existing footage on the beat
* plan_motion  -> props for the beat-synced motion-design composition

Both renderers (ffmpeg fast path and Remotion) consume the same EDL, so
the plan is the single source of truth and can be inspected/edited by hand.
"""
from __future__ import annotations

import random
from bisect import bisect_left

import numpy as np

DENSITY_STEP = {"beat": 1, "half": 2, "bar": 4}
AUTO_STEP = {"high": 1, "mid": 2, "low": 4}

ASPECTS = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}


def _level_at(sections: list[dict], t: float) -> str:
    for s in sections:
        if s["start"] - 1e-3 <= t < s["end"]:
            return s["level"]
    return sections[-1]["level"] if sections else "mid"


def _start_time(audio: dict, start: float, align: bool) -> float:
    if not align:
        return start
    for t in audio["downbeats"]:
        if t >= start - 0.02:
            return t
    return start


def cut_points(audio: dict, fps: int, t0: float, end: float, density: str = "auto",
               offset_frames: int = 0, min_frames: int = 6) -> tuple[list[int], int]:
    """Frames (relative to t0) where a new clip starts. Always starts with 0."""
    total = int(round((end - t0) * fps))
    forced = {s["start"] for s in audio["sections"]}
    if audio.get("drop") is not None:
        forced.add(audio["drop"])
    frames = {0}
    for b in audio["beats"]:
        t = b["t"]
        if t <= t0 or t >= end:
            continue
        step = AUTO_STEP[_level_at(audio["sections"], t)] if density == "auto" else DENSITY_STEP[density]
        if b["beatInBar"] % step == 0 or any(abs(t - f) < 0.03 for f in forced):
            frames.add(int(round((t - t0) * fps)) - offset_frames)
    pts = sorted(f for f in frames if 0 <= f < total)
    kept = [0]
    for f in pts[1:]:
        if f - kept[-1] >= min_frames:
            kept.append(f)
    if len(kept) > 1 and total - kept[-1] < min_frames:
        kept.pop()
    return kept, total


class _Library:
    """Candidate windows across all source videos, with motion normalisation."""

    def __init__(self, videos: list[dict]):
        self.videos = videos
        self.cum = []
        for v in videos:
            m = np.asarray(v["motion"], dtype=float)
            self.cum.append(np.concatenate([[0.0], np.cumsum(m)]))
        all_m = [s["motion"] for v in videos for s in v["shots"]] or [0.0]
        self.lo, self.hi = np.percentile(all_m, 10), np.percentile(all_m, 90)

    def motion(self, vi: int, a: float, b: float) -> float:
        fps = self.videos[vi]["analysisFps"]
        c = self.cum[vi]
        ia, ib = int(a * fps), max(int(a * fps) + 1, int(b * fps))
        ia, ib = min(ia, len(c) - 2), min(ib, len(c) - 1)
        raw = (c[ib] - c[ia]) / max(1, ib - ia)
        if self.hi - self.lo < 1e-9:
            return 0.5
        return float(np.clip((raw - self.lo) / (self.hi - self.lo), 0, 1))

    def windows(self, length: float, margin: float = 0.08):
        out = []
        for vi, v in enumerate(self.videos):
            for si, s in enumerate(v["shots"]):
                if s["luma"] < 0.05:  # skip black / fade frames
                    continue
                room = (s["end"] - margin) - (s["start"] + margin) - length
                if room < 0:
                    continue
                n = int(min(24, room / 0.25)) + 1
                for k in range(n):
                    a = s["start"] + margin + (room * k / max(1, n - 1) if n > 1 else 0)
                    out.append((vi, si, a, False))
        if not out:  # nothing fits inside a single shot: allow crossing cuts
            for vi, v in enumerate(self.videos):
                room = v["duration"] - length
                for k in range(int(max(0, room) / 0.5) + 1):
                    out.append((vi, -1, k * 0.5, True))
        return out


def _overlap(a: float, b: float, used: list[tuple[float, float]]) -> float:
    ov = sum(max(0.0, min(b, ub) - max(a, ua)) for ua, ub in used)
    return ov / max(1e-6, b - a)


def _pick_energy(lib: _Library, slots, rng: random.Random):
    used: dict[int, list[tuple[float, float]]] = {i: [] for i in range(len(lib.videos))}
    recent: list[tuple[int, int]] = []
    prev_vi = -1
    picks = []
    for length, target in slots:
        best, best_s = None, -1e9
        for vi, si, a, crossing in lib.windows(length):
            b = a + length
            m = lib.motion(vi, a, b)
            s = -abs(m - target)
            s -= 2.0 * _overlap(a, b, used[vi])
            s -= 0.3 if vi == prev_vi and len(lib.videos) > 1 else 0.0
            s -= 0.25 if (vi, si) in recent[-3:] else 0.0
            s -= 0.5 if crossing else 0.0
            s += rng.uniform(0, 0.05)
            if s > best_s:
                best, best_s = (vi, si, a, m), s
        vi, si, a, m = best
        used[vi].append((a, a + length))
        recent.append((vi, si))
        prev_vi = vi
        picks.append(best)
    return picks


def _pick_chrono(lib: _Library, slots):
    """Keep story order: walk through sources in order, spreading slots evenly."""
    timeline = []  # (vi, start, end, shot_index)
    for vi, v in enumerate(lib.videos):
        for si, s in enumerate(v["shots"]):
            timeline.append((vi, s["start"], s["end"], si))
    total_mat = sum(e - s for _, s, e, _ in timeline)
    need = sum(L for L, _ in slots)
    gap = max(0.0, (total_mat - need) / max(1, len(slots)))
    picks, ti, cursor = [], 0, timeline[0][1]
    for length, _ in slots:
        placed = False
        while ti < len(timeline):
            vi, s, e, si = timeline[ti]
            a = max(cursor, s)
            if a + length <= e:
                picks.append((vi, si, a, lib.motion(vi, a, a + length)))
                cursor = a + length + gap
                placed = True
                break
            ti += 1
            if ti < len(timeline):
                cursor = timeline[ti][1]
        if not placed:  # ran out of material: wrap around
            ti, cursor = 0, timeline[0][1]
            vi, s, e, si = max(timeline, key=lambda x: x[2] - x[1])
            picks.append((vi, si, s, lib.motion(vi, s, min(e, s + length))))
    return picks


def plan_cut(audio: dict, videos: list[dict], *, audio_src: str, fps: int = 30, aspect: str = "16:9",
             start: float = 0.0, duration: float | None = None, density: str = "auto",
             order: str = "energy", offset_frames: int = 0, min_frames: int = 6,
             align_start: bool = True, seed: int = 7, title: str | None = None) -> dict:
    if not videos:
        raise ValueError("at least one video analysis is required")
    width, height = ASPECTS[aspect]
    t0 = _start_time(audio, start, align_start)
    end = audio["duration"] if duration is None else min(audio["duration"], t0 + duration)
    cuts, total = cut_points(audio, fps, t0, end, density, offset_frames, min_frames)
    bounds = cuts + [total]

    beat_t = [b["t"] for b in audio["beats"]]

    def energy_between(a: float, b: float) -> float:
        i, j = bisect_left(beat_t, a - 1e-3), bisect_left(beat_t, b - 1e-3)
        vals = [audio["beats"][k]["energy"] for k in range(i, max(i + 1, j)) if k < len(beat_t)]
        return float(np.mean(vals)) if vals else 0.5

    slots = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        ta, tb = t0 + a / fps, t0 + b / fps
        slots.append(((b - a) / fps, energy_between(ta, tb)))

    # match on relative energy within this edit (calm parts -> calm shots, drop -> busiest shots)
    es = np.array([e for _, e in slots])
    span = es.max() - es.min()
    targets = [(L, float((e - es.min()) / span) if span > 1e-6 else 0.5) for L, e in slots]

    lib = _Library(videos)
    picks = _pick_chrono(lib, targets) if order == "chronological" else _pick_energy(lib, targets, random.Random(seed))

    def kind_at(frame: int) -> str:
        t = t0 + frame / fps
        if audio.get("drop") is not None and abs(t - audio["drop"]) < 0.05:
            return "drop"
        if any(abs(t - s["start"]) < 0.05 for s in audio["sections"]):
            return "section"
        nb = min(audio["beats"], key=lambda b: abs(b["t"] - t), default=None)
        return "downbeat" if nb and nb["isDownbeat"] and abs(nb["t"] - t) < 0.06 else "beat"

    clips = []
    for (a, b), (vi, si, src_start, m), (_, e) in zip(zip(bounds[:-1], bounds[1:]), picks, slots):
        clips.append({
            "src": videos[vi]["src"],
            "from": a,
            "durationInFrames": b - a,
            "trimBeforeSec": round(src_start, 4),
            "kind": kind_at(a),
            "energy": round(e, 3),
            "motion": round(m, 3),
            "shot": si,
        })

    accents = []
    for bt in audio["beats"]:
        if t0 - 1e-3 <= bt["t"] < end:
            f = int(round((bt["t"] - t0) * fps))
            accents.append({"frame": f, "strength": 1.0 if bt["isDownbeat"] else round(0.3 + 0.4 * bt["strength"], 3),
                            "downbeat": bt["isDownbeat"]})

    return {
        "version": 1,
        "mode": "cut",
        "fps": fps,
        "width": width,
        "height": height,
        "durationInFrames": total,
        "bpm": audio["bpm"],
        "audio": {"src": audio_src, "startSec": round(t0, 4)},
        "title": title,
        "drop": None if audio.get("drop") is None or not (t0 <= audio["drop"] < end) else int(round((audio["drop"] - t0) * fps)),
        "clips": clips,
        "accents": accents,
    }


def plan_motion(audio: dict, *, audio_src: str, title: str, subtitle: str = "", palette: list[str] | None = None,
                fps: int = 30, aspect: str = "16:9", start: float = 0.0, duration: float | None = None,
                hero: str = "first-downbeat") -> dict:
    """Beat-synced motion design: hero reveal on the first downbeat, scale-up on the next strong beat,
    smaller accents on the beats in between. Animation lengths are expressed in beats so the same
    design feels airy at 72 BPM and punchy at 128 BPM."""
    palette = palette or ["#FFEDD3", "#FEB649", "#895834"]
    width, height = ASPECTS[aspect]
    beats = [b for b in audio["beats"] if b["t"] >= start]
    if not beats:
        raise ValueError("no beats after start")
    beat_len = 60.0 / audio["bpm"] if audio["bpm"] > 0 else 0.5

    if hero == "drop" and audio.get("drop") is not None and audio["drop"] >= start:
        hero_t = audio["drop"]
    else:
        hero_t = next((b["t"] for b in beats if b["isDownbeat"] and b["t"] >= start + 0.25), beats[0]["t"])
    after = [b for b in beats if b["t"] > hero_t + 0.5 * beat_len]
    strong = next((b for b in after if b["isDownbeat"] or b["strength"] >= 0.85), after[0] if after else None)
    scale_t = strong["t"] if strong else hero_t + 4 * beat_len

    end = audio["duration"] if duration is None else min(audio["duration"], start + duration)
    total = int(round((end - start) * fps))

    def fr(t: float) -> int:
        return int(round((t - start) * fps))

    return {
        "version": 1,
        "mode": "motion",
        "fps": fps,
        "width": width,
        "height": height,
        "durationInFrames": total,
        "bpm": audio["bpm"],
        "beatFrames": round(beat_len * fps, 3),
        "feel": "airy" if audio["bpm"] < 100 else "punchy",
        "audio": {"src": audio_src, "startSec": round(start, 4)},
        "title": title,
        "subtitle": subtitle,
        "palette": {"paper": palette[0], "accent": palette[1], "ink": palette[2]},
        "heroFrame": fr(hero_t),
        "scaleFrame": fr(scale_t),
        "beats": [{"frame": fr(b["t"]), "strength": b["strength"], "downbeat": b["isDownbeat"],
                   "energy": b["energy"]} for b in beats if b["t"] < end],
    }
