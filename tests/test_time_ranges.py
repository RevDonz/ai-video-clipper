"""Rentang waktu (plan 2026-10-20 P2): the person's own time ranges, parsed and checked."""

import pytest

from ai_clipper.time_ranges import (
    MAX_RANGE_SECONDS,
    MAX_RANGES,
    MAX_RANGES_TEXT,
    MIN_RANGE_SECONDS,
    TimeRange,
    TimeRangeError,
    check_ranges,
    check_within_video,
    format_clock,
    parse_time,
    parse_time_range,
    parse_time_ranges,
)


def test_limits_match_the_job_api():
    # web/lib/time-ranges.mjs TIME_RANGE_LIMITS (web/tests/time-ranges.test.mjs compares them).
    assert (MIN_RANGE_SECONDS, MAX_RANGE_SECONDS, MAX_RANGES, MAX_RANGES_TEXT) == (5, 180, 10, 500)


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("0", 0),
        ("90", 90),
        ("3725", 3725),
        ("10.30", 630),
        ("10:30", 630),
        ("0:05", 5),
        ("75:30", 4530),
        ("1:02:10", 3730),
        ("1.02.10", 3730),
        ("1:02.10", 3730),
        ("１０．３０", 630),  # full-width digits and full stop
        ("１:０２:１０", 3730),
        (" 10.30 ", 630),
    ],
)
def test_parse_time_reads_seconds_minutes_and_hours(text, seconds):
    assert parse_time(text) == seconds


@pytest.mark.parametrize(
    "text",
    ["", "10.3", "10.300", "10..30", ":30", "10:", "1:2:3", "1:02:03:04", "abc", "10,30", "-5",
     "123456", "100:00:00", "10.30.5", "1e3"],
)  # fmt: skip
def test_parse_time_rejects_other_shapes(text):
    with pytest.raises(TimeRangeError) as caught:
        parse_time(text)
    assert caught.value.code == "time_range_invalid"


@pytest.mark.parametrize("text", ["10.75", "1:60:00", "0:61"])
def test_parse_time_rejects_minutes_or_seconds_from_60(text):
    with pytest.raises(TimeRangeError, match="00 sampai 59"):
        parse_time(text)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("10.30-12.05", TimeRange(630, 725)),
        ("10:30 - 12:05", TimeRange(630, 725)),
        ("1:02:10-1:03:00", TimeRange(3730, 3780)),
        ("10.30–12.05", TimeRange(630, 725)),  # en dash
        ("10.30—12.05", TimeRange(630, 725)),  # em dash
        ("10.30−12.05", TimeRange(630, 725)),  # minus sign
        ("１０．３０－１２．０５", TimeRange(630, 725)),  # full width
        ("630-725", TimeRange(630, 725)),  # the worker's form: whole seconds
        ("59:50-1:00:20", TimeRange(3590, 3620)),
    ],
)
def test_parse_time_range_accepts_dots_colons_dashes_and_full_width(text, expected):
    assert parse_time_range(text) == expected


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("10.30", "tidak dikenali"),
        ("10.30-", "tidak dikenali"),
        ("10.30-12.05-13.00", "tidak dikenali"),
        ("10.3-12.05", "tidak dikenali"),
        ("12.05-10.30", "waktu selesai harus setelah waktu mulai"),
        ("10.30-10.30", "waktu selesai harus setelah waktu mulai"),
        ("10.30-10.34", "terlalu pendek"),
        ("10.00-13.01", "terlalu panjang"),
    ],
)
def test_parse_time_range_explains_what_is_wrong(text, message):
    with pytest.raises(TimeRangeError, match=message) as caught:
        parse_time_range(text)
    assert caught.value.code == "time_range_invalid"


def test_range_bounds_are_inclusive():
    assert parse_time_range("10.00-10.05").duration == MIN_RANGE_SECONDS
    assert parse_time_range("10.00-13.00").duration == MAX_RANGE_SECONDS


def test_messages_name_the_range_as_a_clock():
    with pytest.raises(TimeRangeError) as caught:
        parse_time_range("1.02.10-1.02.12")
    assert str(caught.value) == "Rentang 1:02:10–1:02:12 terlalu pendek: minimal 5 detik."
    with pytest.raises(TimeRangeError) as caught:
        parse_time_range("abc-def")
    assert str(caught.value) == "“abc-def” tidak dikenali. Contoh: 10.30-12.05 atau 1:02:10-1:03:00."


def test_a_long_unknown_piece_is_shortened_in_the_message():
    with pytest.raises(TimeRangeError) as caught:
        parse_time_range("x" * 80)
    assert "x" * 24 + "…" in str(caught.value)
    assert "x" * 25 not in str(caught.value)


def test_parse_time_ranges_splits_on_commas_semicolons_and_lines():
    assert parse_time_ranges("10.30-12.05, 1:02:10-1:03:00;\n2:00-2:30\r\n") == (
        TimeRange(630, 725),
        TimeRange(3730, 3780),
        TimeRange(120, 150),
    )
    assert parse_time_ranges("") == ()
    assert parse_time_ranges(" ,\n ; ") == ()


def test_parse_time_ranges_keeps_the_typed_order():
    assert parse_time_ranges("5:00-5:30, 1:00-1:30") == (TimeRange(300, 330), TimeRange(60, 90))


def test_parse_time_ranges_refuses_overlaps_and_repeats():
    with pytest.raises(TimeRangeError, match="1:00–1:30 dan 1:20–2:00 tumpang tindih"):
        parse_time_ranges("1:00-1:30, 1:20-2:00")
    with pytest.raises(TimeRangeError, match="tumpang tindih"):
        parse_time_ranges("1:00-1:30, 1:00-1:30")
    # Touching ranges do not overlap.
    assert len(parse_time_ranges("1:00-1:30, 1:30-2:00")) == 2


def test_parse_time_ranges_caps_count_and_length():
    eleven = ", ".join(f"{minute}:00-{minute}:10" for minute in range(11))
    with pytest.raises(TimeRangeError, match="Maksimal 10 rentang waktu"):
        parse_time_ranges(eleven)
    with pytest.raises(TimeRangeError, match="terlalu panjang"):
        parse_time_ranges("1" * (MAX_RANGES_TEXT + 1))


def test_check_ranges_compares_with_the_clip_count():
    ranges = (TimeRange(60, 90), TimeRange(120, 150), TimeRange(200, 230))
    assert check_ranges(ranges, 3) == ranges
    with pytest.raises(TimeRangeError) as caught:
        check_ranges(ranges, 2)
    assert str(caught.value) == (
        "Ada 3 rentang waktu, tetapi jumlah klip 2. Naikkan jumlah klip atau kurangi rentang."
    )
    assert check_ranges((), 1) == ()
    with pytest.raises(TypeError):
        check_ranges([(60, 90)], 3)


@pytest.mark.parametrize(
    ("start", "end"),
    [(-1, 10), (10, 10), (20, 10), (0, 4), (0, 181), (1.5, 10), (True, 10), ("1", 10)],
)
def test_time_range_validates_itself(start, end):
    with pytest.raises((TimeRangeError, TypeError)):
        TimeRange(start, end)


def test_format_clock():
    assert format_clock(0) == "0:00"
    assert format_clock(65) == "1:05"
    assert format_clock(630) == "10:30"
    assert format_clock(3730) == "1:02:10"
    assert format_clock(3499.9) == "58:19"
    assert TimeRange(3730, 3780).label == "1:02:10–1:03:00"


def test_check_within_video_names_the_first_range_past_the_end():
    ranges = (TimeRange(60, 90), TimeRange(3730, 3780))
    check_within_video(ranges, 3800.0)
    check_within_video(ranges, 3779.2)  # the end of a video rounds to the second people see
    with pytest.raises(TimeRangeError) as caught:
        check_within_video(ranges, 3500.4)
    assert caught.value.code == "range_beyond_video"
    assert str(caught.value) == (
        "Rentang 1:02:10–1:03:00 melewati panjang video (58:20). "
        "Perbaiki rentangnya lalu buat job lagi."
    )
    check_within_video(ranges, None)  # an unknown duration is not checked here
