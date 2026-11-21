"""Workers d'analyse CutKiller : une tâche = une fonction pure JSON -> JSON."""

from __future__ import annotations

import os
import platform
from collections.abc import Callable
from pathlib import Path
from typing import Any

# One model cache, fixed before anything imports huggingface_hub (which reads
# HF_HOME once, at import): otherwise the aligner landed in ~/.cache/huggingface
# or in ~/.cache/cutkiller/hf depending on which task ran first, and was
# downloaded twice.
os.environ.setdefault("HF_HOME", str(Path.home() / ".cache" / "cutkiller" / "hf"))

Task = Callable[[dict[str, Any]], Any]


def ping(request: dict[str, Any]) -> dict[str, Any]:
    """Vérifie la chaîne Node -> Python et renvoie la requête reçue."""
    return {"echo": request, "python": platform.python_version()}


def _transcribe(request: dict[str, Any]) -> Any:
    from .transcribe import transcribe

    return transcribe(request)


def _vad(request: dict[str, Any]) -> Any:
    from .vad import vad

    return vad(request)


def _beats(request: dict[str, Any]) -> Any:
    from .beats import beats

    return beats(request)


def _prosody(request: dict[str, Any]) -> Any:
    from .prosody import prosody

    return prosody(request)


def _align(request: dict[str, Any]) -> Any:
    """Alignement forcé d'un texte connu (mots avec position approximative) sur un audio."""
    from .align import RATE, align_words, noise_floor_db
    from .audio import load_mono

    words = [
        {"text": w["text"], "start": float(w["start"]), "end": float(w["end"])} for w in request["words"]
    ]
    floor = noise_floor_db(load_mono(request["floorPath"], RATE)) if request.get("floorPath") else None
    return {
        "words": align_words(request["path"], words, floor_db=floor, language=request.get("language", "fr"))
        if words
        else [],
        "floorDb": floor,
    }


def _subjects(request: dict[str, Any]) -> Any:
    from .subjects import subjects

    return subjects(request)


def _activity(request: dict[str, Any]) -> Any:
    from .activity import activity

    return activity(request)


TASKS: dict[str, Task] = {
    "ping": ping,
    "transcribe": _transcribe,
    "vad": _vad,
    "beats": _beats,
    "prosody": _prosody,
    "align": _align,
    "subjects": _subjects,
    "activity": _activity,
}
