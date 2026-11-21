"""Nombres écrits en chiffres → mots français, pour l'alignement acoustique.

Whisper écrit « 14 », « 12h15 » ou « 2024 » ; le modèle CTC ne connaît que des
lettres. Sans ce passage, le son « quatorze » n'a pas de cible et il est absorbé
par les mots voisins, dont les frontières se décalent.
"""

from __future__ import annotations

import re

_UNITS = [
    "zéro",
    "un",
    "deux",
    "trois",
    "quatre",
    "cinq",
    "six",
    "sept",
    "huit",
    "neuf",
    "dix",
    "onze",
    "douze",
    "treize",
    "quatorze",
    "quinze",
    "seize",
]
_TENS = {2: "vingt", 3: "trente", 4: "quarante", 5: "cinquante", 6: "soixante"}


def _below_100(n: int) -> str:
    if n < 17:
        return _UNITS[n]
    if n < 20:
        return f"dix {_UNITS[n - 10]}"
    tens, unit = divmod(n, 10)
    if tens in (7, 9):  # soixante-dix…, quatre-vingt-dix…
        base = "soixante" if tens == 7 else "quatre vingt"
        rest = _below_100(10 + unit)
        return f"{base} et {rest}" if tens == 7 and unit == 1 else f"{base} {rest}"
    if tens == 8:
        return "quatre vingts" if unit == 0 else f"quatre vingt {_UNITS[unit]}"
    word = _TENS[tens]
    if unit == 0:
        return word
    return f"{word} et un" if unit == 1 else f"{word} {_UNITS[unit]}"


def spell(n: int) -> str:
    """French words for 0 ≤ n < 1 000 000 (spaces instead of hyphens)."""
    if n < 100:
        return _below_100(n)
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        head = "cent" if hundreds == 1 else f"{_UNITS[hundreds]} cent{'s' if rest == 0 else ''}"
        return head if rest == 0 else f"{head} {_below_100(rest)}"
    thousands, rest = divmod(n, 1000)
    head = "mille" if thousands == 1 else f"{spell(thousands)} mille"
    return head if rest == 0 else f"{head} {spell(rest)}"


_TIME = re.compile(r"(\d{1,2})\s*h\s*(\d{2})?")
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def _number(m: re.Match[str]) -> str:
    text = m.group(0)
    if "," in text or "." in text:
        whole, frac = re.split(r"[.,]", text)
        return f"{spell(int(whole))} virgule {spell(int(frac))}"
    n = int(text)
    return spell(n) if n < 1_000_000 else " ".join(spell(int(d)) for d in text)


def spell_numbers(text: str) -> str:
    """« 12h15 » → « douze heures quinze », « 14 » → « quatorze », « 3,5 » → « trois virgule cinq »."""
    text = _TIME.sub(
        lambda m: f"{spell(int(m.group(1)))} heures" + (f" {spell(int(m.group(2)))}" if m.group(2) else ""),
        text,
    )
    text = text.replace("%", " pour cent")
    return _NUMBER.sub(_number, text)
