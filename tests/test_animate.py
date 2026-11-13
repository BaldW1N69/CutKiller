import json
import subprocess

import numpy as np
import pytest
from PIL import Image

from cutkiller.animate import Ctx, contact_sheet, ease, load_script, prog, render, stills
from cutkiller.animate.presets import PRESETS, preset_frame
from cutkiller.cli import main
from cutkiller.edit.captions import build_captions_ass, group_words, load_words
from cutkiller.edit.overlay import build_overlay_graph, parse_layer, render_overlays
from cutkiller.listen.transcribe import Word
from cutkiller.media import probe


def _pix_fmt(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt",
                          "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout.strip()
    return out


def test_easing_and_prog():
    assert abs(ease(0, "out_back")) < 1e-9 and abs(ease(1, "out_back") - 1) < 1e-9
    assert max(ease(x / 100, "out_back") for x in range(101)) > 1.0  # dépassement = rebond
    assert prog(0.5, 0, 1) == 0.5 and prog(-1, 0, 1) == 0 and prog(2, 0, 1) == 1


@pytest.mark.parametrize("name", list(PRESETS))
def test_every_preset_draws_inside_frame(name, tmp_path):
    params = {"logo": {"path": str(_logo(tmp_path))}}.get(name, {})
    ctx = Ctx(180, 320, 10, 2.0, params=params)
    fn = preset_frame(name)
    a = np.asarray(fn(1.0, ctx))
    assert a.shape == (320, 180, 4) and a[..., 3].max() > 0, f"{name} n'a rien dessiné"
    # rien de visible collé aux bords gauche/droit (texte qui déborde) sauf barre de progression / confettis
    if name not in ("progress", "confetti", "slide", "lower_third"):
        assert a[:, :2, 3].max() < 50 and a[:, -2:, 3].max() < 50, f"{name} déborde"


def _logo(tmp_path):
    p = tmp_path / "logo.png"
    Image.new("RGBA", (64, 64), (255, 0, 0, 255)).save(p)
    return p


def test_text_auto_fit():
    ctx = Ctx(200, 400, 10, 1.0)
    img = ctx.text(ctx.blank(), "UN TEXTE BEAUCOUP TROP LONG POUR LA LARGEUR", (0.5, 0.5), size=0.1)
    cols = np.flatnonzero(np.asarray(img)[..., 3].max(axis=0) > 0)
    assert cols.min() > 0 and cols.max() < 199


def test_render_formats_keep_alpha(tmp_path):
    ctx = Ctx(64, 96, 10, 0.5, params={"text": "A"})
    fn = preset_frame("title")
    assert _pix_fmt(render(fn, tmp_path / "a.mov", ctx)).startswith("yuva444")
    assert _pix_fmt(render(fn, tmp_path / "a.webm", ctx)) in ("yuv420p", "yuva420p")  # alpha en métadonnée VP9
    png = render(fn, tmp_path / "a.png", ctx)
    assert Image.open(png).mode == "RGBA"
    assert abs(probe(tmp_path / "a.mov").duration - 0.5) < 0.15


def test_script_loading_and_stills(tmp_path):
    script = tmp_path / "anim.py"
    script.write_text("DURATION = 1.5\nSIZE = (90, 160)\n"
                      "def frame(t, ctx):\n    return ctx.text(ctx.blank(), 'Hi', (0.5, 0.5), alpha=ctx.prog(t, 0, 1))\n")
    fn, meta = load_script(script)
    assert meta == {"duration": 1.5, "size": (90, 160)}
    shots = stills(fn, Ctx(90, 160, 10, 1.5), [0.0, 1.2], tmp_path / "s")
    assert len(shots) == 2 and all(p.exists() for p in shots)
    sheet = contact_sheet(shots, tmp_path / "sheet.png", ["0", "1.2"])
    assert Image.open(sheet).width == 180
    bad = tmp_path / "bad.py"
    bad.write_text("x = 1\n")
    with pytest.raises(ValueError, match="frame"):
        load_script(bad)


def test_frame_must_match_size(tmp_path):
    with pytest.raises(ValueError, match="RGBA"):
        render(lambda t, c: np.zeros((10, 10, 4), np.uint8), tmp_path / "x.mov", Ctx(20, 20, 10, 0.2))


def test_parse_layer(tmp_path):
    f = _logo(tmp_path)
    L = parse_layer(f"{f}@1.5-4?pos=top-right&scale=0.25&opacity=0.8")
    assert (L.start, L.end, L.pos, L.scale, L.opacity, L.mode) == (1.5, 4.0, "top-right", 0.25, 0.8, "alpha")
    assert parse_layer(f"{f}@2?pos=0.3,0.7").pos == "0.3,0.7"
    for bad in (f"{f}@abc", f"{f}@3-1", f"{f}@1?mode=xor", "/nope.png@1"):
        with pytest.raises(ValueError):
            parse_layer(bad)


def test_overlay_graph_modes(tmp_path):
    f = _logo(tmp_path)
    graph, inputs = build_overlay_graph([parse_layer(f"{f}@1-2"), parse_layer(f"{f}@2-3?mode=screen")], 320, 180, 5.0)
    assert "between(t,1.0000,2.0000)" in graph and "blend=all_mode=screen" in graph
    assert inputs[0][:2] == ["-loop", "1"]


def test_render_overlays_end_to_end(talk_video, tmp_path):
    anim = render(preset_frame("title"), tmp_path / "t.mov", Ctx(320, 240, 25, 1.0, params={"text": "HELLO"}))
    leak = tmp_path / "leak.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=160x90:d=1:r=25",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(leak)], check=True)
    out = render_overlays(talk_video, tmp_path / "o.mp4", [parse_layer(f"{anim}@1"), parse_layer(f"{leak}@3?mode=screen"),
                                                           parse_layer(f"{_logo(tmp_path)}@0?pos=bottom-left&scale=0.2")])
    a, b = probe(talk_video), probe(out)
    assert abs(a.duration - b.duration) < 0.1 and b.has_audio


def test_captions_grouping_and_ass(tmp_path):
    words = [Word(0.0, 0.3, "Salut"), Word(0.3, 0.5, "euh"), Word(0.5, 0.8, "tout"), Word(0.8, 1.0, "le"),
             Word(1.0, 1.4, "monde."), Word(2.5, 2.9, "Suite")]
    groups = group_words(words, max_words=3)
    assert [[w.text for w in g.words] for g in groups] == [["Salut", "tout", "le"], ["monde."], ["Suite"]]
    ass = build_captions_ass(words, 1080, 1920, style="tiktok")
    assert "SALUT" in ass and "\\fscx118" in ass and "euh" not in ass.lower().split("[events]")[1]
    assert "\\kf" in build_captions_ass(words, 1080, 1920, style="karaoke")
    report = tmp_path / "r.listen.json"
    report.write_text(json.dumps({"words": [w.to_dict() for w in words]}), encoding="utf-8")
    assert len(load_words(report)) == 6


def test_cli_animate_overlay_captions(talk_video, tmp_path, capsys):
    anim = tmp_path / "cta.mov"
    assert main(["animate", "cta", "text=Lien en bio", "--size", "160x90", "--duration", "1", "-o", str(anim)]) == 0
    assert main(["animate", "cta", "--size", "160x90", "--preview", "0.5", "-o", str(anim)]) == 0
    assert (tmp_path / "cta_preview").is_dir()
    out = tmp_path / "ov.mp4"
    assert main(["overlay", str(talk_video), "--add", f"{anim}@1", "-o", str(out)]) == 0
    words = tmp_path / "w.listen.json"
    words.write_text(json.dumps({"words": [{"start": 0.2, "end": 0.8, "text": "Bonjour"}, {"start": 0.8, "end": 1.4, "text": "à tous"}]}),
                     encoding="utf-8")
    assert main(["captions", str(out), "--words", str(words), "-o", str(tmp_path / "c.mp4")]) == 0
    assert main(["captions", str(talk_video)]) == 1
    assert "transcribe" in capsys.readouterr().err
    assert main(["animate", "inconnu"]) == 1
