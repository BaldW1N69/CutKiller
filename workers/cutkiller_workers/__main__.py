"""Protocole : `python -m cutkiller_workers <tâche>`, requête JSON sur stdin, réponse sur stdout.

La réponse est toujours `{"ok": true, "result": ...}` ou `{"ok": false, "error": "..."}` ;
les journaux vont sur stderr pour ne jamais corrompre le JSON.
"""

from __future__ import annotations

import json
import sys

from . import TASKS


def main(argv: list[str]) -> int:
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
