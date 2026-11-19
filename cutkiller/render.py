"""Renderers for a plan.

* ffmpeg   : fast path for cut plans (no browser). Frame-exact trims, optional zoom punch.
* remotion : full effects (punch, flash, titles) and motion-design plans.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STUDIO = ROOT / "studio"
DEFAULT_BROWSER = "/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"


SEG_CACHE = Path(".cutkiller-cache") / "segments"


def _segment(c: dict, fps: int, W: int, H: int, punch: bool, crf: int, preset: str) -> Path:
    """Encode one clip to its own file (cached). Frame-exact: N frames, padded if the source runs out."""
    n = c["durationInFrames"]
    a = int(round(c["trimBeforeSec"] * fps))
    kind = c["kind"] if punch else "none"
    st = Path(c["src"]).stat()
    key = hashlib.sha1(f"{c['src']}|{st.st_mtime_ns}|{a}|{n}|{fps}|{W}x{H}|{kind}|{crf}|{preset}|v2".encode()).hexdigest()[:20]
    out = SEG_CACHE / f"{key}.mp4"
    if out.exists():
        return out
    vf = (f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,"
          f"tpad=stop_mode=clone:stop_duration=2")
    if kind in ("downbeat", "section", "drop"):
        amp = {"downbeat": 0.06, "section": 0.10, "drop": 0.14}[kind]
        k = max(2, min(n, int(fps * 0.35)))
        z = f"if(lt(on,{k}),1+{amp}*pow(1-on/{k},2),1)"
        vf += f",zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={fps}"
    vf += ",format=yuv420p"
    tmp = out.with_suffix(".tmp.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a / fps:.6f}", "-i", c["src"], "-an", "-vf", vf,
                    "-frames:v", str(n), "-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-threads", "2",
                    "-video_track_timescale", str(fps * 1000), str(tmp)], check=True)
    tmp.rename(out)
    return out


def render_ffmpeg(plan: dict, out: str | Path, punch: bool = True, crf: int = 18, preset: str = "veryfast",
                  jobs: int | None = None) -> Path:
    """Fast path: encode clips as independent segments in parallel (cached), then stream-copy concat.

    A single filter graph with split+concat buffers every pending branch and scales poorly;
    segments parallelise across cores and only changed clips are re-encoded after a plan edit."""
    if plan["mode"] != "cut":
        raise ValueError("ffmpeg renderer only supports cut plans; use --engine remotion for motion plans")
    from concurrent.futures import ThreadPoolExecutor

    out = Path(out)
    fps, W, H = plan["fps"], plan["width"], plan["height"]
    SEG_CACHE.mkdir(parents=True, exist_ok=True)
    jobs = jobs or max(1, os.cpu_count() or 2)
    with ThreadPoolExecutor(jobs) as ex:
        segs = list(ex.map(lambda c: _segment(c, fps, W, H, punch, crf, preset), plan["clips"]))

    lst = out.with_suffix(".concat.txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in segs))
    dur = plan["durationInFrames"] / fps
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                    "-ss", str(plan["audio"]["startSec"]), "-t", f"{dur:.4f}", "-i", plan["audio"]["src"],
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-t", f"{dur:.4f}", "-movflags", "+faststart", str(out)], check=True)
    lst.unlink(missing_ok=True)
    return out


def _stage(path: str, public: Path) -> str:
    """Link a media file into studio/public so Remotion can serve it via staticFile()."""
    p = Path(path).resolve()
    h = hashlib.sha1(str(p).encode()).hexdigest()[:10]
    rel = Path("cutkiller") / f"{h}-{p.name}"
    dst = public / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        try:
            os.link(p, dst)
        except OSError:
            shutil.copy2(p, dst)
    return rel.as_posix()


def _browser(browser: str | None) -> list[str]:
    exe = browser or os.environ.get("CUTKILLER_BROWSER") or (DEFAULT_BROWSER if Path(DEFAULT_BROWSER).exists() else None)
    return [f"--browser-executable={exe}"] if exe else []


def _stage_plan(plan: dict, props: Path) -> tuple[str, Path]:
    public = STUDIO / "public"
    staged = json.loads(json.dumps(plan))
    if staged["audio"]["src"]:
        staged["audio"]["src"] = _stage(plan["audio"]["src"], public)
    for c in staged.get("clips", []):
        c["src"] = _stage(c["src"], public)
    props.write_text(json.dumps(staged))
    return ("BeatCut" if plan["mode"] == "cut" else "MotionDesign"), props


def render_remotion(plan: dict, out: str | Path, concurrency: int | None = None, browser: str | None = None,
                    quiet: bool = False) -> Path:
    out = Path(out).resolve()
    comp, props = _stage_plan(plan, out.with_suffix(".props.json"))
    cmd = ["npx", "remotion", "render", "src/index.ts", comp, str(out), f"--props={props}", *_browser(browser)]
    if concurrency:
        cmd.append(f"--concurrency={concurrency}")
    if quiet:
        cmd.append("--log=error")
    subprocess.run(cmd, check=True, cwd=STUDIO)
    props.unlink(missing_ok=True)
    return out


def key_frames(plan: dict) -> list[int]:
    """Frames worth eyeballing before a full render."""
    last = plan["durationInFrames"] - 1
    if plan["mode"] == "motion":
        h, s, b = plan["heroFrame"], plan["scaleFrame"], plan["beatFrames"]
        fr = [max(0, int(h - b)), h, int(h + b), s, int(s + b * 1.5), last]
    else:
        fr = [c["from"] + 1 for c in plan["clips"][:5]] + ([plan["drop"] + 1] if plan.get("drop") is not None else [])
    return sorted({min(last, max(0, f)) for f in fr})


def preview(plan: dict, out: str | Path, frames: list[int] | None = None, scale: float = 0.33,
            browser: str | None = None) -> Path:
    """Contact sheet of key frames (bundles once, then one still per frame)."""
    import tempfile

    out = Path(out).resolve()
    frames = frames or key_frames(plan)
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        comp, props = _stage_plan(plan, td / "props.json")
        bundle = td / "bundle"
        subprocess.run(["npx", "remotion", "bundle", "src/index.ts", f"--out-dir={bundle}", "--log=error"],
                       check=True, cwd=STUDIO, stdout=subprocess.DEVNULL)
        pngs = []
        for f in frames:
            png = td / f"f{f:06d}.png"
            subprocess.run(["npx", "remotion", "still", str(bundle), comp, str(png), f"--frame={f}",
                            f"--props={props}", f"--scale={scale}", "--log=error", *_browser(browser)],
                           check=True, cwd=STUDIO, stdout=subprocess.DEVNULL)
            pngs.append(png)
        cols = min(3, len(pngs))
        rows = (len(pngs) + cols - 1) // cols
        inputs = [x for p in pngs for x in ("-i", str(p))]
        labels = [f"[{i}:v]drawtext=text='f{f}':x=10:y=10:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.5[l{i}]"
                  for i, f in enumerate(frames)]
        while len(pngs) < rows * cols:  # pad grid with black
            inputs += ["-f", "lavfi", "-i", "color=black:s=2x2"]
            labels.append(f"[{len(pngs)}:v]null[l{len(pngs)}]")
            pngs.append(None)
        n = len(pngs)
        lay = "|".join(f"{'+'.join(['w0'] * (i % cols)) or '0'}_{'+'.join(['h0'] * (i // cols)) or '0'}" for i in range(n))
        graph = ";".join(labels) + ";" + "".join(f"[l{i}]" for i in range(n)) + f"xstack=inputs={n}:layout={lay}:fill=black"
        subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex", graph, "-frames:v", "1", str(out)],
                       check=True)
    return out
