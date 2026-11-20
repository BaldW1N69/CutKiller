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


def test_serve_answers_line_by_line_and_keeps_going_after_errors():
    proc = subprocess.run(
        [sys.executable, "-m", "cutkiller_workers", "--serve"],
        input="\n".join(
            [
                json.dumps({"id": 1, "task": "ping", "request": {"a": 1}}),
                "{broken",
                json.dumps({"id": 2, "task": "nope", "request": {}}),
                json.dumps({"id": 3, "task": "ping", "request": {"b": 2}}),
            ]
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines()]
    assert proc.returncode == 0
    assert [m["id"] for m in lines] == [1, None, 2, 3]
    assert lines[0]["result"]["echo"] == {"a": 1}
    assert lines[1]["ok"] is False and "JSONDecodeError" in lines[1]["error"]
    assert lines[2]["ok"] is False
    assert lines[3]["result"]["echo"] == {"b": 2}
