"""Workers d'analyse CutKiller : une tâche = une fonction pure JSON -> JSON."""

from __future__ import annotations

import platform
from collections.abc import Callable
from typing import Any

Task = Callable[[dict[str, Any]], Any]


def ping(request: dict[str, Any]) -> dict[str, Any]:
    """Vérifie la chaîne Node -> Python et renvoie la requête reçue."""
    return {"echo": request, "python": platform.python_version()}


TASKS: dict[str, Task] = {"ping": ping}
