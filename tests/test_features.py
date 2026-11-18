"""F1-F5: platform presets, one-pass finishing, pacing curve, strong-beat transitions, draft."""

import json
import subprocess

import numpy as np

from conftest import SR, click_track, write_wav
from cutkiller.cli import main
from cutkiller.edit.finish import remap_words
from cutkiller.edit.montage import pacing_curve
from cutkiller.edit.timeline import assign_joins
from cutkiller.listen.beats import music_structure
from cutkiller.listen.silence import Interval
from cutkiller.listen.transcribe import Word
from cutkiller.media import probe
from cutkiller.transitions import Picker


def _stream(path, *fields):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          "stream=" + ",".join(fields), "-of", "json", str(path)], capture_output=True, text=True,
                         check=True).stdout
    return json.loads(out)["streams"][0]


def _keyframes(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-skip_frame", "nokey", "-show_entries",
                          "frame=pts_time", "-of", "csv=p=0", str(path)], capture_output=True, text=True,
                         check=True).stdout
    return [float(x.strip(",")) for x in out.split() if x.strip(",")]


def _music(tmp_path, quiet_then_loud=True):
    """120 BPM (beats at 0.25 + 0.5 k): soft clicks, then from the beat at 8.25 s loud, dense hits (a 'drop')."""
    soft = click_track(120, 8.25) * 0.08
    loud = click_track(120, 8.0) * 0.9
    noise = np.random.default_rng(0).normal(0, 0.15, loud.size).astype(np.float32)
    audio = np.concatenate([soft, loud + noise * (np.arange(loud.size) % (SR // 2) < SR // 8)])
    return write_wav(tmp_path / "music.wav", audio.astype(np.float32)), audio


def test_music_structure_finds_drop_and_downbeats(tmp_path):
    _, audio = _music(tmp_path)
    beats = [0.25 + 0.5 * k for k in range(31)]
    st = music_structure(audio, SR, beats)
    assert st.drops and abs(beats[st.drops[0]] - 8.25) <= 1.0  # the loud section starts at 8 s
    assert all(b - a == 4 for a, b in zip(st.downbeats, st.downbeats[1:]))
    assert st.level(2) < 0.5 < st.level(20)


def test_pacing_curve_shortens_loud_and_lengthens_soft():
    levels = [0.1] * 4 + [0.5] * 4 + [0.9] * 4
    assert pacing_curve(12, 4, lambda i: levels[i]) == [8] * 4 + [4] * 4 + [2] * 4


def test_strong_cuts_only_get_transitions():
    joins = assign_joins([1, 2, 3, 4], Picker("fade", seed=1), strong=[False, True, False, True])
    assert [j.transition is not None for j in joins] == [False, True, False, True]
    assert all(j.transition is not None for j in assign_joins([1, 2], Picker("fade", seed=1)))  # unchanged default


def test_remap_words_follows_the_cut():
    segs = [Interval(0.0, 1.0), Interval(2.0, 3.0)]  # 1 s cut out at 1-2 s
    words = [Word(0.2, 0.5, "a"), Word(1.2, 1.6, "gone"), Word(2.1, 2.4, "b")]
    assert [(w.text, w.start, w.end) for w in remap_words(words, segs)] == [("a", 0.2, 0.5), ("b", 1.1, 1.4)]


def test_montage_platform_pacing_strong_look_text(tmp_path, talk_video):
    music, _ = _music(tmp_path)
    out = tmp_path / "m.mp4"
    assert main(["montage", str(talk_video), str(talk_video), str(talk_video), str(talk_video), "--music", str(music),
                 "--platform", "shorts", "--pacing", "energy", "--transition", "fade", "--transition-on", "strong",
                 "--look", "film", "--text", "HELLO@0-1:center", "--seed", "1", "-o", str(out)]) == 0
    v = _stream(out, "width", "height", "color_space")
    assert (v["width"], v["height"], v["color_space"]) == (1080, 1920, "bt709")
    keys = _keyframes(out)
    assert len(keys) >= 2 and max(np.diff(keys)) <= 2.0 + 1e-3  # GOP of 2 s for the platform


def test_auto_draft_and_captions(tmp_path, talk_video, capsys):
    words = tmp_path / "w.json"
    words.write_text(json.dumps({"words": [{"start": 0.2, "end": 0.6, "text": "bonjour"},
                                           {"start": 3.1, "end": 3.5, "text": "monde"}]}), encoding="utf-8")
    out = tmp_path / "a.mp4"
    assert main(["auto", str(talk_video), "--draft", "--captions", "tiktok", "--words", str(words),
                 "--text", "TITRE@0-1", "-o", str(out)]) == 0
    info = probe(out)
    assert min(info.width, info.height) <= 540 and info.has_audio
    assert "Sous-titres : 2 mots" in capsys.readouterr().out
