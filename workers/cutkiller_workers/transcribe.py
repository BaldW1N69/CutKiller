"""Transcription au mot (faster-whisper) avec conservation des hésitations."""

from __future__ import annotations

import os
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np

# Whisper is trained to write clean text and drops "euh"; a disfluent prompt
# makes it keep them (fillers are what the cut pass needs to find).
DISFLUENT_PROMPT_FR = "Euh, bon, alors euh… donc, hum, voilà. Euh, je veux dire, ben, en fait, euh."


def models_dir() -> str:
    return os.environ.get("CUTKILLER_MODELS", str(Path.home() / ".cache" / "cutkiller" / "models"))


@cache
def _model(name: str, compute_type: str):
    from faster_whisper import WhisperModel

    threads = int(os.environ.get("CUTKILLER_THREADS", os.cpu_count() or 4))
    return WhisperModel(
        name, device="cpu", compute_type=compute_type, cpu_threads=threads, download_root=models_dir()
    )


def transcribe(request: dict[str, Any]) -> dict[str, Any]:
    path = request["path"]
    language = request.get("language", "fr")
    model_name = request.get("model", "small")
    model = _model(model_name, request.get("computeType", "int8"))
    prompt = request.get("initialPrompt", DISFLUENT_PROMPT_FR if language == "fr" else None)
    from .audio import load_mono

    # Decoded by our FFmpeg on the container timeline (not by PyAV inside faster-whisper):
    # same time origin as every other analyzer, no dependency on the PyAV version.
    audio = load_mono(path, 16_000)
    segments, info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=False,
        beam_size=request.get("beamSize", 5),
        initial_prompt=prompt,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append(
                    {
                        "text": text,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "prob": round(w.probability, 3),
                    }
                )
    from .align import align_words, merge_apostrophes

    words = merge_apostrophes(words)
    if request.get("align", True) and language == "fr" and words:
        words = align_words(path, words)
        if request.get("fillerRescan", True):
            words = rescan_fillers(path, words, model, prompt)
    return {
        "language": info.language,
        "durationS": round(info.duration, 3),
        "model": model_name,
        "words": words,
    }


FILLERS = {"euh", "heu", "euhm", "hum", "hmm", "mmh", "bah", "ben", "beh"}
RESCAN_PAD_S = 0.35
MAX_RESCANS = 200


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum() or ch == "'")


def _suspicious(word: dict[str, Any]) -> bool:
    """A word much longer than its letters explain may hide a hesitation Whisper dropped."""
    letters = len(_norm(word["text"]))
    duration = word["end"] - word["start"]
    return duration > 0.18 + 0.06 * letters or word.get("alignScore", 1.0) < 0.2


def _windows(words: list[dict[str, Any]], duration: float) -> list[tuple[int, float, float]]:
    """Suspicious words and the audio window around each (up to the neighbouring words)."""
    out = []
    for k, w in enumerate(words):
        if w.get("timing") != "forced" or _norm(w["text"]) in FILLERS or not _suspicious(w):
            continue
        a = words[k - 1]["end"] if k > 0 else w["start"] - RESCAN_PAD_S
        b = words[k + 1]["start"] if k + 1 < len(words) else w["end"] + RESCAN_PAD_S
        a = max(0.0, min(a, w["start"] - 0.05))
        b = min(duration, max(b, w["end"] + 0.05))
        out.append((k, a, b))
    return out[:MAX_RESCANS]


BATCH_S = 28.0
GAP_S = 1.0


def rescan_fillers(
    path: str, words: list[dict[str, Any]], model: Any, prompt: str | None
) -> list[dict[str, Any]]:
    """Re-transcribes short windows around suspicious words (much longer than their
    letters explain): in a short local context Whisper often writes the « euh » it
    smoothed over in the full pass. Windows are packed, separated by silence, into
    ~28 s batches so each Whisper pass (always 30 s of audio) serves many words. Any
    filler found is force-aligned and carved out of the word that swallowed it."""
    from .align import RATE, align_words, load_mono, merge_apostrophes

    audio = load_mono(path, RATE)
    windows = _windows(words, len(audio) / RATE)
    found: dict[int, list[dict[str, Any]]] = {}
    batch: list[tuple[int, float, float, float]] = []  # (word index, a, b, offset in batch)
    batches: list[list[tuple[int, float, float, float]]] = []
    cursor = 0.0
    for k, a, b in windows:
        if batch and cursor + (b - a) > BATCH_S:
            batches.append(batch)
            batch, cursor = [], 0.0
        batch.append((k, a, b, cursor))
        cursor += (b - a) + GAP_S
    if batch:
        batches.append(batch)

    for group in batches:
        parts = []
        for _, a, b, _off in group:
            parts += [audio[int(a * RATE) : int(b * RATE)], np.zeros(int(GAP_S * RATE), dtype=np.float32)]
        chunk = np.concatenate(parts)
        segments, _ = model.transcribe(
            chunk, language="fr", word_timestamps=True, vad_filter=False, initial_prompt=prompt, beam_size=5
        )
        heard = merge_apostrophes(
            [
                {"text": x.word.strip(), "start": x.start, "end": x.end, "prob": round(x.probability, 3)}
                for seg in segments
                for x in seg.words or []
                if x.word.strip()
            ]
        )
        for k, a, b, off in group:
            local = [
                dict(x, start=x["start"] - off, end=x["end"] - off)
                for x in heard
                if off - 0.1 <= x["start"] < off + (b - a)
            ]
            if not any(_norm(x["text"]) in FILLERS for x in local):
                continue
            window = audio[int(a * RATE) : int(b * RATE)]
            aligned = align_words(None, local, audio=window)
            fillers = [
                dict(x, start=round(x["start"] + a, 3), end=round(x["end"] + a, 3), rescanned=True)
                for x in aligned
                if _norm(x["text"]) in FILLERS and x.get("timing") == "forced"
            ]
            if fillers:
                found[k] = fillers

    out: list[dict[str, Any]] = []
    for k, w in enumerate(words):
        out.extend(_carve(w, found[k]) if k in found else [w])
    return out


def _carve(word: dict[str, Any], fillers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Splits `word` around the fillers that overlap it."""
    pieces: list[dict[str, Any]] = []
    remaining: dict[str, Any] | None = dict(word, rescanned=True)
    for f in sorted(fillers, key=lambda x: x["start"]):
        if remaining is None or f["end"] <= remaining["start"] or f["start"] >= remaining["end"]:
            continue
        if f["start"] - remaining["start"] > remaining["end"] - f["end"]:
            pieces.append(dict(remaining, end=round(max(remaining["start"] + 0.02, f["start"] - 0.01), 3)))
            pieces.append(f)
            remaining = None
        else:
            pieces.append(f)
            remaining = dict(remaining, start=round(min(remaining["end"] - 0.02, f["end"] + 0.01), 3))
    if remaining is not None:
        pieces.append(remaining)
    return sorted(pieces, key=lambda x: x["start"])
