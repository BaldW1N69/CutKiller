from cutkiller_workers.align import normalize
from cutkiller_workers.numbers import spell, spell_numbers


def test_spell_french_numbers():
    assert spell(14) == "quatorze"
    assert spell(21) == "vingt et un"
    assert spell(71) == "soixante et onze"
    assert spell(80) == "quatre vingts"
    assert spell(97) == "quatre vingt dix sept"
    assert spell(200) == "deux cents"
    assert spell(207) == "deux cent sept"
    assert spell(2024) == "deux mille vingt quatre"


def test_spell_numbers_in_transcript_words():
    assert spell_numbers("12h15,") == "douze heures quinze,"
    assert spell_numbers("14h") == "quatorze heures"
    assert spell_numbers("3,5") == "trois virgule cinq"
    assert spell_numbers("50%") == "cinquante pour cent"


def test_numbers_become_alignable_letters():
    vocab = {c: i for i, c in enumerate("|abcdefghijklmnopqrstuvwxyzéèêàùç'")}
    assert normalize("14", vocab) == "quatorze"
    assert normalize("12h15,", vocab) == "douze|heures|quinze"
    assert normalize("Aujourd’hui", vocab) == "aujourd'hui"
