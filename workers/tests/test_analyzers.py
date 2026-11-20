"""Tests des workers d'analyse sur des signaux dont la vérité est connue."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
SPEECH = ROOT / ".cache" / "fixtures" / "speech-fr.wav"
TRUTH = ROOT / ".cache" / "fixtures" / "speech-fr.truth.json"


@pytest.fixture(scope="module")
def click_track(tmp_path_factory) -> tuple[Path, list[float]]:
    """120 BPM clicks over a quiet pad, first hit at 0.25 s."""
    rate = 44_100
    t = np.arange(int(rate * 12)) / rate
    y = 0.05 * np.sin(2 * np.pi * 110 * t)
    hits = [0.25 + 0.5 * k for k in range(23)]
    for h in hits:
        a = int(h * rate)
        n = int(0.03 * rate)
        y[a : a + n] += 0.8 * np.sin(2 * np.pi * 1000 * t[:n]) * np.exp(-np.arange(n) / (0.008 * rate))
    path = tmp_path_factory.mktemp("beats") / "clicks.wav"
    sf.write(path, y.astype(np.float32), rate)
    return path, hits


def test_beats_are_sample_accurate(click_track):
    from cutkiller_workers.beats import beats

    path, hits = click_track
    result = beats({"path": str(path)})
    assert abs(result["tempoBpm"] - 120) < 2
    errors = [min(abs(b - h) for h in hits) for b in result["beats"]]
    assert len(result["beats"]) >= 20
    assert max(errors) < 0.005  # 5 ms, well under a 30 fps frame


needs_speech = pytest.mark.skipif(
    not SPEECH.exists(), reason="fixture vocale absente : lancer `pnpm fixtures` (requiert espeak-ng)"
)


@needs_speech
def test_vad_covers_every_spoken_word():
    from cutkiller_workers.vad import vad

    result = vad({"path": str(SPEECH)})
    truth = json.loads(TRUTH.read_text())["words"]
    for w in truth:
        mid = (w["start"] + w["end"]) / 2
        assert any(s["start"] - 0.05 <= mid <= s["end"] + 0.05 for s in result["speech"]), w["text"]


def test_refine_boundaries_moves_ctc_edges_to_the_signal():
    from cutkiller_workers.align import refine_boundaries

    rate = 16_000
    audio = np.zeros(rate * 2, dtype=np.float32)
    rng = np.random.default_rng(0)
    audio[int(0.50 * rate) : int(0.90 * rate)] = 0.3 * rng.standard_normal(int(0.4 * rate))
    # CTC-like span: starts late, ends early.
    words = [{"text": "mot", "start": 0.56, "end": 0.80, "timing": "forced"}]
    out = refine_boundaries(audio, words, rate)
    assert abs(out[0]["start"] - 0.50) <= 0.01
    assert abs(out[0]["end"] - 0.90) <= 0.01


def test_merge_apostrophes():
    from cutkiller_workers.align import merge_apostrophes

    words = [{"text": "aujourd", "start": 0.0, "end": 0.3}, {"text": "'hui", "start": 0.3, "end": 0.5}]
    assert merge_apostrophes(words) == [{"text": "aujourd'hui", "start": 0.0, "end": 0.5, "prob": 1.0}]


def test_merge_split_words_and_punctuation():
    from cutkiller_workers.align import merge_apostrophes

    words = [
        {"text": "que", "start": 7.92, "end": 8.0, "prob": 0.9},
        {"text": "pensez", "start": 8.04, "end": 8.3, "prob": 0.9},
        {"text": "-vous", "start": 8.34, "end": 8.7, "prob": 0.8},
        {"text": "du", "start": 9.59, "end": 9.68, "prob": 0.9},
        {"text": "projet", "start": 9.7, "end": 9.9, "prob": 0.9},
        # Detached « ? », timestamped inside the next word.
        {"text": "?", "start": 9.94, "end": 10.2, "prob": 0.5},
        {"text": "Alors,", "start": 10.92, "end": 11.2, "prob": 0.9},
        {"text": "...", "start": 11.2, "end": 11.4, "prob": 0.3},
    ]
    out = merge_apostrophes(words)
    assert [w["text"] for w in out] == ["que", "pensez-vous", "du", "projet?", "Alors,..."]
    assert out[1]["end"] == 8.7
    # The mark adds no duration to the word it joins.
    assert out[3]["end"] == 9.9


@pytest.mark.models
@needs_speech
def test_transcription_is_word_accurate_on_french_speech():
    """Whisper + alignement forcé : erreur de frontière ≤ 1 frame à 30 fps au p95."""
    import difflib
    import re

    from cutkiller_workers.transcribe import transcribe

    result = transcribe({"path": str(SPEECH), "model": "large-v3-turbo"})
    truth = json.loads(TRUTH.read_text())["words"]
    norm = lambda s: re.sub(r"[^\w']", "", s.lower())
    got = result["words"]
    sm = difflib.SequenceMatcher(
        a=[norm(w["text"]) for w in truth], b=[norm(w["text"]) for w in got], autojunk=False
    )
    errors = []
    for a, b, n in sm.get_matching_blocks():
        for k in range(n):
            errors += [
                abs(got[b + k]["start"] - truth[a + k]["start"]),
                abs(got[b + k]["end"] - truth[a + k]["end"]),
            ]
    assert len(errors) >= 0.7 * 2 * len(truth)
    errors.sort()
    assert errors[int(0.95 * len(errors)) - 1] <= 1 / 30
    assert sum(norm(w["text"]) == "euh" for w in got) >= 2, "les hésitations doivent être transcrites"


def test_espeak_available_for_fixtures():
    if shutil.which("espeak-ng") is None:
        pytest.skip("espeak-ng absent")
    out = subprocess.run(["espeak-ng", "--version"], capture_output=True, text=True, check=False)
    assert out.returncode == 0


def test_prosody_finds_the_loud_high_word(tmp_path):
    """Three tones as « words »: the middle one louder and higher must stand out."""
    from cutkiller_workers.prosody import prosody

    rate = 16_000
    t = np.arange(int(rate * 0.4)) / rate
    quiet = 0.05 * np.sin(2 * np.pi * 120 * t)
    loud = 0.4 * np.sin(2 * np.pi * 220 * t)
    gap = np.zeros(int(rate * 0.2))
    y = np.concatenate([gap, quiet, gap, loud, gap, quiet, gap]).astype(np.float32)
    path = tmp_path / "words.wav"
    sf.write(path, y, rate)
    words = [{"start": 0.2, "end": 0.6}, {"start": 0.8, "end": 1.2}, {"start": 1.4, "end": 1.8}]
    out = prosody({"path": str(path), "words": words})["words"]
    assert out[1]["rmsDb"] > out[0]["rmsDb"] + 15
    assert abs(out[0]["pitchSt"] - 12 * np.log2(1.2)) < 0.5
    assert abs(out[1]["pitchSt"] - 12 * np.log2(2.2)) < 0.5


def test_subjects_measure_the_tonal_range(tmp_path):
    """Each sample carries the picture's luma p5 / p50 / p95 (scene-adaptive look)."""
    from cutkiller_workers.subjects import subjects

    video = tmp_path / "split.mp4"
    # Left 40 % black, right 60 % white: p5 ≈ 0, p50 and p95 ≈ 1.
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=white:s=320x180:d=1:r=25",
            "-vf",
            "drawbox=x=0:y=0:w=128:h=180:color=black:t=fill,format=yuv420p",
            "-y",
            str(video),
        ],
        check=True,
    )
    out = subjects({"path": str(video), "fps": 5})
    assert len(out["samples"]) == 5
    for s in out["samples"]:
        p5, p50, p95 = s["luma"]
        assert p5 < 0.1
        assert p50 > 0.9
        assert p95 > 0.9


def test_activity_follows_a_small_moving_square(tmp_path):
    import subprocess

    from cutkiller_workers.activity import activity

    video = tmp_path / "screen.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x1e1e1e:s=640x360:r=30:d=4",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=12x12:r=30:d=4",
            "-filter_complex",
            "[0:v][1:v]overlay=x='if(lt(t,2),60+mod(t*60,60),500+mod(t*60,60))':y='if(lt(t,2),60,280)',format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-y",
            str(video),
        ],
        check=True,
    )
    samples = activity({"path": str(video)})["samples"]
    early = [s for s in samples if 0.4 < s["t"] < 1.8 and s["fraction"] > 0]
    late = [s for s in samples if 2.4 < s["t"] < 3.8 and s["fraction"] > 0]
    assert early and late
    assert all(s["cx"] < 0.3 and s["cy"] < 0.3 for s in early)
    assert all(s["cx"] > 0.7 and s["cy"] > 0.7 for s in late)
    assert all(s["fraction"] < 0.01 for s in early + late)
