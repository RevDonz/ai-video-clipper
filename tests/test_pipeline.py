import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai_clipper.pipeline import run_pipeline


class FakeWhisperModel:
    def transcribe(self, source: str, **options):
        return (
            [
                SimpleNamespace(start=0.0, end=1.0, text="Halo semuanya."),
                SimpleNamespace(
                    start=1.0,
                    end=2.68,
                    text="Kesalahan terbesar adalah tidak menguji produk.",
                ),
            ],
            SimpleNamespace(language="id"),
        )


class EmptyWhisperModel:
    def transcribe(self, source: str, **options):
        return [], SimpleNamespace(language="id")


def test_pipeline_fails_clearly_when_transcription_is_empty(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.touch()

    with pytest.raises(ValueError, match="Transcription produced no usable segments"):
        run_pipeline(source, tmp_path / "output", model=EmptyWhisperModel())


def test_failed_run_invalidates_stale_manifest_without_publishing_partial_results(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.touch()
    output = tmp_path / "output"
    output.mkdir()
    manifest_path = output / "manifest.json"
    manifest_path.write_text('{"status":"completed","clips":[{"output":"old.mp4"}]}')

    with pytest.raises(ValueError, match="Transcription produced no usable segments"):
        run_pipeline(source, output, model=EmptyWhisperModel())

    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "failed"
    assert "clips" not in manifest
    assert "old.mp4" not in manifest_path.read_text()
    assert not (output / "transcript.json").exists()


def test_pipeline_fails_clearly_when_no_highlights_meet_duration_bounds(tmp_path: Path):
    source = tmp_path / "source.mp4"
    source.touch()

    with pytest.raises(ValueError, match="No eligible highlights found"):
        run_pipeline(source, tmp_path / "output", model=FakeWhisperModel())


def test_pipeline_transcribes_selects_renders_and_writes_manifest(tmp_path: Path):
    source = tmp_path / "source.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:size=640x360:rate=24:duration=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-shortest",
            str(source),
        ],
        check=True,
        capture_output=True,
    )

    manifest_path = run_pipeline(
        source,
        tmp_path / "output",
        model=FakeWhisperModel(),
        min_duration=1.0,
        max_duration=3.0,
        limit=1,
        width=360,
        height=640,
    )

    manifest = json.loads(manifest_path.read_text())
    assert manifest["status"] == "completed"
    assert manifest["language"] == "id"
    assert manifest["source"] == str(source.resolve())
    assert len(manifest["clips"]) == 1
    assert manifest["clips"][0]["duration"] == 1.68
    assert Path(manifest["clips"][0]["output"]).is_file()
    assert "Kesalahan terbesar" in manifest["clips"][0]["text"]
