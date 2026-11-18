"""Moteur d'animation : génère des vidéos à fond transparent (motion design) à partir de fonctions `frame(t)`.

Deux usages :
- préréglages (`cutkiller animate title text="SOLDES"`) : voir presets.py ;
- scripts sur mesure écrits par Claude ou l'utilisateur :

    DURATION = 3.0           # facultatif
    def frame(t, ctx):       # t en secondes, ctx = Ctx (taille, polices, easing…)
        img = ctx.blank()
        p = ctx.prog(t, 0, 0.6, "out_back")
        ctx.text(img, "Bonjour", (0.5, 0.5), size=0.1 * (0.5 + 0.5 * p), alpha=p)
        return img           # PIL.Image RGBA ou ndarray HxWx4 uint8

Sortie : .mov (ProRes 4444 avec alpha, accepté par tous les logiciels de montage), .webm (VP9 alpha,
léger), .png (une image : aperçu) ; puis `cutkiller overlay` pour l'incruster.
"""

from __future__ import annotations

import functools
import importlib.util
import math
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from cutkiller.media import _require

# ------------------------------------------------------------------ easing


def _clamp(x: float) -> float:
    return 0.0 if x <= 0 else 1.0 if x >= 1 else x


EASINGS: dict[str, Callable[[float], float]] = {
    "linear": lambda x: x,
    "in": lambda x: x ** 3,
    "out": lambda x: 1 - (1 - x) ** 3,
    "in_out": lambda x: 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2,
    "out_back": lambda x: 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
    "out_elastic": lambda x: x if x in (0, 1) else 2 ** (-10 * x) * math.sin((x * 10 - 0.75) * 2 * math.pi / 3) + 1,
    "out_bounce": lambda x: (lambda n, d: n * x * x if x < 1 / d else n * (x - 1.5 / d) ** 2 + 0.75 if x < 2 / d
                             else n * (x - 2.25 / d) ** 2 + 0.9375 if x < 2.5 / d else n * (x - 2.625 / d) ** 2 + 0.984375)(7.5625, 2.75),
    "smooth": lambda x: x * x * (3 - 2 * x),
}


def ease(x: float, kind: str = "out") -> float:
    return EASINGS[kind](_clamp(x))


def prog(t: float, start: float, end: float, kind: str = "linear") -> float:
    """Progression 0→1 de `start` à `end` (secondes), avec easing."""
    if end <= start:
        return 1.0 if t >= end else 0.0
    return ease((t - start) / (end - start), kind)


def in_out(t: float, duration: float, fade_in: float = 0.35, fade_out: float = 0.35, kind: str = "out") -> float:
    """1 pendant l'animation, avec montée au début et descente à la fin (pour l'opacité)."""
    return min(prog(t, 0, fade_in, kind), 1 - prog(t, duration - fade_out, duration, "in"))


# ------------------------------------------------------------------ polices et couleurs

FONT_CANDIDATES = {
    True: ["arialbd.ttf", "Arial Bold.ttf", "Montserrat-Bold.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf",
           "Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"],
    False: ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf"],
}

NAMED = {"white": "#FFFFFF", "black": "#000000", "yellow": "#FFE600", "red": "#FF2D2D", "green": "#2DFF6E",
         "blue": "#2D7BFF", "orange": "#FF8A00", "pink": "#FF4FB8", "cyan": "#00E5FF", "purple": "#8B5CFF"}


def rgba(color, alpha: float = 1.0) -> tuple[int, int, int, int]:
    if isinstance(color, (tuple, list)):
        r, g, b = color[:3]
        a = color[3] if len(color) > 3 else 255
        return int(r), int(g), int(b), int(a * alpha)
    c = NAMED.get(str(color).lower(), str(color))
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    r, g, b = int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)
    a = int(c[6:8], 16) if len(c) == 8 else 255
    return r, g, b, int(a * _clamp(alpha))


@functools.lru_cache(maxsize=64)
def load_font(size: int, bold: bool = True, path: str | None = None) -> ImageFont.FreeTypeFont:
    for cand in [path, os.environ.get("CUTKILLER_FONT")] + FONT_CANDIDATES[bold]:
        if not cand:
            continue
        try:
            return ImageFont.truetype(cand, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


# ------------------------------------------------------------------ contexte de dessin


@dataclass
class Ctx:
    w: int
    h: int
    fps: float
    duration: float
    font_path: str | None = None
    params: dict | None = None

    # raccourcis
    ease = staticmethod(ease)
    prog = staticmethod(prog)
    in_out = staticmethod(in_out)
    rgba = staticmethod(rgba)

    def blank(self) -> Image.Image:
        return Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))

    def px(self, v: float, axis: str = "h") -> int:
        """Fraction (0..1) de la largeur ('w') ou de la hauteur ('h') → pixels."""
        return int(round(v * (self.w if axis == "w" else self.h)))

    def xy(self, pos) -> tuple[float, float]:
        x, y = pos
        return (x * self.w if x <= 1.5 else x), (y * self.h if y <= 1.5 else y)

    def font(self, size: float, bold: bool = True) -> ImageFont.FreeTypeFont:
        """`size` en fraction de la hauteur (0.08 = 8 %) ou en pixels si > 1."""
        px = int(size * self.h) if size <= 1 else int(size)
        return load_font(max(4, px), bold, self.font_path)

    def measure(self, text: str, size: float, bold: bool = True) -> tuple[int, int]:
        """Taille en pixels (largeur, hauteur) d'un texte multi-lignes."""
        font = self.font(size, bold)
        d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
        x0, y0, x1, y1 = d.multiline_textbbox((0, 0), text, font=font, spacing=int(0.15 * font.size))
        return x1 - x0, y1 - y0

    def fit(self, text: str, size: float, max_width: float = 0.9, bold: bool = True) -> float:
        """Réduit `size` pour que le texte tienne dans `max_width` (fraction de la largeur)."""
        w, _ = self.measure(text, size, bold)
        limit = max_width * self.w
        return size if w <= limit or w == 0 else size * limit / w

    def text(self, img: Image.Image, text: str, pos, *, size: float = 0.07, color="white", alpha: float = 1.0,
             anchor: str = "mm", bold: bool = True, stroke: float = 0.0, stroke_color="black", scale: float = 1.0,
             rotate: float = 0.0, shadow: float = 0.0, align: str = "center", spacing: float = 0.15,
             max_width: float | None = 0.92) -> Image.Image:
        """Dessine du texte (multi-lignes) avec zoom/rotation/opacité autour de son point d'ancrage.
        Réduit automatiquement la taille si le texte dépasse `max_width` (fraction de la largeur)."""
        if alpha <= 0 or scale <= 0 or not text:
            return img
        if max_width:
            size = self.fit(text, size, max_width, bold)
        font = self.font(size * scale if size <= 1 else size * scale, bold)
        sw = int(round(stroke * font.size)) if stroke < 1 else int(stroke)
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        x, y = self.xy(pos)
        kw = dict(font=font, anchor=anchor, align=align, spacing=int(spacing * font.size))
        if shadow:
            off = max(1, int(shadow * font.size))
            d.multiline_text((x + off, y + off), text, fill=(0, 0, 0, 160), **kw)
            layer = layer.filter(ImageFilter.GaussianBlur(off))
            d = ImageDraw.Draw(layer)
        d.multiline_text((x, y), text, fill=rgba(color), stroke_width=sw, stroke_fill=rgba(stroke_color), **kw)
        if rotate:
            layer = layer.rotate(rotate, resample=Image.BICUBIC, center=(x, y))
        return _composite(img, layer, alpha)

    def rect(self, img: Image.Image, box, *, color="white", alpha: float = 1.0, radius: float = 0.0,
             outline=None, width: int = 0) -> Image.Image:
        x0, y0 = self.xy(box[:2])
        x1, y1 = self.xy(box[2:])
        if x1 <= x0 or y1 <= y0 or alpha <= 0:
            return img
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        r = int(radius * min(x1 - x0, y1 - y0)) if radius <= 1 else int(radius)
        ImageDraw.Draw(layer).rounded_rectangle((x0, y0, x1, y1), r, fill=rgba(color),
                                                outline=rgba(outline) if outline else None, width=width)
        return _composite(img, layer, alpha)

    def circle(self, img: Image.Image, center, radius: float, *, color=None, outline="white", width: float = 0.01,
               alpha: float = 1.0, start: float = 0.0, end: float = 360.0) -> Image.Image:
        """Disque ou arc (start/end en degrés, 0 = 3 h, sens horaire). radius en fraction de la hauteur."""
        x, y = self.xy(center)
        r = radius * self.h if radius <= 1.5 else radius
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        bbox = (x - r, y - r, x + r, y + r)
        if color is not None:
            d.ellipse(bbox, fill=rgba(color))
        if outline is not None and end > start:
            w = max(1, int(width * self.h if width < 1 else width))
            d.arc(bbox, start, end, fill=rgba(outline), width=w)
        return _composite(img, layer, alpha)

    def line(self, img: Image.Image, points, *, color="white", width: float = 0.01, alpha: float = 1.0) -> Image.Image:
        pts = [self.xy(p) for p in points]
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        w = max(1, int(width * self.h if width < 1 else width))
        ImageDraw.Draw(layer).line(pts, fill=rgba(color), width=w, joint="curve")
        return _composite(img, layer, alpha)

    def polygon(self, img: Image.Image, points, *, color="white", alpha: float = 1.0) -> Image.Image:
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).polygon([self.xy(p) for p in points], fill=rgba(color))
        return _composite(img, layer, alpha)

    def paste(self, img: Image.Image, src: Image.Image | str | Path, pos, *, scale: float = 1.0, alpha: float = 1.0,
              rotate: float = 0.0, anchor: str = "mm") -> Image.Image:
        """Colle une image (logo PNG transparent…) centrée sur `pos`. scale = fraction de la largeur."""
        im = _load_image(str(src)) if not isinstance(src, Image.Image) else src.convert("RGBA")
        target_w = max(1, int(scale * self.w if scale <= 3 else scale))
        im = im.resize((target_w, max(1, int(im.height * target_w / im.width))), Image.LANCZOS)
        if rotate:
            im = im.rotate(rotate, resample=Image.BICUBIC, expand=True)
        x, y = self.xy(pos)
        ox = {"l": 0, "m": im.width / 2, "r": im.width}[anchor[0]]
        oy = {"t": 0, "m": im.height / 2, "b": im.height}[anchor[1]]
        layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
        layer.paste(im, (int(x - ox), int(y - oy)), im)  # gère aussi les positions hors cadre
        return _composite(img, layer, alpha)

    def glow(self, img: Image.Image, radius: float = 0.02, strength: float = 1.0) -> Image.Image:
        """Halo lumineux autour de tout ce qui est déjà dessiné."""
        r = max(1, int(radius * self.h))
        halo = img.filter(ImageFilter.GaussianBlur(r))
        if strength != 1.0:
            a = np.asarray(halo).copy()
            a[..., 3] = np.clip(a[..., 3] * strength, 0, 255)
            halo = Image.fromarray(a, "RGBA")
        halo.alpha_composite(img)
        return halo


@functools.lru_cache(maxsize=16)
def _load_image(path: str) -> Image.Image:
    return Image.open(path).convert("RGBA")


def _composite(base: Image.Image, layer: Image.Image, alpha: float) -> Image.Image:
    if alpha < 1.0:
        a = np.asarray(layer).copy()
        a[..., 3] = (a[..., 3] * _clamp(alpha)).astype(np.uint8)
        layer = Image.fromarray(a, "RGBA")
    base.alpha_composite(layer)
    return base


# ------------------------------------------------------------------ rendu


def _to_rgba(frame, w: int, h: int) -> np.ndarray:
    if isinstance(frame, Image.Image):
        frame = np.asarray(frame.convert("RGBA"))
    frame = np.asarray(frame)
    if frame.ndim != 3 or frame.shape[2] not in (3, 4) or frame.shape[:2] != (h, w):
        raise ValueError(f"frame() doit renvoyer une image {w}x{h} RGBA (reçu {frame.shape})")
    if frame.shape[2] == 3:
        frame = np.concatenate([frame, np.full((h, w, 1), 255, frame.dtype)], axis=2)
    return np.ascontiguousarray(frame, dtype=np.uint8)


def encoder_args(out: Path) -> list[str]:
    ext = out.suffix.lower()
    if ext == ".webm":
        return ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "24", "-auto-alt-ref", "0",
                "-row-mt", "1"]
    if ext == ".mkv":
        return ["-c:v", "ffv1", "-pix_fmt", "bgra"]
    if ext == ".mp4":  # pas d'alpha en mp4 : fond noir (utile pour un aperçu partageable)
        return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "veryfast"]
    return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0"]


def render(frame_fn: Callable, out: str | Path, ctx: Ctx, *, log=None) -> Path:
    """Rend `frame_fn(t, ctx)` sur toute la durée, vers une vidéo à canal alpha."""
    out = Path(out)
    n = max(1, int(round(ctx.duration * ctx.fps)))
    if out.suffix.lower() == ".png":
        Image.fromarray(_to_rgba(frame_fn(0.0, ctx), ctx.w, ctx.h), "RGBA").save(out)
        return out
    cmd = [_require("ffmpeg"), "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
           "-s", f"{ctx.w}x{ctx.h}", "-r", str(ctx.fps), "-i", "-", *encoder_args(out), str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for k in range(n):
            proc.stdin.write(_to_rgba(frame_fn(k / ctx.fps, ctx), ctx.w, ctx.h).tobytes())
            if log and n >= 60 and k % max(1, n // 5) == 0:
                log(f"    image {k}/{n}")
    except BrokenPipeError:
        pass
    finally:
        proc.stdin.close()
        err = proc.stderr.read().decode(errors="replace")
        code = proc.wait()
    if code != 0:
        raise RuntimeError(f"Encodage de l'animation impossible : {err[-800:]}")
    return out


def stills(frame_fn: Callable, ctx: Ctx, times: list[float], folder: Path, stem: str = "frame",
           background: str | None = "#202020") -> list[Path]:
    """Images clés pour vérifier une animation avant le rendu complet (fond gris : on voit l'alpha)."""
    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for t in times:
        img = Image.fromarray(_to_rgba(frame_fn(min(t, ctx.duration), ctx), ctx.w, ctx.h), "RGBA")
        if background:
            bg = Image.new("RGBA", img.size, rgba(background))
            bg.alpha_composite(img)
            img = bg
        p = folder / f"{stem}_{t:06.2f}s.png"
        img.save(p)
        out.append(p)
    return out


def contact_sheet(images: list[Path], out: Path, labels: list[str] | None = None, max_width: int = 1600) -> Path:
    """Assemble des images côte à côte (avec étiquettes) : une seule image à regarder pour juger une animation."""
    ims = [Image.open(p).convert("RGB") for p in images]
    if not ims:
        raise ValueError("Aucune image à assembler.")
    tile_w = max(1, min(max_width // len(ims), ims[0].width))
    tile_h = int(ims[0].height * tile_w / ims[0].width)
    sheet = Image.new("RGB", (tile_w * len(ims), tile_h + 22), (17, 17, 17))
    d = ImageDraw.Draw(sheet)
    for i, im in enumerate(ims):
        sheet.paste(im.resize((tile_w, tile_h), Image.LANCZOS), (i * tile_w, 22))
        if labels:
            d.text((i * tile_w + 6, 4), labels[i], fill=(230, 230, 230), font=load_font(14, False))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def load_script(path: str | Path) -> tuple[Callable, dict]:
    """Charge un script d'animation : renvoie (frame, réglages DURATION/SIZE/FPS déclarés)."""
    path = Path(path)
    spec = importlib.util.spec_from_file_location(f"cutkiller_anim_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Script illisible : {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not callable(getattr(mod, "frame", None)):
        raise ValueError(f"{path} doit définir une fonction frame(t, ctx)")
    meta = {k.lower(): getattr(mod, k) for k in ("DURATION", "SIZE", "FPS") if hasattr(mod, k)}
    return mod.frame, meta


__all__ = ["Ctx", "ease", "prog", "in_out", "rgba", "render", "stills", "contact_sheet", "load_script", "load_font", "EASINGS"]
