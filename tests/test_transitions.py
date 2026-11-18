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


def _frame_md5(path) -> str:
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v", "-f", "md5", "-"],
                          capture_output=True, text=True, check=True).stdout.strip()


def test_parallel_transitions_match_sequential(talk_video, tmp_path):
    """Rendering transitions in worker processes must give the exact same frames as one by one."""
    clips = [Clip(talk_video, 0, 1.2), Clip(talk_video, 1.6, 2.6), Clip(talk_video, 3.0, 4.0), Clip(talk_video, 4.4, 5.5)]
    joins = [Join(resolve("fx:zoom_punch"), 0.4), Join(resolve("xfade:fade"), 0.4), Join(resolve("fx:glitch"), 0.4)]
    render_timeline(clips, joins, tmp_path / "seq.mp4", fmt=FMT, audio=False, jobs=1)
    render_timeline(clips, joins, tmp_path / "par.mp4", fmt=FMT, audio=False, jobs=3)
    assert _frame_md5(tmp_path / "seq.mp4") == _frame_md5(tmp_path / "par.mp4")


@pytest.fixture(scope="module")
def long_video(tmp_path_factory):
    out = tmp_path_factory.mktemp("long") / "long.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi",
                    "-i", "sine=frequency=330:sample_rate=48000", "-t", "20", "-g", "50", "-c:v", "libx264",
                    "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], check=True)
    return out


def _md5(path, stream) -> str:
    return subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", f"0:{stream}", "-f", "md5", "-"],
                          capture_output=True, text=True, check=True).stdout.strip()


def test_seek_runs_are_frame_exact(long_video, tmp_path, monkeypatch):
    """Seeking to each far-apart clip must give the same frames and samples as decoding the whole source."""
    import cutkiller.edit.timeline as tl

    clips = [Clip(long_video, 2.0, 3.0), Clip(long_video, 9.0, 10.2), Clip(long_video, 15.0, 16.0),
             Clip(long_video, 16.4, 17.4)]
    joins = [Join(resolve("xfade:fade"), 0.4), Join(), Join(jl=0.2)]
    render_timeline(clips, joins, tmp_path / "seek.mkv", fmt=FMT, jobs=1)
    graph, inputs = tl.build_graph(tl.plan_timeline(clips, joins, FMT), {}, "crop", True)
    assert sum(p == long_video for _, p in inputs) == 3  # 2 s, 9 s and 15-17 s: three seeks
    monkeypatch.setattr(tl, "SEEK_GAP_S", 1e9)
    monkeypatch.setattr(tl, "PREROLL_S", 1e9)  # one run from 0: the former full-decode behaviour
    render_timeline(clips, joins, tmp_path / "full.mkv", fmt=FMT, jobs=1)
    assert _md5(tmp_path / "seek.mkv", "v") == _md5(tmp_path / "full.mkv", "v")
    # audio is AAC-encoded: same length, no lag, difference far below the signal (encoder noise only)
    a, b = _pcm(tmp_path / "seek.mkv"), _pcm(tmp_path / "full.mkv")
    assert a.size == b.size
    lag = int(np.argmax(np.correlate(a[24000:28000], b[23950:28050], "valid"))) - 50
    assert lag == 0
    assert np.sqrt(np.mean((a - b) ** 2)) < 0.02 * np.sqrt(np.mean(b ** 2))


def _pcm(path) -> np.ndarray:
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, np.float32)


@pytest.mark.parametrize("same_source", [True, False])
def test_inline_xfade_matches_file_path(long_video, talk_video, tmp_path, monkeypatch, same_source):
    """xfade computed inside the main graph gives the same frames as the (lossless) intermediate file."""
    import cutkiller.edit.timeline as tl

    other = long_video if same_source else talk_video
    clips = [Clip(long_video, 2.0, 3.0), Clip(other, 3.4, 4.4), Clip(long_video, 12.0, 13.0)]
    joins = [Join(resolve("xfade:slideleft"), 0.4), Join(resolve("xfade:fade"), 0.32)]
    plan = render_timeline(clips, joins, tmp_path / "inline.mkv", fmt=FMT, audio=False, jobs=1)
    assert all(j.n > 0 for j in plan.joins)
    monkeypatch.setattr(tl, "inline_joins", lambda plan: set())
    render_timeline(clips, joins, tmp_path / "files.mkv", fmt=FMT, audio=False, jobs=1)
    assert _md5(tmp_path / "inline.mkv", "v") == _md5(tmp_path / "files.mkv", "v")


def test_affine_fast_paths_match_general_bilinear():
    """Separable zoom path and flat-gather sampling equal a naive 2-D bilinear sample."""
    rng = np.random.default_rng(1)
    img = rng.integers(0, 256, (37, 53, 3), dtype=np.uint8)
    h, w = img.shape[:2]

    def naive(scale, angle, dx, dy):
        y, x = np.mgrid[0:h, 0:w].astype(np.float64)
        cx, cy = (w - 1) / 2, (h - 1) / 2
        u, v = x - cx - dx * w, y - cy - dy * h
        c, s = np.cos(-angle), np.sin(-angle)
        xs = np.clip((c * u - s * v) / scale + cx, 0, w - 1.001)
        ys = np.clip((s * u + c * v) / scale + cy, 0, h - 1.001)
        x0, y0 = xs.astype(int), ys.astype(int)
        fx_, fy_ = (xs - x0)[..., None], (ys - y0)[..., None]
        im = img.astype(np.float64)
        top = im[y0, x0] * (1 - fx_) + im[y0, x0 + 1] * fx_
        bot = im[y0 + 1, x0] * (1 - fx_) + im[y0 + 1, x0 + 1] * fx_
        return top * (1 - fy_) + bot * fy_

    for args in [(1.3, 0.0, 0.0, 0.0), (0.8, 0.0, 0.05, -0.1), (1.2, 0.3, 0.02, 0.0)]:
        assert np.abs(fx.affine(img, *args) - naive(*args)).max() < 0.05
    one = img[..., :1]  # any channel count
    assert fx.affine(one, 1.1).shape == one.shape
    blur = fx.motion_blur(img, 5, 1)
    ref = np.stack([np.convolve(np.pad(img[r, :, 0].astype(float), (2, 3), mode="edge"), np.ones(5) / 5, "valid")[:w]
                    for r in range(h)])
    assert np.abs(blur[..., 0] - ref).max() < 0.01


def test_rgb_paths_keep_bt709_colours(tmp_path):
    """fx/GL transitions go through RGB: on a bt709 source they must not shift colour (was luma 124 -> 110),
    and photos must keep their RGB colour when displayed as HD (bt709) video (was up to 19 levels off)."""
    from PIL import Image

    from cutkiller.edit.montage import photo_to_clip

    src = tmp_path / "green.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x28A03C:s=320x240:r=25", "-t", "6",
                    "-vf", "scale=out_color_matrix=bt709,format=yuv420p", "-colorspace", "bt709", "-c:v", "libx264",
                    "-qp", "0", str(src)], check=True)
    render_timeline([Clip(src, 0, 2), Clip(src, 3, 5)], [Join(resolve("fx:cut"), 0.4)], tmp_path / "o.mkv",
                    fmt=VideoFormat(320, 240, 25.0), audio=False, jobs=1)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(tmp_path / "o.mkv"), "-f", "rawvideo", "-pix_fmt",
                          "yuv420p", "-"], capture_output=True, check=True).stdout
    n = 320 * 240 * 3 // 2
    assert {raw[k * n + 120 * 320 + 160] for k in range(len(raw) // n)} == {124}

    fmt = VideoFormat(1080, 1920, 30.0)
    for colour in [(200, 40, 40), (40, 160, 60), (30, 60, 200)]:
        Image.new("RGB", (1080, 1920), colour).save(tmp_path / "c.png")
        photo_to_clip(tmp_path / "c.png", 1.0, fmt, 0.0, tmp_path / "c.mp4")
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(tmp_path / "c.mp4"), "-frames:v", "1", "-vf",
                              "scale=in_color_matrix=bt709,format=rgb24", "-f", "rawvideo", "-"],
                             capture_output=True, check=True).stdout
        got = np.frombuffer(out, np.uint8).reshape(1920, 1080, 3)[960, 540].astype(int)
        assert np.abs(got - np.array(colour)).max() <= 3
