from itertools import pairwise

import pytest

from ai_clipper.edit_v2.timemap import Fps, Piece
from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.subtitles import (
    CaptionCue,
    CaptionWord,
    FrameCue,
    FrameWord,
    SourceWord,
    build_caption_cues,
    build_frame_cues,
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


# --- Editor V3: integer frame cues (plan §3.4, §5.4; T1.2a) -----------------------------------

HUNDRED = Fps(100, 1)  # 1 frame = 1 centisecond: the legacy cue grid, so both must agree exactly


def _pieces_for_ranges(ranges, fps=HUNDRED):
    pieces = []
    out_f0 = 0
    for index, (start, end) in enumerate(ranges):
        in_sf = round(start * fps.num / fps.den)
        out_sf = round(end * fps.num / fps.den)
        role = "cold_open" if len(ranges) > 1 and index == 0 else "body"
        pieces.append(Piece(index, f"seg_{index}", role, in_sf, out_sf, out_f0, out_sf - in_sf))
        out_f0 += out_sf - in_sf
    return tuple(pieces)


def _source_words(segments):
    words = []
    for segment in segments:
        if segment.words:
            items = [(word.start, word.end, word.text) for word in segment.words]
        else:
            tokens = segment.text.split()
            span = segment.end - segment.start
            items = [
                (segment.start + span * i / len(tokens),
                 segment.start + span * (i + 1) / len(tokens), token)
                for i, token in enumerate(tokens)
            ]
        for start, end, text in items:
            words.append(SourceWord(f"w{len(words):06d}", round(start * 1000),
                                    round(end * 1000), text, False))
    return tuple(words)


def _legacy_in_frames(cues):
    return [
        (round(cue.start * 100), round(cue.end * 100), cue.text,
         [(round(w.start * 100), round(w.end * 100), w.text) for w in cue.words])
        for cue in cues
    ]


def _frames(cues):
    return [(cue.f0, cue.f1, cue.text, [(w.f0, w.f1, w.text) for w in cue.words])
            for cue in cues]


LEGACY_CASES = {
    "word_timed": ([_segment((10.1, 10.4, " Gue"), (10.4, 10.8, " bukan"),
                             (10.8, 11.5, " jambret."))], [(10.0, 13.0)], {}),
    "splits": ([_segment((0.0, 0.2, "satu"), (0.2, 0.4, "dua"), (0.4, 0.6, "tiga"),
                         (0.6, 0.8, "empat"), (0.8, 1.0, "lima"), (1.7, 2.0, "enam"),
                         (2.0, 2.3, "tujuh?"), (2.3, 2.6, "Iya"), (2.6, 2.9, "dong."))],
               [(0.0, 5.0)], {}),
    "gap_at_threshold": ([_segment((0.0, 0.3, "satu"), (0.9, 1.2, "dua"))], [(0.0, 2.0)], {}),
    "edge_words": ([_segment((8.0, 8.9, "Kesalahan"), (8.9, 9.6, "terbesar"), (9.6, 10.5, "kita")),
                    _segment((10.5, 11.0, "adalah"), (11.0, 11.6, "mengejar"),
                             (11.6, 12.3, "semua"), (12.3, 13.25, "pelanggan."))],
                   [(9.0, 12.0)], {}),
    "mostly_outside": ([_segment((4.0, 5.8, "sebelum"), (5.8, 6.4, "tepat"),
                                 (6.4, 8.0, "sesudah"))], [(5.5, 7.0)], {}),
    "proportional": ([TranscriptSegment(8.0, 10.0, "satu dua tiga empat")], [(9.0, 12.0)], {}),
    "cold_open": ([_segment((10.2, 10.6, "Awal"), (10.6, 11.0, "cerita.")),
                   _segment((20.5, 20.9, "Kode"), (20.9, 21.4, "rahasia!"))],
                  [(20.0, 22.0), (10.0, 13.0)], {}),
    "join": ([_segment((19.0, 19.8, "sebelum"), (19.8, 21.0, "panjang"), (21.9, 21.95, "akhir")),
              _segment((10.0, 10.1, "a"), (10.1, 10.2, "b"))],
             [(19.5, 22.0), (10.0, 11.0)], {}),
    "min_display": ([_segment((1.0, 1.05, "Oh."), (1.2, 1.4, "Terus"), (3.0, 3.05, "Ya."))],
                    [(0.0, 3.2)], {}),
    "overlapping_asr": ([_segment((0.0, 0.9, "satu"), (0.5, 1.0, "dua"), (0.6, 1.4, "tiga"))],
                        [(0.0, 2.0)], {"max_words": 1}),
    "shared_timestamp": ([_segment((1.0, 1.0, "a"), (1.0, 1.2, "b"), (1.2, 1.6, "c"))],
                         [(0.0, 2.0)], {"max_words": 1}),
    "quantized": ([_segment((0.1234, 0.4567, "satu"), (0.4567, 0.9876, "dua"))],
                  [(0.0, 2.0)], {}),
    "control_chars": ([TranscriptSegment(0.0, 1.0, "ok", words=_words((0.0, 0.5, "hal\x07o"),
                                                                      (0.5, 1.0, "\x1b")))],
                      [(0.0, 1.0)], {}),
    "mixed": ([_segment((10.1, 10.4, " Gue"), (10.4, 10.8, " bukan"), (10.8, 11.5, " jambret."),
                        (12.3, 12.6, "Kode"), (12.6, 13.2, "rahasia"), (13.25, 13.9, "copet"),
                        (14.8, 15.0, "di"), (15.0, 15.4, "keramaian?")),
               _segment((20.5, 20.9, "Kode"), (20.9, 21.4, "rahasia!")),
               TranscriptSegment(30.0, 32.0, "satu dua tiga empat lima")],
              [(20.0, 22.0), (10.0, 16.0), (29.5, 31.5)], {}),
}


@pytest.mark.parametrize("name", sorted(LEGACY_CASES))
def test_frame_cues_reproduce_the_legacy_cues_on_its_cases(name):
    segments, ranges, options = LEGACY_CASES[name]
    legacy = build_caption_cues(segments, ranges, **options)
    pieces = _pieces_for_ranges(ranges)

    cues = build_frame_cues(_source_words(segments), pieces, HUNDRED, **options)

    assert _frames(cues) == _legacy_in_frames(legacy)
    for cue in cues:
        piece = next(p for p in pieces if p.seg == cue.seg)
        assert piece.out_f0 <= cue.f0 < cue.f1 <= piece.out_f0 + piece.frames


def _body_with_cut():
    # Source body [0, 250) frames at 25 fps with [100, 150) removed.
    return (
        Piece(0, "seg_b1", "body", 0, 100, 0, 100),
        Piece(1, "seg_b1", "body", 150, 250, 100, 100),
    )


def test_cues_span_jump_cuts_because_the_gap_is_measured_in_output_time():
    words = (
        SourceWord("w000001", 3000, 3300, "jadi", False),    # output frames 75-83
        SourceWord("w000002", 3500, 3800, "gue", False),     # 88-95
        SourceWord("w000003", 4400, 4800, "hilang", False),  # midpoint inside the removal
        SourceWord("w000004", 6200, 6500, "pulang", False),  # 105-113: 2.4 s later in source
        SourceWord("w000005", 9000, 9300, "lagi", False),    # 175-183: 2.5 s later in output
    )

    cues = build_frame_cues(words, _body_with_cut(), Fps(25, 1))

    assert [cue.text for cue in cues] == ["jadi gue pulang", "lagi"]
    first = cues[0]
    assert [(w.id, w.f0, w.f1) for w in first.words] == [
        ("w000001", 75, 83), ("w000002", 88, 95), ("w000004", 105, 113)]
    assert (first.f0, first.f1) == (75, 113)
    assert all(cue.seg == "seg_b1" for cue in cues)


def test_a_word_is_clamped_to_its_piece_and_never_spans_a_cut():
    # Midpoint 3.94 s (source frame 98) is in the first piece; the word's end reaches the cut.
    words = (SourceWord("w000001", 3800, 4080, "potong", False),)

    [cue] = build_frame_cues(words, _body_with_cut(), Fps(25, 1))

    assert (cue.words[0].f0, cue.words[0].f1) == (95, 100)
    assert (cue.f0, cue.f1) == (95, 103)  # held 300 ms (8 frames); output time is continuous


def test_cues_never_span_the_cold_open_join():
    pieces = (
        Piece(0, "seg_co", "cold_open", 500, 550, 0, 50),
        Piece(1, "seg_b1", "body", 0, 250, 50, 250),
    )
    words = (
        SourceWord("w000001", 21000, 21800, "akhir", False),  # cold open, output 25-45
        SourceWord("w000002", 22000, 22400, "luar", False),   # in neither segment
        SourceWord("w000003", 200, 500, "awal", False),       # body, output 55-63
        SourceWord("w000004", 520, 800, "body", False),       # 63-70
    )

    cues = build_frame_cues(words, pieces, Fps(25, 1))

    assert [(cue.seg, cue.text, cue.f0, cue.f1) for cue in cues] == [
        ("seg_co", "akhir", 25, 45), ("seg_b1", "awal body", 55, 70)]


def test_the_same_source_word_is_captioned_in_the_cold_open_and_in_the_body():
    pieces = (
        Piece(0, "seg_co", "cold_open", 100, 150, 0, 50),
        Piece(1, "seg_b1", "body", 0, 250, 50, 250),
    )
    words = (SourceWord("w000001", 4400, 4800, "diulang", False),)  # source frames 110-120

    cues = build_frame_cues(words, pieces, Fps(25, 1))

    assert [(cue.seg, cue.f0) for cue in cues] == [("seg_co", 10), ("seg_b1", 160)]


def test_removed_words_are_excluded():
    words = (
        SourceWord("w000001", 3000, 3300, "satu", False),
        SourceWord("w000002", 4400, 4800, "dihapus", False),
    )

    cues = build_frame_cues(words, _body_with_cut(), Fps(25, 1))

    assert [w.id for cue in cues for w in cue.words] == ["w000001"]


def test_a_300_word_clip_is_never_truncated():
    fps = Fps(30000, 1001)
    words = []
    for index in range(300):
        start = 1000 + index * 400
        text = f"kata{index}" + ("." if index % 7 == 6 else "")
        words.append(SourceWord(f"w{index:06d}", start, start + 300, text, index % 11 == 0))
    end_sf = -(-(1000 + 300 * 400 + 1000) * fps.num // (1000 * fps.den))
    pieces = (Piece(0, "seg_b1", "body", 0, end_sf, 0, end_sf),)

    cues = build_frame_cues(words, pieces, fps)

    placed = [w for cue in cues for w in cue.words]
    assert [w.id for w in placed] == [w.id for w in words]
    assert [w.emphasis for w in placed] == [w.emphasis for w in words]
    assert all(len(cue.words) <= 4 for cue in cues)
    for earlier, later in pairwise(cues):
        assert earlier.f1 <= later.f0


def test_minimum_display_is_at_least_300_ms_in_frames():
    for fps, expected in ((Fps(24, 1), 8), (Fps(25, 1), 8), (Fps(30000, 1001), 9)):
        pieces = (Piece(0, "seg_b1", "body", 0, 1000, 0, 1000),)
        words = (SourceWord("w000001", 1000, 1040, "Oh.", False),)
        [cue] = build_frame_cues(words, pieces, fps)
        assert cue.f1 - cue.f0 == expected, fps


def test_frame_cues_follow_max_words_gaps_and_sentence_ends():
    pieces = (Piece(0, "seg_b1", "body", 0, 1000, 0, 1000),)
    words = tuple(SourceWord(f"w{i:06d}", 100 * i, 100 * i + 90, text, False)
                  for i, text in enumerate(["a", "b", "c.", "d", "e", "f", "g", "h"]))

    assert [c.text for c in build_frame_cues(words, pieces, HUNDRED)] == ["a b c.", "d e f g", "h"]
    assert [c.text for c in build_frame_cues(words, pieces, HUNDRED, max_words=3)] == [
        "a b c.", "d e f", "g h"]
    assert len(build_frame_cues(words, pieces, HUNDRED, max_gap_ms=5)) == 8


@pytest.mark.parametrize(
    "options",
    [{"max_words": 0}, {"max_gap_ms": -1}, {"min_display_ms": -1}, {"max_gap_ms": 0.5},
     {"max_words": True}],
)
def test_invalid_frame_cue_options_are_rejected(options):
    with pytest.raises((TypeError, ValueError)):
        build_frame_cues((), (Piece(0, "seg_b1", "body", 0, 10, 0, 10),), HUNDRED, **options)


def test_frame_types_validate_their_fields():
    word = FrameWord("w000001", 3, 5, "halo", False)
    assert FrameCue(3, 9, "seg_b1", (word,)).text == "halo"
    with pytest.raises((TypeError, ValueError)):
        FrameWord("w000001", 5, 3, "halo", False)
    with pytest.raises((TypeError, ValueError)):
        FrameWord("w000001", 1.0, 3, "halo", False)
    with pytest.raises((TypeError, ValueError)):
        FrameCue(3, 3, "seg_b1", (word,))
    with pytest.raises((TypeError, ValueError)):
        FrameCue(4, 9, "seg_b1", (word,))  # the word starts before the cue
    with pytest.raises((TypeError, ValueError)):
        FrameCue(3, 9, "seg_b1", ())
    with pytest.raises((TypeError, ValueError)):
        SourceWord("w000001", 10, 5, "halo", False)
    with pytest.raises((TypeError, ValueError)):
        SourceWord("w000001", 1.5, 5, "halo", False)
    with pytest.raises((TypeError, ValueError)):
        SourceWord("w000001", 1, 5, "halo", "no")
