"""Layar terbagi (CONTRACTS §5.45): two stacked bands of the 9:16 output, each a crop of the
source, with a 1 px black line between them.

``tests/fixtures/edit_v2/split-vectors.json`` holds inputs with their bands and crops; this file
and ``web/tests/editor-split.test.mjs`` check both languages against it, so the boxes the gizmo
draws are the crops the render takes. ``EDIT_V2_UPDATE_VECTORS=1`` rewrites the file from the
Python functions (review the diff).
"""

from __future__ import annotations

import copy
import json
import os
import random
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import PAN_E5_MAX, SPLIT_BANDS, SPLIT_TOP_PM, SPLIT_ZOOM_RANGE, layouts

E5_MAX = PAN_E5_MAX  # x_e5 and y_e5 run 0 (left or top edge) … 100000 (right or bottom edge)

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "split-vectors.json"
VECTORS_SCHEMA = "potongin.split-vectors/1"


def crop(x: int = 50_000, y: int = 50_000, zoom: int = 1000) -> dict:
    return {"x_e5": x, "y_e5": y, "zoom_pm": zoom}


def split(top_pm: int = 300, top: dict | None = None, bottom: dict | None = None) -> dict:
    return {"top_pm": top_pm, "top": top or crop(), "bottom": bottom or crop()}


def test_the_constants():
    assert SPLIT_TOP_PM == (300, 500, 700)
    assert SPLIT_ZOOM_RANGE == (1000, 5000)
    assert SPLIT_BANDS == ("top", "bottom")
    assert layouts.LAYOUT_MODES == ("fit_blur", "camera", "fill_center", "split")
    assert "split" not in layouts.CROP_MODES  # manual framing keyframes are not the split's
    assert layouts.default_split() == split()
    assert layouts.default_split() is not layouts.default_split()  # a fresh value each time


def test_the_bands_share_the_rows_above_and_below_the_line():
    # 30 % of the 1919 rows besides the line: 575.7 → 576 rows on top (0–575), the line on row
    # 576, 1343 rows below; swapped (700) is the mirror image
    assert layouts.split_bands((1080, 1920), 300) == ((1080, 576), (1080, 1343))
    assert layouts.split_bands((1080, 1920), 700) == ((1080, 1343), (1080, 576))
    assert layouts.split_bands((1080, 1920), 500) == ((1080, 960), (1080, 959))
    assert layouts.split_bands((720, 1280), 300) == ((720, 384), (720, 895))
    assert layouts.split_bands((720, 1280), 700) == ((720, 895), (720, 384))
    assert layouts.split_bands((720, 1280), 500) == ((720, 640), (720, 639))
    for output in ((720, 1280), (1080, 1920)):
        for top_pm in SPLIT_TOP_PM:
            (_, top), (_, bottom) = layouts.split_bands(output, top_pm)
            assert top + 1 + bottom == output[1]
    with pytest.raises(ValueError):
        layouts.split_bands((720, 1280), 400)


def test_zoom_one_is_the_largest_band_shaped_box_and_the_centre():
    # a band wider than 16:9 (1080×576 = 1.875) takes the whole width of a 16:9 source
    assert layouts.split_crop((1920, 1080), (1080, 576), crop()) == (0, 28, 1920, 1024)
    # a band taller than 16:9 takes the whole height: 1080·1080/1343 = 868.5 → 868 (even)
    assert layouts.split_crop((1920, 1080), (1080, 1343), crop()) == (526, 0, 868, 1080)
    assert layouts.split_crop((1280, 720), (720, 384), crop()) == (0, 20, 1280, 682)
    assert layouts.split_crop((1280, 720), (720, 895), crop()) == (350, 0, 580, 720)
    # a 9:16 source: the bands are wider, so the whole width
    assert layouts.split_crop((720, 1280), (720, 640), crop()) == (0, 320, 720, 640)


def test_zoom_divides_the_box_and_the_position_runs_edge_to_edge():
    assert layouts.split_crop((1920, 1080), (1080, 576), crop(zoom=2000)) == (480, 284, 960, 512)
    assert layouts.split_crop((1920, 1080), (1080, 576), crop(0, 0, 2000)) == (0, 0, 960, 512)
    assert layouts.split_crop((1920, 1080), (1080, 576), crop(E5_MAX, E5_MAX, 2000)) == (
        960, 568, 960, 512)
    assert layouts.split_crop((1920, 1080), (1080, 576), crop(zoom=5000)) == (768, 438, 384, 204)
    # odd travel: the end stays even and inside the source
    x, y, w, h = layouts.split_crop((1918, 1078), (720, 384), crop(E5_MAX, E5_MAX, 3000))
    assert (w, h) == (640, 340) and x + w <= 1918 and y + h <= 1078
    assert x % 2 == y % 2 == w % 2 == h % 2 == 0


def test_every_crop_is_even_inside_the_source_and_close_to_the_band_shape():
    rng = random.Random(5)
    for _ in range(400):
        source = (rng.randrange(16, 4000, 2), rng.randrange(16, 4000, 2))
        output = rng.choice(((720, 1280), (1080, 1920)))
        band = layouts.split_bands(output, rng.choice(SPLIT_TOP_PM))[rng.randrange(2)]
        value = crop(rng.randint(0, E5_MAX), rng.randint(0, E5_MAX),
                     rng.randint(*SPLIT_ZOOM_RANGE))
        x, y, w, h = layouts.split_crop(source, band, value)
        assert all(v % 2 == 0 for v in (x, y, w, h))
        assert 0 <= x and x + w <= source[0] and 0 <= y and y + h <= source[1]
        assert w >= 2 and h >= 2
        # the even rounding moves each side by at most one pixel from the band's shape
        assert abs(w * band[1] - h * band[0]) <= band[0] + band[1]


def test_the_geometry_names_each_band_its_rows_and_crop():
    geometry = layouts.split_geometry(split(), source=(1920, 1080), output=(1080, 1920))
    assert geometry == {
        "line": 576,
        "top": {"y": 0, "size": (1080, 576), "crop": (0, 28, 1920, 1024)},
        "bottom": {"y": 577, "size": (1080, 1343), "crop": (526, 0, 868, 1080)},
    }


def test_the_split_is_checked():
    layouts.check_split(split())
    for bad in (
        {**split(), "top_pm": 400},
        {**split(), "top_pm": "300"},
        {**split(), "extra": 1},
        {"top_pm": 300, "top": crop()},
        split(top=crop(zoom=999)),
        split(top=crop(zoom=5001)),
        split(bottom=crop(x=-1)),
        split(bottom=crop(y=E5_MAX + 1)),
        split(top={**crop(), "w_e5": 1}),
        split(top={"x_e5": 0, "y_e5": 0}),
        split(top=crop(x=True)),
    ):
        with pytest.raises((ValueError, TypeError)):
            layouts.check_split(bad)
    with pytest.raises(TypeError):
        layouts.check_split([300])


def test_the_lane_form_round_trips():
    value = split(700, crop(1, 2, 3000), crop(99_999, 0, 1000))
    lane = layouts.split_lane(value)
    assert lane == [700, [1, 2, 3000], [99_999, 0, 1000]]
    assert layouts.split_from_lane(lane) == value
    with pytest.raises((ValueError, TypeError)):
        layouts.split_from_lane([700, [1, 2, 3000]])
    with pytest.raises((ValueError, TypeError)):
        layouts.split_from_lane([700, [1, 2, 3000], [1, 2]])


def test_the_chain_crops_scales_and_stacks_with_the_line():
    chain = layouts.split_chain(split(), label_in="[vcat]", label_out="[vlay]", suffix="_0",
                                output=(1080, 1920), source=(1920, 1080), matrix="bt709",
                                in_range="tv")
    conversion = "in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv"
    assert chain == (
        "[vcat]split=2[split_top_0][split_bottom_0];"
        f"[split_top_0]crop=1920:1024:0:28,scale=1080:576:{conversion},format=yuv444p,"
        "pad=1080:577:0:0:black[split_a_0];"
        f"[split_bottom_0]crop=868:1080:526:0,scale=1080:1343:{conversion},format=yuv444p"
        "[split_b_0];"
        "[split_a_0][split_b_0]vstack=inputs=2,setsar=1[vlay]")
    swapped = copy.deepcopy(split())
    swapped["top_pm"] = 700
    other = layouts.split_chain(swapped, label_in="[pt1]", label_out="[pl1]", suffix="_1",
                                output=(720, 1280), source=(1280, 720), matrix="bt601",
                                in_range="pc")
    assert "pad=720:896:0:0:black[split_a_1]" in other
    assert "scale=720:384:in_color_matrix=bt601:in_range=pc:" in other
    with pytest.raises(ValueError):
        layouts.split_chain(split(400), label_in="[a]", label_out="[b]", suffix="",
                            output=(720, 1280), source=(1280, 720), matrix="bt709",
                            in_range="tv")


# --- the shared vectors --------------------------------------------------------------------------

SIZES = (((1920, 1080), (1080, 1920)), ((1280, 720), (720, 1280)), ((1918, 1078), (720, 1280)),
         ((640, 480), (720, 1280)), ((640, 360), (1080, 1920)), ((3840, 1600), (1080, 1920)),
         ((720, 1280), (720, 1280)), ((1080, 1920), (1080, 1920)))


def build_vectors() -> list[dict]:
    """Hand-picked cases, then random ones from a fixed seed (both languages read the result)."""
    cases = [
        {"name": "default_1080", "source": [1920, 1080], "output": [1080, 1920],
         "split": split()},
        {"name": "default_720_swapped", "source": [1280, 720], "output": [720, 1280],
         "split": split(700)},
        {"name": "half_corners", "source": [1920, 1080], "output": [1080, 1920],
         "split": split(500, crop(0, 0, 2500), crop(E5_MAX, E5_MAX, 5000))},
        {"name": "odd_travel", "source": [1918, 1078], "output": [720, 1280],
         "split": split(300, crop(E5_MAX, E5_MAX, 3000), crop(33_333, 66_667, 1234))},
        {"name": "portrait_source", "source": [720, 1280], "output": [720, 1280],
         "split": split(500, crop(0, E5_MAX), crop(E5_MAX, 0, 2000))},
    ]
    rng = random.Random(20261021)
    for index in range(27):
        source, output = SIZES[index % len(SIZES)]

        def pick() -> dict:
            return crop(rng.choice((0, E5_MAX, rng.randint(0, E5_MAX))),
                        rng.choice((0, E5_MAX, rng.randint(0, E5_MAX))),
                        rng.choice((1000, 5000, rng.randint(*SPLIT_ZOOM_RANGE))))

        cases.append({"name": f"random_{index:02d}", "source": list(source),
                      "output": list(output),
                      "split": split(rng.choice(SPLIT_TOP_PM), pick(), pick())})
    for case in cases:
        geometry = layouts.split_geometry(case["split"], source=tuple(case["source"]),
                                          output=tuple(case["output"]))
        case["line"] = geometry["line"]
        for band in SPLIT_BANDS:
            case[band] = {"y": geometry[band]["y"], "size": list(geometry[band]["size"]),
                          "crop": list(geometry[band]["crop"])}
    return cases


def test_the_shared_vectors_are_the_python_values():
    vectors = build_vectors()
    if os.environ.get("EDIT_V2_UPDATE_VECTORS") == "1":
        VECTORS.write_text(json.dumps({
            "schema": VECTORS_SCHEMA,
            "description": ("Layar terbagi (CONTRACTS §5.45): the line row, each band's rows and "
                            "its crop [x, y, w, h] of the source for layout.split "
                            "(edit_v2.layouts.split_geometry). Written by "
                            "tests/test_edit_v2_split.py; web/tests/editor-split.test.mjs checks "
                            "web/lib/editor/split.mjs against it."),
            "vectors": vectors}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    stored = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert stored["schema"] == VECTORS_SCHEMA
    assert stored["vectors"] == vectors
    assert len(vectors) == 32
    assert {v["split"]["top_pm"] for v in vectors} == set(SPLIT_TOP_PM)
