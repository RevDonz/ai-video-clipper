"""Gain envelopes as integer breakpoints and their f32 expansion (plan §5.3, §5.6).

Owner: T1.4. An ``Envelope`` is a tuple of ``(sample, gain_e6)`` breakpoints with strictly
increasing samples (output samples at 48 kHz; ``gain_e6 = round_half_up(g·10⁶)``). The gain is
linear between breakpoints and held before the first and after the last one.

Everything that defines an envelope is integer or exact rational arithmetic: dB are converted in
``decimal`` (no platform ``pow``), ramps and crossings are ``Fraction`` values rounded half up to
``gain_e6``. The same document therefore gives the same breakpoints and the same bytes on every
machine (gate G-DET). ``expand_f32`` is the only place with floats: each sample is the correctly
rounded value of an exact rational, so it is deterministic as well.

* **Speech** (§5.3): a linear ramp to 0 over the last ``cut_fade_ms`` before every join and back
  over the first ``cut_fade_ms`` after it; the cold-open join uses its ``audio_fade_ms``. Each
  side is clamped to half of its neighbour piece. The whole envelope is scaled by the source gain.
* **Music** (§5.6 step 2): gain × fade-in × fade-out × ducking. Ducking merges the speech spans
  whose gap is below ``hold_ms``; each merged span ``[s, e)`` holds the duck level on
  ``[s, e + hold]``, ramps down linearly over ``attack`` before ``s`` and back up over
  ``release`` after ``e + hold``; overlapping ramps take the minimum. The integer samples on both
  sides of every crossing are breakpoints, so the envelope equals the designed minimum at every
  sample. Where two factors ramp at once the product is curved; breakpoints are then placed at
  most 10 ms apart and close enough that linear interpolation stays within 1e-6 of the product.
"""

from __future__ import annotations

import array
import sys
from bisect import bisect_left, bisect_right
from collections.abc import Mapping, Sequence
from decimal import ROUND_HALF_UP, Context, Decimal
from fractions import Fraction
from functools import lru_cache
from itertools import pairwise, repeat
from math import isqrt
from operator import truediv
from typing import Any

from .timemap import SAMPLE_RATE, Fps, Piece, smp

Envelope = tuple[tuple[int, int], ...]  # (sample, gain_e6), increasing

UNITY_E6 = 1_000_000
SAMPLES_PER_MS = SAMPLE_RATE // 1000
MAX_CURVED_SPACING = 480  # 10 ms: breakpoint spacing where two gain factors ramp at once
CURVATURE_TOLERANCE_E6 = 1  # max linear-interpolation error of a curved product (1e-6 gain)

_DECIMAL = Context(prec=40)
_HALF = Fraction(1, 2)


def _integer(value: object, name: str) -> int:
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer")
    return value


def _non_negative(value: object, name: str) -> int:
    if _integer(value, name) < 0:
        raise ValueError(f"{name} must not be negative")
    return value  # type: ignore[return-value]


def _round_half_up(value: Fraction) -> int:
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


@lru_cache(maxsize=8192, typed=True)
def gain_e6(cdb: int) -> int:
    """``round_half_up(10^(cdb/2000) · 10⁶)``: a gain in centi-dB as a linear ``gain_e6``.

    Computed in 40-digit decimal arithmetic, so the result does not depend on the platform's
    ``pow`` (``gain_e6(-1000) == 316228``, ``gain_e6(0) == 1_000_000``).
    """
    _integer(cdb, "gain")
    exponent = _DECIMAL.divide(Decimal(cdb), Decimal(2000))
    value = _DECIMAL.multiply(_DECIMAL.power(Decimal(10), exponent), Decimal(UNITY_E6))
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP, context=_DECIMAL))


# --- speech ----------------------------------------------------------------------------------


def speech_envelope(
    pieces: Sequence[Piece],
    joins: Mapping[str, int],
    cut_fade_ms: int,
    fps: Fps,
    gain_cdb: int,
) -> Envelope:
    """Micro-fades at every join (``cut_fade_ms``, or ``joins[segment_id] = audio_fade_ms``
    after that segment, e.g. 30 ms at the cold-open join), clamped to half of each neighbour,
    times the source gain ``gain_cdb``.

    For a join at output sample ``J`` between pieces ``p`` and ``q`` the breakpoints are
    ``(J − before, g)``, ``(J, 0)``, ``(J + after, g)`` with
    ``before = min(fade, len(p) // 2)`` and ``after = min(fade, len(q) // 2)``; ``fade = 0``
    is a hard cut. The envelope runs from sample 0 to ``smp(total frames)``.
    """
    g = gain_e6(gain_cdb)
    _non_negative(cut_fade_ms, "cut_fade_ms")
    if not pieces:
        return ((0, g),)
    points: dict[int, int] = {0: g}
    for left, right in pairwise(pieces):
        if left.seg == right.seg:
            fade_ms = cut_fade_ms
        else:
            fade_ms = _non_negative(joins.get(left.seg, cut_fade_ms), "audio_fade_ms")
        fade = fade_ms * SAMPLES_PER_MS
        join = smp(right.out_f0, fps)
        before = min(fade, (join - smp(left.out_f0, fps)) // 2)
        after = min(fade, (smp(right.out_f0 + right.frames, fps) - join) // 2)
        if before <= 0 or after <= 0:
            continue
        points[join - before] = g
        points[join] = 0
        points[join + after] = g
    last = pieces[-1]
    points[smp(last.out_f0 + last.frames, fps)] = g
    return tuple(sorted(points.items()))


# --- music -----------------------------------------------------------------------------------


def merge_spans(spans: Sequence[tuple[int, int]], hold_samples: int) -> tuple[tuple[int, int], ...]:
    """Sort the non-empty spans and merge those whose gap is below ``hold_samples`` (plan §5.6:
    "merged when the gap is below ``hold_ms``"; overlapping spans always merge)."""
    _non_negative(hold_samples, "hold")
    merged: list[list[int]] = []
    for start, end in sorted((_integer(a, "span"), _integer(b, "span")) for a, b in spans):
        if end <= start:
            continue
        if merged and start - merged[-1][1] < hold_samples:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return tuple((start, end) for start, end in merged)


def music_item(doc: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The document's music item (track ``kind: audio``, ``role: music``), or None."""
    for track in doc.get("tracks", ()):
        if track.get("kind") == "audio" and track.get("role") == "music" and track.get("items"):
            return track["items"][0]
    return None


class _Music:
    """The exact music gain (e6 units, a ``Fraction``) at any output sample."""

    def __init__(self, spans: Sequence[tuple[int, int]], payload: Mapping[str, Any],
                 total: int, fps: Fps) -> None:
        self.total = total
        self.gain = gain_e6(payload["gain_cdb"])
        fade_in_f = _non_negative(payload["fade_in_f"], "fade_in_f")
        fade_out_f = _non_negative(payload["fade_out_f"], "fade_out_f")
        self.fade_in = min(smp(fade_in_f, fps), total)
        # The frame count whose sample boundary is ``total``: smp(n) = total ⇔ n = ⌈total/r⌉.
        frames = -(-total * fps.num // (SAMPLE_RATE * fps.den))
        self.fade_out = smp(max(frames - fade_out_f, 0), fps) if fade_out_f else total
        self.fade_out = min(self.fade_out, total)
        duck = payload["duck"]
        self.traps: list[tuple[int, int, int, int]] = []
        self.level = UNITY_E6
        if duck["on"]:
            self.level = gain_e6(-_integer(duck["depth_cdb"], "depth_cdb"))
            self.attack = _non_negative(duck["attack_ms"], "attack_ms") * SAMPLES_PER_MS
            hold = _non_negative(duck["hold_ms"], "hold_ms") * SAMPLES_PER_MS
            self.release = _non_negative(duck["release_ms"], "release_ms") * SAMPLES_PER_MS
            for start, end in merge_spans(spans, hold):
                self.traps.append((start - self.attack, start, end + hold,
                                   end + hold + self.release))
        self.los = [t[0] for t in self.traps]
        self.his = [t[3] for t in self.traps]

    # factors (exact) -------------------------------------------------------------------------

    def fade(self, x: int) -> Fraction:
        value = Fraction(1)
        if x < self.fade_in:
            value *= Fraction(x, self.fade_in)
        if x > self.fade_out:
            value *= Fraction(self.total - x, self.total - self.fade_out)
        return value

    def duck(self, x: int) -> Fraction:
        value = Fraction(UNITY_E6)
        level = self.level
        for k in range(bisect_right(self.his, x), bisect_left(self.los, x)):
            lo, start, held, _hi = self.traps[k]
            if x < start:
                ramp = Fraction(UNITY_E6 * self.attack + (level - UNITY_E6) * (x - lo),
                                self.attack)
            elif x <= held:
                ramp = Fraction(level)
            else:
                ramp = Fraction(level * self.release + (UNITY_E6 - level) * (x - held),
                                self.release)
            value = min(value, ramp)
        return value

    def value(self, x: int) -> int:
        return _round_half_up(self.gain * self.fade(x) * self.duck(x) / UNITY_E6)

    # breakpoints -----------------------------------------------------------------------------

    def candidates(self) -> list[int]:
        points = {0, self.total, self.fade_in, self.fade_out}
        for trap in self.traps:
            points.update(trap)
        if self.traps and self.attack and self.release:
            a, r = self.attack, self.release
            for k, (_lo, _start, held, hi) in enumerate(self.traps):
                j = k + 1
                while j < len(self.traps) and self.los[j] < hi:
                    lo_j, start_j = self.traps[j][0], self.traps[j][1]
                    # release of k meets attack of j: (x − held)/R + (x − lo_j)/A = 1
                    cross = Fraction(a * r + a * held + r * lo_j, a + r)
                    if max(held, lo_j) < cross < min(hi, start_j):
                        floor_ = cross.numerator // cross.denominator
                        points.update((floor_, floor_ + 1))
                    j += 1
        return sorted(x for x in points if 0 <= x <= self.total)

    def breakpoints(self) -> Envelope:
        xs = self.candidates()
        refined: list[int] = []
        for x0, x1 in pairwise(xs):
            refined.append(x0)
            refined.extend(self._subdivide(x0, x1))
        refined.append(xs[-1])
        points = [(x, self.value(x)) for x in refined]
        return _drop_flat_interior(points)

    def _subdivide(self, x0: int, x1: int) -> range:
        """Extra breakpoints in ``(x0, x1)`` when at least two factors ramp there."""
        if x1 - x0 < 2:
            return range(0)
        slopes: list[Fraction] = []
        if x1 <= self.fade_in:
            slopes.append(Fraction(1, self.fade_in))
        if x0 >= self.fade_out and self.fade_out < self.total:
            slopes.append(Fraction(1, self.total - self.fade_out))
        d0, d1 = self.duck(x0), self.duck(x1)
        if d0 != d1:
            slopes.append(abs(d1 - d0) / (UNITY_E6 * (x1 - x0)))
        if len(slopes) < 2:
            return range(0)
        # |P''| ≤ 2·g·Σ_{i<j} a_i·a_j; linear interpolation error ≤ |P''|·h²/8 ≤ tolerance.
        curvature = 2 * self.gain * sum(a * b for i, a in enumerate(slopes) for b in slopes[i + 1:])
        limit = Fraction(8 * CURVATURE_TOLERANCE_E6) / curvature
        step = max(1, min(MAX_CURVED_SPACING, isqrt(limit.numerator // limit.denominator)))
        return range(x0 + step, x1, step)


def _drop_flat_interior(points: list[tuple[int, int]]) -> Envelope:
    """Remove a breakpoint whose neighbours both have the same gain (no audible change)."""
    kept = [points[0]]
    for index in range(1, len(points) - 1):
        if not points[index - 1][1] == points[index][1] == points[index + 1][1]:
            kept.append(points[index])
    if len(points) > 1:
        kept.append(points[-1])
    return tuple(kept)


def music_envelope(
    speech_spans: Sequence[tuple[int, int]], item: Mapping, total_samples: int, fps: Fps
) -> Envelope:
    """Music gain × fades × ducking (spans merged by ``hold_ms``; attack before, release after;
    minimum on overlap) for the music ``item`` of the document.

    ``speech_spans`` are output-sample spans of the kept words (``RenderPlan.speech_spans``);
    ``fade_in_f`` ramps from 0 at sample 0 to 1 at ``smp(fade_in_f)`` and ``fade_out_f`` from 1
    at ``smp(frames − fade_out_f)`` to 0 at ``total_samples``. Ramps reaching outside
    ``[0, total_samples]`` are clipped (the first and last breakpoints carry the value there).
    """
    total = _non_negative(total_samples, "total_samples")
    payload = item["payload"]
    music = _Music(speech_spans, payload, total, fps)
    if total == 0:
        return ((0, music.value(0)),)
    return music.breakpoints()


# --- expansion ---------------------------------------------------------------------------------


def _validated(env: Envelope) -> Sequence[tuple[int, int]]:
    if not env:
        raise ValueError("an envelope needs at least one breakpoint")
    previous: int | None = None
    for point in env:
        if len(point) != 2:
            raise ValueError("breakpoints are (sample, gain_e6) pairs")
        sample, gain = _integer(point[0], "sample"), _integer(point[1], "gain_e6")
        if gain < 0:
            raise ValueError("gain_e6 must not be negative")
        if previous is not None and sample <= previous:
            raise ValueError("breakpoint samples must increase strictly")
        previous = sample
    return env


def expand_f32(env: Envelope, total_samples: int) -> bytes:
    """Mono little-endian f32 samples at 48 kHz (≤ 150 ms for a 90 s clip).

    Sample ``s`` between breakpoints ``(s0, g0)`` and ``(s1, g1)`` is the correctly rounded
    value of ``(g0·(s1 − s) + g1·(s − s0)) / ((s1 − s0)·10⁶)`` (an exact integer quotient,
    rounded once to double, then to f32). Constant spans are filled at C speed; each distinct
    ramp is computed once per call.
    """
    points = _validated(env)
    total = _non_negative(total_samples, "total_samples")
    out = array.array("f")
    ramps: dict[tuple[int, int, int], array.array] = {}

    def constant(gain: int, count: int) -> None:
        out.extend(array.array("f", [gain / UNITY_E6]) * count)

    first_sample, first_gain = points[0]
    if first_sample > 0:
        constant(first_gain, min(first_sample, total))
    for (s0, g0), (s1, g1) in pairwise(points):
        lo, hi = max(s0, 0), min(s1, total)
        if lo >= hi:
            continue
        if g0 == g1:
            constant(g0, hi - lo)
            continue
        key = (g0, g1, s1 - s0)
        ramp = ramps.get(key)
        if ramp is None:
            n = s1 - s0
            step = g1 - g0
            ramp = array.array("f", map(truediv, range(g0 * n, g0 * n + step * n, step),
                                        repeat(n * UNITY_E6)))
            ramps[key] = ramp
        out.extend(ramp[lo - s0: hi - s0])
    last_sample, last_gain = points[-1]
    tail = max(last_sample, 0)
    if tail < total:
        constant(last_gain, total - tail)
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


def is_unity(env: Envelope) -> bool:
    """True when the envelope is 1.0 everywhere (multiplying by it changes nothing)."""
    return all(gain == UNITY_E6 for _sample, gain in env)


__all__ = [
    "CURVATURE_TOLERANCE_E6",
    "MAX_CURVED_SPACING",
    "UNITY_E6",
    "Envelope",
    "expand_f32",
    "gain_e6",
    "is_unity",
    "merge_spans",
    "music_envelope",
    "music_item",
    "speech_envelope",
]
