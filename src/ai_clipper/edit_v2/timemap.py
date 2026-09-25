"""Integer time map of clip-edit-v2 documents (plan §3.4, Appendix A ``timemap.py``).

All arithmetic is exact integer arithmetic; rational comparisons use cross-multiplication. The
only floating-point function is :func:`now_ms`, which deliberately reproduces FFmpeg's
``vf_subtitles`` double expression so that ASS event times can be made frame-safe.

Units: ``_sf`` is a source-grid frame at the output rate (frame *k* covers source time
``[k·den/num, (k+1)·den/num)`` s from t = 0), ``_f`` an output frame, ``_ms`` source
milliseconds, samples are at 48 kHz unless ``rate`` says otherwise.

The browser mirror is ``web/lib/editor/timemap.mjs``; both are checked against
``tests/fixtures/edit_v2/timemap-vectors.json``.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

SAMPLE_RATE = 48_000
MIN_PIECE_FRAMES = 2  # a remaining sub-range shorter than this joins the adjacent cut


def _integer(value: object, name: str) -> int:
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer")
    return value


@dataclass(frozen=True, slots=True)
class Fps:
    """A frame rate ``num/den`` (e.g. 30000/1001). Documents allow the five rates of §3.1."""

    num: int
    den: int

    def __post_init__(self) -> None:
        for name in ("num", "den"):
            if _integer(getattr(self, name), f"fps {name}") <= 0:
                raise ValueError(f"fps {name} must be positive")

    @classmethod
    def from_json(cls, value: object) -> Fps:
        """Accept an ``Fps`` or a ``[num, den]`` pair as stored in documents."""
        if isinstance(value, Fps):
            return value
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise TypeError("fps must be a [num, den] pair")
        return cls(value[0], value[1])

    def to_json(self) -> list[int]:
        return [self.num, self.den]


@dataclass(frozen=True, slots=True)
class Piece:
    """A kept source range ``[in_sf, out_sf)`` placed at output frames ``[out_f0, out_f0+frames)``."""

    i: int
    seg: str
    role: str
    in_sf: int
    out_sf: int
    out_f0: int
    frames: int

    def to_dto(self) -> dict[str, Any]:
        """The plan DTO form (plan §4.3 ``pieces``)."""
        return {
            "i": self.i,
            "seg": self.seg,
            "role": self.role,
            "inSf": self.in_sf,
            "outSf": self.out_sf,
            "outF0": self.out_f0,
            "frames": self.frames,
        }


def _kept_ranges(in_sf: int, out_sf: int, cuts: list[tuple[int, int]]) -> list[tuple[int, int]]:
    kept: list[tuple[int, int]] = []
    cursor = in_sf
    for start, end in sorted(cuts):
        start, end = max(start, in_sf), min(end, out_sf)
        if start >= end:
            continue
        if start > cursor:
            kept.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < out_sf:
        kept.append((cursor, out_sf))
    return [(start, end) for start, end in kept if end - start >= MIN_PIECE_FRAMES]


def pieces(doc: Mapping) -> tuple[Piece, ...]:
    """Pieces of ``doc["main"]`` in output order (plan §3.4 "Pieces").

    For each segment in order: ``[in_sf, out_sf)`` minus the union of the removals whose ``seg``
    is that segment (clamped to it). A remaining sub-range shorter than two frames is dropped: it
    joins the adjacent cut. Removals naming another segment are ignored; the validator reports
    them. Pieces are laid out back to back from output frame 0.
    """
    main = doc["main"]
    cuts: dict[str, list[tuple[int, int]]] = {}
    for removal in main.get("removals", ()):
        start = _integer(removal["in_sf"], "removal in_sf")
        end = _integer(removal["out_sf"], "removal out_sf")
        if end <= start:
            raise ValueError("removal must satisfy in_sf < out_sf")
        cuts.setdefault(removal["seg"], []).append((start, end))
    result: list[Piece] = []
    out_f0 = 0
    for segment in main["segments"]:
        in_sf = _integer(segment["in_sf"], "segment in_sf")
        out_sf = _integer(segment["out_sf"], "segment out_sf")
        if in_sf < 0 or out_sf <= in_sf:
            raise ValueError("segment must satisfy 0 <= in_sf < out_sf")
        for start, end in _kept_ranges(in_sf, out_sf, cuts.get(segment["id"], [])):
            frames = end - start
            result.append(
                Piece(len(result), segment["id"], segment["role"], start, end, out_f0, frames)
            )
            out_f0 += frames
    return tuple(result)


def total_frames(pieces: Sequence[Piece]) -> int:
    """Output length in frames: the sum of the piece lengths."""
    return sum(piece.frames for piece in pieces)


def smp(n: int, fps: Fps, rate: int = SAMPLE_RATE) -> int:
    """First sample of output frame ``n``: ``⌊n·rate·den / num⌋`` (1601/1602 at 29.97, no drift)."""
    return _integer(n, "n") * _integer(rate, "rate") * fps.den // fps.num


def sf_floor(ms: int, fps: Fps) -> int:
    """The source-grid frame containing millisecond ``ms``: ``⌊ms·num / (1000·den)⌋``."""
    return _integer(ms, "ms") * fps.num // (1000 * fps.den)


def sf_ceil(ms: int, fps: Fps) -> int:
    """``⌈ms·num / (1000·den)⌉``: the first frame boundary at or after ``ms``."""
    return -(-_integer(ms, "ms") * fps.num // (1000 * fps.den))


def div_round_half_up(numerator: int, denominator: int) -> int:
    """``round_half_up(numerator / denominator)`` for integers (halves round toward +∞)."""
    _integer(numerator, "numerator")
    if _integer(denominator, "denominator") <= 0:
        raise ValueError("denominator must be positive")
    return (2 * numerator + denominator) // (2 * denominator)


class _Index:
    """Lookup structure for one immutable pieces tuple (runs sorted by source frame)."""

    __slots__ = ("out_starts", "pieces", "runs")

    def __init__(self, pieces: Sequence[Piece]) -> None:
        self.pieces = tuple(pieces)
        self.out_starts = [piece.out_f0 for piece in self.pieces]
        runs: list[tuple[list[int], list[Piece]]] = []
        for piece in self.pieces:
            if runs and runs[-1][1][-1].out_sf <= piece.in_sf:
                runs[-1][0].append(piece.in_sf)
                runs[-1][1].append(piece)
            else:
                runs.append(([piece.in_sf], [piece]))
        self.runs = runs


_last_index: tuple[tuple[Piece, ...], _Index] | None = None


def _index(pieces: Sequence[Piece]) -> _Index:
    # Callers typically pass the same pieces tuple for every word or frame; tuples are immutable,
    # so the identity check below is exact (the cache holds a reference, so ids are not reused).
    global _last_index
    cached = _last_index
    if cached is not None and cached[0] is pieces:
        return cached[1]
    index = _Index(pieces)
    if isinstance(pieces, tuple):
        _last_index = (pieces, index)
    return index


def out_to_src(n: int, pieces: Sequence[Piece]) -> tuple[Piece, int]:
    """The piece showing output frame ``n`` and the source-grid frame it shows."""
    index = _index(pieces)
    total = index.out_starts[-1] + index.pieces[-1].frames if index.pieces else 0
    if not 0 <= _integer(n, "n") < total:
        raise ValueError("output frame outside the clip")
    piece = index.pieces[bisect_right(index.out_starts, n) - 1]
    return piece, piece.in_sf + (n - piece.out_f0)


def word_frames(
    s_ms: int, e_ms: int, pieces: Sequence[Piece], fps: Fps
) -> tuple[int, int] | None:
    """Output frames ``[n_on, n_off)`` of a word, or None when it is not visible (plan §3.4).

    A word is visible in the first piece (in output order) of ``pieces`` whose source span
    contains its midpoint ``(s+e)/2``; pass one segment's pieces to get that segment's
    occurrence. ``n_on = out_f0 + round_half_up((s_ms − t0_ms)·num / (1000·den))`` with ``t0_ms``
    the piece's source start, ``n_off`` likewise from ``e_ms``; both are clamped to the piece and
    ``n_off >= n_on``.
    """
    if _integer(e_ms, "e_ms") < _integer(s_ms, "s_ms"):
        raise ValueError("word must satisfy s_ms <= e_ms")
    scale = 1000 * fps.den
    # Midpoint m inside [in_sf, out_sf) ⇔ in_sf ≤ m·num/scale < out_sf ⇔ the frame containing
    # m, i.e. ⌊(s+e)·num / (2·scale)⌋, lies in [in_sf, out_sf).
    mid_sf = (s_ms + e_ms) * fps.num // (2 * scale)
    for starts, run in _index(pieces).runs:
        position = bisect_right(starts, mid_sf) - 1
        if position < 0 or mid_sf >= run[position].out_sf:
            continue
        piece = run[position]
        base = piece.in_sf * scale
        last = piece.out_f0 + piece.frames
        on = piece.out_f0 + div_round_half_up(s_ms * fps.num - base, scale)
        off = piece.out_f0 + div_round_half_up(e_ms * fps.num - base, scale)
        on = min(max(on, piece.out_f0), last)
        off = max(min(max(off, piece.out_f0), last), on)
        return on, off
    return None


def speech_spans(
    words: Sequence[tuple[int, int]],
    pieces: Sequence[Piece],
    fps: Fps,
    rate: int = SAMPLE_RATE,
) -> tuple[tuple[int, int], ...]:
    """Output sample spans ``[smp(n_on), smp(n_off))`` of every kept word occurrence.

    ``words`` are ``(s_ms, e_ms)`` pairs (hidden words included: hiding only affects captions).
    Each segment is mapped separately, so a word shown in the cold open and in the body yields
    two spans. Empty spans are dropped; the result is sorted and not merged (ducking merges by
    ``hold_ms``, plan §5.6).
    """
    groups: dict[str, list[Piece]] = {}
    for piece in pieces:
        groups.setdefault(piece.seg, []).append(piece)
    spans: list[tuple[int, int]] = []
    for group in groups.values():
        scope = tuple(group)
        for s_ms, e_ms in words:
            frames = word_frames(s_ms, e_ms, scope, fps)
            if frames is not None and frames[1] > frames[0]:
                spans.append((smp(frames[0], fps, rate), smp(frames[1], fps, rate)))
    return tuple(sorted(spans))


def now_ms(n: int, fps: Fps) -> int:
    """The time libass sees for output frame ``n`` inside FFmpeg, in whole milliseconds.

    ``libavfilter/vf_subtitles.c`` computes ``double time_ms = pts * av_q2d(tb) * 1000`` and
    passes it to ``ass_render_frame(…, long long now, …)``, truncating. With the graph's
    ``settb=den/num`` the frame index is the pts, so this is ``trunc(n · (den/num) · 1000)``
    evaluated in IEEE double in exactly that order. It can be one below the exact value
    (7,328 such frames in 3 h at 30 fps); :func:`safe_cs` absorbs that.
    """
    return int(float(_integer(n, "n")) * (fps.den / fps.num) * 1000)


def safe_cs(n: int, fps: Fps) -> int:
    """Frame-safe ASS centisecond for "visible from frame n": ``(now_ms(n) − 2) // 10``.

    An event visible on output frames ``[a, b)`` is written ``Start = safe_cs(a)``,
    ``End = safe_cs(b)``. ``safe_cs(0)`` is −1; ASS writers clamp it to 0, which is still
    visible from frame 0 because ``now_ms(0) == 0``.
    """
    return (now_ms(n, fps) - 2) // 10


def cell_frames(fps: Fps) -> int:
    """Plate cell length: ``2·⌈num/den⌉`` frames (60 at 29.97 and 30, 50 at 25, 48 at 24)."""
    return 2 * -(-fps.num // fps.den)


def logo_box(
    *, x_e5: int, y_e5: int, w_e5: int, asset_w: int, asset_h: int, out_w: int, out_h: int
) -> tuple[int, int, int, int]:
    """Integer logo box ``(x0, y0, w_px, h_px)`` in output pixels (plan §3.4 "Logo box").

    ``w_px = round_half_up(w_e5·W/100000)``, ``h_px = round_half_up(w_px·asset_h/asset_w)``,
    ``x0 = round_half_up(x_e5·W/100000 − w_px/2)``, ``y0 = round_half_up(y_e5·H/100000 − h_px/2)``.
    The box may lie partly outside the frame; the validator reports ``item_out_of_frame``.
    """
    for name, value in (("asset_w", asset_w), ("asset_h", asset_h), ("out_w", out_w),
                        ("out_h", out_h)):
        if _integer(value, name) <= 0:
            raise ValueError(f"{name} must be positive")
    for name, value in (("x_e5", x_e5), ("y_e5", y_e5), ("w_e5", w_e5)):
        _integer(value, name)
    w_px = div_round_half_up(w_e5 * out_w, 100_000)
    h_px = div_round_half_up(w_px * asset_h, asset_w)
    x0 = div_round_half_up(2 * x_e5 * out_w - w_px * 100_000, 200_000)
    y0 = div_round_half_up(2 * y_e5 * out_h - h_px * 100_000, 200_000)
    return x0, y0, w_px, h_px


__all__ = [
    "MIN_PIECE_FRAMES",
    "SAMPLE_RATE",
    "Fps",
    "Piece",
    "cell_frames",
    "div_round_half_up",
    "logo_box",
    "now_ms",
    "out_to_src",
    "pieces",
    "safe_cs",
    "sf_ceil",
    "sf_floor",
    "smp",
    "speech_spans",
    "total_frames",
    "word_frames",
]
