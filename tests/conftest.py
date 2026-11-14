import os
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

SR = 48_000


def write_wav(path: Path, audio: np.ndarray, sr: int = SR) -> Path:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return path


def speech_like(pattern: list[tuple[float, bool]], sr: int = SR, seed: int = 0) -> np.ndarray:
    """Alterne 'parole' (bruit modulé + harmoniques) et 'silence' (bruit de fond faible)."""
    rng = np.random.default_rng(seed)
    chunks = []
    for dur, voiced in pattern:
        n = int(dur * sr)
        t = np.arange(n) / sr
        floor = 0.002 * rng.standard_normal(n)
        if voiced:
            env = 0.5 + 0.5 * np.sin(2 * np.pi * 4 * t) ** 2
            sig = 0.3 * env * (np.sin(2 * np.pi * 180 * t) + 0.5 * np.sin(2 * np.pi * 360 * t)) + 0.05 * rng.standard_normal(n)
            chunks.append(sig + floor)
        else:
            chunks.append(floor)
    return np.concatenate(chunks).astype(np.float32)


def click_track(bpm: float, dur: float, sr: int = SR) -> np.ndarray:
    audio = np.zeros(int(dur * sr), dtype=np.float32)
    period = 60.0 / bpm
    click = np.exp(-np.arange(int(0.03 * sr)) / (0.004 * sr)) * np.sin(2 * np.pi * 1000 * np.arange(int(0.03 * sr)) / sr)
    t = 0.25
    while t < dur - 0.05:
        i = int(t * sr)
        audio[i : i + click.size] += click[: audio.size - i]
        t += period
    return audio * 0.8


PATTERN = [(1.5, True), (1.5, False), (1.5, True), (1.0, False), (1.0, True)]  # 6.5 s, 2.5 s de silence


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("media")


@pytest.fixture(scope="session")
def talk_video(media_dir) -> Path:
    wav = write_wav(media_dir / "talk.wav", speech_like(PATTERN))
    out = media_dir / "talk.mp4"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25",
         "-i", str(wav), "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", str(out)],
        check=True,
    )
    return out


@pytest.fixture(scope="session")
def music_wav(media_dir) -> Path:
    return write_wav(media_dir / "music.wav", click_track(120, 4.0))


@pytest.fixture(scope="session")
def sfx_wav(media_dir) -> Path:
    t = np.arange(int(0.3 * SR)) / SR
    return write_wav(media_dir / "whoosh.wav", (0.5 * np.sin(2 * np.pi * 600 * t) * np.exp(-t * 8)).astype(np.float32))


# Chromium préinstallé (CI, conteneurs) : utilisé par les tests HTML si Playwright n'a pas le sien
if not os.environ.get("CUTKILLER_CHROMIUM") and Path("/opt/pw-browsers/chromium").exists():
    os.environ["CUTKILLER_CHROMIUM"] = "/opt/pw-browsers/chromium"
