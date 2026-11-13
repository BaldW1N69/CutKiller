import subprocess

from conftest import click_track, write_wav
from cutkiller.cli import main
from cutkiller.edit.montage import MontageSettings, beat_grid, build_montage
from cutkiller.media import probe
from cutkiller.transitions.frames import VideoFormat

FMT = VideoFormat(180, 320, 25.0)


def _clip(path, color, dur=4.0):
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s=320x180:r=25:d={dur}",
                    "-vf", f"drawbox=c={color}@0.6:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt",
                    "yuv420p", str(path)], check=True)
    return path


def test_beat_grid():
    assert beat_grid([0.5, 1, 1.5, 2, 2.5], 0.9, music_start=0.7) == [0, 0.5, 1.0, 1.5]
    assert beat_grid([0.5, 1, 1.5, 2], 0.05) is None


def test_build_montage_cuts_on_beats(tmp_path):
    a, b, c = _clip(tmp_path / "a.mp4", "red"), _clip(tmp_path / "b.mp4", "blue"), _clip(tmp_path / "c.mp4", "green", 1.2)
    beats = [i * 0.5 for i in range(30)]
    clips = build_montage([a, b, c, a], FMT, MontageSettings(beats_per_clip=4), tmp_path, beats)
    ends, t = [], 0
    for cl in clips:
        t += cl.end - cl.start
        ends.append(round(t, 3))
    # 4 temps = 2 s ; le clip c (1.2 s) ne tient que 2 temps → coupe à 5.0, puis retour sur la grille
    assert ends == [2.0, 4.0, 5.0, 7.0]
    assert all(cl.start > 0 for cl in clips[:2])  # extraits centrés → poignées


def test_photo_clip(tmp_path):
    img = tmp_path / "p.png"
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=400x300", "-frames:v", "1",
                    str(img)], check=True)
    [clip] = build_montage([img], FMT, MontageSettings(photo_duration=1.0), tmp_path)
    info = probe(clip.src)
    assert info.width == 180 and info.height == 320 and abs(info.duration - 3.0) < 0.1


def test_cli_montage(tmp_path):
    a, b = _clip(tmp_path / "a.mp4", "red"), _clip(tmp_path / "b.mp4", "blue")
    music = write_wav(tmp_path / "m.wav", click_track(120, 10.0))
    out = tmp_path / "m.mp4"
    assert main(["montage", str(a), str(b), str(a), "-o", str(out), "--size", "180x320", "--music", str(music),
                 "--beats-per-clip", "4", "--transition", "fade|fx:flash", "--seed", "1"]) == 0
    info = probe(out)
    assert info.width == 180 and info.height == 320 and info.has_audio
    assert abs(info.duration - 6.0) < 0.15
