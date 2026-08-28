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

    with pytest.raises(ValueError, match="source duration"):
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
