import pytest

from ai_clipper.models import Highlight, TranscriptSegment, TranscriptWord


@pytest.mark.parametrize(
    ("start", "end"),
    [(float("nan"), 1.0), (0.0, float("nan")), (0.0, float("inf"))],
)
def test_transcript_segment_rejects_non_finite_timestamps(start: float, end: float):
    with pytest.raises(ValueError, match="finite"):
        TranscriptSegment(start, end, "Valid text")


@pytest.mark.parametrize(
    ("start", "end", "score"),
    [
        (float("nan"), 1.0, 1.0),
        (0.0, float("inf"), 1.0),
        (0.0, 1.0, float("nan")),
        (0.0, 1.0, float("inf")),
    ],
)
def test_highlight_rejects_non_finite_numbers(start: float, end: float, score: float):
    with pytest.raises(ValueError, match="finite"):
        Highlight(start, end, "Valid text", score)


@pytest.mark.parametrize(("start", "end"), [(-1.0, 1.0), (1.0, 1.0), (2.0, 1.0)])
def test_highlight_rejects_invalid_timestamp_order(start: float, end: float):
    with pytest.raises(ValueError, match="0 <= start < end"):
        Highlight(start, end, "Valid text", 1.0)


def test_transcript_word_accepts_zero_duration_and_optional_probability():
    word = TranscriptWord(1.0, 1.0, "Gue")
    assert word.probability is None
    assert TranscriptWord(0, 0.5, "iya", 1).probability == 1


@pytest.mark.parametrize(
    ("start", "end", "text", "probability", "error"),
    [
        (-0.1, 1.0, "x", None, ValueError),
        (2.0, 1.0, "x", None, ValueError),
        (float("nan"), 1.0, "x", None, ValueError),
        (0.0, float("inf"), "x", None, ValueError),
        (True, 1.0, "x", None, TypeError),
        ("0", 1.0, "x", None, TypeError),
        (0.0, 1.0, "  ", None, ValueError),
        (0.0, 1.0, 3, None, ValueError),
        (0.0, 1.0, "x", 1.5, ValueError),
        (0.0, 1.0, "x", -0.1, ValueError),
        (0.0, 1.0, "x", float("nan"), ValueError),
        (0.0, 1.0, "x", True, ValueError),
    ],
)
def test_transcript_word_rejects_invalid_values(start, end, text, probability, error):
    with pytest.raises(error):
        TranscriptWord(start, end, text, probability)


def test_transcript_segment_words_default_to_empty_tuple_and_must_be_chronological():
    assert TranscriptSegment(0.0, 1.0, "Halo").words == ()
    words = (TranscriptWord(0.0, 0.4, "Halo"), TranscriptWord(0.4, 0.9, "semua"))
    assert TranscriptSegment(0.0, 1.0, "Halo semua", words).words == words
    with pytest.raises(TypeError, match="tuple"):
        TranscriptSegment(0.0, 1.0, "Halo semua", list(words))
    with pytest.raises(TypeError, match="tuple"):
        TranscriptSegment(0.0, 1.0, "Halo", ("Halo",))
    with pytest.raises(ValueError, match="chronological"):
        TranscriptSegment(0.0, 1.0, "Halo semua", tuple(reversed(words)))


@pytest.mark.parametrize(
    ("start", "end", "text"),
    [(True, 1.0, "x"), ("0", 1.0, "x"), (0.0, None, "x"), (0.0, 1.0, None), (0.0, 1.0, 7)],
)
def test_transcript_segment_rejects_wrong_types(start, end, text):
    with pytest.raises(TypeError):
        TranscriptSegment(start, end, text)
