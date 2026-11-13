from cutkiller.edit.cutlist import CutSettings, build_keep_segments, merge, output_cut_points, snap_segments, total_duration
from cutkiller.edit.mixer import MixPlan, MusicBed, SfxCue, build_mix_filter, render_mix, spaced
from cutkiller.edit.render import build_cut_filter, render_cuts
from cutkiller.listen import listen
from cutkiller.listen.silence import Interval
from cutkiller.media import probe


def test_keep_segments_with_padding():
    segs = build_keep_segments(6.5, [Interval(1.5, 3.0), Interval(4.5, 5.5)], CutSettings(padding=0.1))
    assert segs == [Interval(0.0, 1.6), Interval(2.9, 4.6), Interval(5.4, 6.5)]
    assert output_cut_points(segs) == [1.6, 3.3]


def test_keep_segments_edges_and_tiny_bits():
    # silence au début et à la fin : pas de padding côté bord ; micro-segment de 0.1 s supprimé
    segs = build_keep_segments(10, [Interval(0, 1), Interval(4, 5), Interval(5.1, 6), Interval(9, 10)],
                               CutSettings(padding=0.0, min_keep=0.2))
    assert segs == [Interval(1, 4), Interval(6, 9)]


def test_merge_and_snap():
    assert merge([Interval(2, 3), Interval(0, 1), Interval(1.05, 1.5)], gap=0.1) == [Interval(0, 1.5), Interval(2, 3)]
    assert snap_segments([Interval(0.98, 2.03)], [1.0, 2.0], 0.05) == [Interval(1.0, 2.0)]


def test_cut_filter_graph():
    g = build_cut_filter([Interval(0, 1), Interval(2, 3)], has_video=True)
    assert "concat=n=2:v=1:a=1[outv][outa]" in g and "trim=start=2.0000:end=3.0000" in g
    assert "concat=n=2:v=0:a=1[outa]" in build_cut_filter([Interval(0, 1), Interval(2, 3)], has_video=False)


def test_spaced():
    assert spaced([0.0, 0.5, 2.0, 2.4, 5.0], 1.5) == [0.0, 2.0, 5.0]


def test_mix_filter_graph(tmp_path):
    plan = MixPlan(music=MusicBed(tmp_path / "m.mp3"), sfx=[SfxCue(tmp_path / "s.wav", [1.0, 2.5, 99.0])])
    graph, inputs = build_mix_filter(plan, duration=10.0, has_voice=True)
    assert "sidechaincompress" in graph and "asplit=2[voice][sc]" in graph
    assert "adelay=1000:all=1" in graph and "adelay=2500:all=1" in graph and "99000" not in graph
    assert "amix=inputs=4" in graph and "loudnorm=I=-14.0" in graph
    assert inputs[0][:2] == ["-stream_loop", "-1"]


def test_render_cut_and_mix(talk_video, music_wav, sfx_wav, tmp_path):
    rep = listen(talk_video, with_loudness=False)
    segs = build_keep_segments(rep.media.duration, rep.silences, CutSettings(padding=0.05))
    cut = render_cuts(talk_video, tmp_path / "cut.mp4", segs)
    info = probe(cut)
    assert info.has_video and info.has_audio
    assert abs(info.duration - total_duration(segs)) < 0.25
    assert info.duration < rep.media.duration - 2.0

    plan = MixPlan(music=MusicBed(music_wav), sfx=[SfxCue(sfx_wav, output_cut_points(segs))])
    mixed = render_mix(cut, tmp_path / "mix.mp4", plan)
    m = probe(mixed)
    assert m.has_video and m.has_audio and abs(m.duration - info.duration) < 0.25
    # la musique (4 s) a été bouclée sur toute la durée : la fin n'est pas muette
    end = listen(mixed, with_loudness=True)
    assert end.loudness.integrated_lufs is not None and abs(end.loudness.integrated_lufs + 14) < 3
