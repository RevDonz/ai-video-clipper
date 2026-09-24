from itertools import pairwise

import pytest

from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.subtitles import (
    CaptionCue,
    CaptionWord,
    build_caption_cues,
    cues_to_srt,
    timeline_to_srt,
    to_srt,
)


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


def _timing(cues) -> list[tuple[float, float, str]]:
    return [(cue.start, cue.end, cue.text) for cue in cues]


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


def test_word_timed_cue_starts_at_first_word_and_ends_at_last_word_relative_to_clip():
    segment = _segment((10.1, 10.4, " Gue"), (10.4, 10.8, " bukan"), (10.8, 11.5, " jambret."))

    cues = build_caption_cues([segment], [(10.0, 13.0)])

    assert _timing(cues) == [(0.1, 1.5, "Gue bukan jambret.")]
    assert cues[0].words == (
        CaptionWord(0.1, 0.4, "Gue"),
        CaptionWord(0.4, 0.8, "bukan"),
        CaptionWord(0.8, 1.5, "jambret."),
    )


def test_word_cues_split_on_max_words_long_gaps_and_sentence_ends():
    segment = _segment(
        (0.0, 0.2, "satu"),
        (0.2, 0.4, "dua"),
        (0.4, 0.6, "tiga"),
        (0.6, 0.8, "empat"),
        (0.8, 1.0, "lima"),
        (1.7, 2.0, "enam"),
        (2.0, 2.3, "tujuh?"),
        (2.3, 2.6, "Iya"),
        (2.6, 2.9, "dong."),
    )

    cues = build_caption_cues([segment], [(0.0, 5.0)])

    assert [cue.text for cue in cues] == [
        "satu dua tiga empat",
        "lima",
        "enam tujuh?",
        "Iya dong.",
    ]
    assert _timing(cues)[1] == (0.8, 1.1, "lima")


def test_gap_equal_to_threshold_does_not_split_cue():
    segment = _segment((0.0, 0.3, "satu"), (0.9, 1.2, "dua"))

    cues = build_caption_cues([segment], [(0.0, 2.0)])

    assert _timing(cues) == [(0.0, 1.2, "satu dua")]


def test_edge_words_from_partially_overlapping_segments_are_included():
    segments = [
        _segment((8.0, 8.9, "Kesalahan"), (8.9, 9.6, "terbesar"), (9.6, 10.5, "kita")),
        _segment(
            (10.5, 11.0, "adalah"),
            (11.0, 11.6, "mengejar"),
            (11.6, 12.3, "semua"),
            (12.3, 13.25, "pelanggan."),
        ),
    ]

    cues = build_caption_cues(segments, [(9.0, 12.0)])

    words = [word for cue in cues for word in cue.words]
    assert [word.text for word in words] == ["terbesar", "kita", "adalah", "mengejar", "semua"]
    assert words[0].start == 0.0
    assert words[-1].end == 3.0
    assert cues[-1].end == 3.0


def test_words_mostly_outside_the_range_are_left_out():
    segment = _segment((4.0, 5.8, "sebelum"), (5.8, 6.4, "tepat"), (6.4, 8.0, "sesudah"))

    cues = build_caption_cues([segment], [(5.5, 7.0)])

    assert [cue.text for cue in cues] == ["tepat"]


def test_segments_without_words_fall_back_to_proportional_timing_including_edges():
    segments = [TranscriptSegment(8.0, 10.0, "satu dua tiga empat")]

    cues = build_caption_cues(segments, [(9.0, 12.0)])

    assert _timing(cues) == [(0.0, 1.0, "tiga empat")]


def test_cold_open_timeline_offsets_main_range_by_cold_open_length():
    segments = [
        _segment((10.2, 10.6, "Awal"), (10.6, 11.0, "cerita.")),
        _segment((20.5, 20.9, "Kode"), (20.9, 21.4, "rahasia!")),
    ]

    cues = build_caption_cues(segments, [(20.0, 22.0), (10.0, 13.0)])

    assert _timing(cues) == [(0.5, 1.4, "Kode rahasia!"), (2.2, 3.0, "Awal cerita.")]


def test_cues_never_cross_the_join_between_ranges():
    segments = [
        _segment((19.0, 19.8, "sebelum"), (19.8, 21.0, "panjang"), (21.9, 21.95, "akhir")),
        _segment((10.0, 10.1, "a"), (10.1, 10.2, "b")),
    ]

    cues = build_caption_cues(segments, [(19.5, 22.0), (10.0, 11.0)])

    assert _timing(cues) == [
        (0.3, 1.5, "panjang"),
        (2.4, 2.5, "akhir"),
        (2.5, 2.8, "a b"),
    ]


def test_short_cue_is_held_for_minimum_display_but_never_overlaps_the_next():
    segment = _segment(
        (1.0, 1.05, "Oh."),
        (1.2, 1.4, "Terus"),
        (3.0, 3.05, "Ya."),
    )

    cues = build_caption_cues([segment], [(0.0, 3.2)])

    assert _timing(cues) == [(1.0, 1.2, "Oh."), (1.2, 1.5, "Terus"), (3.0, 3.2, "Ya.")]


def test_overlapping_asr_word_times_produce_non_overlapping_cues():
    segment = _segment((0.0, 0.9, "satu"), (0.5, 1.0, "dua"), (0.6, 1.4, "tiga"))

    cues = build_caption_cues([segment], [(0.0, 2.0)], max_words=1)

    assert [cue.text for cue in cues] == ["satu", "dua", "tiga"]
    for earlier, later in pairwise(cues):
        assert earlier.end <= later.start
    assert all(cue.end > cue.start for cue in cues)


def test_words_sharing_one_timestamp_are_merged_instead_of_zero_length_cues():
    segment = _segment((1.0, 1.0, "a"), (1.0, 1.2, "b"), (1.2, 1.6, "c"))

    cues = build_caption_cues([segment], [(0.0, 2.0)], max_words=1)

    assert all(cue.end - cue.start >= 0.05 for cue in cues)
    assert " ".join(cue.text for cue in cues) == "a b c"


def test_cue_times_are_quantized_to_centiseconds():
    segment = _segment((0.1234, 0.4567, "satu"), (0.4567, 0.9876, "dua"))

    cues = build_caption_cues([segment], [(0.0, 2.0)])

    assert _timing(cues) == [(0.12, 0.99, "satu dua")]
    assert [(word.start, word.end) for word in cues[0].words] == [(0.12, 0.46), (0.46, 0.99)]


def test_control_characters_are_removed_from_caption_words():
    segment = TranscriptSegment(
        0.0, 1.0, "ok", words=_words((0.0, 0.5, "hal\x07o"), (0.5, 1.0, "\x1b"))
    )

    cues = build_caption_cues([segment], [(0.0, 1.0)])

    assert [cue.text for cue in cues] == ["halo"]


def test_to_srt_uses_word_timing_when_words_exist():
    segments = [
        _segment((8.0, 8.9, "Kesalahan"), (8.9, 9.6, "terbesar"), (9.6, 10.5, "kita")),
    ]

    srt = to_srt(segments, clip_start=9.0, clip_end=12.0)

    assert srt == "1\n00:00:00,000 --> 00:00:01,500\nterbesar kita\n"


def test_timeline_srt_serializes_cues_with_offsets():
    segments = [
        _segment((20.5, 20.9, "Kode"), (20.9, 21.4, "rahasia!")),
        _segment((10.2, 10.6, "Awal"), (10.6, 11.0, "cerita.")),
    ]

    srt = timeline_to_srt(segments, [(20.0, 22.0), (10.0, 13.0)])

    assert srt == (
        "1\n00:00:00,500 --> 00:00:01,400\nKode rahasia!\n\n"
        "2\n00:00:02,200 --> 00:00:03,000\nAwal cerita.\n"
    )
    assert cues_to_srt(()) == ""


@pytest.mark.parametrize(
    "ranges",
    [
        [],
        [(1.0, 1.0)],
        [(2.0, 1.0)],
        [(-1.0, 1.0)],
        [(0.0, float("nan"))],
        [(0.0, float("inf"))],
        [(0.0,)],
    ],
)
def test_invalid_timeline_ranges_are_rejected(ranges):
    with pytest.raises((TypeError, ValueError)):
        build_caption_cues([], ranges)


@pytest.mark.parametrize(
    "options",
    [{"max_words": 0}, {"max_gap": -0.1}, {"min_display": float("nan")}],
)
def test_invalid_cue_options_are_rejected(options):
    with pytest.raises(ValueError):
        build_caption_cues([], [(0.0, 1.0)], **options)


@pytest.mark.parametrize(
    ("start", "end", "words"),
    [
        (1.0, 1.0, (CaptionWord(1.0, 1.0, "a"),)),
        (0.0, 1.0, ()),
        (0.0, 1.0, (CaptionWord(0.5, 1.5, "a"),)),
        (float("nan"), 1.0, (CaptionWord(0.5, 1.0, "a"),)),
    ],
)
def test_caption_cue_validates_its_fields(start, end, words):
    with pytest.raises((TypeError, ValueError)):
        CaptionCue(start, end, words)


def test_caption_word_rejects_blank_text():
    with pytest.raises(ValueError):
        CaptionWord(0.0, 1.0, "  ")
