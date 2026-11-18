"""Failure paths: errors must surface (non-zero exit, ffmpeg's message), never a silent success."""

import os
from pathlib import Path

import numpy as np
import pytest

from cutkiller import cli
from cutkiller.media import MediaError, atomic_output, probe
from cutkiller.transitions.frames import FrameWriter, VideoFormat


def test_framewriter_reports_ffmpeg_death(tmp_path):
    with pytest.raises(RuntimeError, match="Encodage de la transition impossible"):
        with FrameWriter(tmp_path / "missing_dir" / "t.mkv", VideoFormat(64, 64, 30)) as w:
            for _ in range(5000):  # enough bytes to hit the closed pipe
                w.write(np.zeros((64, 64, 3), np.uint8))


def test_cli_exits_non_zero_when_an_encoder_dies(monkeypatch, capsys):
    def boom(_a):
        raise BrokenPipeError(32, "Broken pipe")  # not stdout: an ffmpeg pipe

    monkeypatch.setattr(cli, "cmd_doctor", boom)
    assert cli.main(["doctor"]) == 1
    assert "Erreur" in capsys.readouterr().err


def test_probe_is_cached_and_invalidated(talk_video, tmp_path, monkeypatch):
    import cutkiller.media as media

    calls = []
    real = media._probe
    monkeypatch.setattr(media, "_probe", lambda p: calls.append(p) or real(p))
    media._probe_cached.cache_clear()
    copy = tmp_path / "copy.mp4"
    copy.write_bytes(talk_video.read_bytes())
    a, b = probe(copy), probe(str(copy))
    assert a == b and len(calls) == 1
    os.utime(copy, ns=(1, 1))  # rewritten file → probed again
    probe(copy)
    assert len(calls) == 2
    with pytest.raises(MediaError, match="introuvable"):
        probe(tmp_path / "nope.mp4")


def test_atomic_output_never_leaves_partial_files(tmp_path):
    dst = tmp_path / "out.mp4"
    with pytest.raises(ValueError):
        with atomic_output(dst) as tmp:
            Path(tmp).write_bytes(b"half")
            raise ValueError("render failed")
    assert list(tmp_path.iterdir()) == []
    with atomic_output(dst) as tmp:
        Path(tmp).write_bytes(b"done")
    assert dst.read_bytes() == b"done" and [p.name for p in tmp_path.iterdir()] == ["out.mp4"]
