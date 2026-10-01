"""Layout switch and face-track through the preview lane (plan §11.3 T3.6, §5.7, §3.3
``layout.default.mode``, Appendix B ``SetLayout``).

A switch changes only ``layout.default.mode``. The plate key follows it (the layout is part of
the plate pixels) while the text and the audio mix stay as they are; switching back finds the
plate cells built before. The face-track layout of a clip seeded with another layout needs a
camera plan: ``prepare`` builds it once for the clip window and every later plan, preview and
export reuses that file. Runs of the plan without a face become ``no_face`` warnings at the
output frame where they start (per piece), so the editor can list them with a jump-to target.

The media tests run on the synthetic V3 job of ``scripts/editor_fixture/make_job.py`` (a 180 s
barcode source at 29.97, fit-blur seeds).
"""

from __future__ import annotations

import copy
import hashlib
import json

import pytest
from test_edit_v2_plates import camera_plan, synthetic_job, with_layout, write_camera
from test_edit_v2_preview_cli import b64, body, call, ok

from ai_clipper.edit_v2 import camera, plates, preview_cli, render_edit, store
from ai_clipper.edit_v2 import timemap as tm


@pytest.fixture(scope="module")
def job(tmp_path_factory, request):
    request.getfixturevalue("edit_v2_libass")
    pytest.importorskip("cv2")
    return synthetic_job(tmp_path_factory.mktemp("layout-switch-job"))


def clip_case(job: dict, index: int) -> dict:
    clip = job["clips"][index]
    seed, etag = store.seed(clip)
    words = store.load_words(clip, seed["base"]["words"]["sha256"])
    return {"root": job["jobs_root"], "clip": clip, "seed": seed, "etag": etag, "words": words,
            "jobId": job["job_id"], "clipId": clip.name, "job_dir": job["job_dir"]}


def revision(case: dict, layout: str | None = None) -> dict:
    """Revision 1 of the clip, as the editor saves it after ``SetLayout``."""
    doc = copy.deepcopy(case["seed"])
    doc["revision"] = 1
    doc["parent_sha256"] = case["etag"]
    doc["audit"]["editor"] = "editor-v3/1.0.0"
    doc["audit"]["last_command"] = "SetLayout"
    if layout is not None:
        doc["layout"]["default"]["mode"] = layout
    return doc


def plan_of(case: dict, doc: dict) -> dict:
    status, payload = call(case["root"], op="plan", jobId=case["jobId"], clipId=case["clipId"],
                           requestRaw=b64(body(doc)))
    assert status == 0, payload
    return payload


def lane_op(case: dict, name: str, **fields) -> dict:
    return ok(call(case["root"], op=name, jobId=case["jobId"], clipId=case["clipId"], **fields))


def test_a_layout_switch_changes_the_plate_and_nothing_else(job):
    case = clip_case(job, 0)
    assert case["seed"]["layout"]["default"]["mode"] == "fit_blur"
    fit = plan_of(case, revision(case))["dto"]
    center = plan_of(case, revision(case, "fill_center"))["dto"]
    assert center["plate"]["plateKey"] != fit["plate"]["plateKey"]
    assert center["plate"]["plateKey"] == plates.plate_key(
        revision(case, "fill_center"), toolchain_sha256=preview_cli._toolchain())
    # the same pieces, cells, text and mix: a switch rebuilds only the plate
    assert center["pieces"] == fit["pieces"]
    assert [c["k"] for c in center["plate"]["cells"]] == [c["k"] for c in fit["plate"]["cells"]]
    assert center["text"]["assSha256"] == fit["text"]["assSha256"]
    assert center["audio"]["mixSha256"] == fit["audio"]["mixSha256"]
    assert center["planSha256"] != fit["planSha256"]
    back = plan_of(case, revision(case, "fit_blur"))["dto"]
    assert back["plate"]["plateKey"] == fit["plate"]["plateKey"]
    assert back["planSha256"] == fit["planSha256"]


def test_cells_built_before_a_switch_are_found_after_switching_back(job):
    case = clip_case(job, 0)
    first = plan_of(case, revision(case))["lane"]
    playhead_cell = first["cells"][0]
    built = lane_op(case, "cells", layout="fit_blur", cells=[playhead_cell], cancelToken=None)
    assert built["plateKey"] == first["plateKey"]
    switched = plan_of(case, revision(case, "fill_center"))
    assert playhead_cell in switched["lane"]["missing"]  # other pixels: not built yet
    back = plan_of(case, revision(case, "fit_blur"))
    states = {cell["k"]: cell["state"] for cell in back["dto"]["plate"]["cells"]}
    assert states[playhead_cell] == "ready"
    assert playhead_cell not in back["lane"]["missing"]


def test_the_camera_plan_is_built_once_for_the_window_and_reused(job, monkeypatch):
    case = clip_case(job, 1)
    assert case["seed"]["base"]["camera"]["sha256"] is None  # seeded fit-blur: no camera plan
    calls = []
    original = camera.detect_window

    def counting(*args, **kwargs):
        calls.append(kwargs.get("start"))
        return original(*args, **kwargs)

    monkeypatch.setattr(camera, "detect_window", counting)
    doc = revision(case, "camera")
    status, payload = call(case["root"], op="plan", jobId=case["jobId"], clipId=case["clipId"],
                           requestRaw=b64(body(doc)))
    assert status == 8 and payload["error"]["code"] == "analysis_missing"
    assert payload["error"]["ref"] == "camera"
    prepared = lane_op(case, "prepare", layout="camera")
    assert prepared["camera"] == "ready" and len(calls) == 1
    files = sorted(case["clip"].glob("camera.*.json"))
    assert len(files) == 1
    raw = files[0].read_bytes()
    built = json.loads(raw)
    assert built["window_ms"] == case["seed"]["base"]["window_ms"]
    assert built["fps"] == case["seed"]["output"]["fps"]
    sha = hashlib.sha256(raw).hexdigest()
    key = plan_of(case, doc)["dto"]["plate"]["plateKey"]
    assert key == prepared["plateKey"]
    # prepare again, switch away and back: the same file, the same key, no second analysis
    assert lane_op(case, "prepare", layout="camera")["plateKey"] == key
    plan_of(case, revision(case, "fill_center"))
    assert plan_of(case, revision(case, "camera"))["dto"]["plate"]["plateKey"] == key
    assert len(calls) == 1
    assert sorted(case["clip"].glob("camera.*.json")) == files
    assert plates.camera_for(case["clip"], doc)[1] == sha
    # the export resolves the same camera plan as the preview (P-PLATE after a switch)
    inputs = render_edit.load_render_inputs(case["job_dir"], doc)
    assert inputs.camera == plates.camera_for(case["clip"], doc)[0] == built
    assert inputs.plan.camera == built


def _ms(sf: int, fps: tm.Fps) -> int:
    return -(-sf * 1000 * fps.den // fps.num)


def _body_removal(case: dict, doc: dict) -> dict:
    """A removal of two words in the middle of the body, cut on the ``bounds`` table."""
    body_segment = doc["main"]["segments"][-1]
    fps = tm.Fps.from_json(doc["output"]["fps"])
    scale = 1000 * fps.den
    inside = [w for w in case["words"]["words"]
              if body_segment["in_sf"] * scale <= (w["s"] + w["e"]) // 2 * fps.num
              < body_segment["out_sf"] * scale]
    middle = len(inside) // 2
    chosen = inside[middle:middle + 2]
    before = {b["before"]: b for b in case["words"]["bounds"]}
    after = {b["after"]: b for b in case["words"]["bounds"]}
    return {"id": "rm_1", "seg": body_segment["id"], "in_sf": before[chosen[0]["id"]]["sf"],
            "out_sf": after[chosen[-1]["id"]]["sf"], "words": [w["id"] for w in chosen],
            "reason": "user", "origin": "user"}


@pytest.fixture(scope="module")
def no_face_case(job):
    """Clip 3 switched to face-track with a cut, and a camera plan with three runs without a
    face: inside the body, across the cut, and before the clip (never shown)."""
    case = clip_case(job, 2)
    doc = revision(case, "camera")
    removal = _body_removal(case, doc)
    doc["main"]["removals"] = [removal]
    fps = tm.Fps.from_json(doc["output"]["fps"])
    body_segment = doc["main"]["segments"][-1]
    window = doc["base"]["window_ms"]
    spans = [
        # 1 s into the body, 2 s long
        [_ms(body_segment["in_sf"], fps) + 1000, _ms(body_segment["in_sf"], fps) + 3000],
        # across the removal: seen in the pieces on both sides of the cut
        [_ms(removal["in_sf"], fps) - 1500, _ms(removal["out_sf"], fps) + 1500],
        # inside the analysis window but before the clip: never shown, never listed
        [window[0], window[0] + 2000],
    ]
    assert spans[2][1] < _ms(min(s["in_sf"] for s in doc["main"]["segments"]), fps)
    write_camera(case["clip"], camera_plan(doc, no_face=spans))
    expected = []
    for start_ms, end_ms in spans:
        for piece in tm.pieces(doc):
            if start_ms < _ms(piece.out_sf, fps) and end_ms > _ms(piece.in_sf, fps):
                first = max(tm.sf_floor(start_ms, fps), piece.in_sf)
                expected.append(piece.out_f0 + first - piece.in_sf)
    assert len(expected) == 3  # one run inside a piece, one on both sides of the cut
    return case, doc, sorted(expected)


def test_no_face_runs_are_listed_at_their_output_frames(no_face_case):
    case, doc, expected = no_face_case
    plan = render_edit.load_render_inputs(case["job_dir"], doc).plan
    listed = [w for w in plan.warnings if w.code == "no_face"]
    assert sorted(w.f for w in listed) == expected
    assert all(w.path == "/layout/default/mode" and w.ref is None for w in listed)
    assert all(0 <= w.f < plan.total_frames for w in listed)
    # the same runs mean nothing for the layouts without a camera
    for layout in ("fit_blur", "fill_center"):
        other = plan_of(case, with_layout(doc, layout))["dto"]
        assert not [w for w in other["warnings"] if w["code"] == "no_face"]


@pytest.mark.xfail(strict=True, reason=(
    "preview_cli._plan de-duplicates the DTO warnings by (code, path, ref), so every no_face run "
    "after the first (same code and path, no ref, another f) is dropped; the fix is to include "
    "'f' in that marker (request to the W3 integrator: preview_cli.py is T2.3's)"))
def test_the_plan_dto_lists_every_no_face_run(no_face_case):
    case, doc, expected = no_face_case
    dto = plan_of(case, doc)["dto"]
    assert sorted(w["f"] for w in dto["warnings"] if w["code"] == "no_face") == expected


def test_the_plan_dto_lists_the_first_no_face_run(no_face_case):
    case, doc, expected = no_face_case
    listed = [w for w in plan_of(case, doc)["dto"]["warnings"] if w["code"] == "no_face"]
    assert listed and listed[0]["f"] == expected[0]
    assert listed[0]["path"] == "/layout/default/mode"


def test_a_switch_is_undone_by_switching_back_to_the_seed_layout(job):
    """Undo of ``SetLayout`` restores the seed layout: content equals the seed again (R10)."""
    from ai_clipper.edit_v2.doc import content_equals_seed

    case = clip_case(job, 0)
    switched = revision(case, "fill_center")
    assert not content_equals_seed(switched, case["seed"])
    undone = with_layout(switched, case["seed"]["layout"]["default"]["mode"])
    assert content_equals_seed(undone, case["seed"])
