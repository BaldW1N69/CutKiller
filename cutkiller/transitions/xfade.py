"""Moteur ffmpeg `xfade` : 56 transitions natives + expressions personnalisées."""

from __future__ import annotations

from pathlib import Path

from cutkiller.media import run_ffmpeg
from cutkiller.transitions.frames import LOSSLESS, VideoFormat, color_tags, norm_chain, seek_args

XFADE = {
    "fade": "fondu enchaîné", "dissolve": "dissolution en grain", "fadeblack": "fondu au noir",
    "fadewhite": "fondu au blanc", "fadegrays": "fondu en passant par le gris", "fadefast": "fondu rapide",
    "fadeslow": "fondu lent", "distance": "fondu par distance de couleur", "hblur": "fondu flou horizontal",
    "pixelize": "pixelisation", "radial": "balayage radial (horloge)", "circlecrop": "cercle qui recadre",
    "rectcrop": "rectangle qui recadre", "circleopen": "ouverture en cercle", "circleclose": "fermeture en cercle",
    "vertopen": "ouverture verticale", "vertclose": "fermeture verticale", "horzopen": "ouverture horizontale",
    "horzclose": "fermeture horizontale", "zoomin": "zoom avant", "squeezeh": "écrasement horizontal",
    "squeezev": "écrasement vertical",
    **{f"wipe{d}": f"volet vers {fr}" for d, fr in (("left", "la gauche"), ("right", "la droite"), ("up", "le haut"), ("down", "le bas"))},
    **{f"wipe{d}": f"volet diagonal {d}" for d in ("tl", "tr", "bl", "br")},
    **{f"slide{d}": f"glissement vers {fr}" for d, fr in (("left", "la gauche"), ("right", "la droite"), ("up", "le haut"), ("down", "le bas"))},
    **{f"smooth{d}": f"volet doux vers {fr}" for d, fr in (("left", "la gauche"), ("right", "la droite"), ("up", "le haut"), ("down", "le bas"))},
    **{f"cover{d}": f"recouvrement par {fr}" for d, fr in (("left", "la droite"), ("right", "la gauche"), ("up", "le bas"), ("down", "le haut"))},
    **{f"reveal{d}": f"dévoilement vers {fr}" for d, fr in (("left", "la gauche"), ("right", "la droite"), ("up", "le haut"), ("down", "le bas"))},
    **{f"diag{d}": f"diagonale {d}" for d in ("tl", "tr", "bl", "br")},
    **{f"{s}slice": f"tranches {s}" for s in ("hl", "hr", "vu", "vd")},
    **{f"{s}wind": f"effet vent {s}" for s in ("hl", "hr", "vu", "vd")},
}

TAGS = {
    "fade": "clean fade", "dissolve": "clean dissolve", "fadeblack": "clean fade", "fadewhite": "flash fade",
    "fadegrays": "clean fade color", "fadefast": "clean fade", "fadeslow": "clean fade", "distance": "fade color",
    "hblur": "blur", "pixelize": "retro pixelate", "radial": "wipe clock", "circlecrop": "shape circle",
    "rectcrop": "shape", "circleopen": "shape circle iris", "circleclose": "shape circle iris",
    "zoomin": "zoom dynamic", "squeezeh": "distort", "squeezev": "distort",
}


def tags_for(name: str) -> list[str]:
    if name in TAGS:
        return TAGS[name].split()
    for prefix, t in (("wipe", "clean wipe"), ("slide", "slide dynamic push"), ("smooth", "clean wipe"),
                      ("cover", "slide cover"), ("reveal", "slide reveal"), ("diag", "wipe"),
                      ("vertopen", "wipe split"), ("vertclose", "wipe split"), ("horzopen", "wipe split"),
                      ("horzclose", "wipe split")):
        if name.startswith(prefix):
            return t.split()
    if name.endswith("slice"):
        return ["wipe", "stripes"]
    if name.endswith("wind"):
        return ["wipe", "noise"]
    return []


def xfade_filter(name: str, params: dict, n: int, fps: float) -> str:
    """Filtre xfade complet pour une fenêtre de `n` images (les deux entrées commencent à 0)."""
    if name == "custom":
        expr = params.get("expr")
        if not expr:
            raise ValueError("xfade:custom demande une expression : xfade:custom?expr=…")
        trans = f"transition=custom:expr='{expr}'"
    else:
        trans = f"transition={name}"
    return f"xfade={trans}:duration={n / fps:.6f}:offset=0,format=yuv420p"


def render(name: str, params: dict, a_src: Path, a_start: int, b_src: Path, b_start: int, n: int,
           fmt: VideoFormat, fit: str, out: Path) -> Path:
    """Fenêtre xfade isolée (aperçus). Dans une timeline, xfade est calculé dans le graphe principal."""
    seek_a, skip_a = seek_args(a_start, fmt.fps)
    seek_b, skip_b = seek_args(b_start, fmt.fps)
    norm = norm_chain(fmt, fit)
    graph = (
        f"[0:v]{norm},trim=start_frame={skip_a}:end_frame={skip_a + n},setpts=PTS-STARTPTS[a];"
        f"[1:v]{norm},trim=start_frame={skip_b}:end_frame={skip_b + n},setpts=PTS-STARTPTS[b];"
        f"[a][b]{xfade_filter(name, params, n, fmt.fps)}[v]"
    )
    run_ffmpeg([*seek_a, "-i", str(a_src), *seek_b, "-i", str(b_src), "-filter_complex", graph, "-map", "[v]",
                "-frames:v", str(n), *LOSSLESS, *color_tags(fmt.width, fmt.height), str(out)])
    return out
