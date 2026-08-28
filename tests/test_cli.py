from pathlib import Path

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
    assert parse_args(["video.mp4"]).render_mode == "face-track"


def test_cli_returns_nonzero_and_reports_pipeline_value_error(monkeypatch, capsys):
    monkeypatch.setattr(cli, "load_whisper_model", lambda *args, **kwargs: object())

    def fail_pipeline(*args, **kwargs):
        raise ValueError("No eligible highlights found")

    monkeypatch.setattr(cli, "run_pipeline", fail_pipeline)

    exit_code = cli.main(["video.mp4"])

    assert exit_code == 1
    assert "Error: No eligible highlights found" in capsys.readouterr().err
