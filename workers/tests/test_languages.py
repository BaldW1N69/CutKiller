from cutkiller_workers import languages
from cutkiller_workers.align import normalize


def test_every_language_has_fillers_prompt_and_aligner():
    for code, lang in languages.LANGUAGES.items():
        assert lang.code == code
        assert lang.prompt and lang.aligner and len(lang.fillers) >= 4


def test_unknown_language_falls_back_to_universal_fillers():
    lang = languages.get("sw")
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


def test_device_defaults_to_cpu_and_can_be_forced(monkeypatch):
    from cutkiller_workers import device

    device.device.cache_clear()
    monkeypatch.setenv("CUTKILLER_DEVICE", "cpu")
    assert device.device() == "cpu"
    assert device.whisper_compute_type(None) == "int8"
    assert device.whisper_compute_type("float32") == "float32"
    device.device.cache_clear()
    monkeypatch.setenv("CUTKILLER_DEVICE", "cuda")
    assert device.whisper_compute_type(None) == "float16"
    device.device.cache_clear()
