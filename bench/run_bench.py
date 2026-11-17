"""Reproducible render benchmark for CutKiller.

Generates its own fixtures (lavfi test sources, synthetic music and SFX), runs two scenarios
in-process through the real CLI entry point, and records:

- wall time (median of N runs) and time per stage (listen, sounds, photos, transitions, timeline, mix)
- number of ffmpeg / ffprobe processes, video encodes and audio encodes
- CPU time (parent + children), output size and stream properties
- loudness of the output (ebur128: integrated LUFS, true peak)
- image quality: SSIM / PSNR against the same pipeline rendered losslessly (x264 -qp 0),
  i.e. the degradation added by the lossy encoding chain only.

Usage:
    python bench/run_bench.py                      # print results
    python bench/run_bench.py --save baseline      # write bench/baseline.json
    python bench/run_bench.py --compare baseline   # compare with bench/baseline.json
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import re
import resource
import shutil
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORK = ROOT / ".work"
FIX = WORK / "fixtures"

# ----------------------------------------------------------------------------- fixtures


def _ff(*args: str) -> None:
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-hide_banner", "-v", "error", *args], check=True)


def make_fixtures() -> dict[str, Path]:
    FIX.mkdir(parents=True, exist_ok=True)
    f = {
        "talk": FIX / "talk.mp4",
        "music": FIX / "music.wav",
        "whoosh": FIX / "whoosh.wav",
        **{f"clip{k}": FIX / f"clip{k}.mp4" for k in range(6)},
        "clip4k": FIX / "clip4k.mp4",
        "vertical": FIX / "vertical.mp4",
        "photo0": FIX / "photo0.png",
        "photo1": FIX / "photo1.png",
    }
    noise = "noise=alls=2:allf=t"  # light sensor-like grain: makes encoding non-trivial
    phone = ["-c:v", "libx264", "-b:v", "12M", "-maxrate", "16M", "-bufsize", "24M", "-preset", "veryfast", "-g", "60"]
    if not f["talk"].exists():
        # 60 s, 1080p30, "speech" = 440 Hz tone 2.2 s on / 0.8 s off (silences to cut)
        _ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi",
            "-i", "aevalsrc='0.3*sin(2*PI*440*t)*lt(mod(t,3),2.2)':s=48000:c=stereo", "-t", "60",
            "-vf", noise, *phone,
            "-c:a", "aac", "-b:a", "192k", "-shortest", str(f["talk"]))
    for k in range(6):
        if not f[f"clip{k}"].exists():
            _ff("-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-f", "lavfi",
                "-i", f"sine=frequency={300 + 50 * k}:sample_rate=48000", "-t", "20",
                "-vf", f"hue=h={60 * k},{noise}", *phone, "-c:a", "aac", "-shortest", str(f[f"clip{k}"]))
    if not f["clip4k"].exists():
        _ff("-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30", "-t", "10", "-vf", noise,
            *phone, str(f["clip4k"]))
    if not f["vertical"].exists():
        _ff("-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30", "-t", "15", "-vf", noise,
            *phone, str(f["vertical"]))
    for k in range(2):
        if not f[f"photo{k}"].exists():
            _ff("-f", "lavfi", "-i", f"testsrc2=size=3000x2000:rate=1,hue=h={90 * k}", "-frames:v", "1",
                str(f[f"photo{k}"]))
    if not f["music"].exists():
        # 45 s, 120 BPM: decaying kick every 0.5 s + bass line
        _ff("-f", "lavfi", "-i",
            "aevalsrc='0.7*sin(2*PI*55*t)*exp(-25*mod(t,0.5))+0.12*sin(2*PI*110*t)':s=48000:c=stereo",
            "-t", "45", str(f["music"]))
    if not f["whoosh"].exists():
        _ff("-f", "lavfi", "-i", "anoisesrc=d=0.6:c=pink:a=0.5", "-af",
            "afade=t=in:d=0.4,afade=t=out:st=0.4:d=0.2,aformat=channel_layouts=stereo", str(f["whoosh"]))
    return f


def scenarios(f: dict[str, Path], out: Path) -> dict[str, list[str]]:
    clips = [str(f[f"clip{k}"]) for k in range(6)]
    return {
        # primary use case: beat-synced montage, vertical, mixed sources (1080p, 4K, vertical, photos)
        "montage": ["montage", clips[0], clips[1], str(f["photo0"]), clips[2], str(f["clip4k"]), clips[3],
                    str(f["vertical"]), clips[4], str(f["photo1"]), clips[5],
                    "--music", str(f["music"]), "--size", "1080x1920", "--beats-per-clip", "4",
                    "--transition", "fade|fx:zoom_punch|slideleft|fx:whip_left", "--seed", "1",
                    "--sfx", f"{f['whoosh']}@transitions", "--sfx-align", "peak",
                    "-o", str(out / "montage.mp4")],
        # talking head: silence cuts + punch-in + a transition every 4 cuts + music + sfx
        "auto": ["auto", str(f["talk"]), "--punch-in", "1.15", "--transition", "fade", "--transition-every", "4",
                 "--music", str(f["music"]), "--sfx", f"{f['whoosh']}@cuts", "--sfx-spacing", "4",
                 "-o", str(out / "auto.mp4")],
    }


# ----------------------------------------------------------------------------- instrumentation

_real_popen = subprocess.Popen


def _real_run(cmd, **k):
    with _real_popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=k.get("text", False),
                     cwd=k.get("cwd")) as p:
        out, err = p.communicate()
    if k.get("check") and p.returncode:
        raise subprocess.CalledProcessError(p.returncode, cmd, out, err)
    return subprocess.CompletedProcess(cmd, p.returncode, out, err)


class Recorder:
    """Counts external processes; optionally rewrites x264 options to lossless (reference render)."""

    def __init__(self, lossless: bool = False):
        self.lossless = lossless
        self.counts: dict[str, int] = defaultdict(int)
        self.stages: dict[str, float] = defaultdict(float)

    def _inspect(self, cmd):
        if not isinstance(cmd, (list, tuple)) or not cmd:
            return cmd
        exe = Path(str(cmd[0])).name.lower()
        if exe.startswith("ffprobe"):
            self.counts["ffprobe"] += 1
        elif exe.startswith("ffmpeg"):
            self.counts["ffmpeg"] += 1
            args = [str(c) for c in cmd]
            vcodecs = [args[i + 1] for i, a in enumerate(args[:-1]) if a in ("-c:v", "-vcodec", "-codec:v")]
            vcodecs = [c for c in vcodecs if c != "copy"]
            if vcodecs:
                self.counts["video_encodes"] += 1
            if any(args[i + 1] == "aac" for i, a in enumerate(args[:-1]) if a in ("-c:a", "-acodec")):
                self.counts["aac_encodes"] += 1
            if self.lossless and "libx264" in vcodecs:
                cmd = _lossless(args)
        return cmd

    @contextlib.contextmanager
    def install(self):
        rec = self

        # subprocess.run goes through subprocess.Popen: patching Popen alone sees every process once
        class Popen(_real_popen):  # noqa: N801
            def __init__(self, cmd, *a, **k):
                super().__init__(rec._inspect(cmd), *a, **k)

        subprocess.Popen = Popen
        try:
            yield self
        finally:
            subprocess.Popen = _real_popen


def _lossless(args: list[str]) -> list[str]:
    out, skip = [], False
    drop = {"-crf", "-preset", "-tune", "-profile:v", "-level", "-b:v", "-maxrate", "-bufsize", "-x264-params", "-cq",
            "-rc", "-qp"}
    for i, a in enumerate(args):
        if skip:
            skip = False
            continue
        if a in drop and i < len(args) - 1:
            skip = True
            continue
        out.append(a)
    k = out.index("libx264") + 1
    return out[:k] + ["-qp", "0", "-preset", "ultrafast"] + out[k:]


# Stage timing: wrap pipeline functions by name. Missing names are ignored, so the bench keeps
# working while the code evolves (a renamed stage simply disappears from the breakdown).
STAGES = {
    "listen": [("cutkiller.listen", "listen")],
    "sounds": [("cutkiller.cli", "_prepare_mix")],
    "photos": [("cutkiller.edit.montage", "photo_to_clip")],
    "transitions": [("cutkiller.edit.timeline", "render_transition")],
    "timeline": [("cutkiller.edit.timeline", "render_timeline")],
    "mix": [("cutkiller.edit.mixer", "render_mix")],
}


@contextlib.contextmanager
def stage_timers(rec: Recorder):
    import importlib

    patched = []
    for stage, targets in STAGES.items():
        for mod_name, attr in targets:
            try:
                mod = importlib.import_module(mod_name)
            except ImportError:
                continue
            fn = getattr(mod, attr, None)
            if fn is None:
                continue

            def wrapper(*a, __fn=fn, __stage=stage, **k):
                t0 = time.perf_counter()
                try:
                    return __fn(*a, **k)
                finally:
                    rec.stages[__stage] += time.perf_counter() - t0

            # patch the defining module and every module that imported the name
            for m in list(sys.modules.values()):
                if m and getattr(m, "__name__", "").startswith("cutkiller") and getattr(m, attr, None) is fn:
                    setattr(m, attr, wrapper)
                    patched.append((m, attr, fn))
    try:
        yield
    finally:
        for m, attr, fn in patched:
            setattr(m, attr, fn)


def _children_cpu() -> float:
    r = resource.getrusage(resource.RUSAGE_CHILDREN)
    s = resource.getrusage(resource.RUSAGE_SELF)
    return r.ru_utime + r.ru_stime + s.ru_utime + s.ru_stime


def run_scenario(argv: list[str], lossless: bool = False) -> dict:
    from cutkiller.cli import main

    rec = Recorder(lossless=lossless)
    cpu0, t0 = _children_cpu(), time.perf_counter()
    with rec.install(), stage_timers(rec), open(os.devnull, "w") as devnull, contextlib.redirect_stdout(devnull):
        code = main(argv)
    wall = time.perf_counter() - t0
    if code != 0:
        raise RuntimeError(f"cutkiller {' '.join(argv[:2])} returned {code}")
    stages = dict(rec.stages)
    # transitions are rendered inside render_timeline: report the timeline's own share
    if "timeline" in stages and "transitions" in stages:
        stages["timeline"] = max(0.0, stages["timeline"] - stages["transitions"])
    return {"wall_s": wall, "cpu_s": _children_cpu() - cpu0, "stages_s": stages, "counts": dict(rec.counts)}


# ----------------------------------------------------------------------------- measures


def probe_out(path: Path) -> dict:
    out = _real_run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                    capture_output=True, text=True, check=True)
    d = json.loads(out.stdout)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), {})
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), {})
    head = path.read_bytes()[: 1 << 16]
    moov, mdat = head.find(b"moov"), head.find(b"mdat")
    return {
        "size_mb": round(path.stat().st_size / 1e6, 3),
        "duration_s": round(float(d["format"]["duration"]), 3),
        "bitrate_kbps": round(int(d["format"].get("bit_rate", 0)) / 1000),
        "video": {k: v.get(k) for k in ("codec_name", "profile", "pix_fmt", "width", "height", "avg_frame_rate",
                                        "color_space", "color_primaries", "color_transfer", "color_range")},
        "audio": {k: a.get(k) for k in ("codec_name", "sample_rate", "channels", "bit_rate")},
        "faststart": moov != -1 and (mdat == -1 or moov < mdat),
    }


def loudness(path: Path) -> dict:
    r = _real_run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-vn", "-af", "ebur128=peak=true",
                   "-f", "null", "-"], capture_output=True, text=True)
    s = r.stderr[r.stderr.rfind("Summary:"):]
    get = lambda rx: (lambda m: float(m.group(1)) if m else None)(re.search(rx, s))  # noqa: E731
    return {"integrated_lufs": get(r"I:\s+(-?[\d.]+) LUFS"), "true_peak_dbtp": get(r"Peak:\s+(-?[\d.]+) dBFS"),
            "lra_lu": get(r"LRA:\s+(-?[\d.]+) LU")}


def quality(dist: Path, ref: Path) -> dict:
    r = _real_run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(dist), "-i", str(ref), "-lavfi",
                   "[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]ssim;"
                   "[0:v]setpts=PTS-STARTPTS[d2];[1:v]setpts=PTS-STARTPTS[r2];[d2][r2]psnr",
                   "-f", "null", "-"], capture_output=True, text=True)
    ssim = re.search(r"SSIM .*All:([\d.]+)", r.stderr)
    psnr = re.search(r"PSNR .*average:([\d.inf]+)", r.stderr)
    return {"ssim": float(ssim.group(1)) if ssim else None,
            "psnr_db": float(psnr.group(1)) if psnr and psnr.group(1) != "inf" else None}


# ----------------------------------------------------------------------------- main


def bench(runs: int, only: list[str] | None) -> dict:
    f = make_fixtures()
    out = WORK / "out"
    ref_dir = WORK / "ref"
    out.mkdir(parents=True, exist_ok=True)
    ref_dir.mkdir(parents=True, exist_ok=True)
    results = {}
    for name, argv in scenarios(f, out).items():
        if only and name not in only:
            continue
        print(f"[{name}] {runs} run(s)…", file=sys.stderr)
        samples = [run_scenario(argv) for _ in range(runs)]
        best = min(samples, key=lambda s: s["wall_s"])
        target = Path(argv[argv.index("-o") + 1])
        res = {
            "wall_s_median": round(statistics.median(s["wall_s"] for s in samples), 2),
            "wall_s_all": [round(s["wall_s"], 2) for s in samples],
            "cpu_s": round(best["cpu_s"], 1),
            "stages_s": {k: round(v, 2) for k, v in sorted(best["stages_s"].items(), key=lambda kv: -kv[1])},
            "counts": best["counts"],
            "output": probe_out(target),
            "loudness": loudness(target),
        }
        print(f"[{name}] reference render (lossless)…", file=sys.stderr)
        ref_argv = list(argv)
        ref_target = ref_dir / f"{name}.mkv"
        ref_argv[argv.index("-o") + 1] = str(ref_target)
        run_scenario(ref_argv, lossless=True)
        res["quality_vs_lossless"] = quality(target, ref_target)
        ref_target.unlink(missing_ok=True)  # lossless renders are large
        results[name] = res
        print(f"[{name}] {res['wall_s_median']} s, SSIM {res['quality_vs_lossless']['ssim']}", file=sys.stderr)
    return results


def environment() -> dict:
    ver = _real_run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    commit = _real_run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=ROOT).stdout.strip()
    return {"commit": commit, "python": platform.python_version(), "ffmpeg": ver, "cpus": os.cpu_count(),
            "platform": platform.platform(), "gpu": shutil.which("nvidia-smi") is not None}


def compare(base: dict, cur: dict) -> str:
    rows = ["| Scénario | Mesure | Baseline | Actuel | Delta |", "|---|---|---|---|---|"]

    def row(sc, label, b, c, pct=True):
        if b is None or c is None:
            delta = "n/a"
        elif pct and b:
            delta = f"{(c - b) / b * 100:+.1f} %"
        else:
            delta = f"{c - b:+.4g}"
        rows.append(f"| {sc} | {label} | {b} | {c} | {delta} |")

    for sc in cur["results"]:
        b, c = base["results"].get(sc), cur["results"][sc]
        if not b:
            continue
        row(sc, "temps total (s)", b["wall_s_median"], c["wall_s_median"])
        row(sc, "CPU (s)", b["cpu_s"], c["cpu_s"])
        for k in sorted(set(b["stages_s"]) | set(c["stages_s"])):
            row(sc, f"étape {k} (s)", b["stages_s"].get(k), c["stages_s"].get(k))
        for k in sorted(set(b["counts"]) | set(c["counts"])):
            row(sc, k, b["counts"].get(k, 0), c["counts"].get(k, 0), pct=False)
        row(sc, "taille (Mo)", b["output"]["size_mb"], c["output"]["size_mb"])
        row(sc, "SSIM", b["quality_vs_lossless"]["ssim"], c["quality_vs_lossless"]["ssim"], pct=False)
        row(sc, "PSNR (dB)", b["quality_vs_lossless"]["psnr_db"], c["quality_vs_lossless"]["psnr_db"], pct=False)
        row(sc, "LUFS", b["loudness"]["integrated_lufs"], c["loudness"]["integrated_lufs"], pct=False)
        row(sc, "true peak (dBTP)", b["loudness"]["true_peak_dbtp"], c["loudness"]["true_peak_dbtp"], pct=False)
    return "\n".join(rows)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--only", action="append", help="scenario name (repeatable)")
    ap.add_argument("--save", metavar="NAME", help="write bench/<NAME>.json")
    ap.add_argument("--compare", metavar="NAME", help="compare with bench/<NAME>.json")
    a = ap.parse_args()
    data = {"env": environment(), "runs": a.runs, "results": bench(a.runs, a.only)}
    print(json.dumps(data, indent=1, ensure_ascii=False))
    if a.save:
        (ROOT / f"{a.save}.json").write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    if a.compare:
        base = json.loads((ROOT / f"{a.compare}.json").read_text(encoding="utf-8"))
        print("\n" + compare(base, data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
