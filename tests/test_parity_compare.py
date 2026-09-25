"""Unit tests for the text-parity comparison code (plan §11.1 T1.2b, ``scripts/parity/compare.py``).

SSIM/PSNR on image pairs with known answers, region masks, the PNG codec and the P-TXT and
P-COLOR helpers. The SSIM definition is FFmpeg's ``ssim`` filter (x264's 8×8 windows on a
4-pixel grid); a cross-check against FFmpeg runs when FFmpeg is installed.
"""

from __future__ import annotations

import math
import random
import re
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import compare
from compare import Box, Image


def _flat(width: int, height: int, rgb: tuple[int, int, int]) -> Image:
    return Image(width, height, 3, bytes(rgb) * (width * height))


def _noise(width: int, height: int, seed: int) -> Image:
    rng = random.Random(seed)
    return Image(width, height, 3, bytes(rng.randrange(256) for _ in range(width * height * 3)))


def _paint(image: Image, box: Box, rgb: tuple[int, int, int]) -> Image:
    data = bytearray(image.data)
    for y in range(box.y0, box.y1):
        for x in range(box.x0, box.x1):
            offset = (y * image.width + x) * 3
            data[offset:offset + 3] = bytes(rgb)
    return Image(image.width, image.height, 3, bytes(data))


def _chunk_types(png: bytes) -> list[bytes]:
    types, offset = [], 8
    while offset < len(png):
        (length,) = struct.unpack(">I", png[offset:offset + 4])
        types.append(png[offset + 4:offset + 8])
        offset += 12 + length
    return types


# --- PNG codec ----------------------------------------------------------------------------------


def test_png_round_trip_writes_only_critical_chunks() -> None:
    image = _noise(13, 7, seed=1)
    png = compare.encode_png(image)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert _chunk_types(png) == [b"IHDR", b"IDAT", b"IEND"]
    assert compare.read_png(png) == image


def test_png_reader_handles_every_filter_type_alpha_and_ancillary_chunks() -> None:
    width, height, channels = 5, 5, 4
    rng = random.Random(7)
    rows = [bytes(rng.randrange(256) for _ in range(width * channels)) for _ in range(height)]

    def filtered(kind: int, row: bytes, prior: bytes) -> bytes:
        out = bytearray()
        for i, value in enumerate(row):
            left = row[i - channels] if i >= channels else 0
            up = prior[i]
            upper_left = prior[i - channels] if i >= channels else 0
            if kind == 0:
                predictor = 0
            elif kind == 1:
                predictor = left
            elif kind == 2:
                predictor = up
            elif kind == 3:
                predictor = (left + up) // 2
            else:
                p = left + up - upper_left
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upper_left)
                predictor = left if pa <= pb and pa <= pc else up if pb <= pc else upper_left
            out.append((value - predictor) & 0xFF)
        return bytes([kind]) + bytes(out)

    raw, prior = b"", bytes(width * channels)
    for index, row in enumerate(rows):
        raw += filtered(index % 5, row, prior)
        prior = row

    def chunk(kind: bytes, payload: bytes) -> bytes:
        crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
           + chunk(b"gAMA", struct.pack(">I", 45455)) + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    image = compare.read_png(png)
    assert (image.width, image.height, image.channels) == (5, 5, 4)
    assert image.data == b"".join(rows)
    assert image.rgb().channels == 3


def test_png_reader_rejects_what_it_cannot_decode() -> None:
    header = b"\x89PNG\r\n\x1a\n"

    def ihdr(depth: int, color: int, interlace: int) -> bytes:
        payload = struct.pack(">IIBBBBB", 1, 1, depth, color, 0, 0, interlace)
        return struct.pack(">I", 13) + b"IHDR" + payload + struct.pack(">I", zlib.crc32(b"IHDR" + payload))

    for depth, color, interlace in ((16, 2, 0), (8, 2, 1), (8, 3, 0)):
        with pytest.raises(ValueError):
            compare.read_png(header + ihdr(depth, color, interlace))
    with pytest.raises(ValueError):
        compare.read_png(b"not a png")


# --- SSIM and PSNR ------------------------------------------------------------------------------


def test_ssim_of_identical_images_is_one_and_psnr_is_infinite() -> None:
    image = _noise(32, 24, seed=2)
    assert compare.ssim(image, image) == 1.0
    assert compare.psnr(image, image) == math.inf


def test_ssim_of_flat_images_matches_the_closed_form() -> None:
    v, d = 100, 10
    a, b = _flat(64, 48, (v, v, v)), _flat(64, 48, (v + d, v + d, v + d))
    c1 = int(0.01 * 0.01 * 255 * 255 * 64 + 0.5)
    expected = (2 * 4096 * v * (v + d) + c1) / (4096 * (v * v + (v + d) ** 2) + c1)
    assert compare.ssim(a, b) == pytest.approx(expected, abs=1e-12)


def test_psnr_of_a_constant_offset_matches_the_closed_form() -> None:
    a, b = _flat(16, 16, (40, 50, 60)), _flat(16, 16, (44, 54, 64))
    assert compare.psnr(a, b) == pytest.approx(10 * math.log10(255 ** 2 / 16), abs=1e-9)


def test_ssim_counts_windows_like_ffmpeg() -> None:
    # (W/4 − 1)·(H/4 − 1) windows per plane; a 12×8 image has 2×1 windows.
    assert compare.ssim_window_grid(12, 8) == (2, 1)
    assert compare.ssim_window_grid(720, 1280) == (179, 319)
    assert compare.ssim_window_grid(7, 7) == (0, 0)
    assert compare.ssim(_flat(7, 7, (1, 2, 3)), _flat(7, 7, (9, 9, 9))) == 1.0


def test_region_ssim_only_uses_windows_overlapping_the_region() -> None:
    base = _noise(64, 64, seed=3)
    changed = _paint(base, Box(20, 20, 30, 28), (255, 0, 0))
    region = [Box(16, 16, 36, 32)]
    whole = compare.ssim(base, changed)
    local = compare.ssim(base, changed, region=region)
    assert local < whole < 1.0
    # Windows outside the changed pixels are identical (SSIM 1), so the whole-frame value is the
    # region value diluted by the untouched windows.
    total = 15 * 15
    inside = len(compare.region_windows(64, 64, region))
    assert whole == pytest.approx(1 - (1 - local) * inside / total, abs=1e-12)
    # A region far from the change sees identical pixels.
    assert compare.ssim(base, changed, region=[Box(48, 48, 64, 64)]) == 1.0


def test_region_windows_are_the_grid_windows_that_touch_any_box() -> None:
    windows = compare.region_windows(40, 40, [Box(0, 0, 1, 1)])
    assert windows == {(0, 0)}
    windows = compare.region_windows(40, 40, [Box(8, 8, 9, 9), Box(8, 8, 9, 9)])
    # Pixel (8, 8) lies in the 8×8 windows starting at x, y ∈ {4, 8} (grid indices 1 and 2).
    assert windows == {(1, 1), (1, 2), (2, 1), (2, 2)}


@pytest.mark.parametrize("seed", [4, 5])
def test_ssim_and_psnr_agree_with_ffmpeg(tmp_path: Path, edit_v2_ffmpeg: str, seed: int) -> None:
    a = _noise(48, 40, seed=seed)
    rng = random.Random(seed + 100)
    b = Image(48, 40, 3, bytes(min(255, max(0, value + rng.randrange(-20, 21))) for value in a.data))
    compare.write_png(tmp_path / "a.png", a)
    compare.write_png(tmp_path / "b.png", b)
    result = subprocess.run(
        [edit_v2_ffmpeg, "-hide_banner", "-nostdin", "-i", str(tmp_path / "a.png"), "-i",
         str(tmp_path / "b.png"), "-lavfi",
         ("[0:v]format=gbrp[x];[1:v]format=gbrp[y];[x][y]ssim;[0:v]format=gbrp[p];"
          "[1:v]format=gbrp[q];[p][q]psnr"), "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    ssim_all = float(re.search(r"SSIM .*All:([0-9.]+)", result.stderr).group(1))
    psnr_avg = float(re.search(r"PSNR .*average:([0-9.]+)", result.stderr).group(1))
    assert compare.ssim(a, b) == pytest.approx(ssim_all, abs=2e-6)
    assert compare.psnr(a, b) == pytest.approx(psnr_avg, abs=0.01)


# --- pixel statistics and masks -----------------------------------------------------------------


def test_diff_stats_count_pixels_over_the_threshold() -> None:
    a = _flat(10, 10, (50, 50, 50))
    b = _paint(a, Box(0, 0, 2, 1), (67, 50, 50))  # 2 px off by 17 in one channel
    b = _paint(b, Box(5, 5, 6, 6), (66, 66, 66))  # 1 px off by exactly 16
    stats = compare.diff_stats(a, b)
    assert stats["max"] == 17
    assert stats["px_over_16"] == 2
    assert stats["px_differing"] == 3
    assert compare.diff_stats(a, a) == {"max": 0, "px_over_16": 0, "px_differing": 0}


def test_diff_bbox_is_the_half_open_box_of_differing_pixels() -> None:
    a = _flat(20, 10, (1, 1, 1))
    assert compare.diff_bbox(a, a) is None
    b = _paint(a, Box(3, 4, 5, 6), (9, 9, 9))
    b = _paint(b, Box(12, 2, 13, 3), (9, 9, 9))
    assert compare.diff_bbox(a, b) == Box(3, 2, 13, 6)


def test_crop_and_paste_are_inverse_on_the_box() -> None:
    image = _noise(30, 20, seed=9)
    box = Box(4, 5, 17, 11)
    crop = image.crop(box)
    assert (crop.width, crop.height) == (13, 6)
    assert compare.paste(_flat(30, 20, (0, 0, 0)), crop, box.x0, box.y0).crop(box) == crop


def test_p_txt_metrics_and_thresholds() -> None:
    reference = _noise(64, 64, seed=11)
    same = compare.p_txt_metrics(reference, reference, text_region=Box(8, 8, 40, 40))
    assert same == {"ssim": 1.0, "ssim_text": 1.0, "psnr": math.inf, "max": 0, "px_over_16": 0,
                    "px_differing": 0}
    assert compare.p_txt_pass(same)
    off = _paint(reference, Box(10, 10, 11, 11), (0, 0, 0))
    metrics = compare.p_txt_metrics(reference, off, text_region=Box(8, 8, 40, 40))
    assert metrics["px_differing"] == 1
    assert not compare.p_txt_pass({**same, "max": 17, "px_over_16": 1})
    assert not compare.p_txt_pass({**same, "ssim": 0.9989})
    assert not compare.p_txt_pass({**same, "psnr": 44.9})
    assert compare.P_TXT_THRESHOLDS == {"ssim": 0.999, "psnr": 45.0, "max": 16, "px_over_16": 0}


def test_interior_mask_erodes_a_solid_fill() -> None:
    color = (255, 225, 77)
    image = _paint(_flat(30, 30, (0, 0, 0)), Box(5, 5, 25, 20), color)
    image = _paint(image, Box(4, 5, 5, 20), (128, 112, 38))  # an anti-aliased edge column
    mask = compare.interior_mask(image, color, radius=2)
    assert len(mask) == (20 - 4) * (15 - 4)
    assert (7, 7) in mask and (6, 7) not in mask and (22, 17) in mask and (23, 17) not in mask
    assert compare.mean_rgb(image, mask) == (255.0, 225.0, 77.0)


def test_color_delta_reports_channel_mean_differences() -> None:
    color = (82, 199, 255)
    preview = _paint(_flat(20, 20, (0, 0, 0)), Box(2, 2, 18, 18), color)
    delivered = _paint(_flat(20, 20, (0, 0, 0)), Box(2, 2, 18, 18), (80, 203, 250))
    mask = compare.interior_mask(preview, color, radius=1)
    delta = compare.color_delta(preview, delivered, mask)
    assert delta["pixels"] == len(mask)
    assert delta["mean_delta"] == [-2.0, 4.0, -5.0]
    assert delta["max_abs_mean_delta"] == 5.0
    assert not compare.p_color_pass(delta)
    assert compare.p_color_pass({**delta, "max_abs_mean_delta": 4.0})
