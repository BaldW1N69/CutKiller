"""Textures « qui font cher » : grain argentique, grain scanné, rendu rétro tramé (dither), vignettage.

- grain       : grain procédural sur la luminance, renouvelé à chaque image (aucun fichier requis) ;
- grain_file  : vraie pellicule scannée (Super 8, 16 mm, poussières, rayures, burns) posée en mode
                fusion — c'est ce que vendent/donnent les packs type Film Looks. Fond gris 50 % → overlay
                ou softlight ; fond noir (poussières, light leaks) → screen. Bouclée sur toute la vidéo ;
- dither      : palette réduite + trame (bayer = trame ordonnée rétro, floyd_steinberg = diffusion),
                pixels agrandis en option : le look « Ditherboy » / jeu vidéo / imprimé ;
- vignette    : assombrit les bords.

Ordre appliqué : dither → grain → grain scanné → vignette (le grain passe par-dessus la trame,
comme une pellicule filmée).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cutkiller.media import probe, run_ffmpeg

DITHERS = ("bayer", "floyd_steinberg", "sierra2_4a", "heckbert", "none")
BLENDS = ("overlay", "softlight", "screen", "multiply", "addition")


@dataclass
class TextureSettings:
    grain: float = 0.0  # 0..1 (0.25 = discret, 0.5 = marqué)
    grain_file: Path | None = None
    grain_mode: str = "overlay"
    grain_opacity: float = 0.6
    dither: str | None = None
    colors: int = 16
    pixel: int = 1  # taille d'un « pixel » de la trame (1 = résolution native)
    vignette: float = 0.0  # 0..1

    def validate(self) -> None:
        if not 0 <= self.grain <= 1:
            raise ValueError("--grain attend une valeur entre 0 et 1")
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
        if not (self.grain or self.grain_file or self.dither or self.vignette):
            raise ValueError("Aucune texture demandée : --grain, --grain-file, --dither ou --vignette")


def build_texture_filter(s: TextureSettings, w: int, h: int) -> tuple[str, list[list[str]]]:
    """(filter_complex de [0:v] vers [vout], entrées supplémentaires)."""
    w, h = w - w % 2, h - h % 2
    parts: list[str] = []
    inputs: list[list[str]] = []
    cur = "[0:v]"

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
