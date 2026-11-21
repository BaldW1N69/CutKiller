"""Alignement forcé CTC (wav2vec2 XLSR par langue, Apache-2.0) des mots transcrits.

Les timestamps de Whisper dérivent de ±100-250 ms ; l'alignement forcé sur les
caractères ramène l'erreur autour d'une trame CTC (20 ms). Les mots sans aucun
caractère alignable gardent leur timing Whisper et sont marqués comme tels.
"""

from __future__ import annotations

import os
import re
import unicodedata
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np

from . import languages
from .audio import load_mono

MODEL_FR = languages.LANGUAGES["fr"].aligner
RATE = 16_000
FRAME_S = 320 / RATE  # wav2vec2 stride: 20 ms per emission frame
MAX_WINDOW_S = 25.0
PAD_S = 0.4


def _hf_home() -> str:
    return os.environ.get("HF_HOME", str(Path.home() / ".cache" / "cutkiller" / "hf"))


@cache
def _model(name: str):
    os.environ.setdefault("HF_HOME", _hf_home())
    import torch
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    torch.set_num_threads(int(os.environ.get("CUTKILLER_THREADS", os.cpu_count() or 4)))
    try:  # a cached model loads without asking the Hub (one request per file otherwise)
        processor = Wav2Vec2Processor.from_pretrained(name, local_files_only=True)
        local = True
    except OSError:
        processor = Wav2Vec2Processor.from_pretrained(name)
        local = False
    from .device import device

    # The default install ships the CPU build of PyTorch: only move when it sees CUDA.
    target = "cuda" if device() == "cuda" and torch.cuda.is_available() else "cpu"
    model = Wav2Vec2ForCTC.from_pretrained(name, local_files_only=local).eval().to(target)
    return processor, model


def normalize(word: str, vocab: dict[str, int], language: str | None = "fr") -> str:
    """Lower-case, spell numbers out, keep only characters the acoustic model knows.

    Spaces inside a spelled number (« quatorze heures ») come back as "|", the
    model's word delimiter. Models with an upper-case vocabulary get upper case."""
    text = unicodedata.normalize("NFC", languages.spell_numbers(word, language).lower())
    text = text.replace("’", "'").replace("-", " ")
    upper = "a" not in vocab and "A" in vocab
    if upper:
        text = text.upper()
    kept = "".join(ch for ch in text if ch == " " or (ch in vocab and ch != "|"))
    return "|".join(part for part in kept.split(" ") if part)


def _windows(words: list[dict[str, Any]], duration: float) -> list[tuple[int, int, float, float]]:
    """Groups consecutive words into audio windows of at most MAX_WINDOW_S."""
    out: list[tuple[int, int, float, float]] = []
    i = 0
    while i < len(words):
        start = max(0.0, words[i]["start"] - PAD_S)
        j = i
        while j + 1 < len(words) and words[j + 1]["end"] + PAD_S - start <= MAX_WINDOW_S:
            j += 1
        end = min(duration, words[j]["end"] + PAD_S)
        out.append((i, j + 1, start, end))
        i = j + 1
    return out


def noise_floor_db(audio: np.ndarray, rate: int = RATE) -> float:
    """Level the recording's quiet parts sit at (10th percentile of short-term energy)."""
    db = _energy_db(audio, rate)
    return float(np.percentile(db, 10)) if len(db) else -120.0


def align_words(
    path: str | None,
    words: list[dict[str, Any]],
    model_name: str | None = None,
    audio: np.ndarray | None = None,
    floor_db: float | None = None,
    language: str | None = "fr",
) -> list[dict[str, Any]]:
    model_name = model_name or languages.get(language).aligner or MODEL_FR
    import torch
    import torchaudio.functional as F

    processor, model = _model(model_name)
    vocab = processor.tokenizer.get_vocab()
    blank = processor.tokenizer.pad_token_id
    delimiter = vocab["|"]
    if audio is None:
        audio = load_mono(str(path), RATE)
    duration = len(audio) / RATE
    result = [dict(w, timing="whisper") for w in words]

    for a, b, ws, we in _windows(words, duration):
        chunk = audio[int(ws * RATE) : int(we * RATE)]
        inputs = processor(chunk, sampling_rate=RATE, return_tensors="pt")
        with torch.inference_mode():
            values = inputs.input_values.to(next(model.parameters()).device)
            log_probs = torch.log_softmax(model(values).logits, dim=-1).cpu()
        targets: list[int] = []
        owner: list[int] = []  # word index of each target token (-1 for delimiters)
        for k in range(a, b):
            chars = normalize(words[k]["text"], vocab, language)
            if not chars:
                continue
            if targets:
                targets.append(delimiter)
                owner.append(-1)
            targets.extend(vocab[c] for c in chars)
            owner.extend([k] * len(chars))
        if not targets or log_probs.shape[1] < len(targets):
            continue
        labels, scores = F.forced_align(log_probs, torch.tensor([targets], dtype=torch.int32), blank=blank)
        spans = F.merge_tokens(labels[0], scores[0].exp())
        first: dict[int, float] = {}
        last: dict[int, float] = {}
        conf: dict[int, list[float]] = {}
        for span, k in zip(spans, owner, strict=True):
            if k < 0:
                continue
            first.setdefault(k, ws + span.start * FRAME_S)
            last[k] = ws + span.end * FRAME_S
            conf.setdefault(k, []).append(float(span.score))
        for k, start in first.items():
            result[k].update(
                start=round(start, 3),
                end=round(max(last[k], start + FRAME_S), 3),
                alignScore=round(float(np.mean(conf[k])), 3),
                timing="forced",
            )
    return refine_boundaries(audio, result, floor_db=floor_db)


_APOSTROPHE = re.compile(r"^['’]")


def merge_apostrophes(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Glue back what Whisper splits off a word.

    - « aujourd » + « 'hui », « pensez » + « -vous », « Qu'est » + « -ce »: one word;
    - French typography puts a space before « ? ! : ; », so Whisper returns « ? »
      as a word of its own, with a timestamp of its own (often inside the next
      word): the mark joins the previous word, which keeps its timing. A token
      with no letter or digit is never a word: it would read as an empty
      hesitation and cut speech.
    """
    out: list[dict[str, Any]] = []
    for w in words:
        text = w["text"]
        if out and (_APOSTROPHE.match(text) or (text.startswith("-") and len(text) > 1)):
            prev = out[-1]
            prev["text"] += text
            prev["end"] = w["end"]
            prev["prob"] = round(min(prev.get("prob", 1.0), w.get("prob", 1.0)), 3)
        elif not any(ch.isalnum() for ch in text):
            if out:
                out[-1]["text"] += text
        else:
            out.append(dict(w))
    return out


HOP_S = 0.005


def _energy_db(audio: np.ndarray, rate: int) -> np.ndarray:
    hop = int(HOP_S * rate)
    win = hop * 2
    n = max(1, (len(audio) - win) // hop + 1)
    frames = np.lib.stride_tricks.sliding_window_view(audio, win)[::hop][:n]
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms)


def refine_boundaries(
    audio: np.ndarray,
    words: list[dict[str, Any]],
    rate: int = RATE,
    max_extend_s: float = 0.2,
    floor_db: float | None = None,
) -> list[dict[str, Any]]:
    """Moves CTC boundaries to where the voice actually starts and fades out.

    CTC emits a spike per character, so its word starts lag and its ends lead the
    real sound. Each boundary is pushed outwards while the signal stays above a
    threshold set between the noise floor and the word's peak, never crossing into
    the neighbouring word. The noise floor is a property of the recording: an edit
    with its pauses removed must be refined with the floor of its rush
    (`floor_db`), not with its own, much higher one.
    """
    db = _energy_db(audio, rate)
    if len(db) == 0:
        return words
    floor = float(np.percentile(db, 10)) if floor_db is None else floor_db
    out = [dict(w) for w in words]
    idx = lambda t: int(np.clip(round(t / HOP_S), 0, len(db) - 1))
    for k, w in enumerate(out):
        if w.get("timing") != "forced":
            continue
        a, b = idx(w["start"]), idx(w["end"])
        peak = float(db[a : b + 1].max()) if b >= a else float(db[a])
        threshold = max(floor + 12, peak - 40)
        lo_bound = idx(out[k - 1]["end"] + 0.01) if k > 0 else 0
        hi_bound = idx(out[k + 1]["start"] - 0.01) if k + 1 < len(out) else len(db) - 1
        lo_bound = max(lo_bound, idx(w["start"] - max_extend_s))
        hi_bound = min(hi_bound, idx(w["end"] + max_extend_s))
        while a > lo_bound and db[a - 1] > threshold:
            a -= 1
        while b < hi_bound and db[b + 1] > threshold:
            b += 1
        # Also pull a boundary inwards when the CTC span starts or ends in silence.
        while a < b and db[a] <= threshold:
            a += 1
        while b > a and db[b] <= threshold:
            b -= 1
        w["start"] = round(a * HOP_S, 3)
        w["end"] = round((b + 2) * HOP_S, 3)  # frame b covers [b*hop, b*hop + win)
    return out
