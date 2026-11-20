"""Où l'écran change : pour les captures d'écran (tutoriels), la zone où il se passe
quelque chose (curseur, saisie, menu qui s'ouvre) à chaque instant.

Échantillonne la vidéo (5 images/s), en niveaux de gris réduits à 480 px, et compare
chaque échantillon au précédent. Les pixels qui changent de plus de `threshold`
niveaux forment la zone d'activité : sa boîte (percentiles 5–95, pour ignorer un
pixel isolé) et la part de l'image qui a changé. Un changement de plus de 25 % de
l'image est un changement de scène (nouvelle fenêtre), pas une zone à suivre.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

import numpy as np

from .subjects import _probe_size


def activity(request: dict[str, Any]) -> dict[str, Any]:
    path = request["path"]
    fps = float(request.get("fps", 5))
    threshold = int(request.get("threshold", 24))
    max_side = int(request.get("maxSide", 480))
    sw, sh = _probe_size(path)
    scale = min(1.0, max_side / max(sw, sh))
    w = max(2, round(sw * scale / 2) * 2)
    h = max(2, round(sh * scale / 2) * 2)
    ffmpeg = os.environ.get("CUTKILLER_FFMPEG", "ffmpeg")
    raw = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-nostdin",
            "-i",
            path,
            "-map",
            "0:v:0",
            "-vf",
            f"fps={fps}:start_time=0:round=up,scale={w}:{h}:flags=area,format=gray",
            "-f",
            "rawvideo",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w)
    samples: list[dict[str, Any]] = []
    for i in range(1, len(frames)):
        diff = np.abs(frames[i].astype(np.int16) - frames[i - 1].astype(np.int16)) > threshold
        fraction = float(diff.mean())
        t = round(i / fps, 3)
        if fraction < 1e-4:
            samples.append({"t": t, "fraction": 0.0})
            continue
        ys, xs = np.nonzero(diff)
        x0, x1 = np.percentile(xs, [5, 95]) / w
        y0, y1 = np.percentile(ys, [5, 95]) / h
        samples.append(
            {
                "t": t,
                "fraction": round(fraction, 5),
                "cx": round(float(x0 + x1) / 2, 4),
                "cy": round(float(y0 + y1) / 2, 4),
                "w": round(float(x1 - x0), 4),
                "h": round(float(y1 - y0), 4),
            }
        )
    return {"fps": fps, "width": sw, "height": sh, "samples": samples}
