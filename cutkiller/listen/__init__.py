"""Écoute : analyse audio complète d'un média pour guider le montage."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from cutkiller.listen.beats import BeatInfo, analyze_beats
from cutkiller.listen.loudness import LoudnessInfo, measure
from cutkiller.listen.silence import Interval, complement, detect_silences, frame_db
from cutkiller.listen.transcribe import Word, filler_intervals, transcribe
from cutkiller.media import ANALYSIS_SR, MediaInfo, load_audio, probe


@dataclass
class ListenReport:
    media: MediaInfo
    threshold_db: float
    silences: list[Interval]
    speech: list[Interval]
    loudness: LoudnessInfo | None = None
    beats: BeatInfo | None = None
    words: list[Word] = field(default_factory=list)
    language: str | None = None

    @property
    def silence_ratio(self) -> float:
        total = self.media.duration or 1.0
        return sum(s.duration for s in self.silences) / total

    @property
    def fillers(self) -> list[tuple[float, float]]:
        return filler_intervals(self.words)

    def to_dict(self) -> dict:
        d = {
            "file": str(self.media.path),
            "duration": round(self.media.duration, 3),
            "silence_threshold_db": round(self.threshold_db, 1),
            "silence_ratio": round(self.silence_ratio, 3),
            "silences": [s.to_dict() for s in self.silences],
            "speech": [s.to_dict() for s in self.speech],
        }
        if self.loudness:
            d["loudness"] = self.loudness.to_dict()
        if self.beats:
            d["beats"] = self.beats.to_dict()
        if self.words:
            d["language"] = self.language
            d["words"] = [w.to_dict() for w in self.words]
            d["fillers"] = [{"start": round(a, 3), "end": round(b, 3)} for a, b in self.fillers]
        return d

    def summary(self) -> str:
        m = self.media
        lines = [
            f"Fichier      : {m.path.name} ({m.duration:.1f} s{', vidéo ' + str(m.width) + 'x' + str(m.height) if m.has_video else ''})",
            f"Silences     : {len(self.silences)} plages, {self.silence_ratio * 100:.0f} % du temps (seuil {self.threshold_db:.1f} dBFS)",
            f"Gain estimé  : -{sum(s.duration for s in self.silences):.1f} s si on coupe les silences",
        ]
        if self.loudness:
            lu = self.loudness
            lufs = "n/a" if lu.integrated_lufs is None else f"{lu.integrated_lufs:.1f} LUFS"
            lines.append(f"Loudness     : {lufs}, peak {lu.sample_peak_dbfs:.1f} dBFS, bruit de fond {lu.noise_floor_dbfs:.0f} dBFS")
        if self.beats and self.beats.bpm:
            if self.beats.confidence >= 0.2:
                lines.append(f"Tempo        : {self.beats.bpm:.1f} BPM (confiance {self.beats.confidence:.2f}), {len(self.beats.beats)} beats")
            else:
                lines.append(f"Tempo        : pas de pulsation nette (parole ?), {len(self.beats.onsets)} attaques détectées")
        if self.words:
            lines.append(f"Transcription: {len(self.words)} mots ({self.language}), {len(self.fillers)} hésitations (euh, um...)")
        if self.loudness and self.loudness.warnings:
            lines.append("À corriger   :")
            lines += [f"  - {w}" for w in self.loudness.warnings]
        return "\n".join(lines)


def listen(
    path: str | Path,
    *,
    threshold_db: float | None = None,
    min_silence: float = 0.35,
    with_loudness: bool = True,
    with_beats: bool = False,
    with_transcript: bool = False,
    whisper_model: str = "small",
    language: str | None = None,
    target_lufs: float = -14.0,
) -> ListenReport:
    info = probe(path)
    if not info.has_audio:
        raise ValueError(f"{path} n'a pas de piste audio.")
    audio = load_audio(path, ANALYSIS_SR)
    total = audio.size / ANALYSIS_SR
    silences, thr = detect_silences(audio, ANALYSIS_SR, threshold_db=threshold_db, min_silence=min_silence)
    report = ListenReport(media=info, threshold_db=thr, silences=silences, speech=complement(silences, total))
    if with_loudness:
        report.loudness = measure(path, audio, frame_db(audio, ANALYSIS_SR), target_lufs=target_lufs)
    if with_beats:
        report.beats = analyze_beats(audio, ANALYSIS_SR)
    if with_transcript:
        report.words, report.language = transcribe(path, whisper_model, language)
    return report


__all__ = ["ListenReport", "listen", "Interval"]
