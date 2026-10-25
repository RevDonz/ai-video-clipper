"""The frame-identity gate cases (``scripts/parity/frame_identity.py``) can be read at all.

A split case is read band by band (CONTRACTS §5.45): the index through the top band and each
band's ruler against its crop. A band whose crop leaves out the ruler's source rows can never
decode, so every frame would count as a mismatch whatever the render does.
"""

from __future__ import annotations

import sys
from itertools import pairwise
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import frame_identity as fi
from support import edit_v2_media as media

SPLIT_CASES = [case for case in (*fi.P_FRAME_CASES, *fi.P_PLATE_CASES) if case.layout == "split"]


@pytest.mark.parametrize("case", SPLIT_CASES, ids=[case.name for case in SPLIT_CASES])
def test_every_split_band_shows_the_whole_ruler(case):
    pattern = media.Pattern.for_size(*case.source_size)
    ruler = (pattern.ruler_top, pattern.ruler_top + pattern.ruler_bits * pattern.band_h)
    for band in ("top", "bottom"):
        _x, y, _w, h = fi.split_band(case, band)["crop"]
        assert y <= ruler[0] and ruler[1] <= y + h, (case.name, band, (y, y + h), ruler)


AUTO_CASES = fi.AUTO_CASES


def _doc(case):
    duration_ms = case.frames * 1000 * case.fps[1] // case.fps[0]
    info = fi.SourceInfo(*case.source_size, case.fps, case.vfr, duration_ms, case.audio)
    edges = fi.case_edges(case)
    doc = fi.make_doc(info, fps=case.fps, body=edges["body"], cold_open=edges["cold_open"],
                      removals=edges["removals"], layout=case.layout, output=case.output)
    fi.apply_layout(doc, case)
    return doc, duration_ms


def test_the_auto_cases_are_the_p_frame_row_of_rombak_04_a10():
    names = {case.name for case in AUTO_CASES}
    assert {"cfr_30_auto", "cfr_2997_auto", "auto_zoom_content", "auto_mixed_2",
            "auto_mixed_3"} == names
    assert all(case.layout == "auto" for case in AUTO_CASES)
    assert {len(case.ranges) for case in AUTO_CASES} >= {2, 3}
    assert {case.fps for case in AUTO_CASES} >= {(30, 1), (30000, 1001)}
    zoomed = next(case for case in AUTO_CASES if case.name == "auto_zoom_content")
    assert zoomed.zoom_pm != 1000 and zoomed.content is not None


@pytest.mark.parametrize("case", AUTO_CASES, ids=[case.name for case in AUTO_CASES])
def test_an_auto_case_is_a_valid_document_whose_ranges_fall_on_and_inside_pieces(case):
    from ai_clipper.edit_v2 import timemap as tm
    from ai_clipper.edit_v2.doc import validate_doc

    doc, duration_ms = _doc(case)
    validation = validate_doc(doc, words=fi.make_words(duration_ms), assets={}, seed=None)
    assert validation.ok, [issue.to_json() for issue in validation.errors]
    pieces = tm.pieces(doc)
    edges = [entry["in_sf"] for entry in doc["layout"]["ranges"][1:]]
    on = [edge for edge in edges if any(edge in (p.in_sf, p.out_sf) for p in pieces)]
    inside = [edge for edge in edges if any(p.in_sf < edge < p.out_sf for p in pieces)]
    assert on and (inside or len(edges) == 1), (case.name, edges)
    modes = [entry["mode"] for entry in doc["layout"]["ranges"]]
    assert len(set(modes)) >= 2 and all(a != b for a, b in pairwise(modes))


def test_the_automatic_layout_with_manual_framing_is_range_invalid():
    from ai_clipper.edit_v2.doc import validate_doc

    case = fi.AUTO_KEYFRAMES
    doc, duration_ms = _doc(case)
    validation = validate_doc(doc, words=fi.make_words(duration_ms), assets={}, seed=None)
    assert ("range_invalid", "/layout/keyframes") in {(i.code, i.path)
                                                       for i in validation.errors}


def test_the_frames_an_auto_case_reads_with_the_fit_blur_geometry():
    from types import SimpleNamespace

    case = next(case for case in AUTO_CASES if case.name == "cfr_30_auto")
    plan = SimpleNamespace(  # what fallback_frames reads of a plan
        fps=fi.Fps(*case.fps), pieces=[SimpleNamespace(in_sf=0, out_sf=case.frames)],
        camera=fi.make_camera(30_000, case.fps, case.source_size, case.output))
    shown = fi.fallback_frames(case, plan)
    blur = {sf for a, b, mode in case.ranges if mode == "fit_blur" for sf in range(a, b)}
    assert blur <= shown
    # the camera plan's no-face span (3.0-5.25 s = frames 90-157) is in the first camera range
    assert set(range(90, 157)) <= shown
    assert not ({sf for a, b, mode in case.ranges if mode == "fill_center"
                 for sf in range(a, b)} & shown)


def test_a_zoomed_crop_leaves_the_index_out_and_only_those_frames_go_unread():
    from types import SimpleNamespace

    from ai_clipper.edit_v2 import layouts

    zoomed = next(case for case in AUTO_CASES if case.name == "auto_zoom_content")
    pattern = media.Pattern.for_size(*zoomed.source_size)
    # the crop starts below the index rows of the source (scaled by the picture's scale)
    where = fi.geometry("camera", zoomed.picture, zoomed.output, zoomed.zoom_pm)
    assert layouts.crop_y(zoomed.picture, zoomed.output, zoomed.zoom_pm) > 0
    assert -where["top"] / where["scale"] > pattern.index_top
    plan = SimpleNamespace(fps=fi.Fps(*zoomed.fps),
                           pieces=[SimpleNamespace(in_sf=0, out_sf=zoomed.frames)],
                           camera=fi.make_camera(30_000, zoomed.fps, zoomed.source_size,
                                                 zoomed.output))
    fallback = fi.fallback_frames(zoomed, plan)
    hidden = fi.hidden_index_frames(zoomed, plan, fallback)
    crops = {sf for a, b, mode in zoomed.ranges if mode != "fit_blur" for sf in range(a, b)}
    assert hidden == crops - fallback and hidden
    for case in (*fi.P_FRAME_CASES, *fi.SQUARE_CASES, *AUTO_CASES):
        if case.zoom_pm == 1000:
            assert not fi.hidden_index_frames(case, plan, frozenset()), case.name
    assert all(case.layout == "fit_blur" for case in fi.P_FRAME_CASES if case.zoom_pm != 1000)


@pytest.mark.parametrize("case", SPLIT_CASES, ids=[case.name for case in SPLIT_CASES])
def test_the_top_band_shows_the_index(case):
    pattern = media.Pattern.for_size(*case.source_size)
    _x, y, _w, h = fi.split_band(case, "top")["crop"]
    assert y == 0 and pattern.ruler_top <= h
