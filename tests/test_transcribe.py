from pathlib import Path
from types import SimpleNamespace

from ai_clipper.transcribe import transcribe_video


class FakeWhisperModel:
    def transcribe(self, source: str, **options):
        assert Path(source).name == "podcast.mp4"
        assert options["language"] == "id"
        return (
            [
                SimpleNamespace(start=0.0, end=2.0, text=" Halo semuanya. "),
                SimpleNamespace(start=2.0, end=5.5, text=" Ini bagian penting. "),
            ],
            SimpleNamespace(language="id"),
        )


def test_normalizes_whisper_segments_and_language(tmp_path: Path):
    source = tmp_path / "podcast.mp4"
    source.touch()

    result = transcribe_video(source, model=FakeWhisperModel(), language="id")

    assert result.language == "id"
    assert [segment.text for segment in result.segments] == [
        "Halo semuanya.",
        "Ini bagian penting.",
    ]
    assert result.segments[-1].end == 5.5
