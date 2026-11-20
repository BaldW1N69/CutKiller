"""Protocole : `python -m cutkiller_workers <tâche>`, requête JSON sur stdin, réponse sur stdout.

La réponse est toujours `{"ok": true, "result": ...}` ou `{"ok": false, "error": "..."}` ;
les journaux vont sur stderr pour ne jamais corrompre le JSON.

`python -m cutkiller_workers --serve` : un processus persistant, une requête par ligne
(`{"id", "task", "request"}`), une réponse par ligne (`{"id", "ok", ...}`). Les modèles
restent chargés d'une requête à l'autre (Whisper et l'aligneur coûtent ~9 s à charger).
"""

from __future__ import annotations

import json
import sys

from . import TASKS


def run_task(task: str, request: dict) -> dict:
    if task not in TASKS:
        return {"ok": False, "error": f"tâche inconnue, disponibles : {sorted(TASKS)}"}
    try:
        return {"ok": True, "result": TASKS[task](request)}
    except Exception as exc:  # noqa: BLE001 — the protocol reports every failure as JSON
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def serve() -> int:
    """One JSON request per line in, one JSON response per line out, until stdin closes."""
    out = sys.stdout
    sys.stdout = sys.stderr  # libraries that print must not corrupt the protocol
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            message = json.loads(line)
            response = run_task(message.get("task", ""), message.get("request") or {})
            response["id"] = message.get("id")
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": f"JSONDecodeError: {exc}"}
        out.write(json.dumps(response, ensure_ascii=False) + "\n")
        out.flush()
    return 0


def main(argv: list[str]) -> int:
    if argv == ["--serve"]:
        return serve()
    if len(argv) != 1 or argv[0] not in TASKS:
        print(json.dumps({"ok": False, "error": f"tâche inconnue, disponibles : {sorted(TASKS)}"}))
        return 2
    try:
        request = json.loads(sys.stdin.read() or "{}")
        result = TASKS[argv[0]](request)
    except Exception as exc:  # noqa: BLE001 — the protocol reports every failure as JSON
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
