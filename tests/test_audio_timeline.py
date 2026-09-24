from __future__ import annotations

import dataclasses
import json
import math
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from ai_clipper import audio_timeline
from ai_clipper.audio_timeline import (
    ANALYZER_VERSION,
    AudioTimeline,
    AudioTimelineError,
    analyze_audio_timeline,
    build_audio_timeline,
    read_audio_timeline,
    write_audio_timeline,
)

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")

# Shared tone layout (seconds): quiet bursts at 1-2, 2.5-3.5 and 5.6-6.6, one louder burst at
# 4-5, digital silence everywhere else.
_TONE_EXPR = (
    "if(between(t,1,2)+between(t,2.5,3.5)+between(t,5.6,6.6),0.1*sin(2*PI*440*t),"
    "if(between(t,4,5),0.5*sin(2*PI*440*t),0))"
)
_EXPECTED_SILENCES = ((0.0, 1.0), (2.0, 2.5), (3.5, 4.0), (5.0, 5.6), (6.6, 7.0))
_EXPECTED_CUTS = (2.0, 4.0)
_TOLERANCE = 0.15


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        [FFMPEG or "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args],
        check=True,
        capture_output=True,
        timeout=60,
    )


def _colour_inputs() -> list[str]:
    args: list[str] = []
    for colour, seconds in (("red", 2), ("blue", 2), ("green", 3)):
        args.extend(["-f", "lavfi", "-i", f"color=c={colour}:s=160x90:r=10:d={seconds}"])
    return args


@pytest.fixture(scope="module")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not FFMPEG or not FFPROBE:
        pytest.skip("FFmpeg tools are unavailable")
    root = tmp_path_factory.mktemp("audio-timeline-media")
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        f"aevalsrc='{_TONE_EXPR}':s=16000:d=7",
        "-c:a",
        "pcm_s16le",
        str(root / "tones.wav"),
    )
    _ffmpeg(
        *_colour_inputs(),
        "-f",
        "lavfi",
        "-i",
        f"aevalsrc='{_TONE_EXPR}|{_TONE_EXPR}':s=48000:d=7",
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map",
        "[v]",
        "-map",
        "3:a",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "pcm_s16le",
        str(root / "av.mkv"),
    )
    _ffmpeg(
        *_colour_inputs(),
        "-filter_complex",
        "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
        "-map",
        "[v]",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        str(root / "video-only.mp4"),
    )
    return root


def _fake_ffmpeg(tmp_path: Path, body: str) -> str:
    script = tmp_path / "fake-ffmpeg"
    script.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    script.chmod(0o755)
    return str(script)


def _assert_spans_close(
    actual: tuple[tuple[float, float], ...], expected: tuple[tuple[float, float], ...]
) -> None:
    assert len(actual) == len(expected), actual
    for (start, end), (want_start, want_end) in zip(actual, expected, strict=True):
        assert start == pytest.approx(want_start, abs=_TOLERANCE)
        assert end == pytest.approx(want_end, abs=_TOLERANCE)


def _argmax(values: tuple[float, ...]) -> int:
    return max(range(len(values)), key=values.__getitem__)


# --- whole-file analysis with synthesized media ---------------------------------------------


def test_audio_only_media_yields_relative_silences_and_the_loud_burst_peak(media_dir: Path):
    timeline = analyze_audio_timeline(media_dir / "tones.wav")

    assert timeline.analyzer_version == ANALYZER_VERSION
    assert timeline.step == pytest.approx(0.1)
    assert timeline.duration == pytest.approx(7.0, abs=0.05)
    assert len(timeline.rms_db) == len(timeline.loudness_z) == 70
    assert timeline.scene_cuts == ()
    assert "no_video_stream" in timeline.warnings
    _assert_spans_close(timeline.silences, _EXPECTED_SILENCES)

    # 0.1-amplitude sine is about -23 dBFS RMS, 0.5 about -9 dBFS; silence is floored at -90.
    assert timeline.rms_db[15] == pytest.approx(-23.0, abs=1.0)
    assert timeline.rms_db[45] == pytest.approx(-9.0, abs=1.0)
    assert timeline.rms_db[5] == -90.0
    peak_time = _argmax(timeline.loudness_z) * timeline.step
    assert 4.0 <= peak_time < 5.0
    assert max(timeline.loudness_z) > 1.0
    assert timeline.loudness_z[15] < 0.0 < timeline.loudness_z[45]


def test_video_with_audio_detects_both_colour_cuts_and_keeps_audio(media_dir: Path):
    timeline = analyze_audio_timeline(media_dir / "av.mkv")

    assert timeline.warnings == ()
    assert len(timeline.scene_cuts) == len(_EXPECTED_CUTS)
    for cut, expected in zip(timeline.scene_cuts, _EXPECTED_CUTS, strict=True):
        assert cut == pytest.approx(expected, abs=_TOLERANCE)
    # Stereo 48 kHz input is downmixed to mono 16 kHz with the same layout.
    _assert_spans_close(timeline.silences, _EXPECTED_SILENCES)
    assert 4.0 <= _argmax(timeline.loudness_z) * timeline.step < 5.0

    whole = timeline.window_stats(0.0, 7.0)
    assert whole["cut_rate_per_min"] == pytest.approx(2 / (7.0 / 60.0), rel=0.02)
    assert whole["silence_ratio"] == pytest.approx(3.0 / 7.0, abs=0.06)
    loud = timeline.window_stats(4.0, 5.0)
    quiet = timeline.window_stats(1.0, 2.0)
    assert loud["energy_mean_z"] > quiet["energy_mean_z"]
    assert loud["energy_peak_z"] > quiet["energy_peak_z"]
    assert loud["silence_ratio"] == pytest.approx(0.0, abs=0.11)


def test_video_without_audio_reports_no_audio_and_still_finds_cuts(media_dir: Path):
    timeline = analyze_audio_timeline(media_dir / "video-only.mp4")

    assert "no_audio_stream" in timeline.warnings
    assert timeline.rms_db == timeline.loudness_z == ()
    assert timeline.silences == ()
    assert len(timeline.scene_cuts) == 2
    stats = timeline.window_stats(0.0, 7.0)
    assert stats["energy_mean_z"] == stats["energy_peak_z"] == stats["silence_ratio"] == 0.0
    assert stats["cut_rate_per_min"] > 0
    assert timeline.nearest_quiet_point(3.0, 0.5) == 3.0


def test_scene_pass_can_be_disabled(media_dir: Path):
    timeline = analyze_audio_timeline(media_dir / "av.mkv", scene_cuts=False)

    assert timeline.scene_cuts == ()
    assert timeline.warnings == ("scene_cuts_disabled",)
    assert len(timeline.silences) == len(_EXPECTED_SILENCES)


def test_scene_pass_failure_degrades_to_a_warning(media_dir: Path, tmp_path: Path):
    fake = _fake_ffmpeg(
        tmp_path,
        f'case "$*" in *scene*) echo "decoder exploded" >&2; exit 3;; esac\nexec "{FFMPEG}" "$@"',
    )

    timeline = analyze_audio_timeline(media_dir / "av.mkv", ffmpeg_path=fake)

    assert timeline.scene_cuts == ()
    assert "scene_cuts_failed" in timeline.warnings
    _assert_spans_close(timeline.silences, _EXPECTED_SILENCES)


def test_audio_pass_timeout_is_bounded_and_kills_the_process_group(media_dir: Path, tmp_path: Path):
    # No `exec`: the shell's child keeps stdout open, so only a process-group kill ends it.
    fake = _fake_ffmpeg(tmp_path, "sleep 30\necho never")
    started = time.monotonic()

    with pytest.raises(AudioTimelineError, match="timed out"):
        analyze_audio_timeline(media_dir / "tones.wav", timeout=1.0, ffmpeg_path=fake)

    assert time.monotonic() - started < 6.0


def test_probe_timeout_raises_the_public_error(media_dir: Path, tmp_path: Path):
    fake_probe = tmp_path / "fake-ffprobe"
    fake_probe.write_text("#!/bin/sh\nsleep 30\necho never\n", encoding="utf-8")
    fake_probe.chmod(0o755)
    started = time.monotonic()

    with pytest.raises(AudioTimelineError, match="timed out"):
        analyze_audio_timeline(media_dir / "tones.wav", timeout=1.0, ffprobe_path=str(fake_probe))

    assert time.monotonic() - started < 6.0


def test_unparseable_frame_times_do_not_crash_the_audio_pass(media_dir: Path, tmp_path: Path):
    fake = _fake_ffmpeg(
        tmp_path,
        "printf 'frame:0    pts:0       pts_time:nan\\n"
        "lavfi.astats.Overall.RMS_level=-20.0\\n"
        "frame:1    pts:1600    pts_time:inf\\n"
        "lavfi.astats.Overall.RMS_level=-21.0\\n'",
    )

    timeline = analyze_audio_timeline(media_dir / "tones.wav", ffmpeg_path=fake)

    assert timeline.rms_db[:2] == (-20.0, -21.0)
    assert "audio_shorter_than_media" in timeline.warnings


def test_audio_pass_failure_is_sanitized(media_dir: Path, tmp_path: Path):
    secret_dir = tmp_path / "Private Client Name"
    secret_dir.mkdir()
    source = secret_dir / "interview-with-someone.wav"
    shutil.copyfile(media_dir / "tones.wav", source)
    fake = _fake_ffmpeg(tmp_path, 'echo "cannot open $*" >&2\nexit 1')

    with pytest.raises(AudioTimelineError) as caught:
        analyze_audio_timeline(source, ffmpeg_path=fake, scene_cuts=False)

    message = str(caught.value)
    assert "exit code 1" in message
    assert "interview-with-someone" not in message
    assert "Private Client Name" not in message


def test_unreadable_media_fails_probe_without_leaking_the_path(tmp_path: Path):
    if not FFPROBE:
        pytest.skip("FFmpeg tools are unavailable")
    source = tmp_path / "secret-name.mp4"
    source.write_bytes(b"definitely not a media file" * 10)

    with pytest.raises(AudioTimelineError, match="probe") as caught:
        analyze_audio_timeline(source)

    assert "secret-name" not in str(caught.value)


def test_analyze_rejects_invalid_arguments(tmp_path: Path):
    missing = tmp_path / "missing-name.wav"
    with pytest.raises(FileNotFoundError) as caught:
        analyze_audio_timeline(missing)
    assert "missing-name" not in str(caught.value)
    existing = tmp_path / "x.wav"
    existing.write_bytes(b"x")
    with pytest.raises(TypeError):
        analyze_audio_timeline(str(existing))  # type: ignore[arg-type]
    for bad in (0.0, -1.0, math.nan, math.inf):
        with pytest.raises(ValueError):
            analyze_audio_timeline(existing, timeout=bad)
    with pytest.raises(TypeError):
        analyze_audio_timeline(existing, scene_cuts="yes")  # type: ignore[arg-type]


# --- pure timeline construction ------------------------------------------------------------


def _speechy(count: int, low: float = -22.0, high: float = -18.0) -> list[float]:
    return [low if index % 2 else high for index in range(count)]


def test_loudness_z_is_relative_to_the_file_level():
    frames = [-60.0] * 20 + _speechy(100) + [-6.0] * 10 + _speechy(100) + [-60.0] * 20
    loud_podcast = build_audio_timeline(frames, duration=len(frames) * 0.1)
    quiet_podcast = build_audio_timeline([value - 15.0 for value in frames], duration=25.0)

    assert loud_podcast.loudness_z == pytest.approx(quiet_podcast.loudness_z, abs=0.011)
    peak = _argmax(loud_podcast.loudness_z)
    assert 120 <= peak < 130
    assert loud_podcast.loudness_z[peak] > 2.0
    assert all(abs(value) <= 6.0 for value in loud_podcast.loudness_z)


def test_loudness_z_smoothing_is_a_centred_half_second_window():
    frames = [-90.0] * 20 + [-20.0] * 100 + [-90.0] * 20
    spike = 70
    frames[spike] = -5.0
    timeline = build_audio_timeline(frames, duration=14.0)
    z = timeline.loudness_z

    plateau = z[spike - 2 : spike + 3]
    assert max(plateau) - min(plateau) < 0.011
    assert z[spike - 3] == pytest.approx(z[spike + 3], abs=0.011)
    assert plateau[0] > z[spike - 3] + 0.5


def test_silences_use_a_relative_floor_and_a_minimum_length():
    speech = [-20.0] * 20
    frames = (
        [-50.0] * 10
        + speech
        + [-50.0] * 2  # 0.2 s: too short
        + speech
        + [-50.0] * 3  # 0.3 s: a silence
        + speech
        + [-46.0] * 5  # floor + 4 dB: still quiet
        + speech
        + [-42.0] * 5  # floor + 8 dB: not quiet
        + speech
        + [-50.0] * 10
    )
    timeline = build_audio_timeline(frames, duration=13.45)

    # Canonical silences are rounded to milliseconds, so exact comparison is stable.
    assert timeline.silences == ((0.0, 1.0), (5.2, 5.5), (7.5, 8.0), (12.5, 13.45))
    shifted = build_audio_timeline([value + 10.0 for value in frames], duration=13.45)
    assert shifted.silences == timeline.silences


def test_flat_or_silent_audio_is_reported_instead_of_inventing_peaks():
    timeline = build_audio_timeline([-90.0] * 50, duration=5.0)

    assert set(timeline.loudness_z) == {0.0}
    assert "audio_flat" in timeline.warnings
    assert timeline.silences == ((0.0, 5.0),)


def test_build_normalizes_raw_measurements():
    timeline = build_audio_timeline(
        [-math.inf, -120.0, -12.3456, 3.0, math.nan],
        duration=0.5,
        scene_cuts=(0.3, 0.1, 0.1),
        warnings=("custom",),
    )

    assert timeline.rms_db == (-90.0, -90.0, -12.3, 0.0, -90.0)
    assert timeline.scene_cuts == (0.1, 0.3)
    assert timeline.warnings[0] == "custom"


# --- window statistics and quiet points ------------------------------------------------------


def _pattern_timeline() -> AudioTimeline:
    # 0-1 s silence, 1-3 s speech, 3-3.5 s silence, 3.5-8 s speech with a loud 5-6 s, 8-10 s silence.
    frames = (
        [-90.0] * 10
        + _speechy(20)
        + [-90.0] * 5
        + _speechy(15)
        + [-5.0] * 10
        + _speechy(20)
        + [-90.0] * 20
    )
    return build_audio_timeline(frames, duration=10.0, scene_cuts=(1.0, 2.0, 2.5, 9.0))


def test_window_stats_measure_energy_cuts_and_silence():
    timeline = _pattern_timeline()

    first = timeline.window_stats(0.0, 3.0)
    assert set(first) == {"energy_mean_z", "energy_peak_z", "cut_rate_per_min", "silence_ratio"}
    assert first["cut_rate_per_min"] == pytest.approx(3 / (3.0 / 60.0))
    assert first["silence_ratio"] == pytest.approx(1.0 / 3.0, abs=0.001)
    loud = timeline.window_stats(5.0, 6.0)
    assert loud["energy_peak_z"] > first["energy_peak_z"]
    assert loud["energy_mean_z"] > timeline.window_stats(1.2, 2.8)["energy_mean_z"]
    assert loud["silence_ratio"] == 0.0
    assert timeline.window_stats(-5.0, 3.0) == first
    assert timeline.window_stats(20.0, 30.0) == {
        "energy_mean_z": 0.0,
        "energy_peak_z": 0.0,
        "cut_rate_per_min": 0.0,
        "silence_ratio": 0.0,
    }
    for start, end in ((3.0, 3.0), (4.0, 2.0), (math.nan, 1.0), (0.0, math.inf)):
        with pytest.raises(ValueError):
            timeline.window_stats(start, end)


def test_nearest_quiet_point_prefers_silences_then_lower_energy():
    timeline = _pattern_timeline()

    # Already inside a silence: unchanged.
    assert timeline.nearest_quiet_point(3.2, 0.5) == 3.2
    # Speech ends at 3.0: the cut moves just inside the silence that follows.
    moved = timeline.nearest_quiet_point(2.8, 0.4)
    assert 3.0 <= moved <= 3.2
    # Speech starts at 3.5: the cut moves just inside the silence before it.
    moved = timeline.nearest_quiet_point(3.7, 0.4)
    assert 3.3 <= moved <= 3.5
    # No silence within reach: the nearest lowest-energy frame (-22 dB rather than -18 dB).
    shifted = timeline.nearest_quiet_point(1.84, 0.12)
    assert shifted == pytest.approx(1.75)
    assert timeline.rms_db[17] == -22.0 and timeline.rms_db[18] == -18.0
    # The frame at t is already among the quietest: unchanged.
    assert timeline.nearest_quiet_point(1.95, 0.12) == 1.95
    # Nothing quieter within reach: unchanged.
    assert timeline.nearest_quiet_point(5.5, 0.2) == 5.5
    assert timeline.nearest_quiet_point(1.95, 0.0) == 1.95
    for t, shift in ((math.nan, 0.5), (1.0, -0.1), (1.0, math.inf)):
        with pytest.raises(ValueError):
            timeline.nearest_quiet_point(t, shift)


def test_nearest_quiet_point_stays_within_the_shift_and_the_media():
    timeline = _pattern_timeline()
    for t in (0.0, 0.05, 1.33, 4.44, 7.9, 9.99, 10.0):
        for shift in (0.1, 0.3, 1.0):
            point = timeline.nearest_quiet_point(t, shift)
            assert abs(point - t) <= shift + 1e-9
            assert 0.0 <= point <= timeline.duration


def test_nearest_quiet_point_never_reads_a_wrapped_frame_for_negative_times():
    # No silences; the last frame is the quietest. A negative t must not index rms_db[-1]
    # (Python wraps) and must still land inside the media.
    frames = [-20.0] * 30
    frames[-1] = -40.0
    frames[1] = -25.0
    timeline = AudioTimeline(
        analyzer_version=ANALYZER_VERSION,
        duration=3.0,
        step=0.1,
        rms_db=tuple(frames),
        loudness_z=(0.0,) * 30,
        silences=(),
        scene_cuts=(),
        warnings=(),
    )

    point = timeline.nearest_quiet_point(-0.05, 0.3)

    assert 0.0 <= point <= 0.25
    assert point == pytest.approx(0.15)


# --- dataclass contract ------------------------------------------------------------------------


def test_timeline_contract_is_frozen_and_strict():
    timeline = _pattern_timeline()
    with pytest.raises(dataclasses.FrozenInstanceError):
        timeline.duration = 3.0  # type: ignore[misc]

    fields = {field.name: getattr(timeline, field.name) for field in dataclasses.fields(timeline)}
    bad_cases = [
        ({"analyzer_version": "audio-timeline-v0"}, ValueError),
        ({"duration": 0.0}, ValueError),
        ({"duration": True}, TypeError),
        ({"step": -0.1}, ValueError),
        ({"rms_db": list(timeline.rms_db)}, TypeError),
        ({"loudness_z": timeline.loudness_z[:-1]}, ValueError),
        ({"rms_db": (-91.0, *timeline.rms_db[1:])}, ValueError),
        ({"rms_db": (True, *timeline.rms_db[1:])}, TypeError),
        ({"loudness_z": (math.nan, *timeline.loudness_z[1:])}, ValueError),
        ({"silences": ((2.0, 1.0),)}, ValueError),
        ({"silences": ((1.0, 2.0), (1.5, 3.0))}, ValueError),
        ({"silences": ((1.0, 1.1),)}, ValueError),
        ({"silences": ((9.5, 11.0),)}, ValueError),
        ({"scene_cuts": (2.0, 1.0)}, ValueError),
        ({"scene_cuts": (-1.0,)}, ValueError),
        ({"warnings": ("",)}, TypeError),
        ({"rms_db": (-20.0,) * 150, "loudness_z": (0.0,) * 150}, ValueError),
    ]
    for override, error in bad_cases:
        with pytest.raises(error):
            AudioTimeline(**{**fields, **override})


# --- artifact ----------------------------------------------------------------------------------


def test_artifact_round_trips_compactly_and_atomically(tmp_path: Path):
    timeline = _pattern_timeline()
    path = tmp_path / "analysis" / "audio-timeline.json"

    assert write_audio_timeline(timeline, path) == path
    assert read_audio_timeline(path) == timeline
    text = path.read_text(encoding="utf-8")
    assert text.endswith("\n") and text.count("\n") == 1
    assert ", " not in text
    payload = json.loads(text)
    assert payload["analyzer_version"] == ANALYZER_VERSION
    assert all(round(value, 1) == value for value in payload["rms_db"])
    assert all(round(value, 2) == value for value in payload["loudness_z"])

    replacement = build_audio_timeline([-30.0] * 10, duration=1.0)
    write_audio_timeline(replacement, path)
    assert read_audio_timeline(path) == replacement
    assert sorted(item.name for item in path.parent.iterdir()) == ["audio-timeline.json"]


def _valid_payload() -> dict[str, object]:
    return _pattern_timeline().to_dict()


def _encode(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"))


def _mutated(**changes: object) -> str:
    return _encode({**_valid_payload(), **changes})


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        "[]",
        _mutated(analyzer_version="audio-timeline-v9"),
        _encode({key: value for key, value in _valid_payload().items() if key != "step"}),
        _mutated(extra=1),
        _mutated(duration=True),
        _mutated(duration="10"),
        _mutated(rms_db=[-20.0, "x"]),
        _mutated(loudness_z=[0.0]),
        _mutated(silences=[[1.0, 2.0, 3.0]]),
        _mutated(silences=[{"start": 1.0, "end": 2.0}]),
        _mutated(scene_cuts=[3.0, 1.0]),
        _mutated(warnings="oops"),
        _encode(_valid_payload()).replace('"rms_db":[-90.0', '"rms_db":[NaN', 1),
        _encode(_valid_payload())[:-1] + ',"step":0.1}',
    ],
    ids=[
        "not-json",
        "not-object",
        "version",
        "missing-key",
        "extra-key",
        "bool-number",
        "string-number",
        "string-sample",
        "length-mismatch",
        "silence-triple",
        "silence-object",
        "unsorted-cuts",
        "warnings-type",
        "nan",
        "duplicate-key",
    ],
)
def test_reader_rejects_malformed_artifacts(tmp_path: Path, content: str):
    path = tmp_path / "audio-timeline.json"
    assert content != _encode(_valid_payload())
    path.write_text(content, encoding="utf-8")

    with pytest.raises(ValueError):
        read_audio_timeline(path)


def test_reader_bounds_the_artifact_size(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / "audio-timeline.json"
    write_audio_timeline(_pattern_timeline(), path)
    monkeypatch.setattr(audio_timeline, "_MAX_ARTIFACT_BYTES", 64)

    with pytest.raises(ValueError, match="too large"):
        read_audio_timeline(path)


# --- command line ------------------------------------------------------------------------------


def test_cli_writes_the_artifact_and_reports_in_indonesian(
    media_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    output = tmp_path / "analysis" / "audio-timeline.json"

    assert audio_timeline.main([str(media_dir / "tones.wav"), "--output", str(output)]) == 0

    assert len(read_audio_timeline(output).silences) == len(_EXPECTED_SILENCES)
    printed = capsys.readouterr().out
    assert "Selesai" in printed and "jeda" in printed


def test_cli_reports_failures_without_a_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
):
    code = audio_timeline.main([str(tmp_path / "missing.mp4"), "--output", str(tmp_path / "o")])

    assert code == 1
    assert "Analisis gagal" in capsys.readouterr().err
    assert not (tmp_path / "o").exists()
