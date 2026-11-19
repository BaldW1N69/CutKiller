"""Prosodie par mot (énergie et hauteur), pour repérer les mots d'emphase."""

from __future__ import annotations

from typing import Any

import numpy as np

from .audio import load_mono

RATE = 16_000
HOP = 160  # 10 ms


def prosody(request: dict[str, Any]) -> dict[str, Any]:
    import librosa

    audio = load_mono(request["path"], RATE)
    words = request["words"]
    frame = 1024
    rms = librosa.feature.rms(y=audio, frame_length=frame, hop_length=HOP, center=True)[0]
    db = 20 * np.log10(rms + 1e-9)
    f0 = librosa.yin(audio, fmin=65, fmax=400, sr=RATE, frame_length=frame, hop_length=HOP, center=True)
    floor = float(np.percentile(db, 10))
    voiced = db > floor + 15
    out = []
    for w in words:
        a = int(w["start"] * RATE / HOP)
        b = max(a + 1, int(w["end"] * RATE / HOP))
        seg_db = db[a:b]
        seg_f0 = f0[a:b][voiced[a:b]]
        out.append(
            {
                "rmsDb": round(float(seg_db.max()), 2) if len(seg_db) else None,
                # Median pitch in semitones relative to 100 Hz: robust to octave slips of a few frames.
                "pitchSt": round(float(12 * np.log2(np.median(seg_f0) / 100)), 2)
                if len(seg_f0) >= 3
                else None,
            }
        )
    return {"words": out}
