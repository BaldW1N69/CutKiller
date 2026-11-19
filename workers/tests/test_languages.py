from cutkiller_workers import languages
from cutkiller_workers.align import normalize


def test_every_language_has_fillers_prompt_and_aligner():
    for code, lang in languages.LANGUAGES.items():
        assert lang.code == code
        assert lang.prompt and lang.aligner and len(lang.fillers) >= 4


def test_unknown_language_falls_back_to_universal_fillers():
    lang = languages.get("ja")
    assert lang.aligner is None and lang.prompt is None
    assert "hmm" in lang.fillers


def test_numbers_spelled_in_the_spoken_language():
    assert languages.spell_numbers("14", "fr") == "quatorze"
    assert languages.spell_numbers("21", "en") == "twenty one"
    assert languages.spell_numbers("3", "es") == "tres"
    assert languages.spell_numbers("abc", "en") == "abc"


def test_normalize_matches_the_vocabulary_case():
    lower = {c: i for i, c in enumerate("|abcdefghijklmnopqrstuvwxyz'")}
    upper = {c: i for i, c in enumerate("|ABCDEFGHIJKLMNOPQRSTUVWXYZ'")}
    assert normalize("Twenty-one", lower, "en") == "twenty|one"
    assert normalize("It's 2", upper, "en") == "IT'S|TWO"
