"""Finition « qui fait cher » : étalonnage, lueur, netteté, grain argentique, grain scanné, dither, vignettage,
bandes cinéma.

- grade       : étalonnage (teal_orange, green_orange, warm, cold, bleach, bw) ;
- contrast    : noirs plus profonds, contraste plus marqué (0..1) ;
- sharpen     : netteté (le « 4K » des applis) ;
- glow        : lueur autour des hautes lumières (« luminescence ») ;

- grain       : grain procédural sur la luminance, renouvelé à chaque image (aucun fichier requis) ;
- grain_file  : vraie pellicule scannée (Super 8, 16 mm, poussières, rayures, burns) posée en mode
                fusion — c'est ce que vendent/donnent les packs type Film Looks. Fond gris 50 % → overlay
                ou softlight ; fond noir (poussières, light leaks) → screen. Bouclée sur toute la vidéo ;
- dither      : palette réduite + trame (bayer = trame ordonnée rétro, floyd_steinberg = diffusion),
                pixels agrandis en option : le look « Ditherboy » / jeu vidéo / imprimé ;
- vignette    : assombrit les bords ;
- letterbox   : bandes noires au format cinéma (2.39, 2.0, 1.85…).

Ordre appliqué : étalonnage → contraste → netteté → lueur → dither → grain → grain scanné → vignette →
bandes (le grain passe par-dessus l'image comme sur une pellicule ; les bandes restent noires et nettes).
Préréglages `LOOKS` (look cinématique des tutos CapCut : vert-orange + 4K + luminescence, noirs profonds).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cutkiller.media import probe, run_ffmpeg

DITHERS = ("bayer", "floyd_steinberg", "sierra2_4a", "heckbert", "none")
BLENDS = ("overlay", "softlight", "screen", "multiply", "addition")

# ombres → hautes lumières : colorbalance (s = ombres, m = tons moyens, h = hautes lumières), saturation
GRADES = {
    "teal_orange": "colorbalance=rs=-0.08:bs=0.10:rh=0.10:gh=0.02:bh=-0.10,eq=saturation=1.12",
    "green_orange": "colorbalance=rs=-0.06:gs=0.06:bs=-0.02:rh=0.10:gh=0.03:bh=-0.10,eq=saturation=1.08",
    "warm": "colorbalance=rm=0.07:gm=0.02:bm=-0.07:rh=0.04:bh=-0.04",
    "cold": "colorbalance=rm=-0.05:bm=0.07:bs=0.04",
    "bleach": "eq=saturation=0.55:contrast=1.15",
    "bw": "hue=s=0,eq=contrast=1.12",
}

LOOKS: dict[str, dict] = {
    "cinematic": {"grade": "teal_orange", "contrast": 0.4, "sharpen": 0.3, "glow": 0.25, "grain": 0.15, "vignette": 0.3},
    "night": {"grade": "green_orange", "contrast": 0.55, "sharpen": 0.4, "glow": 0.5},
    "film": {"grade": "warm", "contrast": 0.2, "glow": 0.15, "grain": 0.35, "vignette": 0.4},
    "noir": {"grade": "bw", "contrast": 0.5, "grain": 0.3, "vignette": 0.5},
    "retro": {"dither": "bayer", "colors": 16, "pixel": 3, "grain": 0.2},
}


@dataclass
class TextureSettings:
    grade: str | None = None
    contrast: float = 0.0  # 0..1
    sharpen: float = 0.0  # 0..1
    glow: float = 0.0  # 0..1
    letterbox: float | None = None  # rapport largeur/hauteur de l'image utile (2.39 = scope)
    grain: float = 0.0  # 0..1 (0.25 = discret, 0.5 = marqué)
    grain_file: Path | None = None
    grain_mode: str = "overlay"
    grain_opacity: float = 0.6
    dither: str | None = None
    colors: int = 16
    pixel: int = 1  # taille d'un « pixel » de la trame (1 = résolution native)
    vignette: float = 0.0  # 0..1

    def validate(self) -> None:
        for name in ("grain", "contrast", "sharpen", "glow", "vignette"):
            if not 0 <= getattr(self, name) <= 1:
                raise ValueError(f"--{name} attend une valeur entre 0 et 1")
        if self.grade and self.grade not in GRADES:
            raise ValueError(f"--grade : {', '.join(GRADES)}")
        if self.letterbox is not None and not 1.0 < self.letterbox <= 4.0:
            raise ValueError("--letterbox attend un rapport entre 1 et 4 (ex. 2.39)")
        if self.grain_mode not in BLENDS:
            raise ValueError(f"--grain-mode : {', '.join(BLENDS)}")
        if self.dither and self.dither not in DITHERS:
            raise ValueError(f"--dither : {', '.join(DITHERS)}")
        if not 2 <= self.colors <= 256:
            raise ValueError("--colors attend 2 à 256")
        if self.pixel < 1:
            raise ValueError("--pixel attend un entier ≥ 1")
        if self.grain_file and not Path(self.grain_file).exists():
            raise ValueError(f"Grain introuvable : {self.grain_file}")
        if not (self.grain or self.grain_file or self.dither or self.vignette or self.grade or self.contrast
                or self.sharpen or self.glow or self.letterbox):
            raise ValueError("Aucun effet demandé : --look, --grade, --contrast, --sharpen, --glow, --grain, "
                             "--grain-file, --dither, --vignette ou --letterbox")


def build_texture_filter(s: TextureSettings, w: int, h: int) -> tuple[str, list[list[str]]]:
    """(filter_complex de [0:v] vers [vout], entrées supplémentaires)."""
    w, h = w - w % 2, h - h % 2
    parts: list[str] = []
    inputs: list[list[str]] = []
    cur = "[0:v]"

    pre = []
    if s.grade:
        pre.append(GRADES[s.grade])
    if s.contrast:
        pre.append(f"eq=contrast={1 + 0.3 * s.contrast:.3f}:brightness={-0.03 * s.contrast:.3f}")
    if s.sharpen:
        pre.append(f"unsharp=5:5:{0.3 + 1.2 * s.sharpen:.2f}:5:5:0")
    if pre:
        parts.append(f"{cur}{','.join(pre)}[pre]")
        cur = "[pre]"

    if s.glow:
        sigma = max(2.0, h * 0.012)
        parts.append(f"{cur}format=gbrp,split[gA][gB]")
        parts.append(f"[gB]curves=all='0/0 0.55/0 1/1',gblur=sigma={sigma:.1f}[gH]")  # hautes lumières floutées
        parts.append(f"[gA][gH]blend=all_mode=screen:all_opacity={min(1.0, 0.25 + 0.75 * s.glow):.3f},format=yuv420p[glw]")
        cur = "[glw]"

    if s.dither:
        sw, sh = max(2, w // s.pixel), max(2, h // s.pixel)
        bayer = ":bayer_scale=2" if s.dither == "bayer" else ""
        parts.append(f"{cur}scale={sw}:{sh}:flags=area,split[dA][dB]")
        parts.append(f"[dA]palettegen=max_colors={s.colors}:stats_mode=single:reserve_transparent=0[dP]")
        parts.append(f"[dB][dP]paletteuse=dither={s.dither}{bayer}:new=1,scale={w}:{h}:flags=neighbor,"
                     f"format=yuv420p[dith]")
        cur = "[dith]"

    if s.grain:
        strength = int(round(4 + s.grain * 36))  # 0.25 → 13, 0.5 → 22, 1 → 40
        parts.append(f"{cur}format=yuv420p,noise=c0s={strength}:c0f=t+u[grn]")
        cur = "[grn]"

    if s.grain_file:
        inputs.append(["-stream_loop", "-1", "-i", str(s.grain_file)])
        parts.append(f"[1:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1,format=gbrp[gf]")
        parts.append(f"{cur}scale={w}:{h},setsar=1,format=gbrp[gb]")
        parts.append(f"[gb][gf]blend=all_mode={s.grain_mode}:all_opacity={s.grain_opacity:.3f}:shortest=1,"
                     f"format=yuv420p[gfo]")
        cur = "[gfo]"

    if s.vignette:
        angle = 0.2 + 0.5 * s.vignette  # radians : plus grand = bords plus sombres
        parts.append(f"{cur}vignette=angle={angle:.3f}[vig]")
        cur = "[vig]"

    if s.letterbox and w / s.letterbox < h:
        bar = int(round((h - w / s.letterbox) / 2))
        bar -= bar % 2
        if bar > 0:
            parts.append(f"{cur}drawbox=x=0:y=0:w=iw:h={bar}:color=black:t=fill,"
                         f"drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:color=black:t=fill[lbx]")
            cur = "[lbx]"

    parts.append(f"{cur}format=yuv420p[vout]")
    return ";\n".join(parts), inputs


def render_texture(src: str | Path, dst: str | Path, s: TextureSettings, *, crf: int = 18) -> Path:
    s.validate()
    info = probe(src)
    if not info.has_video:
        raise ValueError(f"{src} n'a pas de piste vidéo.")
    graph, extra = build_texture_filter(s, info.width or 1080, info.height or 1920)
    dst = Path(dst)
    args = ["-i", str(src)]
    for inp in extra:
        args += inp
    args += ["-filter_complex", graph, "-map", "[vout]"]
    if info.has_audio:
        args += ["-map", "0:a:0", "-c:a", "copy"]
    args += ["-c:v", "libx264", "-crf", str(crf), "-preset", "veryfast", "-t", f"{info.duration:.3f}"]
    if dst.suffix.lower() in {".mp4", ".mov"}:
        args += ["-movflags", "+faststart"]
    run_ffmpeg(args + [str(dst)])
    return dst
