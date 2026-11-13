"""Aperçus et galerie des transitions."""

from __future__ import annotations

import html
from pathlib import Path

from cutkiller.media import run_ffmpeg
from cutkiller.transitions import Transition, catalog
from cutkiller.transitions.frames import VideoFormat


def demo_sources(folder: Path, fmt: VideoFormat, seconds: float = 3.0) -> tuple[Path, Path]:
    """Deux sources bien distinctes (mire colorée / barres) pour juger une transition."""
    folder.mkdir(parents=True, exist_ok=True)
    a, b = folder / f"demo_a_{fmt.width}x{fmt.height}.mp4", folder / f"demo_b_{fmt.width}x{fmt.height}.mp4"
    size = f"{fmt.width}x{fmt.height}"
    if not a.exists():
        run_ffmpeg(["-f", "lavfi", "-i", f"testsrc2=size={size}:rate={fmt.fps}:duration={seconds}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(a)])
    if not b.exists():
        run_ffmpeg(["-f", "lavfi", "-i", f"smptehdbars=size={size}:rate={fmt.fps}:duration={seconds}",
                    "-vf", "hue=h=200:s=1.3,drawgrid=w=iw/8:h=ih/8:t=2:c=white@0.5",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(b)])
    return a, b


def render_preview(t: Transition, out: Path, *, a: Path | None = None, b: Path | None = None,
                   duration: float = 1.0, fmt: VideoFormat | None = None, cache: Path | None = None) -> Path:
    from cutkiller.edit.timeline import Clip, Join, render_timeline

    fmt = fmt or VideoFormat(480, 270, 25.0)
    if a is None or b is None:
        a, b = demo_sources(cache or out.parent / ".demo", fmt)
    # 1 s de chaque côté, poignées disponibles dans les sources de 3 s
    render_timeline([Clip(a, 0.5, 1.5), Clip(b, 1.5, 2.5)], [Join(t, duration, 0.0)], out, fmt=fmt, audio=False,
                    crf=26)
    return out


def gallery(folder: Path, items: list[Transition] | None = None, *, fmt: VideoFormat | None = None,
            duration: float = 1.0, log=print) -> Path:
    """Rend un aperçu par transition et une page index.html pour les comparer."""
    folder.mkdir(parents=True, exist_ok=True)
    items = items if items is not None else catalog()
    cards, failed = [], []
    for k, t in enumerate(items, 1):
        out = folder / f"{t.family}_{t.name}.mp4"
        if not out.exists():
            try:
                render_preview(t, out, duration=duration, fmt=fmt, cache=folder / ".demo")
            except Exception as exc:  # noqa: BLE001 - une transition cassée ne bloque pas la galerie
                failed.append(f"{t.id}: {exc}")
                continue
        if log:
            log(f"  [{k}/{len(items)}] {t.id}")
        cards.append(
            f'<figure><video src="{html.escape(out.name)}" autoplay loop muted playsinline></video>'
            f"<figcaption><code>{html.escape(t.id)}</code><br>{html.escape(t.description)}</figcaption></figure>"
        )
    page = folder / "index.html"
    page.write_text(
        "<!doctype html><meta charset=utf-8><title>Transitions CutKiller</title>"
        "<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}"
        "main{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}"
        "figure{margin:0}video{width:100%;border-radius:6px}code{color:#7cf}</style>"
        f"<h1>{len(cards)} transitions</h1><main>{''.join(cards)}</main>"
        + (f"<h2>Échecs</h2><pre>{html.escape(chr(10).join(failed))}</pre>" if failed else ""),
        encoding="utf-8",
    )
    return page
