#!/usr/bin/env python3
"""Image comparison for the text parity gates (plan §10.1 P-TXT and P-COLOR; §11.1 T1.2b).

Stdlib only, so it runs unchanged on the host and in the reference image.

* **PNG** read (8-bit gray/RGB/RGBA, every filter type, ancillary chunks ignored) and write
  (IHDR, IDAT and IEND only: no gamma or colour chunks that a browser would act on).
* **SSIM** exactly as FFmpeg's ``ssim`` filter computes it (x264's 8×8 windows on a 4-pixel grid,
  per channel, averaged over the channels), optionally restricted to the windows that touch a
  set of boxes. Windows whose pixels are identical have SSIM 1 exactly, so only windows near a
  difference are evaluated.
* **PSNR**, maximum channel difference, pixels off by more than 16 levels, difference boxes,
  interior masks of solid fills and their mean colour (P-COLOR).

CLI::

    compare.py pair A.png B.png [--region x0,y0,x1,y1]
    compare.py p-txt --fixtures DIR --browser DIR --out OUT.json [--formats gbrp,...]

``p-txt`` reads the manifest written by ``reference_text.py`` and the composites written by the
Playwright spec (``web/e2e/parity-text.spec.mjs``), and scores every probe frame of every P-TXT
clip against the FFmpeg reference of each candidate format.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from operator import mul, sub
from pathlib import Path

P_TXT_THRESHOLDS = {"ssim": 0.999, "psnr": 45.0, "max": 16, "px_over_16": 0}
P_COLOR_MAX_DELTA = 4.0
_SSIM_C1 = int(0.01 * 0.01 * 255 * 255 * 64 + 0.5)
_SSIM_C2 = int(0.03 * 0.03 * 255 * 255 * 64 * 63 + 0.5)
_SQUARES = [value * value for value in range(256)]
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_CHANNELS = {0: 1, 2: 3, 6: 4}


# --- geometry -----------------------------------------------------------------------------------


@dataclass(frozen=True, order=True)
class Box:
    """Half-open pixel box ``[x0, x1) × [y0, y1)``."""

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0

    @property
    def area(self) -> int:
        return max(0, self.width) * max(0, self.height)

    def contains(self, other: Box) -> bool:
        return (self.x0 <= other.x0 and self.y0 <= other.y0 and other.x1 <= self.x1
                and other.y1 <= self.y1)

    def union(self, other: Box | None) -> Box:
        if other is None:
            return self
        return Box(min(self.x0, other.x0), min(self.y0, other.y0), max(self.x1, other.x1),
                   max(self.y1, other.y1))

    def pad(self, amount: int, width: int, height: int) -> Box:
        return Box(max(0, self.x0 - amount), max(0, self.y0 - amount),
                   min(width, self.x1 + amount), min(height, self.y1 + amount))

    def to_list(self) -> list[int]:
        return [self.x0, self.y0, self.x1, self.y1]


# --- images and PNG -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Image:
    """8-bit image, row-major, interleaved channels, no row padding."""

    width: int
    height: int
    channels: int
    data: bytes

    def __post_init__(self) -> None:
        if len(self.data) != self.width * self.height * self.channels:
            raise ValueError("image data does not match its size")

    def rgb(self) -> Image:
        if self.channels == 3:
            return self
        if self.channels == 4:
            data = bytearray(self.width * self.height * 3)
            for channel in range(3):
                data[channel::3] = self.data[channel::4]
            return Image(self.width, self.height, 3, bytes(data))
        data = bytearray(self.width * self.height * 3)
        for channel in range(3):
            data[channel::3] = self.data
        return Image(self.width, self.height, 3, bytes(data))

    def row(self, y: int) -> bytes:
        stride = self.width * self.channels
        return self.data[y * stride:(y + 1) * stride]

    def crop(self, box: Box) -> Image:
        if box.x0 < 0 or box.y0 < 0 or box.x1 > self.width or box.y1 > self.height:
            raise ValueError("crop box outside the image")
        c = self.channels
        rows = [self.row(y)[box.x0 * c:box.x1 * c] for y in range(box.y0, box.y1)]
        return Image(box.width, box.height, c, b"".join(rows))


def paste(target: Image, patch: Image, x: int, y: int) -> Image:
    """``target`` with ``patch`` copied in at ``(x, y)`` (same channel count, fully inside)."""
    if patch.channels != target.channels:
        raise ValueError("channel counts differ")
    if x < 0 or y < 0 or x + patch.width > target.width or y + patch.height > target.height:
        raise ValueError("patch outside the target")
    data = bytearray(target.data)
    c = target.channels
    stride = target.width * c
    for row in range(patch.height):
        start = (y + row) * stride + x * c
        data[start:start + patch.width * c] = patch.row(row)
    return Image(target.width, target.height, c, bytes(data))


def _paeth(left: int, up: int, upper_left: int) -> int:
    p = left + up - upper_left
    pa, pb, pc = abs(p - left), abs(p - up), abs(p - upper_left)
    if pa <= pb and pa <= pc:
        return left
    return up if pb <= pc else upper_left


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytes:
    stride = width * bpp
    out = bytearray(stride * height)
    prior = bytearray(stride)
    offset = 0
    for y in range(height):
        kind = raw[offset]
        line = bytearray(raw[offset + 1:offset + 1 + stride])
        offset += 1 + stride
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            line = bytearray(map(lambda a, b: (a + b) & 0xFF, line, prior))
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prior[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                upper_left = prior[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prior[i], upper_left)) & 0xFF
        elif kind != 0:
            raise ValueError(f"unknown PNG filter type {kind}")
        out[y * stride:(y + 1) * stride] = line
        prior = line
    return bytes(out)


def read_png(source: Path | str | bytes) -> Image:
    """Decode an 8-bit, non-interlaced gray, RGB or RGBA PNG."""
    blob = source if isinstance(source, bytes) else Path(source).read_bytes()
    if blob[:8] != _PNG_SIGNATURE:
        raise ValueError("not a PNG file")
    offset, header, idat = 8, None, []
    while offset + 8 <= len(blob):
        (length,) = struct.unpack(">I", blob[offset:offset + 4])
        kind = blob[offset + 4:offset + 8]
        payload = blob[offset + 8:offset + 8 + length]
        offset += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        elif kind == b"IDAT":
            idat.append(payload)
        elif kind == b"IEND":
            break
    if header is None:
        raise ValueError("PNG without IHDR")
    width, height, depth, color, _compression, _filter, interlace = header
    if depth != 8 or color not in _PNG_CHANNELS or interlace != 0:
        raise ValueError(f"unsupported PNG (depth {depth}, colour type {color}, "
                         f"interlace {interlace})")
    channels = _PNG_CHANNELS[color]
    raw = zlib.decompress(b"".join(idat))
    if len(raw) != height * (1 + width * channels):
        raise ValueError("truncated PNG data")
    return Image(width, height, channels, _unfilter(raw, width, height, channels))


def _chunk(kind: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)


def encode_png(image: Image) -> bytes:
    """PNG with IHDR, IDAT and IEND only (filter 0, zlib level 6)."""
    color = {1: 0, 3: 2, 4: 6}[image.channels]
    stride = image.width * image.channels
    raw = b"".join(b"\0" + image.data[y * stride:(y + 1) * stride] for y in range(image.height))
    header = struct.pack(">IIBBBBB", image.width, image.height, 8, color, 0, 0, 0)
    return (_PNG_SIGNATURE + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(raw, 6))
            + _chunk(b"IEND", b""))


def write_png(path: Path | str, image: Image) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encode_png(image))


def image_from_rgb(width: int, height: int, data: bytes) -> Image:
    return Image(width, height, 3, bytes(data))


# --- differences --------------------------------------------------------------------------------


def _check_pair(a: Image, b: Image) -> None:
    if (a.width, a.height, a.channels) != (b.width, b.height, b.channels):
        raise ValueError(f"image shapes differ: {a.width}x{a.height}x{a.channels} vs "
                         f"{b.width}x{b.height}x{b.channels}")


def _first_difference(x: bytes, y: bytes) -> int:
    low, high = 0, len(x)
    while low < high:  # the first index where the prefixes stop matching
        middle = (low + high) // 2
        if x[low:middle + 1] == y[low:middle + 1]:
            low = middle + 1
        else:
            high = middle
    return low


def diff_bbox(a: Image, b: Image) -> Box | None:
    """Smallest box containing every pixel where ``a`` and ``b`` differ, or ``None``."""
    _check_pair(a, b)
    c = a.channels
    box: Box | None = None
    for y in range(a.height):
        row_a, row_b = a.row(y), b.row(y)
        if row_a == row_b:
            continue
        first = _first_difference(row_a, row_b) // c
        last = len(row_a) - 1 - _first_difference(row_a[::-1], row_b[::-1])
        line = Box(first, y, last // c + 1, y + 1)
        box = line if box is None else box.union(line)
    return box


def diff_stats(a: Image, b: Image, *, region: Box | None = None) -> dict[str, int]:
    """Max channel difference and pixel counts (any channel) differing / off by more than 16."""
    _check_pair(a, b)
    box = diff_bbox(a, b)
    if box is None:
        return {"max": 0, "px_over_16": 0, "px_differing": 0}
    if region is not None:
        box = Box(max(box.x0, region.x0), max(box.y0, region.y0), min(box.x1, region.x1),
                  min(box.y1, region.y1))
        if box.width <= 0 or box.height <= 0:
            return {"max": 0, "px_over_16": 0, "px_differing": 0}
    c = a.channels
    worst = over = differing = 0
    for y in range(box.y0, box.y1):
        row_a = a.row(y)[box.x0 * c:box.x1 * c]
        row_b = b.row(y)[box.x0 * c:box.x1 * c]
        if row_a == row_b:
            continue
        delta = list(map(abs, map(sub, row_a, row_b)))
        per_pixel = list(map(max, *(delta[k::c] for k in range(c)))) if c > 1 else delta
        worst = max(worst, max(per_pixel))
        over += sum(1 for value in per_pixel if value > 16)
        differing += sum(1 for value in per_pixel if value)
    return {"max": worst, "px_over_16": over, "px_differing": differing}


def psnr(a: Image, b: Image, *, region: Box | None = None) -> float:
    """PSNR over all channels of ``region`` (default: the whole image); ``inf`` when equal."""
    _check_pair(a, b)
    area = region or Box(0, 0, a.width, a.height)
    samples = area.area * a.channels
    box = diff_bbox(a, b)
    if box is None or samples == 0:
        return math.inf
    c = a.channels
    x0, x1 = max(box.x0, area.x0), min(box.x1, area.x1)
    total = 0
    for y in range(max(box.y0, area.y0), min(box.y1, area.y1)):
        row_a = a.row(y)[x0 * c:x1 * c]
        row_b = b.row(y)[x0 * c:x1 * c]
        if row_a != row_b:
            total += sum(d * d for d in map(sub, row_a, row_b))
    if total == 0:
        return math.inf
    return 10 * math.log10(255 * 255 * samples / total)


# --- SSIM (FFmpeg vf_ssim / x264) ---------------------------------------------------------------


def ssim_window_grid(width: int, height: int) -> tuple[int, int]:
    """Number of 8×8 windows per row and column on the 4-pixel grid: ``W/4 − 1``, ``H/4 − 1``."""
    columns, rows = width // 4 - 1, height // 4 - 1
    if columns < 1 or rows < 1:
        return 0, 0
    return columns, rows


def region_windows(width: int, height: int, boxes: Iterable[Box]) -> set[tuple[int, int]]:
    """Grid indices ``(i, j)`` of the windows ``[4i, 4i+8) × [4j, 4j+8)`` touching any box."""
    columns, rows = ssim_window_grid(width, height)
    windows: set[tuple[int, int]] = set()
    for box in boxes:
        if box.width <= 0 or box.height <= 0:
            continue
        i0, i1 = max(0, (box.x0 - 7 + 3) // 4), min(columns - 1, (box.x1 - 1) // 4)
        j0, j1 = max(0, (box.y0 - 7 + 3) // 4), min(rows - 1, (box.y1 - 1) // 4)
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                windows.add((i, j))
    return windows


def _block_sums(a: Image, b: Image, channel: int, block_row: int, i0: int, i1: int
                ) -> list[tuple[int, int, int, int]]:
    """``(s1, s2, ss, s12)`` of the 4×4 blocks ``i0..i1`` (inclusive) in one block row."""
    c = a.channels
    x0, x1 = 4 * i0, 4 * (i1 + 1)
    width = x1 - x0
    s1 = [0] * width
    s2 = [0] * width
    ss = [0] * width
    s12 = [0] * width
    for y in range(4 * block_row, 4 * block_row + 4):
        row_a = a.row(y)[x0 * c + channel:x1 * c:c]
        row_b = b.row(y)[x0 * c + channel:x1 * c:c]
        s1 = list(map(int.__add__, s1, row_a))
        s2 = list(map(int.__add__, s2, row_b))
        squares = map(int.__add__, map(_SQUARES.__getitem__, row_a),
                      map(_SQUARES.__getitem__, row_b))
        ss = list(map(int.__add__, ss, squares))
        s12 = list(map(int.__add__, s12, map(mul, row_a, row_b)))
    blocks = []
    for k in range(0, width, 4):
        blocks.append((sum(s1[k:k + 4]), sum(s2[k:k + 4]), sum(ss[k:k + 4]), sum(s12[k:k + 4])))
    return blocks


def _ssim_end(s1: int, s2: int, ss: int, s12: int) -> float:
    variance = ss * 64 - s1 * s1 - s2 * s2
    covariance = s12 * 64 - s1 * s2
    return ((2 * s1 * s2 + _SSIM_C1) * (2 * covariance + _SSIM_C2)
            / ((s1 * s1 + s2 * s2 + _SSIM_C1) * (variance + _SSIM_C2)))


def _window_ssim(a: Image, b: Image, windows: set[tuple[int, int]]) -> dict[tuple[int, int], float]:
    """Mean-over-channels SSIM of the given windows (grid indices)."""
    by_row: dict[int, list[int]] = {}
    for i, j in windows:
        by_row.setdefault(j, []).append(i)
    result: dict[tuple[int, int], float] = {}
    for j, columns in by_row.items():
        i0, i1 = min(columns), max(columns) + 1
        totals = dict.fromkeys(columns, 0.0)
        for channel in range(a.channels):
            top = _block_sums(a, b, channel, j, i0, i1)
            bottom = _block_sums(a, b, channel, j + 1, i0, i1)
            for i in columns:
                k = i - i0
                parts = [top[k], top[k + 1], bottom[k], bottom[k + 1]]
                totals[i] += _ssim_end(*(sum(p[n] for p in parts) for n in range(4)))
        for i in columns:
            result[(i, j)] = totals[i] / a.channels
    return result


def ssim(a: Image, b: Image, *, region: Sequence[Box] | None = None) -> float:
    """FFmpeg-equivalent SSIM (mean over channels), over the windows touching ``region``."""
    _check_pair(a, b)
    columns, rows = ssim_window_grid(a.width, a.height)
    if columns == 0:
        return 1.0
    if region is None:
        candidates = None
        count = columns * rows
    else:
        candidates = region_windows(a.width, a.height, region)
        count = len(candidates)
        if count == 0:
            return 1.0
    box = diff_bbox(a, b)
    if box is None:
        return 1.0
    touched = region_windows(a.width, a.height, [box])
    evaluate = touched if candidates is None else touched & candidates
    values = _window_ssim(a, b, evaluate)
    # Windows without a differing pixel inside the difference box can still be identical.
    return (sum(values.values()) + (count - len(values))) / count


# --- gates --------------------------------------------------------------------------------------


def p_txt_metrics(reference: Image, test: Image, *, text_region: Box) -> dict[str, float | int]:
    """Whole-frame SSIM and PSNR, text-region SSIM and the pixel statistics of one frame."""
    stats = diff_stats(reference, test)
    return {
        "ssim": ssim(reference, test),
        "ssim_text": ssim(reference, test, region=[text_region]),
        "psnr": psnr(reference, test),
        "max": stats["max"],
        "px_over_16": stats["px_over_16"],
        "px_differing": stats["px_differing"],
    }


def p_txt_pass(metrics: dict[str, float | int]) -> bool:
    return (metrics["ssim"] >= P_TXT_THRESHOLDS["ssim"]
            and metrics["psnr"] >= P_TXT_THRESHOLDS["psnr"]
            and metrics["max"] <= P_TXT_THRESHOLDS["max"]
            and metrics["px_over_16"] <= P_TXT_THRESHOLDS["px_over_16"])


def interior_mask(image: Image, color: Sequence[int], radius: int) -> set[tuple[int, int]]:
    """Pixels of exactly ``color`` whose whole ``(2r+1)²`` neighbourhood is that colour too."""
    c = image.channels
    target = bytes(color[:c])
    exact: list[list[bool]] = []
    for y in range(image.height):
        row = image.row(y)
        exact.append([row[x * c:x * c + c] == target for x in range(image.width)])
    # Separable erosion: horizontal runs, then vertical runs.
    horizontal = [[False] * image.width for _ in range(image.height)]
    for y in range(image.height):
        line = exact[y]
        for x in range(radius, image.width - radius):
            horizontal[y][x] = all(line[x - radius:x + radius + 1])
    mask: set[tuple[int, int]] = set()
    for y in range(radius, image.height - radius):
        for x in range(radius, image.width - radius):
            if all(horizontal[yy][x] for yy in range(y - radius, y + radius + 1)):
                mask.add((x, y))
    return mask


def mean_rgb(image: Image, mask: Iterable[tuple[int, int]]) -> tuple[float, ...]:
    c = image.channels
    totals = [0] * c
    count = 0
    for x, y in mask:
        offset = (y * image.width + x) * c
        for k in range(c):
            totals[k] += image.data[offset + k]
        count += 1
    if count == 0:
        raise ValueError("empty mask")
    return tuple(total / count for total in totals)


def color_delta(preview: Image, delivered: Image, mask: set[tuple[int, int]]) -> dict:
    """Mean channel difference ``delivered − preview`` over ``mask`` (P-COLOR)."""
    _check_pair(preview, delivered)
    expected = mean_rgb(preview, mask)
    actual = mean_rgb(delivered, mask)
    deltas = [round(b - a, 3) for a, b in zip(expected, actual, strict=True)]
    c = preview.channels
    worst = 0
    for x, y in mask:
        offset = (y * preview.width + x) * c
        worst = max(worst, max(abs(delivered.data[offset + k] - preview.data[offset + k])
                               for k in range(c)))
    return {
        "pixels": len(mask),
        "preview_mean": [round(v, 3) for v in expected],
        "delivered_mean": [round(v, 3) for v in actual],
        "mean_delta": deltas,
        "max_abs_mean_delta": max(abs(d) for d in deltas),
        "max_abs_pixel_delta": worst,
    }


def p_color_pass(delta: dict) -> bool:
    return delta["max_abs_mean_delta"] <= P_COLOR_MAX_DELTA


# --- manifest-driven P-TXT ----------------------------------------------------------------------


def load_manifest(fixtures: Path) -> dict:
    return json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))


def browser_composite(browser: Path, clip: dict, fmt: str, frame: int, size: tuple[int, int],
                      background: Image) -> Image:
    """The full-frame browser composite: the plate with the browser's text-region crop pasted in.

    The spec checks that the browser composite equals the plate outside the region (it records
    any leak), so the full frame is exactly reconstructed from the crop.
    """
    crop = read_png(browser / "composite" / clip["id"] / fmt / f"{frame}.png").rgb()
    region = Box(*clip["text_region"])
    if (crop.width, crop.height) != (region.width, region.height):
        raise ValueError(f"{clip['id']} {fmt} {frame}: crop is {crop.width}x{crop.height}, "
                         f"region is {region.width}x{region.height}")
    if (background.width, background.height) != size:
        raise ValueError("background size differs from the manifest size")
    return paste(background, crop, region.x0, region.y0)


def score_p_txt(fixtures: Path, browser: Path, formats: Sequence[str] | None = None) -> dict:
    manifest = load_manifest(fixtures)
    size = tuple(manifest["size"])
    wanted = list(formats or manifest["formats"])
    result: dict = {"schema": "potongin.p-txt/1", "thresholds": P_TXT_THRESHOLDS, "formats": {}}
    for fmt in wanted:
        clips: dict = {}
        failures: list[dict] = []
        worst = {"ssim": 1.0, "ssim_text": 1.0, "psnr": math.inf, "max": 0, "px_over_16": 0}
        frames_scored = 0
        for clip in manifest["clips"]:
            if clip["kind"] not in ("ptxt", "pcolor"):
                continue
            per_frame = {}
            for frame in clip["probe_frames"]:
                reference = read_png(fixtures / clip["files"]["ref"][fmt][str(frame)]).rgb()
                background = read_png(fixtures / clip["files"]["bg"][fmt][str(frame)]).rgb()
                test = browser_composite(browser, clip, fmt, frame, size, background)
                metrics = p_txt_metrics(reference, test, text_region=Box(*clip["text_region"]))
                per_frame[str(frame)] = metrics
                frames_scored += 1
                gated = clip.get("gate", True)
                if gated:
                    worst["ssim"] = min(worst["ssim"], metrics["ssim"])
                    worst["ssim_text"] = min(worst["ssim_text"], metrics["ssim_text"])
                    worst["psnr"] = min(worst["psnr"], metrics["psnr"])
                    worst["max"] = max(worst["max"], metrics["max"])
                    worst["px_over_16"] = max(worst["px_over_16"], metrics["px_over_16"])
                    if not p_txt_pass(metrics):
                        failures.append({"clip": clip["id"], "frame": frame, **metrics})
            clips[clip["id"]] = {
                "pack": clip["pack"], "variant": clip.get("variant"), "gate": clip.get("gate", True),
                "pass": all(p_txt_pass(m) for m in per_frame.values()), "frames": per_frame,
            }
        result["formats"][fmt] = {
            "frames_scored": frames_scored,
            "worst_gated": worst,
            "gate": {"pass": not failures, "failures": failures},
            "clips": clips,
        }
    return result


def _json_default(value: object) -> object:
    if isinstance(value, float) and math.isinf(value):
        return "inf"
    raise TypeError(f"not JSON serialisable: {value!r}")


def _finite(value: object) -> object:
    if isinstance(value, float) and math.isinf(value):
        return "inf"
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_finite(item) for item in value]
    return value


def dump_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_finite(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _parse_box(text: str) -> Box:
    parts = [int(part) for part in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("box is x0,y0,x1,y1")
    return Box(*parts)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub_parsers = parser.add_subparsers(dest="command", required=True)
    pair = sub_parsers.add_parser("pair", help="compare two PNG files")
    pair.add_argument("a", type=Path)
    pair.add_argument("b", type=Path)
    pair.add_argument("--region", type=_parse_box)
    ptxt = sub_parsers.add_parser("p-txt", help="score the browser composites (P-TXT)")
    ptxt.add_argument("--fixtures", type=Path, required=True)
    ptxt.add_argument("--browser", type=Path, required=True)
    ptxt.add_argument("--out", type=Path, required=True)
    ptxt.add_argument("--formats", help="comma-separated subset of the manifest formats")
    args = parser.parse_args(argv)
    if args.command == "pair":
        a, b = read_png(args.a).rgb(), read_png(args.b).rgb()
        region = args.region or Box(0, 0, a.width, a.height)
        print(json.dumps(_finite(p_txt_metrics(a, b, text_region=region)), indent=2))
        return 0
    formats = args.formats.split(",") if args.formats else None
    result = score_p_txt(args.fixtures, args.browser, formats)
    dump_json(args.out, result)
    for fmt, entry in result["formats"].items():
        worst = entry["worst_gated"]
        print(f"P-TXT {fmt}: pass={entry['gate']['pass']} frames={entry['frames_scored']} "
              f"min_ssim={worst['ssim']:.6f} min_ssim_text={worst['ssim_text']:.6f} "
              f"min_psnr={worst['psnr']} max={worst['max']} px>16={worst['px_over_16']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
