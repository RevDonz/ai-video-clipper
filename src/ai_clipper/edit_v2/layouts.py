"""Layout filter builders shared by ``plate_cells`` and ``final`` (plan §5.2 R3–R4).

The chains start from ``render.py``'s filter strings, imported and not modified
(``render._layout_filter``: fit-blur and center-crop), and only add the Essentials rules:

* **R3.** The layout ``scale`` names its colour conversion explicitly
  (``in_color_matrix=<probe, or bt709 for ≥ 720p, bt601 below>``, ``out_color_matrix=bt709``,
  ``out_range=tv``) and converts to ``yuv444p`` itself, so no implicit conversion happens and
  both ``overlay`` inputs of fit-blur are 4:4:4 (no even-pixel truncation, R3 bug 3).
* **R4.** ``fit_blur`` blurs with ``σ = 35·H/1280`` (today's look at 720×1280, the same relative
  blur at other sizes). ``fill_center`` is today's centred crop. ``camera`` crops with an x
  expression of the branch's integer frame counter ``n`` (source-grid frame ``first_sf + n``),
  whose values come from :func:`crop_positions`: the interpolation of
  ``face_tracking.build_crop_expression`` evaluated exactly at every source-grid frame, rounded
  once to an even integer. A plate cell and a final piece therefore crop any source frame at
  the same x, whatever their first frame.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from itertools import pairwise
from pathlib import Path

from ..render import _layout_filter
from .timemap import Fps, div_round_half_up

# layout.default.mode values (plan §3.3): fit-blur, face-track, center-crop.
LAYOUT_MODES = ("fit_blur", "camera", "fill_center")

WORKING_FORMAT = "yuv444p"  # every layout branch leaves in 4:4:4, BT.709, tv range
OVERLAY_FORMAT = "yuva444p"  # the fit-blur foreground: overlay's yuv444 mode needs alpha
OUTPUT_MATRIX = "bt709"
BLUR_SIGMA_AT_1280 = 35

_LEGACY_MODE = {"fit_blur": "fit-blur", "camera": "center-crop", "fill_center": "center-crop"}
_PROBE_MATRIX = {
    "bt709": "bt709",
    "bt470bg": "bt601",
    "smpte170m": "bt601",
    "fcc": "fcc",
    "smpte240m": "smpte240m",
    "bt2020nc": "bt2020",
    "bt2020c": "bt2020",
}


def color_matrix(color_space: str | None, height: int) -> str:
    """The source YCbCr matrix for ``scale``: the probed ``color_space`` when it names one,
    otherwise BT.709 for sources at least 720 lines high and BT.601 below (plan §5.2 R3)."""
    if color_space in _PROBE_MATRIX:
        return _PROBE_MATRIX[color_space]
    return "bt709" if height >= 720 else "bt601"


def _decimal(numerator: int, denominator: int) -> str:
    """Exact decimal of a non-negative fraction, at most 6 places (rounded half up)."""
    micro = div_round_half_up(numerator * 1_000_000, denominator)
    whole, fraction = divmod(micro, 1_000_000)
    return str(whole) if not fraction else f"{whole}.{fraction:06d}".rstrip("0")


def blur_sigma(out_h: int) -> str:
    """``σ = 35·H/1280`` for ``gblur``: ``35`` at 1280, ``52.5`` at 1920."""
    return _decimal(BLUR_SIGMA_AT_1280 * out_h, 1280)


def scaled_size(source: tuple[int, int], output: tuple[int, int]) -> tuple[int, int]:
    """The size FFmpeg's ``scale=W:H:force_original_aspect_ratio=increase`` produces.

    ``ff_scale_adjust_dimensions``: ``w = max(av_rescale(H, in_w, in_h), W)`` and likewise for
    ``h``; ``av_rescale`` rounds to nearest, halves away from zero.
    """
    (src_w, src_h), (out_w, out_h) = source, output
    width = (out_h * src_w + src_h // 2) // src_h
    height = (out_w * src_h + src_w // 2) // src_w
    return max(width, out_w), max(height, out_h)


def crop_positions(
    camera: Mapping,
    fps: Fps,
    *,
    source: tuple[int, int],
    output: tuple[int, int],
    first_sf: int,
    count: int,
) -> tuple[int, ...]:
    """Even crop x (in the scaled source) for source-grid frames ``first_sf … first_sf+count−1``.

    The camera plan (``potongin.camera-plan/1``) holds ``samples [[t_ms, center_pm], …]`` in
    source time and ``cuts`` parallel to them. Like ``face_tracking.build_crop_expression``:
    a sample's position is ``clamp(round(center·scaled_w − W/2), 0, scaled_w − W)``, the crop
    moves linearly between samples and holds when the next sample is a cut or at the same
    position; before the first sample it holds the first position (the float expression would
    extrapolate) and after the last it holds the last. The time of frame ``k`` is its start,
    ``k·den/num`` s, evaluated as an exact rational, and the result is rounded once to the
    nearest even integer.
    """
    samples = camera["samples"]
    cuts = camera["cuts"]
    if not samples or len(cuts) != len(samples):
        raise ValueError("camera plan needs samples with one cut flag each")
    scaled_w = scaled_size(source, output)[0]
    out_w = output[0]
    limit = max(scaled_w - out_w, 0)
    limit -= limit % 2
    positions = [
        min(max(div_round_half_up(2 * center * scaled_w - 1000 * out_w, 2000), 0), limit)
        for _t_ms, center in samples
    ]
    times = [t_ms for t_ms, _center in samples]
    if any(later <= earlier for earlier, later in pairwise(times)):
        raise ValueError("camera samples must be strictly increasing in time")
    # Compare sample times with frame starts without division: t_ms·num vs k·1000·den.
    scaled_times = [t_ms * fps.num for t_ms in times]
    scale = 1000 * fps.den
    values = []
    for sf in range(first_sf, first_sf + count):
        now = sf * scale  # frame start in ms, times num
        index = bisect_right(scaled_times, now) - 1
        if index < 0:
            numerator, denominator = positions[0], 1
        elif index == len(positions) - 1 or cuts[index + 1] or (
            positions[index] == positions[index + 1]
        ):
            numerator, denominator = positions[index], 1
        else:
            # x = p0 + (p1 − p0)·offset/span with offset and span in ms·num.
            denominator = scaled_times[index + 1] - scaled_times[index]
            offset = now - scaled_times[index]
            numerator = (positions[index] * denominator
                         + (positions[index + 1] - positions[index]) * offset)
        value = 2 * div_round_half_up(numerator, 2 * denominator)  # the one rounding: to even
        values.append(min(max(value, 0), limit))
    return tuple(values)


def crop_expression(values: Sequence[int]) -> str:
    """A crop ``x`` expression of the frame counter ``n`` returning ``values[n]``.

    Runs of equal values become the leaves of a balanced ``if(lt(n,K),A,B)`` tree, so the
    expression depth grows with log2 of the number of runs, not with the clip length. Every
    number is an integer, so the double evaluation in FFmpeg is exact.
    """
    if not values:
        raise ValueError("a crop expression needs at least one value")
    runs: list[tuple[int, int]] = []
    for n, value in enumerate(values):
        if not runs or runs[-1][1] != value:
            runs.append((n, value))

    def tree(lo: int, hi: int) -> str:
        if hi - lo == 1:
            return str(runs[lo][1])
        mid = (lo + hi) // 2
        return f"if(lt(n,{runs[mid][0]}),{tree(lo, mid)},{tree(mid, hi)})"

    return tree(0, len(runs))


def _replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"render.py layout string changed: expected one {old!r}")
    return text.replace(old, new)


def layout_chain(
    mode: str,
    *,
    label_in: str,
    label_out: str,
    suffix: str,
    output: tuple[int, int],
    source: tuple[int, int],
    matrix: str,
    in_range: str,
    crop: Sequence[int] | None = None,
) -> str:
    """The layout chain of one branch, from ``label_in`` to ``label_out`` (yuv444p, BT.709, tv,
    SAR 1). ``crop`` holds the camera crop x per frame of the branch (``camera`` only).

    ``suffix`` keeps the internal labels of fit-blur unique (``[background<suffix>]`` …).
    """
    if mode not in LAYOUT_MODES:
        raise ValueError(f"unknown layout mode: {mode}")
    if in_range not in ("tv", "pc"):
        raise ValueError("in_range must be tv or pc")
    width, height = output
    legacy = _layout_filter(Path(), input_label=label_in, start=0.0, end=0.0, width=width,
                            height=height, render_mode=_LEGACY_MODE[mode], label_suffix=suffix)
    conversion = (f"in_color_matrix={matrix}:in_range={in_range}:"
                  f"out_color_matrix={OUTPUT_MATRIX}:out_range=tv,format=")
    chain = _replace_once(legacy, "force_original_aspect_ratio=increase,",
                          f"force_original_aspect_ratio=increase:{conversion}{WORKING_FORMAT},")
    if mode == "fit_blur":
        # overlay=format=yuv444 takes its second input only as yuva444p: the foreground gets an
        # (opaque) alpha plane here, explicitly, instead of an auto-inserted scale (R3).
        chain = _replace_once(chain, "force_original_aspect_ratio=decrease[",
                              f"force_original_aspect_ratio=decrease:{conversion}"
                              f"{OVERLAY_FORMAT}[")
        chain = _replace_once(chain, "gblur=sigma=35[", f"gblur=sigma={blur_sigma(height)}[")
        chain = _replace_once(chain, "overlay=(W-w)/2:(H-h)/2,",
                              "overlay=(W-w)/2:(H-h)/2:format=yuv444,")
    elif mode == "camera":
        if not crop:
            raise ValueError("the camera layout needs crop positions")
        chain = _replace_once(chain, f"crop={width}:{height},",
                              f"crop={width}:{height}:x='{crop_expression(crop)}':y=(ih-oh)/2,")
    elif crop is not None:
        raise ValueError("only the camera layout takes crop positions")
    return chain + label_out


__all__ = [
    "LAYOUT_MODES",
    "blur_sigma",
    "color_matrix",
    "crop_expression",
    "crop_positions",
    "layout_chain",
    "scaled_size",
]
