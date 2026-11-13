"""Registre unifié des transitions.

Syntaxe d'une transition (option --transition) :
  fade                          nom seul (cherché dans toutes les familles, insensible à la casse)
  xfade:circleopen              famille explicite
  gl:WhipPan?direction=1,0&blur=0.6   paramètres
  fx:zoom_punch                 effet CPU (sans OpenGL)
  pack:transitions/ink.mov      vidéo de transition (fond vert, alpha ou fond noir)
  luma:masques/spirale.png?softness=0.2   masque luma personnel
  glsl:mon_shader.glsl          shader au format gl-transitions
  xfade:custom?expr=…           expression ffmpeg personnalisée
  random | random:glitch | fade|gl:Cube|fx:flash   tirage aléatoire (thème ou liste)
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qsl

from cutkiller.transitions import fx, gl, xfade
from cutkiller.transitions.frames import VideoFormat

FAMILIES = ("xfade", "gl", "fx", "pack", "luma", "glsl")


@dataclass
class Transition:
    family: str
    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    params: dict = field(default_factory=dict)
    path: Path | None = None  # pack / luma / glsl

    @property
    def id(self) -> str:
        return f"{self.family}:{self.name}"

    @property
    def needs_gl(self) -> bool:
        return self.family in ("gl", "glsl")

    def with_params(self, params: dict) -> "Transition":
        return Transition(self.family, self.name, self.description, self.tags, {**self.params, **params}, self.path)


def catalog(include_gl: bool = True) -> list[Transition]:
    items = [Transition("xfade", n, d, xfade.tags_for(n)) for n, d in xfade.XFADE.items()]
    items += [Transition("fx", n, d, t.split()) for n, (_, d, t) in fx.EFFECTS.items()]
    if include_gl:
        for name, spec in gl.catalog().items():
            items.append(Transition("gl", name, spec.get("description") or "", _gl_tags(spec.get("tags") or [])))
    return items


# thèmes transverses pour que random:dynamic / random:clean couvrent aussi les shaders GL
DYNAMIC = {"motion-blur", "zoom", "glitch", "flash", "spin", "bounce", "push", "shake", "warp", "light"}
CLEAN = {"fade", "dissolve", "blend", "wipe", "reveal", "cover"}
LOUD = {"3d", "glitch", "retro", "noise", "distort", "pattern", "tiles", "shape", "static", "chromatic"}


def _gl_tags(tags: list[str]) -> list[str]:
    out = list(tags)
    if DYNAMIC & set(tags):
        out.append("dynamic")
    if CLEAN & set(tags) and not LOUD & set(tags):
        out.append("clean")
    return out


def _value(raw: str):
    low = raw.lower()
    if low in ("true", "false"):
        return low == "true"
    parts = raw.split(",")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        return raw
    nums = [int(v) if v.is_integer() and "." not in p else v for v, p in zip(nums, parts)]
    return nums[0] if len(nums) == 1 else nums


def parse_params(query: str) -> dict:
    return {k: _value(v) for k, v in parse_qsl(query, keep_blank_values=True)}


def resolve(spec: str) -> Transition:
    """Résout une transition unique (pas de tirage aléatoire)."""
    spec = spec.strip()
    base, _, query = spec.partition("?")
    params = parse_params(query) if query else {}
    family, sep, name = base.partition(":")
    if not sep:
        family, name = "", base
    if family in ("pack", "luma", "glsl"):
        path = Path(name).expanduser()
        if not path.exists():
            raise ValueError(f"Fichier de transition introuvable : {path}")
        desc = {"pack": "vidéo de transition", "luma": "masque luma", "glsl": "shader personnalisé"}[family]
        return Transition(family, path.name, desc, [family], params, path)
    if family == "xfade" and name == "custom":
        return Transition("xfade", "custom", "expression ffmpeg", ["custom"], params)
    if family and family not in FAMILIES:
        raise ValueError(f"Famille inconnue « {family} » (attendu : {', '.join(FAMILIES)})")
    matches = [t for t in catalog() if (not family or t.family == family) and t.name.lower() == name.lower()]
    if not matches:
        hint = [t.id for t in catalog() if name.lower() in t.name.lower()][:8]
        raise ValueError(f"Transition inconnue « {spec} ». "
                         + (f"Proches : {', '.join(hint)}" if hint else "Voir : cutkiller transitions list"))
    return matches[0].with_params(params)  # ordre du catalogue : xfade (rapide) > fx > gl


class Picker:
    """Choisit une transition par coupe à partir d'une spec (fixe, liste ou tirage par thème)."""

    def __init__(self, spec: str, seed: int | None = None, gl_ok: bool | None = None):
        self.rng = random.Random(seed)
        self.gl_ok = gl.available() if gl_ok is None else gl_ok
        spec = spec.strip()
        if spec == "random" or spec.startswith("random:"):
            tag = spec.partition(":")[2].lower()
            pool = [t for t in catalog(self.gl_ok) if t.name not in ("cut",) and (not tag or tag in t.tags or tag == t.family)]
            if not pool:
                raise ValueError(f"Aucune transition avec le thème « {tag} ». Thèmes : cutkiller transitions tags")
            self.pool = pool
        elif "|" in spec:
            self.pool = [resolve(s) for s in spec.split("|") if s.strip()]
        else:
            self.pool = [resolve(spec)]
        if not self.gl_ok and any(t.needs_gl for t in self.pool):
            raise RuntimeError("Transitions GL demandées mais moderngl absent : pip install 'cutkiller[gl]'")

    def next(self) -> Transition:
        return self.pool[0] if len(self.pool) == 1 else self.rng.choice(self.pool)


def fixed_duration(t: Transition, fmt: VideoFormat) -> int | None:
    """Nombre de frames imposé par la transition (un pack a sa propre durée)."""
    if t.family == "pack":
        from cutkiller.media import probe

        return max(2, int(round(probe(t.path).duration * fmt.fps)))
    return None


def render(t: Transition, a_src: Path, a_start: int, b_src: Path, b_start: int, n: int, fmt: VideoFormat,
           fit: str, out: Path, gl_renderer_textures: dict | None = None) -> Path:
    """Rend la fenêtre de transition : n frames mêlant A (depuis a_start) et B (depuis b_start)."""
    if t.family == "xfade":
        return xfade.render(t.name, t.params, a_src, a_start, b_src, b_start, n, fmt, fit, out)
    if t.family == "fx":
        return fx.render_effect(t.name, t.params, a_src, a_start, b_src, b_start, n, fmt, fit, out)
    if t.family == "pack":
        return fx.render_pack(t.path, str(t.params.get("mode", "auto")), a_src, a_start, b_src, b_start, n, fmt, fit, out)
    if t.family == "luma":
        mask = fx.load_luma(t.path, fmt)
        return fx.render_luma(mask, float(t.params.get("softness", 0.15)), bool(t.params.get("invert", False)),
                              a_src, a_start, b_src, b_start, n, fmt, fit, out)
    spec = gl.load_custom(t.path) if t.family == "glsl" else gl.catalog()[t.name]
    params = dict(t.params)
    textures = {}
    for tex_name in spec.get("textures") or []:  # ex. gl:LumaWipe?luma=mon_masque.png
        if isinstance(params.get(tex_name), str):
            textures[tex_name] = fx.read_all(Path(params.pop(tex_name)), fmt, fit="stretch")[0]
    return gl.render(spec, params, a_src, a_start, b_src, b_start, n, fmt, fit, out, textures)


def all_tags() -> dict[str, int]:
    counts: dict[str, int] = {}
    for t in catalog():
        for tag in t.tags:
            counts[tag] = counts.get(tag, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


__all__ = ["Transition", "Picker", "resolve", "catalog", "render", "VideoFormat", "all_tags", "fixed_duration"]
