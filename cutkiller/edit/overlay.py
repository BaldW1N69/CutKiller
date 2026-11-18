"""Compositing : incruster des animations, logos, images ou vidéos sur une vidéo de base.

Spec d'un calque :  SOURCE@DÉBUT[-FIN]?pos=…&scale=…&mode=…&opacity=…
  - SOURCE  : .mov/.webm à alpha (sortie de `cutkiller animate`), .png/.jpg, vidéo fond vert, light leak…
  - DÉBUT/FIN en secondes (FIN par défaut = fin du calque, ou de la vidéo pour une image)
  - pos     : center, top, bottom, left, right, top-left, top-right, bottom-left, bottom-right, ou x,y (0..1 = centre du calque)
  - scale   : largeur du calque en fraction de la largeur de la vidéo (défaut : 1 = pleine largeur)
  - mode    : alpha (défaut), green (fond vert), screen (fond noir : light leaks, flares, particules)
  - opacity : 0..1
"""

from __future__ import annotations

from cutkiller.transitions.frames import color_tags, rgb_yuv

import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from cutkiller.media import probe, run_ffmpeg
from cutkiller.transitions import parse_params

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}
POSITIONS = {
    "center": (0.5, 0.5), "top": (0.5, 0.0), "bottom": (0.5, 1.0), "left": (0.0, 0.5), "right": (1.0, 0.5),
    "top-left": (0.0, 0.0), "top-right": (1.0, 0.0), "bottom-left": (0.0, 1.0), "bottom-right": (1.0, 1.0),
}


@dataclass
class Layer:
    src: Path
    start: float = 0.0
    end: float | None = None
    pos: str = "center"
    scale: float = 1.0
    mode: str = "alpha"
    opacity: float = 1.0
    margin: float = 0.04
    extra: dict = field(default_factory=dict)


def parse_layer(spec: str) -> Layer:
    base, _, query = spec.partition("?")
    src, sep, timing = base.rpartition("@")
    if not sep:
        src, timing = base, "0"
    path = Path(src).expanduser()
    if not path.exists():
        raise ValueError(f"Calque introuvable : {path}")
    start_s, _, end_s = timing.partition("-")
    try:
        start = float(start_s or 0)
        end = float(end_s) if end_s else None
    except ValueError as exc:
        raise ValueError(f"Minutage invalide « {timing} » dans « {spec} » (ex. 2.5 ou 2.5-6)") from exc
    params = parse_params(query) if query else {}
    layer = Layer(path, start, end)
    if "pos" in params:
        pos = params.pop("pos")
        layer.pos = ",".join(str(v) for v in pos) if isinstance(pos, list) else str(pos)
    for key in ("scale", "opacity", "margin"):
        if key in params:
            setattr(layer, key, float(params.pop(key)))
    if "mode" in params:
        layer.mode = str(params.pop("mode"))
    if layer.mode not in ("alpha", "green", "screen"):
        raise ValueError(f"mode inconnu « {layer.mode} » (alpha, green, screen)")
    if layer.end is not None and layer.end <= layer.start:
        raise ValueError(f"La fin doit être après le début dans « {spec} »")
    layer.extra = params
    return layer


def _xy_expr(layer: Layer) -> tuple[str, str]:
    """Expressions overlay x/y : le point d'ancrage du calque est placé sur la position demandée."""
    if layer.pos in POSITIONS:
        ax, ay = POSITIONS[layer.pos]
        m = layer.margin
    else:
        try:
            ax, ay = (float(v) for v in layer.pos.split(","))
        except ValueError as exc:
            raise ValueError(f"Position invalide « {layer.pos} »") from exc
        m = 0.0
        return f"W*{ax}-w/2", f"H*{ay}-h/2"
    x = {0.0: f"W*{m}", 0.5: "(W-w)/2", 1.0: f"W-w-W*{m}"}[ax]
    y = {0.0: f"H*{m}", 0.5: "(H-h)/2", 1.0: f"H-h-H*{m}"}[ay]
    return x, y


def build_overlay_graph(layers: list[Layer], base_w: int, base_h: int, duration: float) -> tuple[str, list[list[str]]]:
    conv = rgb_yuv(base_w, base_h)  # calques RGBA -> YUV avec la matrice de la vidéo
    parts: list[str] = []
    inputs: list[list[str]] = []
    cur = "[0:v]"
    for i, L in enumerate(layers, 1):
        is_image = L.src.suffix.lower() in IMAGE_EXT
        end = L.end
        if is_image:
            end = end if end is not None else duration
            inputs.append(["-loop", "1", "-t", f"{max(0.04, end - L.start):.3f}", "-i", str(L.src)])
        else:
            inputs.append(["-i", str(L.src)])
            if end is None:
                end = min(duration, L.start + probe(L.src).duration)
        end = min(end, duration)
        w = max(2, int(round(base_w * L.scale / 2)) * 2)
        chain = f"[{i}:v]setpts=PTS-STARTPTS+{L.start:.4f}/TB,scale={w}:-2"
        if L.mode == "green":
            sim = float(L.extra.get("similarity", 0.18))
            chain += f",chromakey=0x00FF00:{sim}:0.08,despill=type=green"
        if L.mode == "screen":
            # on pose le calque sur un fond noir plein cadre puis fusion « écran » : le noir ne change rien
            parts.append(f"{chain},format=rgba[l{i}]")
            parts.append(f"color=black:s={base_w}x{base_h}:d={duration:.3f}[bk{i}]")
            x, y = _xy_expr(L)
            parts.append(f"[bk{i}][l{i}]overlay=x={x}:y={y}:eof_action=pass:enable='between(t,{L.start:.4f},{end:.4f})',"
                         f"format=gbrp,colorchannelmixer=rr={L.opacity}:gg={L.opacity}:bb={L.opacity}[s{i}]")
            parts.append(f"{cur}{conv},format=gbrp[b{i}]")
            parts.append(f"[b{i}][s{i}]blend=all_mode=screen:shortest=1,{conv},format=yuv420p[v{i}]")
        else:
            chain += ",format=rgba"
            if L.opacity < 1:
                chain += f",colorchannelmixer=aa={L.opacity}"
            parts.append(f"{chain},{conv},format=yuva420p[l{i}]")
            x, y = _xy_expr(L)
            parts.append(f"{cur}[l{i}]overlay=x={x}:y={y}:eof_action=pass:format=auto:"
                         f"enable='between(t,{L.start:.4f},{end:.4f})'[v{i}]")
        cur = f"[v{i}]"
    parts.append(f"{cur}format=yuv420p[outv]")
    return ";\n".join(parts), inputs


def render_overlays(src: str | Path, dst: str | Path, layers: list[Layer], *, crf: int = 18) -> Path:
    if not layers:
        raise ValueError("Aucun calque à incruster.")
    info = probe(src)
    if not info.has_video:
        raise ValueError(f"{src} n'a pas de piste vidéo.")
    graph, extra = build_overlay_graph(layers, info.width, info.height, info.duration)
    dst = Path(dst)
    with tempfile.TemporaryDirectory(prefix="cutkiller_overlay_") as tmp:
        script = Path(tmp) / "graph.txt"
        script.write_text(graph, encoding="utf-8")
        args = ["-i", str(src)]
        for inp in extra:
            args += inp
        args += ["-filter_complex_script", str(script), "-map", "[outv]", "-c:v", "libx264", "-crf", str(crf),
                 "-preset", "veryfast", "-r", str(info.fps or 30),
                 *color_tags(info.width or 0, info.height or 0)]
        if info.has_audio:
            args += ["-map", "0:a:0", "-c:a", "copy"]
        args += ["-t", f"{info.duration:.3f}"]
        if dst.suffix.lower() in {".mp4", ".mov", ".m4a"}:
            args += ["-movflags", "+faststart"]
        run_ffmpeg(args + [str(dst)])
    return dst
