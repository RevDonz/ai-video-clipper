from ai_clipper.models import TranscriptSegment
from ai_clipper.subtitles import to_srt


def test_srt_excludes_segments_that_only_partially_overlap_clip():
    segments = [
        TranscriptSegment(8.0, 10.5, "Kesalahan terbesar"),
        TranscriptSegment(10.5, 13.25, "adalah mengejar semua pelanggan."),
    ]

    srt = to_srt(segments, clip_start=9.0, clip_end=12.0)

    assert srt == ""


def test_long_segment_is_split_into_short_readable_cues():
    segments = [
        TranscriptSegment(0.0, 10.0, "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh")
    ]

    srt = to_srt(segments, clip_start=0.0, clip_end=10.0)

    assert "00:00:00,000 --> 00:00:04,000\nsatu dua tiga empat" in srt
    assert "00:00:04,000 --> 00:00:08,000\nlima enam tujuh delapan" in srt
    assert "00:00:08,000 --> 00:00:10,000\nsembilan sepuluh" in srt
