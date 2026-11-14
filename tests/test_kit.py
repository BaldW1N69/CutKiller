"""Kit de sound design : association transition → son, placement, calage sur le pic, mixage."""

import subprocess
from pathlib import Path

import numpy as np
import pytest

from conftest import SR, click_track, write_wav
from cutkiller import sounds
from cutkiller.cli import main
from cutkiller.edit.mixer import MixPlan, SfxCue, build_mix_filter
from cutkiller.media import ANALYSIS_SR, load_audio, probe
from cutkiller.sounds.kit import KITS, hit_time, parse_overrides, plan_events, role_for
from cutkiller.sounds.providers import LocalProvider
from cutkiller.transitions import resolve


@pytest.mark.parametrize("spec,role", [
    ("fx:whip_left", "whoosh"), ("fx:zoom_punch", "whoosh"), ("fx:spin", "whoosh"), ("xfade:slideleft", "whoosh"),
    ("fx:flash", "flash"), ("fx:glitch", "glitch"), ("fx:rgb_split", "glitch"),
    ("xfade:fade", None), ("xfade:dissolve", None), ("fx:blur", None),
])
def test_role_for(spec, role):
    assert role_for(resolve(spec)) == role


def test_plan_events_cinematic():
    whip, flash, fade = resolve("fx:whip_left"), resolve("fx:flash"), resolve("fade")
    cuts = [2.0, 4.0, 6.0, 8.0]
    trans = [(2.0, whip), (4.0, flash), (6.0, fade)]
    ev = plan_events(KITS["cinematic"], 10.0, cuts, trans)
    got = [(e.role, e.time) for e in ev]
    assert ("focus", 0.15) in got
    assert ("whoosh", 2.0) in got and ("flash", 4.0) in got
    assert ("click", 8.0) in got  # coupe sèche
    assert not any(r == "click" and t == 6.0 for r, t in got)  # un fondu n'est pas une coupe sèche
    assert not any(r != "riser" and t == 6.0 for r, t in got)  # ni un son de transition
    assert ("riser", 4.0) in got  # premier gros raccord après l'accroche (≥ 3 s)
    [amb] = [e for e in ev if e.role == "ambience"]
    assert amb.time == 8.0 and amb.length == pytest.approx(2.0)


def test_plan_events_minimal_and_no_clicks():
    whip = resolve("fx:whip_left")
    ev = plan_events(KITS["minimal"], 10.0, [2.0, 5.0], [(2.0, whip)])
    assert [(e.role, e.time) for e in ev] == [("whoosh", 2.0)]
    ev = plan_events(KITS["cinematic"], 10.0, [2.0, 5.0], [(2.0, whip)], clicks=False)
    assert not any(e.role == "click" for e in ev)


def test_click_not_stacked_on_transition_sound():
    whip = resolve("fx:whip_left")
    ev = plan_events(KITS["cinematic"], 10.0, [2.0, 2.2], [(2.0, whip)])
    assert not any(e.role == "click" for e in ev)  # 0,2 s après un whoosh : trop près


def _whoosh(path, peak=0.7, dur=1.2):
    t = np.arange(int(dur * SR)) / SR
    rng = np.random.default_rng(1)
    return write_wav(path, (0.6 * np.exp(-((t - peak) / 0.12) ** 2) * rng.standard_normal(t.size)).astype(np.float32))


def _click(path, lead=0.2):
    a = np.zeros(int((lead + 0.2) * SR), dtype=np.float32)
    t = np.arange(int(0.05 * SR)) / SR
    a[int(lead * SR):int(lead * SR) + t.size] = 0.8 * np.exp(-t * 80) * np.sin(2 * np.pi * 1500 * t)
    return write_wav(path, a)


def test_hit_time(tmp_path):
    assert hit_time(_whoosh(tmp_path / "w.wav"), "peak") == pytest.approx(0.7, abs=0.03)
    assert hit_time(_click(tmp_path / "c.wav"), "onset") == pytest.approx(0.2, abs=0.02)
    assert hit_time(tmp_path / "w.wav", "start") == 0.0


def test_parse_overrides():
    assert parse_overrides(["whoosh=a.wav", "Riser = epic riser"]) == {"whoosh": "a.wav", "riser": "epic riser"}
    with pytest.raises(ValueError):
        parse_overrides(["bang=a.wav"])
    with pytest.raises(ValueError):
        parse_overrides(["whoosh"])


def test_mix_filter_preroll_and_bed(tmp_path):
    plan = MixPlan(sfx=[SfxCue(Path("w.wav"), [-0.5, 2.0]), SfxCue(Path("rain.wav"), [8.0], loop_for=2.0, fade=0.5)],
                   target_lufs=None)
    graph, inputs = build_mix_filter(plan, 10.0, has_voice=True)
    assert "atrim=start=0.500" in graph and "adelay=2000" in graph
    assert inputs[1][:2] == ["-stream_loop", "-1"] and "atrim=0:2.000" in graph and "afade=t=out" in graph


def test_local_sound_with_spaces(tmp_path):
    """Les packs nomment leurs fichiers « Whoosh Cinematic.wav » : l'URI file:// encodée doit être décodée."""
    _whoosh(tmp_path / "Whoosh Cinematic.wav")
    [s] = LocalProvider(tmp_path).search("whoosh cinematic", kind="sfx")
    assert sounds.download(s).exists()


def _clip(path, color, dur=4.0):
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=180x320:r=25:d={dur}",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def test_cli_montage_with_kit(tmp_path, monkeypatch, capsys):
    pack = tmp_path / "pack"
    pack.mkdir()
    _whoosh(pack / "Whoosh Cinematic.wav")
    _click(pack / "Click 10.wav")
    monkeypatch.setenv("CUTKILLER_SOUNDS_DIR", str(pack))
    a, b, c = (_clip(tmp_path / f"{n}.mp4", col) for n, col in (("a", "red"), ("b", "blue"), ("c", "green")))
    music = write_wav(tmp_path / "m.wav", click_track(120, 10.0) * 0.01)
    out = tmp_path / "k.mp4"
    assert main(["montage", str(a), str(b), str(c), "-o", str(out), "--size", "180x320", "--music", str(music),
                 "--music-volume", "-40", "--beats-per-clip", "4", "--transition", "fx:whip_left",
                 "--transition-every", "2", "--seed", "1", "--sfx-kit", "cinematic", "--no-normalize"]) == 0
    log = capsys.readouterr().out
    assert "Kit cinematic" in log and "whoosh×1" in log and "click×1" in log
    assert probe(out).has_audio
    # le pic du whoosh tombe sur la 1re coupe (2 s), le clic démarre sur la 2e (4 s)
    audio = load_audio(out, ANALYSIS_SR)
    hop = ANALYSIS_SR // 100
    env = np.sqrt((audio[: audio.size // hop * hop].reshape(-1, hop) ** 2).mean(axis=1))
    assert abs((150 + env[150:250].argmax()) / 100 - 2.0) < 0.06
    assert abs((350 + env[350:450].argmax()) / 100 - 4.0) < 0.06
