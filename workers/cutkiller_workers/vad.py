"""Détection de parole (Silero VAD, MIT) et niveau de bruit de fond."""

from __future__ import annotations

from typing import Any

import numpy as np

from .audio import load_mono

RATE = 16_000
# Codec padding: AAC and MP3 add up to a few tens of ms of near digital silence
# at the ends of a stream (measured: 32 ms after an AAC re-encode). It is not
# the recording's edge and must not hide a word cut off right before it.
PADDING_DB = -70.0
MAX_PADDING_S = 0.05


def _strip_padding(audio: np.ndarray) -> np.ndarray:
    block = RATE // 200  # 5 ms
    limit = int(MAX_PADDING_S * RATE) // block

    def quiet(x: np.ndarray) -> bool:
        return 20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9) < PADDING_DB

    lo, hi = 0, len(audio)
    for _ in range(limit):
        if hi - lo <= 2 * block or not quiet(audio[lo : lo + block]):
            break
        lo += block
    for _ in range(limit):
        if hi - lo <= 2 * block or not quiet(audio[hi - block : hi]):
            break
        hi -= block
    return audio[lo:hi]


def _in_speech(db: np.ndarray, segments: list[dict[str, float]], hop: int) -> np.ndarray:
    """Levels of the 10 ms frames inside detected speech (all frames if none)."""
    keep = np.zeros(len(db), dtype=bool)
    for s in segments:
        keep[int(s["start"] * RATE / hop) : int(s["end"] * RATE / hop) + 1] = True
    return db[keep] if keep.any() else db


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
    body = _strip_padding(audio)

    def level(x: np.ndarray) -> float:
        return round(float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9)), 1)

    return {
        "durationS": round(len(audio) / RATE, 3),
        "speech": segments,
        "noiseFloorDb": round(float(np.percentile(db, 10)), 1),
        "peakDb": round(float(db.max()), 1),
        # Loud speech, and the first / last 30 ms: a recording that starts or
        # stops while someone talks cuts a word (still loud on its edge).
        "speechDb": round(float(np.percentile(_in_speech(db, segments, hop), 90)), 1),
        "edgeDb": {"start": level(body[:edge]), "end": level(body[-edge:])},
    }
