"""Transcription (optionnelle, via faster-whisper) et détection des mots parasites."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

FILLERS = {
    "fr": {"euh", "heu", "hum", "hmm", "bah", "ben", "beh", "euuh", "heuu", "mmh"},
    "en": {"uh", "um", "uhm", "umm", "erm", "er", "hmm", "mm"},
}
ALL_FILLERS = set().union(*FILLERS.values())


@dataclass(frozen=True)
class Word:
    start: float
    end: float
    text: str

    @property
    def is_filler(self) -> bool:
        return normalize(self.text) in ALL_FILLERS

    def to_dict(self) -> dict:
        return {"start": round(self.start, 3), "end": round(self.end, 3), "text": self.text}


def normalize(text: str) -> str:
    return re.sub(r"[^\w']", "", text.lower()).strip()


def transcribe(path: str | Path, model_size: str = "small", language: str | None = None) -> tuple[list[Word], str | None]:
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError as exc:  # pragma: no cover - dépend de l'environnement
        raise RuntimeError("Transcription indisponible : pip install 'cutkiller[transcribe]'") from exc
    model = WhisperModel(model_size, device="auto", compute_type="auto")
    segments, info = model.transcribe(str(path), language=language, word_timestamps=True, vad_filter=True)
    words: list[Word] = []
    for seg in segments:
        for w in seg.words or []:
            words.append(Word(float(w.start), float(w.end), w.word.strip()))
    return words, getattr(info, "language", language)


def filler_intervals(words: list[Word]) -> list[tuple[float, float]]:
    return [(w.start, w.end) for w in words if w.is_filler]


def _ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def to_srt(words: list[Word], max_chars: int = 42, max_gap: float = 0.6) -> str:
    """Regroupe les mots en sous-titres courts (format vertical / shorts)."""
    cues: list[list[Word]] = []
    for w in words:
        if w.is_filler:
            continue
        cur = cues[-1] if cues else None
        if cur and len(" ".join(x.text for x in cur + [w])) <= max_chars and w.start - cur[-1].end <= max_gap:
            cur.append(w)
        else:
            cues.append([w])
    lines = []
    for i, cue in enumerate(cues, 1):
        lines += [str(i), f"{_ts(cue[0].start)} --> {_ts(cue[-1].end)}", " ".join(x.text for x in cue), ""]
    return "\n".join(lines)
