"""Zoom and the source's content rect (CONTRACTS §5.47): the crop layouts cover the output
enlarged by ``layout.zoom_pm`` and take an output-sized crop of it; latar blur enlarges its
picture the same way; every layout sees only the source's content rect (the picture without
its black bars, ``base.source.content_rect``).

``tests/fixtures/edit_v2/zoom-vectors.json`` holds inputs with their geometry and the crop x of
manual framing keyframes; this file and ``web/tests/editor-zoom.test.mjs`` check both languages
against it, so the box the gizmo draws is the crop the render takes. ``EDIT_V2_UPDATE_VECTORS=1``
rewrites the file from the Python functions (review the diff).
"""

from __future__ import annotations

import json
import os
import random
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import KEYFRAME_MOVES, ZOOM_RANGE, layouts
from ai_clipper.edit_v2.timemap import Fps

ROOT = Path(__file__).resolve().parents[1]
VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "zoom-vectors.json"
VECTORS_SCHEMA = "potongin.zoom-vectors/1"
CONVERSION = ":in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv"
ARGS = {"label_in": "[in]", "label_out": "[out]", "suffix": "_7", "output": (720, 1280),
        "matrix": "bt709", "in_range": "tv"}


def kf(sf: int, pan: int, move: str = "cut") -> dict:
    return {"sf": sf, "pan_e5": pan, "move": move}


def camera_plan(samples, cuts=None) -> dict:
    return {"samples": [list(sample) for sample in samples],
            "cuts": cuts or [False] * len(samples), "no_face": []}


def test_the_constants():
    assert ZOOM_RANGE == (1000, 1500)
    assert layouts.ZOOM_RANGE == ZOOM_RANGE


def test_the_zoomed_output_rounds_each_side_half_up():
    assert layouts.zoomed_output((720, 1280), 1000) == (720, 1280)
    assert layouts.zoomed_output((720, 1280), 1500) == (1080, 1920)
    assert layouts.zoomed_output((720, 1280), 1100) == (792, 1408)
    assert layouts.zoomed_output((720, 1280), 1333) == (960, 1706)  # 959.76, 1706.24
    assert layouts.zoomed_output((1080, 1920), 1100) == (1188, 2112)
    for zoom in (999, 1501, 1000.0, True, None):
        with pytest.raises(ValueError):
            layouts.zoomed_output((720, 1280), zoom)


def test_zoom_widens_the_travel_and_moves_the_centre():
    assert layouts.pan_limit((1280, 720), (720, 1280), 1500) == 2692  # 3413 − 720 = 2693
    assert layouts.centre_x((1280, 720), (720, 1280), 1500) == 1346
    assert layouts.crop_y((1280, 720), (720, 1280), 1500) == 320  # (1920 − 1280) / 2
    assert layouts.crop_y((1280, 720), (720, 1280)) == 0
    # a 9:16 source has nothing to pan at zoom 1, and some travel once zoomed
    assert layouts.pan_limit((720, 1280), (720, 1280)) == 0
    assert layouts.pan_limit((720, 1280), (720, 1280), 1500) == 360
    assert layouts.centre_x((720, 1280), (720, 1280), 1500) == 180
    # the defaults are today's numbers
    for source, output in (((1280, 720), (720, 1280)), ((1920, 1080), (1080, 1920)),
                           ((640, 480), (720, 1280))):
        assert layouts.pan_limit(source, output, 1000) == layouts.pan_limit(source, output)
        assert layouts.centre_x(source, output, 1000) == layouts.centre_x(source, output)


def test_keyframes_pan_over_the_zoomed_travel():
    keyframes = [kf(0, 0), kf(10, 100_000, "slide")]
    values = layouts.keyframe_positions(keyframes, source=(1280, 720), output=(720, 1280),
                                        first_sf=0, count=11, zoom_pm=1500)
    assert values[0] == 0 and values[-1] == 2692
    assert all(value % 2 == 0 for value in values)
    assert layouts.keyframe_positions([kf(0, 50_000)], source=(1280, 720), output=(720, 1280),
                                      first_sf=0, count=1, zoom_pm=1500) == (1346,)
    plain = layouts.keyframe_positions(keyframes, source=(1280, 720), output=(720, 1280),
                                       first_sf=0, count=11)
    assert layouts.keyframe_positions(keyframes, source=(1280, 720), output=(720, 1280),
                                      first_sf=0, count=11, zoom_pm=1000) == plain


def test_the_camera_crop_follows_the_face_inside_the_content_rect():
    camera = camera_plan([(0, 500), (1000, 100)])
    fps = Fps(30, 1)
    # a 4:3 picture pillarboxed in 1920×1080: the face at the source's centre is at the content's
    # centre, 0.5 · 1707 − 360 = 493.5 → 494
    content = (240, 0, 1440, 1080)
    values = layouts.crop_positions(camera, fps, source=(1920, 1080), output=(720, 1280),
                                    first_sf=0, count=31, content=content)
    assert values[0] == 494
    assert values[-1] == 0  # 10 % of the source is inside the left bar: clamped to the edge
    # the whole frame as content is today's crop
    for zoom in (1000, 1250):
        whole = layouts.crop_positions(camera, fps, source=(1920, 1080), output=(720, 1280),
                                       first_sf=0, count=31, zoom_pm=zoom)
        assert layouts.crop_positions(camera, fps, source=(1920, 1080), output=(720, 1280),
                                      first_sf=0, count=31, zoom_pm=zoom,
                                      content=(0, 0, 1920, 1080)) == whole
    zoomed = layouts.crop_positions(camera, fps, source=(1920, 1080), output=(720, 1280),
                                    first_sf=0, count=1, zoom_pm=1500)
    # 0.5 · 3413 − 360 = 1346.5 → 1347, then to even: 1348 (the centred crop truncates: 1346)
    assert zoomed == (1348,)


def test_the_content_rect_is_checked():
    layouts.check_content_rect((0, 140, 1920, 800), (1920, 1080))
    for rect in ((1, 140, 1918, 800), (0, 139, 1920, 800), (0, 140, 1919, 800),
                 (0, 140, 1920, 801), (0, 0, 1920, 1080), (0, 140, 1920, 1000), (-2, 0, 10, 10),
                 (0, 0, 0, 1080), (0, 0, 14, 1080), (0, 0, 1920.0, 800), (0, 0, 1920)):
        with pytest.raises(ValueError):
            layouts.check_content_rect(rect, (1920, 1080))
    assert layouts.picture_size((1920, 1080), None) == (1920, 1080)
    assert layouts.picture_size((1920, 1080), (0, 140, 1920, 800)) == (1920, 800)


# --- chains ----------------------------------------------------------------------------------


def test_zoom_one_and_no_content_keep_every_chain():
    crop = (0, 2, 2, 4)
    for mode, extra in (("fit_blur", {}), ("fill_center", {}), ("camera", {"crop": crop}),
                        ("camera", {"crop": crop, "fallback": (False, True, True, False)})):
        today = layouts.layout_chain(mode, source=(1280, 720), **ARGS, **extra)
        assert layouts.layout_chain(mode, source=(1280, 720), zoom_pm=1000, content=None,
                                    **ARGS, **extra) == today
    split = layouts.default_split()
    today = layouts.split_chain(split, source=(1280, 720), **ARGS)
    assert layouts.split_chain(split, source=(1280, 720), content=None, **ARGS) == today


def test_a_zoomed_crop_layout_covers_the_zoomed_output_and_crops_the_output():
    assert layouts.layout_chain("fill_center", source=(1280, 720), zoom_pm=1500, **ARGS) == (
        f"[in]scale=1080:1920:force_original_aspect_ratio=increase{CONVERSION},format=yuv444p,"
        "crop=720:1280,setsar=1[out]")
    camera = layouts.layout_chain("camera", source=(1280, 720), zoom_pm=1250, crop=(4, 4),
                                  **ARGS)
    assert camera == (
        f"[in]scale=900:1600:force_original_aspect_ratio=increase{CONVERSION},format=yuv444p,"
        "crop=720:1280:x='4':y=(ih-oh)/2,setsar=1[out]")


def test_a_zoomed_latar_blur_enlarges_its_picture_and_crops_it_to_the_frame():
    chain = layouts.layout_chain("fit_blur", source=(1280, 720), zoom_pm=1500, **ARGS)
    assert chain == (
        "[in]split=2[background_7][foreground_7];"
        f"[background_7]scale=1080:1920:force_original_aspect_ratio=increase{CONVERSION},"
        "format=yuv444p,crop=720:1280,gblur=sigma=35[blurred_7];"
        f"[foreground_7]scale=1080:1920:force_original_aspect_ratio=decrease{CONVERSION},"
        "format=yuva444p,crop=720:608[fit_7];"
        "[blurred_7][fit_7]overlay=(W-w)/2:(H-h)/2:format=yuv444,setsar=1[out]")
    # a picture that still fits inside the frame is not cropped: 4:3 at 1.1 is 792·594 wide
    small = layouts.layout_chain("fit_blur", source=(640, 480), zoom_pm=1100, **ARGS)
    assert "format=yuva444p,crop=720:594[fit_7]" in small
    assert layouts.foreground_size((640, 480), (720, 1280), 1000) == (720, 540)
    assert layouts.foreground_size((640, 480), (720, 1280), 1100) == (792, 594)
    assert layouts.foreground_size((720, 1280), (720, 1280), 1500) == (1080, 1920)


def test_the_zoomed_fallback_frames_are_the_zoomed_latar_blur_frames():
    crop = (0, 10, 20, 30)
    fallback = (False, True, True, False)
    chain = layouts.layout_chain("camera", source=(1280, 720), zoom_pm=1500, crop=crop,
                                 fallback=fallback, **ARGS)
    fit_blur = layouts.layout_chain("fit_blur", source=(1280, 720), zoom_pm=1500, **ARGS)
    centre = layouts.centre_x((1280, 720), (720, 1280), 1500)
    x = layouts.crop_expression([0, centre, centre, 30])
    assert chain == (
        fit_blur.replace("crop=720:1280,gblur=sigma=35[",
                         f"crop=720:1280:x='{x}':y=(ih-oh)/2,gblur=sigma=35:enable="
                         "'if(lt(n,1),0,if(lt(n,3),1,0))'[")
        .replace("format=yuva444p,crop=720:608[",
                 "format=yuva444p,crop=720:608,lutyuv=a=0:enable="
                 "'if(lt(n,1),1,if(lt(n,3),0,1))'["))
    assert layouts.layout_chain("camera", source=(1280, 720), zoom_pm=1500, crop=crop[:2],
                                fallback=(True, True), **ARGS) == fit_blur


def test_every_layout_crops_the_content_rect_first():
    content = (0, 140, 1920, 800)
    for mode, extra in (("fit_blur", {}), ("fill_center", {}), ("camera", {"crop": (2, 4)}),
                        ("camera", {"crop": (2, 4), "fallback": (True, False)})):
        on_picture = layouts.layout_chain(mode, source=(1920, 800), zoom_pm=1200, **ARGS,
                                          **extra)
        framed = layouts.layout_chain(mode, source=(1920, 1080), zoom_pm=1200, content=content,
                                      **ARGS, **extra)
        assert framed == "[in]crop=1920:800:0:140," + on_picture[len("[in]"):]
    split = layouts.default_split()
    on_picture = layouts.split_chain(split, source=(1920, 800), **ARGS)
    assert layouts.split_chain(split, source=(1920, 1080), content=content, **ARGS) == (
        "[in]crop=1920:800:0:140," + on_picture[len("[in]"):])
    with pytest.raises(ValueError):
        layouts.layout_chain("fill_center", source=(1920, 1080), content=(0, 0, 1920, 1080),
                             **ARGS)


def test_the_split_has_no_zoom_of_its_own():
    with pytest.raises(ValueError):
        layouts.layout_chain("split", source=(1280, 720), zoom_pm=1200, **ARGS)


# --- the shared vectors ------------------------------------------------------------------------

SIZES = (((1280, 720), (720, 1280)), ((1920, 1080), (1080, 1920)), ((1918, 1080), (720, 1280)),
         ((640, 480), (720, 1280)), ((720, 1280), (720, 1280)), ((3840, 1600), (1080, 1920)),
         ((1080, 1920), (1080, 1920)))
ZOOMS = (1000, 1100, 1250, 1333, 1500)


def letterbox(source: tuple[int, int], content_h: int) -> list[int]:
    top = (source[1] - content_h) // 2
    return [0, top - top % 2, source[0], content_h - content_h % 2]


def pillarbox(source: tuple[int, int], content_w: int) -> list[int]:
    left = (source[0] - content_w) // 2
    return [left - left % 2, 0, content_w - content_w % 2, source[1]]


def geometry(source, content, output, zoom) -> dict:
    picture = layouts.picture_size(tuple(source), None if content is None else tuple(content))
    return {
        "picture": list(picture),
        "zoomed": list(layouts.zoomed_output(tuple(output), zoom)),
        "scaled": list(layouts.scaled_size(picture, layouts.zoomed_output(tuple(output), zoom))),
        "limit": layouts.pan_limit(picture, tuple(output), zoom),
        "centre_x": layouts.centre_x(picture, tuple(output), zoom),
        "crop_y": layouts.crop_y(picture, tuple(output), zoom),
        "foreground": list(layouts.foreground_size(picture, tuple(output), zoom)),
    }


def build_vectors() -> list[dict]:
    """Hand-picked cases, then random ones from a fixed seed (both languages read the result)."""
    cases = [
        {"name": "zoom_150_720", "source": [1280, 720], "content": None, "output": [720, 1280],
         "zoom_pm": 1500, "keyframes": [kf(10, 0), kf(20, 100_000, "slide")], "first_sf": 5,
         "count": 20},
        {"name": "portrait_zoomed", "source": [720, 1280], "content": None,
         "output": [720, 1280], "zoom_pm": 1500, "keyframes": [kf(0, 0), kf(8, 100_000, "slide")],
         "first_sf": 0, "count": 10},
        {"name": "letterbox_239", "source": [1920, 1080], "content": [0, 138, 1920, 804],
         "output": [1080, 1920], "zoom_pm": 1000, "keyframes": [kf(3, 50_000)], "first_sf": 0,
         "count": 4},
        {"name": "pillarbox_916", "source": [1920, 1080], "content": [656, 0, 608, 1080],
         "output": [720, 1280], "zoom_pm": 1200, "keyframes": [kf(0, 0), kf(4, 100_000, "slide")],
         "first_sf": 0, "count": 6},
        {"name": "pillarbox_43_zoomed", "source": [1920, 1080], "content": [240, 0, 1440, 1080],
         "output": [720, 1280], "zoom_pm": 1333,
         "keyframes": [kf(2, 12_345), kf(9, 98_765, "slide"), kf(12, 40_000, "cut")],
         "first_sf": 0, "count": 16},
    ]
    rng = random.Random(20261022)
    for index in range(24):
        source, output = SIZES[index % len(SIZES)]
        content = None
        shape = index % 3
        if shape == 1 and source[0] > source[1]:
            content = letterbox(source, rng.randint(source[1] // 2, source[1] - 40))
        elif shape == 2:
            content = pillarbox(source, rng.randint(source[0] // 3, source[0] - 40))
        zoom = rng.choice((*ZOOMS, rng.randint(*ZOOM_RANGE)))
        sf = rng.randint(0, 1500)
        keyframes = []
        for _ in range(rng.randint(1, 6)):
            keyframes.append(kf(sf, rng.choice((0, 100_000, rng.randint(0, 100_000))),
                                rng.choice(KEYFRAME_MOVES)))
            sf += rng.randint(1, 60)
        first = max(0, keyframes[0]["sf"] - rng.randint(0, 20))
        count = keyframes[-1]["sf"] - first + rng.randint(1, 20)
        cases.append({"name": f"random_{index:02d}", "source": list(source), "content": content,
                      "output": list(output), "zoom_pm": zoom, "keyframes": keyframes,
                      "first_sf": first, "count": count})
    for case in cases:
        case.update(geometry(case["source"], case["content"], case["output"], case["zoom_pm"]))
        case["positions"] = list(layouts.keyframe_positions(
            case["keyframes"], source=tuple(case["picture"]), output=tuple(case["output"]),
            first_sf=case["first_sf"], count=case["count"], zoom_pm=case["zoom_pm"]))
    return cases


def test_the_shared_vectors_are_the_python_values():
    vectors = build_vectors()
    if os.environ.get("EDIT_V2_UPDATE_VECTORS") == "1":
        VECTORS.write_text(json.dumps({
            "schema": VECTORS_SCHEMA,
            "description": ("Zoom and the content rect (CONTRACTS §5.47): the picture the "
                            "layouts see, the zoomed output, its scaled size, the crop's travel, "
                            "centre and row, latar blur's foreground, and the crop x of "
                            "layout.keyframes over source-grid frames first_sf … "
                            "first_sf+count−1 (edit_v2.layouts). Written by "
                            "tests/test_edit_v2_zoom.py; web/tests/editor-zoom.test.mjs checks "
                            "web/lib/editor/framing.mjs against it."),
            "vectors": vectors}, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    stored = json.loads(VECTORS.read_text(encoding="utf-8"))
    assert stored["schema"] == VECTORS_SCHEMA
    assert stored["vectors"] == vectors
    assert len(vectors) == 29
    assert {v["zoom_pm"] for v in vectors} >= set(ZOOMS)
    assert sum(v["content"] is not None for v in vectors) >= 10
