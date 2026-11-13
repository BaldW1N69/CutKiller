"""Assemblage d'une timeline : clips + transitions vidéo + raccords audio.

Principe (comme un logiciel de montage) : une transition est centrée sur le point de coupe et
utilise les "poignées" (images avant le début / après la fin des clips). La durée totale ne bouge
pas et la parole n'est pas mangée. Sans poignée disponible, on bascule en chevauchement classique
(la vidéo raccourcit de la partie manquante).

Tout est calculé en frames de la cadence de sortie : pas de dérive, même avec des centaines de coupes.
"""

from __future__ import annotations

import math
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from cutkiller.media import MediaInfo, probe, run_ffmpeg
from cutkiller.transitions import Transition, fixed_duration
from cutkiller.transitions import render as render_transition
from cutkiller.transitions.frames import VideoFormat, norm_chain

AUDIO_FMT = "aformat=sample_rates=48000:channel_layouts=stereo"
MICRO_FADE = 0.008


@dataclass
class Clip:
    src: Path
    start: float
    end: float


@dataclass
class Join:
    transition: Transition | None = None
    duration: float = 0.0  # secondes (ignoré pour un pack : sa propre durée)
    audio_fade: float = 0.03  # fondu croisé audio centré sur la coupe
    jl: float = 0.0  # >0 : L-cut (le son de A déborde sur B) ; <0 : J-cut (le son de B arrive avant)


@dataclass
class _PClip:
    src: Path
    info: MediaInfo
    sf: int
    ef: int
    total: int  # frames disponibles dans la source

    @property
    def len(self) -> int:
        return self.ef - self.sf


@dataclass
class _PJoin:
    transition: Transition | None
    n: int = 0  # frames de la transition
    x: int = 0  # frames de la fenêtre placées avant la coupe
    audio_fade: float = 0.0
    jl: float = 0.0


@dataclass
class TimelinePlan:
    fmt: VideoFormat
    clips: list[_PClip] = field(default_factory=list)
    joins: list[_PJoin] = field(default_factory=list)

    @property
    def frames(self) -> int:
        return sum(c.len for c in self.clips)

    @property
    def duration(self) -> float:
        return self.frames / self.fmt.fps

    def cut_times(self) -> list[float]:
        """Instants des coupes dans la vidéo finale (pour placer les SFX)."""
        t, out = 0, []
        for c in self.clips[:-1]:
            t += c.len
            out.append(round(t / self.fmt.fps, 3))
        return out


def plan_timeline(clips: list[Clip], joins: list[Join], fmt: VideoFormat | None = None,
                  allow_overlap: bool = True) -> TimelinePlan:
    if len(joins) != max(0, len(clips) - 1):
        raise ValueError("Il faut exactement un raccord (Join) entre deux clips.")
    infos = {}
    for c in clips:
        if c.src not in infos:
            infos[c.src] = probe(c.src)
    if fmt is None:
        first = infos[clips[0].src]
        fmt = VideoFormat.from_media(first) if first.has_video else VideoFormat(1280, 720, 30.0)
    F = fmt.fps
    pc: list[_PClip] = []
    pj: list[Join] = []
    for i, c in enumerate(clips):
        info = infos[c.src]
        total = int(math.floor(info.duration * F + 1e-6))
        sf, ef = max(0, int(round(c.start * F))), min(total, int(round(c.end * F)))
        if ef - sf < 1:
            continue
        if pc and i > 0:
            pj.append(joins[i - 1])
        pc.append(_PClip(c.src, info, sf, ef, total))
    plan = TimelinePlan(fmt, pc)
    r_prev = 0
    for i, j in enumerate(pj):
        a, b = pc[i], pc[i + 1]
        last = i == len(pj) - 1
        t = j.transition
        n = 0
        if t is not None:
            n = fixed_duration(t, fmt) or int(round(j.duration * F))
        h_a, h_b = a.total - a.ef, b.sf
        if n >= 2 and allow_overlap and h_a + h_b < n:
            deficit = n - h_a - h_b
            sa = min((deficit + 1) // 2, max(0, a.len - r_prev - 1))
            sb = min(deficit - sa, max(0, b.len // 2))
            a.ef -= sa
            b.sf += sb
            h_a, h_b = h_a + sa, h_b + sb
        left = min(h_b, a.len - r_prev)
        right = min(h_a, b.len if last else b.len // 2)
        n = min(n, max(0, left) + max(0, right))
        x = 0
        if n < 2:
            n = 0
        else:
            x = min(max(n // 2, n - right), left)
        plan.joins.append(_PJoin(t if n else None, n, x, j.audio_fade, j.jl))
        r_prev = n - x
    _plan_audio(plan)
    return plan


def _plan_audio(plan: TimelinePlan) -> None:
    F = plan.fmt.fps
    for i, j in enumerate(plan.joins):
        a, b = plan.clips[i], plan.clips[i + 1]
        a_dur = a.info.duration if a.info.has_audio else math.inf
        lim = 0.45 * min(a.len, b.len) / F
        d = max(-lim, min(lim, j.jl))
        d = min(d, a_dur - a.ef / F)  # pas de son après la fin de la source A
        d = max(d, -b.sf / F) if b.info.has_audio else d  # ni avant le début de B
        room = min(a_dur - a.ef / F - d, (b.sf / F + d) if b.info.has_audio else math.inf, lim - abs(d))
        j.jl = d
        j.audio_fade = max(0.0, min(j.audio_fade, 2 * room))


def _audio_bounds(plan: TimelinePlan) -> list[tuple[float, float]]:
    F = plan.fmt.fps
    out = []
    for i, c in enumerate(plan.clips):
        start = c.sf / F
        end = c.ef / F
        if i > 0:
            pj = plan.joins[i - 1]
            start += pj.jl - pj.audio_fade / 2
        if i < len(plan.joins):
            j = plan.joins[i]
            end += j.jl + j.audio_fade / 2
        out.append((start, end))
    return out


def build_graph(plan: TimelinePlan, trans_files: dict[int, Path], fit: str, audio: bool) -> tuple[str, list[Path]]:
    srcs: list[Path] = []
    for c in plan.clips:
        if c.src not in srcs:
            srcs.append(c.src)
    inputs = srcs + [trans_files[k] for k in sorted(trans_files)]
    tidx = {k: len(srcs) + n for n, k in enumerate(sorted(trans_files))}
    F = plan.fmt.fps
    parts: list[str] = []

    # --- vidéo : une normalisation par source puis split vers chaque morceau
    pieces: list[tuple[int, int, int]] = []  # (src index, start_frame, end_frame) ou transition
    order: list[tuple[str, int]] = []
    for i, c in enumerate(plan.clips):
        r_prev = plan.joins[i - 1].n - plan.joins[i - 1].x if i > 0 else 0
        x = plan.joins[i].x if i < len(plan.joins) else 0
        s, e = c.sf + r_prev, c.ef - x
        if e > s:
            order.append(("m", len(pieces)))
            pieces.append((srcs.index(c.src), s, e))
        if i in trans_files:
            order.append(("t", i))
    by_src: dict[int, list[int]] = {}
    for p, (k, _, _) in enumerate(pieces):
        by_src.setdefault(k, []).append(p)
    norm = norm_chain(plan.fmt, fit)
    for k, plist in by_src.items():
        outs = "".join(f"[vs{p}]" for p in plist)
        parts.append(f"[{k}:v]{norm},split={len(plist)}{outs}" if len(plist) > 1 else f"[{k}:v]{norm}[vs{plist[0]}]")
    labels = []
    for kind, idx in order:
        if kind == "m":
            _, s, e = pieces[idx]
            parts.append(f"[vs{idx}]trim=start_frame={s}:end_frame={e},setpts=PTS-STARTPTS[vp{idx}]")
            labels.append(f"[vp{idx}]")
        else:
            parts.append(f"[{tidx[idx]}:v]setpts=PTS-STARTPTS,fps={F},setsar=1,format=yuv420p[vt{idx}]")
            labels.append(f"[vt{idx}]")
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[outv]")

    if audio:
        bounds = _audio_bounds(plan)
        a_by_src: dict[int, list[int]] = {}
        for i, c in enumerate(plan.clips):
            if c.info.has_audio:
                a_by_src.setdefault(srcs.index(c.src), []).append(i)
        for k, ilist in a_by_src.items():
            outs = "".join(f"[as{i}]" for i in ilist)
            parts.append(f"[{k}:a]{AUDIO_FMT},asetpts=PTS-STARTPTS,asplit={len(ilist)}{outs}" if len(ilist) > 1
                         else f"[{k}:a]{AUDIO_FMT},asetpts=PTS-STARTPTS[as{ilist[0]}]")
        for i, c in enumerate(plan.clips):
            s, e = bounds[i]
            fades = []
            if i > 0 and plan.joins[i - 1].audio_fade == 0:
                fades.append(f"afade=t=in:st=0:d={MICRO_FADE}")
            if i < len(plan.joins) and plan.joins[i].audio_fade == 0:
                fades.append(f"afade=t=out:st={max(0.0, e - s - MICRO_FADE):.6f}:d={MICRO_FADE}")
            tail = ("," + ",".join(fades)) if fades else ""
            if c.info.has_audio:
                parts.append(f"[as{i}]atrim=start={s:.6f}:end={e:.6f},asetpts=PTS-STARTPTS{tail}[ap{i}]")
            else:
                parts.append(f"anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={e - s:.6f}[ap{i}]")
        acc = "[ap0]"
        for i, j in enumerate(plan.joins):
            nxt, out = f"[ap{i + 1}]", f"[ax{i}]"
            if j.audio_fade > 0:
                parts.append(f"{acc}{nxt}acrossfade=d={j.audio_fade:.6f}:c1=tri:c2=tri{out}")
            else:
                parts.append(f"{acc}{nxt}concat=n=2:v=0:a=1{out}")
            acc = out
        parts.append(f"{acc}anull[outa]")
    return ";\n".join(parts), inputs


def render_timeline(clips: list[Clip], joins: list[Join], out: str | Path, *, fmt: VideoFormat | None = None,
                    fit: str = "crop", audio: bool = True, crf: int = 20, preset: str = "veryfast",
                    allow_overlap: bool = True, log=None) -> TimelinePlan:
    plan = plan_timeline(clips, joins, fmt, allow_overlap)
    if not plan.clips:
        raise ValueError("Timeline vide : aucun clip ne dure au moins une image.")
    has_audio = audio and any(c.info.has_audio for c in plan.clips)
    out = Path(out)
    with tempfile.TemporaryDirectory(prefix="cutkiller_") as tmp:
        trans_files: dict[int, Path] = {}
        todo = [(i, j) for i, j in enumerate(plan.joins) if j.transition is not None]
        for k, (i, j) in enumerate(todo, 1):
            a, b = plan.clips[i], plan.clips[i + 1]
            if log:
                log(f"    transition {k}/{len(todo)} : {j.transition.id} ({j.n / plan.fmt.fps:.2f} s)")
            trans_files[i] = render_transition(j.transition, a.src, a.ef - j.x, b.src, b.sf - j.x, j.n, plan.fmt, fit,
                                               Path(tmp) / f"t{i:05d}.mkv")
        graph, inputs = build_graph(plan, trans_files, fit, has_audio)
        script = Path(tmp) / "graph.txt"
        script.write_text(graph)
        args = []
        for p in inputs:
            args += ["-i", str(p)]
        args += ["-filter_complex_script", str(script), "-map", "[outv]", "-c:v", "libx264", "-crf", str(crf),
                 "-preset", preset, "-pix_fmt", "yuv420p", "-r", str(plan.fmt.fps)]
        if has_audio:
            args += ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"]
        if out.suffix.lower() in {".mp4", ".mov", ".m4a"}:
            args += ["-movflags", "+faststart"]
        run_ffmpeg(args + [str(out)])
    return plan


def assign_joins(cut_times: list[float], picker=None, *, duration: float = 0.4, every: int = 1,
                 min_gap: float = 0.0, audio_fade: float = 0.03, jl: float = 0.0) -> list[Join]:
    """Un raccord par coupe : transition toutes les `every` coupes, espacées d'au moins `min_gap` s."""
    joins, last = [], -1e9
    for k, t in enumerate(cut_times):
        use = picker is not None and k % max(1, every) == 0 and t - last >= min_gap
        if use:
            last = t
            joins.append(Join(picker.next(), duration, max(audio_fade, min(duration, 0.25)), jl))
        else:
            joins.append(Join(None, 0.0, audio_fade, jl))
    return joins
