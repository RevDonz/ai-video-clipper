import json
import subprocess
import tempfile
from pathlib import Path

import pytest

from ai_clipper.models import TranscriptSegment
from ai_clipper.render import render_vertical


def _make_source(path: Path) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _make_video_only_source(path: Path, *, duration: float = 3.0) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=640x360:rate=24:duration={duration}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def test_renders_vertical_captioned_clip_with_expected_duration(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    _make_source(source)
    transcript = [TranscriptSegment(0.5, 2.5, "Ini adalah momen penting untuk diuji.")]

    render_vertical(
        source,
        output,
        start=0.5,
        end=2.5,
        transcript=transcript,
        width=360,
        height=640,
    )

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio:format=duration",
            "-of",
            "json",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(probe.stdout)
    video_stream = next(stream for stream in metadata["streams"] if "width" in stream)
    assert video_stream["width"] == 360
    assert video_stream["height"] == 640
    assert video_stream["sample_aspect_ratio"] == "1:1"
    assert 1.9 <= float(metadata["format"]["duration"]) <= 2.1
    assert output.stat().st_size > 5_000


def test_video_only_source_gets_exactly_one_full_length_aac_stream(tmp_path: Path):
    source = tmp_path / "silent.mp4"
    output = tmp_path / "clip.mp4"
    _make_video_only_source(source)

    render_vertical(
        source,
        output,
        start=0.5,
        end=2.5,
        transcript=[TranscriptSegment(0.5, 2.5, "Silence is synthesized safely.")],
        width=360,
        height=640,
    )

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,duration",
            "-of",
            "json",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(probe.stdout)["streams"]
    assert [(stream["codec_type"], stream["codec_name"]) for stream in streams] == [
        ("video", "h264"),
        ("audio", "aac"),
    ]
    assert all(1.75 <= float(stream["duration"]) <= 2.25 for stream in streams)


def test_rejects_clip_beyond_selected_video_duration_when_audio_is_longer(tmp_path: Path):
    source = tmp_path / "short-video-long-audio.mp4"
    output = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24:duration=0.5",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    with pytest.raises(ValueError, match="video duration"):
        render_vertical(source, output, start=0.0, end=2.0, transcript=[], width=360, height=640)

    assert not output.exists()
    assert not output.with_suffix(".srt").exists()


def test_renders_when_output_path_contains_filtergraph_metacharacters(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "creator's [draft];clip" / "clip.mp4"
    _make_source(source)

    rendered = render_vertical(
        source,
        output,
        start=0.5,
        end=1.5,
        transcript=[TranscriptSegment(0.5, 1.5, "Jangan interpolasi path pengguna.")],
        width=360,
        height=640,
    )

    assert rendered == output
    assert output.is_file()
    assert output.with_suffix(".srt").is_file()


def test_renders_when_temporary_directory_contains_filtergraph_metacharacters(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    hostile_temp = tmp_path / "creator's:temp"
    hostile_temp.mkdir()
    _make_source(source)
    monkeypatch.setattr(tempfile, "tempdir", str(hostile_temp))

    rendered = render_vertical(
        source,
        output,
        start=0.5,
        end=1.5,
        transcript=[TranscriptSegment(0.5, 1.5, "Path sementara harus aman.")],
        width=360,
        height=640,
    )

    assert rendered == output
    assert output.is_file()


@pytest.mark.parametrize(
    ("start", "end"),
    [(float("nan"), 1.0), (0.0, float("nan")), (0.0, float("inf"))],
)
def test_rejects_non_finite_render_timestamps(tmp_path: Path, start: float, end: float):
    source = tmp_path / "source.mp4"
    source.touch()

    with pytest.raises(ValueError, match="finite"):
        render_vertical(source, tmp_path / "clip.mp4", start=start, end=end, transcript=[])


def test_rejects_clip_end_after_source_duration(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    _make_source(source)

    with pytest.raises(ValueError, match="source video duration"):
        render_vertical(
            source,
            output,
            start=2.0,
            end=3.5,
            transcript=[TranscriptSegment(2.0, 3.0, "Jangan hasilkan klip pendek.")],
            width=360,
            height=640,
        )

    assert not output.exists()


def test_renders_fit_blur_layout_without_distorting_canvas(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "fit-blur.mp4"
    _make_source(source)

    render_vertical(
        source,
        output,
        start=0.5,
        end=1.5,
        transcript=[TranscriptSegment(0.5, 1.5, "Frame utuh tetap proporsional.")],
        width=360,
        height=640,
        render_mode="fit-blur",
    )

    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio",
            "-of",
            "json",
            str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = next(item for item in json.loads(probe.stdout)["streams"] if "width" in item)
    assert stream == {"width": 360, "height": 640, "sample_aspect_ratio": "1:1"}


def test_rejects_unknown_render_mode(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.touch()

    with pytest.raises(ValueError, match="render mode"):
        render_vertical(
            source,
            tmp_path / "clip.mp4",
            start=0.0,
            end=1.0,
            transcript=[],
            render_mode="stretch",
        )


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda data: data["streams"][0].update(codec_name="hevc"), "video codec"),
        (lambda data: data["streams"][1].update(codec_name="mp3"), "audio codec"),
        (lambda data: data["streams"][0].update(width=358), "dimensions"),
        (lambda data: data["streams"][0].update(sample_aspect_ratio="4:3"), "sample aspect ratio"),
        (lambda data: data["streams"][0].update(duration="0.100"), "video duration"),
        (lambda data: data["streams"][1].update(duration="0.100"), "audio duration"),
        (lambda data: data["streams"].append(dict(data["streams"][1])), "stream contract"),
        (lambda data: data["streams"].reverse(), "stream contract"),
    ],
)
def test_rejects_rendered_media_that_does_not_match_v1_contract(
    tmp_path: Path, monkeypatch, mutate, message: str
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    metadata = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 360,
                "height": 640,
                "sample_aspect_ratio": "1:1",
                "duration": "1.000",
            },
            {"codec_type": "audio", "codec_name": "aac", "duration": "1.000"},
        ],
    }
    mutate(metadata)
    source_metadata = {
        "streams": [
            {"codec_type": "video", "duration": "3.000"},
            {"codec_type": "audio", "duration": "3.000"},
        ]
    }

    def run(command, **kwargs):
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"rendered")
            return subprocess.CompletedProcess(command, 0, "", "")
        if any(
            str(part).startswith("stream=index,codec_type,duration,duration_ts,time_base")
            for part in command
        ):
            return subprocess.CompletedProcess(command, 0, json.dumps(source_metadata), "")
        return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError, match=message):
        render_vertical(
            source,
            output,
            start=0.5,
            end=1.5,
            transcript=[],
            width=360,
            height=640,
        )


def test_maps_selected_non_attached_video_and_only_default_audio_stream(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    source_metadata = {
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "duration": "0.010",
                "disposition": {"attached_pic": 1, "default": 0},
            },
            {
                "index": 1,
                "codec_type": "audio",
                "duration": "3.000",
                "disposition": {"attached_pic": 0, "default": 1},
            },
            {
                "index": 2,
                "codec_type": "video",
                "duration": "3.000",
                "disposition": {"attached_pic": 0, "default": 1},
            },
            {
                "index": 3,
                "codec_type": "audio",
                "duration": "3.000",
                "disposition": {"attached_pic": 0, "default": 0},
            },
        ]
    }
    output_metadata = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 360,
                "height": 640,
                "sample_aspect_ratio": "1:1",
                "duration": "1.000",
            },
            {"codec_type": "audio", "codec_name": "aac", "duration": "1.000"},
        ]
    }
    render_commands = []

    def run(command, **kwargs):
        if command[0] == "ffmpeg":
            render_commands.append(command)
            Path(command[-1]).write_bytes(b"rendered")
            return subprocess.CompletedProcess(command, 0, "", "")
        metadata = source_metadata if str(source) in command else output_metadata
        return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")

    monkeypatch.setattr(subprocess, "run", run)
    render_vertical(source, output, start=0.5, end=1.5, transcript=[], width=360, height=640)

    filter_graph = render_commands[0][render_commands[0].index("-filter_complex") + 1]
    assert "[0:2]" in filter_graph
    assert "[0:1]apad[audio]" in filter_graph
    assert "[0:0]" not in filter_graph
    assert "[0:3]" not in filter_graph


def test_rejects_symlink_render_output(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    outside = tmp_path / "outside.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    outside.write_bytes(b"outside")
    output.symlink_to(outside)
    calls = []

    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: calls.append(command))
    with pytest.raises(RuntimeError, match="regular file"):
        render_vertical(source, output, start=0.0, end=1.0, transcript=[])
    assert calls == []
    assert outside.read_bytes() == b"outside"


def test_render_subprocess_timeout_is_bounded_and_error_is_sanitized(tmp_path: Path, monkeypatch):
    source = tmp_path / "private-source-name.mp4"
    output = tmp_path / "secret-output-name.mp4"
    source.write_bytes(b"source")
    observed_timeouts = []

    def run(command, **kwargs):
        observed_timeouts.append(kwargs.get("timeout"))
        if any(
            str(part).startswith("stream=index,codec_type,duration,duration_ts,time_base")
            for part in command
        ):
            metadata = {"streams": [{"codec_type": "video", "duration": "3.000"}]}
            return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")
        raise subprocess.TimeoutExpired(command, kwargs["timeout"], stderr="private diagnostic")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError) as raised:
        render_vertical(source, output, start=0.0, end=1.0, transcript=[])
    assert observed_timeouts and all(
        isinstance(value, (int, float)) and value > 0 for value in observed_timeouts
    )
    assert "timed out" in str(raised.value).lower()
    assert "private" not in str(raised.value)
    assert source.name not in str(raised.value)
    assert output.name not in str(raised.value)
    assert not output.exists()
    assert not output.with_suffix(".srt").exists()


def test_render_failure_cleans_all_sibling_temporary_and_public_artifacts(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")

    def run(command, **kwargs):
        if any(
            str(part).startswith("stream=index,codec_type,duration,duration_ts,time_base")
            for part in command
        ):
            metadata = {"streams": [{"codec_type": "video", "duration": "3.000"}]}
            return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"partial")
            raise subprocess.CalledProcessError(1, command, stderr="private")
        raise AssertionError(command)

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError, match="render failed"):
        render_vertical(source, output, start=0.0, end=1.0, transcript=[])

    assert not output.exists()
    assert not output.with_suffix(".srt").exists()
    assert sorted(item.name for item in tmp_path.iterdir()) == ["source.mp4"]


def test_render_path_swap_cannot_overwrite_symlink_target_or_publish_partial_files(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    outside = tmp_path / "outside.mp4"
    source.write_bytes(b"source")
    outside.write_bytes(b"outside")

    def run(command, **kwargs):
        if any(
            str(part).startswith("stream=index,codec_type,duration,duration_ts,time_base")
            for part in command
        ):
            metadata = {"streams": [{"codec_type": "video", "duration": "3.000"}]}
            return subprocess.CompletedProcess(command, 0, json.dumps(metadata), "")
        if command[0] == "ffmpeg":
            output.symlink_to(outside)
            Path(command[-1]).write_bytes(b"rendered")
            return subprocess.CompletedProcess(command, 0, "", "")
        return subprocess.CompletedProcess(command, 0, "not-json", "")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError):
        render_vertical(source, output, start=0.0, end=1.0, transcript=[])

    assert outside.read_bytes() == b"outside"
    assert not output.with_suffix(".srt").exists()
    assert sorted(item.name for item in tmp_path.iterdir()) == [
        "clip.mp4",
        "outside.mp4",
        "source.mp4",
    ]


def test_existing_subtitle_symlink_is_never_followed_or_replaced(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    subtitle = output.with_suffix(".srt")
    outside = tmp_path / "outside.srt"
    source.write_bytes(b"source")
    outside.write_text("outside", encoding="utf-8")
    subtitle.symlink_to(outside)
    calls = []

    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: calls.append(command))
    with pytest.raises(RuntimeError, match="regular file"):
        render_vertical(source, output, start=0.0, end=1.0, transcript=[])

    assert calls == []
    assert outside.read_text(encoding="utf-8") == "outside"
    assert subtitle.is_symlink()
    assert not output.exists()
