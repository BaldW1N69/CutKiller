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
