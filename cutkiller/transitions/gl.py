"""Moteur GL : la collection gl-transitions (214 shaders, MIT) rendue via moderngl.

Fonctionne avec un GPU ou en rendu logiciel (Mesa llvmpipe via EGL sur un serveur sans écran).
Installation : pip install 'cutkiller[gl]'.
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path

import numpy as np

from cutkiller.transitions.frames import FrameWriter, VideoFormat, read_window

DATA = Path(__file__).with_name("gl_transitions.json")

VERTEX = """
#version 330
in vec2 in_pos;
out vec2 _uv;
void main() { _uv = 0.5 * (in_pos + 1.0); gl_Position = vec4(in_pos, 0.0, 1.0); }
"""

FRAGMENT = """
#version 330
in vec2 _uv;
out vec4 _fragColor;
uniform sampler2D from, to;
uniform float progress, ratio;
vec4 getFromColor(vec2 uv) {{ return texture(from, uv); }}
vec4 getToColor(vec2 uv) {{ return texture(to, uv); }}
{body}
void main() {{ _fragColor = transition(_uv); }}
"""


@functools.lru_cache(maxsize=1)
def catalog() -> dict[str, dict]:
    return {t["name"]: t for t in json.loads(DATA.read_text(encoding="utf-8"))}


def load_custom(path: Path) -> dict:
    """Charge un shader au format gl-transitions écrit par l'utilisateur (.glsl)."""
    src = path.read_text(encoding="utf-8")
    src = re.sub(r"\btexture2D\s*\(", "texture(", src)
    params, types = {}, {}
    for m in re.finditer(r"uniform\s+(\w+)\s+(\w+)\s*;\s*//\s*=\s*([^\n]+)", src):
        typ, name, raw = m.groups()
        types[name] = typ
        params[name] = _parse_default(typ, raw.strip())
    return {"name": path.stem, "glsl": src, "defaultParams": params, "paramsTypes": types, "textures": [],
            "tags": ["custom"], "description": f"shader personnalisé {path.name}", "license": "?"}


def _parse_default(typ: str, raw: str):
    nums = [float(x) for x in re.findall(r"-?\d+\.?\d*(?:e-?\d+)?", raw)]
    if typ == "bool":
        return raw.startswith("true")
    if typ in ("int",):
        return int(nums[0]) if nums else 0
    if typ == "float":
        return nums[0] if nums else 0.0
    if typ.startswith("ivec"):
        return [int(v) for v in nums]
    return nums


class GLRenderer:
    """Contexte OpenGL hors écran réutilisable (un programme compilé par transition)."""

    def __init__(self, width: int, height: int):
        try:
            import moderngl  # type: ignore
        except ImportError as exc:
            raise RuntimeError("Transitions GL indisponibles : pip install 'cutkiller[gl]'") from exc
        self.ctx = _create_context(moderngl)
        self.width, self.height = width, height
        self.fbo = self.ctx.simple_framebuffer((width, height), components=4)
        self.quad = self.ctx.buffer(np.array([-1, -1, 1, -1, -1, 1, 1, 1], dtype="f4").tobytes())
        self.tex_a = self._texture()
        self.tex_b = self._texture()
        self.programs: dict[str, tuple] = {}

    def _texture(self, size=None, data=None):
        import moderngl  # type: ignore

        tex = self.ctx.texture(size or (self.width, self.height), 3, data)
        tex.filter = (moderngl.LINEAR, moderngl.LINEAR)
        tex.repeat_x = tex.repeat_y = False  # clamp to edge, comme la référence gl-transitions
        return tex

    def program(self, spec: dict):
        key = spec["name"] + str(hash(spec["glsl"]))
        if key not in self.programs:
            prog = self.ctx.program(vertex_shader=VERTEX, fragment_shader=FRAGMENT.format(body=spec["glsl"]))
            vao = self.ctx.simple_vertex_array(prog, self.quad, "in_pos")
            self.programs[key] = (prog, vao)
        return self.programs[key]

    def render(self, spec: dict, a: np.ndarray, b: np.ndarray, progress: float, params: dict,
               extra_textures: dict[str, np.ndarray] | None = None) -> np.ndarray:
        prog, vao = self.program(spec)
        self.tex_a.write(np.ascontiguousarray(a[::-1, :, :3]).tobytes())
        self.tex_b.write(np.ascontiguousarray(b[::-1, :, :3]).tobytes())
        unit = 0
        for name, tex in (("from", self.tex_a), ("to", self.tex_b)):
            tex.use(unit)
            if name in prog:
                prog[name].value = unit
            unit += 1
        for name, img in (extra_textures or {}).items():
            tex = self._texture((img.shape[1], img.shape[0]), np.ascontiguousarray(img[::-1, :, :3]).tobytes())
            tex.use(unit)
            if name in prog:
                prog[name].value = unit
            unit += 1
        values = {**spec.get("defaultParams", {}), **params, "progress": progress, "ratio": self.width / self.height}
        types = spec.get("paramsTypes", {})
        for name, val in values.items():
            if name not in prog or types.get(name) == "sampler2D":
                continue
            prog[name].value = _uniform(val, types.get(name))
        self.fbo.use()
        self.fbo.clear(0, 0, 0, 1)
        vao.render(mode=self.ctx.TRIANGLE_STRIP)
        raw = self.fbo.read(components=3)
        return np.frombuffer(raw, dtype=np.uint8).reshape(self.height, self.width, 3)[::-1]

    def release(self) -> None:
        self.ctx.release()


def _create_context(moderngl):
    errors = []
    for kwargs in ({}, {"backend": "egl"}):
        try:
            return moderngl.create_standalone_context(require=330, **kwargs)
        except Exception as exc:  # noqa: BLE001 - on essaie le backend suivant
            errors.append(f"{kwargs.get('backend', 'défaut')}: {exc}")
    raise RuntimeError("Aucun contexte OpenGL 3.3 disponible (" + " | ".join(errors) + "). "
                       "Sur un serveur Linux sans écran : apt install libegl1 libgl1-mesa-dri")


def _uniform(val, typ):
    if typ == "bool":
        return bool(val)
    if typ == "int":
        return int(val)
    if typ and typ.startswith("ivec"):
        return tuple(int(v) for v in val)
    if isinstance(val, (list, tuple)):
        return tuple(float(v) for v in val)
    return float(val)


def available() -> bool:
    try:
        import moderngl  # type: ignore  # noqa: F401
    except ImportError:
        return False
    return True


def default_textures(spec: dict, fmt: VideoFormat) -> dict[str, np.ndarray]:
    """Textures procédurales pour LumaWipe / DisplacementMap quand l'utilisateur n'en fournit pas."""
    out = {}
    h, w = fmt.height, fmt.width
    for name in spec.get("textures") or []:
        y, x = np.mgrid[0:h, 0:w].astype(np.float32)
        if "displacement" in name.lower():
            v = 0.5 + 0.25 * np.sin(x / w * 18) * np.cos(y / h * 14) + 0.25 * np.sin((x + y) / (w + h) * 40)
        else:  # luma : dégradé radial
            v = np.hypot(x / w - 0.5, (y / h - 0.5) / fmt.ratio * fmt.ratio) / 0.71
        g = (np.clip(v, 0, 1) * 255).astype(np.uint8)
        out[name] = np.repeat(g[..., None], 3, axis=2)
    return out


def render(spec: dict, params: dict, a_src: Path, a_start: int, b_src: Path, b_start: int, n: int,
           fmt: VideoFormat, fit: str, out: Path, textures: dict[str, np.ndarray] | None = None) -> Path:
    a = read_window(a_src, a_start, n, fmt, fit)
    b = read_window(b_src, b_start, n, fmt, fit)
    tex = {**default_textures(spec, fmt), **(textures or {})}
    r = GLRenderer(fmt.width, fmt.height)
    try:
        with FrameWriter(out, fmt) as w:
            for k in range(n):
                w.write(r.render(spec, a[k], b[k], (k + 1) / (n + 1), params, tex))
    finally:
        r.release()
    return out
