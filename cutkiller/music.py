"""Royalty-free minimal electronic bed, built to a known grid so edits land exactly on it.

Structure (bars of 4 beats):
  intro  [0, build)        filtered pad + 16th ticks + data blips
  build  [build, drop)     kick, off-beat hats, sub; last bar: snare roll + riser + gap
  drop   [drop, end)       kick, clap, pumping bass, chord stabs
  end    at `end` bar      impact + reverb tail
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
A_MINOR_PROG = [  # Am - F - C - G (MIDI notes)
    [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
]


def _hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def _lp(x: np.ndarray, cutoff) -> np.ndarray:
    """One-pole low-pass; cutoff may be a per-sample array (Hz)."""
    c = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = 1 - np.exp(-2 * np.pi * c / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def _saw(f: float, n: int, detune: float = 0.0, seed: int = 0) -> np.ndarray:
    t = np.arange(n) / SR
    ph = np.random.default_rng(seed).uniform(0, 1)
    out = np.zeros(n)
    for d in (-detune, 0.0, detune):
        out += 2 * ((t * f * (1 + d) + ph) % 1.0) - 1
    return out / 3


def _env(n: int, a: float, d: float) -> np.ndarray:
    t = np.arange(n) / SR
    return np.minimum(1.0, t / max(a, 1e-4)) * np.exp(-t / max(d, 1e-4))


def _reverb(x: np.ndarray, seconds: float = 1.6, mix: float = 0.25, seed: int = 3) -> np.ndarray:
    n = int(seconds * SR)
    ir = np.random.default_rng(seed).standard_normal(n) * np.exp(-np.arange(n) / SR * 4.5)
    ir = _lp(ir, 5000)
    wet = np.fft.irfft(np.fft.rfft(x, len(x) + n) * np.fft.rfft(ir, len(x) + n))[: len(x)]
    wet /= np.abs(wet).max() + 1e-9
    return (1 - mix) * x + mix * wet * (np.abs(x).max() + 1e-9)


def minimal_tech(out: str | Path, bpm: float = 120, build: int = 1, drop: int = 4, end: int = 8,
                 tail: float = 1.6, seed: int = 4) -> Path:
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    bar = 4 * beat
    total = end * bar + tail
    N = int(total * SR)
    drums, bass, music, fx = (np.zeros(N) for _ in range(4))

    def put(buf, sig, t):
        i = int(round(t * SR))
        if i >= N:
            return
        j = min(N, i + len(sig))
        buf[i:j] += sig[: j - i]

    def kick(amp=1.0):
        n = int(0.4 * SR)
        t = np.arange(n) / SR
        f = 45 + 110 * np.exp(-t * 38)
        body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5)
        click = rng.standard_normal(n) * np.exp(-t * 400) * 0.25
        return amp * np.tanh(1.6 * (body + click))

    def hat(amp, decay=60.0, dur=0.08):
        n = int(dur * SR)
        x = np.diff(rng.standard_normal(n + 1)) * np.exp(-np.arange(n) / SR * decay)
        return amp * (x - _lp(x, 7000))

    def clap(amp):
        n = int(0.25 * SR)
        x = rng.standard_normal(n)
        e = np.zeros(n)
        for k, o in enumerate((0, 0.011, 0.022)):
            i = int(o * SR)
            e[i:] += np.exp(-np.arange(n - i) / SR * (60 if k < 2 else 16))
        x = (x - _lp(x, 900)) * e
        return amp * _lp(x, 6000)

    def blip(m, amp):
        n = int(0.12 * SR)
        t = np.arange(n) / SR
        return amp * np.sin(2 * np.pi * _hz(m) * t) * np.exp(-t * 35)

    # ---- intro: pad + ticks + blips
    pad_end = drop * bar
    for b in range(0, drop):
        chord = A_MINOR_PROG[0]
        n = int(bar * SR)
        x = sum(_saw(_hz(m), n, 0.004, seed=b * 7 + k) for k, m in enumerate(chord))
        open_ = np.linspace(300, 1200 + 900 * b / max(1, drop), n)
        put(music, 0.18 * _lp(x, open_) * np.minimum(1, np.arange(n) / (0.6 * SR) + (b > 0)), b * bar)
    for k in range(int(drop * 16)):
        t = k * beat / 4
        if t >= pad_end:
            break
        put(drums, hat(0.05 + 0.04 * (k % 4 == 2), decay=120, dur=0.04), t)
    for k, m in enumerate([81, 84, 88, 86, 81, 79, 84, 76]):
        put(fx, blip(m, 0.07), k * beat / 2 + 3 * beat / 4)

    # ---- build
    for b in range(build, drop):
        for q in range(4):
            t = b * bar + q * beat
            last_bar = b == drop - 1
            if last_bar and q == 3:
                continue  # gap before the drop
            put(drums, kick(0.85), t)
            put(drums, hat(0.12, decay=25, dur=0.15), t + beat / 2)
            n = int(beat * SR)
            sub = np.sin(2 * np.pi * _hz(33) * np.arange(n) / SR) * np.minimum(1, np.arange(n) / (0.12 * SR))
            put(bass, 0.35 * sub * np.exp(-np.arange(n) / SR * 3), t + 0.06)
    # snare roll + riser into the drop
    roll_start = (drop - 1) * bar
    k = 0
    t = roll_start
    while t < drop * bar - beat:
        put(drums, clap(0.15 + 0.35 * (t - roll_start) / (3 * beat)), t)
        step = beat / (2 if t < roll_start + 2 * beat else 4)
        t += step
        k += 1
    n = int(bar * SR)
    noise = rng.standard_normal(n)
    sweep = _lp(noise, np.linspace(400, 9000, n)) * np.linspace(0, 1, n) ** 2
    sweep[int(3.5 * beat * SR):] = 0
    put(fx, 0.35 * sweep, roll_start)

    # ---- drop
    for b in range(drop, end):
        chord = A_MINOR_PROG[(b - drop) % 4]
        root = chord[0] - 24
        for q in range(4):
            t = b * bar + q * beat
            put(drums, kick(1.0), t)
            put(drums, hat(0.16, decay=22, dur=0.16), t + beat / 2)
            for s in (0.25, 0.75):
                put(drums, hat(0.06, decay=140, dur=0.04), t + s * beat)
            if q in (1, 3):
                put(drums, clap(0.45), t)
            # pumping bass on the off-beats
            n = int(beat / 2 * SR)
            x = _saw(_hz(root), n, 0.003, seed=b * 4 + q)
            put(bass, 0.32 * _lp(x, 450) * _env(n, 0.01, 0.18), t + beat / 2)
            # chord stab
            n = int(0.35 * SR)
            st = sum(_saw(_hz(m + 12), n, 0.006, seed=q + m) for m in chord)
            put(music, 0.14 * _lp(st, 2600) * _env(n, 0.003, 0.09), t + beat / 2)

    # ---- end impact
    t_end = end * bar
    n = int(tail * SR)
    tt = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(30 + 60 * np.exp(-tt * 9)) / SR) * np.exp(-tt * 2.2)
    put(fx, 0.9 * boom, t_end)
    put(fx, 0.25 * _lp(rng.standard_normal(n), 2500) * np.exp(-tt * 3), t_end)
    stab = sum(_saw(_hz(m), n, 0.006, seed=m) for m in A_MINOR_PROG[0])
    put(music, 0.16 * _lp(stab, 1800) * _env(n, 0.002, 0.6), t_end)

    # sidechain-style ducking of music/bass on drop kicks
    duck = np.ones(N)
    for b in range(drop, end):
        for q in range(4):
            i = int((b * bar + q * beat) * SR)
            n = int(beat * SR)
            j = min(N, i + n)
            duck[i:j] = np.minimum(duck[i:j], 0.35 + 0.65 * np.minimum(1, np.arange(j - i) / (0.18 * SR)))
    mix = drums + duck * (bass + _reverb(music, 1.8, 0.3)) + _reverb(fx, 2.0, 0.35)
    mix = np.tanh(1.3 * mix) / np.tanh(1.3)
    mix *= 0.89 / (np.abs(mix).max() + 1e-9)
    stereo = np.stack([mix, mix], axis=1)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, stereo, SR)
    return out
