import math

import pytest

from ai_clipper.highlight import select_highlights
from ai_clipper.models import TranscriptSegment


def test_selects_complete_highlight_within_requested_duration():
    segments = [
        TranscriptSegment(0.0, 8.0, "Halo semuanya, selamat datang di podcast ini."),
        TranscriptSegment(
            8.0,
            24.0,
            "Kesalahan terbesar saat memulai bisnis adalah mengejar semua pelanggan sekaligus.",
        ),
        TranscriptSegment(
            24.0,
            42.0,
            "Fokuslah pada satu masalah yang sangat penting, lalu buktikan orang mau membayar.",
        ),
        TranscriptSegment(42.0, 50.0, "Setelah itu barulah produk dikembangkan lebih jauh."),
        TranscriptSegment(50.0, 57.0, "Terima kasih sudah menonton."),
    ]

    clips = select_highlights(segments, min_duration=25, max_duration=45, limit=1)

    assert len(clips) == 1
    assert clips[0].start == 8.0
    assert clips[0].end == 50.0
    assert "Kesalahan terbesar" in clips[0].text
    assert clips[0].score > 0


def test_excludes_single_segment_longer_than_maximum_duration():
    clips = select_highlights(
        [TranscriptSegment(0.0, 90.0, "Rahasia penting yang dijelaskan panjang sekali.")],
        min_duration=20.0,
        max_duration=60.0,
        limit=1,
    )

    assert clips == []


@pytest.mark.parametrize(
    ("min_duration", "max_duration"),
    [(math.nan, 60.0), (20.0, math.inf)],
)
def test_rejects_non_finite_duration_bounds(min_duration: float, max_duration: float):
    with pytest.raises(ValueError, match="finite"):
        select_highlights(
            [TranscriptSegment(0.0, 30.0, "Bagian penting")],
            min_duration=min_duration,
            max_duration=max_duration,
        )
