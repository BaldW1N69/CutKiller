"""Visages et couleur de peau : patch de peau robuste, échantillonnage à l'instant juste."""

from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import pytest

from cutkiller_workers.subjects import _skin

ROOT = Path(__file__).resolve().parents[2]
FACE_PAN = ROOT / ".cache" / "fixtures" / "face-pan.mp4"


def _face(eyes_y: float, nose_y: float, mouth_y: float) -> np.ndarray:
    """YuNet row: box, right eye, left eye, nose tip, mouth corners, score."""
    return np.array(
        [80, 40, 120, 150, 110, eyes_y, 170, eyes_y, 140, nose_y, 115, mouth_y, 165, mouth_y, 0.9],
        dtype=np.float32,
    )


def test_skin_patch_is_cheeks_and_nose_and_ignores_a_caption() -> None:
    frame = np.zeros((240, 320, 3), np.uint8)
    frame[:, :] = (40, 40, 40)  # background, beard, hair: dark grey (BGR)
    frame[95:150, 100:180] = (90, 120, 200)  # skin band between the eyes and the mouth (BGR)
    frame[95:105, 100:180] = (255, 255, 255)  # a caption line drawn over its top
    rgb = _skin(frame, _face(eyes_y=90, nose_y=130, mouth_y=160))
    # Median of the patch: the skin colour, as RGB 0–1, despite the caption.
    assert np.allclose(rgb, np.array([200, 120, 90]) / 255, atol=1e-6)


def test_skin_patch_empty_when_landmarks_leave_the_frame() -> None:
    frame = np.full((60, 80, 3), 128, np.uint8)
    face = _face(eyes_y=200, nose_y=220, mouth_y=240)
    assert np.allclose(_skin(frame, face), 0)


@pytest.mark.models
@pytest.mark.skipif(not FACE_PAN.exists() or shutil.which("ffmpeg") is None, reason="pnpm fixtures")
def test_samples_show_the_frame_at_their_time() -> None:
    """Le visage du fixture glisse de 30 % à 70 % (smoothstep 2,5–3,5 s) : chaque
    échantillon le voit là où il est à son instant, pas une frame plus tard."""
    from cutkiller_workers.subjects import subjects

    result = subjects({"path": str(FACE_PAN), "fps": 5})
    assert result["width"] == 1280 and result["sampleFps"] == 5
    for s in result["samples"]:
        p = min(1.0, max(0.0, (s["t"] - 2.5) / 1.0))
        truth = 0.3 + 0.4 * p * p * (3 - 2 * p)
        face = s["faces"][0]
        assert abs(face["x"] + face["w"] / 2 - truth) < 0.01, s["t"]
    # 8 s at 5 samples/s.
    assert len(result["samples"]) == 40
