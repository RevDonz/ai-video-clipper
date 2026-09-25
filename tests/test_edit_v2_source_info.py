"""``analysis/source.json`` and the immutable-file helpers of T1.5 (plan §4.1, §3.5, §9.1).

``ensure_source_info(job_dir, source)`` writes ``{content_sha256, probe}`` once per job: the
sha256 of the source bytes and an ffprobe summary (size, native frame rate, VFR flag, duration,
audio). The VFR flag comes from the packet timestamps, because Matroska sources report their
nominal rate in ``r_frame_rate`` even when frames were dropped.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat

import pytest
from support import edit_v2_media as media

from ai_clipper.edit_v2 import source_info
from ai_clipper.edit_v2.source_info import (
    SOURCE_INFO_RELATIVE_PATH,
    SourceInfoError,
    canonical_json,
    ensure_source_info,
    file_sha256,
    frame_step_irregularity,
    probe_source,
    read_regular,
    write_immutable,
)

PROBE_KEYS = {
    "version",
    "w",
    "h",
    "fps_native",
    "vfr",
    "duration_ms",
    "has_audio",
    "video_stream",
    "audio_stream",
    "video_codec",
    "pix_fmt",
    "color_space",
    "color_primaries",
    "color_transfer",
    "color_range",
    "rotation",
    "audio_sample_rate",
    "audio_channels",
    "size_bytes",
    "frame_steps",
    "irregular_frame_steps",
}


def _small(fps=(30000, 1001), frames=45, **kwargs):
    return media.VideoSpec(width=160, height=144, fps=fps, frames=frames, **kwargs)


# --- helpers -----------------------------------------------------------------------------------


def test_canonical_json_is_the_plan_encoding():
    value = {"b": [1, 2], "a": chr(0xE9), "c": {"z": None, "y": True}}
    assert canonical_json(value) == json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    with pytest.raises(ValueError):
        canonical_json({"x": float("nan")})


def test_write_immutable_creates_once_and_never_overwrites(tmp_path):
    target = tmp_path / "a" / "b" / "file.json"
    assert write_immutable(target, b"first") is True
    assert target.read_bytes() == b"first"
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
    inode = target.stat().st_ino
    assert write_immutable(target, b"second") is False
    assert target.read_bytes() == b"first"
    assert target.stat().st_ino == inode
    assert sorted(path.name for path in target.parent.iterdir()) == ["file.json"]


def test_write_immutable_never_writes_through_a_symlink(tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"keep")
    link = tmp_path / "dir" / "link.json"
    link.parent.mkdir()
    link.symlink_to(outside)
    assert write_immutable(link, b"evil") is False
    assert outside.read_bytes() == b"keep"
    with pytest.raises(OSError):
        read_regular(link, 1024)


def test_read_regular_is_bounded_and_refuses_directories(tmp_path):
    path = tmp_path / "f.bin"
    path.write_bytes(b"x" * 10)
    assert read_regular(path, 10) == b"x" * 10
    with pytest.raises(ValueError):
        read_regular(path, 9)
    with pytest.raises((OSError, ValueError)):
        read_regular(tmp_path, 100)
    with pytest.raises(FileNotFoundError):
        read_regular(tmp_path / "missing", 100)


def test_file_sha256_hashes_the_bytes(tmp_path):
    path = tmp_path / "blob"
    path.write_bytes(b"potongin" * 100_000)
    assert file_sha256(path) == hashlib.sha256(b"potongin" * 100_000).hexdigest()


# --- frame-step classification -------------------------------------------------------------------


def test_frame_steps_of_a_ms_timebase_cfr_source_are_regular():
    pts = [round(k * 1001 / 30) for k in range(300)]  # 29.97 in ms: steps of 33 and 34
    steps, irregular = frame_step_irregularity(pts, time_base=(1, 1000), fps=(30000, 1001))
    assert (steps, irregular) == (299, 0)
    pts = [k * 1001 for k in range(300)]
    assert frame_step_irregularity(pts, time_base=(1, 30000), fps=(30000, 1001)) == (299, 0)


def test_dropped_and_jittered_frames_are_irregular():
    pts = [round(k * 1001 / 30) for k in range(300) if k % 9 != 8]
    steps, irregular = frame_step_irregularity(pts, time_base=(1, 1000), fps=(30000, 1001))
    assert steps == len(pts) - 1 and irregular >= 30
    jitter = [round(k * 1001 / 30) + (k % 3) for k in range(300)]
    assert frame_step_irregularity(jitter, time_base=(1, 1000), fps=(30000, 1001))[1] > 50
    # Decode-order input is sorted first; duplicate timestamps are irregular.
    shuffled = [3003, 0, 2002, 1001, 1001]
    assert frame_step_irregularity(shuffled, time_base=(1, 30000), fps=(30000, 1001)) == (4, 1)


# --- probe ---------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fps", "frames", "container"),
    [((30000, 1001), 45, "mp4"), ((25, 1), 40, "mp4"), ((60, 1), 90, "mp4"),
     ((24000, 1001), 36, "mkv")],
)
def test_probe_reports_the_native_rate(edit_v2_media_factory, fps, frames, container):
    path = edit_v2_media_factory(_small(fps, frames, container=container))
    probe = probe_source(path)
    assert set(probe) == PROBE_KEYS
    assert probe["fps_native"] == list(fps)
    assert probe["vfr"] is False
    assert (probe["w"], probe["h"]) == (160, 144)
    assert probe["has_audio"] is True and probe["audio_stream"] is not None
    assert probe["audio_sample_rate"] == 48000 and probe["audio_channels"] == 2
    expected_ms = frames * 1000 * fps[1] / fps[0]
    assert expected_ms <= probe["duration_ms"] <= expected_ms + 50
    assert probe["size_bytes"] == path.stat().st_size
    assert probe["video_codec"] == "h264" and probe["pix_fmt"] == "yuv420p"
    assert probe["rotation"] == 0


def test_probe_flags_vfr_from_packet_timestamps(edit_v2_media_factory):
    path = edit_v2_media_factory(
        _small((30000, 1001), 90, vfr=True, drop_every=9, container="mkv")
    )
    probe = probe_source(path)
    assert probe["vfr"] is True
    assert probe["irregular_frame_steps"] > 0
    cfr = probe_source(edit_v2_media_factory(_small((30000, 1001), 90, container="mkv")))
    assert cfr["vfr"] is False and cfr["irregular_frame_steps"] == 0


def test_probe_without_audio(edit_v2_media_factory):
    probe = probe_source(edit_v2_media_factory(_small(audio=None)))
    assert probe["has_audio"] is False
    assert probe["audio_stream"] is None
    assert probe["audio_sample_rate"] is None and probe["audio_channels"] is None


def test_probe_rejects_a_file_without_video(tmp_path, edit_v2_ffmpeg):
    path = media.make_audio(tmp_path / "a.wav", media.AudioSpec(), duration_ms=500)
    with pytest.raises(SourceInfoError):
        probe_source(path)
    with pytest.raises(SourceInfoError):
        probe_source(tmp_path / "missing.mp4")


# --- ensure_source_info --------------------------------------------------------------------------


def test_ensure_source_info_writes_once(tmp_path, edit_v2_media_factory):
    source = edit_v2_media_factory(_small())
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    info = ensure_source_info(job_dir, source)
    assert set(info) == {"content_sha256", "probe"}
    assert info["content_sha256"] == file_sha256(source)
    assert info["probe"] == probe_source(source)
    path = job_dir / SOURCE_INFO_RELATIVE_PATH
    assert path.read_bytes() == canonical_json(info)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    before = (path.stat().st_ino, path.stat().st_mtime_ns)
    again = ensure_source_info(job_dir, source)
    assert again == info
    assert (path.stat().st_ino, path.stat().st_mtime_ns) == before


def test_ensure_source_info_never_recomputes_an_existing_file(tmp_path, edit_v2_media_factory,
                                                              monkeypatch):
    source = edit_v2_media_factory(_small())
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    info = ensure_source_info(job_dir, source)

    def boom(*_args, **_kwargs):
        raise AssertionError("must not probe again")

    monkeypatch.setattr(source_info, "probe_source", boom)
    monkeypatch.setattr(source_info, "file_sha256", boom)
    assert ensure_source_info(job_dir, source) == info


def test_ensure_source_info_refuses_a_corrupt_existing_file(tmp_path, edit_v2_media_factory):
    source = edit_v2_media_factory(_small())
    job_dir = tmp_path / "job"
    (job_dir / "analysis").mkdir(parents=True)
    path = job_dir / SOURCE_INFO_RELATIVE_PATH
    path.write_bytes(b'{"content_sha256": "nope"}')
    with pytest.raises(SourceInfoError):
        ensure_source_info(job_dir, source)
    assert path.read_bytes() == b'{"content_sha256": "nope"}'


def test_ensure_source_info_refuses_a_symlinked_source(tmp_path, edit_v2_media_factory):
    source = edit_v2_media_factory(_small())
    link = tmp_path / "link.mp4"
    link.symlink_to(source)
    job_dir = tmp_path / "job"
    job_dir.mkdir()
    with pytest.raises(SourceInfoError):
        ensure_source_info(job_dir, link)
    assert not (job_dir / SOURCE_INFO_RELATIVE_PATH).exists()
    assert not os.path.exists(job_dir / "analysis" / "source.json")
