import json
import subprocess
import sys


def run(task: str, payload: str) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, "-m", "cutkiller_workers", task],
        input=payload,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, json.loads(proc.stdout)


def test_ping_echoes_request():
    code, response = run("ping", json.dumps({"a": 1}))
    assert code == 0
    assert response["ok"] is True
    assert response["result"]["echo"] == {"a": 1}


def test_unknown_task_is_reported_as_json():
    code, response = run("nope", "{}")
    assert code == 2
    assert response["ok"] is False
    assert "ping" in response["error"]


def test_invalid_json_is_reported_as_json():
    code, response = run("ping", "{not json")
    assert code == 1
    assert response["ok"] is False
    assert "JSONDecodeError" in response["error"]
