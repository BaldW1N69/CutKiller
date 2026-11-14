"""Texte incrusté : accroches, prix, appels à l'action, sous-titres style réseaux sociaux.

On génère un fichier ASS (libass) puis on le grave avec le filtre `ass` de ffmpeg. Le filtre est
lancé depuis le dossier du fichier ASS avec un chemin relatif : ça évite tous les problèmes
d'échappement des chemins Windows (`C:\\...`) dans les filtres ffmpeg.
"""

from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from cutkiller.media import probe, run_ffmpeg

ALIGN = {"bottom": 2, "center": 5, "top": 8}
COLORS = {"white": "FFFFFF", "black": "000000", "yellow": "FFE600", "red": "FF2D2D", "green": "2DFF6E",
          "blue": "2D7BFF", "orange": "FF8A00", "pink": "FF4FB8", "cyan": "00E5FF"}


@dataclass
class Cue:
    text: str
    start: float
    end: float | None = None  # None = jusqu'à la fin de la vidéo
    position: str = "bottom"
    color: str | None = None
    size: float | None = None  # % de la hauteur de l'image


def parse_cue(spec: str) -> Cue:
    """'SOLDES -50 %@0-3' · 'Code PUB10@5-:center' · 'Abonne-toi@8.5-12:bottom:yellow'."""
    if "@" not in spec:
        raise ValueError(f"Texte invalide « {spec} » : format attendu « texte@début-fin[:position[:couleur]] »")
    text, _, rest = spec.rpartition("@")
    timing, *opts = rest.split(":")
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)?\s*", timing)
    if not m:
        raise ValueError(f"Durée invalide « {timing} » dans « {spec} » (ex. 0-3, 5-, 2.5-6)")
    start, end = float(m.group(1)), (float(m.group(2)) if m.group(2) else None)
    if end is not None and end <= start:
        raise ValueError(f"La fin doit être après le début dans « {spec} »")
    cue = Cue(text.replace("\\n", "\n"), start, end)
    for o in opts:
        o = o.strip().lower()
        if o in ALIGN:
            cue.position = o
        elif o in COLORS or re.fullmatch(r"#?[0-9a-f]{6}", o):
            cue.color = o
        elif o.endswith("%") and o[:-1].replace(".", "", 1).isdigit():
            cue.size = float(o[:-1])
        else:
            raise ValueError(f"Option inconnue « {o} » dans « {spec} » (position, couleur ou taille en %)")
    return cue


def parse_srt(text: str) -> list[Cue]:
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = [ln for ln in block.split("\n") if ln.strip()]
        for i, ln in enumerate(lines):
            m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)", ln)
            if m:
                g = [int(x) for x in m.groups()]
                start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
                end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
                body = "\n".join(lines[i + 1:])
                if body:
                    cues.append(Cue(body, start, end))
                break
    return cues


def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_color(c: str | None, default: str = "FFFFFF") -> str:
    hexa = COLORS.get((c or "").lower(), (c or default).lstrip("#")).upper()
    r, g, b = hexa[0:2], hexa[2:4], hexa[4:6]
    return f"&H00{b}{g}{r}"  # ASS = BGR


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(cues: list[Cue], width: int, height: int, duration: float, *, size: float = 6.0, color: str = "white",
              outline: float = 0.6, font: str = "Arial", bold: bool = True, box: bool = False,
              fade: float = 0.15) -> str:
    """Un style par (position, couleur, taille) ; marges de 6 % pour rester dans la zone sûre des réseaux."""
    styles: dict[tuple, str] = {}
    lines = []
    for c in cues:
        key = (c.position, c.color or color, c.size or size)
        if key not in styles:
            styles[key] = f"S{len(styles)}"
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,"
        "StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ]
    for (pos, col, sz), name in styles.items():
        fs = round(height * sz / 100)
        mv = round(height * (0.10 if pos == "bottom" else 0.08 if pos == "top" else 0))
        style = 3 if box else 1
        back = "&H99000000" if box else "&H00000000"
        header.append(
            f"Style: {name},{font},{fs},{_ass_color(col)},&H000000FF,&H00000000,{back},{-1 if bold else 0},0,0,0,100,100,0,0,"
            f"{style},{max(1, round(fs * outline / 6)) if not box else 8},0,{ALIGN[pos]},{round(width * 0.06)},{round(width * 0.06)},{mv},1")
    lines += ["", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"]
    f_ms = int(fade * 1000)
    for c in cues:
        end = min(c.end if c.end is not None else duration, duration)
        if c.start >= duration or end <= c.start:
            continue
        name = styles[(c.position, c.color or color, c.size or size)]
        fx = f"{{\\fad({f_ms},{f_ms})}}" if f_ms and end - c.start > 2 * fade else ""
        lines.append(f"Dialogue: 0,{_ass_time(c.start)},{_ass_time(end)},{name},,0,0,0,,{fx}{_escape(c.text)}")
    return "\n".join(header + lines) + "\n"


def font_family(font: str | None) -> tuple[str | None, Path | None]:
    """Nom de police OU fichier .ttf/.otf (ex. téléchargé sur Fontshare) → (famille pour l'ASS, fichier à charger)."""
    if not font:
        return font, None
    p = Path(font).expanduser()
    if p.suffix.lower() in (".ttf", ".otf", ".ttc") or p.exists():
        if not p.exists():
            raise ValueError(f"Police introuvable : {p}")
        from PIL import ImageFont

        family = ImageFont.truetype(str(p), 12).getname()[0]
        return family, p.resolve()
    return font, None


def burn_ass(src: str | Path, dst: str | Path, ass: str, *, crf: int = 18, font_file: str | Path | None = None) -> Path:
    """Grave un script ASS (texte, sous-titres, animations libass) sur la vidéo.
    `font_file` : police .ttf/.otf non installée à charger en plus de celles du système."""
    src, dst = Path(src).resolve(), Path(dst).resolve()
    info = probe(src)
    if not info.has_video:
        raise ValueError(f"{src} n'a pas de piste vidéo.")
    with tempfile.TemporaryDirectory(prefix="cutkiller_text_") as tmp:
        (Path(tmp) / "cues.ass").write_text(ass, encoding="utf-8")
        vf = "ass=cues.ass"
        if font_file:
            import shutil

            fdir = Path(tmp) / "fonts"  # copie locale : pas d'échappement de chemin dans le filtre ffmpeg
            fdir.mkdir()
            shutil.copy2(font_file, fdir / Path(font_file).name)
            vf += ":fontsdir=fonts"
        args = ["-i", str(src), "-vf", vf, "-c:v", "libx264", "-crf", str(crf), "-preset", "veryfast",
                "-pix_fmt", "yuv420p"]
        args += ["-c:a", "copy"] if info.has_audio else ["-an"]
        if dst.suffix.lower() in {".mp4", ".mov", ".m4a"}:
            args += ["-movflags", "+faststart"]
        run_ffmpeg(args + [str(dst)], cwd=tmp)
    return dst


def burn_text(src: str | Path, dst: str | Path, cues: list[Cue], *, crf: int = 18, **style) -> Path:
    if not cues:
        raise ValueError("Aucun texte à incruster.")
    info = probe(src)
    family, font_file = font_family(style.get("font"))
    if family:
        style["font"] = family
    ass = build_ass(cues, info.width or 1080, info.height or 1920, info.duration, **style)
    return burn_ass(src, dst, ass, crf=crf, font_file=font_file)
