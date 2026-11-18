"""Measures the features against the workflow they replace (same fixtures as run_bench.py).

F2 one-pass finishing: `montage --look film --text …` vs the former chain
   `montage` → `texture --look film` → `text …` (3 full encodes).
F5 draft: `montage --draft` vs the full render.

Quality: SSIM/PSNR against the same command rendered losslessly (x264 -qp 0), frames paired by index.

    python bench/features_bench.py [--runs 3]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_bench as rb  # noqa: E402


def _montage(f, out: Path, *extra: str) -> list[str]:
    clips = [str(f[f"clip{k}"]) for k in range(6)]
    return ["montage", clips[0], clips[1], str(f["photo0"]), clips[2], clips[3], "--music", str(f["music"]),
            "--size", "1080x1920", "--transition", "fade|fx:zoom_punch", "--seed", "1", *extra, "-o", str(out)]


def _chain(steps: list[list[str]], lossless: bool = False) -> dict:
    tot = {"wall_s": 0.0, "counts": {}}
    for argv in steps:
        r = rb.run_scenario(argv, lossless=lossless)
        tot["wall_s"] += r["wall_s"]
        for k, v in r["counts"].items():
            tot["counts"][k] = tot["counts"].get(k, 0) + v
    return tot


def measure(name: str, steps_for, runs: int, work: Path) -> dict:
    out = work / f"{name}.mp4"
    samples = [_chain(steps_for(out)) for _ in range(runs)]
    ref = work / f"{name}_ref.mkv"
    _chain(steps_for(ref), lossless=True)
    fps = 30.0
    q = rb.quality(out, ref, fps)
    ref.unlink(missing_ok=True)
    return {"wall_s_median": round(statistics.median(s["wall_s"] for s in samples), 2),
            "video_encodes": samples[0]["counts"].get("video_encodes", 0), **q,
            "size_mb": round(out.stat().st_size / 1e6, 3)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    a = ap.parse_args()
    f = rb.make_fixtures()
    work = rb.WORK / "features"
    work.mkdir(parents=True, exist_ok=True)
    text = ["--text", "CUTKILLER@0-3:center:yellow"]

    def chain(out: Path):
        stem = out.with_suffix("")
        m, t = Path(f"{stem}_m.mp4"), Path(f"{stem}_t.mp4")
        return [_montage(f, m), ["texture", str(m), "--look", "film", "-o", str(t)],
                ["text", str(t), *text, "-o", str(out)]]

    res = {
        "F2_chain_montage_texture_text": measure("chain", chain, a.runs, work),
        "F2_one_pass": measure("onepass", lambda out: [_montage(f, out, "--look", "film", *text)], a.runs, work),
        "F5_full": measure("full", lambda out: [_montage(f, out)], a.runs, work),
        "F5_draft": {"wall_s_median": round(statistics.median(
            rb.run_scenario(_montage(f, work / "draft.mp4", "--draft"))["wall_s"] for _ in range(a.runs)), 2)},
    }
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
