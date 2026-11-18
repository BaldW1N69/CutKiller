"""Préréglages de diffusion : un flag règle format, durée, loudness et encodage pour une plateforme.

Les limites de durée sont indicatives (elles évoluent chez les plateformes) : CutKiller prévient, il ne coupe
pas. Les plateformes réencodent toujours : on leur envoie une source de bonne qualité (CRF 18), en 4:2:0
H.264 High, keyframe toutes les 2 s (GOP fermé), son AAC 48 kHz à -14 LUFS et -1 dBTP.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Platform:
    name: str
    width: int
    height: int
    max_duration: float | None  # indicatif : avertissement au-delà
    lufs: float = -14.0
    crf: int = 18
    gop_seconds: float = 2.0
    max_fps: float = 60.0
    label: str = ""


PLATFORMS: dict[str, Platform] = {
    "tiktok": Platform("tiktok", 1080, 1920, 600.0, label="TikTok (9:16)"),
    "shorts": Platform("shorts", 1080, 1920, 180.0, label="YouTube Shorts (9:16)"),
    "reels": Platform("reels", 1080, 1920, 180.0, label="Instagram Reels (9:16)"),
    "youtube": Platform("youtube", 1920, 1080, None, label="YouTube (16:9)"),
}


def get(name: str) -> Platform:
    try:
        return PLATFORMS[name]
    except KeyError:
        raise ValueError(f"Plateforme inconnue « {name} » : {', '.join(PLATFORMS)}") from None


def duration_warning(p: Platform, duration: float) -> str | None:
    if p.max_duration and duration > p.max_duration:
        return (f"{duration:.0f} s dépasse la durée indicative de {p.label} ({p.max_duration:.0f} s) : "
                f"vérifie la limite actuelle de la plateforme")
    return None


def encode_args(p: Platform, fps: float) -> dict:
    """Paramètres d'encodage pour render_timeline."""
    return {"crf": p.crf, "gop": max(1, int(round(p.gop_seconds * fps)))}
