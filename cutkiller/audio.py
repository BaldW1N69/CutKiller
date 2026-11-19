"""Audio analysis: beats, downbeats, onsets, energy curve and energy sections.

Output is a plain dict (JSON-serialisable) consumed by the planner.

Improvements over a naive `librosa.beat.beat_track` call:
  * sub-frame beat refinement on a high-resolution onset envelope (~6 ms grid);
  * downbeat (bar phase) estimation from low-frequency (kick) onsets;
  * per-beat strength + loudness, so cuts and accents can be weighted;
  * bar-level energy sections (low / mid / high) that drive cut density;
  * "drop" detection (largest energy jump) for hero moments.
"""
from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np

SR = 22050
HOP = 512          # beat-tracking resolution (~23 ms)
HOP_FINE = 128     # refinement resolution (~5.8 ms)
REFINE_WINDOW = 0.035  # seconds searched around each beat


def _norm(x: np.ndarray, lo_q: float = 5, hi_q: float = 95) -> np.ndarray:
    if x.size == 0:
        return x
    lo, hi = np.percentile(x, lo_q), np.percentile(x, hi_q)
    if hi - lo < 1e-9:
        return np.full_like(x, 0.5, dtype=float)
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def _refine(beat_times: np.ndarray, env_fine: np.ndarray, sr: int) -> np.ndarray:
    """Snap each beat to the strongest fine-grained onset peak nearby."""
    out = beat_times.copy()
    w = int(REFINE_WINDOW * sr / HOP_FINE)
    floor = np.median(env_fine) + 1e-9
    for i, t in enumerate(beat_times):
        c = int(round(t * sr / HOP_FINE))
        a, b = max(0, c - w), min(len(env_fine), c + w + 1)
        if b <= a:
            continue
        k = a + int(np.argmax(env_fine[a:b]))
        if env_fine[k] > 2.0 * floor:  # only move on a real transient
            out[i] = librosa.frames_to_time(k, sr=sr, hop_length=HOP_FINE)
    return out


def _sample(env: np.ndarray, times: np.ndarray, sr: int, hop: int, win: int = 2) -> np.ndarray:
    """Max of an envelope in a small window around each time."""
    idx = np.round(times * sr / hop).astype(int)
    vals = []
    for c in idx:
        a, b = max(0, c - win), min(len(env), c + win + 1)
        vals.append(float(env[a:b].max()) if b > a else 0.0)
    return np.asarray(vals)


def _downbeat_phase(low_at_beats: np.ndarray, full_at_beats: np.ndarray, beats_per_bar: int) -> int:
    """Pick the bar phase whose beats carry the most low-end (kick) energy."""
    if len(low_at_beats) < beats_per_bar:
        return 0
    score = 0.7 * _norm(low_at_beats) + 0.3 * _norm(full_at_beats)
    phases = [score[p::beats_per_bar].mean() for p in range(beats_per_bar)]
    return int(np.argmax(phases))


def _sections(bar_energy: np.ndarray, bar_times: np.ndarray, duration: float, min_bars: int = 2):
    if len(bar_energy) == 0:
        return []
    # smooth over neighbouring bars so a single fill does not flip the level
    k = np.ones(3) / 3
    smooth = np.convolve(np.pad(bar_energy, 1, mode="edge"), k, mode="valid")
    levels = np.where(smooth >= 0.66, 2, np.where(smooth >= 0.33, 1, 0))
    # merge runs shorter than min_bars into the previous run
    runs: list[list[int]] = []  # [level, start_bar, end_bar_exclusive]
    for i, lv in enumerate(levels):
        if runs and runs[-1][0] == lv:
            runs[-1][2] = i + 1
        else:
            runs.append([int(lv), i, i + 1])
    merged: list[list[int]] = []
    for r in runs:
        if merged and ((r[2] - r[1]) < min_bars or merged[-1][0] == r[0]):
            merged[-1][2] = r[2]  # absorb short runs, and re-join equal neighbours
        else:
            merged.append(r)
    names = {0: "low", 1: "mid", 2: "high"}
    out = []
    for lv, a, b in merged:
        start = float(bar_times[a])
        end = float(bar_times[b]) if b < len(bar_times) else duration
        out.append({
            "start": round(start, 4),
            "end": round(end, 4),
            "level": names[lv],
            "energy": round(float(bar_energy[a:b].mean()), 4),
        })
    return out


def _octave_fix(bpm: float, beat_times: np.ndarray, env_low: np.ndarray, sr: int) -> float:
    """Halve a doubled tempo when only every other beat carries a kick (e.g. 72 BPM read as 144)."""
    if bpm < 125 or len(beat_times) < 16:
        return bpm
    low = _sample(env_low, beat_times, sr, HOP)
    even, odd = low[0::2].mean(), low[1::2].mean()
    lo, hi = sorted((even, odd))
    if hi > 0 and lo / hi < 0.35 and bpm / 2 >= 60:
        return bpm / 2
    return bpm


def _fit_grid(bpm: float, env: np.ndarray, sr: int, duration: float) -> tuple[float, float]:
    """Constant-tempo grid (period, phase) maximising onset energy over the whole track."""
    t_env = np.arange(len(env)) * HOP_FINE / sr

    def search(periods, best):
        for p in periods:
            grid = np.arange(0, duration - p, p)
            for ph in np.arange(0, p, 0.004):
                v = np.interp(grid + ph, t_env, env).mean()
                if v > best[2]:
                    best = (p, ph, v)
        return best

    # coarse (+-4%: the DP tracker's tempo is quantised and can be off by >1%), then fine
    p0 = 60.0 / bpm
    best = search(np.linspace(p0 * 0.96, p0 * 1.04, 81), (p0, 0.0, -1.0))
    pc = best[0]
    best = search(np.linspace(pc * 0.999, pc * 1.001, 41), best)
    return best[0], best[1]


def _grid_drift(period: float, phase: float, env: np.ndarray, sr: int, t0: float, t1: float, win: int = 16) -> float:
    """90th percentile of the local phase error (in beats) of a fixed grid, measured per 16-beat window."""
    t_env = np.arange(len(env)) * HOP_FINE / sr
    beats = np.arange(phase, t1, period)
    beats = beats[beats >= t0]
    shifts = np.linspace(-0.4, 0.4, 81) * period
    offs = []
    for i in range(0, len(beats) - win, win):
        g = beats[i:i + win]
        if np.interp(g, t_env, env).mean() < 0.1:  # near-silent window: no evidence
            continue
        scores = [np.interp(g + sh, t_env, env).mean() for sh in shifts]
        offs.append(abs(shifts[int(np.argmax(scores))]) / period)
    return float(np.percentile(offs, 90)) if offs else 0.0


def _track_grid(period: float, phase: float, env: np.ndarray, sr: int, t0: float, t1: float,
                win: int = 16) -> np.ndarray:
    """Drift-tolerant grid: re-fit tempo and phase every half window, but only within +-15% of a beat,
    so the tracker can follow a live tempo without flipping onto the off-beat."""
    t_env = np.arange(len(env)) * HOP_FINE / sr
    p = period
    t = phase + np.ceil((t0 - 0.25 * period - phase) / period) * period
    out: list[float] = []
    ks = np.arange(win)
    while t <= t1:
        best = (-1.0, 0.0, p)
        for pp in np.linspace(p * 0.97, p * 1.03, 25):
            for sh in np.linspace(-0.15 * p, 0.15 * p, 31):
                v = np.interp(t + sh + ks * pp, t_env, env).mean()
                if v > best[0]:
                    best = (v, sh, pp)
        _, sh, pp = best
        take = t + sh + ks[: win // 2] * pp
        out.extend(x for x in take if x <= t1)
        p = 0.6 * p + 0.4 * pp
        t = take[-1] + p
    return np.asarray(out)


def analyze_audio(path: str | Path, bpm_hint: float | None = None, beats_per_bar: int = 4,
                  grid: str = "auto") -> dict:
    y, sr = librosa.load(str(path), sr=SR, mono=True)
    duration = float(len(y) / sr)

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    env_fine = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_FINE)
    env_low = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, fmax=200, n_mels=32)
    env_low_fine = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_FINE, fmax=200, n_mels=32)
    # bass/kick define where the beat is (avoids locking onto off-beat chords, e.g. polka "oom-pah")
    env_fit = _norm(env_fine, 0, 99) + _norm(env_low_fine, 0, 99)

    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=env, sr=sr, hop_length=HOP,
        start_bpm=bpm_hint or 120.0, tightness=100 if bpm_hint is None else 400,
    )
    bpm = float(np.atleast_1d(tempo)[0])
    dyn_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)
    if bpm_hint is None:
        bpm = _octave_fix(bpm, dyn_times, env_low, sr)
    else:
        bpm = bpm_hint

    # Most produced music has a steady tempo: a global grid fills the beats the DP tracker
    # trims (quiet intros/outros) and never flips phase. If the grid drifts (live playing),
    # fall back to a windowed tracker that follows tempo but cannot jump to the off-beat.
    active = np.nonzero(librosa.feature.rms(y=y, hop_length=HOP)[0] > 0.0056 * np.abs(y).max())[0]  # -45 dB: keep quiet intros
    t_first = librosa.frames_to_time(active[0], sr=sr, hop_length=HOP) if len(active) else 0.0
    t_last = librosa.frames_to_time(active[-1], sr=sr, hop_length=HOP) if len(active) else duration
    # the grid ends at the last real attack, not at the end of a reverb/decay tail
    strong = np.nonzero(env_fit > 0.25 * env_fit.max())[0]
    if len(strong):
        t_last = min(t_last, strong[-1] * HOP_FINE / sr + 0.1)
    drift = None
    if grid == "dynamic":
        mode = "dynamic"
        beat_times = _refine(dyn_times, env_fine, sr)
    else:
        period, ph = _fit_grid(bpm, env_fit, sr, duration)
        drift = _grid_drift(period, ph, env_fit, sr, t_first, t_last)
        mode = grid if grid in ("fixed", "tracked") else ("fixed" if drift <= 0.08 else "tracked")
        if mode == "fixed":
            beat_times = np.arange(ph, duration, period)
            beat_times = beat_times[(beat_times >= t_first - period * 0.25) & (beat_times <= t_last)]
        else:
            beat_times = _track_grid(period, ph, env_fit, sr, t_first, t_last)
        bpm = 60.0 / float(np.median(np.diff(beat_times))) if len(beat_times) > 1 else 60.0 / period

    full_at = _sample(env, beat_times, sr, HOP)
    low_at = _sample(env_low, beat_times, sr, HOP)
    phase = _downbeat_phase(low_at, full_at, beats_per_bar)

    # linear RMS separates build-ups from drops better than dB
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    loud = np.clip(rms / (np.percentile(rms, 98) + 1e-9), 0, 1)

    # loudness per beat = mean RMS over [beat, next beat)
    edges = np.append(beat_times, duration)
    beat_loud = []
    for a, b in zip(edges[:-1], edges[1:]):
        ia, ib = int(a * sr / HOP), max(int(a * sr / HOP) + 1, int(b * sr / HOP))
        beat_loud.append(float(loud[ia:ib].mean()) if ib <= len(loud) else float(loud[ia:].mean() if ia < len(loud) else 0))
    beat_loud = np.asarray(beat_loud)
    strength = _norm(full_at)

    beats = []
    for i, t in enumerate(beat_times):
        pos = (i - phase) % beats_per_bar
        beats.append({
            "t": round(float(t), 4),
            "strength": round(float(strength[i]), 4),
            "energy": round(float(beat_loud[i]), 4),
            "beatInBar": int(pos),
            "isDownbeat": pos == 0,
        })
    downbeats = [b["t"] for b in beats if b["isDownbeat"]]

    # bar-level energy (bars start at downbeats)
    bar_times = np.asarray(downbeats)
    bar_energy = []
    for i, t in enumerate(bar_times):
        end = bar_times[i + 1] if i + 1 < len(bar_times) else duration
        sel = [b["energy"] for b in beats if t <= b["t"] < end]
        bar_energy.append(np.mean(sel) if sel else 0.0)
    bar_energy = _norm(np.asarray(bar_energy, dtype=float), 0, 100) if len(bar_energy) else np.asarray([])

    drop = None
    if len(bar_energy) >= 2:
        jumps = np.diff(bar_energy)
        j = int(np.argmax(jumps))
        if jumps[j] > 0.25:
            drop = round(float(bar_times[j + 1]), 4)

    onset_frames = librosa.onset.onset_detect(onset_envelope=env_fine, sr=sr, hop_length=HOP_FINE, backtrack=False)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP_FINE)
    onset_strength = _norm(env_fine[onset_frames]) if len(onset_frames) else np.asarray([])

    return {
        "source": str(path),
        "duration": round(duration, 4),
        "bpm": round(bpm, 2),
        "grid": mode,
        "gridDrift": None if drift is None else round(drift, 3),
        "beatsPerBar": beats_per_bar,
        "beats": beats,
        "downbeats": downbeats,
        "bars": [{"t": round(float(t), 4), "energy": round(float(e), 4)} for t, e in zip(bar_times, bar_energy)],
        "sections": _sections(bar_energy, bar_times, duration),
        "drop": drop,
        "onsets": [{"t": round(float(t), 4), "s": round(float(s), 4)} for t, s in zip(onset_times, onset_strength)],
    }


def click_track(path: str | Path, analysis: dict, out: str | Path) -> Path:
    """Music + clicks (high = downbeat, low = beat) to check the grid by ear."""
    import soundfile as sf

    y, sr = librosa.load(str(path), sr=SR, mono=True)
    down = [b["t"] for b in analysis["beats"] if b["isDownbeat"]]
    other = [b["t"] for b in analysis["beats"] if not b["isDownbeat"]]
    c = librosa.clicks(times=down, sr=sr, click_freq=1760, length=len(y))
    c += 0.6 * librosa.clicks(times=other, sr=sr, click_freq=880, length=len(y))
    mix = 0.7 * y / (np.abs(y).max() + 1e-9) + 0.5 * c
    sf.write(str(out), mix / (np.abs(mix).max() + 1e-9) * 0.9, sr)
    return Path(out)
