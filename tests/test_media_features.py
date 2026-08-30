import concurrent.futures
import dataclasses
import fcntl
import json
import math
import multiprocessing
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from ai_clipper import media_features
from ai_clipper.media_features import (
    ANALYZER_VERSION,
    AudioFeatures,
    MeasuredInterval,
    MediaFeatureAnalysis,
    VisualFeatures,
    analyze_media,
    read_feature_artifact,
    read_feature_artifacts,
    write_feature_artifacts,
)

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def _run_ffmpeg(*args: str) -> None:
    subprocess.run(
        [FFMPEG or "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        capture_output=True,
        timeout=30,
    )


def _blocking_visual_worker(_connection, _request) -> None:
    time.sleep(10)


def _large_visual_worker(connection, _request) -> None:
    cuts = [index / 10.0 for index in range(1, 10_000)]
    connection.send(
        (
            "ok",
            {
                "features": VisualFeatures(tuple(cuts), 10.0, 10.0, None, None, 10_000).to_dict(),
                "warnings": [],
            },
        )
    )
    connection.close()


def test_feature_contract_is_immutable_bounded_and_strictly_serializable():
    analysis = MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        source="fixture.mp4",
        source_duration=4.0,
        window_start=0.0,
        window_end=4.0,
        audio=AudioFeatures(
            rms_db=-12.5,
            energy_score=7.5,
            pause_intervals=(MeasuredInterval(0.0, 1.0),),
            pause_ratio=0.25,
            energy_change_score=3.0,
            sample_count=4,
        ),
        visual=VisualFeatures(
            scene_cut_timestamps=(2.0,),
            scene_activity_score=2.5,
            motion_score=4.0,
            face_presence_ratio=None,
            face_activity_score=None,
            sample_count=4,
        ),
        warnings=(),
        provenance=("ffprobe", "ffmpeg", "opencv"),
    )

    assert MediaFeatureAnalysis.from_dict(analysis.to_dict()) == analysis
    assert (
        json.loads(json.dumps(analysis.to_dict(), allow_nan=False))["audio"]["energy_score"] == 7.5
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        analysis.source_duration = 5.0  # type: ignore[misc]
    with pytest.raises(ValueError, match="unknown"):
        MediaFeatureAnalysis.from_dict({**analysis.to_dict(), "emotion": 9.0})
    with pytest.raises(ValueError, match="between 0 and 10"):
        AudioFeatures(None, 10.1, (), None, None, 0)
    with pytest.raises(ValueError, match="finite"):
        VisualFeatures((), None, math.nan, None, None, 0)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_audio_analysis_measures_silence_energy_and_change_with_sample_cap(tmp_path: Path):
    source = tmp_path / "energy.wav"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=8000:cl=mono:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=1",
        "-filter_complex",
        "[1:a]volume=0.08[quiet];[2:a]volume=0.8[loud];[0:a][quiet][loud]concat=n=3:v=0:a=1[out]",
        "-map",
        "[out]",
        str(source),
    )

    measured = analyze_media(source, max_samples=6, timeout=20)

    assert measured.audio.sample_count <= 6
    assert measured.audio.rms_db is not None and measured.audio.rms_db < 0
    assert measured.audio.energy_score is not None
    assert 0.0 <= measured.audio.energy_score <= 10.0
    assert measured.audio.pause_ratio is not None and measured.audio.pause_ratio >= 0.25
    assert measured.audio.pause_intervals
    assert measured.audio.energy_change_score is not None
    assert measured.audio.energy_change_score > 0
    assert measured.visual.sample_count == 0
    assert any("video stream" in warning for warning in measured.warnings)


def test_successful_empty_ffmpeg_output_reports_audio_measurements_unavailable(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "audio.bin"
    source.write_bytes(b"audio")
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, True, False))
    monkeypatch.setattr(
        media_features,
        "_run",
        lambda *_args: subprocess.CompletedProcess([], 0, stdout="", stderr=""),
    )

    result = analyze_media(source, max_samples=4)

    assert result.audio.rms_db is None
    assert result.audio.energy_score is None
    assert result.audio.pause_ratio is None
    assert result.audio.energy_change_score is None
    assert result.audio.sample_count == 0
    assert any("mean volume metadata" in warning for warning in result.warnings)
    assert any("pause metadata" in warning for warning in result.warnings)
    assert any("RMS bucket metadata" in warning for warning in result.warnings)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_audio_analysis_measures_no_pauses_for_real_continuous_tone(tmp_path: Path):
    source = tmp_path / "tone.wav"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=1",
        str(source),
    )

    measured = analyze_media(source, max_samples=4, timeout=20)

    assert measured.audio.pause_ratio == 0.0
    assert measured.audio.pause_intervals == ()
    assert not any("pause metadata" in warning for warning in measured.warnings)


def test_parseable_digital_silence_is_measured_as_zero_energy(tmp_path: Path, monkeypatch):
    source = tmp_path / "audio.bin"
    source.write_bytes(b"audio")
    outputs = iter(
        [
            subprocess.CompletedProcess([], 0, stdout="", stderr="mean_volume: -inf dB"),
            subprocess.CompletedProcess(
                [],
                0,
                stdout=(
                    "lavfi.astats.Overall.RMS_level=-inf\nlavfi.astats.Overall.RMS_level=-inf\n"
                ),
                stderr="",
            ),
        ]
    )
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, True, False))
    monkeypatch.setattr(media_features, "_run", lambda *_args: next(outputs))

    result = analyze_media(source, max_samples=4)

    assert result.audio.rms_db is None
    assert result.audio.energy_score == 0.0
    assert result.audio.energy_change_score == 0.0
    assert result.audio.sample_count == 2
    assert not any("metadata unavailable" in warning for warning in result.warnings)


def test_audio_contract_canonicalizes_unordered_overlapping_and_touching_pauses():
    features = AudioFeatures(
        None,
        None,
        (
            MeasuredInterval(4.0, 5.0),
            MeasuredInterval(1.0, 3.0),
            MeasuredInterval(2.0, 4.0),
            MeasuredInterval(8.0, 9.0),
        ),
        None,
        None,
        0,
    )

    assert features.pause_intervals == (
        MeasuredInterval(1.0, 5.0),
        MeasuredInterval(8.0, 9.0),
    )


def test_parse_silences_uses_clipped_union_for_ratio_before_interval_cap():
    intervals, duration = media_features._parse_silences(
        """silence_start: 4.0
silence_end: 8.0
silence_start: 1.0
silence_end: 5.0
silence_start: 9.0
silence_end: 12.0""",
        duration=10.0,
        max_intervals=1,
        timeline_offset=2.0,
    )

    assert intervals == (MeasuredInterval(3.0, 10.0),)
    assert duration == 8.0


def test_partial_ffmpeg_output_preserves_bucket_change_when_mean_volume_is_absent(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "audio.bin"
    source.write_bytes(b"audio")
    outputs = iter(
        [
            subprocess.CompletedProcess([], 0, stdout="", stderr="silence_start: 0.25"),
            subprocess.CompletedProcess(
                [],
                0,
                stdout=("lavfi.astats.Overall.RMS_level=-30\nlavfi.astats.Overall.RMS_level=-12\n"),
                stderr="",
            ),
        ]
    )
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, True, False))
    monkeypatch.setattr(media_features, "_run", lambda *_args: next(outputs))

    result = analyze_media(source, max_samples=4)

    assert result.audio.rms_db is None
    assert result.audio.energy_score is None
    assert result.audio.energy_change_score == 3.0
    assert result.audio.sample_count == 2
    assert any("mean volume metadata" in warning for warning in result.warnings)


def test_partial_ffmpeg_output_preserves_mean_energy_without_rms_buckets(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "audio.bin"
    source.write_bytes(b"audio")
    outputs = iter(
        [
            subprocess.CompletedProcess([], 0, stdout="", stderr="mean_volume: -18.0 dB"),
            subprocess.CompletedProcess([], 0, stdout="", stderr=""),
        ]
    )
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, True, False))
    monkeypatch.setattr(media_features, "_run", lambda *_args: next(outputs))

    result = analyze_media(source, max_samples=4)

    assert result.audio.rms_db == -18.0
    assert result.audio.energy_score == 7.0
    assert result.audio.energy_change_score is None
    assert result.audio.sample_count == 0
    assert any("RMS bucket metadata" in warning for warning in result.warnings)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_visual_analysis_detects_hard_cut_and_more_motion_than_static(tmp_path: Path):
    active = tmp_path / "active.mp4"
    static = tmp_path / "static.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=12:d=2",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=12:d=2",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[out]",
        "-map",
        "[out]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(active),
    )
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=160x90:r=12:d=4",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        str(static),
    )

    active_result = analyze_media(active, max_samples=8, timeout=20)
    static_result = analyze_media(static, max_samples=8, timeout=20)

    assert active_result.visual.sample_count <= 8
    assert any(1.4 <= cut <= 2.6 for cut in active_result.visual.scene_cut_timestamps)
    assert active_result.visual.scene_activity_score is not None
    assert active_result.visual.motion_score is not None
    assert static_result.visual.motion_score is not None
    assert active_result.visual.motion_score > static_result.visual.motion_score
    assert active_result.visual.face_presence_ratio is None
    assert active_result.visual.face_activity_score is None
    encoded = json.dumps(active_result.to_dict()).casefold()
    for forbidden in ("emotion", "expression", "speaker", "virality"):
        assert forbidden not in encoded


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_missing_audio_command_keeps_visual_measurements_and_warning(tmp_path: Path):
    source = tmp_path / "av.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=80x60:r=5:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=1",
        "-shortest",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        str(source),
    )

    result = analyze_media(source, max_samples=4, ffmpeg_path="definitely-missing-ffmpeg")

    assert result.audio.sample_count == 0
    assert result.audio.rms_db is None
    assert result.visual.sample_count > 0
    assert any("audio analysis unavailable" in warning for warning in result.warnings)


def test_visual_timeout_is_hard_kills_worker_and_returns_partial_result(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "video.bin"
    source.write_bytes(b"video")
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, False, True))
    run_visual = media_features._run_visual_analysis
    monkeypatch.setattr(
        media_features,
        "_run_visual_analysis",
        lambda **kwargs: run_visual(**kwargs, worker_target=_blocking_visual_worker),
    )
    children_before = {child.pid for child in multiprocessing.active_children()}
    began = time.monotonic()

    result = analyze_media(source, max_samples=4, timeout=0.1)

    assert time.monotonic() - began < 2.0
    assert result.visual == VisualFeatures((), None, None, None, None, 0)
    assert any("visual analysis timed out" in warning for warning in result.warnings)
    assert {child.pid for child in multiprocessing.active_children()} == children_before


def test_visual_worker_drains_large_spawn_payload_before_join(tmp_path: Path):
    began = time.monotonic()

    result, warnings = media_features._run_visual_analysis(
        source=tmp_path / "video.bin",
        start=0.0,
        duration=1_000.0,
        max_samples=10_000,
        timeout=5.0,
        worker_target=_large_visual_worker,
    )

    assert result.sample_count == 10_000
    assert len(result.scene_cut_timestamps) == 9_999
    assert warnings == ()
    assert time.monotonic() - began < 5.0


def test_cv2_error_is_controlled_at_visual_boundary_and_audio_survives(tmp_path: Path, monkeypatch):
    class FakeCvError(Exception):
        pass

    class ErrorCapture:
        def isOpened(self):
            return True

        def set(self, *_args):
            return True

        def read(self):
            raise FakeCvError("native decode failed")

        def release(self):
            return None

    class FakeCv2:
        error = FakeCvError
        CAP_PROP_POS_MSEC = 0
        INTER_AREA = 0

        @staticmethod
        def VideoCapture(_source):
            return ErrorCapture()

    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)
    with pytest.raises(media_features._VisualAnalysisUnavailable, match="native decode failed"):
        media_features._analyze_visual(
            tmp_path / "video.mp4", start=0.0, duration=1.0, max_samples=2
        )

    source = tmp_path / "av.bin"
    source.write_bytes(b"av")
    audio = AudioFeatures(-18.0, 7.0, (), 0.0, 1.0, 2)
    monkeypatch.setattr(media_features, "_probe_media", lambda *_args: (1.0, True, True))
    monkeypatch.setattr(media_features, "_analyze_audio", lambda *_args, **_kwargs: (audio, ()))
    monkeypatch.setattr(
        media_features,
        "_run_visual_analysis",
        lambda **_kwargs: (_ for _ in ()).throw(
            media_features._VisualAnalysisUnavailable("OpenCV native decode failed")
        ),
    )

    result = analyze_media(source, max_samples=2)

    assert result.audio == audio
    assert result.visual.sample_count == 0
    assert any("OpenCV native decode failed" in warning for warning in result.warnings)


def test_visual_boundary_does_not_swallow_programming_errors(tmp_path: Path, monkeypatch):
    class ProgrammingErrorCapture:
        def isOpened(self):
            return True

        def set(self, *_args):
            return True

        def read(self):
            raise TypeError("bug")

        def release(self):
            return None

    class FakeCv2:
        class error(Exception):
            pass

        CAP_PROP_POS_MSEC = 0
        INTER_AREA = 0

        @staticmethod
        def VideoCapture(_source):
            return ProgrammingErrorCapture()

    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)

    with pytest.raises(TypeError, match="bug"):
        media_features._analyze_visual(
            tmp_path / "video.mp4", start=0.0, duration=1.0, max_samples=2
        )


def test_visual_samples_use_actual_seek_timestamps_and_report_rejected_seek(
    tmp_path: Path, monkeypatch
):
    class Difference:
        @staticmethod
        def mean():
            return 255.0

    class Capture:
        set_results = iter((False, True, True))
        timestamps = iter((100.0, 900.0))

        def isOpened(self):
            return True

        def set(self, *_args):
            return next(self.set_results)

        def read(self):
            return True, object()

        def get(self, *_args):
            return next(self.timestamps)

        def release(self):
            return None

    class FakeCv2:
        class error(Exception):
            pass

        CAP_PROP_POS_MSEC = 0
        INTER_AREA = 0
        VideoCapture = staticmethod(lambda _source: Capture())
        resize = staticmethod(lambda frame, *_args, **_kwargs: frame)
        absdiff = staticmethod(lambda _left, _right: Difference())

    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)

    visual, warnings = media_features._analyze_visual(
        tmp_path / "video.mp4", start=0.0, duration=1.0, max_samples=3
    )

    assert visual.scene_cut_timestamps == (0.9,)
    assert visual.sample_count == 2
    assert any("seek" in warning for warning in warnings)


def test_visual_skips_nonmonotonic_actual_timestamp_with_warning(tmp_path: Path, monkeypatch):
    class Capture:
        timestamps = iter((500.0, 500.0))

        def isOpened(self):
            return True

        def set(self, *_args):
            return True

        def read(self):
            return True, object()

        def get(self, *_args):
            return next(self.timestamps)

        def release(self):
            return None

    class FakeCv2:
        class error(Exception):
            pass

        CAP_PROP_POS_MSEC = 0
        INTER_AREA = 0
        VideoCapture = staticmethod(lambda _source: Capture())
        resize = staticmethod(lambda frame, *_args, **_kwargs: frame)

    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)

    visual, warnings = media_features._analyze_visual(
        tmp_path / "video.mp4", start=0.0, duration=1.0, max_samples=2
    )

    assert visual.sample_count == 1
    assert any("strictly increasing" in warning for warning in warnings)


def test_visual_analysis_retains_only_previous_thumbnail(tmp_path: Path, monkeypatch):
    class Thumbnail:
        alive = 0
        maximum_alive = 0

        def __init__(self):
            type(self).alive += 1
            type(self).maximum_alive = max(type(self).maximum_alive, type(self).alive)

        def __del__(self):
            type(self).alive -= 1

    class Difference:
        @staticmethod
        def mean():
            return 0.0

    class Capture:
        index = 0

        def isOpened(self):
            return True

        def set(self, *_args):
            return True

        def read(self):
            self.index += 1
            return True, object()

        def get(self, *_args):
            return float(self.index)

        def release(self):
            return None

    class FakeCv2:
        class error(Exception):
            pass

        CAP_PROP_POS_MSEC = 0
        INTER_AREA = 0
        VideoCapture = staticmethod(lambda _source: Capture())
        resize = staticmethod(lambda *_args, **_kwargs: Thumbnail())
        absdiff = staticmethod(lambda _left, _right: Difference())

    monkeypatch.setitem(sys.modules, "cv2", FakeCv2)

    visual, _warnings = media_features._analyze_visual(
        tmp_path / "video.mp4", start=0.0, duration=2.0, max_samples=1_000
    )

    assert visual.sample_count == 1_000
    assert Thumbnail.maximum_alive <= 2


def test_invalid_inputs_and_probe_timeout_are_diagnostic(tmp_path: Path, monkeypatch):
    with pytest.raises(TypeError, match="pathlib.Path"):
        analyze_media("video.mp4")  # type: ignore[arg-type]
    with pytest.raises(FileNotFoundError):
        analyze_media(tmp_path / "missing.mp4")

    source = tmp_path / "anything.bin"
    source.write_bytes(b"x")

    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("ffprobe", 0.01)

    monkeypatch.setattr(subprocess, "run", timeout)
    with pytest.raises(RuntimeError, match="media probe failed.*TimeoutExpired"):
        analyze_media(source, timeout=0.01)
    with pytest.raises(ValueError, match="max_samples"):
        analyze_media(source, max_samples=1)


@pytest.mark.parametrize(
    ("payload", "detail"),
    [
        ([], "top-level"),
        ({"format": [], "streams": []}, "format"),
        ({"format": {"duration": "1"}, "streams": {}}, "streams"),
        ({"format": {"duration": "1"}, "streams": ["audio"]}, "stream entry"),
        ({"format": {"duration": "1"}, "streams": [{"codec_type": []}]}, "codec_type"),
        ({"format": {"duration": "1"}, "streams": [{"codec_type": {}}]}, "codec_type"),
        ({"format": {"duration": "1"}, "streams": [{"codec_type": 1}]}, "codec_type"),
        ({"format": {"duration": "1"}, "streams": [{}]}, "codec_type"),
        ({"format": {"duration": True}, "streams": []}, "duration"),
    ],
)
def test_malformed_ffprobe_json_shapes_are_diagnostic(
    tmp_path: Path, monkeypatch, payload: object, detail: str
):
    source = tmp_path / "anything.bin"
    source.write_bytes(b"x")
    monkeypatch.setattr(
        media_features,
        "_run",
        lambda *_args: subprocess.CompletedProcess([], 0, stdout=json.dumps(payload), stderr=""),
    )

    with pytest.raises(RuntimeError, match=rf"media probe failed.*ValueError.*{detail}"):
        analyze_media(source)


def test_atomic_scoped_artifacts_round_trip_and_reject_unknown_fields(tmp_path: Path):
    analysis = MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        source="fixture.mp4",
        source_duration=4.0,
        window_start=1.0,
        window_end=3.0,
        audio=AudioFeatures(-20.0, 6.667, (), 0.0, 2.0, 4),
        visual=VisualFeatures((2.0,), 3.0, 4.0, None, None, 4),
        warnings=("face measurements not requested",),
        provenance=("ffprobe", "ffmpeg", "opencv"),
    )

    audio_path, scenes_path = write_feature_artifacts(analysis, tmp_path)

    assert audio_path == tmp_path / "analysis" / "audio-features.json"
    assert scenes_path == tmp_path / "analysis" / "scenes.json"
    assert read_feature_artifact(audio_path) == analysis.audio
    assert read_feature_artifact(scenes_path) == analysis.visual
    assert not list((tmp_path / "analysis").glob("*.tmp"))

    corrupted = json.loads(audio_path.read_text(encoding="utf-8"))
    corrupted["emotion"] = 9
    audio_path.write_text(json.dumps(corrupted), encoding="utf-8")
    with pytest.raises(ValueError, match="unknown"):
        read_feature_artifact(audio_path)


def test_feature_artifact_pair_reader_reconstructs_complete_analysis(tmp_path: Path):
    analysis = MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        analysis_id="complete-generation",
        source="fixture.mp4",
        source_duration=4.0,
        window_start=1.0,
        window_end=3.0,
        audio=AudioFeatures(-20.0, 6.667, (), 0.0, 2.0, 4),
        visual=VisualFeatures((2.0,), 3.0, 4.0, None, None, 4),
        warnings=("face measurements not requested",),
        provenance=("ffprobe", "ffmpeg", "opencv"),
    )
    write_feature_artifacts(analysis, tmp_path)

    assert read_feature_artifacts(tmp_path) == analysis


def test_feature_artifact_pair_reader_rejects_mismatched_generations(tmp_path: Path):
    analysis = MediaFeatureAnalysis(
        ANALYZER_VERSION,
        "fixture.mp4",
        4.0,
        1.0,
        3.0,
        AudioFeatures(-20.0, 6.667, (), 0.0, 2.0, 4),
        VisualFeatures((2.0,), 3.0, 4.0, None, None, 4),
        (),
        ("ffprobe",),
        analysis_id="first-generation",
    )
    _, scenes_path = write_feature_artifacts(analysis, tmp_path)
    scenes = json.loads(scenes_path.read_text(encoding="utf-8"))
    scenes["analysis_id"] = "second-generation"
    scenes_path.write_text(json.dumps(scenes), encoding="utf-8")

    with pytest.raises(ValueError, match="metadata mismatch: analysis_id"):
        read_feature_artifacts(tmp_path)


def test_concurrent_artifact_writers_publish_one_complete_analysis_pair(tmp_path: Path):
    analyses = [
        MediaFeatureAnalysis(
            ANALYZER_VERSION,
            f"generation-{index}.mp4",
            20.0,
            float(index),
            float(index + 1),
            AudioFeatures(-20.0, 6.667, (), 0.0, 2.0, 4),
            VisualFeatures((index + 0.5,), 3.0, 4.0, None, None, 4),
            (),
            (f"generation-{index}",),
        )
        for index in range(12)
    ]

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as executor:
        results = list(
            executor.map(lambda analysis: write_feature_artifacts(analysis, tmp_path), analyses)
        )

    assert len(results) == len(analyses)
    audio = json.loads((tmp_path / "analysis" / "audio-features.json").read_text())
    scenes = json.loads((tmp_path / "analysis" / "scenes.json").read_text())
    assert audio["source"] == scenes["source"]
    assert audio["window_start"] == scenes["window_start"]
    assert audio["provenance"] == scenes["provenance"]
    assert audio["analysis_id"] == scenes["analysis_id"]
    assert audio["analysis_id"]
    assert not list((tmp_path / "analysis").glob(".*.tmp"))


def test_concurrent_artifact_readers_never_combine_generations(tmp_path: Path):
    analyses = tuple(
        MediaFeatureAnalysis(
            ANALYZER_VERSION,
            f"generation-{index}.mp4",
            100.0,
            float(index),
            float(index + 1),
            AudioFeatures(-20.0, float(index % 11), (), 0.0, 2.0, index),
            VisualFeatures((index + 0.5,), 3.0, 4.0, None, None, index),
            (f"warning-{index}",),
            (f"generation-{index}",),
            analysis_id=f"generation-{index}",
        )
        for index in range(40)
    )
    write_feature_artifacts(analyses[0], tmp_path)
    start = threading.Barrier(5)

    def publish_generations() -> None:
        start.wait()
        for analysis in analyses[1:]:
            write_feature_artifacts(analysis, tmp_path)

    def read_generations() -> list[MediaFeatureAnalysis]:
        start.wait()
        return [read_feature_artifacts(tmp_path) for _ in range(100)]

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
        writer = executor.submit(publish_generations)
        readers = [executor.submit(read_generations) for _ in range(4)]
        writer.result()
        observed = [analysis for reader in readers for analysis in reader.result()]

    assert len(observed) == 400
    assert all(analysis in analyses for analysis in observed)
    assert read_feature_artifacts(tmp_path) == analyses[-1]


def test_artifact_publication_lock_closes_descriptor_when_unlock_fails(tmp_path: Path, monkeypatch):
    artifact_dir = tmp_path / "analysis"
    artifact_dir.mkdir()
    original_flock = fcntl.flock
    original_close = os.close
    unlocked_descriptors: list[int] = []
    closed_descriptors: list[int] = []

    def fail_unlock(descriptor: int, operation: int) -> None:
        if operation == fcntl.LOCK_UN:
            unlocked_descriptors.append(descriptor)
            raise OSError("injected unlock failure")
        original_flock(descriptor, operation)

    def track_close(descriptor: int) -> None:
        closed_descriptors.append(descriptor)
        original_close(descriptor)

    monkeypatch.setattr(fcntl, "flock", fail_unlock)
    monkeypatch.setattr(os, "close", track_close)
    try:
        with (
            pytest.raises(OSError, match="injected unlock failure"),
            media_features._artifact_publication_lock(artifact_dir),
        ):
            pass

        assert closed_descriptors == unlocked_descriptors
    finally:
        for descriptor in unlocked_descriptors:
            if descriptor not in closed_descriptors:
                original_close(descriptor)


@pytest.mark.skipif(
    not hasattr(os, "fork") or not hasattr(os, "register_at_fork"),
    reason="fork lock reset is unavailable",
)
def test_artifact_publication_lock_resets_inherited_thread_lock_after_fork(tmp_path: Path):
    artifact_dir = tmp_path / "analysis"
    artifact_dir.mkdir()
    lock = media_features._ARTIFACT_THREAD_LOCK
    lock.acquire()
    child_pid: int | None = None
    reaped = False

    try:
        child_pid = os.fork()
        if child_pid == 0:
            try:
                signal.signal(signal.SIGALRM, lambda *_args: os._exit(124))
                signal.alarm(2)
                with media_features._artifact_publication_lock(artifact_dir):
                    pass
                signal.alarm(0)
            except OSError:
                os._exit(1)
            os._exit(0)
    finally:
        lock.release()

    assert child_pid is not None
    deadline = time.monotonic() + 5
    try:
        while time.monotonic() < deadline:
            waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
            if waited_pid == child_pid:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0
                break
            time.sleep(0.01)
        else:
            pytest.fail("forked child did not exit within the bounded timeout")
    finally:
        if not reaped:
            os.kill(child_pid, signal.SIGKILL)
            os.waitpid(child_pid, 0)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_windowed_pause_timestamps_stay_on_source_timeline(tmp_path: Path):
    source = tmp_path / "window.wav"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=8000:cl=mono:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=2",
        "-filter_complex",
        "[0:a][1:a]concat=n=2:v=0:a=1[out]",
        "-map",
        "[out]",
        str(source),
    )

    result = analyze_media(source, start=0.5, end=2.0, max_samples=4)

    assert result.audio.pause_intervals
    assert result.audio.pause_intervals[0].start == pytest.approx(0.5, abs=0.05)
    assert result.audio.pause_intervals[0].end == pytest.approx(1.0, abs=0.05)


def test_analysis_rejects_measurement_timestamps_outside_window():
    with pytest.raises(ValueError, match="outside analysis window"):
        MediaFeatureAnalysis(
            ANALYZER_VERSION,
            "fixture.mp4",
            10.0,
            4.0,
            6.0,
            AudioFeatures(None, None, (MeasuredInterval(1.0, 2.0),), 0.5, None, 1),
            VisualFeatures((), None, None, None, None, 0),
            (),
            ("ffprobe",),
        )

    with pytest.raises(ValueError, match="outside analysis window"):
        MediaFeatureAnalysis(
            ANALYZER_VERSION,
            "fixture.mp4",
            10.0,
            4.0,
            6.0,
            AudioFeatures(None, None, (), None, None, 0),
            VisualFeatures((8.0,), None, None, None, None, 1),
            (),
            ("ffprobe",),
        )


@pytest.mark.parametrize(
    ("kind", "features"),
    [
        (
            "audio",
            AudioFeatures(None, None, (MeasuredInterval(1.0, 2.0),), 0.5, None, 1).to_dict(),
        ),
        ("visual", VisualFeatures((8.0,), None, None, None, None, 1).to_dict()),
    ],
)
def test_read_artifact_rejects_tampered_measurements_outside_window(
    tmp_path: Path, kind: str, features: dict[str, object]
):
    artifact = tmp_path / f"{kind}.json"
    artifact.write_text(
        json.dumps(
            {
                "analyzer_version": ANALYZER_VERSION,
                "analysis_id": "tampered-generation",
                "kind": kind,
                "source": "fixture.mp4",
                "source_duration": 10.0,
                "window_start": 4.0,
                "window_end": 6.0,
                "warnings": [],
                "provenance": ["ffprobe"],
                "features": features,
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="outside analysis window"):
        read_feature_artifact(artifact)


@pytest.mark.skipif(not FFMPEG or not FFPROBE, reason="FFmpeg tools are unavailable")
def test_missing_opencv_returns_audio_and_warning(tmp_path: Path, monkeypatch):
    source = tmp_path / "av.mp4"
    _run_ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=80x60:r=5:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=8000:duration=1",
        "-shortest",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        str(source),
    )
    monkeypatch.setitem(sys.modules, "cv2", None)
    with pytest.raises(media_features._VisualAnalysisUnavailable, match="OpenCV is unavailable"):
        media_features._analyze_visual(source, start=0.0, duration=1.0, max_samples=4)
    monkeypatch.setattr(
        media_features,
        "_run_visual_analysis",
        lambda **_kwargs: (_ for _ in ()).throw(
            media_features._VisualAnalysisUnavailable(
                "OpenCV is unavailable; install the vision extra"
            )
        ),
    )

    result = analyze_media(source, max_samples=4)

    assert result.audio.sample_count > 0
    assert result.visual.sample_count == 0
    assert any("OpenCV is unavailable" in warning for warning in result.warnings)
