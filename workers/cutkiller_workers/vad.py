"""Détection de parole (Silero VAD, MIT) et niveau de bruit de fond."""

from __future__ import annotations

from typing import Any

import numpy as np

from .audio import load_mono

RATE = 16_000


def vad(request: dict[str, Any]) -> dict[str, Any]:
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    audio = load_mono(request["path"], RATE)
    model = load_silero_vad()
    stamps = get_speech_timestamps(
        torch.from_numpy(audio),
        model,
        sampling_rate=RATE,
        threshold=request.get("threshold", 0.5),
        min_silence_duration_ms=request.get("minSilenceMs", 100),
        speech_pad_ms=request.get("padMs", 0),
        return_seconds=False,
    )
    segments = [{"start": round(s["start"] / RATE, 3), "end": round(s["end"] / RATE, 3)} for s in stamps]
    hop = RATE // 100
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop) if len(audio) >= hop else audio.reshape(1, -1)
    db = 20 * np.log10(np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1)) + 1e-9)
    edge = int(0.03 * RATE)

    def level(x: np.ndarray) -> float:
        return round(float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9)), 1)

    return {
        "durationS": round(len(audio) / RATE, 3),
        "speech": segments,
        "noiseFloorDb": round(float(np.percentile(db, 10)), 1),
        "peakDb": round(float(db.max()), 1),
        # Loud speech, and the first / last 30 ms: a recording that starts or
        # stops while someone talks cuts a word (still loud on its edge).
        "speechDb": round(float(np.percentile(db, 90)), 1),
        "edgeDb": {"start": level(audio[:edge]), "end": level(audio[-edge:])},
    }
