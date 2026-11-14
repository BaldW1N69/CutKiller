"""Animations HTML rendues image par image (Chromium sans écran, horloge pilotée)."""

import subprocess

import numpy as np
import pytest

from cutkiller.animate import html
from cutkiller.cli import main
from cutkiller.media import probe

pytestmark = pytest.mark.skipif(not html.available(), reason="Playwright absent (pip install 'cutkiller[html]')")

CSS_PAGE = """<!doctype html><html><head><meta name="duration" content="2">
<style>html,body{margin:0;background:transparent}
#b{position:absolute;top:0;left:0;width:20px;height:20px;background:#f00;animation:mv 2s linear forwards}
@keyframes mv{from{transform:translateX(0)}to{transform:translateX(100px)}}</style></head>
<body><div id=b></div><canvas id=c width=200 height=100 style="position:absolute;left:0;top:50px"></canvas>
<script>const g=c.getContext('2d');function f(now){g.clearRect(0,0,200,100);g.fillStyle='#00f';
g.fillRect(now/20,0,10,10);requestAnimationFrame(f)}requestAnimationFrame(f)</script></body></html>"""

SEEK_PAGE = """<!doctype html><html><body style="margin:0;background:transparent"><div id=d
style="position:absolute;top:0;left:0;width:10px;height:10px;background:#0f0"></div><script>
window.DURATION = 1.5;
window.cutkillerSeek = t => { d.style.left = Math.round(t * 100) + 'px'; };
</script></body></html>"""


def _x(img, rgb, rows=slice(None)):
    a = img[rows]
    m = (np.abs(a[..., :3].astype(int) - rgb).sum(axis=-1) < 60) & (a[..., 3] > 200)
    xs = np.nonzero(m)[1]
    return int(xs.min()) if xs.size else None


@pytest.fixture
def scene_factory(tmp_path):
    made = []

    def make(code, **kw):
        p = tmp_path / f"p{len(made)}.html"
        p.write_text(code, encoding="utf-8")
        try:
            s = html.HtmlScene(p, 200, 150, 25.0, **kw)
        except RuntimeError as exc:  # Chromium absent sur cette machine
            pytest.skip(str(exc))
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def test_css_and_raf_follow_the_clock(scene_factory):
    s = scene_factory(CSS_PAGE)
    assert s.duration == 2.0  # <meta name="duration">
    img = s(1.0)
    assert img.shape == (150, 200, 4)
    assert _x(img, (255, 0, 0), slice(0, 20)) == pytest.approx(50, abs=2)  # CSS : 100 px en 2 s
    assert _x(img, (0, 0, 255), slice(50, 60)) == pytest.approx(50, abs=2)  # rAF : now/20 à t = 1 s
    assert img[140, 190, 3] == 0  # fond transparent
    back = s(0.5)  # retour en arrière : rechargement
    assert _x(back, (255, 0, 0), slice(0, 20)) == pytest.approx(25, abs=2)


def test_seek_hook_and_duration(scene_factory):
    s = scene_factory(SEEK_PAGE)
    assert s.duration == 1.5
    assert _x(s(0.8), (0, 255, 0)) == 80


def test_cli_animate_html(tmp_path):
    page = tmp_path / "anim.html"
    page.write_text(CSS_PAGE, encoding="utf-8")
    out = tmp_path / "anim.mov"
    try:
        code = main(["animate", str(page), "-o", str(out), "--size", "200x150", "--fps", "10"])
    except RuntimeError as exc:
        pytest.skip(str(exc))
    assert code == 0
    info = probe(out)
    assert abs(info.duration - 2.0) < 0.15 and info.width == 200
    pix = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", str(out)],
                         capture_output=True, text=True).stdout
    assert "yuva" in pix  # canal alpha conservé
