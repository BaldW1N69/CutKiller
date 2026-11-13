"""Mesure de loudness (EBU R128 via ffmpeg) et diagnostic de qualité audio."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from cutkiller.media import run_ffmpeg

PLATFORM_TARGETS = {"youtube": -14.0, "tiktok": -14.0, "instagram": -14.0, "podcast": -16.0, "broadcast": -23.0}


@dataclass
class LoudnessInfo:
    integrated_lufs: float | None
    loudness_range: float | None
    true_peak_dbtp: float | None
    sample_peak_dbfs: float
    clipping_ratio: float
    noise_floor_dbfs: float
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        r = lambda v: None if v is None else round(v, 2)  # noqa: E731
        return {
            "integrated_lufs": r(self.integrated_lufs),
            "loudness_range_lu": r(self.loudness_range),
            "true_peak_dbtp": r(self.true_peak_dbtp),
            "sample_peak_dbfs": r(self.sample_peak_dbfs),
            "clipping_ratio": round(self.clipping_ratio, 5),
            "noise_floor_dbfs": r(self.noise_floor_dbfs),
            "warnings": self.warnings,
        }


_SUMMARY = {
    "integrated_lufs": re.compile(r"I:\s+(-?[\d.]+|-inf)\s+LUFS"),
    "loudness_range": re.compile(r"LRA:\s+(-?[\d.]+)\s+LU"),
    "true_peak_dbtp": re.compile(r"Peak:\s+(-?[\d.]+|-inf)\s+dBFS"),
}


def parse_ebur128(stderr: str) -> dict[str, float | None]:
    summary = stderr[stderr.rfind("Summary:") :] if "Summary:" in stderr else stderr
    out: dict[str, float | None] = {}
    for key, rx in _SUMMARY.items():
        m = rx.search(summary)
        out[key] = None if not m or m.group(1) == "-inf" else float(m.group(1))
    return out


def measure(path: str | Path, audio: np.ndarray, frame_db: np.ndarray, target_lufs: float = -14.0) -> LoudnessInfo:
    res = run_ffmpeg(["-v", "info", "-i", str(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], quiet=False)
    ebu = parse_ebur128(res.stderr)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    clip = float(np.mean(np.abs(audio) >= 0.999)) if audio.size else 0.0
    noise = float(np.percentile(frame_db, 10)) if frame_db.size else -120.0
    info = LoudnessInfo(
        integrated_lufs=ebu["integrated_lufs"],
        loudness_range=ebu["loudness_range"],
        true_peak_dbtp=ebu["true_peak_dbtp"],
        sample_peak_dbfs=20 * np.log10(peak + 1e-12),
        clipping_ratio=clip,
        noise_floor_dbfs=noise,
    )
    info.warnings = diagnose(info, target_lufs)
    return info


def diagnose(info: LoudnessInfo, target_lufs: float = -14.0) -> list[str]:
    w: list[str] = []
    if info.integrated_lufs is not None:
        delta = info.integrated_lufs - target_lufs
        if delta < -3:
            w.append(f"Audio trop faible ({info.integrated_lufs:.1f} LUFS, cible {target_lufs:.0f}) : normalisation recommandée (+{-delta:.1f} dB).")
        elif delta > 2:
            w.append(f"Audio trop fort ({info.integrated_lufs:.1f} LUFS, cible {target_lufs:.0f}) : les plateformes vont le baisser.")
    if info.clipping_ratio > 1e-4:
        w.append(f"Saturation détectée sur {info.clipping_ratio * 100:.2f} % des échantillons : la prise est écrêtée, réduire le gain à l'enregistrement.")
    if info.true_peak_dbtp is not None and info.true_peak_dbtp > -1.0:
        w.append(f"True peak à {info.true_peak_dbtp:.1f} dBTP (> -1) : risque de distorsion après encodage.")
    if info.noise_floor_dbfs > -50:
        w.append(f"Bruit de fond élevé ({info.noise_floor_dbfs:.0f} dBFS) : envisager un débruitage (ex. ffmpeg afftdn).")
    return w
