"""Sous-titres animés façon TikTok / Reels : groupes de 1 à 4 mots, mot prononcé mis en avant.

Source des mots horodatés : le rapport de `cutkiller listen --transcribe` (<vidéo>.listen.json, clé "words"),
ou une transcription faite à la volée. Rendu via libass (même gravure que `cutkiller text`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from cutkiller.edit.text import _ass_color, _ass_time, _escape
from cutkiller.listen.transcribe import Word

STYLES = {
    # nom : (mots max par groupe, majuscules, couleur active, pop (zoom du mot actif), taille % hauteur, position)
    "tiktok": (3, True, "yellow", 118, 6.5, "lower"),
    "bold": (2, True, "green", 125, 8.0, "lower"),
    "karaoke": (6, False, "cyan", 100, 5.0, "bottom"),
    "minimal": (5, False, "white", 100, 4.5, "bottom"),
}
ALIGN = {"bottom": 2, "lower": 2, "center": 5, "top": 8}
MARGIN_V = {"bottom": 0.12, "lower": 0.28, "center": 0.0, "top": 0.10}  # "lower" ≈ 70 % de la hauteur : zone TikTok


@dataclass
class Group:
    words: list[Word]

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end


def load_words(path: str | Path) -> list[Word]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    raw = data.get("words") if isinstance(data, dict) else data
    if not raw:
        raise ValueError(f"Aucun mot horodaté dans {path} : lance d'abord « cutkiller listen <vidéo> --transcribe ».")
    return [Word(float(w["start"]), float(w["end"]), str(w["text"]).strip()) for w in raw if str(w["text"]).strip()]


def group_words(words: list[Word], max_words: int = 3, max_chars: int = 18, max_gap: float = 0.45,
                skip_fillers: bool = True) -> list[Group]:
    groups: list[Group] = []
    cur: list[Word] = []
    for w in words:
        if skip_fillers and w.is_filler:
            continue
        text_len = len(" ".join(x.text for x in cur + [w]))
        punct_break = bool(cur) and cur[-1].text.rstrip()[-1:] in ".!?,;:"
        if cur and (len(cur) >= max_words or text_len > max_chars or w.start - cur[-1].end > max_gap or punct_break):
            groups.append(Group(cur))
            cur = []
        cur.append(w)
    if cur:
        groups.append(Group(cur))
    return groups


def build_captions_ass(words: list[Word], width: int, height: int, *, style: str = "tiktok", color: str = "white",
                       active: str | None = None, size: float | None = None, position: str | None = None,
                       font: str = "Arial", max_words: int | None = None) -> str:
    n_max, upper, active_default, pop, size_default, pos_default = STYLES[style]
    size = size or size_default
    position = position or pos_default
    active_c = _ass_color(active or active_default)
    base_c = _ass_color(color)
    fs = round(height * size / 100)
    mv = round(height * MARGIN_V[position])
    header = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,"
        "StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
        f"Style: Cap,{font},{fs},{base_c},{active_c},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,"
        f"{max(2, round(fs / 9))},{max(1, round(fs / 18))},{ALIGN[position]},{round(width * 0.07)},{round(width * 0.07)},{mv},1",
        "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ]
    lines = []
    groups = group_words(words, max_words or n_max)
    for gi, g in enumerate(groups):
        nxt = groups[gi + 1].start if gi + 1 < len(groups) else g.end + 0.4
        g_end = min(max(g.end, g.start + 0.25), nxt)
        if style == "karaoke":  # balayage progressif de couleur (\kf, centièmes de seconde)
            parts = []
            for i, w in enumerate(g.words):
                nxt_w = g.words[i + 1].start if i + 1 < len(g.words) else g_end
                parts.append(f"{{\\kf{max(1, round((nxt_w - w.start) * 100))}}}{_escape(w.text)}")
            text = " ".join(parts)
            lines.append(f"Dialogue: 0,{_ass_time(g.start)},{_ass_time(g_end)},Cap,,0,0,0,,{{\\fad(80,80)}}{text}")
            continue
        for i, w in enumerate(g.words):  # un événement par mot : le mot actif change de couleur et grossit
            s = w.start if i else g.start
            e = g.words[i + 1].start if i + 1 < len(g.words) else g_end
            if e <= s:
                continue
            chunks = []
            for j, x in enumerate(g.words):
                t = _escape(x.text.upper() if upper else x.text)
                if j == i:
                    if pop > 100:
                        t = (f"{{\\c{active_c}\\fscx{pop}\\fscy{pop}\\t(0,90,\\fscx100\\fscy100)}}{t}"
                             f"{{\\c{base_c}\\fscx100\\fscy100}}")
                    else:
                        t = f"{{\\c{active_c}}}{t}{{\\c{base_c}}}"
                chunks.append(t)
            intro = "{\\fad(60,0)}" if i == 0 else ""
            lines.append(f"Dialogue: 0,{_ass_time(s)},{_ass_time(e)},Cap,,0,0,0,,{intro}{' '.join(chunks)}")
    return "\n".join(header + lines) + "\n"
