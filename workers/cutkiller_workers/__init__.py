"""Workers d'analyse CutKiller : une tâche = une fonction pure JSON -> JSON."""

from __future__ import annotations

import platform
from collections.abc import Callable
from typing import Any

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


TASKS: dict[str, Task] = {
    "ping": ping,
    "transcribe": _transcribe,
    "vad": _vad,
    "beats": _beats,
    "prosody": _prosody,
}
