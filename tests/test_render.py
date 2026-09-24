import json
import subprocess
import tempfile
from pathlib import Path

import pytest

import ai_clipper.render as render_module
from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.render import render_vertical
from ai_clipper.subtitles import build_caption_cues, cues_to_srt


def _make_source(
    path: Path, *, duration: float = 3.0, video: str = "testsrc2=size=640x360"
) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"{video}:rate=24:duration={duration}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:sample_rate=48000:duration={duration}",
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


_SOURCE_PROBE_PREFIX = "stream=index,codec_type,duration,duration_ts,time_base"


def _words(*items: tuple[float, float, str]) -> tuple[TranscriptWord, ...]:
    return tuple(TranscriptWord(start, end, text) for start, end, text in items)


def _segment(*items: tuple[float, float, str]) -> TranscriptSegment:
    words = _words(*items)
    return TranscriptSegment(
        words[0].start,
        max(word.end for word in words),
        " ".join(word.text for word in words),
        words=words,
    )


def _probe_streams(path: Path) -> list[dict[str, str]]:
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(probe.stdout)["streams"]


def _luma_at(path: Path, *, time: float, x: int, y: int) -> int:
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{time:.3f}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            f"format=gray,crop=2:2:{x}:{y}",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout[0]


def _fake_render_tools(
    monkeypatch,
    *,
    output_duration: float,
    source_duration: float = 30.0,
    has_audio: bool = True,
) -> dict[str, list]:
    """Replace ffprobe/ffmpeg; record each ffmpeg command and the ASS it would burn."""
    captured: dict[str, list] = {"commands": [], "ass": []}
    source_streams = [{"index": 0, "codec_type": "video", "duration": f"{source_duration:.3f}"}]
    if has_audio:
        source_streams.append(
            {"index": 1, "codec_type": "audio", "duration": f"{source_duration:.3f}"}
        )
    output_metadata = {
        "streams": [
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 360,
                "height": 640,
                "sample_aspect_ratio": "1:1",
                "duration": f"{output_duration:.3f}",
            },
            {"codec_type": "audio", "codec_name": "aac", "duration": f"{output_duration:.3f}"},
        ]
    }

    def run(command, **kwargs):
        if command[0] == "ffmpeg":
            captured["commands"].append(command)
            ass_path = Path(kwargs["cwd"]) / "captions.ass"
            captured["ass"].append(ass_path.read_text(encoding="utf-8"))
            Path(command[-1]).write_bytes(b"rendered")
            return subprocess.CompletedProcess(command, 0, "", "")
        if any(str(part).startswith(_SOURCE_PROBE_PREFIX) for part in command):
            return subprocess.CompletedProcess(
                command, 0, json.dumps({"streams": source_streams}), ""
            )
        return subprocess.CompletedProcess(command, 0, json.dumps(output_metadata), "")

    monkeypatch.setattr(subprocess, "run", run)
    return captured


def _dialogues(ass: str) -> list[str]:
    return [line for line in ass.splitlines() if line.startswith("Dialogue:")]


def _inputs(command: list[str]) -> list[list[str]]:
    """Arguments of each input, from the previous input (or "ffmpeg") up to its -i path."""
    groups: list[list[str]] = []
    begin = 1
    for index, part in enumerate(command):
        if part == "-filter_complex":
            break
        if part == "-i":
            groups.append(command[begin : index + 2])
            begin = index + 2
    return groups


def test_default_render_keeps_single_input_and_burns_classic_ass_captions(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    transcript = [TranscriptSegment(0.5, 1.5, "Jangan hasilkan klip pendek.")]
    captured = _fake_render_tools(monkeypatch, output_duration=1.0)

    render_vertical(
        source, output, start=0.5, end=1.5, transcript=transcript, width=360, height=640
    )

    [command] = captured["commands"]
    assert _inputs(command) == [["-y", "-ss", "0.500", "-i", str(source)]]
    assert command[command.index("-t") + 1] == "1.000"
    graph = command[command.index("-filter_complex") + 1]
    assert graph.endswith("ass=filename='captions.ass'[video];[0:1]apad[audio]")
    assert "concat" not in graph
    [ass] = captured["ass"]
    assert "PlayResX: 360" in ass and "PlayResY: 640" in ass
    dialogues = _dialogues(ass)
    assert dialogues == [
        "Dialogue: 0,0:00:00.00,0:00:01.00,Caption,,0,0,0,,Jangan hasilkan klip pendek."
    ]
    assert "\\k" not in ass
    expected_srt = cues_to_srt(build_caption_cues(transcript, [(0.5, 1.5)]))
    assert output.with_suffix(".srt").read_text(encoding="utf-8") == expected_srt


def test_cold_open_render_seeks_two_inputs_and_concatenates_with_audio_fades(
    tmp_path: Path, monkeypatch
):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    transcript = [
        _segment((4.2, 4.6, "Awal"), (4.6, 5.0, "cerita.")),
        _segment((10.4, 10.8, "Kode"), (10.8, 11.5, "rahasia!")),
    ]
    captured = _fake_render_tools(monkeypatch, output_duration=7.5)

    render_vertical(
        source,
        output,
        start=4.0,
        end=9.0,
        transcript=transcript,
        width=360,
        height=640,
        cold_open=(10.0, 12.5),
    )

    [command] = captured["commands"]
    assert _inputs(command) == [
        ["-y", "-ss", "10.000", "-t", "2.500", "-i", str(source)],
        ["-ss", "4.000", "-t", "5.000", "-i", str(source)],
    ]
    output_options = command[command.index("-filter_complex") :]
    assert "-t" not in output_options and "-ss" not in output_options
    graph = command[command.index("-filter_complex") + 1]
    assert "[0:0]setpts=PTS-STARTPTS" in graph and "[1:0]setpts=PTS-STARTPTS" in graph
    assert "[0:1]asetpts=PTS-STARTPTS,apad,atrim=duration=2.500" in graph
    assert "[1:1]asetpts=PTS-STARTPTS,apad,atrim=duration=5.000" in graph
    assert "afade=t=out:st=2.470:d=0.030[audio0]" in graph
    assert "afade=t=in:st=0:d=0.030[audio1]" in graph
    assert "[video0][audio0][video1][audio1]concat=n=2:v=1:a=1[joined][audio]" in graph
    assert graph.endswith("[joined]ass=filename='captions.ass'[video]")
    dialogues = _dialogues(captured["ass"][0])
    assert dialogues == [
        "Dialogue: 0,0:00:00.40,0:00:01.50,Caption,,0,0,0,,Kode rahasia!",
        "Dialogue: 0,0:00:02.70,0:00:03.50,Caption,,0,0,0,,Awal cerita.",
    ]
    assert output.with_suffix(".srt").read_text(encoding="utf-8") == (
        "1\n00:00:00,400 --> 00:00:01,500\nKode rahasia!\n\n"
        "2\n00:00:02,700 --> 00:00:03,500\nAwal cerita.\n"
    )


def test_cold_open_fit_blur_uses_distinct_filter_labels_per_range(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    captured = _fake_render_tools(monkeypatch, output_duration=3.0, has_audio=False)

    render_vertical(
        source,
        tmp_path / "clip.mp4",
        start=1.0,
        end=3.0,
        transcript=[],
        width=360,
        height=640,
        render_mode="fit-blur",
        cold_open=(5.0, 6.0),
    )

    [command] = captured["commands"]
    assert "lavfi" not in command
    graph = command[command.index("-filter_complex") + 1]
    for label in ("background", "foreground", "blurred", "fit"):
        assert graph.count(f"[{label}0]") == 2
        assert graph.count(f"[{label}1]") == 2
    assert "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=1.000" in graph
    assert "anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=2.000" in graph


def test_cold_open_face_track_computes_a_crop_track_per_range(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    captured = _fake_render_tools(monkeypatch, output_duration=4.0)
    tracked = []

    def detect(path, *, start, end):
        tracked.append((start, end))
        return [0.0, 1.0], [0.5, 0.5], [False, False], 640, 360

    monkeypatch.setattr(render_module, "validate_render_mode", lambda mode: None)
    monkeypatch.setattr(render_module, "detect_face_track", detect)
    monkeypatch.setattr(
        render_module,
        "build_crop_expression",
        lambda times, centers, **kwargs: f"crop{len(tracked)}",
    )

    render_vertical(
        source,
        tmp_path / "clip.mp4",
        start=2.0,
        end=5.0,
        transcript=[],
        width=360,
        height=640,
        render_mode="face-track",
        cold_open=(8.0, 9.0),
    )

    assert tracked == [(8.0, 9.0), (2.0, 5.0)]
    graph = captured["commands"][0][captured["commands"][0].index("-filter_complex") + 1]
    assert "[source0]scale=360:640" in graph and "x='crop1'" in graph
    assert "[source1]scale=360:640" in graph and "x='crop2'" in graph


def test_hook_text_and_karaoke_are_burned_while_srt_stays_plain(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    transcript = [_segment((1.1, 1.4, "Gue"), (1.4, 1.8, "bukan"), (1.8, 2.3, "jambret."))]
    captured = _fake_render_tools(monkeypatch, output_duration=4.0)

    render_vertical(
        source,
        output,
        start=1.0,
        end=5.0,
        transcript=transcript,
        width=360,
        height=640,
        hook_text="Kode rahasia {copet}",
        hook_duration=2.5,
        caption_style="karaoke",
    )

    ass = captured["ass"][0]
    dialogues = _dialogues(ass)
    assert dialogues[0] == (
        "Dialogue: 0,0:00:00.10,0:00:01.30,Karaoke,,0,0,0,,{\\k30}Gue {\\k40}bukan {\\k50}jambret."
    )
    hook_lines = [line for line in dialogues if ",Hook," in line]
    assert hook_lines
    assert all(line.startswith("Dialogue: 1,0:00:00.00,0:00:02.50,Hook,") for line in hook_lines)
    assert "\\{copet\\}" in ass
    assert output.with_suffix(".srt").read_text(encoding="utf-8") == (
        "1\n00:00:00,100 --> 00:00:01,300\nGue bukan jambret.\n"
    )


@pytest.mark.parametrize(
    ("cold_open", "error"),
    [
        ((1.0,), TypeError),
        ("ab", TypeError),
        ((True, 2.0), TypeError),
        ((float("nan"), 2.0), ValueError),
        ((2.0, float("inf")), ValueError),
        ((-1.0, 1.0), ValueError),
        ((3.0, 2.0), ValueError),
        ((1.0, 1.4), ValueError),
        ((1.0, 9.5), ValueError),
        ((0.5, 2.0), ValueError),
    ],
)
def test_invalid_cold_open_is_rejected_before_any_subprocess(
    tmp_path: Path, monkeypatch, cold_open, error
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: calls.append(command))

    with pytest.raises(error):
        render_vertical(
            source,
            tmp_path / "clip.mp4",
            start=0.5,
            end=2.5,
            transcript=[],
            cold_open=cold_open,
        )

    assert calls == []
    assert sorted(item.name for item in tmp_path.iterdir()) == ["source.mp4"]


def test_cold_open_beyond_source_video_is_rejected(tmp_path: Path, monkeypatch):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    source.write_bytes(b"source")
    captured = _fake_render_tools(monkeypatch, output_duration=2.0, source_duration=3.0)

    with pytest.raises(ValueError, match="source video duration"):
        render_vertical(source, output, start=0.0, end=1.0, transcript=[], cold_open=(2.5, 3.5))

    assert captured["commands"] == []
    assert sorted(item.name for item in tmp_path.iterdir()) == ["source.mp4"]


@pytest.mark.parametrize(
    ("options", "error"),
    [
        ({"caption_style": "neon"}, ValueError),
        ({"hook_duration": 0.0}, ValueError),
        ({"hook_duration": float("nan")}, ValueError),
        ({"hook_duration": 31.0}, ValueError),
        ({"hook_text": 42}, TypeError),
    ],
)
def test_invalid_packaging_options_are_rejected_before_any_subprocess(
    tmp_path: Path, monkeypatch, options, error
):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    calls = []
    monkeypatch.setattr(subprocess, "run", lambda command, **kwargs: calls.append(command))

    with pytest.raises(error):
        render_vertical(source, tmp_path / "clip.mp4", start=0.0, end=1.0, transcript=[], **options)

    assert calls == []


def test_cold_open_render_has_combined_duration_and_offset_captions(tmp_path: Path):
    source = tmp_path / "source.mp4"
    output = tmp_path / "clip.mp4"
    _make_source(source, duration=6.0)
    transcript = [
        _segment((1.2, 1.6, "Awal"), (1.6, 2.5, "cerita.")),
        _segment((4.2, 4.5, "Kode"), (4.5, 4.8, "rahasia!")),
    ]

    render_vertical(
        source,
        output,
        start=1.0,
        end=3.0,
        transcript=transcript,
        width=360,
        height=640,
        cold_open=(4.0, 5.0),
    )

    streams = _probe_streams(output)
    assert [(stream["codec_type"], stream["codec_name"]) for stream in streams] == [
        ("video", "h264"),
        ("audio", "aac"),
    ]
    assert all(abs(float(stream["duration"]) - 3.0) <= 0.1 for stream in streams)
    assert output.with_suffix(".srt").read_text(encoding="utf-8") == (
        "1\n00:00:00,200 --> 00:00:00,800\nKode rahasia!\n\n"
        "2\n00:00:01,200 --> 00:00:02,500\nAwal cerita.\n"
    )


def test_cold_open_video_only_source_gets_silent_audio_for_both_ranges(tmp_path: Path):
    source = tmp_path / "silent.mp4"
    output = tmp_path / "clip.mp4"
    _make_video_only_source(source, duration=6.0)

    render_vertical(
        source,
        output,
        start=0.5,
        end=2.5,
        transcript=[],
        width=360,
        height=640,
        render_mode="fit-blur",
        cold_open=(4.0, 5.5),
    )

    streams = _probe_streams(output)
    assert [(stream["codec_type"], stream["codec_name"]) for stream in streams] == [
        ("video", "h264"),
        ("audio", "aac"),
    ]
    assert all(abs(float(stream["duration"]) - 3.5) <= 0.1 for stream in streams)


def test_hook_box_is_burned_in_the_top_safe_area_only_for_hook_duration(tmp_path: Path):
    source = tmp_path / "gray.mp4"
    output = tmp_path / "clip.mp4"
    _make_source(source, duration=4.0, video="color=c=0x808080:size=640x360")

    render_vertical(
        source,
        output,
        start=0.5,
        end=2.5,
        transcript=[_segment((0.6, 1.0, "Halo"), (1.0, 1.4, "semua."))],
        width=360,
        height=640,
        render_mode="fit-blur",
        cold_open=(3.0, 4.0),
        hook_text="Rahasia copet",
        hook_duration=1.2,
        caption_style="karaoke",
    )

    # Inside the hook box's top padding (13% from the top), at the centre column.
    x, y = 180, round(640 * 0.13) + 3
    during_hook = _luma_at(output, time=0.6, x=x, y=y)
    after_hook = _luma_at(output, time=2.5, x=x, y=y)
    assert during_hook < 80
    assert abs(after_hook - 128) <= 12
    streams = _probe_streams(output)
    assert all(abs(float(stream["duration"]) - 3.0) <= 0.1 for stream in streams)
