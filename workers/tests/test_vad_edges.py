"""The VAD worker reports how loud the first and last 30 ms of a recording are."""

import shutil
import subprocess

import pytest

from cutkiller_workers.vad import vad

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg absent")


def _tone(path, afilter):
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=220:duration=2",
            "-af",
            afilter,
            str(path),
        ],
        check=True,
    )


def test_cut_off_sound_is_loud_on_its_edge_a_faded_one_is_not(tmp_path):
    cut = tmp_path / "cut.wav"
    faded = tmp_path / "faded.wav"
    _tone(cut, "volume=0.5")
    _tone(faded, "volume=0.5,afade=t=out:st=1.6:d=0.4")
    a, b = vad({"path": str(cut)}), vad({"path": str(faded)})
    assert a["edgeDb"]["end"] > a["speechDb"] - 15
    assert b["edgeDb"]["end"] < b["speechDb"] - 15


def test_codec_padding_does_not_hide_a_cut_off_word(tmp_path):
    padded = tmp_path / "padded.wav"
    _tone(padded, "volume=0.5,apad=pad_dur=0.032")
    a = vad({"path": str(padded)})
    assert a["edgeDb"]["end"] > a["speechDb"] - 15
