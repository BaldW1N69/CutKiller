import subprocess
import sys

import numpy as np
import pytest

from cutkiller.cli import main, run_doctor
from cutkiller.edit.text import Cue, build_ass, burn_text, parse_cue, parse_srt
from cutkiller.media import probe


def test_parse_cue_variants():
    c = parse_cue("SOLDES -50 %@0-3:center:yellow:9%")
    assert (c.text, c.start, c.end, c.position, c.color, c.size) == ("SOLDES -50 %", 0.0, 3.0, "center", "yellow", 9.0)
    c = parse_cue("Code PUB10\\nlivraison offerte@5-")
    assert c.text == "Code PUB10\nlivraison offerte" and c.end is None and c.position == "bottom"
    assert parse_cue("a@b@2.5-4:#ff8800").color == "#ff8800"
    for bad in ("sans temps", "x@abc", "x@3-1", "x@0-2:inconnu"):
        with pytest.raises(ValueError):
            parse_cue(bad)


def test_parse_srt():
    cues = parse_srt("﻿1\n00:00:01,500 --> 00:00:03,000\nSalut\nle monde\n\n2\n00:01:00,000 --> 00:01:02,250\nSuite\n")
    assert [(c.start, c.end, c.text) for c in cues] == [(1.5, 3.0, "Salut\nle monde"), (60.0, 62.25, "Suite")]


def test_build_ass_styles_and_escape():
    cues = [Cue("A {x} \\ b\nc", 0.0, 3.0, "center", "yellow", 9), Cue("B", 4.0, None), Cue("hors durée", 50.0, 60.0)]
    ass = build_ass(cues, 1080, 1920, 10.0)
    assert "PlayResX: 1080" in ass and ass.count("Style: S") == 2
    assert "Dialogue: 0,0:00:00.00,0:00:03.00,S0" in ass and "0:00:04.00,0:00:10.00,S1" in ass
    assert "hors durée" not in ass
    assert "A (x) \\\\ b\\Nc" in ass
    assert "&H0000E6FF" in ass  # jaune FFE600 en BGR


def _frame(path, t):
    out = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out, np.uint8).astype(np.int16)


def test_burn_text_changes_only_the_cue_window(talk_video, tmp_path):
    out = burn_text(talk_video, tmp_path / "t.mp4", [Cue("HELLO", 1.0, 2.0, "center", size=14)])
    a, b = probe(talk_video), probe(out)
    assert abs(a.duration - b.duration) < 0.1 and b.has_audio
    inside = np.abs(_frame(talk_video, 1.5) - _frame(out, 1.5)).mean()
    outside = np.abs(_frame(talk_video, 3.0) - _frame(out, 3.0)).mean()  # = seulement le bruit du ré-encodage
    assert inside > 3 * outside and outside < 2.0, (inside, outside)


def test_cli_text_and_errors(talk_video, tmp_path, capsys):
    srt = tmp_path / "s.srt"
    srt.write_text("1\n00:00:00,500 --> 00:00:01,500\nÉté à Paris\n", encoding="utf-8")
    out = tmp_path / "o.mp4"
    assert main(["text", str(talk_video), "-o", str(out), "--text", "Titre@0-1:top", "--srt", str(srt)]) == 0
    assert probe(out).has_video
    assert main(["text", str(talk_video)]) == 1
    assert "Rien à incruster" in capsys.readouterr().err


def test_doctor_reports_core_tools():
    rows = {r["name"]: r for r in run_doctor()}
    assert rows["ffmpeg"]["status"] == "ok" and rows["ffprobe"]["status"] == "ok"
    assert main(["doctor"]) == 0


def test_console_stays_utf8_under_legacy_encoding():
    """Windows (cp1252 / redirection) : les accents et flèches ne doivent pas faire planter la CLI."""
    env = {"PYTHONIOENCODING": "ascii", "PATH": __import__("os").environ["PATH"]}
    r = subprocess.run([sys.executable, "-m", "cutkiller", "transitions", "list", "--family", "fx"], env=env,
                       capture_output=True)
    assert r.returncode == 0, r.stderr.decode(errors="replace")
    assert "illimité".encode() in r.stdout
