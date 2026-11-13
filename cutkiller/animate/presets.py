"""Animations prêtes à l'emploi. Chaque préréglage = fonction frame(t, ctx) paramétrée par ctx.params.

Paramètres communs : color, accent, size (fraction de la hauteur), x, y (0..1), font (chemin .ttf).
"""

from __future__ import annotations

import math
import random

from PIL import Image

from cutkiller.animate import Ctx, ease, in_out, prog


def _p(ctx: Ctx, key: str, default):
    v = (ctx.params or {}).get(key, default)
    if isinstance(default, bool):
        return str(v).lower() in ("1", "true", "yes", "oui") if isinstance(v, str) else bool(v)
    if isinstance(default, (int, float)) and not isinstance(default, bool):
        try:
            return type(default)(v)
        except (TypeError, ValueError):
            return default
    return v


def _text_param(ctx: Ctx, default: str) -> str:
    return str(_p(ctx, "text", default)).replace("\\n", "\n")


# ------------------------------------------------------------------ texte


def title(t, ctx: Ctx):
    """Titre qui apparaît en « pop » (zoom avec rebond), reste, puis s'efface."""
    img = ctx.blank()
    pop = prog(t, 0, 0.45, "out_back")
    a = in_out(t, ctx.duration, 0.2, 0.3)
    return ctx.text(img, _text_param(ctx, "TITRE"), (_p(ctx, "x", 0.5), _p(ctx, "y", 0.5)), size=_p(ctx, "size", 0.09),
                    color=_p(ctx, "color", "white"), alpha=a, scale=0.3 + 0.7 * pop, stroke=_p(ctx, "stroke", 0.06),
                    shadow=0.04)


def slide(t, ctx: Ctx):
    """Texte qui glisse depuis un bord (dir = left|right|top|bottom), avec flou de vitesse simulé."""
    img = ctx.blank()
    d = _p(ctx, "dir", "left")
    p = prog(t, 0, 0.5, "out")
    out = prog(t, ctx.duration - 0.35, ctx.duration, "in")
    off = (1 - p) + out
    sx, sy = {"left": (-1, 0), "right": (1, 0), "top": (0, -1), "bottom": (0, 1)}[d]
    x, y = _p(ctx, "x", 0.5) + sx * off * 0.8, _p(ctx, "y", 0.5) + sy * off * 0.8
    for k, ghost in enumerate((0.12, 0.06)):  # traînée
        speed = (1 - p) + out
        if speed > 0.05:
            img = ctx.text(img, _text_param(ctx, "Texte"), (x - sx * ghost * speed, y - sy * ghost * speed),
                           size=_p(ctx, "size", 0.08), color=_p(ctx, "color", "white"), alpha=0.25 / (k + 1))
    return ctx.text(img, _text_param(ctx, "Texte"), (x, y), size=_p(ctx, "size", 0.08), color=_p(ctx, "color", "white"),
                    stroke=0.05, shadow=0.04)


def typewriter(t, ctx: Ctx):
    """Machine à écrire : les lettres arrivent une à une, curseur clignotant."""
    img = ctx.blank()
    text = _text_param(ctx, "Tape ton texte ici")
    cps = _p(ctx, "speed", 18.0)
    n = min(len(text), int(max(0.0, t - 0.1) * cps))
    cursor = "|" if int(t * 2.2) % 2 == 0 or n < len(text) else " "
    a = 1 - prog(t, ctx.duration - 0.3, ctx.duration)
    return ctx.text(img, text[:n] + cursor, (_p(ctx, "x", 0.5), _p(ctx, "y", 0.5)), size=_p(ctx, "size", 0.06),
                    color=_p(ctx, "color", "white"), alpha=a, stroke=0.05)


def kinetic(t, ctx: Ctx):
    """Typographie cinétique : mots qui arrivent un par un ; *mot* = mot mis en avant (couleur accent, plus gros)."""
    img = ctx.blank()
    words = [(w.strip("*"), w.startswith("*") and w.endswith("*") and len(w) > 2)
             for w in _text_param(ctx, "Le *meilleur* moment c'est *maintenant*").split()]
    per = _p(ctx, "per_word", 0.28)
    accent = _p(ctx, "accent", "yellow")
    size = _p(ctx, "size", 0.075)
    max_w = 0.86 * ctx.w
    gap = ctx.measure(" ", size)[0] or int(0.3 * size * ctx.h)

    def width(w, hot):
        return ctx.measure(w, size * (1.2 if hot else 1.0))[0]

    # taille globale réduite si un mot seul dépasse la largeur
    widest = max((width(w, h) for w, h in words), default=1)
    if widest > max_w:
        size *= max_w / widest
        gap = ctx.measure(" ", size)[0]
    lines, cur, cur_w = [], [], 0
    for w, hot in words:
        ww = width(w, hot)
        if cur and cur_w + gap + ww > max_w:
            lines.append((cur, cur_w))
            cur, cur_w = [], 0
        cur_w += (gap if cur else 0) + ww
        cur.append((w, hot, ww))
    if cur:
        lines.append((cur, cur_w))
    a_out = 1 - prog(t, ctx.duration - 0.3, ctx.duration)
    line_h = size * 1.35
    y0 = _p(ctx, "y", 0.5) - (len(lines) - 1) * line_h / 2
    k = 0
    for li, (line, lw) in enumerate(lines):
        x = (ctx.w - lw) / 2
        y = (y0 + li * line_h) * ctx.h
        for w, hot, ww in line:
            pop = prog(t, k * per, k * per + 0.3, "out_back")
            img = ctx.text(img, w, (x + ww / 2, y + (1 - pop) * 0.03 * ctx.h), size=size * (1.2 if hot else 1.0),
                           color=accent if hot else _p(ctx, "color", "white"), alpha=min(pop * 1.5, 1) * a_out,
                           scale=0.6 + 0.4 * pop, stroke=0.06, max_width=None)
            x += ww + gap
            k += 1
    return img


def lower_third(t, ctx: Ctx):
    """Bandeau nom + fonction en bas à gauche (interview, présentation)."""
    img = ctx.blank()
    accent = _p(ctx, "accent", "#FF2D55")
    name, sub = _text_param(ctx, "Prénom Nom"), str(_p(ctx, "subtitle", "Fonction"))
    y = _p(ctx, "y", 0.80)
    bar = prog(t, 0, 0.45, "out") - prog(t, ctx.duration - 0.45, ctx.duration, "in")
    txt = prog(t, 0.25, 0.7, "out") - prog(t, ctx.duration - 0.6, ctx.duration - 0.15, "in")
    x0, w = 0.06, 0.55 if ctx.w > ctx.h else 0.75
    img = ctx.rect(img, (x0, y - 0.045, x0 + 0.012, y + 0.05), color=accent, alpha=min(1, bar * 2))
    img = ctx.rect(img, (x0 + 0.018, y - 0.045, x0 + 0.018 + w * bar, y + 0.05), color=(0, 0, 0, 170), radius=0.1)
    tx = x0 + 0.04 - (1 - txt) * 0.05
    img = ctx.text(img, name, (tx, y - 0.012), size=0.042, anchor="ls", alpha=txt, color="white")
    return ctx.text(img, sub, (tx, y + 0.032), size=0.03, anchor="ls", alpha=txt, color=accent, bold=False)


def counter(t, ctx: Ctx):
    """Compteur animé : from → to (ex. 0 → 10000 clients), préfixe/suffixe, séparateur de milliers."""
    img = ctx.blank()
    a, b = float(_p(ctx, "from", 0.0)), float(_p(ctx, "to", 100.0))
    p = prog(t, 0.1, max(0.2, ctx.duration - 0.6), "out")
    v = a + (b - a) * p
    decimals = int(_p(ctx, "decimals", 0))
    s = f"{v:,.{decimals}f}".replace(",", " ")
    label = f"{_p(ctx, 'prefix', '')}{s}{_p(ctx, 'suffix', '')}"
    bump = 1 + 0.08 * math.sin(min(1, p) * math.pi) if p < 1 else 1 + 0.1 * prog(t, ctx.duration - 0.6, ctx.duration - 0.4, "out_back") * (1 - prog(t, ctx.duration - 0.4, ctx.duration - 0.2))
    final = f"{_p(ctx, 'prefix', '')}{f'{b:,.{decimals}f}'.replace(',', ' ')}{_p(ctx, 'suffix', '')}"
    size = ctx.fit(final, _p(ctx, "size", 0.12), 0.82)
    img = ctx.text(img, label, (_p(ctx, "x", 0.5), _p(ctx, "y", 0.45)), size=size, max_width=None,
                   color=_p(ctx, "color", "white"), scale=bump, stroke=0.05, alpha=in_out(t, ctx.duration, 0.15, 0.2))
    caption = str(_p(ctx, "label", ""))
    if caption:
        img = ctx.text(img, caption, (_p(ctx, "x", 0.5), _p(ctx, "y", 0.45) + _p(ctx, "size", 0.12) * 0.8), size=0.04,
                       color=_p(ctx, "accent", "yellow"), alpha=prog(t, 0.3, 0.7) * in_out(t, ctx.duration, 0.1, 0.2))
    return img


# ------------------------------------------------------------------ éléments graphiques


def cta(t, ctx: Ctx):
    """Bouton d'appel à l'action qui pulse (« Acheter maintenant », « Lien en bio »…)."""
    img = ctx.blank()
    label = _text_param(ctx, "Acheter maintenant")
    color = _p(ctx, "color", "#FF2D55")
    enter = prog(t, 0, 0.5, "out_back")
    pulse = 1 + 0.05 * math.sin(max(0.0, t - 0.5) * 2 * math.pi * 1.6) if t > 0.5 else 1
    s = enter * pulse
    cx, cy = _p(ctx, "x", 0.5), _p(ctx, "y", 0.78)
    tsize = ctx.fit(label, 0.034, 0.7)
    tw, th = ctx.measure(label, tsize)
    bw = (tw / ctx.w + 0.12) * s
    bh = (th / ctx.h + 0.04) * s
    a = in_out(t, ctx.duration, 0.1, 0.25)
    img = ctx.rect(img, (cx - bw / 2, cy - bh / 2 + 0.008, cx + bw / 2, cy + bh / 2 + 0.008), color=(0, 0, 0, 120),
                   radius=0.5, alpha=a)
    img = ctx.rect(img, (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2), color=color, radius=0.5, alpha=a)
    shine = (t * 0.7) % 1.6 - 0.3  # reflet qui balaie le bouton
    if 0 < shine < 1:
        sx = cx - bw / 2 + shine * bw
        img = ctx.polygon(img, [(sx, cy - bh / 2), (sx + 0.03, cy - bh / 2), (sx + 0.01, cy + bh / 2),
                                (sx - 0.02, cy + bh / 2)], color=(255, 255, 255, 70), alpha=a)
    return ctx.text(img, label, (cx, cy), size=tsize * s, color=_p(ctx, "text_color", "white"), alpha=a, max_width=None)


def progress(t, ctx: Ctx):
    """Barre de progression (rétention sur Shorts/Reels), en haut ou en bas."""
    img = ctx.blank()
    top = _p(ctx, "position", "top") == "top"
    hgt = _p(ctx, "thickness", 0.008)
    y0 = 0.0 if top else 1 - hgt
    p = prog(t, 0, ctx.duration, "linear")
    img = ctx.rect(img, (0, y0, 1, y0 + hgt), color=(255, 255, 255, 60))
    return ctx.rect(img, (0, y0, max(0.0005, p), y0 + hgt), color=_p(ctx, "color", "#FF2D55"))


def logo(t, ctx: Ctx):
    """Apparition de logo : zoom avec rebond, halo, reflet ; path = image PNG (transparente de préférence)."""
    img = ctx.blank()
    path = _p(ctx, "path", None)
    if not path:
        raise ValueError("logo : paramètre path=<image.png> requis")
    pop = prog(t, 0, 0.6, "out_back")
    a = in_out(t, ctx.duration, 0.25, 0.35)
    img = ctx.paste(img, path, (_p(ctx, "x", 0.5), _p(ctx, "y", 0.5)), scale=_p(ctx, "width", 0.4) * (0.6 + 0.4 * pop),
                    alpha=a)
    if _p(ctx, "glow", True):
        img = ctx.glow(img, 0.015, 0.8 * prog(t, 0.3, 0.8) * a)
    text = str(_p(ctx, "text", ""))
    if text:
        img = ctx.text(img, text.replace("\\n", "\n"), (_p(ctx, "x", 0.5), _p(ctx, "y", 0.5) + 0.16), size=0.045,
                       alpha=prog(t, 0.45, 0.9) * a, color=_p(ctx, "color", "white"))
    return img


def confetti(t, ctx: Ctx):
    """Explosion de confettis (déterministe : seed=…)."""
    img = ctx.blank()
    rng = random.Random(int(_p(ctx, "seed", 7)))
    n = int(_p(ctx, "count", 140))
    colors = ["#FF2D55", "#FFE600", "#2DFF6E", "#2D7BFF", "#FF8A00", "#FFFFFF", "#8B5CFF"]
    ox, oy = _p(ctx, "x", 0.5), _p(ctx, "y", 0.6)
    fade = 1 - prog(t, ctx.duration - 0.6, ctx.duration)
    aspect = ctx.h / ctx.w
    for _ in range(n):
        ang = rng.uniform(-math.pi * 0.95, -math.pi * 0.05)
        sp = rng.uniform(0.6, 1.6)
        vx, vy = math.cos(ang) * sp * 0.55 * aspect, math.sin(ang) * sp
        g = 1.6
        drag = math.exp(-1.2 * t)
        x = ox + vx * (1 - drag) / 1.2
        y = oy + vy * (1 - drag) / 1.2 + 0.5 * g * t * t * 0.35
        if not (-0.05 < x < 1.05 and -0.05 < y < 1.05):
            continue
        size = rng.uniform(0.006, 0.013)
        spin = rng.uniform(-8, 8) * t
        w = size * abs(math.cos(spin)) + 0.002
        col = rng.choice(colors)
        img = ctx.polygon(img, [(x - w * aspect, y - size), (x + w * aspect, y - size), (x + w * aspect, y + size),
                                (x - w * aspect, y + size)], color=col, alpha=fade)
    return img


def circle_highlight(t, ctx: Ctx):
    """Cercle « dessiné à la main » autour d'un élément (x, y, r en fractions)."""
    img = ctx.blank()
    p = prog(t, 0, _p(ctx, "draw", 0.6), "in_out")
    a = 1 - prog(t, ctx.duration - 0.3, ctx.duration)
    start = -100
    return ctx.circle(img, (_p(ctx, "x", 0.5), _p(ctx, "y", 0.5)), _p(ctx, "r", 0.12), outline=_p(ctx, "color", "#FF2D2D"),
                      width=_p(ctx, "width", 0.012), start=start, end=start + 370 * p, alpha=a)


def arrow(t, ctx: Ctx):
    """Flèche qui arrive et pointe une cible (x, y), avec petit rebond."""
    img = ctx.blank()
    tx, ty = _p(ctx, "x", 0.5), _p(ctx, "y", 0.5)
    ang = math.radians(float(_p(ctx, "angle", 225)))  # direction d'où vient la flèche
    length = _p(ctx, "length", 0.18)
    p = prog(t, 0, 0.45, "out_back")
    bob = 0.012 * math.sin(max(0.0, t - 0.45) * 2 * math.pi * 1.5) if t > 0.45 else 0
    aspect = ctx.h / ctx.w
    dx, dy = math.cos(ang) * aspect, math.sin(ang)
    tip = (tx + dx * (0.02 + bob + (1 - p) * 0.3), ty + dy * (0.02 + bob + (1 - p) * 0.3))
    tail = (tip[0] + dx * length, tip[1] + dy * length)
    a = 1 - prog(t, ctx.duration - 0.3, ctx.duration)
    col = _p(ctx, "color", "#FFE600")
    img = ctx.line(img, [tail, tip], color=col, width=0.014, alpha=a)
    hx, hy = math.cos(ang + 0.5) * 0.045, math.sin(ang + 0.5) * 0.045
    kx, ky = math.cos(ang - 0.5) * 0.045, math.sin(ang - 0.5) * 0.045
    return ctx.polygon(img, [tip, (tip[0] + hx * aspect, tip[1] + hy), (tip[0] + kx * aspect, tip[1] + ky)], color=col,
                       alpha=a)


PRESETS = {
    "title": (title, "titre qui apparaît en pop avec rebond", "text color size x y stroke"),
    "slide": (slide, "texte qui glisse depuis un bord", "text dir=left|right|top|bottom color size x y"),
    "typewriter": (typewriter, "machine à écrire avec curseur", "text speed color size x y"),
    "kinetic": (kinetic, "typo cinétique mot par mot, *mot* en surbrillance", "text accent per_word color size y"),
    "lower_third": (lower_third, "bandeau nom + fonction", "text subtitle accent y"),
    "counter": (counter, "compteur animé (chiffres clés)", "from to prefix suffix decimals label color accent size x y"),
    "cta": (cta, "bouton d'appel à l'action qui pulse", "text color text_color x y"),
    "progress": (progress, "barre de progression", "position=top|bottom color thickness"),
    "logo": (logo, "révélation de logo (zoom, halo)", "path width text color glow x y"),
    "confetti": (confetti, "explosion de confettis", "count seed x y"),
    "circle_highlight": (circle_highlight, "cercle dessiné autour d'un élément", "x y r color width draw"),
    "arrow": (arrow, "flèche qui pointe une cible", "x y angle length color"),
}


def preset_frame(name: str):
    if name not in PRESETS:
        raise ValueError(f"Animation inconnue « {name} ». Disponibles : {', '.join(PRESETS)}")
    return PRESETS[name][0]


__all__ = ["PRESETS", "preset_frame", "Image"]
