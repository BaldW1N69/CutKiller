import subprocess
import json

from cutkiller.cli import _sfx_times, build_parser, main
from cutkiller.media import probe


def test_parser_has_commands():
    p = build_parser()
    a = p.parse_args(["auto", "x.mp4", "--music", "lofi", "--sfx", "whoosh@cuts", "--remove-fillers"])
    assert a.music == "lofi" and a.sfx == ["whoosh@cuts"] and a.remove_fillers


def test_sfx_times():
    assert _sfx_times("cuts", [1.0, 2.0], None) == [1.0, 2.0]
    assert _sfx_times("1.5, 3", [], None) == [1.5, 3.0]
    assert _sfx_times("beats:2", [], [0, 0.5, 1, 1.5, 2]) == [0, 1, 2]


def test_cli_listen_cut_mix_auto(talk_video, music_wav, sfx_wav, tmp_path, capsys):
    report = tmp_path / "r.json"
    assert main(["listen", str(talk_video), "-o", str(report), "--beats"]) == 0
    assert len(json.loads(report.read_text())["silences"]) == 2

    assert main(["cut", str(talk_video), "--dry-run"]) == 0
    assert "segments gardés" in capsys.readouterr().out

    out = tmp_path / "auto.mp4"
    assert main(["auto", str(talk_video), "-o", str(out), "--music", str(music_wav),
                 "--sfx", f"{sfx_wav}@cuts", "--sfx", f"{sfx_wav}@beats:4"]) == 0
    info = probe(out)
    assert info.has_video and info.has_audio and info.duration < 5
    assert sorted(p.name for p in tmp_path.iterdir()) == ["auto.mp4", "r.json"]  # aucun intermédiaire laissé
    # constant frame rate with exact timestamps (an .mkv intermediate rounded them to the millisecond)
    rates = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                            "stream=r_frame_rate,avg_frame_rate", "-of", "csv=p=0", str(out)],
                           capture_output=True, text=True, check=True).stdout.strip().split(",")
    assert rates[0] == rates[1]


def test_cli_errors_are_clean(tmp_path, capsys):
    assert main(["listen", str(tmp_path / "missing.mp4")]) == 1
    assert "introuvable" in capsys.readouterr().err
