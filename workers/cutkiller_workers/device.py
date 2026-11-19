"""Where the speech models run: an NVIDIA GPU when one is usable, else the CPU.

CUTKILLER_DEVICE=cpu|cuda forces the choice. On CUDA, Whisper runs in float16
(several times faster than int8 on CPU) and the aligner moves to the GPU.
"""

from __future__ import annotations

import os
from functools import cache


@cache
def device() -> str:
    forced = os.environ.get("CUTKILLER_DEVICE", "").strip().lower()
    if forced in ("cpu", "cuda"):
        return forced
    try:
        import ctranslate2

        count = ctranslate2.get_cuda_device_count()
    except Exception:  # noqa: BLE001 - no CUDA runtime is the common case
        count = 0
    return "cuda" if count > 0 else "cpu"


def whisper_compute_type(requested: str | None) -> str:
    """int8 on CPU (fast, accurate enough), float16 on GPU, unless the request names one."""
    if requested:
        return requested
    return "float16" if device() == "cuda" else "int8"
