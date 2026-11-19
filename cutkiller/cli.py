"""CutKiller command line.

One-shot:
  cutkiller cut    MUSIC VIDEO [VIDEO...] -o out.mp4     # cut footage on the beat
  cutkiller motion MUSIC --title "Hello" -o out.mp4      # beat-synced motion design

Step by step (each step writes inspectable JSON):
  cutkiller analyze-audio MUSIC -o beats.json
  cutkiller analyze-video VIDEO... -o footage.json
  cutkiller plan-cut beats.json footage.json --audio MUSIC -o plan.json
  cutkiller plan-motion beats.json --audio MUSIC --title "Hello" -o plan.json
  cutkiller render plan.json -o out.mp4 [--engine ffmpeg|remotion]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

CACHE = Path(".cutkiller-cache")


def _key(path: str, extra: str) -> str:
    p = Path(path).resolve()
    st = p.stat()
    return hashlib.sha1(f"{p}|{st.st_size}|{st.st_mtime_ns}|{extra}".encode()).hexdigest()[:16]


def _cached(kind: str, path: str, extra: str, fn):
    CACHE.mkdir(exist_ok=True)
    f = CACHE / f"{kind}-{_key(path, extra)}.json"
    if f.exists():
        return json.loads(f.read_text())
    data = fn()
    f.write_text(json.dumps(data))
    return data


def _audio(path: str, bpm: float | None, meter: int, grid: str = "auto") -> dict:
    from .audio import analyze_audio
    return _cached("audio", path, f"{bpm}|{meter}|{grid}|v7", lambda: analyze_audio(path, bpm, meter, grid))


def _videos(paths: list[str]) -> list[dict]:
    from .video import analyze_video
    return [_cached("video", p, "v1", lambda p=p: analyze_video(p)) for p in paths]


def _write(obj, out: str | None):
    s = json.dumps(obj, indent=2)
    if out:
        Path(out).write_text(s)
        print(f"wrote {out}", file=sys.stderr)
    else:
        print(s)


def _render(plan: dict, out: str, engine: str, punch: bool, concurrency: int | None, crf: int | None = None):
    from .render import render_ffmpeg, render_remotion
    t = time.time()
    if engine == "auto":
        engine = "ffmpeg" if plan["mode"] == "cut" and not plan.get("title") else "remotion"
    if engine == "ffmpeg":
        render_ffmpeg(plan, out, punch=punch)
    else:
        render_remotion(plan, out, concurrency=concurrency, crf=crf)
    print(f"rendered {out} with {engine} in {time.time() - t:.1f}s", file=sys.stderr)


def _summary(plan: dict):
    if plan["mode"] == "cut":
        kinds: dict[str, int] = {}
        for c in plan["clips"]:
            kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
        print(f"plan: {len(plan['clips'])} clips over {plan['durationInFrames'] / plan['fps']:.2f}s "
              f"@ {plan['bpm']} BPM | cuts by kind {kinds}", file=sys.stderr)
    else:
        print(f"plan: motion {plan['durationInFrames'] / plan['fps']:.2f}s @ {plan['bpm']} BPM ({plan['feel']}), "
              f"hero f{plan['heroFrame']}, scale-up f{plan['scaleFrame']}", file=sys.stderr)


def _cut_kwargs(a) -> dict:
    return dict(fps=a.fps, aspect=a.aspect, start=a.start, duration=a.duration, density=a.density,
                order=a.order, offset_frames=a.offset, min_frames=a.min_frames,
                align_start=not a.no_align, seed=a.seed, title=a.title)


def _add_cut_opts(p):
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--aspect", choices=["16:9", "9:16", "1:1", "4:5"], default="16:9")
    p.add_argument("--start", type=float, default=0.0, help="music start (s)")
    p.add_argument("--duration", type=float, help="max output length (s)")
    p.add_argument("--density", choices=["auto", "beat", "half", "bar"], default="auto",
                   help="auto = every bar when calm, every 2 beats mid, every beat at high energy")
    p.add_argument("--order", choices=["energy", "chronological"], default="energy",
                   help="energy = match clip motion to music energy; chronological = keep story order")
    p.add_argument("--offset", type=int, default=0, help="cut N frames before the beat (1-2 often feels tighter)")
    p.add_argument("--min-frames", type=int, default=6, help="shortest allowed clip")
    p.add_argument("--no-align", action="store_true", help="do not snap start to the first downbeat")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--title", help="title overlay (forces the remotion engine)")


def _add_audio_opts(p):
    p.add_argument("--bpm", type=float, help="tempo hint if detection doubles/halves")
    p.add_argument("--meter", type=int, default=4, help="beats per bar")
    p.add_argument("--grid", choices=["auto", "fixed", "tracked", "dynamic"], default="auto",
                   help="fixed = constant tempo (produced music); tracked = follows live tempo drift without "
                        "off-beat flips; dynamic = raw librosa tracker; auto picks fixed/tracked")


def _add_render_opts(p):
    p.add_argument("--engine", choices=["auto", "ffmpeg", "remotion"], default="auto")
    p.add_argument("--no-punch", action="store_true", help="ffmpeg engine: disable zoom punch on downbeats")
    p.add_argument("--concurrency", type=int)
    p.add_argument("--crf", type=int, help="remotion engine: quality (lower = better, e.g. 15 for an upload master)")


def _add_motion_opts(p):
    p.add_argument("--title", required=True)
    p.add_argument("--subtitle", default="")
    p.add_argument("--palette", default="#FFEDD3,#FEB649,#895834", help="paper,accent,ink")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--aspect", choices=["16:9", "9:16", "1:1", "4:5"], default="16:9")
    p.add_argument("--start", type=float, default=0.0)
    p.add_argument("--duration", type=float, default=12.0)
    p.add_argument("--hero", choices=["first-downbeat", "drop"], default="first-downbeat")


def _motion_kwargs(a) -> dict:
    return dict(title=a.title, subtitle=a.subtitle, palette=a.palette.split(","), fps=a.fps, aspect=a.aspect,
                start=a.start, duration=a.duration, hero=a.hero)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="cutkiller", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("analyze-audio"); p.add_argument("audio"); _add_audio_opts(p); p.add_argument("-o", "--out")
    p.add_argument("--click", help="also write music+click WAV to check beats by ear")
    p = sub.add_parser("analyze-video"); p.add_argument("videos", nargs="+"); p.add_argument("-o", "--out")

    p = sub.add_parser("plan-cut"); p.add_argument("audio_analysis"); p.add_argument("video_analysis")
    p.add_argument("--audio", required=True, help="music file used for the soundtrack"); _add_cut_opts(p)
    p.add_argument("-o", "--out")

    p = sub.add_parser("plan-motion"); p.add_argument("audio_analysis")
    p.add_argument("--audio", required=True); _add_motion_opts(p); p.add_argument("-o", "--out")

    p = sub.add_parser("preview", help="contact sheet of key frames (Remotion) before a full render")
    p.add_argument("plan"); p.add_argument("-o", "--out", required=True)
    p.add_argument("--frames", help="comma-separated frame numbers (default: key frames)")

    p = sub.add_parser("render"); p.add_argument("plan"); p.add_argument("-o", "--out", required=True); _add_render_opts(p)

    p = sub.add_parser("cut", help="analyse + plan + render footage cut on the beat")
    p.add_argument("audio"); p.add_argument("videos", nargs="+"); p.add_argument("-o", "--out", required=True)
    p.add_argument("--plan-out", help="also save the plan JSON")
    _add_audio_opts(p); _add_cut_opts(p); _add_render_opts(p)

    p = sub.add_parser("motion", help="analyse + plan + render beat-synced motion design")
    p.add_argument("audio"); p.add_argument("-o", "--out", required=True); p.add_argument("--plan-out")
    _add_audio_opts(p); _add_motion_opts(p); p.add_argument("--concurrency", type=int)

    p = sub.add_parser("music", help="generate a royalty-free minimal electronic bed on an exact grid")
    p.add_argument("-o", "--out", required=True); p.add_argument("--bpm", type=float, default=120)
    p.add_argument("--build", type=int, default=1, help="bar where kicks start")
    p.add_argument("--drop", type=int, default=4, help="bar of the drop")
    p.add_argument("--end", type=int, default=8, help="bar of the final impact")

    p = sub.add_parser("demo", help="generate synthetic demo music + footage into demo/")
    p.add_argument("--bpm", type=float, default=128)

    a = ap.parse_args(argv)
    from .plan import plan_cut, plan_motion

    if a.cmd == "analyze-audio":
        data = _audio(a.audio, a.bpm, a.meter, a.grid)
        print(f"{data['bpm']} BPM, {len(data['beats'])} beats, {len(data['downbeats'])} bars, "
              f"drop={data['drop']}, grid={data['grid']}, sections={[s['level'] for s in data['sections']]}", file=sys.stderr)
        if a.click:
            from .audio import click_track
            print(f"wrote {click_track(a.audio, data, a.click)}", file=sys.stderr)
        _write(data, a.out)
    elif a.cmd == "analyze-video":
        data = _videos(a.videos)
        for v in data:
            print(f"{Path(v['src']).name}: {v['duration']}s, {len(v['shots'])} shots", file=sys.stderr)
        _write(data, a.out)
    elif a.cmd == "plan-cut":
        plan = plan_cut(json.loads(Path(a.audio_analysis).read_text()), json.loads(Path(a.video_analysis).read_text()),
                        audio_src=str(Path(a.audio).resolve()), **_cut_kwargs(a))
        _summary(plan); _write(plan, a.out)
    elif a.cmd == "plan-motion":
        plan = plan_motion(json.loads(Path(a.audio_analysis).read_text()), audio_src=str(Path(a.audio).resolve()),
                           **_motion_kwargs(a))
        _summary(plan); _write(plan, a.out)
    elif a.cmd == "preview":
        from .render import preview
        fr = [int(x) for x in a.frames.split(",")] if a.frames else None
        print(f"wrote {preview(json.loads(Path(a.plan).read_text()), a.out, fr)}", file=sys.stderr)
    elif a.cmd == "render":
        _render(json.loads(Path(a.plan).read_text()), a.out, a.engine, not a.no_punch, a.concurrency, a.crf)
    elif a.cmd == "cut":
        audio = _audio(a.audio, a.bpm, a.meter, a.grid)
        plan = plan_cut(audio, _videos(a.videos), audio_src=str(Path(a.audio).resolve()), **_cut_kwargs(a))
        _summary(plan)
        if a.plan_out:
            _write(plan, a.plan_out)
        _render(plan, a.out, a.engine, not a.no_punch, a.concurrency)
    elif a.cmd == "motion":
        audio = _audio(a.audio, a.bpm, a.meter, a.grid)
        plan = plan_motion(audio, audio_src=str(Path(a.audio).resolve()), **_motion_kwargs(a))
        _summary(plan)
        if a.plan_out:
            _write(plan, a.plan_out)
        _render(plan, a.out, "remotion", False, a.concurrency)
    elif a.cmd == "music":
        from .music import minimal_tech
        print(f"wrote {minimal_tech(a.out, a.bpm, a.build, a.drop, a.end)} "
              f"(drop at {a.drop * 240 / a.bpm:.2f}s, impact at {a.end * 240 / a.bpm:.2f}s)", file=sys.stderr)
    elif a.cmd == "demo":
        from .synth import demo_track, demo_video
        Path("demo").mkdir(exist_ok=True)
        demo_track(f"demo/track-{int(a.bpm)}.wav", bpm=a.bpm)
        demo_video("demo/footage-a.mp4", [0, 1, 2, 3])
        demo_video("demo/footage-b.mp4", [4, 5, 1, 0], shot_len=3.0)
        print("wrote demo/track-*.wav, demo/footage-a.mp4, demo/footage-b.mp4", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
