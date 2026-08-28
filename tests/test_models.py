import pytest

from ai_clipper.models import Highlight, TranscriptSegment


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
