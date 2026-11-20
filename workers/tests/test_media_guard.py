"""A playlist sent as a rush must never make FFmpeg read another file."""

import shutil
import subprocess

import pytest

from cutkiller_workers.audio import load_mono

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg absent")


def test_playlist_pointing_at_another_file_is_refused(tmp_path):
    secret = tmp_path / "other-user.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", str(secret)],
        check=True,
    )
    playlist = tmp_path / "upload.m3u8"
    playlist.write_text(f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{secret}\n#EXT-X-ENDLIST\n")
    with pytest.raises(subprocess.CalledProcessError):
        load_mono(str(playlist))
    assert len(load_mono(str(secret))) > 0  # the real media still decodes
