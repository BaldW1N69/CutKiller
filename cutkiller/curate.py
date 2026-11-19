"""Footage curation: keep only the takes where the group is in place and composed.

A frame is "ready" when:
  * every member is visible: face count equals the group size (the most common count
    among calm frames), faces not overlapping (nobody hidden behind someone),
  * faces are frontal (nose centred between the eyes),
  * the group is still: low frame-difference motion and stable face positions.
Contiguous ready frames (>= min_len seconds) become usable segments. The median face
positions of the best segment are returned, so planners can frame each member.

Face detector: OpenCV YuNet (Apache-2.0), downloaded once into .cutkiller-cache/models.
"""
from __future__ import annotations

import subprocess
import urllib.request
from pathlib import Path

import numpy as np

MODEL_URLS = [
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
]
MODEL = Path(".cutkiller-cache/models/yunet.onnx")
FPS = 5


def _model() -> Path:
    if MODEL.exists() and MODEL.stat().st_size > 100_000:
        return MODEL
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    for url in MODEL_URLS:
        try:
            urllib.request.urlretrieve(url, MODEL)
            if MODEL.stat().st_size > 100_000:
                return MODEL
        except Exception:
            continue
    raise RuntimeError("could not download the YuNet face model; place it at " + str(MODEL))


def _frames(src: str, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", src, "-vf", f"fps={FPS},scale={w}:{h}", "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def scan(src: str, width: int, height: int) -> list[dict]:
    """Per-frame faces (centre, size, yaw) and motion, at FPS frames per second."""
    import cv2

    fr = _frames(src, width, height)
    det = cv2.FaceDetectorYN.create(str(_model()), "", (width, height), 0.7, 0.3, 5000)
    out, prev = [], None
    for i, f in enumerate(fr):
        _, faces = det.detect(f)
        g = cv2.cvtColor(cv2.resize(f, (320, 180)), cv2.COLOR_BGR2GRAY).astype(np.float32)
        motion = 0.0 if prev is None else float(np.abs(g - prev).mean())
        prev = g
        items = []
        for d in ([] if faces is None else faces):
            x, y, w, h = (float(v) for v in d[:4])
            re, le, nose = d[4:6], d[6:8], d[8:10]
            eye = float(np.linalg.norm(le - re)) + 1e-6
            items.append({"x": x + w / 2, "y": y + h / 2, "size": h,
                          "yaw": float(abs(nose[0] - (re[0] + le[0]) / 2) / eye)})
        items.sort(key=lambda it: it["x"])
        out.append({"t": round(i / FPS, 3), "motion": motion, "faces": items})
    return out


def curate(src: str, width: int, height: int, group: int | None = None, min_len: float = 1.0,
           max_yaw: float = 0.3, frames: list[dict] | None = None) -> dict:
    frames = frames or scan(src, width, height)
    motion = np.array([f["motion"] for f in frames])
    calm = motion <= np.percentile(motion, 50)
    if group is None:
        counts = [len(f["faces"]) for f, c in zip(frames, calm) if c] or [0]
        group = int(np.bincount(counts).argmax())

    def ready(i: int) -> bool:
        f = frames[i]
        fs = f["faces"]
        if len(fs) != group or group == 0:
            return False
        size = np.median([x["size"] for x in fs])
        gaps = np.diff([x["x"] for x in fs]) if len(fs) > 1 else np.array([size])
        if gaps.min() < 1.0 * size:  # someone half-hidden behind a neighbour
            return False
        if np.mean([x["yaw"] for x in fs]) > max_yaw:
            return False
        if f["motion"] > max(4.0, 1.4 * np.percentile(motion, 30)):
            return False
        j = max(0, i - FPS)  # positions stable over the last second
        prev = frames[j]["faces"]
        if len(prev) == len(fs) and max(abs(a["x"] - b["x"]) for a, b in zip(fs, prev)) > 0.5 * size:
            return False
        return True

    flags = [ready(i) for i in range(len(frames))]
    # close 1-frame holes (a blink, a missed detection)
    for i in range(1, len(flags) - 1):
        if not flags[i] and flags[i - 1] and flags[i + 1]:
            flags[i] = True
    segs, start = [], None
    for i, ok in enumerate(flags + [False]):
        if ok and start is None:
            start = i
        elif not ok and start is not None:
            a, b = start / FPS, i / FPS
            if b - a >= min_len:
                segs.append({"start": round(a, 2), "end": round(b, 2),
                             "motion": round(float(motion[start:i].mean()), 3)})
            start = None
    best = max(segs, key=lambda s: (s["end"] - s["start"]) / (1 + s["motion"])) if segs else None
    members = []
    if best:
        sel = [f["faces"] for f in frames[int(best["start"] * FPS): int(best["end"] * FPS)] if len(f["faces"]) == group]
        for k in range(group):
            members.append({"x": round(float(np.median([fs[k]["x"] for fs in sel])), 1),
                            "y": round(float(np.median([fs[k]["y"] for fs in sel])), 1),
                            "size": round(float(np.median([fs[k]["size"] for fs in sel])), 1)})
    return {"src": src, "group": group, "segments": segs, "best": best, "members": members,
            "rejected": round(1 - sum(s["end"] - s["start"] for s in segs) / max(1e-6, len(frames) / FPS), 3)}
