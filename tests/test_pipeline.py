"""End-to-end checks on synthetic media with known ground truth."""
import json
import subprocess

import pytest

from cutkiller.audio import analyze_audio
from cutkiller.plan import plan_cut, plan_motion
from cutkiller.render import render_ffmpeg
from cutkiller.synth import demo_track, demo_video
from cutkiller.video import analyze_video

LEAD = 0.5  # synth: silence before the first downbeat


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("media")
    return {
        "t128": demo_track(d / "t128.wav", bpm=128),
        "t72": demo_track(d / "t72.wav", bpm=72),
        "va": demo_video(d / "a.mp4", [0, 1, 2, 3], shot_len=4.0),
        "vb": demo_video(d / "b.mp4", [4, 5, 1], shot_len=3.0),
    }


@pytest.fixture(scope="module")
def a128(media):
    return analyze_audio(media["t128"])


@pytest.fixture(scope="module")
def vids(media):
    return [analyze_video(media["va"]), analyze_video(media["vb"])]


@pytest.mark.parametrize("bpm", [128, 72])
def test_tempo_and_downbeats(media, bpm):
    a = analyze_audio(media[f"t{bpm}"])
    assert abs(a["bpm"] - bpm) < 0.5, a["bpm"]  # 72 must not be read as 144
    bar = 4 * 60 / bpm
    truth = [LEAD + i * bar for i in range(16)]
    assert len(a["downbeats"]) == 16
    for got, exp in zip(a["downbeats"], truth):
        assert abs(got - exp) < 0.025, (got, exp)
    drop = LEAD + 8 * bar  # bars 9-16 are the loud part
    assert a["drop"] is not None and abs(a["drop"] - drop) < 60 / bpm


def test_sections_rise(a128):
    levels = [s["level"] for s in a128["sections"]]
    assert levels[0] == "low" and levels[-1] == "high"


def test_shot_detection(vids):
    va, vb = vids
    assert [round(s["start"], 1) for s in va["shots"]] == [0.0, 4.0, 8.0, 12.0]
    assert [round(s["start"], 1) for s in vb["shots"]] == [0.0, 3.0, 6.0]


def test_cut_plan_is_on_beat_and_contiguous(media, a128, vids):
    p = plan_cut(a128, vids, audio_src=str(media["t128"]), fps=30)
    clips = p["clips"]
    assert clips[0]["from"] == 0
    for c, n in zip(clips, clips[1:]):
        assert c["from"] + c["durationInFrames"] == n["from"]
    assert sum(c["durationInFrames"] for c in clips) == p["durationInFrames"]
    beat_frames = {round((b["t"] - p["audio"]["startSec"]) * 30) for b in a128["beats"]}
    assert all(c["from"] in beat_frames for c in clips)
    assert all(c["durationInFrames"] >= 6 for c in clips)
    # clips never run past their source
    dur = {v["src"]: v["duration"] for v in vids}
    assert all(c["trimBeforeSec"] + c["durationInFrames"] / 30 <= dur[c["src"]] + 1e-3 for c in clips)
    # auto density: faster cutting in the loud part than in the intro
    drop_f = p["drop"]
    before = [c for c in clips if c["from"] < drop_f]
    after = [c for c in clips if c["from"] >= drop_f]
    avg = lambda cs: sum(c["durationInFrames"] for c in cs) / len(cs)
    assert avg(after) < avg(before)


def test_chronological_order(media, a128, vids):
    p = plan_cut(a128, vids, audio_src=str(media["t128"]), order="chronological", duration=10)
    keys = [(next(i for i, v in enumerate(vids) if v["src"] == c["src"]), c["trimBeforeSec"]) for c in p["clips"]]
    assert keys == sorted(keys)


def test_motion_plan(media, a128):
    p = plan_motion(a128, audio_src=str(media["t128"]), title="Hi", duration=8)
    downs = [b["frame"] for b in p["beats"] if b["downbeat"]]
    assert p["heroFrame"] == downs[0]
    assert p["scaleFrame"] == downs[1]  # next strong beat
    assert p["feel"] == "punchy"
    slow = plan_motion(analyze_audio(media["t72"]), audio_src=str(media["t72"]), title="Hi")
    assert slow["feel"] == "airy" and slow["beatFrames"] > p["beatFrames"]


def test_ffmpeg_render_is_frame_exact(media, a128, vids, tmp_path):
    p = plan_cut(a128, vids, audio_src=str(media["t128"]), duration=3)
    out = render_ffmpeg(p, tmp_path / "o.mp4", preset="ultrafast")
    info = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v", "-show_entries",
         "stream=nb_read_frames,width,height", "-of", "json", str(out)],
        capture_output=True, text=True, check=True).stdout)["streams"][0]
    assert int(info["nb_read_frames"]) == p["durationInFrames"]
    assert (info["width"], info["height"]) == (1920, 1080)


def test_tempo_outside_tracker_estimate(tmp_path):
    """Regression: the DP tracker read this 120 BPM bed as ~117.5; the grid search must recover 120."""
    from cutkiller.music import minimal_tech
    import numpy as np

    a = analyze_audio(minimal_tech(tmp_path / "bed.wav", bpm=120))
    assert abs(a["bpm"] - 120) < 0.1
    bt = np.array([b["t"] for b in a["beats"]])
    assert np.abs(bt - np.round(bt / 0.5) * 0.5).max() < 0.03
    assert bt[0] < 0.03  # quiet pad/tick intro is kept (not trimmed)
    # bar phase is not asserted: every kick in this bed is equally loud, so it is genuinely ambiguous


def test_reel_plan_uses_only_curated_window():
    from cutkiller.music import grid
    from cutkiller.plan import plan_reel

    cur = {"best": {"start": 35.0, "end": 40.6, "motion": 2.5}, "rejected": 0.87,
           "members": [{"x": 235 + 170 * i, "y": 370, "size": 66} for i in range(6)]}
    p = plan_reel(grid(120, end=6, drop=3, duration=13.6), cur, {"width": 1280, "height": 720},
                  video_src="v.mp4", audio_src="m.wav", brand="X", highlight=(38.0, 2))
    for s in p["shots"]:
        assert 35.0 <= s["inSec"] and s["inSec"] + s["dur"] / 30 <= 40.6 + 1e-6, s
    starts = [s["from"] for s in p["shots"]]
    assert all(f % 15 == 0 for f in starts)          # every cut on a beat (120 BPM @ 30 fps)
    assert p["heroFrame"] == 180 and p["endFrame"] == 360  # drop on bar 3, end card on bar 6 impact
    assert [s["tag"] for s in p["shots"]][1:7] == ["01", "02", "03", "04", "05", "06"]
