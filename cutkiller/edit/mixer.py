"""Mixage : musique de fond avec ducking sous la voix, SFX placés, normalisation loudness."""

from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from cutkiller.media import probe, run_ffmpeg

FMT = "aformat=sample_rates=48000:channel_layouts=stereo"


@dataclass
class MusicBed:
    path: Path
    gain_db: float = -16.0  # niveau de la musique avant ducking
    start_offset: float = 0.0  # sauter l'intro du morceau
    fade_in: float = 1.0
    fade_out: float = 2.5
    duck: bool = True
    duck_ratio: float = 8.0  # compression quand la voix parle
    duck_threshold: float = 0.02
    duck_release_ms: int = 400


@dataclass
class SfxCue:
    path: Path
    times: list[float]
    gain_db: float = -8.0


@dataclass
class MixPlan:
    music: MusicBed | None = None
    sfx: list[SfxCue] = field(default_factory=list)
    target_lufs: float | None = -14.0
    voice_gain_db: float = 0.0


def spaced(times: list[float], min_spacing: float) -> list[float]:
    """Évite le spam de SFX : garde des instants espacés d'au moins `min_spacing` s."""
    out: list[float] = []
    for t in sorted(times):
        if not out or t - out[-1] >= min_spacing:
            out.append(t)
    return out


def build_mix_filter(plan: MixPlan, duration: float, has_voice: bool) -> tuple[str, list[list[str]]]:
    """Retourne (filter_complex, arguments d'entrée supplémentaires par input)."""
    inputs: list[list[str]] = []
    parts: list[str] = []
    mix_labels: list[str] = []
    idx = 1  # 0 = vidéo/voix d'origine

    if has_voice:
        split = 2 if plan.music and plan.music.duck else 1
        chain = f"[0:a]{FMT},volume={plan.voice_gain_db}dB"
        parts.append(chain + (",asplit=2[voice][sc]" if split == 2 else "[voice]"))
        mix_labels.append("[voice]")

    if plan.music:
        m = plan.music
        args = ["-stream_loop", "-1"]
        if m.start_offset > 0:
            args += ["-ss", f"{m.start_offset:.3f}"]
        inputs.append(args + ["-i", str(m.path)])
        fade_out_start = max(0.0, duration - m.fade_out)
        parts.append(
            f"[{idx}:a]{FMT},atrim=0:{duration:.3f},asetpts=PTS-STARTPTS,volume={m.gain_db}dB,"
            f"afade=t=in:st=0:d={m.fade_in},afade=t=out:st={fade_out_start:.3f}:d={m.fade_out}[mus]"
        )
        if has_voice and m.duck:
            parts.append(
                f"[mus][sc]sidechaincompress=threshold={m.duck_threshold}:ratio={m.duck_ratio}:"
                f"attack=20:release={m.duck_release_ms}[ducked]"
            )
            mix_labels.append("[ducked]")
        else:
            mix_labels.append("[mus]")
        idx += 1

    for k, cue in enumerate(plan.sfx):
        times = [t for t in cue.times if 0 <= t < duration]
        if not times:
            continue
        inputs.append(["-i", str(cue.path)])
        src = f"[{idx}:a]{FMT},volume={cue.gain_db}dB"
        if len(times) == 1:
            parts.append(f"{src}[sfx{k}_0]")
        else:
            outs = "".join(f"[sfx{k}_{j}]" for j in range(len(times)))
            parts.append(f"{src},asplit={len(times)}{outs}")
        for j, t in enumerate(times):
            ms = int(round(t * 1000))
            parts.append(f"[sfx{k}_{j}]adelay={ms}:all=1[sfx{k}_{j}d]")
            mix_labels.append(f"[sfx{k}_{j}d]")
        idx += 1

    if not mix_labels:
        raise ValueError("Rien à mixer : ni voix, ni musique, ni SFX.")
    # la première entrée (voix ou musique) fixe la durée ; on la ramène à la durée vidéo
    parts.append(
        f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:normalize=0:duration=first:dropout_transition=0,"
        f"atrim=0:{duration:.3f}[mixed]"
    )
    if plan.target_lufs is not None:
        parts.append(f"[mixed]loudnorm=I={plan.target_lufs}:TP=-1.5:LRA=11,{FMT}[aout]")
    else:
        parts.append(f"[mixed]alimiter=limit=0.89,{FMT}[aout]")
    return ";\n".join(parts), inputs


def render_mix(src: str | Path, dst: str | Path, plan: MixPlan) -> Path:
    info = probe(src)
    graph, extra_inputs = build_mix_filter(plan, info.duration, info.has_audio)
    dst = Path(dst)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as fh:
        fh.write(graph)
        script = fh.name
    try:
        args = ["-i", str(src)]
        for inp in extra_inputs:
            args += inp
        args += ["-filter_complex_script", script]
        if info.has_video:
            args += ["-map", "0:v:0", "-c:v", "copy"]
        args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", f"{info.duration:.3f}"]
        if dst.suffix.lower() in {".mp4", ".mov", ".m4a"}:
            args += ["-movflags", "+faststart"]
        run_ffmpeg(args + [str(dst)])
    finally:
        Path(script).unlink(missing_ok=True)
    return dst
