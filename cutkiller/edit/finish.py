"""Finition appliquée dans le graphe du rendu principal : look (texture), texte et sous-titres gravés.

Avant, `texture`, `text` et `captions` étaient des commandes séparées : chacune réencodait toute la vidéo
(une génération de pertes et un encodage complet de plus par étape). Ici, tout se fait dans l'unique
encodage du montage.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cutkiller.edit.texture import TextureSettings, build_texture_filter


@dataclass
class Finish:
    texture: TextureSettings | None = None
    ass: str | list[str] | None = None  # script(s) ASS complets (textes, sous-titres), calés sur la vidéo finale
    font_file: Path | None = None  # police non installée, chargée par libass

    def __bool__(self) -> bool:
        return bool(self.texture or self.ass)


def append_finish(parts: list[str], src: str, out: str, finish: Finish, width: int, height: int,
                  first_input: int, workdir: Path) -> list[list[str]]:
    """Ajoute la finition de `src` vers `out` dans `parts` ; renvoie les entrées supplémentaires.

    Le script ASS est écrit dans `workdir` et référencé par un nom relatif : le rendu doit s'exécuter avec
    `cwd=workdir` (pas d'échappement de chemin Windows dans le filtre)."""
    inputs: list[list[str]] = []
    cur = src
    if finish.texture:
        finish.texture.validate()
        graph, inputs = build_texture_filter(finish.texture, width, height, src=cur, out="[fin_tex]",
                                             first_input=first_input)
        parts.append(graph)
        cur = "[fin_tex]"
    scripts = [finish.ass] if isinstance(finish.ass, str) else list(finish.ass or [])
    fontsdir = ""
    if scripts and finish.font_file:
        import shutil

        fonts = workdir / "fonts"
        fonts.mkdir(exist_ok=True)
        shutil.copy2(finish.font_file, fonts / Path(finish.font_file).name)
        fontsdir = ":fontsdir=fonts"
    for k, script in enumerate(scripts):
        (workdir / f"finish{k}.ass").write_text(script, encoding="utf-8")
        parts.append(f"{cur}ass=finish{k}.ass{fontsdir}[fin_ass{k}]")
        cur = f"[fin_ass{k}]"
    parts.append(f"{cur}null{out}")
    return inputs


def remap_words(words, segments) -> list:
    """Mots horodatés dans la source → temps de la vidéo montée (segments gardés mis bout à bout).
    Un mot coupé par un montage est rogné ; un mot entièrement retiré disparaît."""
    from cutkiller.listen.transcribe import Word

    out, offset = [], 0.0
    bounds = []
    for s in segments:
        bounds.append((s.start, s.end, offset))
        offset += s.end - s.start
    for w in words:
        for a, b, off in bounds:
            lo, hi = max(w.start, a), min(w.end, b)
            if hi - lo > 0.04 or (a <= w.start < b and hi > lo):
                out.append(Word(round(lo - a + off, 3), round(hi - a + off, 3), w.text))
                break
    return out
