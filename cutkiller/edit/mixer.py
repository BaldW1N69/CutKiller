"""Mixage : musique de fond avec ducking sous la voix, SFX placés, normalisation loudness."""

from __future__ import annotations

import json
import re
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
    times: list[float]  # début du son dans la vidéo ; négatif = le son commence avant 0 (début coupé)
    gain_db: float = -8.0
    loop_for: float | None = None  # nappe : bouclée/coupée à cette durée
    fade: float = 0.0  # fondu d'entrée et de sortie (s)


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


TRUE_PEAK = -1.0  # plafond visé après encodage AAC (dBTP), recommandation des plateformes
LRA = 11


def build_mix_filter(plan: MixPlan, duration: float, has_voice: bool, *, measured: dict | None = None,
                     tp: float = -1.5) -> tuple[str, list[list[str]]]:
    """Retourne (filter_complex, arguments d'entrée supplémentaires par input).

    `measured` : mesures loudnorm d'une première passe (render_mix) → normalisation linéaire exacte."""
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
        times = [t for t in cue.times if -30.0 < t < duration]
        if not times:
            continue
        inputs.append((["-stream_loop", "-1"] if cue.loop_for else []) + ["-i", str(cue.path)])
        src = f"[{idx}:a]{FMT},volume={cue.gain_db}dB"
        if cue.loop_for:
            length = min(cue.loop_for, duration)
            src += f",atrim=0:{length:.3f},asetpts=PTS-STARTPTS"
            if cue.fade:
                f = min(cue.fade, length / 2)
                src += f",afade=t=in:st=0:d={f:.3f},afade=t=out:st={length - f:.3f}:d={f:.3f}"
        if len(times) == 1:
            parts.append(f"{src}[sfx{k}_0]")
        else:
            outs = "".join(f"[sfx{k}_{j}]" for j in range(len(times)))
            parts.append(f"{src},asplit={len(times)}{outs}")
        for j, t in enumerate(times):
            if t < 0:  # le son démarre avant la vidéo : on coupe son début pour garder l'impact au bon endroit
                parts.append(f"[sfx{k}_{j}]atrim=start={-t:.3f},asetpts=PTS-STARTPTS[sfx{k}_{j}d]")
            else:
                parts.append(f"[sfx{k}_{j}]adelay={int(round(t * 1000))}:all=1[sfx{k}_{j}d]")
            mix_labels.append(f"[sfx{k}_{j}d]")
        idx += 1

    if not mix_labels:
        raise ValueError("Rien à mixer : ni voix, ni musique, ni SFX.")
    # la première entrée (voix ou musique) fixe la durée ; on la ramène à la durée vidéo
    parts.append(
        f"{''.join(mix_labels)}amix=inputs={len(mix_labels)}:normalize=0:duration=first:dropout_transition=0,"
        f"atrim=0:{duration:.3f}[mixed]"
    )
    if plan.target_lufs is None:
        parts.append(f"[mixed]alimiter=limit=0.89,{FMT}[aout]")
    elif measured is None:  # passe d'analyse (ou rendu en une passe)
        parts.append(f"[mixed]loudnorm=I={plan.target_lufs}:TP={tp:.2f}:LRA={LRA}:print_format=json,{FMT}[aout]")
    else:  # passe 2 : gain linéaire calculé sur la mesure, la dynamique du mix est conservée
        m = measured
        parts.append(
            f"[mixed]loudnorm=I={plan.target_lufs}:TP={tp:.2f}:LRA={LRA}:linear=true:"
            f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
            f"measured_thresh={m['input_thresh']}:offset={m['target_offset']},{FMT}[aout]"
        )
    return ";\n".join(parts), inputs


def _loudnorm_json(stderr: str) -> dict:
    blob = stderr[stderr.rfind("{"): stderr.rfind("}") + 1]
    try:
        data = json.loads(blob)
        return {k: data[k] for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
    except (ValueError, KeyError) as exc:
        raise RuntimeError(f"Mesure de loudness illisible : {stderr[-500:]}") from exc


def true_peak(path: str | Path) -> float | None:
    """True peak (dBTP) du fichier final, après encodage."""
    res = run_ffmpeg(["-i", str(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], quiet=False)
    m = re.search(r"Peak:\s+(-?[\d.]+|-inf)\s+dBFS", res.stderr[res.stderr.rfind("Summary:"):])
    return None if not m or m.group(1) == "-inf" else float(m.group(1))


def render_mix(src: str | Path, dst: str | Path, plan: MixPlan) -> Path:
    """Mixe et normalise. Avec une cible LUFS : 1) mesure du mix, 2) gain linéaire exact (la dynamique n'est
    pas compressée comme en loudnorm une passe), 3) contrôle du true peak APRÈS l'AAC, qui peut dépasser
    de quelques dixièmes de dB : si besoin, rendu refait avec un plafond abaissé d'autant."""
    info = probe(src)
    dst = Path(dst)
    with tempfile.TemporaryDirectory(prefix="cutkiller_mix_") as tmp:
        script = Path(tmp) / "graph.txt"

        def base_args(graph: str) -> list[str]:
            script.write_text(graph, encoding="utf-8")
            args = ["-i", str(src)]
            for inp in extra_inputs:
                args += inp
            return args + ["-filter_complex_script", str(script)]

        measured, tp = None, -1.5
        graph, extra_inputs = build_mix_filter(plan, info.duration, info.has_audio)
        if plan.target_lufs is not None:
            res = run_ffmpeg(base_args(graph) + ["-map", "[aout]", "-t", f"{info.duration:.3f}", "-f", "null", "-"],
                             quiet=False)
            measured = _loudnorm_json(res.stderr)
        for _ in range(2):
            if measured is not None:
                graph, extra_inputs = build_mix_filter(plan, info.duration, info.has_audio, measured=measured, tp=tp)
            args = base_args(graph)
            if info.has_video:
                args += ["-map", "0:v:0", "-c:v", "copy"]
            args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", f"{info.duration:.3f}"]
            if dst.suffix.lower() in {".mp4", ".mov", ".m4a"}:
                args += ["-movflags", "+faststart"]
            run_ffmpeg(args + [str(dst)])
            if measured is None:
                break
            peak = true_peak(dst)
            if peak is None or peak <= TRUE_PEAK:
                break
            tp -= peak - TRUE_PEAK + 0.1
    return dst
