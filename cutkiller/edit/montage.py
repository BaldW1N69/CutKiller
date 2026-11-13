"""Montage multi-clips calé sur le rythme de la musique (vidéos et photos)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cutkiller.edit.timeline import Clip
from cutkiller.media import probe, run_ffmpeg
from cutkiller.transitions.frames import VideoFormat

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic"}


@dataclass
class MontageSettings:
    beats_per_clip: int = 4
    clip_duration: float = 2.0  # sans musique (ou rythme incertain)
    max_duration: float | None = None
    photo_duration: float = 3.0
    ken_burns: float = 0.12  # zoom lent appliqué aux photos


def beat_grid(beats: list[float], confidence: float, music_start: float = 0.0) -> list[float] | None:
    """Temps des beats relatifs au premier beat après `music_start` (None si rythme inexploitable)."""
    usable = [b for b in beats if b >= music_start]
    if confidence < 0.15 or len(usable) < 4:
        return None
    return [b - usable[0] for b in usable]


def photo_to_clip(img: Path, seconds: float, fmt: VideoFormat, zoom: float, out: Path) -> Path:
    """Photo → vidéo avec effet Ken Burns (zoom lent), plus 1 s de poignée de chaque côté."""
    total = seconds + 2.0
    frames = max(2, int(round(total * fmt.fps)))
    w, h = fmt.width, fmt.height
    run_ffmpeg([
        "-loop", "1", "-i", str(img), "-t", f"{total:.3f}",
        "-vf", (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,crop={w * 2}:{h * 2},"
                f"zoompan=z='1+{zoom}*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={w}x{h}:fps={fmt.fps},"
                "format=yuv420p"),
        "-frames:v", str(frames), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", str(out),
    ])
    return out


def build_montage(inputs: list[Path], fmt: VideoFormat, settings: MontageSettings, work: Path,
                  beats: list[float] | None = None) -> list[Clip]:
    """Un extrait centré par source. Avec une grille de beats, chaque coupe vise un temps ;
    un clip trop court décale une coupe, la suivante se recale sur la grille."""
    clips: list[Clip] = []
    F = fmt.fps
    t, bi = 0.0, 0
    for src in inputs:
        if settings.max_duration and t >= settings.max_duration - 0.05:
            break
        is_photo = src.suffix.lower() in IMAGE_EXT
        if beats:
            if bi + 1 >= len(beats):
                break  # fin de la musique
            target = min(bi + settings.beats_per_clip, len(beats) - 1)
            want = beats[target] - t
        else:
            target = None
            want = settings.photo_duration if is_photo else settings.clip_duration
        if is_photo:
            path = photo_to_clip(src, want, fmt, settings.ken_burns, work / f"photo_{len(clips):04d}.mp4")
            avail = want + 2.0
        else:
            path = src
            avail = probe(src).duration
        dur = want
        if avail < want:
            dur = avail
            if beats:  # garder la coupe sur un temps si possible
                fit = [k for k in range(bi + 1, target + 1) if beats[k] - t <= avail]
                if fit:
                    target, dur = fit[-1], beats[fit[-1]] - t
        if settings.max_duration:
            dur = min(dur, settings.max_duration - t)
        if dur <= 0.1:
            continue
        if beats and target is not None and abs(t + dur - beats[target]) < 1e-6:
            bi = target
        n_frames = int(round((t + dur) * F)) - int(round(t * F))  # quantification cumulative : pas de dérive
        start = round(max(0.0, (avail - dur) / 2) * F) / F  # centré : poignées pour les transitions
        clips.append(Clip(path, start, start + n_frames / F))
        t += dur
    return clips
