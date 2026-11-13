import asyncio
import json
import os
import sys

import pytest

from cutkiller import mcp_server as srv


def test_flag_helpers():
    a: list[str] = []
    srv.flag(a, "--x", None)
    srv.flag(a, "--y", False)
    srv.flag(a, "--z", True)
    srv.flag(a, "--n", 0.0)
    srv.flag(a, "--s", "v")
    srv.repeat(a, "--sfx", ["a@cuts", "b@1,2"])
    assert a == ["--z", "--n", "0.0", "--s", "v", "--sfx", "a@cuts", "--sfx", "b@1,2"]
    t: list[str] = []
    srv.transition_args(t, "fade", 0.4, 3, 2.0, 7, 0.0, None)
    assert t[:2] == ["--transition", "fade"] and "--transition-every" in t and "--seed" in t
    t = []
    srv.transition_args(t, None, 0.4, 3, 2.0, None, 0.0, None)
    assert "--transition-duration" not in t  # pas de transition : pas d'options associées


def test_need_files(tmp_path):
    assert srv._need_files([str(tmp_path)]) is None
    err = srv._need_files([str(tmp_path / "nope.mp4")])
    assert err["status"] == "failed" and "nope.mp4" in err["error"]


def test_launch_runs_cli_and_extracts_outputs(talk_video, tmp_path):
    res = srv.launch(["cut", str(talk_video), "-o", str(tmp_path / "c.mp4")], wait=60)
    assert res["status"] == "done" and res["exit_code"] == 0
    assert res["outputs"] == [str(tmp_path / "c.mp4")] and (tmp_path / "c.mp4").exists()


def test_launch_failure_and_running_job(tmp_path):
    res = srv.launch(["listen", str(tmp_path / "absent.mp4")], wait=30)
    assert res["status"] == "failed" and "introuvable" in res["log"]
    job = srv.JOBS.start(["sounds", "providers"])
    job.wait(30)
    assert srv.JOBS.get(job.id).snapshot()["status"] == "done"
    with pytest.raises(KeyError):
        srv.JOBS.get("zzz")


def test_credits_are_returned(tmp_path):
    job = srv.JOBS.start(["doctor", "--json"])
    job.wait(30)
    credits = tmp_path / "x.credits.txt"
    credits.write_text("Sons : test é", encoding="utf-8")
    job.lines.extend([f"Export : {tmp_path / 'x.mp4'}", f"Crédits à mettre en description : {credits}"])
    snap = job.snapshot()
    assert snap["credits"] == "Sons : test é" and snap["credits_file"] == str(credits)


mcp = pytest.importorskip("mcp")


def test_mcp_server_over_stdio(tmp_path):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def run():
        params = StdioServerParameters(command=sys.executable, args=["-m", "cutkiller.mcp_server"],
                                       env={"PATH": os.environ["PATH"], "CUTKILLER_CACHE": str(tmp_path)})
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                names = {t.name for t in (await s.list_tools()).tools}
                tr = json.loads((await s.call_tool("cutkiller_transitions", {"tag": "glitch", "limit": 2})).content[0].text)
                missing = json.loads((await s.call_tool("cutkiller_auto", {"path": str(tmp_path / "x.mp4")})).content[0].text)
                return names, tr, missing

    names, tr, missing = asyncio.run(run())
    assert {"cutkiller_auto", "cutkiller_montage", "cutkiller_text", "cutkiller_job", "cutkiller_doctor",
            "cutkiller_sounds_search", "cutkiller_transitions"} <= names
    assert tr["total"] >= 5 and len(tr["transitions"]) == 2 and "dynamic" in tr["themes"]
    assert missing["status"] == "failed" and "introuvable" in missing["error"]
