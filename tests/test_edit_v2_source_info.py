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

from ai_clipper.edit_v2 import DOC_FPS, source_info
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
from ai_clipper.edit_v2.timemap import Fps

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
    "grid_sf",
    "content_rect",
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
    assert probe["content_rect"] is None  # the test pattern has no black bars
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


@pytest.mark.parametrize(
    "spec",
    [
        # 902 frames at 29.97: 30,096.73 ms, so duration_ms (30,097, rounded up) points one grid
        # frame past the last frame at 30000/1001 (the verifier's end-of-source case).
        _small((30000, 1001), 902),
        # the video starts 41 ms after the audio (ffprobe start_time 0.041 s, like two of the
        # real downloads): the grid has no frame 0 at any document rate.
        _small((24000, 1001), 120, video_delay_ms=41),
        _small((25, 1), 75, video_delay_ms=41),
        _small((30000, 1001), 90, vfr=True, drop_every=9, container="mkv"),
    ],
    ids=["end_29.97", "delayed_23.976", "delayed_25", "vfr_mkv"],
)
def test_probe_records_the_grid_that_exists_at_every_document_rate(edit_v2_media_factory, spec):
    path = edit_v2_media_factory(spec)
    probe = probe_source(path)
    assert probe["version"] == 2
    assert [entry[:2] for entry in probe["grid_sf"]] == [list(rate) for rate in DOC_FPS]
    for num, den, first, end in probe["grid_sf"]:
        # the independent whole-file fps grid (decoded frame timestamps with -copyts)
        assert (first, end) == media.grid_range(path, (num, den)), (num, den)
        assert source_info.grid_range(probe, Fps(num, den)) == (first, end)
    if spec.video_delay_ms:
        assert all(first == 1 for _num, _den, first, _end in probe["grid_sf"])
    if spec.frames == 902:
        assert source_info.grid_range(probe, Fps(30000, 1001)) == (0, 902)
        assert probe["duration_ms"] == 30097  # sf_ceil(30097) would be 903


def test_the_grid_end_is_found_when_the_video_ends_early(edit_v2_media_factory, monkeypatch):
    """``duration_ms`` can come from the container (Matroska), so the video may end more than
    3 s before it: an empty tail decode falls back to decoding from the start."""
    path = edit_v2_media_factory(_small((30000, 1001), 90))
    expected = probe_source(path)["grid_sf"]
    real = source_info._grid_pts
    seeks = []

    def late(ffmpeg, source, stream, seek_ms, *, first_only):
        seeks.append(seek_ms)
        if not first_only and seek_ms > 0:
            return [[] for _rate in DOC_FPS]  # the seek landed after the last video frame
        return real(ffmpeg, source, stream, seek_ms, first_only=first_only)

    monkeypatch.setattr(source_info, "_grid_pts", late)
    grid = source_info.measure_grid(path, video_stream=0, duration_ms=60_000)
    assert grid == expected
    assert seeks == [0, 57_000, 0]


def test_the_grid_is_measured_on_one_thread_when_threaded_ffmpeg_aborts(edit_v2_media_factory,
                                                                        monkeypatch):
    """FFmpeg 6.1.1 aborts on some AV1 sources with ``-threads 4`` ("Assertion pkt failed at
    src/fftools/ffmpeg_dec.c:597", rc -6) and decodes them with ``-threads 1`` (W3 verifier):
    a failed threaded run is retried once on one thread, which gives the same grid."""
    path = edit_v2_media_factory(_small((30000, 1001), 90))
    expected = probe_source(path)["grid_sf"]
    real_run = source_info.subprocess.run
    threads = []

    def flaky(argv, **kwargs):
        if "-filter_complex" in argv:
            count = argv[argv.index("-threads") + 1]
            threads.append(count)
            if count != "1":
                return source_info.subprocess.CompletedProcess(argv, -6, b"", b"Assertion pkt failed")
        return real_run(argv, **kwargs)

    monkeypatch.setattr(source_info.subprocess, "run", flaky)
    grid = source_info.measure_grid(path, video_stream=0, duration_ms=3003)
    assert grid == expected
    assert threads == [str(source_info.GRID_THREADS), "1", str(source_info.GRID_THREADS), "1"]


def test_a_grid_run_that_fails_on_one_thread_too_is_an_error(edit_v2_media_factory, monkeypatch):
    path = edit_v2_media_factory(_small((30000, 1001), 30))

    def broken(argv, **kwargs):
        return source_info.subprocess.CompletedProcess(argv, 1, b"", b"")

    monkeypatch.setattr(source_info.subprocess, "run", broken)
    with pytest.raises(SourceInfoError, match="frame grid could not be measured"):
        source_info.measure_grid(path, video_stream=0, duration_ms=1001)


def test_grid_range_needs_a_recorded_rate():
    probe = {"grid_sf": [[30000, 1001, 0, 902]]}
    assert source_info.grid_range(probe, Fps(30000, 1001)) == (0, 902)
    with pytest.raises(SourceInfoError):
        source_info.grid_range(probe, Fps(25, 1))
    with pytest.raises(SourceInfoError):
        source_info.grid_range({}, Fps(30000, 1001))


def test_ensure_source_info_refuses_a_probe_without_the_grid(tmp_path, edit_v2_media_factory):
    """A version-1 file (no ``grid_sf``) was never written outside W1 development; it is refused
    rather than trusted, because its seeds could reach past the frames that exist."""
    source = edit_v2_media_factory(_small())
    job_dir = tmp_path / "job"
    (job_dir / "analysis").mkdir(parents=True)
    probe = probe_source(source)
    old = {key: value for key, value in probe.items() if key != "grid_sf"}
    old["version"] = 1
    path = job_dir / SOURCE_INFO_RELATIVE_PATH
    path.write_bytes(canonical_json({"content_sha256": file_sha256(source), "probe": old}))
    with pytest.raises(SourceInfoError):
        ensure_source_info(job_dir, source)


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


# --- black bars: the content rect (CONTRACTS §5.52) ---------------------------------------------


def _detect(x1: int, x2: int, y1: int, y2: int) -> str:
    """One sample's stderr as FFmpeg's cropdetect prints it (``reset=0``: the last line holds
    the bounds of every frame of the run)."""
    w, h = x2 - x1 + 1, y2 - y1 + 1
    lines = ["Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'source.mp4':",
             "  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(tv, bt709), 1920x1080"]
    for pts in (512, 1024):
        lines.append(f"[Parsed_cropdetect_0 @ 0x55d0c0] x1:{x1} x2:{x2} y1:{y1} y2:{y2} "
                     f"w:{w} h:{h} x:{x1} y:{y1} pts:{pts} t:0.04 limit:0.094000 "
                     f"crop={w}:{h}:{x1}:{y1}")
    return "\n".join(lines) + "\n"


BLACK = ("[Parsed_cropdetect_0 @ 0x55d0c0] x1:1919 x2:0 y1:1079 y2:0 w:-1918 h:-1078 "
         "x:1920 y:1080 pts:512 t:0.04 limit:0.094000 crop=-1918:-1078:1920:1080\n")


def test_the_content_rect_of_a_letterbox_and_a_pillarbox():
    rect = source_info.content_rect_from_cropdetect
    # 2.39:1 in 1920×1080, one sample a row darker at the edge
    samples = [_detect(0, 1919, 138, 941)] * 4 + [_detect(0, 1919, 139, 940)]
    assert rect(samples, (1920, 1080)) == {"x": 0, "y": 138, "w": 1920, "h": 804}
    # 4:3 pillarbox; odd bounds are rounded inwards to even
    assert rect([_detect(241, 1678, 0, 1079)] * 5, (1920, 1080)) == {
        "x": 242, "y": 0, "w": 1436, "h": 1080}
    # 9:16 inside 16:9
    assert rect([_detect(656, 1263, 0, 1079)] * 3, (1920, 1080)) == {
        "x": 656, "y": 0, "w": 608, "h": 1080}
    # the bounds of all samples together: a frame whose content reaches further widens the rect
    wider = [_detect(240, 1679, 0, 1079)] * 4 + [_detect(200, 1719, 0, 1079)]
    assert rect(wider, (1920, 1080)) == {"x": 200, "y": 0, "w": 1520, "h": 1080}


def test_a_source_without_bars_has_no_content_rect():
    rect = source_info.content_rect_from_cropdetect
    assert rect([_detect(0, 1919, 0, 1079)] * 5, (1920, 1080)) is None
    # a few dark rows or columns at one edge are no bars
    assert rect([_detect(0, 1919, 4, 1079)] * 5, (1920, 1080)) is None
    assert rect([_detect(6, 1915, 0, 1079)] * 5, (1920, 1080)) is None  # 6 px < 1 %
    # bars on one side only (a dark stage, a lower third) are not a letterbox
    assert rect([_detect(0, 1919, 0, 900)] * 5, (1920, 1080)) is None
    assert rect([_detect(300, 1919, 0, 1079)] * 5, (1920, 1080)) is None
    # a picture under a quarter of the source is more likely a dark scene than bars
    assert rect([_detect(800, 1119, 0, 1079)] * 5, (1920, 1080)) is None


def test_black_and_missing_samples_do_not_count():
    rect = source_info.content_rect_from_cropdetect
    letterbox = _detect(0, 1919, 138, 941)
    # black frames (a fade) and a failed run are left out; the rest still agree
    assert rect([letterbox, BLACK, letterbox, "", letterbox], (1920, 1080)) == {
        "x": 0, "y": 138, "w": 1920, "h": 804}
    # fewer than half the samples (or fewer than two) is not enough to tell
    assert rect([letterbox, BLACK, BLACK, "", letterbox], (1920, 1080)) is None
    assert rect([letterbox], (1920, 1080)) is None
    assert rect([], (1920, 1080)) is None
    assert rect(["garbage x1:a", BLACK], (1920, 1080)) is None
    # bounds outside the source (a different stream) are not trusted
    assert rect([_detect(0, 1919, 138, 1200)] * 5, (1920, 1080)) is None


def test_cropdetect_runs_a_few_bounded_samples(tmp_path, monkeypatch):
    calls = []

    class Done:
        returncode = 0
        stderr = _detect(0, 1279, 90, 629)

    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        return Done()

    monkeypatch.setattr(source_info.subprocess, "run", run)
    monkeypatch.setattr(source_info, "_tool", lambda name: "/usr/bin/" + name)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"")
    assert source_info.measure_content_rect(source, video_stream=0, duration_ms=600_000,
                                            size=(1280, 720)) == {
        "x": 0, "y": 90, "w": 1280, "h": 540}
    assert len(calls) == source_info.CROPDETECT_SAMPLES == 5
    seeks = []
    for argv, kwargs in calls:
        assert argv[:3] == ["/usr/bin/ffmpeg", "-nostdin", "-hide_banner"]
        assert "-protocol_whitelist" in argv and "file,pipe" in argv
        assert argv[argv.index("-frames:v") + 1] == str(source_info.CROPDETECT_FRAMES)
        assert "cropdetect=limit=0.094:round=2:reset=0" in argv[argv.index("-vf") + 1]
        assert argv[argv.index("-map") + 1] == "0:0"
        assert kwargs["timeout"] == source_info.CROPDETECT_TIMEOUT_S
        assert kwargs["env"] == source_info.child_env()
        seeks.append(argv[argv.index("-ss") + 1])
    assert seeks == ["60.000", "180.000", "300.000", "420.000", "540.000"]


def test_a_failing_or_slow_cropdetect_is_no_content_rect(tmp_path, monkeypatch):
    def slow(argv, **kwargs):
        raise source_info.subprocess.TimeoutExpired(argv, kwargs["timeout"])

    class Failed:
        returncode = 1
        stderr = _detect(0, 1279, 90, 629)

    monkeypatch.setattr(source_info, "_tool", lambda name: "/usr/bin/" + name)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"")
    for run in (slow, lambda argv, **kwargs: Failed()):
        monkeypatch.setattr(source_info.subprocess, "run", run)
        assert source_info.measure_content_rect(source, video_stream=0, duration_ms=60_000,
                                                size=(1280, 720)) is None


def _boxed(path, edit_v2_ffmpeg, pad: str) -> object:
    import subprocess

    subprocess.run([edit_v2_ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=320x136:rate=30:duration=3",
                    "-vf", pad, "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset",
                    "ultrafast", str(path)], check=True, timeout=60)
    return path


def test_the_probe_measures_the_bars_of_a_letterboxed_source(tmp_path, edit_v2_ffmpeg):
    boxed = _boxed(tmp_path / "boxed.mp4", edit_v2_ffmpeg, "pad=320:180:0:22:black")
    assert probe_source(boxed)["content_rect"] == {"x": 0, "y": 22, "w": 320, "h": 136}
    plain = _boxed(tmp_path / "plain.mp4", edit_v2_ffmpeg, "scale=320:180")
    assert probe_source(plain)["content_rect"] is None


def test_source_info_keeps_a_valid_content_rect_and_refuses_a_bad_one(tmp_path,
                                                                       edit_v2_media_factory):
    source = edit_v2_media_factory(_small())
    value = ensure_source_info(tmp_path / "job", source)
    assert "content_rect" in value["probe"]
    path = tmp_path / "job" / SOURCE_INFO_RELATIVE_PATH
    for rect, ok in (({"x": 0, "y": 8, "w": 160, "h": 128}, True), (None, True),
                     ({"x": 1, "y": 8, "w": 158, "h": 128}, False),
                     ({"x": 0, "y": 0, "w": 160, "h": 144}, False), ([0, 8, 160, 128], False)):
        stored = json.loads(path.read_text())
        stored["probe"]["content_rect"] = rect
        os.chmod(path, 0o600)
        path.write_bytes(canonical_json(stored))
        if ok:
            assert ensure_source_info(tmp_path / "job", source)["probe"]["content_rect"] == rect
        else:
            with pytest.raises(SourceInfoError):
                ensure_source_info(tmp_path / "job", source)
    # a file written before the bars were measured has no key, and stays valid
    stored["probe"].pop("content_rect")
    path.write_bytes(canonical_json(stored))
    assert "content_rect" not in ensure_source_info(tmp_path / "job", source)["probe"]
