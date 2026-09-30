"""Tests for the logo gates tool (plan §11.3 T3.2, ``scripts/parity/logo_gates.py``).

The tool writes the zone vectors the browser gizmo is checked against, sweeps G5 through the
compiler, writes synthetic logos in the form uploads are stored, and scores P-LOGO. The media
steps run FFmpeg in the toolchain image; what is tested here needs no FFmpeg.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import compare
import logo_gates as lg

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.plan import ui_zone


def test_the_committed_vectors_are_the_compilers_current_answers():
    assert lg.VECTORS.read_text(encoding="utf-8") == "\n".join(lg.vector_lines()) + "\n", (
        "run: PYTHONPATH=src:tests python scripts/parity/logo_gates.py vectors --write")


def test_the_zone_written_from_the_plan_text_is_plan_ui_zone():
    for output in ((720, 1280), (1080, 1920), (720, 720), (1920, 1080)):
        assert lg.independent_zone(output) == ui_zone(output)
    assert lg.independent_zone((720, 1280)) == (93, 280, 93)


def test_a_box_start_gives_back_exactly_that_box():
    for w_e5 in (4000, 16000, 27777, 40000):
        _x, _y, width, height = tm.logo_box(x_e5=50_000, y_e5=50_000, w_e5=w_e5, asset_w=640, asset_h=360,
                                            out_w=720, out_h=1280)
        for start in range(0, 720 - width + 1, 7):
            x_e5 = lg.centre_e5(start, width, 720)
            assert tm.logo_box(x_e5=x_e5, y_e5=50_000, w_e5=w_e5, asset_w=640, asset_h=360,
                               out_w=720, out_h=1280)[0] == start
        for start in range(0, 1280 - height + 1, 11):
            y_e5 = lg.centre_e5(start, height, 1280)
            assert tm.logo_box(x_e5=50_000, y_e5=y_e5, w_e5=w_e5, asset_w=640, asset_h=360,
                               out_w=720, out_h=1280)[1] == start


def test_g5_through_the_compiler_on_a_small_sweep():
    result = lg.g5_sweep(per_edge=1)
    assert result["mismatches"] == 0, result["mismatch_detail"]
    assert result["unsafe_cases"] > 20 and result["safe_cases"] > 20
    assert result["pass"] is True


def _chunks(data: bytes) -> list[bytes]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    kinds, offset = [], 8
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kinds.append(data[offset + 4:offset + 8])
        offset += 12 + length
    return kinds


def test_synthetic_logos_are_rgba_pngs_with_only_the_chunks_uploads_keep(tmp_path):
    data = lg.synthetic_logo(120, 60, hue=1)
    assert _chunks(data) == [b"IHDR", b"IDAT", b"IEND"]
    image = compare.read_png(data)
    assert (image.width, image.height, image.channels) == (120, 60, 4)
    alphas = {image.row(y)[x * 4 + 3] for y in range(60) for x in range(120)}
    assert 0 in alphas and 255 in alphas and any(0 < alpha < 255 for alpha in alphas)
    # The outer band is black and white blocks at full alpha on every edge.
    for x, y in ((0, 0), (119, 0), (0, 59), (119, 59), (60, 0), (0, 30)):
        pixel = image.row(y)[x * 4:x * 4 + 4]
        assert pixel[3] == 255 and tuple(pixel[:3]) in {(0, 0, 0), (255, 255, 255)}
    job = tmp_path / "job"
    assert lg.main(["assets", "--job-dir", str(job)]) == 0
    stored = sorted((job / "analysis" / "assets").iterdir())
    assert len(stored) == 2 * len(lg.LOGOS)
    for path in stored:
        if path.suffix == ".png":
            assert hashlib.sha256(path.read_bytes()).hexdigest() == path.stem
            meta = json.loads(path.with_suffix(".json").read_text())
            assert meta["kind"] == "image" and meta["mime"] == "image/png"


def _image(width: int, height: int, pixel) -> compare.Image:
    data = bytes(channel for y in range(height) for x in range(width) for channel in pixel(x, y))
    return compare.image_from_rgb(width, height, data)


def test_alignment_finds_the_shift_of_the_logo():
    def scene(dx: int):
        def pixel(x: int, y: int):
            inside = 20 + dx <= x < 44 + dx and 30 <= y < 50
            return (230, (x * 7) % 256, 40) if inside else (60, 60, 60)
        return pixel

    box = {"x": 20, "y": 30, "w": 24, "h": 20}
    same = lg.alignment(_image(80, 80, scene(0)), _image(80, 80, scene(0)), box)
    assert same["best"] == [0, 0] and same["aligned"] and same["sad_zero"] == 0
    shifted = lg.alignment(_image(80, 80, scene(0)), _image(80, 80, scene(2)), box)
    assert shifted["best"] == [2, 0] and not shifted["aligned"]


def test_the_box_found_by_difference_and_the_levels():
    base = _image(40, 40, lambda x, y: (10, 10, 10))
    drawn = _image(40, 40, lambda x, y: (200, 10, 10) if 5 <= x < 15 and 8 <= y < 20 else (10, 10, 10))
    assert lg.detect_box(drawn, base, {"x": 5, "y": 8, "w": 10, "h": 12}) == [5, 8, 15, 20]
    levels = lg.box_levels(drawn, base, {"x": 5, "y": 8, "w": 10, "h": 12})
    assert levels["max"] == 190 and abs(levels["mean_abs"] - 190 / 3) < 1e-9
