"""Synthetic demo / test assets (no copyrighted media needed).

* demo_track : drum track with a quiet intro, a build and a loud drop
* demo_video : footage made of several visually distinct shots (known cut times)
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100


def _kick(sr: int, amp: float) -> np.ndarray:
    t = np.arange(int(0.35 * sr)) / sr
    f = 50 + 90 * np.exp(-t * 30)
    return amp * np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * 9)


def _noise(sr: int, dur: float, decay: float, amp: float, hp: bool, rng) -> np.ndarray:
    n = rng.standard_normal(int(dur * sr))
    if hp:
        n = np.diff(n, prepend=0)
    t = np.arange(len(n)) / sr
    return amp * n * np.exp(-t * decay)


def demo_track(path: str | Path, bpm: float = 128, bars: int = 16, intro_bars: int = 4,
               build_bars: int = 4, seed: int = 1) -> Path:
    """4/4 drums. Downbeats carry the loudest kick, so bar phase is recoverable."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    lead = 0.5  # silence before first downbeat
    total = lead + bars * 4 * beat + 1.0
    y = np.zeros(int(total * SR))

    def add(sig, t):
        i = int(t * SR)
        j = min(len(y), i + len(sig))
        y[i:j] += sig[: j - i]

    for bar in range(bars):
        phase = 0 if bar < intro_bars else (1 if bar < intro_bars + build_bars else 2)
        for k in range(4):
            t = lead + (bar * 4 + k) * beat
            kick_amp = [0.35, 0.6, 0.95][phase] * (1.0 if k == 0 else 0.55)
            if phase > 0 or k == 0:
                add(_kick(SR, kick_amp), t)
            if phase >= 1 and k in (1, 3):
                add(_noise(SR, 0.18, 22, [0, 0.25, 0.4][phase], False, rng), t)
            add(_noise(SR, 0.05, 80, [0.08, 0.1, 0.14][phase], True, rng), t + beat / 2)
            if phase == 2:  # bass on 8ths
                tt = np.arange(int(beat / 2 * SR)) / SR
                rel = np.minimum(1.0, (tt[-1] - tt) / 0.01)  # 10 ms release: no click at note-off
                note = 0.18 * np.sign(np.sin(2 * np.pi * 55 * tt)) * np.exp(-tt * 4) * rel
                add(note, t)
                add(note, t + beat / 2)
    y /= np.abs(y).max() + 1e-9
    y *= 0.9
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(path, y, SR)
    return path


LAVFI_SHOTS = [
    "testsrc2=size=640x360:rate=30",
    "life=size=640x360:rate=30:mold=10:ratio=0.3:death_color=#1a1a40:life_color=#ffcc33",
    "mandelbrot=size=640x360:rate=30",
    "smptehdbars=size=640x360:rate=30",
    "cellauto=size=640x360:rate=30:rule=110",
    "gradients=size=640x360:rate=30:speed=0.05",
]


def demo_video(path: str | Path, shots: list[int], shot_len: float = 4.0) -> Path:
    """Concatenate lavfi sources -> one video with hard cuts every `shot_len` seconds."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for s in shots:
        cmd += ["-f", "lavfi", "-t", str(shot_len), "-i", LAVFI_SHOTS[s % len(LAVFI_SHOTS)]]
    chains = "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(len(shots)))
    chains += "".join(f"[v{i}]" for i in range(len(shots))) + f"concat=n={len(shots)}:v=1:a=0[out]"
    cmd += ["-filter_complex", chains, "-map", "[out]", "-c:v", "libx264", "-preset", "veryfast",
            "-crf", "23", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True)
    return path
