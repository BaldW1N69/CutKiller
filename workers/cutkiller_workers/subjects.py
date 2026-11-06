"""Sujets et couleurs des rushes : visages (OpenCV YuNet, MIT) et couleurs moyennes.

Échantillonne la vidéo (5 images/s par défaut) sur la timeline du conteneur et
renvoie, pour chaque échantillon, les visages détectés (boîtes normalisées,
confiance, couleur de la peau des joues et du nez) et la couleur
moyenne de l'image. Le recadrage 9:16 suit ces visages ; l'étalonnage égalise
la couleur de la peau d'un plan à l'autre.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import urllib.request
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np

from .transcribe import models_dir

YUNET_URL = (
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"
    "face_detection_yunet/face_detection_yunet_2023mar.onnx"
)
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


def _yunet_path() -> str:
    path = Path(models_dir()) / "yunet" / "face_detection_yunet_2023mar.onnx"
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == YUNET_SHA256:
        return str(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".part")
    urllib.request.urlretrieve(YUNET_URL, tmp)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    if digest != YUNET_SHA256:
        tmp.unlink()
        raise RuntimeError(f"modèle YuNet corrompu (sha256 {digest})")
    tmp.replace(path)
    return str(path)


@cache
def _detector(width: int, height: int):
    import cv2

    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)  # OpenCV 5 warns on every load
    return cv2.FaceDetectorYN.create(_yunet_path(), "", (width, height), 0.6, 0.3, 50)


def _probe_size(path: str) -> tuple[int, int]:
    ffprobe = os.environ.get("CUTKILLER_FFPROBE", "ffprobe")
    out = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
            path,
        ],
        capture_output=True,
        check=True,
        text=True,
    ).stdout.strip()
    w, h = (int(v) for v in out.split(",")[:2])
    return w, h


def _skin(frame: np.ndarray, face: np.ndarray) -> np.ndarray:
    """Skin colour of a face: per-channel median of the cheeks and nose.

    The patch runs between the eyes, from under the eyes to above the mouth
    (YuNet landmarks), so hair, beard, mouth and background stay out; the median
    ignores glasses, specular highlights and a caption drawn over part of it.
    """
    h, w = frame.shape[:2]
    (rex, rey), (lex, ley), (_, ny), (_, rmy), (_, lmy) = face[4:14].reshape(5, 2)
    eye_y, mouth_y = (rey + ley) / 2, (rmy + lmy) / 2
    x0, x1 = int(max(0, min(rex, lex))), int(min(w, max(rex, lex) + 1))
    y0 = int(max(0, eye_y + 0.3 * (ny - eye_y)))
    y1 = int(min(h, ny + 0.3 * (mouth_y - ny) + 1))
    patch = frame[y0:y1, x0:x1]
    if patch.size == 0:
        return np.zeros(3)
    return np.median(patch.reshape(-1, 3)[:, ::-1], axis=0) / 255


def subjects(request: dict[str, Any]) -> dict[str, Any]:
    path = request["path"]
    fps = float(request.get("fps", 5))
    max_side = int(request.get("maxSide", 640))
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
            # Several input frames fall in each sample slot and the fps filter keeps
            # the last one: round=up makes it the last frame at or before the sample
            # time (round=near would pick one up to half a slot late).
            f"fps={fps}:start_time=0:round=up,scale={w}:{h}:flags=area",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    detector = _detector(w, h)
    samples = []
    for i, frame in enumerate(frames):
        _, found = detector.detect(frame)
        faces = []
        for f in found if found is not None else []:
            x, y, fw, fh = (float(v) for v in f[:4])
            rgb = _skin(frame, f)
            faces.append(
                {
                    "x": round(x / w, 4),
                    "y": round(y / h, 4),
                    "w": round(fw / w, 4),
                    "h": round(fh / h, 4),
                    "score": round(float(f[-1]), 3),
                    "rgb": [round(float(c), 4) for c in rgb],
                }
            )
        pixels = frame.reshape(-1, 3)[:, ::-1] / 255
        mean = pixels.mean(axis=0)
        # Tonal range of the picture (BT.709 luma, gamma-encoded): p5 / p50 / p95.
        luma = np.percentile(pixels @ np.array([0.2126, 0.7152, 0.0722]), [5, 50, 95])
        samples.append(
            {
                "t": round(i / fps, 3),
                "faces": faces,
                "rgb": [round(float(c), 4) for c in mean],
                "luma": [round(float(v), 4) for v in luma],
            }
        )
    return {"width": sw, "height": sh, "sampleFps": fps, "samples": samples}
