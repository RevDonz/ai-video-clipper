"""Time map of clip-edit-v2 documents (plan §3.4, Appendix A ``timemap.py``)."""

from __future__ import annotations

import copy
import functools
import importlib.util
import json
import math
import random
import shutil
import subprocess
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "timemap-vectors.json"
GENERATOR = ROOT / "scripts" / "edit_v2" / "gen_timemap_vectors.py"

NTSC = Fps(30000, 1001)
ALL_RATES = (
    Fps(24, 1),
    Fps(25, 1),
    Fps(30, 1),
    Fps(50, 1),
    Fps(60, 1),
    Fps(24000, 1001),
    Fps(30000, 1001),
    Fps(60000, 1001),
)
THREE_HOURS_MS = 3 * 3600 * 1000
# Frames whose IEEE-double time differs from the exact rational time within 3 h. The 30 fps
# figure (7,328) is the one measured by the parity-first spike (plan §3.4, [PF]).
HAZARDS_3H = {
    (24, 1): 0,
    (25, 1): 1569,
    (30, 1): 7328,
    (50, 1): 3142,
    (60, 1): 14668,
    (24000, 1001): 107,
    (30000, 1001): 0,
    (60000, 1001): 0,
}


def _doc(segments, removals=()):
    return {
        "main": {
            "segments": [
                {"id": seg_id, "role": role, "in_sf": in_sf, "out_sf": out_sf}
                for seg_id, role, in_sf, out_sf in segments
            ],
            "removals": [
                {"id": f"rm_{index}", "seg": seg, "in_sf": in_sf, "out_sf": out_sf}
                for index, (seg, in_sf, out_sf) in enumerate(removals)
            ],
        }
    }


def _exact_ms(n: int, fps: Fps) -> Fraction:
    return Fraction(n * 1000 * fps.den, fps.num)


def _frames_in(ms: int, fps: Fps) -> int:
    return ms * fps.num // (1000 * fps.den) + 1


# --- Fps and Piece ---------------------------------------------------------------------------


def test_fps_is_a_frozen_pair_of_positive_integers():
    fps = Fps(30000, 1001)
    assert (fps.num, fps.den) == (30000, 1001)
    assert fps.to_json() == [30000, 1001]
    assert Fps.from_json([25, 1]) == Fps(25, 1)
    assert Fps.from_json((24000, 1001)) == Fps(24000, 1001)
    assert Fps.from_json(fps) is fps
    with pytest.raises(AttributeError):
        fps.num = 30  # type: ignore[misc]
    for bad in ((0, 1), (30, 0), (-30, 1), (True, 1), (30.0, 1), ("30", 1)):
        with pytest.raises((TypeError, ValueError)):
            Fps(*bad)
    for bad in ([30], [30, 1, 1], "30/1", None, [30.0, 1]):
        with pytest.raises((TypeError, ValueError)):
            Fps.from_json(bad)


def test_piece_dto_uses_the_plan_dto_field_names():
    piece = Piece(i=1, seg="seg_b1", role="body", in_sf=37215, out_sf=37483, out_f0=135, frames=268)
    assert piece.to_dto() == {
        "i": 1,
        "seg": "seg_b1",
        "role": "body",
        "inSf": 37215,
        "outSf": 37483,
        "outF0": 135,
        "frames": 268,
    }


# --- pieces ----------------------------------------------------------------------------------


def test_pieces_without_removals_is_one_piece_per_segment():
    doc = _doc([("seg_co", "cold_open", 38210, 38345), ("seg_b1", "body", 37215, 39284)])
    assert tm.pieces(doc) == (
        Piece(0, "seg_co", "cold_open", 38210, 38345, 0, 135),
        Piece(1, "seg_b1", "body", 37215, 39284, 135, 2069),
    )
    assert tm.total_frames(tm.pieces(doc)) == 135 + 2069


def test_pieces_subtract_removals_and_lay_out_consecutively():
    doc = _doc(
        [("seg_co", "cold_open", 38210, 38345), ("seg_b1", "body", 37215, 39284)],
        [("seg_b1", 37483, 37556), ("seg_b1", 37813, 37848)],
    )
    assert tm.pieces(doc) == (
        Piece(0, "seg_co", "cold_open", 38210, 38345, 0, 135),
        Piece(1, "seg_b1", "body", 37215, 37483, 135, 268),
        Piece(2, "seg_b1", "body", 37556, 37813, 403, 257),
        Piece(3, "seg_b1", "body", 37848, 39284, 660, 1436),
    )


def test_pieces_drop_remaining_sub_ranges_shorter_than_two_frames():
    doc = _doc(
        [("seg_b1", "body", 100, 200)],
        [("seg_b1", 101, 150), ("seg_b1", 151, 160), ("seg_b1", 162, 199)],
    )
    # [100,101) and [150,151) and [199,200) are 1-frame slivers: they join the adjacent cut.
    assert tm.pieces(doc) == (Piece(0, "seg_b1", "body", 160, 162, 0, 2),)


def test_pieces_union_overlapping_touching_and_out_of_segment_removals():
    doc = _doc(
        [("seg_b1", "body", 100, 200)],
        [("seg_b1", 90, 110), ("seg_b1", 110, 120), ("seg_b1", 115, 130), ("seg_b1", 190, 250)],
    )
    assert tm.pieces(doc) == (Piece(0, "seg_b1", "body", 130, 190, 0, 60),)


def test_pieces_ignore_removals_of_other_segments():
    doc = _doc(
        [("seg_co", "cold_open", 500, 560), ("seg_b1", "body", 100, 400)],
        [("seg_b1", 500, 520), ("seg_zz", 100, 400)],
    )
    assert [(p.seg, p.in_sf, p.out_sf) for p in tm.pieces(doc)] == [
        ("seg_co", 500, 560),
        ("seg_b1", 100, 400),
    ]


def test_pieces_of_a_fully_removed_segment_are_empty():
    doc = _doc([("seg_b1", "body", 100, 200)], [("seg_b1", 100, 200)])
    assert tm.pieces(doc) == ()
    assert tm.total_frames(()) == 0


def test_pieces_reject_malformed_segments():
    with pytest.raises((TypeError, ValueError)):
        tm.pieces(_doc([("seg_b1", "body", 200, 100)]))
    with pytest.raises((TypeError, ValueError)):
        tm.pieces(_doc([("seg_b1", "body", 1.5, 100)]))
    with pytest.raises((TypeError, ValueError)):
        tm.pieces(_doc([("seg_b1", "body", 0, 100)], [("seg_b1", 50, 40)]))


# --- out_to_src ------------------------------------------------------------------------------


def test_out_to_src_maps_output_frames_to_source_grid_frames():
    doc = _doc(
        [("seg_co", "cold_open", 38210, 38345), ("seg_b1", "body", 37215, 39284)],
        [("seg_b1", 37483, 37556)],
    )
    pieces = tm.pieces(doc)
    assert tm.out_to_src(0, pieces) == (pieces[0], 38210)
    assert tm.out_to_src(134, pieces) == (pieces[0], 38344)
    assert tm.out_to_src(135, pieces) == (pieces[1], 37215)
    assert tm.out_to_src(402, pieces) == (pieces[1], 37482)
    assert tm.out_to_src(403, pieces) == (pieces[2], 37556)
    total = tm.total_frames(pieces)
    assert tm.out_to_src(total - 1, pieces) == (pieces[2], 39283)
    for bad in (-1, total):
        with pytest.raises(ValueError):
            tm.out_to_src(bad, pieces)


# --- word_frames -----------------------------------------------------------------------------


def test_word_frames_midpoint_rule_rounding_and_clamping():
    fps = Fps(30, 1)
    pieces = tm.pieces(_doc([("seg_b1", "body", 100, 200)], [("seg_b1", 120, 130)]))
    # Piece 0 covers [3333.3, 4000) ms, piece 1 covers [4333.3, 6666.7) ms.
    assert tm.word_frames(3500, 3700, pieces, fps) == (5, 11)
    assert tm.word_frames(4400, 4600, pieces, fps) == (22, 28)
    # Starts before its piece (midpoint inside): clamped to the piece start.
    assert tm.word_frames(4300, 4700, pieces, fps) == (20, 31)
    # Midpoint exactly on a frame start belongs to that frame (4000 ms = frame 120, removed).
    assert tm.word_frames(3900, 4100, pieces, fps) is None
    # Midpoint outside every piece.
    assert tm.word_frames(1000, 1200, pieces, fps) is None
    assert tm.word_frames(7000, 7100, pieces, fps) is None
    # Ends after the last frame (midpoint still inside): clamped to the piece end.
    assert tm.word_frames(6600, 6700, pieces, fps) == (88, 90)
    # Zero-length words keep n_off >= n_on.
    assert tm.word_frames(3500, 3500, pieces, fps) == (5, 5)


def test_word_frames_round_half_up_on_exact_halves():
    fps = Fps(25, 1)  # 40 ms per frame
    pieces = tm.pieces(_doc([("seg_b1", "body", 0, 100)]))
    assert tm.word_frames(20, 60, pieces, fps) == (1, 2)  # 0.5 -> 1, 1.5 -> 2
    assert tm.word_frames(19, 59, pieces, fps) == (0, 1)


def test_word_frames_take_the_first_piece_in_output_order():
    fps = Fps(30, 1)
    doc = _doc([("seg_co", "cold_open", 150, 180), ("seg_b1", "body", 100, 200)])
    pieces = tm.pieces(doc)
    # 5.1-5.3 s lies in the cold open (frames 150..180) and in the body.
    assert tm.word_frames(5100, 5300, pieces, fps) == (3, 9)
    body_only = tuple(p for p in pieces if p.seg == "seg_b1")
    assert tm.word_frames(5100, 5300, body_only, fps) == (30 + 53, 30 + 59)


def test_word_frames_reject_reversed_words():
    pieces = tm.pieces(_doc([("seg_b1", "body", 0, 100)]))
    with pytest.raises(ValueError):
        tm.word_frames(500, 400, pieces, NTSC)


def test_speech_spans_are_sorted_output_sample_spans_per_occurrence():
    fps = Fps(30, 1)
    doc = _doc(
        [("seg_co", "cold_open", 150, 180), ("seg_b1", "body", 100, 200)],
        [("seg_b1", 120, 130)],
    )
    pieces = tm.pieces(doc)
    words = [(3500, 3700), (3900, 4100), (5100, 5300), (5500, 5500), (9000, 9100)]
    spans = tm.speech_spans(words, pieces, fps)
    # Cold-open occurrence of 5.1-5.3 s, then body words 3.5-3.7 s and 5.1-5.3 s; the removed,
    # zero-length and outside words produce nothing.
    assert spans == (
        (tm.smp(3, fps), tm.smp(9, fps)),
        (tm.smp(35, fps), tm.smp(41, fps)),
        (tm.smp(30 + 20 + 23, fps), tm.smp(30 + 20 + 29, fps)),
    )


# --- samples, grid, cells --------------------------------------------------------------------


def test_sf_floor_and_ceil_are_exact_rational_roundings():
    assert tm.sf_floor(1241900, NTSC) == 37219
    assert tm.sf_ceil(1309400, NTSC) == 39243
    assert tm.sf_floor(1000, Fps(25, 1)) == tm.sf_ceil(1000, Fps(25, 1)) == 25
    assert tm.sf_ceil(1001, Fps(25, 1)) == 26
    assert tm.sf_floor(0, NTSC) == tm.sf_ceil(0, NTSC) == 0
    for fps in ALL_RATES:
        for k in range(1, 5000, 7):
            start = _exact_ms(k, fps)
            # The first ms at or after a frame start belongs to that frame; the last ms at or
            # before it rounds up to that frame.
            assert tm.sf_floor(math.ceil(start), fps) == k
            assert tm.sf_ceil(math.floor(start), fps) == k


def test_smp_is_floor_of_the_exact_sample_position():
    assert tm.smp(0, NTSC) == 0
    assert tm.smp(1, NTSC) == 1601
    assert tm.smp(2, NTSC) == 3203
    assert tm.smp(30000, NTSC) == 48000 * 1001
    assert tm.smp(25, Fps(25, 1)) == 48000
    assert tm.smp(3, Fps(24, 1), rate=44100) == 5512


def test_samples_at_29_97_over_10_hours_have_zero_drift():
    frames = 10 * 3600 * 30000 // 1001 + 1
    previous = 0
    counts = {1601: 0, 1602: 0}
    for n in range(1, frames + 1):
        current = tm.smp(n, NTSC)
        counts[current - previous] += 1
        previous = current
    assert set(counts) == {1601, 1602}
    # Sum of per-frame counts equals the absolute position: no accumulated drift.
    assert sum(size * count for size, count in counts.items()) == tm.smp(frames, NTSC)
    exact = Fraction(frames * 48000 * 1001, 30000)
    assert 0 <= exact - tm.smp(frames, NTSC) < 1
    # Every 1001 s (30,000 frames) the grid lands exactly on a sample.
    for k in range(1, 36):
        assert tm.smp(30000 * k, NTSC) == 48000 * 1001 * k


def test_piece_sample_counts_tile_the_output_exactly():
    rng = random.Random(7)
    for _ in range(200):
        fps = rng.choice(ALL_RATES)
        sizes = [rng.randint(2, 5000) for _ in range(rng.randint(1, 30))]
        out_f0 = 0
        total = 0
        for size in sizes:
            total += tm.smp(out_f0 + size, fps) - tm.smp(out_f0, fps)
            out_f0 += size
        assert total == tm.smp(out_f0, fps)


def test_cell_frames_is_two_seconds_rounded_up():
    assert tm.cell_frames(NTSC) == 60
    assert tm.cell_frames(Fps(30, 1)) == 60
    assert tm.cell_frames(Fps(25, 1)) == 50
    assert tm.cell_frames(Fps(24, 1)) == 48
    assert tm.cell_frames(Fps(24000, 1001)) == 48
    assert tm.cell_frames(Fps(60000, 1001)) == 120


def test_div_round_half_up():
    assert tm.div_round_half_up(5, 2) == 3
    assert tm.div_round_half_up(-5, 2) == -2
    assert tm.div_round_half_up(-7, 2) == -3
    assert tm.div_round_half_up(7, 3) == 2
    assert tm.div_round_half_up(0, 9) == 0
    with pytest.raises(ValueError):
        tm.div_round_half_up(1, 0)
    with pytest.raises(ValueError):
        tm.div_round_half_up(1, -2)


def test_logo_box_follows_the_integer_rule_of_section_3_4():
    box = tm.logo_box(x_e5=88000, y_e5=7000, w_e5=16000, asset_w=512, asset_h=512,
                      out_w=720, out_h=1280)
    assert box == (576, 32, 115, 115)
    wide = tm.logo_box(x_e5=50000, y_e5=50000, w_e5=40000, asset_w=800, asset_h=200,
                       out_w=1080, out_h=1920)
    assert wide == (324, 906, 432, 108)
    # x0 + w lands exactly on the right edge for x_e5 = 92000.
    edge = tm.logo_box(x_e5=92000, y_e5=50000, w_e5=16000, asset_w=512, asset_h=512,
                       out_w=720, out_h=1280)
    assert edge[0] + edge[2] == 720


# --- property tests --------------------------------------------------------------------------


def _random_doc(rng: random.Random):
    segments = []
    body_in = rng.randint(0, 200_000)
    body_out = body_in + rng.randint(2, 9000)
    if rng.random() < 0.5:
        co_in = rng.randint(0, 210_000)
        segments.append(("seg_co", "cold_open", co_in, co_in + rng.randint(2, 240)))
    segments.append(("seg_b1", "body", body_in, body_out))
    removals = []
    for seg_id, _role, in_sf, out_sf in segments:
        cursor = in_sf
        while cursor < out_sf and rng.random() < 0.85:
            start = cursor + rng.randint(0, 120)
            end = start + rng.randint(1, 90)
            if end > out_sf:
                break
            removals.append((seg_id, start, end))
            cursor = end + rng.randint(0, 3)
    return _doc(segments, removals)


def _brute_force(doc):
    kept_runs = []
    removals = doc["main"]["removals"]
    for segment in doc["main"]["segments"]:
        removed = set()
        for removal in removals:
            if removal["seg"] == segment["id"]:
                removed.update(range(removal["in_sf"], removal["out_sf"]))
        run = []
        for sf in range(segment["in_sf"], segment["out_sf"] + 1):
            if sf < segment["out_sf"] and sf not in removed:
                run.append(sf)
                continue
            if len(run) >= 2:
                kept_runs.append((segment["id"], run[0], run[-1] + 1))
            run = []
    return kept_runs


def test_property_pieces_match_frame_by_frame_expansion():
    rng = random.Random(20260924)
    for _ in range(150):
        doc = _random_doc(rng)
        pieces = tm.pieces(doc)
        assert [(p.seg, p.in_sf, p.out_sf) for p in pieces] == _brute_force(doc)


def test_property_monotonic_contiguous_and_summed():
    rng = random.Random(11)
    for _ in range(300):
        doc = _random_doc(rng)
        pieces = tm.pieces(doc)
        out_f0 = 0
        for index, piece in enumerate(pieces):
            assert piece.i == index
            assert piece.out_f0 == out_f0
            assert piece.frames == piece.out_sf - piece.in_sf >= tm.MIN_PIECE_FRAMES
            out_f0 += piece.frames
        assert tm.total_frames(pieces) == out_f0 == sum(p.frames for p in pieces)
        # Within a piece the map is strictly increasing and step 1.
        for n in range(0, out_f0, max(1, out_f0 // 50)):
            piece, sf = tm.out_to_src(n, pieces)
            assert piece.out_f0 <= n < piece.out_f0 + piece.frames
            assert sf == piece.in_sf + (n - piece.out_f0)
            if n + 1 < piece.out_f0 + piece.frames:
                assert tm.out_to_src(n + 1, pieces)[1] == sf + 1
        # Pieces of one segment are in source order, separated by a cut, never overlapping.
        for left, right in pairwise(pieces):
            if left.seg == right.seg:
                assert left.out_sf < right.in_sf


def test_property_delete_then_restore_is_byte_identical():
    rng = random.Random(3)
    for _ in range(200):
        doc = _random_doc(rng)
        before = json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()
        pieces_before = tm.pieces(doc)
        edited = copy.deepcopy(doc)
        body = edited["main"]["segments"][-1]
        start = rng.randint(body["in_sf"], body["out_sf"] - 1)
        end = rng.randint(start + 1, body["out_sf"])
        edited["main"]["removals"].append(
            {"id": "rm_new", "seg": body["id"], "in_sf": start, "out_sf": end}
        )
        assert tm.total_frames(tm.pieces(edited)) <= tm.total_frames(pieces_before)
        edited["main"]["removals"] = [r for r in edited["main"]["removals"] if r["id"] != "rm_new"]
        after = json.dumps(edited, sort_keys=True, separators=(",", ":")).encode()
        assert after == before
        assert tm.pieces(edited) == pieces_before


def test_property_word_frames_match_exact_rational_arithmetic():
    rng = random.Random(5)
    for _ in range(150):
        doc = _random_doc(rng)
        fps = rng.choice(ALL_RATES)
        pieces = tm.pieces(doc)
        for _word in range(20):
            s_ms = rng.randint(0, 8_000_000)
            e_ms = s_ms + rng.randint(0, 900)
            got = tm.word_frames(s_ms, e_ms, pieces, fps)
            expected = None
            mid = Fraction(s_ms + e_ms, 2)
            for piece in pieces:
                lo, hi = _exact_ms(piece.in_sf, fps), _exact_ms(piece.out_sf, fps)
                if lo <= mid < hi:
                    rate = Fraction(fps.num, 1000 * fps.den)
                    on = piece.out_f0 + math.floor((s_ms - lo) * rate + Fraction(1, 2))
                    off = piece.out_f0 + math.floor((e_ms - lo) * rate + Fraction(1, 2))
                    last = piece.out_f0 + piece.frames
                    on = min(max(on, piece.out_f0), last)
                    off = max(min(max(off, piece.out_f0), last), on)
                    expected = (on, off)
                    break
            assert got == expected


# --- now_ms and safe_cs ----------------------------------------------------------------------


@functools.cache
def _hazards(fps: Fps, frames: int) -> tuple[int, ...]:
    """Frames whose double-precision time truncates below the exact rational time."""
    q = fps.den / fps.num
    return tuple(
        n
        for n in range(frames)
        if int(float(n) * q * 1000) != (n * 1000 * fps.den) // fps.num
    )


def _on_centisecond(n: int, fps: Fps) -> bool:
    return (n * 1000 * fps.den) % (fps.num * 10) == 0


def test_now_ms_is_ffmpeg_truncated_double_time():
    # 25 fps frame 803: 803 * 0.04 * 1000 = 32119.999999999996 in IEEE double.
    assert tm.now_ms(803, Fps(25, 1)) == 32119
    assert tm.now_ms(804, Fps(25, 1)) == 32160
    assert tm.now_ms(0, NTSC) == 0
    assert tm.now_ms(1, NTSC) == 33
    assert tm.now_ms(30, NTSC) == 1001
    assert tm.now_ms(1, Fps(60, 1)) == 16


def test_hazard_frame_counts_over_three_hours():
    for fps in ALL_RATES:
        frames = _frames_in(THREE_HOURS_MS, fps)
        hazards = _hazards(fps, frames)
        assert len(hazards) == HAZARDS_3H[(fps.num, fps.den)], fps
        for n in hazards[:50]:
            assert tm.now_ms(n, fps) == (n * 1000 * fps.den) // fps.num - 1


def test_safe_cs_has_zero_failures_over_three_hours_at_every_rate():
    for fps in ALL_RATES:
        frames = _frames_in(THREE_HOURS_MS, fps)
        failures = 0
        min_margin = 10
        previous = tm.now_ms(0, fps)
        for n in range(1, frames):
            current = tm.now_ms(n, fps)
            boundary = tm.safe_cs(n, fps) * 10
            # libass shows an event when start <= now < end; a boundary written at safe_cs(n)
            # must switch exactly between frame n - 1 and frame n.
            if not previous < boundary <= current:
                failures += 1
            min_margin = min(min_margin, boundary - previous, current - boundary)
            previous = current
        assert failures == 0, fps
        assert min_margin >= 2, fps


def test_safe_cs_formula_and_frame_zero():
    assert tm.safe_cs(0, NTSC) == -1  # writers clamp to 0; now_ms(0) == 0 shows it at frame 0
    assert tm.safe_cs(1, NTSC) == 3
    assert tm.safe_cs(803, Fps(25, 1)) == 3211
    assert tm.safe_cs(804, Fps(25, 1)) == 3215


C_REFERENCE = r"""
#include <stdint.h>
#include <stdio.h>
typedef struct { int num, den; } Rational;
static double q2d(Rational a) { return a.num / (double) a.den; }
int main(void) {
    long long num, den, n;
    while (scanf("%lld %lld %lld", &num, &den, &n) == 3) {
        int64_t pts = n;
        Rational tb = { (int) den, (int) num };
        double time_ms = pts * q2d(tb) * 1000;   /* libavfilter/vf_subtitles.c filter_frame */
        long long now = time_ms;                  /* ass_render_frame(..., long long now, ...) */
        printf("%lld\n", now);
    }
    return 0;
}
"""


def test_now_ms_reproduces_the_c_double_expression_on_the_hazard_list(tmp_path):
    compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if compiler is None:
        pytest.skip("no C compiler available to build the vf_subtitles reference expression")
    source = tmp_path / "now_ms.c"
    source.write_text(C_REFERENCE, encoding="utf-8")
    binary = tmp_path / "now_ms"
    subprocess.run([compiler, "-O2", "-std=c99", "-o", str(binary), str(source)], check=True)
    cases = []
    for fps in ALL_RATES:
        frames = _frames_in(THREE_HOURS_MS, fps)
        hazards = _hazards(fps, frames)
        cases.extend((fps, n) for n in hazards)
        cases.extend((fps, n + 1) for n in hazards[:200])
        cases.extend((fps, n) for n in range(0, frames, 997))
    stdin = "".join(f"{fps.num} {fps.den} {n}\n" for fps, n in cases)
    result = subprocess.run([str(binary)], input=stdin, capture_output=True, text=True, check=True)
    expected = [int(line) for line in result.stdout.split()]
    assert len(expected) == len(cases) > 26_000
    mismatches = [
        (fps, n) for (fps, n), value in zip(cases, expected) if tm.now_ms(n, fps) != value
    ]
    assert mismatches == []


def _ass_time(cs: int) -> str:
    cs = max(cs, 0)
    hours, rest = divmod(cs, 360000)
    minutes, rest = divmod(rest, 6000)
    seconds, cents = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{cents:02d}"


def _ass_probe(left_start_cs: int, right_start_cs: int) -> str:
    return (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 16\nPlayResY: 16\nWrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        "Style: Default,DejaVu Sans,10,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,"
        "0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        f"Dialogue: 0,{_ass_time(left_start_cs)},9:00:00.00,Default,,0,0,0,,"
        "{\\pos(0,0)\\p1}m 0 0 l 8 0 8 16 0 16{\\p0}\n"
        f"Dialogue: 0,{_ass_time(right_start_cs)},9:00:00.00,Default,,0,0,0,,"
        "{\\pos(8,0)\\p1}m 0 0 l 8 0 8 16 0 16{\\p0}\n"
    )


def _probe_frames(tmp_path: Path, fps: Fps, first: int, ass_text: str) -> list[tuple[int, int]]:
    ffmpeg = shutil.which("ffmpeg")
    (tmp_path / "probe.ass").write_text(ass_text, encoding="utf-8")
    graph = (
        f"color=c=black:s=16x16:r={fps.num}/{fps.den},trim=end_frame=3,"
        f"settb={fps.den}/{fps.num},setpts=PTS+{first},ass=filename=probe.ass"
    )
    result = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
         "-f", "lavfi", "-i", graph, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        cwd=tmp_path, capture_output=True, check=True,
    )
    frames = [result.stdout[index : index + 256] for index in range(0, len(result.stdout), 256)]
    assert len(frames) == 3
    return [(frame[8 * 16 + 3], frame[8 * 16 + 12]) for frame in frames]


def test_ffmpeg_ass_filter_switches_exactly_on_now_ms(tmp_path):
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg not available")
    filters = subprocess.run(
        [ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, check=False
    )
    if " ass " not in filters.stdout:
        pytest.skip("ffmpeg was built without libass")
    checked = 0
    for fps in ALL_RATES:
        frames = _frames_in(THREE_HOURS_MS, fps)
        hazards = _hazards(fps, frames)
        # Hazards whose exact time is a whole centisecond can be written as an ASS start time.
        aligned = [n for n in hazards if _on_centisecond(n, fps)]
        hazard_set = set(hazards)
        controls = []
        for n in range(1, frames):
            if _on_centisecond(n, fps) and n not in hazard_set:
                controls.append(n)
                if len(controls) == 2:
                    break
        for n in aligned[:2] + aligned[-1:] + controls:
            exact_cs = n * 1000 * fps.den // fps.num // 10
            # Left: an event written at the exact frame time; right: the frame-safe time.
            pixels = _probe_frames(tmp_path, fps, n - 1, _ass_probe(exact_cs, tm.safe_cs(n, fps)))
            left = [value > 128 for value, _ in pixels]
            right = [value > 128 for _, value in pixels]
            hazard = tm.now_ms(n, fps) < exact_cs * 10
            assert left == [False, not hazard, True], (fps, n)
            assert right == [False, True, True], (fps, n)
            checked += 1
    assert checked >= 15


# --- shared vectors --------------------------------------------------------------------------


def _load_generator():
    spec = importlib.util.spec_from_file_location("gen_timemap_vectors", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_vector_generation_is_deterministic_and_committed_file_is_current():
    generator = _load_generator()
    first = generator.render()
    second = generator.render()
    assert first == second
    assert VECTORS.read_bytes() == first


def test_vectors_are_reproduced_by_the_python_time_map():
    data = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert data["schema"] == "potongin.timemap-vectors/1"
    total = 0
    for case in data["cases"]:
        fps = Fps.from_json(case["fps"])
        pieces = tm.pieces(case["doc"])
        assert [p.to_dto() for p in pieces] == case["pieces"], case["name"]
        assert tm.total_frames(pieces) == case["total_frames"], case["name"]
        total += 2
        for n, index, sf in case["out_to_src"]:
            piece, got_sf = tm.out_to_src(n, pieces)
            assert (piece.i, got_sf) == (index, sf), (case["name"], n)
            total += 1
        for vector in case["word_frames"]:
            scope = pieces if vector["scope"] is None else tuple(
                p for p in pieces if p.seg == vector["scope"]
            )
            got = tm.word_frames(vector["s_ms"], vector["e_ms"], scope, fps)
            assert (None if got is None else list(got)) == vector["expect"], case["name"]
            total += 1
        spans = tm.speech_spans([tuple(w) for w in case["speech_words"]], pieces, fps)
        assert [list(span) for span in spans] == case["speech_spans"], case["name"]
        total += 1
    scalar = {
        "smp": lambda v: tm.smp(v[2], Fps(v[0], v[1]), rate=v[3]),
        "sf_floor": lambda v: tm.sf_floor(v[2], Fps(v[0], v[1])),
        "sf_ceil": lambda v: tm.sf_ceil(v[2], Fps(v[0], v[1])),
        "now_ms": lambda v: tm.now_ms(v[2], Fps(v[0], v[1])),
        "safe_cs": lambda v: tm.safe_cs(v[2], Fps(v[0], v[1])),
        "cell_frames": lambda v: tm.cell_frames(Fps(v[0], v[1])),
        "div_round_half_up": lambda v: tm.div_round_half_up(v[0], v[1]),
    }
    for name, compute in scalar.items():
        for vector in data[name]:
            assert compute(vector["in"]) == vector["expect"], (name, vector)
            total += 1
    hazard_rows = [v for v in data["now_ms"] if v["hazard"]]
    assert len(hazard_rows) >= 100
    for vector in hazard_rows:
        num, den, n = vector["in"]
        assert vector["expect"] == n * 1000 * den // num - 1
    for vector in data["logo_box"]:
        assert list(tm.logo_box(**vector["in"])) == vector["expect"]
        total += 1
    assert total >= 500
    assert data["counts"]["total"] == total
