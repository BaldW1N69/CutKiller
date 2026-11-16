import numpy as np

from conftest import PATTERN, SR, click_track, speech_like
from cutkiller.listen import listen
from cutkiller.listen.beats import analyze_beats, snap
from cutkiller.listen.loudness import LoudnessInfo, diagnose, parse_ebur128
from cutkiller.listen.silence import Interval, auto_threshold, complement, detect_silences, frame_db
from cutkiller.listen.transcribe import Word, to_srt


def test_detect_silences_finds_the_gaps():
    audio = speech_like(PATTERN)
    silences, thr = detect_silences(audio, SR, min_silence=0.3)
    assert len(silences) == 2
    assert abs(silences[0].start - 1.5) < 0.06 and abs(silences[0].end - 3.0) < 0.06
    assert abs(silences[1].start - 4.5) < 0.06 and abs(silences[1].end - 5.5) < 0.06
    assert -60 <= thr <= -18


def test_min_silence_ignores_short_pauses():
    audio = speech_like([(1.0, True), (0.2, False), (1.0, True)])
    silences, _ = detect_silences(audio, SR, min_silence=0.35)
    assert silences == []


def test_explicit_threshold_and_digital_silence():
    audio = np.zeros(SR, dtype=np.float32)
    silences, thr = detect_silences(audio, SR, threshold_db=-40)
    assert thr == -40 and len(silences) == 1 and silences[0].duration > 0.95
    assert auto_threshold(frame_db(audio, SR)) <= -50


def test_complement():
    assert complement([Interval(1, 2), Interval(3, 4)], 5) == [Interval(0, 1), Interval(2, 3), Interval(4, 5)]
    assert complement([], 2) == [Interval(0, 2)]


def test_tempo_and_beats_on_click_track():
    info = analyze_beats(click_track(120, 8.0, SR), SR)
    assert abs(info.bpm - 120) < 3, info.bpm
    diffs = np.diff(info.beats)
    assert abs(np.median(diffs) - 0.5) < 0.03
    assert len(info.onsets) >= 14


def test_snap():
    assert snap(1.04, [0.5, 1.0, 1.5], 0.1) == 1.0
    assert snap(1.2, [0.5, 1.0, 1.5], 0.1) == 1.2


def test_parse_ebur128_summary():
    stderr = """[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -23.4 LUFS
    Threshold: -33.6 LUFS

  Loudness range:
    LRA:         5.2 LU

  True peak:
    Peak:       -1.3 dBFS"""
    d = parse_ebur128(stderr)
    assert d == {"integrated_lufs": -23.4, "loudness_range": 5.2, "true_peak_dbtp": -1.3}


def test_diagnose_warnings():
    info = LoudnessInfo(-28.0, 6.0, -0.2, -0.1, 0.01, -40.0)
    msgs = " ".join(diagnose(info, -14))
    assert "trop faible" in msgs and "Saturation" in msgs and "True peak" in msgs and "Bruit de fond" in msgs


def test_srt_skips_fillers_and_groups_words():
    words = [Word(0.0, 0.3, "Salut"), Word(0.35, 0.5, "euh"), Word(0.55, 0.9, "tout"), Word(0.95, 1.2, "le"),
             Word(1.25, 1.6, "monde"), Word(3.0, 3.4, "Suite")]
    srt = to_srt(words)
    assert "euh" not in srt
    assert "Salut tout le monde" in srt and "00:00:03,000 --> 00:00:03,400" in srt
    assert Word(0, 1, "Euh,").is_filler


def test_listen_end_to_end(talk_video):
    rep = listen(talk_video, with_beats=True)
    assert len(rep.silences) == 2
    assert 0.3 < rep.silence_ratio < 0.45
    assert rep.loudness and rep.loudness.integrated_lufs is not None
    d = rep.to_dict()
    assert d["speech"] and "loudness" in d and "beats" in d
    assert "Silences" in rep.summary()
