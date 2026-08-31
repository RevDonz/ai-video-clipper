from pathlib import Path

import pytest

from ai_clipper import cli
from ai_clipper.cli import parse_args


def test_cli_parses_source_and_processing_options():
    args = parse_args(
        [
            "video.mp4",
            "--output-dir",
            "hasil",
            "--model",
            "tiny",
            "--language",
            "id",
            "--min-duration",
            "15",
            "--max-duration",
            "45",
            "--limit",
            "3",
            "--render-mode",
            "fit-blur",
        ]
    )

    assert args.source == Path("video.mp4")
    assert args.output_dir == Path("hasil")
    assert args.model == "tiny"
    assert args.language == "id"
    assert args.min_duration == 15
    assert args.max_duration == 45
    assert args.limit == 3
    assert args.render_mode == "fit-blur"


def test_cli_defaults_to_face_tracking():
    args = parse_args(["video.mp4"])
    assert args.render_mode == "face-track"
    assert args.selection_mode == "v1"
    assert args.clip_profile == "standard"
    assert args.max_candidates == 200
    assert args.max_media_candidates == 12
    assert args.media_timeout == 30.0


@pytest.mark.parametrize(
    "arguments",
    [
        ["--selection-mode", "v2"],
        ["--clip-profile", "long"],
        ["--max-candidates", "0"],
        ["--max-candidates", "5001"],
        ["--max-media-candidates", "0"],
        ["--max-media-candidates", "101"],
        ["--media-timeout", "nan"],
        ["--media-timeout", "301"],
    ],
)
def test_cli_rejects_invalid_v2_options(arguments: list[str]):
    with pytest.raises(SystemExit, match="2"):
        parse_args(["video.mp4", *arguments])


def test_cli_parses_v2_shadow_options():
    args = parse_args(
        [
            "video.mp4",
            "--selection-mode",
            "v2-shadow",
            "--clip-profile",
            "viral-short",
            "--max-candidates",
            "40",
            "--max-media-candidates",
            "6",
            "--media-timeout",
            "12.5",
        ]
    )

    assert args.selection_mode == "v2-shadow"
    assert args.clip_profile == "viral-short"
    assert args.max_candidates == 40
    assert args.max_media_candidates == 6
    assert args.media_timeout == 12.5


def test_cli_forwards_v2_options_to_pipeline(monkeypatch, tmp_path: Path):
    received = {}
    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def pipeline(*args, **kwargs):
        received.update(kwargs)
        manifest = tmp_path / "manifest.json"
        manifest.touch()
        return manifest

    monkeypatch.setattr(cli, "run_pipeline", pipeline)
    assert (
        cli.main(
            [
                "video.mp4",
                "--selection-mode",
                "v2-shadow",
                "--clip-profile",
                "deep-dive",
                "--max-candidates",
                "25",
                "--max-media-candidates",
                "4",
                "--media-timeout",
                "9",
            ]
        )
        == 0
    )
    assert received["selection_mode"] == "v2-shadow"
    assert received["clip_profile"] == "deep-dive"
    assert received["max_candidates"] == 25
    assert received["max_media_candidates"] == 4
    assert received["media_timeout"] == 9.0


def test_cli_returns_nonzero_and_reports_pipeline_value_error(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def fail_pipeline(*args, **kwargs):
        raise ValueError("No eligible highlights found")

    monkeypatch.setattr(cli, "run_pipeline", fail_pipeline)

    exit_code = cli.main(["video.mp4"])

    assert exit_code == 1
    assert "Error: No eligible highlights found" in capsys.readouterr().err
