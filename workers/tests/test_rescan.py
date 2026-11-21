from cutkiller_workers.transcribe import _carve, _plausible, _suspicious


def test_suspicious_words_are_long_for_their_letters():
    assert _suspicious({"text": "depuis", "start": 0.0, "end": 0.62})
    assert not _suspicious({"text": "depuis", "start": 0.0, "end": 0.35})
    assert _suspicious({"text": "a", "start": 0.0, "end": 0.4, "alignScore": 0.9})


def test_carve_splits_the_word_around_a_trailing_filler():
    word = {"text": "depuis", "start": 1.0, "end": 1.6}
    filler = {"text": "euh", "start": 1.35, "end": 1.6}
    pieces = _carve(word, [filler])
    assert [p["text"] for p in pieces] == ["depuis", "euh"]
    assert pieces[0]["end"] == 1.34
    assert pieces[0]["rescanned"] is True  # the carved word is marked; fillers come marked from the rescan


def test_carve_handles_a_leading_filler():
    pieces = _carve({"text": "donc", "start": 2.0, "end": 2.6}, [{"text": "euh", "start": 2.0, "end": 2.25}])
    assert [p["text"] for p in pieces] == ["euh", "donc"]
    assert pieces[1]["start"] == 2.26


def test_fillers_themselves_are_never_rescanned():
    from cutkiller_workers.transcribe import _windows

    words = [
        {"text": "vidéo.", "start": 0.0, "end": 0.4, "timing": "forced"},
        {"text": "Euh,", "start": 1.0, "end": 1.6, "timing": "forced"},
        {"text": "depuis", "start": 2.0, "end": 2.7, "timing": "forced"},
    ]
    assert [k for k, _, _ in _windows(words, 5.0)] == [2]


def test_a_carved_word_left_with_a_few_milliseconds_is_implausible():
    """« euh » stretched over « euh d'autres »: the carved word keeps 20 ms and must be realigned."""
    pieces = _carve(
        {"text": "d'autres", "start": 56.74, "end": 57.45}, [{"text": "euh,", "start": 56.73, "end": 57.42}]
    )
    word = next(p for p in pieces if p["text"] == "d'autres")
    assert not _plausible(word)
    assert _plausible({"text": "d'autres", "start": 56.8, "end": 57.5})
    assert _plausible({"text": "a", "start": 1.0, "end": 1.07})
