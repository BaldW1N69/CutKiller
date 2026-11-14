"""Textures (grain, pellicule scannée, dither) et polices en fichier (Fontshare)."""

import glob
import subprocess

import numpy as np
import pytest

from cutkiller.cli import main
from cutkiller.edit.text import font_family
from cutkiller.edit.texture import TextureSettings, build_texture_filter
from cutkiller.media import probe


def test_filter_chain_order():
    s = TextureSettings(grain=0.5, grain_file="g.mp4", dither="bayer", colors=8, pixel=3, vignette=0.5)
    graph, inputs = build_texture_filter(s, 1081, 1920)
    order = [graph.index(k) for k in ("paletteuse", "noise=", "blend=", "vignette")]
    assert order == sorted(order)  # dither → grain → scan → vignette
    assert "scale=360:640" in graph and "max_colors=8" in graph and "bayer_scale" in graph
    assert "scale=1080:1920:flags=neighbor" in graph  # largeur paire
    assert inputs == [["-stream_loop", "-1", "-i", "g.mp4"]]


def test_validate():
    with pytest.raises(ValueError):
        TextureSettings().validate()
    with pytest.raises(ValueError):
        TextureSettings(grain=2).validate()
    with pytest.raises(ValueError):
        TextureSettings(dither="atkinson").validate()


def _frame(path, t=0.5):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).astype(np.int16)


def test_cli_texture(talk_video, tmp_path):
    scan = tmp_path / "scan.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=160x120:r=25:d=1,noise=alls=50:allf=t",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(scan)], check=True)
    film = tmp_path / "film.mp4"
    assert main(["texture", str(talk_video), "-o", str(film), "--grain", "0.5", "--grain-file", str(scan),
                 "--grain-mode", "softlight", "--vignette", "0.5"]) == 0
    src, out = probe(talk_video), probe(film)
    assert out.has_audio and abs(out.duration - src.duration) < 0.1 and (out.width, out.height) == (src.width, src.height)
    assert np.abs(_frame(film) - _frame(talk_video)).mean() > 2  # la texture se voit
    dith = tmp_path / "d.mp4"
    assert main(["texture", str(talk_video), "-o", str(dith), "--dither", "bayer", "--colors", "4", "--pixel", "2"]) == 0

    def colors(path):  # couleurs distinctes (arrondies : la compression 4:2:0 crée des teintes intermédiaires)
        return len(np.unique(_frame(path).reshape(-1, 3) // 16, axis=0))

    assert colors(dith) < 0.5 * colors(talk_video)  # palette réduite


FONTS = sorted(glob.glob("/usr/share/fonts/**/DejaVuSans.ttf", recursive=True))


@pytest.mark.skipif(not FONTS, reason="DejaVuSans.ttf absente")
def test_font_file(talk_video, tmp_path):
    family, path = font_family(FONTS[0])
    assert family == "DejaVu Sans" and path.name == "DejaVuSans.ttf"
    assert font_family("Arial") == ("Arial", None)
    with pytest.raises(ValueError):
        font_family(str(tmp_path / "absente.otf"))
    out = tmp_path / "t.mp4"
    assert main(["text", str(talk_video), "-o", str(out), "--text", "Hello@0-2", "--font", FONTS[0]]) == 0
    assert probe(out).has_video


def test_looks_and_letterbox():
    from cutkiller.edit.texture import LOOKS

    for name, values in LOOKS.items():
        s = TextureSettings(**values)
        s.validate()
        build_texture_filter(s, 1920, 1080)
    graph, _ = build_texture_filter(TextureSettings(grade="teal_orange", glow=0.5, sharpen=0.3, contrast=0.4,
                                                    letterbox=2.39), 1920, 1080)
    order = [graph.index(k) for k in ("colorbalance", "eq=contrast", "unsharp", "blend=all_mode=screen", "drawbox")]
    assert order == sorted(order)
    assert "h=138" in graph  # (1080 - 1920 / 2.39) / 2 ≈ 138
    with pytest.raises(ValueError):
        TextureSettings(grade="sepia").validate()
    with pytest.raises(ValueError):
        TextureSettings(letterbox=0.5).validate()


def test_cli_look_letterbox_bars(talk_video, tmp_path):
    out = tmp_path / "look.mp4"
    assert main(["texture", str(talk_video), "-o", str(out), "--look", "cinematic", "--letterbox", "2.39",
                 "--grain", "0"]) == 0
    px = _frame(out).reshape(probe(out).height, probe(out).width, 3)
    assert px[:20].max() < 30 and px[-20:].max() < 30  # bandes noires (grain désactivé)
    assert px[px.shape[0] // 2].mean() > 30
