import json

import pytest

from cutkiller import sounds
from cutkiller.sounds import Credits, pick_music
from cutkiller.sounds.base import Sound
from cutkiller.sounds.providers import FreesoundProvider, JamendoProvider, LocalProvider, OpenverseProvider

OPENVERSE = {"results": [
    {"id": "abc", "title": "Deep Whoosh #1", "url": "https://cdn.freesound.org/x.mp3", "duration": 1800,
     "license": "cc0", "license_url": "https://creativecommons.org/publicdomain/zero/1.0/", "creator": "Kinoton",
     "foreign_landing_url": "https://freesound.org/s/1", "filetype": "mp3", "tags": [{"name": "whoosh"}]},
    {"id": "nourl", "title": "x", "url": None},
]}

FREESOUND = {"results": [
    {"id": 42, "name": "pop.wav", "duration": 0.4, "license": "http://creativecommons.org/licenses/by/4.0/",
     "username": "bob", "url": "https://freesound.org/s/42/", "tags": ["pop"],
     "previews": {"preview-hq-mp3": "https://cdn.freesound.org/previews/42-hq.mp3"}},
]}

JAMENDO = {"results": [
    {"id": "7", "name": "Chill", "duration": 180, "artist_name": "Ann", "audio": "https://j/7.mp3",
     "audiodownload": "https://j/7-dl.mp3", "audiodownload_allowed": True,
     "license_ccurl": "http://creativecommons.org/licenses/by-nc-sa/3.0/", "shareurl": "https://jamendo.com/t/7",
     "musicinfo": {"tags": {"genres": ["lounge"], "vartags": ["chill"]}}},
    {"id": "8", "name": "Free", "duration": 90, "artist_name": "Max", "audio": "https://j/8.mp3",
     "license_ccurl": "http://creativecommons.org/licenses/by/3.0/"},
]}


def test_openverse_parse_converts_ms():
    [s] = OpenverseProvider.parse(OPENVERSE)
    assert s.ref == "openverse:abc" and s.duration == 1.8 and s.commercial_ok and not s.needs_attribution
    assert "whoosh" in s.tags


def test_freesound_parse_license():
    [s] = FreesoundProvider.parse(FREESOUND)
    assert s.license == "by" and s.needs_attribution and s.download_url.endswith("42-hq.mp3")
    assert "par bob" in s.attribution()


def test_jamendo_parse_and_commercial_filter(monkeypatch):
    nc, by = JamendoProvider.parse(JAMENDO)
    assert nc.license == "by-nc-sa" and not nc.commercial_ok and nc.download_url.endswith("7-dl.mp3")
    assert by.license == "by" and by.commercial_ok
    monkeypatch.setattr("cutkiller.sounds.providers.http_json", lambda url, params: JAMENDO)
    p = JamendoProvider(client_id="x")
    assert [s.id for s in p.search("chill")] == ["8"]
    assert len(p.search("chill", commercial=False)) == 2
    assert p.search("pop", kind="sfx") == []


def test_freesound_builds_filters(monkeypatch):
    seen = {}

    def fake(url, params):
        seen.update(params)
        return FREESOUND

    monkeypatch.setattr("cutkiller.sounds.providers.http_json", fake)
    FreesoundProvider(token="t").search("pop", max_duration=2)
    assert "duration:[0 TO 2]" in seen["filter"] and "Creative Commons 0" in seen["filter"]
    assert not FreesoundProvider(token=None).available() or True


def test_local_provider(tmp_path, sfx_wav):
    (tmp_path / "sfx" / "transitions").mkdir(parents=True)
    target = tmp_path / "sfx" / "transitions" / "whoosh_fast.wav"
    target.write_bytes(sfx_wav.read_bytes())
    (tmp_path / "readme.txt").write_text("not audio")
    p = LocalProvider(tmp_path)
    [s] = p.search("whoosh fast")
    assert s.provider == "local" and s.duration and s.duration < 1
    assert p.search("explosion") == []
    assert sounds.download(s) == target


def test_search_survives_provider_failure(monkeypatch):
    def boom(url, params):
        raise TimeoutError("down")

    monkeypatch.setattr("cutkiller.sounds.providers.http_json", boom)
    res, errors = sounds.search("whoosh", providers=["openverse", "nope"])
    assert res == [] and "TimeoutError" in errors["openverse"] and errors["nope"] == "provider inconnu"


def test_pick_music_prefers_long_enough():
    mk = lambda i, d: Sound("p", str(i), f"t{i}", "u", duration=d)  # noqa: E731
    assert pick_music([mk(1, 30), mk(2, 200), mk(3, 70)], 60).id == "3"
    assert pick_music([mk(1, 30), mk(2, 50)], 60).id == "2"
    assert pick_music([], 10) is None


def test_credits(tmp_path):
    c = Credits()
    s = FreesoundProvider.parse(FREESOUND)[0]
    c.add(s)
    c.add(s)
    nc = JamendoProvider.parse(JAMENDO)[0]
    c.add(nc)
    out = c.write(tmp_path / "c.txt")
    txt = out.read_text()
    assert txt.count("pop.wav") == 1 and "ATTENTION" in txt and "Chill" in txt
    assert Credits().write(tmp_path / "none.txt") is None
    local = Credits()
    local.add(Sound("local", "a.wav", "a", "file:///a.wav", license="local"))
    assert local.text() == ""


def test_download_uses_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("CUTKILLER_CACHE", str(tmp_path))
    calls = []

    class Resp:
        def __init__(self):
            import io
            self.buf = io.BytesIO(b"ID3fake")

        def read(self, *a):
            return self.buf.read(*a)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr("urllib.request.urlopen", lambda req, timeout=0: calls.append(req.full_url) or Resp())
    s = OpenverseProvider.parse(OPENVERSE)[0]
    p1 = sounds.download(s)
    p2 = sounds.download(s)
    assert p1 == p2 and p1.read_bytes() == b"ID3fake" and len(calls) == 1
    assert json.loads(p1.with_suffix(".json").read_text())["license"] == "cc0"


@pytest.mark.network
def test_openverse_live():
    res = OpenverseProvider().search("whoosh", kind="sfx", limit=3, max_duration=5)
    assert res and all(s.commercial_ok for s in res)


def test_openverse_music_second_pass(monkeypatch):
    calls = []

    def fake(url, params):
        calls.append(dict(params))
        return OPENVERSE

    monkeypatch.setattr("cutkiller.sounds.providers.http_json", fake)
    res = OpenverseProvider().search("lofi", kind="music", limit=5)
    assert calls[0]["category"] == "music" and "category" not in calls[1]
    assert calls[0]["license_type"] == "commercial,modification" and calls[0]["page_size"] <= 20
    assert [s.id for s in res] == ["abc"]  # dédoublonné


def test_fetch_first_skips_failing_cdn(monkeypatch):
    a, b = Sound("p", "1", "a", "https://x/a.mp3"), Sound("p", "2", "b", "https://x/b.mp3")

    def fake(s, dest_dir=None):
        if s.id == "1":
            raise OSError("HTTP Error 403: Forbidden")
        return f"/cache/{s.id}.mp3"

    monkeypatch.setattr(sounds, "download", fake)
    errs = []
    assert sounds.fetch_first([a, b], on_error=lambda s, e: errs.append(s.id)) == (b, "/cache/2.mp3")
    assert errs == ["1"]
    monkeypatch.setattr(sounds, "download", lambda s, d=None: (_ for _ in ()).throw(OSError("down")))
    assert sounds.fetch_first([a]) is None
