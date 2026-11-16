"""« Jump cut fix » : alternance d'échelle à chaque coupe, micro-rampe de 3 images à cheval sur la coupe."""

import subprocess

import numpy as np

from cutkiller.cli import main
from cutkiller.edit.timeline import Join, _zoom_expr, punch_zooms
from cutkiller.media import probe
from cutkiller.transitions import resolve


def _eval(expr: str, n: int) -> float:
    """Évalue l'expression zoompan pour l'image n (if/gte/lt seulement)."""
    py = expr.replace("in", str(n))
    py = py.replace("if(", "_if(").replace("gte(", "_gte(").replace("lt(", "_lt(")
    return eval(py, {"_if": lambda c, a, b: a if c else b, "_gte": lambda a, b: a >= b, "_lt": lambda a, b: a < b})


def test_zoom_ramp_straddles_the_cut():
    # clip A (1.0, 10 images) → clip B (1.3) : 2/3 de la rampe avant la coupe… version 3 images : A[9]=1/3, B[0]=2/3
    a = _zoom_expr(1.0, None, 1.3, 10, 3)
    b = _zoom_expr(1.3, 1.0, None, 10, 3)
    assert [round(_eval(a, n), 3) for n in (7, 8, 9)] == [1.0, 1.0, 1.1]
    assert [round(_eval(b, n), 3) for n in (0, 1, 5)] == [1.2, 1.3, 1.3]
    assert _zoom_expr(1.15, 1.15, 1.15, 10, 3) == "1.1500"  # pas de changement : pas de rampe
    assert _zoom_expr(1.0, None, 1.3, 10, 0) == "1.0000"  # rampe désactivée : coupe sèche


def test_punch_zooms_pattern_and_transitions():
    plain = [Join() for _ in range(4)]
    assert punch_zooms(5, plain, [1.0, 1.15]) == [1.0, 1.15, 1.0, 1.15, 1.0]
    assert punch_zooms(4, plain[:3], [1.0, 1.15, 1.0, 1.3]) == [1.0, 1.15, 1.0, 1.3]
    with_tr = [Join(), Join(resolve("fade"), 0.4), Join()]
    assert punch_zooms(4, with_tr, [1.0, 1.2]) == [1.0, 1.0, 1.0, 1.2]  # les deux voisins d'une transition à 1
    assert punch_zooms(3, plain[:2], []) == [1.0, 1.0, 1.0]


def _gray(path):
    info = probe(path)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, info.height, info.width).astype(float)


def test_cli_cut_punch_in(talk_video, tmp_path):
    plain, punched = tmp_path / "plain.mp4", tmp_path / "punch.mp4"
    assert main(["cut", str(talk_video), "-o", str(plain)]) == 0
    assert main(["cut", str(talk_video), "-o", str(punched), "--punch-in", "1.25"]) == 0
    a, b = _gray(plain), _gray(punched)
    assert a.shape == b.shape  # même durée, même taille
    diff = np.abs(a - b).mean(axis=(1, 2))
    n = len(diff)
    assert diff[: n // 4].mean() < 3  # 1er plan : non recadré
    assert diff[n // 2: n // 2 + 5].mean() > 10  # 2e plan : resserré
    assert main(["cut", str(talk_video), "-o", str(tmp_path / "x.mp4"), "--punch-pattern", "1,2"]) != 0  # 200 % refusé
