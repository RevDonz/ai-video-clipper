"""Gain envelopes: integer breakpoints and their f32 expansion (plan §5.3, §5.6; T1.4)."""

from __future__ import annotations

import array
import math
import random
import struct
import sys
import time
from fractions import Fraction
from itertools import pairwise

import pytest

from ai_clipper.edit_v2 import envelope as env
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.timemap import Fps, Piece

NTSC = Fps(30000, 1001)
FILM = Fps(24, 1)
UNITY = 1_000_000


def _pieces(*ranges: tuple[str, str, int, int]) -> tuple[Piece, ...]:
    out: list[Piece] = []
    f0 = 0
    for seg, role, in_sf, out_sf in ranges:
        out.append(Piece(len(out), seg, role, in_sf, out_sf, f0, out_sf - in_sf))
        f0 += out_sf - in_sf
    return tuple(out)


def _floats(data: bytes) -> list[float]:
    return list(struct.unpack(f"<{len(data) // 4}f", data))


def _f32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


def _item(**payload: object) -> dict:
    body = {
        "asset": "sha256:" + "a" * 64, "src_in_smp": 0, "loop": True, "gain_cdb": 0,
        "fade_in_f": 0, "fade_out_f": 0,
        "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                 "hold_ms": 250, "detector": "words"},
    }
    duck = payload.pop("duck", {})
    body.update(payload)
    body["duck"] = {**body["duck"], **duck}
    return {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
            "end": {"at": "clip_end"}, "payload": body, "origin": "user"}


# --- deterministic gain conversion ------------------------------------------------------------


@pytest.mark.parametrize(
    ("cdb", "e6"),
    [
        (0, 1_000_000),
        (-600, 501_187),
        (-1000, 316_228),
        (-2400, 63_096),
        (-4800, 3_981),
        (300, 1_412_538),
        (600, 1_995_262),
        (1200, 3_981_072),
    ],
)
def test_gain_e6_vectors(cdb, e6):
    assert env.gain_e6(cdb) == e6


def test_gain_e6_agrees_with_the_float_formula_over_the_document_range():
    # The Decimal conversion is platform independent; the float formula is only a cross-check.
    for cdb in range(-4800, 1201):
        exact = env.gain_e6(cdb)
        approx = 10 ** (cdb / 2000) * 1e6
        assert abs(exact - approx) <= 0.5 + 1e-6, cdb


def test_gain_e6_rejects_non_integers():
    with pytest.raises(TypeError):
        env.gain_e6(1.5)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        env.gain_e6(True)  # type: ignore[arg-type]


# --- speech envelope: micro-fades at every join -------------------------------------------------


def test_single_piece_is_a_constant_unity_envelope():
    pieces = _pieces(("seg_b1", "body", 100, 400))
    total = tm.smp(300, NTSC)
    assert total == 480_480
    assert env.speech_envelope(pieces, {}, 8, NTSC, 0) == ((0, UNITY), (total, UNITY))


def test_jump_cut_gets_a_linear_ramp_to_zero_and_back():
    pieces = _pieces(("seg_b1", "body", 100, 200), ("seg_b1", "body", 250, 400))
    join = tm.smp(100, NTSC)
    assert join == 160_160
    assert env.speech_envelope(pieces, {}, 8, NTSC, 0) == (
        (0, UNITY),
        (join - 384, UNITY),
        (join, 0),
        (join + 384, UNITY),
        (tm.smp(250, NTSC), UNITY),
    )


def test_cold_open_join_uses_audio_fade_ms():
    pieces = _pieces(("seg_co", "cold_open", 500, 560), ("seg_b1", "body", 100, 400))
    join = tm.smp(60, NTSC)
    assert join == 96_096
    assert env.speech_envelope(pieces, {"seg_co": 30}, 8, NTSC, 0) == (
        (0, UNITY),
        (join - 1440, UNITY),
        (join, 0),
        (join + 1440, UNITY),
        (tm.smp(360, NTSC), UNITY),
    )


def test_cuts_inside_the_cold_open_use_cut_fade_ms():
    pieces = _pieces(
        ("seg_co", "cold_open", 500, 530),
        ("seg_co", "cold_open", 540, 560),
        ("seg_b1", "body", 100, 400),
    )
    first = tm.smp(30, NTSC)
    second = tm.smp(50, NTSC)
    result = env.speech_envelope(pieces, {"seg_co": 30}, 8, NTSC, 0)
    assert result == (
        (0, UNITY),
        (first - 384, UNITY),
        (first, 0),
        (first + 384, UNITY),
        (second - 1440, UNITY),
        (second, 0),
        (second + 1440, UNITY),
        (tm.smp(350, NTSC), UNITY),
    )


def test_fades_are_clamped_to_half_of_each_neighbour():
    # 24 fps: 2000 samples per frame. The middle piece has 2 frames = 4000 samples, so each of
    # its fades is at most 2000 samples although cut_fade_ms = 50 asks for 2400.
    pieces = _pieces(
        ("seg_b1", "body", 0, 10), ("seg_b1", "body", 20, 22), ("seg_b1", "body", 40, 100)
    )
    assert env.speech_envelope(pieces, {}, 50, FILM, 0) == (
        (0, UNITY),
        (17_600, UNITY),
        (20_000, 0),
        (22_000, UNITY),
        (24_000, 0),
        (26_400, UNITY),
        (144_000, UNITY),
    )


def test_odd_neighbour_lengths_round_the_half_down():
    # 30000/1001: piece of 2 frames starting at output frame 1 spans smp(3) - smp(1) = 3203
    # samples, so its fades are clamped to 1601.
    pieces = _pieces(
        ("seg_b1", "body", 0, 1), ("seg_b1", "body", 10, 12), ("seg_b1", "body", 20, 40)
    )
    lengths = [tm.smp(p.out_f0 + p.frames, NTSC) - tm.smp(p.out_f0, NTSC) for p in pieces]
    assert lengths[1] == 3203
    result = env.speech_envelope(pieces, {}, 50, NTSC, 0)
    first, second = tm.smp(1, NTSC), tm.smp(3, NTSC)
    assert result == (
        (0, UNITY),
        (first - lengths[0] // 2, UNITY),
        (first, 0),
        (first + 1601, UNITY),
        (second - 1601, UNITY),
        (second, 0),
        (second + 2400, UNITY),
        (tm.smp(23, NTSC), UNITY),
    )


def test_source_gain_scales_every_breakpoint():
    pieces = _pieces(("seg_b1", "body", 100, 200), ("seg_b1", "body", 250, 400))
    join = tm.smp(100, NTSC)
    g = env.gain_e6(-600)
    assert env.speech_envelope(pieces, {}, 8, NTSC, -600) == (
        (0, g), (join - 384, g), (join, 0), (join + 384, g), (tm.smp(250, NTSC), g),
    )


def test_zero_fade_means_a_hard_cut():
    pieces = _pieces(("seg_co", "cold_open", 500, 560), ("seg_b1", "body", 100, 400))
    total = tm.smp(360, NTSC)
    assert env.speech_envelope(pieces, {"seg_co": 0}, 8, NTSC, 0) == ((0, UNITY), (total, UNITY))
    two = _pieces(("seg_b1", "body", 100, 200), ("seg_b1", "body", 250, 400))
    assert env.speech_envelope(two, {}, 0, NTSC, 300) == (
        (0, env.gain_e6(300)), (tm.smp(250, NTSC), env.gain_e6(300)),
    )


# --- music envelope: gain, fades, ducking ---------------------------------------------------------


def test_music_gain_alone_is_constant():
    total = tm.smp(300, NTSC)
    item = _item(gain_cdb=-1000, duck={"on": False})
    assert env.music_envelope([(1000, 5000)], item, total, NTSC) == (
        (0, 316_228), (total, 316_228),
    )


def test_music_fades_are_linear_ramps_on_the_frame_grid():
    total = tm.smp(300, NTSC)
    item = _item(gain_cdb=-1000, fade_in_f=15, fade_out_f=30, duck={"on": False})
    assert env.music_envelope([], item, total, NTSC) == (
        (0, 0),
        (tm.smp(15, NTSC), 316_228),
        (tm.smp(270, NTSC), 316_228),
        (total, 0),
    )


def test_duck_span_ramps_down_before_and_up_after_span_end_plus_hold():
    total = tm.smp(300, NTSC)
    item = _item()
    depth = env.gain_e6(-1000)
    assert env.music_envelope([(100_000, 200_000)], item, total, NTSC) == (
        (0, UNITY),
        (100_000 - 1440, UNITY),
        (100_000, depth),
        (200_000 + 12_000, depth),
        (200_000 + 12_000 + 19_200, UNITY),
        (total, UNITY),
    )


def test_spans_closer_than_hold_are_merged():
    total = tm.smp(300, NTSC)
    item = _item()
    merged = env.music_envelope([(100_000, 200_000)], item, total, NTSC)
    assert env.music_envelope([(100_000, 150_000), (160_000, 200_000)], item, total, NTSC) == merged
    assert env.merge_spans([(100_000, 150_000), (160_000, 200_000), (230_000, 240_000)],
                           12_000) == ((100_000, 200_000), (230_000, 240_000))


def test_overlapping_and_unsorted_spans_are_merged():
    assert env.merge_spans([(300, 400), (100, 250), (200, 260), (500, 500)], 0) == (
        (100, 260), (300, 400),
    )


def test_gap_equal_to_hold_is_not_merged_but_stays_ducked():
    total = tm.smp(300, NTSC)
    item = _item()
    separate = env.music_envelope([(100_000, 150_000), (162_000, 200_000)], item, total, NTSC)
    merged = env.music_envelope([(100_000, 200_000)], item, total, NTSC)
    assert env.expand_f32(separate, total) == env.expand_f32(merged, total)


def _duck_reference(s, traps, depth_e6, attack, release):
    """Brute force: the minimum of every span's trapezoid at sample ``s`` (e6, float)."""
    value = float(UNITY)
    for lo, a, h, hi in traps:
        if lo < s < a:
            value = min(value, UNITY + (depth_e6 - UNITY) * (s - lo) / attack)
        elif a <= s <= h:
            value = min(value, float(depth_e6))
        elif h < s < hi:
            value = min(value, depth_e6 + (UNITY - depth_e6) * (s - h) / release)
    return value


def test_overlapping_release_and_attack_take_the_minimum_exactly():
    total = 260_000
    spans = [(100_000, 150_000), (175_000, 250_000)]
    item = _item()
    result = env.music_envelope(spans, item, total, NTSC)
    # The release of the first span (162000..181200) crosses the attack of the second
    # (173560..175000) at x = (A·R + A·162000 + R·173560)/(A + R) = 174093.02…: both
    # neighbouring integer samples are breakpoints.
    samples = [s for s, _g in result]
    assert 174_093 in samples and 174_094 in samples
    depth = env.gain_e6(-1000)
    traps = [(a - 1440, a, b + 12_000, b + 12_000 + 19_200)
             for a, b in env.merge_spans(spans, 12_000)]
    values = _floats(env.expand_f32(result, total))
    assert values[:98_560] == [1.0] * 98_560
    worst = max(abs(values[s] * UNITY - _duck_reference(s, traps, depth, 1440, 19_200))
                for s in range(98_560, total))
    assert worst <= 1.0  # breakpoint rounding (0.5 e6) plus f32 rounding


def test_attack_before_zero_and_release_after_the_end_are_clipped():
    total = 400_000
    item = _item()
    depth = env.gain_e6(-1000)
    result = env.music_envelope([(500, 50_000), (390_000, 399_000)], item, total, NTSC)
    first_value = UNITY + Fraction((depth - UNITY) * 940, 1440)
    assert result[0] == (0, math.floor(first_value + Fraction(1, 2)))
    assert result[1] == (500, depth)
    assert result[-1][0] == total
    assert result[-1][1] == depth  # still held at the end (399000 + hold > total)


def test_duck_off_ignores_speech():
    total = tm.smp(300, NTSC)
    item = _item(duck={"on": False})
    assert env.music_envelope([(100_000, 200_000)], item, total, NTSC) == (
        (0, UNITY), (total, UNITY),
    )


def test_fade_times_duck_is_subdivided_where_two_factors_ramp():
    total = tm.smp(300, NTSC)
    item = _item(gain_cdb=-600, fade_in_f=60, duck={"release_ms": 2000})
    spans = [(10_000, 40_000)]
    result = env.music_envelope(spans, item, total, NTSC)
    g = env.gain_e6(-600)
    depth = env.gain_e6(-1000)
    fade_end = tm.smp(60, NTSC)
    release = (40_000 + 12_000, 40_000 + 12_000 + 96_000)
    # The designed product at every sample vs the expanded envelope.
    values = _floats(env.expand_f32(result, total))
    worst = 0.0
    for s in range(160_000):
        fade = min(s, fade_end) / fade_end
        if s < 10_000 - 1440:
            duck = float(UNITY)
        elif s < 10_000:
            duck = UNITY + (depth - UNITY) * (s - (10_000 - 1440)) / 1440
        elif s <= release[0]:
            duck = float(depth)
        elif s < release[1]:
            duck = depth + (UNITY - depth) * (s - release[0]) / 96_000
        else:
            duck = float(UNITY)
        exact = g * fade * duck / UNITY
        worst = max(worst, abs(values[s] * UNITY - exact))
    assert worst <= 2.0  # 2e-6 absolute gain: breakpoint rounding + curvature + f32
    # Breakpoints are at most 10 ms apart where the fade-in and the release ramp overlap.
    inside = [s for s, _g in result if release[0] <= s <= fade_end]
    assert inside and max(b - a for a, b in pairwise(inside)) <= 480


def test_music_envelope_is_deterministic_and_integer():
    total = tm.smp(2700, NTSC)
    rng = random.Random(7)
    spans = []
    t = 20_000
    while t < total - 100_000:
        length = rng.randrange(5_000, 60_000)
        spans.append((t, t + length))
        t += length + rng.randrange(1_000, 50_000)
    item = _item(gain_cdb=-1300, fade_in_f=15, fade_out_f=30)
    first = env.music_envelope(spans, item, total, NTSC)
    assert first == env.music_envelope(list(spans), item, total, NTSC)
    assert all(type(s) is int and type(g) is int for s, g in first)
    assert all(a[0] < b[0] for a, b in pairwise(first))
    assert first[0][0] == 0 and first[-1][0] == total


# --- f32 expansion --------------------------------------------------------------------------------


def test_expand_ramp_values_are_the_exact_rational_rounded():
    envelope = ((0, 0), (384, UNITY))
    values = _floats(env.expand_f32(envelope, 400))
    assert len(values) == 400
    assert values[:384] == [_f32(k / 384) for k in range(384)]
    assert values[384:] == [1.0] * 16


def test_expand_holds_before_the_first_and_after_the_last_breakpoint():
    envelope = ((100, 500_000), (200, 250_000))
    values = _floats(env.expand_f32(envelope, 300))
    assert values[:100] == [0.5] * 100
    assert values[200:] == [0.25] * 100
    assert values[150] == _f32(0.375)


def test_expand_is_little_endian_f32():
    data = env.expand_f32(((0, 316_228),), 3)
    assert data == struct.pack("<3f", 0.316228, 0.316228, 0.316228)
    assert env.expand_f32(((0, UNITY),), 0) == b""


def test_expand_matches_the_speech_envelope_join():
    pieces = _pieces(("seg_b1", "body", 100, 200), ("seg_b1", "body", 250, 400))
    total = tm.smp(250, NTSC)
    envelope = env.speech_envelope(pieces, {}, 8, NTSC, 0)
    values = _floats(env.expand_f32(envelope, total))
    join = tm.smp(100, NTSC)
    assert values[join] == 0.0
    assert values[join - 1] == _f32(1 / 384)
    assert values[join + 1] == _f32(1 / 384)
    assert values[join - 384] == 1.0 and values[join + 384] == 1.0
    assert all(v == 1.0 for v in values[: join - 384])


@pytest.mark.parametrize(
    "bad",
    [
        (),
        ((0, 1), (0, 2)),
        ((10, 1), (5, 2)),
        ((0, -1),),
        ((0, 1.0),),
    ],
)
def test_expand_rejects_malformed_envelopes(bad):
    with pytest.raises((ValueError, TypeError)):
        env.expand_f32(bad, 10)


def test_expand_rejects_negative_length():
    with pytest.raises(ValueError):
        env.expand_f32(((0, UNITY),), -1)


def _realistic_90s():
    """A 90 s clip at 29.97: 20 jump cuts + cold open; 90 duck spans; 0.5 s/1 s fades."""
    ranges = [("seg_co", "cold_open", 90_000, 90_150)]
    start = 10_000
    for k in range(21):
        ranges.append(("seg_b1", "body", start, start + 121))
        start += 121 + 17
    pieces = _pieces(*ranges)
    frames = tm.total_frames(pieces)
    total = tm.smp(frames, NTSC)
    rng = random.Random(90)
    spans = []
    t = 10_000
    while t < total - 50_000:
        length = rng.randrange(8_000, 40_000)
        spans.append((t, t + length))
        t += length + rng.randrange(6_000, 30_000)
    return pieces, total, spans


def test_expansion_budget_90_s():
    pieces, total, spans = _realistic_90s()
    assert 89 * 48_000 <= total <= 91 * 48_000
    speech = env.speech_envelope(pieces, {"seg_co": 30}, 8, NTSC, 0)
    music = env.music_envelope(spans, _item(gain_cdb=-1000, fade_in_f=15, fade_out_f=30), total,
                               NTSC)
    best = math.inf
    for _ in range(3):
        started = time.perf_counter()
        a = env.expand_f32(speech, total)
        b = env.expand_f32(music, total)
        best = min(best, time.perf_counter() - started)
    assert len(a) == len(b) == 4 * total
    # Plan §5.6 step 3: ≤ 150 ms for a 90 s clip (both envelopes together).
    assert best <= 0.150, f"{best * 1000:.0f} ms for the two 90 s envelopes"


def test_expand_output_is_native_array_compatible():
    data = env.expand_f32(((0, 0), (10, UNITY)), 10)
    values = array.array("f")
    values.frombytes(data)
    if sys.byteorder == "big":
        values.byteswap()
    assert values[0] == 0.0 and values[5] == 0.5
