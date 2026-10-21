"""Output sizes 9:16 and 1:1 at 720 and 1080 wide (CONTRACTS §5.54): the zone, the frame margins
and the text height of each size, the document, the seed, the captions, the hook, the watermark
and a real render of a 1:1 clip."""

from __future__ import annotations

import copy
import os

import pytest
from support import edit_v2_fixtures as fixtures
from support import edit_v2_media as media
from test_edit_v2_compile import run_to_file, synthetic_clip
from test_edit_v2_plan import HARNESS
from test_edit_v2_seed import _job, _logo_job, _seed

from ai_clipper import captions_ass
from ai_clipper.captions_ass import WatermarkSpec, build_ass_v2, layout_hook, layout_watermark
from ai_clipper.edit_v2 import (
    OUTPUT_SIZES,
    PACK_DEFAULT_OVERRIDES,
    frame_margins,
    portrait,
    text_height,
    ui_zone,
    verify,
)
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.compile_ffmpeg import compile_job
from ai_clipper.edit_v2.doc import validate_doc
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan, unsafe_zone_issues
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.subtitles import FrameCue, FrameWord

SQUARES = ((720, 720), (1080, 1080))
PORTRAITS = ((720, 1280), (1080, 1920))


def test_the_output_sizes_are_9_16_and_1_1_at_720_and_1080_wide():
    assert set(OUTPUT_SIZES) == {*PORTRAITS, *SQUARES}
    assert len(OUTPUT_SIZES) == 4
    assert [portrait(size) for size in OUTPUT_SIZES] == [True, True, False, False]


def test_the_tiktok_zone_scales_at_9_16_and_is_absent_at_1_1():
    assert ui_zone((720, 1280)) == (93, 280, 93)
    assert ui_zone((1080, 1920)) == (140, 420, 140)
    for size in SQUARES:
        assert ui_zone(size) == (0, 0, 0)


def test_the_frame_margins_are_the_zone_at_9_16_and_4_percent_at_1_1():
    for size in PORTRAITS:
        assert frame_margins(size) == ui_zone(size)
    assert frame_margins((720, 720)) == (29, 29, 29)  # rhu(720 · 40 / 1000) = 28.8
    assert frame_margins((1080, 1080)) == (43, 43, 43)  # 43.2


def test_text_is_sized_from_the_9_16_frame_of_the_same_width():
    assert text_height((720, 1280)) == 1280
    assert text_height((1080, 1920)) == 1920
    assert text_height((720, 720)) == 1280
    assert text_height((1080, 1080)) == 1920


# --- the document and the seed ------------------------------------------------------------------


def test_a_document_takes_a_1_1_output_and_refuses_16_9(edit_v2_doc_contexts):
    context_id = fixtures.CONTEXT_IDS[0]
    context = edit_v2_doc_contexts[context_id]
    for size, errors in ((SQUARES[0], ()), (SQUARES[1], ()), ((1920, 1080), ("/output/w",)),
                         ((720, 1080), ("/output/h",)), ((1280, 1280), ("/output/w",))):
        doc = copy.deepcopy(context.seed)
        doc["output"].update(w=size[0], h=size[1])
        found = validate_doc(doc, words=context.words, assets=context.assets, seed=None)
        assert tuple(issue.path for issue in found.errors) == errors, size


@pytest.mark.parametrize("size", SQUARES)
def test_a_1_1_job_seeds_a_1_1_document(size):
    job = _job()
    job["renderSize"] = list(size)
    seed = _seed(job=job)
    assert (seed["output"]["w"], seed["output"]["h"]) == size
    assert seed["clip_id"] == _seed()["clip_id"]  # the clip is the same moment of the video


@pytest.mark.parametrize("size", SQUARES)
def test_the_default_logo_of_a_1_1_clip_keeps_the_margin_from_the_corner(size):
    job = _logo_job()
    job["renderSize"] = list(size)
    transform = _seed(job=job)["tracks"][1]["items"][0]["transform"]
    x, y, w, h = tm.logo_box(x_e5=transform["x_e5"], y_e5=transform["y_e5"],
                             w_e5=transform["w_e5"], asset_w=512, asset_h=512,
                             out_w=size[0], out_h=size[1])
    margin = frame_margins(size)[0]
    assert (y, size[0] - (x + w)) == (margin, margin)
    assert w == h


def test_a_1_1_clip_has_no_tiktok_zone_warning():
    job = _logo_job()
    job["renderSize"] = [720, 720]
    seed = _seed(job=job)
    seed["captions"]["overrides"]["y_e5"] = 100_000  # the caption's bottom on the frame's edge
    seed["tracks"][0]["items"][0]["transform"]["y_e5"] = 0  # the hook at the very top
    # the logo in the top-right corner, touching both edges
    seed["tracks"][1]["items"][0]["transform"].update(x_e5=92_000, y_e5=8_000)
    assets = {f"sha256:{'e' * 64}": {"kind": "image", "mime": "image/png", "w": 512, "h": 512}}
    assert unsafe_zone_issues(seed, assets, (720, 720)) == ()
    assert len(unsafe_zone_issues(seed, assets, (720, 1280))) == 3


# --- captions, hook and watermark ---------------------------------------------------------------


def _cue():
    words = (FrameWord("w000000", 0, 10, "gue", False), FrameWord("w000001", 10, 25, "bukan", True),
             FrameWord("w000002", 25, 40, "jambret.", False))
    return FrameCue(0, 40, "seg_b1", words)


def _style(document, name):
    line = next(line for line in document.splitlines() if line.startswith(f"Style: {name},"))
    return line.removeprefix("Style: ").split(",")


@pytest.mark.parametrize("pack", ["classic", "karaoke", "bold", "box", "sorot", "sinar"])
@pytest.mark.parametrize("width", [720, 1080])
def test_1_1_captions_are_the_9_16_captions_of_its_width_at_their_own_spot(pack, width):
    tall, square = (width, width * 16 // 9), (width, width)
    documents = {}
    for size in (tall, square):
        documents[size] = build_ass_v2(
            (_cue(),), play_res=size, fps=Fps(30000, 1001), total_frames=60,
            pack=captions_ass.load_pack(pack, 1), overrides=dict(PACK_DEFAULT_OVERRIDES[pack]),
            hook=None)
    style_tall = _style(documents[tall], captions_ass.load_pack(pack, 1).style_name)
    style_square = _style(documents[square], captions_ass.load_pack(pack, 1).style_name)
    # Name, Fontname, Fontsize, colours, Bold … Outline, Shadow, Alignment, margins, Encoding
    assert style_square[:-2] == style_tall[:-2]
    margin_v = int(style_square[-2])
    assert margin_v == tm.div_round_half_up((100_000 - 83_000) * width, 100_000)
    assert f"PlayResY: {width}" in documents[square]


@pytest.mark.parametrize("design", [("legacy-bar", 1), ("kicker", 1), ("blok", 1), ("kotak", 1)])
def test_the_hook_of_a_1_1_clip_has_the_9_16_size_at_its_own_top(design):
    text = "Kenapa sutradara ditahan di film sendiri?"
    tall = layout_hook(text, play_res=(720, 1280), y_e5=13_000, design=design)
    square = layout_hook(text, play_res=(720, 720), y_e5=13_000, design=design)
    assert (square.font_size, square.lines, square.overflow) == (
        tall.font_size, tall.lines, tall.overflow)
    assert square.top == tm.div_round_half_up(13_000 * 720, 100_000)


def test_the_watermark_of_a_1_1_clip_sits_4_percent_inside_every_edge():
    for size in SQUARES:
        margin = frame_margins(size)[0]
        tall = layout_watermark(WatermarkSpec("@potongin", "top_right", 1000, 800),
                                play_res=(size[0], size[0] * 16 // 9))
        for pos in ("top_right", "bottom_left", "middle_center"):
            mark = layout_watermark(WatermarkSpec("@potongin", pos, 1000, 800), play_res=size)
            assert mark.font_size == tall.font_size
            edge = -(-mark.outline_cp // 100)
            if pos == "top_right":
                assert (mark.x, mark.y) == (str(size[0] - margin - edge),
                                            margin + edge + mark.font_size)
            if pos == "bottom_left":
                assert (mark.x, mark.y) == (str(margin + edge), size[1] - margin - edge)


# --- a real 1:1 render -------------------------------------------------------------------------


@pytest.fixture
def harness(monkeypatch):
    for module, name, function in HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    return HARNESS


@pytest.mark.parametrize("layout", ["fit_blur", "fill_center"])
def test_a_1_1_render_shows_the_planned_frames_at_720x720(harness, tmp_path, edit_v2_libass,
                                                          layout):
    clip = synthetic_clip(tmp_path, frames=240, cold_open=(180, 200), body=(20, 160),
                          removals=((60, 70),), layout=layout)
    doc = copy.deepcopy(clip.doc)
    doc["output"].update(w=720, h=720)
    plan = build_plan(doc, words=clip.words, camera=None, assets={},
                      resources=Resources(RESOURCES_DIR))
    assert plan.output == (720, 720)
    job = compile_job(plan, mode="final", source=clip.source, assets_root=tmp_path)
    output = tmp_path / "final.mp4"
    assert run_to_file(job, output).returncode == 0
    fd = os.open(output, os.O_RDONLY)
    try:
        report = verify.verify_output(fd, plan, size=(720, 720), normalize=False)
    finally:
        os.close(fd)
    assert report.ok, report.to_json()
    assert report.gate("G2").values["frames"] == plan.total_frames
    assert [issue.code for issue in report.warnings] == []  # no TikTok zone at 1:1
    # every frame shows the source frame the time map plans (P-FRAME at 1:1)
    pattern = media.Pattern.for_size(640, 360)
    scale, top = ((720 / 640, (720 - 360 * 720 / 640) / 2) if layout == "fit_blur"
                  else (720 / 360, 0.0))
    got = [media.decode_index(plane, 720, 720, pattern, scale=scale, top=top)
           for plane in HARNESS.iter_gray_frames(output, (720, 720))]
    expected = [clip.grid[tm.out_to_src(n, plan.pieces)[1]] for n in range(plan.total_frames)]
    assert got == expected
