import subprocess

import numpy as np
import pytest

from conftest import write_wav
from cutkiller.edit.timeline import Clip, Join, _audio_bounds, assign_joins, plan_timeline, render_timeline
from cutkiller.media import probe
from cutkiller.transitions import Picker, catalog, gl, parse_params, resolve
from cutkiller.transitions import fx
from cutkiller.transitions.frames import VideoFormat, read_window

needs_gl = pytest.mark.skipif(not gl.available(), reason="moderngl non installé")
FMT = VideoFormat(160, 90, 25.0)


def _gl_context_ok():
    if not gl.available():
        return False
    try:
        gl.GLRenderer(16, 16).release()
        return True
    except RuntimeError:
        return False


needs_gl_ctx = pytest.mark.skipif(not _gl_context_ok(), reason="pas de contexte OpenGL")


def test_catalog_sizes():
    fams = {}
    for t in catalog():
        fams[t.family] = fams.get(t.family, 0) + 1
    assert fams["xfade"] == 58 and fams["gl"] == 214 and fams["fx"] >= 15


def test_resolve_and_params():
    assert resolve("fade").id == "xfade:fade"  # xfade prioritaire (rapide)
    assert resolve("gl:fade").id == "gl:Fade"
    assert resolve("whippan").id == "gl:WhipPan"
    t = resolve("gl:WhipPan?direction=1,0&blur=0.6")
    assert t.params == {"direction": [1, 0], "blur": 0.6}
    assert parse_params("a=true&b=x&c=2") == {"a": True, "b": "x", "c": 2}
    with pytest.raises(ValueError, match="Proches"):
        resolve("whip")
    with pytest.raises(ValueError, match="introuvable"):
        resolve("pack:/nope.mov")


def test_picker_pools():
    p = Picker("random:glitch", seed=1, gl_ok=True)
    assert p.pool and all("glitch" in t.tags for t in p.pool)
    seq1 = [Picker("random", seed=5, gl_ok=True).next().id for _ in range(3)]
    assert seq1 == [Picker("random", seed=5, gl_ok=True).next().id for _ in range(3)]
    p = Picker("fade|fx:flash", seed=0, gl_ok=False)
    assert {t.id for t in p.pool} == {"xfade:fade", "fx:flash"}
    assert all(not t.needs_gl for t in Picker("random", gl_ok=False).pool)
    with pytest.raises(RuntimeError, match="moderngl"):
        Picker("gl:Cube", gl_ok=False)


def test_fx_effects_endpoints():
    a = np.zeros((36, 64, 3), np.uint8)
    b = np.full((36, 64, 3), 200, np.uint8)
    for name, (fn, _, _) in fx.EFFECTS.items():
        start, end = fn(a, b, 0.02, {}), fn(a, b, 0.98, {})
        assert start.shape == a.shape, name
        assert np.mean(start) < np.mean(end), name
    whip = fx.EFFECTS["whip_left"][0]
    assert np.allclose(whip(a, b, 0.0, {}), a) and np.allclose(whip(a, b, 1.0, {}), b)


def test_key_alpha_modes():
    green = np.zeros((4, 8, 8, 3), np.uint8)
    green[..., 1] = 255
    green[2, :, :4] = 255  # forme blanche qui couvre la moitié
    rgb, alpha, mode = fx.key_alpha(green)
    assert mode == "green" and alpha[0].mean() < 0.05 and alpha[2].mean() > 0.4
    dark = np.zeros((3, 8, 8, 3), np.uint8)
    dark[1] = 220
    rgb, alpha, mode = fx.key_alpha(dark)
    assert mode == "screen" and int(np.argmax(fx.coverage(alpha, rgb, mode))) == 1


def test_plan_handles_keep_duration(talk_video):
    clips = [Clip(talk_video, 0, 1.5), Clip(talk_video, 3.0, 4.5), Clip(talk_video, 5.5, 6.5)]
    joins = [Join(resolve("fade"), 0.4), Join(resolve("fade"), 0.4)]
    plan = plan_timeline(clips, joins, FMT)
    assert abs(plan.duration - 4.0) < 0.05  # pas raccourci : poignées utilisées
    assert [j.n for j in plan.joins] == [10, 10]
    bounds = _audio_bounds(plan)
    audio = sum(e - s for s, e in bounds) - sum(j.audio_fade for j in plan.joins)
    assert abs(audio - plan.duration) < 1e-6


def test_plan_overlap_without_handles(talk_video):
    # clips qui touchent le début et la fin de la source : pas de poignée → chevauchement
    clips = [Clip(talk_video, 3.0, 6.5), Clip(talk_video, 0, 3.0)]
    plan = plan_timeline(clips, [Join(resolve("fade"), 0.8)], FMT)
    j = plan.joins[0]
    assert j.n == 20 and abs(plan.duration - (6.48 - 0.8)) < 0.05  # raccourci de la durée de la transition
    # avec une poignée côté A, pas besoin de raccourcir
    plan = plan_timeline([Clip(talk_video, 0, 3.0), Clip(talk_video, 0, 3.0)], [Join(resolve("fade"), 0.8)], FMT)
    assert plan.joins[0].n == 20 and abs(plan.duration - 6.0) < 0.05


def test_assign_joins():
    p = Picker("fade", gl_ok=False)
    joins = assign_joins([1, 2, 3, 4, 5, 6], p, every=2)
    assert [bool(j.transition) for j in joins] == [True, False, True, False, True, False]
    joins = assign_joins([1, 1.5, 2, 5], p, min_gap=2)
    assert [bool(j.transition) for j in joins] == [True, False, False, True]
    assert all(j.transition is None for j in assign_joins([1, 2], None))


@pytest.mark.parametrize("spec", ["xfade:circleopen", "fx:zoom_punch", "xfade:custom?expr=if(gt(X,W*P),A,B)"])
def test_render_timeline_engines(talk_video, tmp_path, spec):
    clips = [Clip(talk_video, 0, 1.5), Clip(talk_video, 3.0, 4.5)]
    plan = render_timeline(clips, [Join(resolve(spec), 0.4)], tmp_path / "o.mp4", fmt=FMT)
    info = probe(tmp_path / "o.mp4")
    assert info.has_audio and abs(info.duration - plan.duration) < 0.08


@needs_gl_ctx
def test_gl_render_and_custom_shader(talk_video, tmp_path):
    shader = tmp_path / "split.glsl"
    shader.write_text("uniform float edge; // = 0.5\n"
                      "vec4 transition(vec2 uv) { return uv.x < progress ? getToColor(uv) : getFromColor(uv); }\n")
    for spec in ("gl:Cube", f"glsl:{shader}", "gl:LumaWipe"):
        clips = [Clip(talk_video, 0, 1.5), Clip(talk_video, 3.0, 4.5)]
        plan = render_timeline(clips, [Join(resolve(spec), 0.4)], tmp_path / "g.mp4", fmt=FMT)
        assert abs(probe(tmp_path / "g.mp4").duration - plan.duration) < 0.08


@needs_gl_ctx
def test_gl_orientation_matches_cpu():
    """Le rendu GL doit respecter le haut/bas des images (pas de miroir vertical)."""
    a = np.zeros((32, 32, 3), np.uint8)
    a[:8] = 255  # bande blanche en haut
    r = gl.GLRenderer(32, 32)
    try:
        out = r.render(gl.catalog()["Fade"], a, a, 0.5, {})
    finally:
        r.release()
    assert out[:8].mean() > 200 and out[-8:].mean() < 30


def test_pack_and_luma(talk_video, tmp_path):
    pack = tmp_path / "pack.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x00ff00:s=160x90:d=0.8:r=25",
                    "-vf", "drawbox=x='-160+t*400':y=0:w=160:h=90:c=white:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    str(pack)], check=True)
    mask = tmp_path / "mask.png"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "gradients=s=160x90:c0=black:c1=white:x0=0:y0=0:x1=160:y1=0",
                    "-frames:v", "1", str(mask)], check=True)
    for spec in (f"pack:{pack}", f"luma:{mask}?softness=0.3"):
        clips = [Clip(talk_video, 0, 1.5), Clip(talk_video, 3.0, 4.5)]
        plan = render_timeline(clips, [Join(resolve(spec), 0.4)], tmp_path / "p.mp4", fmt=FMT)
        assert abs(probe(tmp_path / "p.mp4").duration - plan.duration) < 0.08
    assert plan_timeline(clips, [Join(resolve(f"pack:{pack}"), 0.1)], FMT).joins[0].n == 20  # durée du pack


def test_read_window_pads_past_end(talk_video):
    frames = read_window(talk_video, int(6.4 * 25), 10, FMT)
    assert frames.shape == (10, 90, 160, 3)
