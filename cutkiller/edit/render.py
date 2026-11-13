"""Rendu des jump cuts via un filter_complex ffmpeg."""

from __future__ import annotations

import tempfile
from pathlib import Path

from cutkiller.listen.silence import Interval
from cutkiller.media import probe, run_ffmpeg

FADE_S = 0.012  # micro-fondu audio pour éviter les clics aux coupes


def build_cut_filter(segments: list[Interval], has_video: bool, fade: float = FADE_S) -> str:
    parts: list[str] = []
    labels: list[str] = []
    for i, s in enumerate(segments):
        a, b = f"{s.start:.4f}", f"{s.end:.4f}"
        f = min(fade, s.duration / 4)
        fade_out = max(0.0, s.duration - f)
        if has_video:
            parts.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}]")
            labels.append(f"[v{i}]")
        parts.append(
            f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={f:.4f},afade=t=out:st={fade_out:.4f}:d={f:.4f}[a{i}]"
        )
        labels.append(f"[a{i}]")
    v = 1 if has_video else 0
    outs = "[outv][outa]" if has_video else "[outa]"
    parts.append(f"{''.join(labels)}concat=n={len(segments)}:v={v}:a=1{outs}")
    return ";\n".join(parts)


def render_cuts(src: str | Path, dst: str | Path, segments: list[Interval], *, crf: int = 20, preset: str = "veryfast",
                joins=None, log=None) -> Path:
    """Rend les segments gardés. Vidéo : via la timeline (transitions possibles) ; audio seul : concat simple."""
    if not segments:
        raise ValueError("Aucun segment à garder : vérifie le seuil de silence.")
    info = probe(src)
    dst = Path(dst)
    if info.has_video:
        from cutkiller.edit.timeline import Clip, Join, render_timeline

        clips = [Clip(Path(src), s.start, s.end) for s in segments]
        render_timeline(clips, joins or [Join() for _ in clips[1:]], dst, crf=crf, preset=preset, log=log)
        return dst
    graph = build_cut_filter(segments, has_video=False)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as fh:
        fh.write(graph)
        script = fh.name
    try:
        run_ffmpeg(["-i", str(src), "-filter_complex_script", script, "-map", "[outa]", "-c:a", "aac", "-b:a", "192k",
                    str(dst)])
    finally:
        Path(script).unlink(missing_ok=True)
    return dst
