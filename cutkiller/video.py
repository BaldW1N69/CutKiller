"""Video analysis: metadata, motion curve, shot boundaries, dark frames.

Frames are decoded by ffmpeg at low resolution (64x36 grey, 10 fps) and piped
to numpy, so analysis stays fast even on long rushes.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

AN_FPS = 10
AN_W, AN_H = 64, 36


def probe(path: str | Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    v = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if v is None:
        raise ValueError(f"no video stream in {path}")
    num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    duration = float(v.get("duration") or data["format"].get("duration") or 0)
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) in (90, 270):
        w, h = h, w
    return {
        "duration": round(duration, 4),
        "fps": round(fps, 4),
        "width": w,
        "height": h,
        "hasAudio": any(s["codec_type"] == "audio" for s in data["streams"]),
    }


def _frames(path: str | Path) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-an",
         "-vf", f"fps={AN_FPS},scale={AN_W}:{AN_H},format=gray",
         "-f", "rawvideo", "-"],
        check=True, capture_output=True,
    ).stdout
    n = len(raw) // (AN_W * AN_H)
    return np.frombuffer(raw[: n * AN_W * AN_H], dtype=np.uint8).reshape(n, AN_H, AN_W).astype(np.float32) / 255.0


def analyze_video(path: str | Path, cut_threshold: float | None = None, min_shot: float = 0.5) -> dict:
    meta = probe(path)
    fr = _frames(path)
    if len(fr) < 2:
        raise ValueError(f"video too short to analyse: {path}")

    diff = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))  # 0..1, len n-1
    # histogram distance is robust to camera motion; combine both
    hists = np.stack([np.histogram(f, bins=16, range=(0, 1))[0] for f in fr]).astype(np.float32)
    hists /= hists.sum(axis=1, keepdims=True) + 1e-9
    hdist = 0.5 * np.abs(np.diff(hists, axis=0)).sum(axis=1)  # 0..1
    cut_score = 0.5 * diff / (diff.max() + 1e-9) + 0.5 * hdist

    if cut_threshold is None:
        med = np.median(cut_score)
        mad = np.median(np.abs(cut_score - med)) + 1e-6
        cut_threshold = max(0.25, med + 8 * mad)

    min_gap = int(min_shot * AN_FPS)
    cuts: list[int] = []
    for i in range(1, len(cut_score) - 1):
        if cut_score[i] >= cut_threshold and cut_score[i] >= cut_score[i - 1] and cut_score[i] >= cut_score[i + 1]:
            if not cuts or i - cuts[-1] >= min_gap:
                cuts.append(i)
    # boundary between frame i and i+1 -> time of frame i+1
    bounds = [0.0] + [(c + 1) / AN_FPS for c in cuts] + [meta["duration"] or len(fr) / AN_FPS]

    # motion excludes the cut spikes themselves
    motion = diff.copy()
    for c in cuts:
        motion[max(0, c - 1): c + 2] = np.nan
    motion = np.nan_to_num(motion, nan=float(np.nanmedian(motion)) if np.isfinite(np.nanmedian(motion)) else 0.0)
    luma = fr.mean(axis=(1, 2))

    shots = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        ia, ib = int(a * AN_FPS), max(int(a * AN_FPS) + 1, int(b * AN_FPS) - 1)
        m = motion[ia:ib]
        shots.append({
            "start": round(a, 3),
            "end": round(b, 3),
            "motion": round(float(m.mean()) if m.size else 0.0, 5),
            "luma": round(float(luma[ia:ib].mean()) if ib > ia else 0.0, 4),
        })

    return {
        "src": str(Path(path).resolve()),
        **meta,
        "analysisFps": AN_FPS,
        "motion": [round(float(x), 5) for x in motion],
        "luma": [round(float(x), 4) for x in luma],
        "shots": shots,
    }
