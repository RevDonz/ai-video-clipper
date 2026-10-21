"""Manual framing, "Atur bingkai" (CONTRACTS §5.44): the crop x of every source-grid frame from
the document's ``layout.keyframes``.

``tests/fixtures/edit_v2/framing-vectors.json`` holds inputs and the expected crop x; this file
and ``web/tests/editor-framing.test.mjs`` check both languages against it, so the gizmo's box
and the render's crop agree to the pixel. ``EDIT_V2_UPDATE_VECTORS=1`` rewrites the file from
the Python function (review the diff).
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import KEYFRAME_MOVES, MAX_KEYFRAMES, PAN_E5_MAX, layouts

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "framing-vectors.json"
VECTORS_SCHEMA = "potongin.framing-vectors/1"


def kf(sf: int, pan: int, move: str = "cut") -> dict:
    return {"sf": sf, "pan_e5": pan, "move": move}


def positions(keyframes, *, source=(1280, 720), output=(720, 1280), first_sf=0, count=100):
    return layouts.keyframe_positions(keyframes, source=source, output=output,
                                      first_sf=first_sf, count=count)


def test_the_constants():
    assert KEYFRAME_MOVES == ("cut", "slide")
    assert MAX_KEYFRAMES == 100
    assert PAN_E5_MAX == 100_000
    assert layouts.KEYFRAME_MOVES == KEYFRAME_MOVES


def test_the_travel_is_the_scaled_width_minus_the_output_width_floored_to_even():
    assert layouts.pan_limit((1280, 720), (720, 1280)) == 1556  # 2276 − 720
    assert layouts.pan_limit((1920, 1080), (1080, 1920)) == 2332  # 3413 − 1080 = 2333
    assert layouts.pan_limit((1918, 1080), (720, 1280)) == 1552  # 2273 − 720 = 1553
    assert layouts.pan_limit((720, 1280), (720, 1280)) == 0  # already 9:16: nothing to pan
    assert layouts.pan_limit((720, 1600), (720, 1280)) == 0  # taller than 9:16


def test_one_keyframe_holds_for_the_whole_clip():
    assert positions([kf(500, 0)], first_sf=0, count=4) == (0, 0, 0, 0)
    assert positions([kf(500, 100_000)], first_sf=900, count=2) == (1556, 1556)
    # pan 50 % is the centred crop of Potong tengah; crop x is even, so an odd centre (4:3 at
    # 720 wide: (1707 − 720) // 2 = 493) is one pixel off
    for source, output in (((1280, 720), (720, 1280)), ((1920, 1080), (1080, 1920)),
                           ((1918, 1080), (720, 1280)), ((640, 360), (1080, 1920))):
        assert positions([kf(0, 50_000)], source=source, output=output, count=1) == (
            layouts.centre_x(source, output),)
    assert positions([kf(0, 50_000)], source=(640, 480), count=1) == (494,)


def test_a_cut_holds_until_the_next_keyframe_and_a_slide_moves_linearly():
    keyframes = [kf(10, 0), kf(20, 100_000, "cut"), kf(30, 0, "slide")]
    values = positions(keyframes, first_sf=0, count=40)
    assert values[:20] == (0,) * 20  # before the first keyframe: held; then held to the cut
    assert values[20] == 1556  # the cut lands on its keyframe's frame
    assert values[30:] == (0,) * 10  # after the last keyframe: held
    # the slide: p = 1556 · (30 − sf) / 10, rounded once to the nearest even integer
    assert values[20:31] == (1556, 1400, 1244, 1090, 934, 778, 622, 466, 312, 156, 0)
    assert all(value % 2 == 0 for value in values)


def test_the_move_of_the_first_keyframe_changes_nothing():
    for move in KEYFRAME_MOVES:
        assert positions([kf(10, 30_000, move), kf(20, 60_000, "cut")], count=30) == positions(
            [kf(10, 30_000, "cut"), kf(20, 60_000, "cut")], count=30)


def test_a_window_of_frames_is_the_same_slice():
    keyframes = [kf(3, 12_345), kf(47, 99_000, "slide"), kf(61, 1_000, "cut"),
                 kf(90, 70_000, "slide")]
    whole = positions(keyframes, count=120)
    for first, count in ((0, 1), (5, 40), (46, 3), (60, 2), (89, 31)):
        assert positions(keyframes, first_sf=first, count=count) == whole[first:first + count]


def test_nothing_to_pan_gives_zero():
    assert positions([kf(0, 0), kf(5, 100_000, "slide")], source=(720, 1280), count=8) == (0,) * 8


def test_keyframes_are_checked():
    with pytest.raises(ValueError):
        positions([])
    with pytest.raises(ValueError):
        positions([kf(10, 0), kf(10, 5)])  # strictly increasing frames
    with pytest.raises(ValueError):
        positions([kf(10, 100_001)])
    with pytest.raises(ValueError):
        positions([kf(10, 0, "fade")])


# --- the shared vectors --------------------------------------------------------------------------

SIZES = (((1280, 720), (720, 1280)), ((1920, 1080), (1080, 1920)), ((1918, 1080), (720, 1280)),
         ((640, 480), (720, 1280)), ((640, 360), (1080, 1920)), ((3840, 1600), (1080, 1920)),
         ((720, 1280), (720, 1280)))


def build_vectors() -> list[dict]:
    """Hand-picked cases, then random ones from a fixed seed (both languages read the result)."""
    cases = [
        {"name": "centre_720", "source": [1280, 720], "output": [720, 1280],
         "keyframes": [kf(500, 50_000)], "first_sf": 480, "count": 40},
        {"name": "centre_1080", "source": [1920, 1080], "output": [1080, 1920],
         "keyframes": [kf(500, 50_000)], "first_sf": 490, "count": 20},
        {"name": "cut_then_slide", "source": [1280, 720], "output": [720, 1280],
         "keyframes": [kf(10, 0), kf(20, 100_000, "cut"), kf(30, 0, "slide")],
         "first_sf": 0, "count": 40},
        {"name": "slide_odd_span", "source": [1918, 1080], "output": [720, 1280],
         "keyframes": [kf(100, 1_234, "slide"), kf(107, 98_765, "slide")],
         "first_sf": 95, "count": 20},
        {"name": "portrait_source", "source": [720, 1280], "output": [720, 1280],
         "keyframes": [kf(0, 0), kf(5, 100_000, "slide")], "first_sf": 0, "count": 8},
    ]
    rng = random.Random(20261021)
    for index in range(24):
        source, output = SIZES[index % len(SIZES)]
        sf = rng.randint(0, 2000)
        keyframes = []
        for _ in range(rng.randint(1, 8)):
            keyframes.append(kf(sf, rng.choice((0, 100_000, rng.randint(0, 100_000))),
                                rng.choice(KEYFRAME_MOVES)))
            sf += rng.randint(1, 90)
        first = max(0, keyframes[0]["sf"] - rng.randint(0, 30))
        count = keyframes[-1]["sf"] - first + rng.randint(1, 30)
        cases.append({"name": f"random_{index:02d}", "source": list(source),
                      "output": list(output), "keyframes": keyframes, "first_sf": first,
                      "count": count})
    for case in cases:
        case["limit"] = layouts.pan_limit(tuple(case["source"]), tuple(case["output"]))
        case["positions"] = list(positions(case["keyframes"], source=tuple(case["source"]),
                                           output=tuple(case["output"]),
                                           first_sf=case["first_sf"], count=case["count"]))
    return cases


def test_the_shared_vectors_are_the_python_values():
    vectors = build_vectors()
    if os.environ.get("EDIT_V2_UPDATE_VECTORS") == "1":
        VECTORS.write_text(json.dumps({
            "schema": VECTORS_SCHEMA,
            "description": ("Manual framing (CONTRACTS §5.44): the crop x of source-grid frames "
                            "first_sf … first_sf+count−1 for layout.keyframes "
                            "(edit_v2.layouts.keyframe_positions). Written by "
                            "tests/test_edit_v2_framing.py; web/tests/editor-framing.test.mjs "
                            "checks web/lib/editor/framing.mjs against it."),
            "vectors": vectors}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    stored = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert stored["schema"] == VECTORS_SCHEMA
    assert stored["vectors"] == vectors
    assert len(vectors) == 29 and sum(v["count"] for v in vectors) > 1000
    moves = {k["move"] for v in vectors for k in v["keyframes"][1:]}
    assert moves == set(KEYFRAME_MOVES)
