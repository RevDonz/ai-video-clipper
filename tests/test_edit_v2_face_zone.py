"""The caption over the speaker's face (``face_zone``, CONTRACTS §5.50).

The camera plan's ``faces`` (the framed face per sample, per mille of the source frame) is mapped
through the clip's layout into the 9:16 output and compared with the caption block. Fake face
boxes only: the geometry is the subject, not the detector.
"""

from __future__ import annotations

import copy
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from ai_clipper.edit_v2 import CAPTION_PRESETS, PACK_IDS, face_zone, layouts
from ai_clipper.edit_v2.doc import Issue
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = (720, 1280)
FPS = Fps(25, 1)
SOURCE = (1280, 720)
# the caption block of Klasik at Bawah on 720×1280 (caption-geometry.mjs captionBox):
# font rhu(1280·12/288) = 53, pitch rhu(53·1.164) = 62, outline rhu(1280/150) = 9,
# bottom 1280 − rhu(0.17·1280) = 1062, top 1062 − 2·62 − 9 = 929, sides rhu(720·0.06) = 43
CLASSIC_BAWAH = (43, 929, 634, 133)

LOW = [450, 600, 100, 300]  # a face low in the frame: rows 0.6–0.9
HIGH = [450, 100, 100, 250]  # a face where faces usually are: rows 0.1–0.35


def doc_with(*, y_e5=83000, mode="fill_center", pack="classic", enabled=True, size_pm=1000,
             keyframes=None, split=None, no_face="center"):
    layout = {"default": {"mode": mode, "no_face": no_face}}
    if keyframes is not None:
        layout["keyframes"] = keyframes
    if split is not None:
        layout["split"] = split
    return {
        "output": {"w": OUTPUT[0], "h": OUTPUT[1], "fps": [FPS.num, FPS.den]},
        "captions": {"enabled": enabled, "pack": {"id": pack, "v": 1},
                     "overrides": {"y_e5": y_e5, "size_pm": size_pm}},
        "layout": layout,
    }


def face_plan(faces, *, centre_pm=500, start_ms=0):
    """A camera plan with one sample per 750 ms from ``start_ms``, ``faces`` per sample."""
    times = [start_ms + 750 * index for index in range(len(faces))]
    return {
        "schema": "potongin.camera-plan/1",
        "window_ms": [start_ms, times[-1] + 750],
        "fps": [FPS.num, FPS.den],
        "source": {"w": SOURCE[0], "h": SOURCE[1]},
        "output": {"w": OUTPUT[0], "h": OUTPUT[1]},
        "sample_ms": 750,
        "samples": [[t, centre_pm] for t in times],
        "cuts": [False] * len(faces),
        "no_face": [],
        "faces": faces,
    }


def whole(plan):
    """One piece over the plan's window, and one cue over all of it."""
    a, b = plan["window_ms"]
    first, last = a * FPS.num // (1000 * FPS.den), b * FPS.num // (1000 * FPS.den)
    pieces = (Piece(0, "seg_b1", "body", first, last, 0, last - first),)
    return pieces, (SimpleNamespace(f0=0, f1=last - first),)


def issues(doc, plan, pieces=None, cues=None):
    if pieces is None or cues is None:
        whole_pieces, whole_cues = whole(plan)
        pieces = whole_pieces if pieces is None else pieces
        cues = whole_cues if cues is None else cues
    return face_zone.caption_over_face_issues(doc, plan, pieces, cues, OUTPUT)


# --- the caption block -----------------------------------------------------------------------------


def test_the_caption_block_is_the_editors_estimate():
    assert face_zone.caption_box(doc_with()["captions"], OUTPUT) == CLASSIC_BAWAH
    tengah = face_zone.caption_box(doc_with(y_e5=60000)["captions"], OUTPUT)
    assert tengah == (43, 768 - 133, 634, 133)
    # Box: one line (max_width_pm) of Montserrat, 1.2·53 = 64 px, pitch rhu(64·1.219) = 78,
    # outline rhu(1280/100) = 13
    box = face_zone.caption_box(doc_with(pack="box")["captions"], OUTPUT)
    assert box[1] + box[3] == 1062 and box[3] == 78 + 13


def test_the_pack_metrics_match_the_caption_gizmo():
    """caption-geometry.mjs draws the same box (CONTRACTS §5.47): its table, read from the source,
    equals the metrics this module derives from every pack file."""
    text = (ROOT / "web/components/editor/gizmos/caption-geometry.mjs").read_text(encoding="utf-8")
    rows = {name: tuple(int(value) for value in values) for name, *values in
            re.findall(r"(\w+): metrics\((\d+), \[\d+, \d+\], (\d+), (\d+)\)", text)}
    assert set(rows) == set(PACK_IDS)
    for pack_id in PACK_IDS:
        metrics = face_zone.pack_metrics(pack_id, 1)
        assert (metrics.scale_pm, metrics.line_em_pm, metrics.lines) == rows[pack_id], pack_id


def test_the_presets_are_the_editors():
    text = (ROOT / "web/components/editor/panels/caption-model.mjs").read_text(encoding="utf-8")
    block = text[text.index("export const CAPTION_POSITIONS"):]
    block = block[:block.index("]);")]
    found = re.findall(r'\{ id: "(\w+)", label: "\w+", value: (\d+) \}', block)
    assert tuple((name, int(value)) for name, value in found) == CAPTION_PRESETS


# --- the face in the output ------------------------------------------------------------------------


def test_a_centre_crop_maps_the_face_through_the_scaled_source():
    # 1280×720 → 2276×1280, centre crop x 778
    rects = face_zone.face_rects(LOW, doc_with(), face_plan([LOW]), sf=0, output=OUTPUT)
    scale = 2276 / 1280
    assert rects == [pytest.approx((0.45 * 1280 * scale - 778, 0.6 * 1280,
                                    0.55 * 1280 * scale - 778, 0.9 * 1280))]


def test_a_face_outside_the_crop_is_not_in_the_output():
    left = [20, 600, 80, 300]
    assert face_zone.face_rects(left, doc_with(), face_plan([left]), sf=0, output=OUTPUT) == []


def test_fit_blur_maps_the_face_into_the_fitted_picture():
    rects = face_zone.face_rects(LOW, doc_with(mode="fit_blur"), face_plan([LOW]), sf=0,
                                 output=OUTPUT)
    fit, top = 720 / 1280, (1280 - 405) / 2
    assert rects == [pytest.approx((0.45 * 720, top + 0.6 * 720 * fit,
                                    0.55 * 720, top + 0.9 * 720 * fit))]


def test_face_track_maps_the_face_through_its_own_crop():
    left = [20, 600, 80, 300]
    plan = face_plan([left], centre_pm=50)
    rects = face_zone.face_rects(left, doc_with(mode="camera"), plan, sf=0, output=OUTPUT)
    crop_x = layouts.crop_positions(plan, FPS, source=SOURCE, output=OUTPUT, first_sf=0,
                                    count=1)[0]
    assert crop_x == 0
    assert rects == [pytest.approx((0.02 * 2276, 768, 0.1 * 2276, 1152))]


def test_manual_framing_maps_the_face_through_its_keyframes():
    left = [20, 600, 80, 300]
    doc = doc_with(keyframes=[{"sf": 0, "pan_e5": 0, "move": "cut"}])
    assert face_zone.face_rects(left, doc, face_plan([left]), sf=0, output=OUTPUT) == [
        pytest.approx((0.02 * 2276, 768, 0.1 * 2276, 1152))]


def test_split_maps_the_face_into_each_band_that_shows_it():
    doc = doc_with(mode="split", split=layouts.default_split())
    rects = face_zone.face_rects(LOW, doc, face_plan([LOW]), sf=0, output=OUTPUT)
    geometry = layouts.split_geometry(layouts.default_split(), source=SOURCE, output=OUTPUT)
    assert len(rects) == 2
    for rect, band in zip(rects, ("top", "bottom"), strict=True):
        x, y, w, h = geometry[band]["crop"]
        (band_w, band_h), band_y = geometry[band]["size"], geometry[band]["y"]
        sx, sy = band_w / w, band_h / h
        expected = ((0.45 * 1280 - x) * sx, band_y + (0.6 * 720 - y) * sy,
                    (0.55 * 1280 - x) * sx, band_y + (0.9 * 720 - y) * sy)
        clipped = (max(expected[0], 0), max(expected[1], band_y),
                   min(expected[2], band_w), min(expected[3], band_y + band_h))
        assert rect == pytest.approx(clipped)


# --- the warning -----------------------------------------------------------------------------------


def test_a_caption_over_the_face_for_a_share_of_the_clip_is_a_warning():
    plan = face_plan([HIGH, LOW, LOW, None, HIGH, HIGH, HIGH, HIGH])
    found = issues(doc_with(), plan)
    first = 750 * FPS.num // (1000 * FPS.den)  # the first sample over the face
    assert found == (Issue("caption_over_face", "/captions/overrides/y_e5", "tengah", first),)


def test_a_moment_over_the_face_is_not_a_warning():
    assert issues(doc_with(), face_plan([HIGH, LOW, HIGH, HIGH, HIGH, HIGH, HIGH, HIGH])) == ()


def test_a_caption_clear_of_the_face_is_not_a_warning():
    assert issues(doc_with(), face_plan([HIGH] * 8)) == ()
    assert issues(doc_with(y_e5=60000), face_plan([HIGH] * 8)) == ()


def test_a_caption_that_only_grazes_the_face_is_not_over_it():
    chin = [450, 100, 100, 640]  # rows 72–533 of 720 → output 128–948: 19 px inside the block
    assert issues(doc_with(), face_plan([chin] * 8)) == ()


def test_the_fix_is_the_nearest_preset_that_clears_the_face():
    # Tengah, fit-blur: the face low in the fitted picture is under the caption; Atas (22000
    # away) is nearer than Bawah (23000 away) and clears it
    low = [450, 500, 100, 400]
    found = issues(doc_with(mode="fit_blur", y_e5=60000), face_plan([low] * 8))
    assert [(issue.code, issue.ref) for issue in found] == [("caption_over_face", "atas")]


def test_without_a_preset_that_clears_the_face_the_warning_names_no_fix():
    huge = [300, 0, 400, 1000]  # the whole height of the frame
    found = issues(doc_with(), face_plan([huge] * 8))
    assert [(issue.code, issue.ref) for issue in found] == [("caption_over_face", None)]


def test_only_samples_with_a_caption_on_screen_count():
    plan = face_plan([LOW, LOW, LOW, HIGH, HIGH, HIGH, HIGH, HIGH])
    pieces, _cues = whole(plan)
    late = (SimpleNamespace(f0=3 * 750 * FPS.num // (1000 * FPS.den), f1=pieces[0].frames),)
    assert issues(doc_with(), plan, pieces, late) == ()


def test_samples_that_were_cut_out_do_not_count():
    plan = face_plan([HIGH, HIGH, LOW, LOW, LOW, HIGH, HIGH, HIGH])
    fps_ms = 1000 * FPS.den
    cut_at, back_at = 1500 * FPS.num // fps_ms, 3750 * FPS.num // fps_ms
    end = 6000 * FPS.num // fps_ms
    pieces = (Piece(0, "seg_b1", "body", 0, cut_at, 0, cut_at),
              Piece(1, "seg_b1", "body", back_at, end, cut_at, end - back_at))
    cues = (SimpleNamespace(f0=0, f1=cut_at + end - back_at),)
    assert issues(doc_with(), plan, pieces, cues) == ()
    # kept, the same samples are a warning at their output frame
    assert [issue.f for issue in issues(doc_with(), plan)] == [1500 * FPS.num // fps_ms]


def test_no_warning_without_captions_or_without_faces():
    plan = face_plan([LOW] * 8)
    assert issues(doc_with(enabled=False), plan) == ()
    without = copy.deepcopy(plan)
    del without["faces"]
    assert issues(doc_with(), without) == ()
    assert face_zone.caption_over_face_issues(doc_with(), None, (), (), OUTPUT) == ()


@pytest.mark.parametrize("faces", [
    "nope", [[450, 600, 100]], [[450, 600, 100, 300]] * 3, [[450, 600, 100, True]] * 8,
    [[450, 600, 100, 1001]] * 8, [[-1, 600, 100, 300]] * 8,
])
def test_malformed_faces_are_ignored(faces):
    plan = face_plan([LOW] * 8)
    plan["faces"] = faces
    assert issues(doc_with(), plan) == ()


def test_a_plan_the_crop_rejects_gives_no_warning():
    plan = face_plan([LOW] * 8)
    plan["samples"][3][0] = plan["samples"][2][0]  # not increasing: crop_positions refuses it
    assert issues(doc_with(mode="camera"), plan) == ()
