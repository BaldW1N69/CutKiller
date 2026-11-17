"""Moteur CPU (numpy) : effets dynamiques sans OpenGL, packs de transitions et masques luma.

- fx:*   effets "réseaux sociaux" (whip, zoom punch, shake, glitch, flash…) en repli du moteur GL
- pack:  vidéo de transition (fond vert, canal alpha ou fond noir type light leak)
- luma:  masque en niveaux de gris fourni par l'utilisateur (image) → volet sur mesure
"""

from __future__ import annotations

import functools
from pathlib import Path

import numpy as np

from cutkiller.transitions.frames import FrameWriter, VideoFormat, read_all, read_window

# ----------------------------------------------------------------- outils d'image


def ease(p: float) -> float:
    return p * p * (3 - 2 * p)


def bump(p: float) -> float:
    """0 aux extrémités, 1 au milieu."""
    return 1.0 - abs(2.0 * p - 1.0)


def sample(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Échantillonnage bilinéaire avec bords étendus (clamp).

    Gathers 1-D sur l'image aplatie (bien plus rapides que l'indexation 2-D), conversion en float
    après la lecture : seuls les pixels lus sont convertis."""
    h, w = img.shape[:2]
    xs = np.clip(xs, 0, w - 1.001)
    ys = np.clip(ys, 0, h - 1.001)
    x0, y0 = xs.astype(np.int32), ys.astype(np.int32)
    fx, fy = (xs - x0)[..., None], (ys - y0)[..., None]
    flat = img.reshape(h * w, -1)
    i00 = y0 * w + x0
    p00 = flat.take(i00, axis=0).astype(np.float32)
    p01 = flat.take(i00 + 1, axis=0).astype(np.float32)
    p10 = flat.take(i00 + w, axis=0).astype(np.float32)
    p11 = flat.take(i00 + w + 1, axis=0).astype(np.float32)
    top = p00 + (p01 - p00) * fx
    bot = p10 + (p11 - p10) * fx
    return top + (bot - top) * fy


@functools.lru_cache(maxsize=8)
def _axes(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    return np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32)


def _sample_separable(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Bilinéaire quand x ne dépend que de la colonne et y que de la ligne (zoom, translation) :
    interpolation des lignes puis des colonnes, deux gathers 1-D au lieu de quatre gathers 2-D."""
    h, w = img.shape[:2]
    xs = np.clip(xs, 0, w - 1.001)
    ys = np.clip(ys, 0, h - 1.001)
    x0, y0 = xs.astype(np.int32), ys.astype(np.int32)
    fx, fy = (xs - x0)[None, :, None], (ys - y0)[:, None, None]
    r0 = img.take(y0, axis=0).astype(np.float32)
    rows = r0 + (img.take(y0 + 1, axis=0).astype(np.float32) - r0) * fy
    c0 = rows.take(x0, axis=1)
    return c0 + (rows.take(x0 + 1, axis=1) - c0) * fx


def affine(img: np.ndarray, scale: float = 1.0, angle: float = 0.0, dx: float = 0.0, dy: float = 0.0) -> np.ndarray:
    """Zoom/rotation autour du centre + translation (en fraction de l'image)."""
    h, w = img.shape[:2]
    xr, yr = _axes(h, w)
    cx, cy = (w - 1) / 2, (h - 1) / 2
    u, v = xr - cx - dx * w, yr - cy - dy * h
    if angle == 0.0:
        return _sample_separable(img, u / scale + cx, v / scale + cy)
    c, s = np.cos(-angle), np.sin(-angle)
    u, v = u[None, :], v[:, None]
    xs = (c * u - s * v) / scale + cx
    ys = (s * u + c * v) / scale + cy
    return sample(img, xs.astype(np.float32), ys.astype(np.float32))


def motion_blur(img: np.ndarray, length: int, axis: int) -> np.ndarray:
    """Flou de mouvement en boîte le long d'un axe (cumsum, O(n))."""
    if length < 2:
        return img.astype(np.float32)
    im = img.astype(np.float32)
    pad = [(0, 0)] * im.ndim
    pad[axis] = (length // 2 + 1, length - length // 2)  # +1 : zéro de tête de la somme cumulée
    p = np.pad(im, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float32)
    n = im.shape[axis]
    hi = [slice(None)] * im.ndim
    lo = [slice(None)] * im.ndim
    hi[axis], lo[axis] = slice(length, length + n), slice(0, n)
    return (c[tuple(hi)] - c[tuple(lo)]) / length


def box_blur(img: np.ndarray, radius: int) -> np.ndarray:
    if radius < 1:
        return img.astype(np.float32)
    return motion_blur(motion_blur(img, 2 * radius + 1, 0), 2 * radius + 1, 1)


def mix(a, b, t: float) -> np.ndarray:
    return a.astype(np.float32) * (1 - t) + b.astype(np.float32) * t


# ----------------------------------------------------------------- effets


def fx_flash(a, b, p, prm):
    color = np.array(prm.get("color", [255, 255, 255]), dtype=np.float32)
    base = a if p < 0.5 else b
    return mix(base, np.broadcast_to(color, a.shape), bump(p) ** float(prm.get("sharpness", 1.5)))


def fx_zoom_punch(a, b, p, prm):
    amount = float(prm.get("amount", 0.6))
    blur = int(prm.get("blur", 6))
    if p < 0.5:
        q = ease(p * 2)
        img = affine(a, 1 + amount * q)
    else:
        q = ease((1 - p) * 2)
        img = affine(b, 1 + amount * q)
    return box_blur(img, int(blur * q))


def fx_zoom_out(a, b, p, prm):
    amount = float(prm.get("amount", 0.5))
    if p < 0.5:
        q = ease(p * 2)
        img = affine(a, 1 / (1 + amount * q))
    else:
        q = ease((1 - p) * 2)
        img = affine(b, 1 / (1 + amount * q))
    return box_blur(img, int(4 * q))


def _whip(direction):
    axis_x = direction in ("left", "right")
    sign = -1 if direction in ("left", "up") else 1

    def fx(a, b, p, prm):
        h, w = a.shape[:2]
        e = ease(p)
        size = w if axis_x else h
        strip = np.concatenate([a, b], axis=1 if axis_x else 0) if sign < 0 else np.concatenate([b, a], axis=1 if axis_x else 0)
        offset = e * size if sign < 0 else (1 - e) * size
        o = int(round(offset))
        view = strip[:, o:o + w] if axis_x else strip[o:o + h]
        length = int(float(prm.get("blur", 0.25)) * size * bump(p) ** 2)
        return motion_blur(view, length, 1 if axis_x else 0)

    return fx


def fx_spin(a, b, p, prm):
    turns = float(prm.get("turns", 1.0))
    angle = 2 * np.pi * turns * ease(p)
    q = bump(p)
    img = a if p < 0.5 else b
    return box_blur(affine(img, 1 + 0.5 * q, angle), int(5 * q))


def fx_shake(a, b, p, prm):
    rng = np.random.default_rng(int(p * 1000) + 7)
    amp = float(prm.get("amount", 0.04)) * bump(p)
    img = a if p < 0.5 else b
    return affine(img, 1 + 2 * amp, rng.uniform(-0.05, 0.05) * bump(p), rng.uniform(-amp, amp), rng.uniform(-amp, amp))


def fx_glitch(a, b, p, prm):
    rng = np.random.default_rng(int(p * 997) + 3)
    q = bump(p)
    base = (a if p < 0.5 else b).astype(np.float32)
    if rng.random() < 0.3 * q:
        base = (a if p >= 0.5 else b).astype(np.float32)  # images qui sautent
    h, w = base.shape[:2]
    out = base.copy()
    shift = int(float(prm.get("rgb", 0.03)) * w * q)
    if shift:
        out[..., 0] = np.roll(base[..., 0], shift, axis=1)
        out[..., 2] = np.roll(base[..., 2], -shift, axis=1)
    for _ in range(int(12 * q)):
        y0 = rng.integers(0, h)
        hh = int(rng.integers(2, max(3, h // 12)))
        out[y0:y0 + hh] = np.roll(out[y0:y0 + hh], int(rng.integers(-w // 8, w // 8)), axis=1)
    noise = rng.normal(0, 18 * q, out.shape[:2])[..., None]
    return out + noise


def fx_rgb_split(a, b, p, prm):
    q = bump(p)
    base = mix(a, b, ease(p))
    out = base.copy()
    s = float(prm.get("amount", 0.08)) * q
    out[..., 0] = affine(base[..., :1], 1 + s)[..., 0]
    out[..., 2] = affine(base[..., 2:], 1 - s / 2)[..., 0]
    return out


def fx_blur(a, b, p, prm):
    r = int(float(prm.get("radius", 0.03)) * a.shape[1] * bump(p))
    return box_blur(mix(a, b, ease(p)), r)


def fx_light_leak(a, b, p, prm):
    h, w = a.shape[:2]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    q = bump(p)
    cx = w * (0.2 + 0.6 * p)
    blob = np.exp(-(((x - cx) / (0.45 * w)) ** 2 + ((y - 0.4 * h) / (0.6 * h)) ** 2))
    tint = np.array(prm.get("color", [255, 150, 60]), dtype=np.float32)
    leak = blob[..., None] * tint * q * float(prm.get("intensity", 1.4))
    base = mix(a, b, ease(p))
    return 255 - (255 - base) * (255 - np.clip(leak, 0, 255)) / 255  # mode écran


def fx_wave(a, b, p, prm):
    h, w = a.shape[:2]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    q = bump(p)
    amp = float(prm.get("amount", 0.03)) * w * q
    xs = x + amp * np.sin(y / h * 2 * np.pi * float(prm.get("waves", 3)) + p * 10)
    return mix(sample(a, xs, y), sample(b, xs, y), ease(p))


def fx_cut(a, b, p, prm):
    return a if p < 0.5 else b


EFFECTS = {
    "flash": (fx_flash, "flash blanc au moment de la coupe", "flash light dynamic"),
    "zoom_punch": (fx_zoom_punch, "zoom avant brutal + flou, l'image suivante dézoome", "zoom dynamic tiktok"),
    "zoom_out": (fx_zoom_out, "dézoom puis rezoom", "zoom dynamic"),
    "whip_left": (_whip("left"), "whip pan vers la gauche (flou de mouvement)", "slide motion-blur dynamic tiktok"),
    "whip_right": (_whip("right"), "whip pan vers la droite", "slide motion-blur dynamic tiktok"),
    "whip_up": (_whip("up"), "whip pan vers le haut", "slide motion-blur dynamic tiktok"),
    "whip_down": (_whip("down"), "whip pan vers le bas", "slide motion-blur dynamic tiktok"),
    "spin": (fx_spin, "rotation + zoom", "rotate dynamic"),
    "shake": (fx_shake, "tremblement caméra", "shake dynamic tiktok"),
    "glitch": (fx_glitch, "glitch numérique (RVB, tranches, bruit)", "glitch dynamic tiktok"),
    "rgb_split": (fx_rgb_split, "aberration chromatique", "chromatic glitch dynamic"),
    "blur": (fx_blur, "fondu flouté", "blur clean"),
    "light_leak": (fx_light_leak, "fuite de lumière chaude", "light film clean"),
    "wave": (fx_wave, "ondulation", "distort wave"),
    "cut": (fx_cut, "coupe franche (pour tester)", "clean"),
}


# ----------------------------------------------------------------- packs & luma


def key_alpha(frames: np.ndarray, mode: str = "auto") -> tuple[np.ndarray, np.ndarray, str]:
    """Retourne (rgb, alpha [0,1], mode utilisé) pour une vidéo de transition."""
    rgb = frames[..., :3].astype(np.float32)
    if frames.shape[-1] == 4 and mode in ("auto", "alpha") and frames[..., 3].min() < 250:
        return rgb, frames[..., 3:4].astype(np.float32) / 255, "alpha"
    if mode == "auto":
        g_dom = (rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2]))
        mode = "green" if np.mean(g_dom > 60) > 0.15 else "screen"
    if mode == "green":
        g_dom = rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])
        alpha = 1 - np.clip((g_dom - 25) / 50, 0, 1)
        rgb[..., 1] = np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2]))  # anti-débordement vert
        return rgb, alpha[..., None], "green"
    return rgb, np.ones(rgb.shape[:-1] + (1,), np.float32), "screen"


def coverage(alpha: np.ndarray, rgb: np.ndarray, mode: str) -> np.ndarray:
    if mode == "screen":
        return rgb.mean(axis=(1, 2, 3)) / 255
    return alpha.mean(axis=(1, 2, 3))


def render_pack(pack: Path, mode: str, a_src: Path, a_start: int, b_src: Path, b_start: int, n: int,
                fmt: VideoFormat, fit: str, out: Path) -> Path:
    ov = read_all(pack, fmt, fit="crop", alpha=True)
    ov = ov[:n] if ov.shape[0] >= n else np.concatenate([ov, np.repeat(ov[-1:], n - ov.shape[0], 0)])
    rgb, alpha, used = key_alpha(ov, mode)
    cut = int(np.argmax(coverage(alpha, rgb, used)))  # coupe cachée au moment où le pack couvre le plus
    a = read_window(a_src, a_start, n, fmt, fit)
    b = read_window(b_src, b_start, n, fmt, fit)
    with FrameWriter(out, fmt) as w:
        for k in range(n):
            base = (a[k] if k < cut else b[k]).astype(np.float32)
            if used == "screen":
                frame = 255 - (255 - base) * (255 - rgb[k]) / 255
            else:
                frame = base * (1 - alpha[k]) + rgb[k] * alpha[k]
            w.write(np.clip(frame, 0, 255).astype(np.uint8))
    return out


def load_luma(path: Path, fmt: VideoFormat) -> np.ndarray:
    img = read_all(path, fmt, fit="stretch")[0].astype(np.float32)
    return img.mean(axis=2) / 255


def render_luma(mask: np.ndarray, softness: float, invert: bool, a_src: Path, a_start: int, b_src: Path, b_start: int,
                n: int, fmt: VideoFormat, fit: str, out: Path) -> Path:
    m = 1 - mask if invert else mask
    a = read_window(a_src, a_start, n, fmt, fit).astype(np.float32)
    b = read_window(b_src, b_start, n, fmt, fit).astype(np.float32)
    with FrameWriter(out, fmt) as w:
        for k in range(n):
            p = (k + 1) / (n + 1)
            t = np.clip((p * (1 + softness) - m) / max(softness, 1e-3), 0, 1)[..., None]
            w.write(np.clip(a[k] * (1 - t) + b[k] * t, 0, 255).astype(np.uint8))
    return out


def render_effect(name: str, params: dict, a_src: Path, a_start: int, b_src: Path, b_start: int, n: int,
                  fmt: VideoFormat, fit: str, out: Path) -> Path:
    fn = EFFECTS[name][0]
    a = read_window(a_src, a_start, n, fmt, fit)
    b = read_window(b_src, b_start, n, fmt, fit)
    with FrameWriter(out, fmt) as w:
        for k in range(n):
            w.write(np.clip(fn(a[k], b[k], (k + 1) / (n + 1), params), 0, 255).astype(np.uint8))
    return out
