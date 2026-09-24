import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai_clipper.models import TranscriptWord
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


class RecordingModel:
    def __init__(self, segments, *, duration: float = 0.0):
        self.segments = segments
        self.duration = duration
        self.options: dict[str, object] = {}

    def transcribe(self, source: str, **options):
        self.options = options
        return iter(self.segments), SimpleNamespace(language="id", duration=self.duration)


def _word(start, end, word, probability=0.9):
    return SimpleNamespace(start=start, end=end, word=word, probability=probability)


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "podcast.mp4"
    path.touch()
    return path


def test_normalizes_whisper_segments_and_language(source: Path):
    result = transcribe_video(source, model=FakeWhisperModel(), language="id")

    assert result.language == "id"
    assert [segment.text for segment in result.segments] == [
        "Halo semuanya.",
        "Ini bagian penting.",
    ]
    assert result.segments[-1].end == 5.5
    assert all(segment.words == () for segment in result.segments)


def test_requests_word_timestamps_by_default_and_keeps_decoding_options(source: Path):
    model = RecordingModel([SimpleNamespace(start=0.0, end=1.0, text="Halo")])

    transcribe_video(source, model=model)

    assert model.options == {
        "language": "id",
        "vad_filter": True,
        "beam_size": 5,
        "word_timestamps": True,
        "initial_prompt": None,
    }


def test_passes_initial_prompt_and_can_disable_word_timestamps(source: Path):
    model = RecordingModel(
        [SimpleNamespace(start=0.0, end=1.0, text="Halo", words=[_word(0.0, 0.5, " Halo")])]
    )

    result = transcribe_video(
        source,
        model=model,
        word_timestamps=False,
        initial_prompt="Podcast santai, pakai tanda baca.",
    )

    assert model.options["word_timestamps"] is False
    assert model.options["initial_prompt"] == "Podcast santai, pakai tanda baca."
    assert result.segments[0].words == ()


def test_rejects_non_string_initial_prompt(source: Path):
    with pytest.raises(TypeError, match="initial_prompt"):
        transcribe_video(source, model=RecordingModel([]), initial_prompt=3)


def test_normalizes_word_timestamps(source: Path):
    words = [
        _word(-0.2, 0.3, " Gue", 0.93),
        _word(0.3, 0.2, " bukan", 1.2),
        _word(0.5, 0.5, "   ", 0.5),
        _word(0.6, 0.9, " jambret.", -0.3),
        _word(math.nan, 1.0, " hilang", 0.5),
        _word(0.95, 1.4, " lagi", math.nan),
        _word(1.45, 1.6, " ya", None),
    ]
    model = RecordingModel(
        [SimpleNamespace(start=0.0, end=1.5, text=" Gue  bukan\njambret. lagi ya", words=words)]
    )

    segment = transcribe_video(source, model=model).segments[0]

    assert segment.text == "Gue bukan jambret. lagi ya"
    assert segment.words == (
        TranscriptWord(0.0, 0.3, "Gue", 0.93),
        TranscriptWord(0.3, 0.3, "bukan", 1.0),
        TranscriptWord(0.6, 0.9, "jambret.", 0.0),
        TranscriptWord(0.95, 1.4, "lagi", None),
        TranscriptWord(1.45, 1.5, "ya", None),
    )


def test_words_are_forced_chronological_inside_their_segment(source: Path):
    words = [_word(1.0, 1.4, " satu"), _word(0.8, 1.2, " dua"), _word(1.3, 2.4, " tiga")]
    model = RecordingModel([SimpleNamespace(start=1.0, end=2.0, text="satu dua tiga", words=words)])

    segment = transcribe_video(source, model=model).segments[0]

    assert [(word.start, word.end) for word in segment.words] == [
        (1.0, 1.4),
        (1.0, 1.2),
        (1.3, 2.0),
    ]


def test_overlapping_segments_are_clamped_and_degenerate_ones_dropped(source: Path):
    model = RecordingModel(
        [
            SimpleNamespace(start=0.0, end=2.0, text="Satu.", words=[_word(0.1, 1.9, " Satu.")]),
            SimpleNamespace(start=1.8, end=3.0, text="Dua.", words=[_word(1.8, 2.9, " Dua.")]),
            SimpleNamespace(start=2.5, end=2.9, text="Hantu."),
            SimpleNamespace(start=3.0, end=3.0, text="Kosong."),
            SimpleNamespace(start=3.2, end=4.0, text="   "),
            SimpleNamespace(start=math.inf, end=5.0, text="Rusak."),
            SimpleNamespace(start=4.0, end=5.0, text="Tiga."),
        ]
    )

    segments = transcribe_video(source, model=model).segments

    assert [(segment.start, segment.end, segment.text) for segment in segments] == [
        (0.0, 2.0, "Satu."),
        (2.0, 3.0, "Dua."),
        (4.0, 5.0, "Tiga."),
    ]
    assert segments[1].words == (TranscriptWord(2.0, 2.9, "Dua.", 0.9),)


def test_reports_progress_against_media_duration(source: Path):
    progress: list[float] = []
    model = RecordingModel(
        [
            SimpleNamespace(start=0.0, end=5.0, text="Satu."),
            SimpleNamespace(start=5.0, end=12.0, text="Dua."),
        ],
        duration=10.0,
    )

    transcribe_video(source, model=model, progress_callback=progress.append)

    assert progress == [0.5, 1.0]


def test_missing_source_raises(tmp_path: Path):
    with pytest.raises(FileNotFoundError):
        transcribe_video(tmp_path / "missing.mp4", model=RecordingModel([]))
