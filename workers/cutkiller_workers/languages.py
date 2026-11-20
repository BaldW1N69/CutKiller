"""Per-language settings of the speech analysis: disfluent prompt, filler words,
forced-alignment model, number spelling.

Whisper is trained to write clean text and drops hesitations; a prompt written
the way people actually speak makes it keep them. The CTC aligner only knows
letters, so numbers are spelled out in the spoken language first.

Adding a language = one entry in LANGUAGES (and its fillers in
packages/core/src/lexicon.ts). A language without an aligner keeps Whisper's
word timestamps (marked `timing: "whisper"`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Language:
    code: str
    prompt: str | None
    fillers: frozenset[str]
    aligner: str | None
    # num2words language code (None: digits are left as is; the aligner skips them).
    numbers: str | None = None


LANGUAGES: dict[str, Language] = {
    "fr": Language(
        "fr",
        "Euh, bon, alors euh… donc, hum, voilà. Euh, je veux dire, ben, en fait, euh.",
        frozenset({"euh", "heu", "euhm", "hum", "hmm", "mmh", "bah", "ben", "beh"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-french",
        "fr",
    ),
    "en": Language(
        "en",
        "Um, so, uh… I mean, like, you know, uh, hmm. Well, um, basically, uh.",
        frozenset({"um", "uh", "uhm", "umm", "uhh", "erm", "er", "hmm", "mm", "mmm", "ah"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-english",
        "en",
    ),
    "es": Language(
        "es",
        "Eh, bueno, este… o sea, em, pues, mmm. Eh, es que, digamos, eh.",
        frozenset({"eh", "em", "ehm", "mmm", "mm", "hmm", "ah"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-spanish",
        "es",
    ),
    "de": Language(
        "de",
        "Äh, also, ähm… naja, hm, sozusagen, äh. Ähm, halt, eigentlich, äh.",
        frozenset({"äh", "ähm", "öh", "öhm", "hm", "hmm", "mhm", "eh"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-german",
        "de",
    ),
    "it": Language(
        "it",
        "Ehm, allora, cioè… eh, insomma, mmm, praticamente, ehm.",
        frozenset({"ehm", "eh", "mmm", "mm", "hmm", "ah", "uhm"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-italian",
        "it",
    ),
    "pt": Language(
        "pt",
        "Hã, então, tipo… é, hum, né, ahn. Hã, assim, sabe, hum.",
        frozenset({"hã", "ahn", "hum", "hmm", "mm", "eh", "ãh"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-portuguese",
        "pt",
    ),
    "nl": Language(
        "nl",
        "Eh, nou, ehm… dus, hmm, zeg maar, eh.",
        frozenset({"eh", "ehm", "uh", "uhm", "hmm", "mm"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-dutch",
        "nl",
    ),
    "pl": Language(
        "pl",
        "Yyy, no więc, eee… wiesz, hmm, jakby, yyy.",
        frozenset({"yyy", "eee", "emm", "hmm", "mmm", "yy"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-polish",
        "pl",
    ),
    "ru": Language(
        "ru",
        "Э-э, ну, вот… эм, как бы, ммм, значит, э-э.",
        frozenset({"э", "ээ", "э-э", "эм", "ммм", "мм", "хм"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-russian",
        "ru",
    ),
    "ar": Language(
        "ar",
        "اممم، يعني، ااا… طيب، ممم، يعني، اه.",
        frozenset({"اممم", "امم", "ااا", "ممم", "اه", "إه"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-arabic",
        "ar",
    ),
    "zh": Language(
        "zh",
        "嗯，那个，呃……就是，额，然后，嗯。",
        frozenset({"嗯", "呃", "额", "啊", "唔"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn",
        None,
    ),
    "ja": Language(
        "ja",
        "えー、あの、えっと……まあ、うーん、なんか、ええと。",
        frozenset({"えー", "えっと", "ええと", "あの", "あのー", "うーん", "えーと"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-japanese",
        "ja",
    ),
    "fi": Language(
        "fi",
        "Öö, niinku, siis… tota, hmm, no, ööh.",
        frozenset({"öö", "ööh", "öh", "hmm", "mm"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-finnish",
        "fi",
    ),
    "el": Language(
        "el",
        "Εεε, λοιπόν, μμμ… δηλαδή, χμ, ας πούμε, εεε.",
        frozenset({"εεε", "εε", "ε", "μμμ", "χμ"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-greek",
        None,
    ),
    "hu": Language(
        "hu",
        "Ööö, hát, szóval… izé, hmm, tehát, ööö.",
        frozenset({"ööö", "öö", "ö", "hmm", "mmm"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-hungarian",
        "hu",
    ),
    "fa": Language(
        "fa",
        "اممم، یعنی، خب… ممم، اینکه، اه.",
        frozenset({"اممم", "امم", "ممم", "اه", "اِ"}),
        "jonatasgrosman/wav2vec2-large-xlsr-53-persian",
        "fa",
    ),
}

GENERIC_FILLERS = frozenset({"hmm", "mm", "mmm", "uh", "um"})


def get(code: str | None) -> Language:
    """Settings of a language; unknown languages transcribe without prompt or aligner."""
    if code in LANGUAGES:
        return LANGUAGES[code]
    return Language(code or "auto", None, GENERIC_FILLERS, None, None)


def fillers(code: str | None) -> frozenset[str]:
    return get(code).fillers


_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def spell_numbers(text: str, code: str | None) -> str:
    """Digits → words in the spoken language, for the CTC aligner."""
    if code == "fr":
        from .numbers import spell_numbers as spell_fr

        return spell_fr(text)
    lang = get(code).numbers
    if lang is None or not _NUMBER.search(text):
        return text
    try:
        from num2words import num2words
    except ImportError:  # optional: digits are skipped by the aligner
        return text

    def one(m: re.Match[str]) -> str:
        raw = m.group(0).replace(",", ".")
        try:
            value = float(raw) if "." in raw else int(raw)
            return num2words(value, lang=lang).replace("-", " ")
        except (NotImplementedError, ValueError, OverflowError):
            return m.group(0)

    return _NUMBER.sub(one, text.replace("%", " percent" if code == "en" else " %"))
