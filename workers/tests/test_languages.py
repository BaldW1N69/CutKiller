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
    # The Greek aligner has an upper-case Greek vocabulary (and a stray Latin « M »).
    greek = {c: i for i, c in enumerate("|'-MΆΈΉΊΌΎΏΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩΪΫ")}
    assert normalize("λόγο", greek, "el") == "ΛΌΓΟ"
    assert normalize("σου,", greek, "el") == "ΣΟΥ"
    # Scripts without case (Arabic, Chinese) are left as they are.
    assert normalize("中国", {"|": 0, "中": 1, "国": 2}, "zh") == "中国"


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


def test_roman_numerals_are_spelled_for_the_aligner():
    from cutkiller_workers.languages import roman_to_digits, spell_numbers

    assert roman_to_digits("Kapitel II.") == "Kapitel 2."
    assert roman_to_digits("Louis XIV") == "Louis 14"
    # Words that look like numerals are left alone: one letter, D/M, invalid forms.
    for word in ["I", "DID", "MIX", "CIVIL", "IIII", "Vive"]:
        assert roman_to_digits(word) == word
    assert spell_numbers("II.", "de").startswith("zwei")
    assert spell_numbers("XIV", "fr") == "quatorze"


def test_aligner_downloads_weights_missing_from_a_partial_cache(monkeypatch):
    """Tokenizer cached, weights not (a CI cache restore): download, do not fail offline."""
    import transformers

    from cutkiller_workers import align

    calls = []

    class Model:
        def eval(self):
            return self

        def to(self, _target):
            return self

    def model_from(name, local_files_only=False):
        calls.append(local_files_only)
        if local_files_only:
            raise OSError(f"{name} does not appear to have a file named model.safetensors")
        return Model()

    monkeypatch.setattr(transformers.Wav2Vec2Processor, "from_pretrained", lambda *a, **k: object())
    monkeypatch.setattr(transformers.Wav2Vec2ForCTC, "from_pretrained", model_from)
    _, model = align._model.__wrapped__("some/aligner")
    assert isinstance(model, Model)
    assert calls == [True, False]
