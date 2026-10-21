"""The logo or the text watermark over the caption (``overlay_zone``, CONTRACTS §5.51).

The logo is drawn above the caption and the watermark line next to it, both for the whole clip,
so a box that sits on the caption block hides words. The plan warns ``logo_over_caption`` and
names the nearest corner (logo) or place (watermark) that clears the block.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace

from ai_clipper import captions_ass
from ai_clipper.edit_v2 import face_zone, overlay_zone
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import Issue

OUTPUT = (720, 1280)
ASSET = "sha256:" + "ab" * 32
# Klasik at Bawah on 720×1280: x 43..677, y 929..1062 (test_edit_v2_face_zone CLASSIC_BAWAH)
CLASSIC_BAWAH = (43, 929, 634, 133)
CUES = (SimpleNamespace(f0=12, f1=40), SimpleNamespace(f0=45, f1=80))
# A 2:1 logo at 16 % of the width is 115 × 58 px; SnapLogo's corners at 720×1280 (4 % from the
# left, against the TikTok zone's 93 px top, 280 px bottom and 93 px right).
CORNER_BOXES = {
    "top_left": (29, 93, 115, 58),
    "top_right": (512, 93, 115, 58),
    "bottom_left": (29, 942, 115, 58),
    "bottom_right": (512, 942, 115, 58),
}


def doc_with(*, logo=None, watermark=None, y_e5=83000, enabled=True, pack="classic"):
    doc = {
        "output": {"w": OUTPUT[0], "h": OUTPUT[1], "fps": [25, 1]},
        "captions": {"enabled": enabled, "pack": {"id": pack, "v": 1},
                     "overrides": {"y_e5": y_e5, "size_pm": 1000}},
        "tracks": [],
        "assets": {},
    }
    if logo is not None:
        x_e5, logo_y = logo
        doc["tracks"].append({
            "id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay",
            "items": [{"id": "it_logo", "type": "image", "transform": {
                "x_e5": x_e5, "y_e5": logo_y, "w_e5": 16000, "opacity_pm": 850},
                "payload": {"asset": ASSET, "mode": "free"}}],
        })
        doc["assets"][ASSET] = {"kind": "image", "mime": "image/png", "w": 400, "h": 200}
    if watermark is not None:
        doc["watermark"] = {"text": "@akun", "pos": watermark, "size_pm": 1000,
                            "opacity_pm": 700}
    return doc


def at_corner(corner):
    """The logo's centre e5 at a SnapLogo corner."""
    x, y, w, h = CORNER_BOXES[corner]
    return (tm.div_round_half_up((2 * x + w) * 100_000, 2 * OUTPUT[0]),
            tm.div_round_half_up((2 * y + h) * 100_000, 2 * OUTPUT[1]))


def issues(doc, cues=CUES):
    return overlay_zone.logo_over_caption_issues(doc, doc["assets"], cues, OUTPUT)


def test_the_caption_block_is_the_face_check_one():
    assert face_zone.caption_box(doc_with()["captions"], OUTPUT) == CLASSIC_BAWAH


def test_snaplogo_corners_match_the_editor():
    meta = {"w": 400, "h": 200}
    for corner, box in CORNER_BOXES.items():
        assert overlay_zone.corner_box((115, 58), corner, OUTPUT) == box, corner
        x_e5, y_e5 = at_corner(corner)
        assert tm.logo_box(x_e5=x_e5, y_e5=y_e5, w_e5=16000, asset_w=meta["w"],
                           asset_h=meta["h"], out_w=OUTPUT[0], out_h=OUTPUT[1]) == box


def test_a_bottom_corner_logo_over_the_caption_is_warned_with_the_corner_that_clears_it():
    found = issues(doc_with(logo=at_corner("bottom_right")))
    # bottom_left also covers the block; top_right is the nearest that clears it
    assert found == (Issue("logo_over_caption", "/tracks/0/items/0/transform", "top_right", 12),)
    found = issues(doc_with(logo=at_corner("bottom_left")))
    assert found == (Issue("logo_over_caption", "/tracks/0/items/0/transform", "top_left", 12),)


def test_a_logo_clear_of_the_caption_is_not_warned():
    for corner in ("top_left", "top_right"):
        assert issues(doc_with(logo=at_corner(corner))) == ()
    # the caption moved to Atas: now the top corners are the problem, the bottom ones are clear
    assert issues(doc_with(logo=at_corner("bottom_right"), y_e5=38000)) == ()
    found = issues(doc_with(logo=at_corner("top_right"), y_e5=20000))
    assert [(issue.code, issue.ref) for issue in found] == [("logo_over_caption", "bottom_right")]


def test_a_graze_is_not_a_cover():
    """At least 15 % of the smaller box (the logo) must be over the block, as for the face."""
    x_e5, _y = at_corner("bottom_right")
    # the logo's bottom row 4 px into the block (929): 4·115 of 58·115 is 7 %
    grazing = tm.div_round_half_up((2 * (929 + 4 - 58) + 58) * 100_000, 2 * OUTPUT[1])
    assert issues(doc_with(logo=(x_e5, grazing))) == ()
    covering = tm.div_round_half_up((2 * (929 + 12 - 58) + 58) * 100_000, 2 * OUTPUT[1])
    assert [issue.code for issue in issues(doc_with(logo=(x_e5, covering)))] == [
        "logo_over_caption"]


def test_no_caption_shown_means_no_warning():
    doc = doc_with(logo=at_corner("bottom_right"))
    assert issues(doc, cues=()) == ()
    assert issues(doc_with(logo=at_corner("bottom_right"), enabled=False)) == ()
    assert issues(doc_with()) == ()


def test_a_logo_whose_every_corner_covers_the_caption_has_no_fix():
    doc = doc_with(logo=at_corner("bottom_right"))
    # 144 × 1100 px: from any corner it runs across the caption block
    doc["tracks"][0]["items"][0]["transform"]["w_e5"] = 20000
    doc["assets"][ASSET] = {"kind": "image", "mime": "image/png", "w": 144, "h": 1100}
    found = issues(doc)
    assert [(issue.code, issue.ref) for issue in found] == [("logo_over_caption", None)]


def test_the_watermark_box_follows_its_layout():
    spec = captions_ass.WatermarkSpec("@akun", "bottom_right", 1000, 700)
    layout = captions_ass.layout_watermark(spec, play_res=OUTPUT)
    x0, y0, x1, y1 = captions_ass.watermark_box(spec, play_res=OUTPUT)
    edge = -(-layout.outline_cp // 100)
    assert (layout.font_size, edge, layout.y) == (32, 2, 998)
    assert x1 == float(layout.x) + edge and y1 == layout.y + edge
    assert y0 == layout.y - tm.div_round_half_up(32 * 1164, 1000) - edge
    assert 60 < x1 - x0 < 140  # five glyphs of DejaVu Sans Bold at 32 px
    centre = captions_ass.watermark_box(
        captions_ass.WatermarkSpec("@akun", "middle_center", 1000, 700), play_res=OUTPUT)
    assert abs((centre[0] + centre[2]) / 2 - OUTPUT[0] / 2) < 1e-9


def test_a_watermark_over_the_caption_is_warned_with_the_place_that_clears_it():
    found = issues(doc_with(watermark="bottom_right"))
    assert found == (Issue("logo_over_caption", "/watermark/pos", "middle_right", 12),)
    found = issues(doc_with(watermark="bottom_center"))
    assert [(issue.path, issue.ref) for issue in found] == [("/watermark/pos", "middle_center")]
    # at Tengah the middle row covers the caption; the same column's top place clears it first
    found = issues(doc_with(watermark="middle_right", y_e5=60000))
    assert [(issue.path, issue.ref) for issue in found] == [("/watermark/pos", "top_right")]
    for clear in ("top_left", "top_center", "top_right", "middle_left"):
        assert issues(doc_with(watermark=clear)) == (), clear


def test_logo_and_watermark_are_one_warning_each():
    found = issues(doc_with(logo=at_corner("bottom_left"), watermark="bottom_right"))
    assert [(issue.path, issue.ref) for issue in found] == [
        ("/tracks/0/items/0/transform", "top_left"), ("/watermark/pos", "middle_right")]


def test_a_document_it_cannot_read_gives_no_warning():
    doc = doc_with(logo=at_corner("bottom_right"))
    broken = copy.deepcopy(doc)
    broken["assets"] = {}
    assert overlay_zone.logo_over_caption_issues(broken, broken["assets"], CUES, OUTPUT) == ()
    broken = copy.deepcopy(doc)
    del broken["captions"]["overrides"]
    assert issues(broken) == ()
