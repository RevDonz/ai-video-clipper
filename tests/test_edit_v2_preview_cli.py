"""CLI ``python -m ai_clipper.edit_v2.preview_cli``: the server preview lane (plan §4.2, §4.3,
§6, §2.6; T2.3).

Ops ``prepare``, ``plan``, ``cells``, ``audio``, ``frame`` and ``derive``. The plan tests run on
the committed document contexts (no media); the FFmpeg tests on the synthetic V3 job of
``scripts/editor_fixture/make_job.py``.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from support import edit_v2_media as media
from test_edit_v2_plates import camera_plan, synthetic_job, with_layout, write_camera
from test_edit_v2_store import make_clip, next_doc

from ai_clipper.edit_v2 import (
    COMPILER_ID,
    RENDER_SEMANTICS,
    compile_ffmpeg,
    execute,
    plates,
    preview_cli,
    store,
)
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import canonical_bytes, doc_sha256
from ai_clipper.edit_v2.errors import MESSAGES
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan

ROOT = Path(__file__).resolve().parents[1]
VALID = ROOT / "tests" / "fixtures" / "edit_v2" / "docs" / "valid"
HEX16 = re.compile(r"[0-9a-f]{16}")
FONTS = json.loads((RESOURCES_DIR / "fonts" / "fonts.json").read_text(encoding="utf-8"))
FONT_SHA = {font["file"]: font["sha256"] for font in FONTS["fonts"]}


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


@pytest.fixture
def c30(tmp_path, contexts):
    context = contexts["c30"]
    clip = make_clip(tmp_path, context)
    return {"root": tmp_path, "clip": clip, "seed": context.seed, "words": context.words,
            "assets": context.assets, "jobId": context.seed["base"]["job_id"],
            "clipId": context.seed["clip_id"]}


def valid(name: str) -> dict:
    return json.loads((VALID / f"{name}.json").read_text(encoding="utf-8"))


def body(doc: dict | None = None, *, raw_doc: bytes | None = None, **fields) -> bytes:
    """A route body: ``{"doc": …}`` plus ``known``/``playhead``/``f`` (raw JSON bytes)."""
    parts = [b'"doc":' + (canonical_bytes(doc) if raw_doc is None else raw_doc)]
    for key, value in fields.items():
        parts.append(json.dumps(key).encode() + b":" + json.dumps(value).encode())
    return b"{" + b",".join(parts) + b"}"


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def call(root: Path, **envelope) -> tuple[int, dict]:
    return preview_cli.handle(json.dumps(envelope).encode(), jobs_root=root)


def plan(case: dict, doc: dict | None = None, **fields) -> tuple[int, dict]:
    raw = body(case["seed"] if doc is None else doc, **fields)
    return call(case["root"], op="plan", jobId=case["jobId"], clipId=case["clipId"],
                requestRaw=b64(raw))


def ok(result: tuple[int, dict]) -> dict:
    status, payload = result
    assert status == 0, payload
    return payload


def assert_error(result: tuple[int, dict], exit_code: int, code: str) -> dict:
    status, payload = result
    assert status == exit_code, payload
    assert set(payload["error"]) == {"code", "path", "ref", "messageId"}
    assert payload["error"]["code"] == code
    assert payload["error"]["messageId"] in {f"edit.{c}" for c in MESSAGES}
    return payload


def expected_plan(case: dict, doc: dict, camera=None):
    return build_plan(doc, words=case["words"], camera=camera,
                      assets={k: v for k, v in case["assets"].items() if k in doc["assets"]},
                      resources=Resources(RESOURCES_DIR))


# --- envelope --------------------------------------------------------------------------------------


JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
CLIP = "clip_" + "a" * 24


@pytest.mark.parametrize("raw", [
    b"",
    b"not json",
    b"[]",
    b'{"op": "delete", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode() + b'"}',
    b'{"op": "plan", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode() + b'"}',
    b'{"op": "plan", "jobId": "../etc", "clipId": "' + CLIP.encode() + b'", "requestRaw": "e30="}',
    b'{"op": "plan", "jobId": "' + JOB.encode() + b'", "clipId": "clip_x", "requestRaw": "e30="}',
    b'{"op": "plan", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "requestRaw": "***"}',
    b'{"op": "plan", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "requestRaw": "e30=", "extra": 1}',
    b'{"op": "prepare", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "layout": "split"}',
    b'{"op": "cells", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "layout": "fit_blur", "cells": [], "cancelToken": null}',
    b'{"op": "cells", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "layout": "fit_blur", "cells": [1, true], "cancelToken": null}',
    b'{"op": "cells", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "layout": "fit_blur", "cells": [1], "cancelToken": "../x"}',
    b'{"op": "cells", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "layout": "fit_blur", "cells": ' + json.dumps(list(range(65))).encode()
    + b', "cancelToken": null}',
    b'{"op": "derive", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "asset": "sha256:xyz", "w": 10, "h": 10, "opacityPm": 800, "cancelToken": null}',
    b'{"op": "derive", "jobId": "' + JOB.encode() + b'", "clipId": "' + CLIP.encode()
    + b'", "asset": "sha256:' + b"a" * 64 + b'", "w": 10.0, "h": 10, "opacityPm": 800,'
    b' "cancelToken": null}',
    b"{" + b" " * (3 << 20) + b"}",
])
def test_malformed_envelopes_are_usage_errors(tmp_path, raw):
    status, payload = preview_cli.handle(raw, jobs_root=tmp_path)
    assert status == 2
    assert payload["error"]["code"] == "internal_error"
    assert str(tmp_path) not in json.dumps(payload)


def test_the_ops_are_the_frozen_ones():
    assert preview_cli.OPS == ("prepare", "plan", "cells", "audio", "frame", "derive")


def test_jobs_root_must_be_configured(c30):
    raw = json.dumps({"op": "plan", "jobId": c30["jobId"], "clipId": c30["clipId"],
                      "requestRaw": b64(body(c30["seed"]))}).encode()
    status, payload = preview_cli.handle(raw, jobs_root=None)
    assert status == 1 and payload["error"]["code"] == "internal_error"


def test_unknown_job_or_clip_is_not_found(c30):
    raw = b64(body(c30["seed"]))
    assert_error(call(c30["root"], op="plan", jobId=JOB.replace("8f", "9f"),
                      clipId=c30["clipId"], requestRaw=raw), 4, "not_found")
    assert_error(call(c30["root"], op="plan", jobId=c30["jobId"], clipId=CLIP, requestRaw=raw),
                 4, "not_found")


def test_a_symlinked_clip_directory_is_not_followed(c30, tmp_path_factory):
    elsewhere = tmp_path_factory.mktemp("elsewhere")
    real = c30["clip"]
    moved = elsewhere / real.name
    real.rename(moved)
    os.symlink(moved, real)
    assert_error(plan(c30), 4, "not_found")


# --- plan: the DTO ---------------------------------------------------------------------------------


DTO_KEYS = {"planSha256", "docSha256", "compiler", "renderSemantics", "fps", "totalFrames",
            "output", "pieces", "cues", "hook", "text", "plate", "logo", "audio", "rev0",
            "warnings", "errors"}


def test_plan_of_the_seed_is_the_frozen_dto(c30):
    result = ok(plan(c30))
    dto = result["dto"]
    seed = c30["seed"]
    expected = expected_plan(c30, seed)
    assert set(dto) == DTO_KEYS
    assert dto["planSha256"] == expected.plan_sha256
    assert dto["docSha256"] == doc_sha256(seed)
    assert dto["compiler"] == COMPILER_ID and dto["renderSemantics"] == RENDER_SEMANTICS
    assert dto["fps"] == seed["output"]["fps"]
    assert dto["totalFrames"] == expected.total_frames
    assert dto["output"] == {"w": 720, "h": 1280}
    assert dto["pieces"] == [piece.to_dto() for piece in expected.pieces]
    cues = expected.captions.cues
    assert [(c["f0"], c["f1"], c["words"]) for c in dto["cues"]] == [
        (c.f0, c.f1, [w.id for w in c.words]) for c in cues]
    assert dto["cues"][0]["text"] == " ".join(w.text for w in cues[0].words)
    hook = seed["tracks"][0]["items"][0]
    assert dto["hook"] == {"f0": 0, "f1": min(hook["dur_f"], expected.total_frames),
                           "lines": list(expected.captions.hook_lines), "overflow": False}
    prefix = f"/api/jobs/{c30['jobId']}/clips/{c30['clipId']}/media"
    ass_sha = expected.ass_sha256
    assert dto["text"]["assSha256"] == ass_sha
    assert dto["text"]["ass"] == expected.ass
    assert dto["text"]["url"] == f"{prefix}/ass/{ass_sha[:16]}.ass"
    # karaoke and the legacy-bar hook: DejaVu Sans Bold; the fallback DejaVu Sans (R6)
    assert dto["text"]["fonts"] == [
        {"family": "DejaVu Sans", "url": f"/api/resources/fonts/{name}?v={FONT_SHA[name][:16]}",
         "sha256": FONT_SHA[name]} for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf")]
    plate = dto["plate"]
    fps = tm.Fps.from_json(seed["output"]["fps"])
    assert plate["plateKey"] == plates.plate_key(seed)
    assert plate["cellFrames"] == 60 and (plate["w"], plate["h"]) == (720, 1280)
    assert [cell["k"] for cell in plate["cells"]] == list(
        plates.cells_for_pieces(expected.pieces, fps))
    assert all(cell == {"k": cell["k"], "state": "queued"} for cell in plate["cells"])
    assert dto["logo"] is None
    audio = dto["audio"]
    assert HEX16.fullmatch(audio["mixSha256"][:16]) and len(audio["mixSha256"]) == 64
    assert audio["state"] == "queued" and "url" not in audio
    assert audio["samples"] == expected.total_samples == tm.smp(expected.total_frames, fps)
    assert audio["musicGainPoints"] == []
    assert audio["speechSpans"] == [list(span) for span in expected.speech_spans]
    assert dto["rev0"] == {"planSha256": expected.plan_sha256, "autoRenderUrl": None,
                           "exact": False}
    assert {"code": "unsafe_zone", "path": "/captions/overrides/y_e5"}.items() <= next(
        w for w in dto["warnings"] if w["code"] == "unsafe_zone").items()
    assert dto["errors"] == []


def test_plan_publishes_the_ass_bytes_it_names(c30):
    dto = ok(plan(c30))["dto"]
    name = dto["text"]["url"].rsplit("/", 1)[1]
    path = c30["clip"] / "preview" / "ass" / name
    assert path.read_bytes() == dto["text"]["ass"].encode("utf-8")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == dto["text"]["assSha256"]
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    for directory in (c30["clip"] / "preview", c30["clip"] / "preview" / "ass"):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    ok(plan(c30))  # a second plan leaves the published file alone
    assert path.read_bytes() == dto["text"]["ass"].encode("utf-8")


def test_the_ass_is_omitted_when_the_client_already_has_it(c30):
    first = ok(plan(c30))["dto"]
    known = ok(plan(c30, known={"assSha256": first["text"]["assSha256"]}))["dto"]
    assert "ass" not in known["text"]
    assert {k: v for k, v in known["text"].items()} == {
        k: v for k, v in first["text"].items() if k != "ass"}
    other = ok(plan(c30, known={"assSha256": "0" * 64}))["dto"]
    assert other["text"]["ass"] == first["text"]["ass"]
    empty = ok(plan(c30, known={}))["dto"]
    assert empty["text"]["ass"] == first["text"]["ass"]


def test_the_lane_section_tells_node_what_to_build(c30):
    result = ok(plan(c30, playhead=150))
    dto, lane = result["dto"], result["lane"]
    assert set(lane) == {"playhead", "layout", "plateKey", "cellFrames", "cells", "missing",
                         "audio", "logo", "frameKey"}
    assert lane["playhead"] == 150
    assert lane["layout"] == "fit_blur" and lane["plateKey"] == dto["plate"]["plateKey"]
    assert lane["cells"] == [cell["k"] for cell in dto["plate"]["cells"]] == lane["missing"]
    assert lane["audio"] == {"key": dto["audio"]["mixSha256"], "ready": False}
    assert lane["logo"] is None
    assert HEX16.fullmatch(lane["frameKey"])
    assert ok(plan(c30))["lane"]["playhead"] == 0
    assert ok(plan(c30, playhead=10**9))["lane"]["playhead"] == dto["totalFrames"] - 1


def test_an_edited_document_names_the_seed_plan_as_revision_0(c30):
    doc = valid("removal_single__c30")
    result = ok(plan(c30, doc))
    dto = result["dto"]
    edited = expected_plan(c30, doc)
    assert dto["planSha256"] == edited.plan_sha256 != expected_plan(c30, c30["seed"]).plan_sha256
    assert dto["rev0"]["planSha256"] == expected_plan(c30, c30["seed"]).plan_sha256
    assert dto["docSha256"] == doc_sha256(doc)
    assert dto["totalFrames"] == edited.total_frames
    unchanged = ok(plan(c30, valid("rev1_unchanged__c30")))["dto"]
    assert unchanged["planSha256"] == unchanged["rev0"]["planSha256"]


def test_the_seed_plan_is_built_once_and_kept_under_its_identity(c30):
    seed_sha = expected_plan(c30, c30["seed"]).plan_sha256
    assert ok(plan(c30, valid("removal_single__c30")))["dto"]["rev0"]["planSha256"] == seed_sha
    cached = sorted((c30["clip"] / "preview").glob("rev0.*.json"))
    assert len(cached) == 1
    entry = json.loads(cached[0].read_text())
    assert set(entry) == {"key", "planSha256"} and entry["planSha256"] == seed_sha
    assert cached[0].name == f"rev0.{entry['key'][:16]}.json"
    # the second edit reads the file instead of planning the seed again
    cached[0].chmod(0o600)
    cached[0].write_text(json.dumps({"key": entry["key"], "planSha256": "e" * 64}))
    assert ok(plan(c30, valid("pack_bold__c30")))["dto"]["rev0"]["planSha256"] == "e" * 64
    # a file under another identity (another compiler or resources) is not used
    cached[0].write_text(json.dumps({"key": "0" * 64, "planSha256": "e" * 64}))
    assert ok(plan(c30, valid("pack_bold__c30")))["dto"]["rev0"]["planSha256"] == seed_sha


def test_the_audio_key_follows_the_sound_and_the_plate_key_the_pixels(c30):
    seed = ok(plan(c30))["dto"]
    bold = ok(plan(c30, valid("pack_bold__c30")))["dto"]
    removal = ok(plan(c30, valid("removal_single__c30")))["dto"]
    music = ok(plan(c30, valid("music__c30")))["dto"]
    center = ok(plan(c30, valid("layout_fill_center__c30")))["dto"]
    assert bold["audio"]["mixSha256"] == seed["audio"]["mixSha256"]
    assert bold["plate"]["plateKey"] == seed["plate"]["plateKey"]
    assert bold["text"]["assSha256"] != seed["text"]["assSha256"]
    assert removal["audio"]["mixSha256"] != seed["audio"]["mixSha256"]
    assert removal["plate"]["plateKey"] == seed["plate"]["plateKey"]
    assert music["audio"]["mixSha256"] not in (seed["audio"]["mixSha256"],
                                               removal["audio"]["mixSha256"])
    assert music["audio"]["musicGainPoints"] and all(
        len(point) == 2 for point in music["audio"]["musicGainPoints"])
    assert center["plate"]["plateKey"] != seed["plate"]["plateKey"]
    assert center["audio"]["mixSha256"] == seed["audio"]["mixSha256"]


def test_the_logo_box_and_its_derived_bitmap_are_named(c30):
    doc = valid("logo__c30")
    result = ok(plan(c30, doc))
    dto, lane = result["dto"], result["lane"]
    item = next(t for t in doc["tracks"] if t["kind"] == "visual")["items"][0]
    meta = c30["assets"][item["payload"]["asset"]]
    x0, y0, w, h = tm.logo_box(x_e5=item["transform"]["x_e5"], y_e5=item["transform"]["y_e5"],
                               w_e5=item["transform"]["w_e5"], asset_w=meta["w"],
                               asset_h=meta["h"], out_w=720, out_h=1280)
    assert dto["logo"] == {"box": {"x": x0, "y": y0, "w": w, "h": h},
                           "opacityPm": item["transform"]["opacity_pm"], "state": "queued"}
    assert lane["logo"]["asset"] == item["payload"]["asset"]
    assert (lane["logo"]["w"], lane["logo"]["h"]) == (w, h)
    assert lane["logo"]["opacityPm"] == item["transform"]["opacity_pm"]
    assert re.fullmatch(rf"[0-9a-f]{{16}}@{w}x{h}a{item['transform']['opacity_pm']}\.png",
                        lane["logo"]["name"])
    assert lane["logo"]["ready"] is False


def test_published_files_are_reported_ready_with_their_urls(c30):
    first = ok(plan(c30))
    dto, lane = first["dto"], first["lane"]
    preview = c30["clip"] / "preview"
    k = lane["cells"][0]
    (preview / "plates").mkdir(mode=0o700)
    (preview / "plates" / plates.cell_name(lane["plateKey"], k)).write_bytes(b"cell")
    (preview / "audio").mkdir(mode=0o700)
    key16 = lane["audio"]["key"][:16]
    (preview / "audio" / f"{key16}.flac").write_bytes(b"fLaC")
    (preview / "audio" / f"{key16}.json").write_text(json.dumps(
        {"samples": dto["audio"]["samples"], "gainCdb": -120,
         "warnings": [{"code": "peak_reduced:-1.20 dB", "path": "/audio"}],
         "mixSha256": "f" * 64}))
    again = ok(plan(c30))
    prefix = f"/api/jobs/{c30['jobId']}/clips/{c30['clipId']}/media"
    cell = again["dto"]["plate"]["cells"][0]
    assert cell == {"k": k, "state": "ready",
                    "url": f"{prefix}/plates/{plates.cell_name(lane['plateKey'], k)}"}
    assert again["lane"]["missing"] == lane["cells"][1:]
    assert again["dto"]["audio"]["state"] == "ready"
    assert again["dto"]["audio"]["url"] == f"{prefix}/audio/{key16}.flac"
    assert again["lane"]["audio"]["ready"] is True
    assert {"code": "peak_reduced:-1.20 dB", "path": "/audio"} in again["dto"]["warnings"]


def test_revision_0_is_exact_only_for_an_edit_v2_auto_render(c30):
    seed = c30["seed"]
    job = c30["root"] / c30["jobId"]
    (job / "output").mkdir()
    rank = seed["base"]["origin"]["rank_at_seed"]
    name = f"clip-{rank:02d}.mp4"
    (job / "output" / name).write_bytes(b"mp4")
    seed_sha = expected_plan(c30, seed).plan_sha256

    def manifest(**entry):
        (job / "output" / "manifest.json").write_text(json.dumps(
            {"clips": [{"index": 1, "clip_id": "clip_" + "0" * 24},
                       {"index": rank, **entry}]}))

    url = f"/api/jobs/{c30['jobId']}/files/output/{name}"
    manifest(clip_id=c30["clipId"], render_engine=COMPILER_ID, plan_sha256=seed_sha)
    assert ok(plan(c30))["dto"]["rev0"] == {"planSha256": seed_sha, "autoRenderUrl": url,
                                            "exact": True}
    assert ok(plan(c30, valid("rev1_unchanged__c30")))["dto"]["rev0"]["exact"] is True
    assert ok(plan(c30, valid("removal_single__c30")))["dto"]["rev0"]["exact"] is False
    manifest(clip_id=c30["clipId"], render_engine="legacy", plan_sha256=seed_sha)
    assert ok(plan(c30))["dto"]["rev0"] == {"planSha256": seed_sha, "autoRenderUrl": url,
                                            "exact": False}
    manifest(clip_id=c30["clipId"], render_engine=COMPILER_ID, plan_sha256="0" * 64)
    assert ok(plan(c30))["dto"]["rev0"]["exact"] is False
    manifest()  # an older manifest: found by rank, engine from the seed
    assert ok(plan(c30))["dto"]["rev0"]["exact"] is True
    (job / "output" / name).unlink()
    assert ok(plan(c30))["dto"]["rev0"] == {"planSha256": seed_sha, "autoRenderUrl": None,
                                            "exact": False}


def test_a_legacy_engine_seed_is_never_exact(tmp_path, contexts):
    context = contexts["c30"]
    seed = copy.deepcopy(context.seed)
    seed["base"]["engine"]["compiler"] = "legacy"
    clip = make_clip(tmp_path, context, seed=seed)
    job = clip.parents[2]
    (job / "output").mkdir()
    name = f"clip-{seed['base']['origin']['rank_at_seed']:02d}.mp4"
    (job / "output" / name).write_bytes(b"mp4")
    case = {"root": tmp_path, "seed": seed, "jobId": seed["base"]["job_id"],
            "clipId": seed["clip_id"]}
    rev0 = ok(plan(case))["dto"]["rev0"]
    assert rev0["exact"] is False
    assert rev0["autoRenderUrl"].endswith(name)


# --- plan: invalid requests and documents ----------------------------------------------------------


def request(case: dict, raw: bytes) -> tuple[int, dict]:
    return call(case["root"], op="plan", jobId=case["jobId"], clipId=case["clipId"],
                requestRaw=b64(raw))


def test_the_document_is_validated_exactly_as_received(c30):
    raw_doc = canonical_bytes(c30["seed"]).replace(b'"cut_fade_ms":8', b'"cut_fade_ms":8.0')
    payload = assert_error(request(c30, body(raw_doc=raw_doc)), 3, "float_not_allowed")
    assert payload["error"]["path"] == "/main/cut_fade_ms"
    duplicate = canonical_bytes(c30["seed"]).replace(b'"cut_fade_ms":8',
                                                     b'"cut_fade_ms":8,"cut_fade_ms":8')
    assert_error(request(c30, body(raw_doc=duplicate)), 3, "duplicate_key")
    newer = copy.deepcopy(c30["seed"])
    newer["schema_minor"] = 1
    assert_error(plan(c30, newer), 7, "schema_too_new")


@pytest.mark.parametrize("raw", [
    b"{}",
    b"[]",
    b'{"doc": {}, "doc": {}}',
    b'{"doc": 1}',
    b'{"known": {}}',
    b'{"doc": {"a": 1}} trailing',
])
def test_malformed_request_bodies_are_invalid(c30, raw):
    assert_error(request(c30, raw), 3, "invalid_json")


@pytest.mark.parametrize("fields", [
    {"extra": 1},
    {"known": {"assSha256": "F" * 64}},
    {"known": {"assSha256": "a" * 64, "planSha256": "b" * 64}},
    {"known": []},
    {"playhead": -1},
    {"playhead": True},
    {"playhead": 1.5},
    {"f": 3},  # frame numbers belong to the frame op
])
def test_request_fields_other_than_the_contract_are_refused(c30, fields):
    assert_error(plan(c30, **fields), 3, "invalid_json")


def test_semantic_problems_list_every_issue(c30):
    doc = next_doc(c30["seed"], fixtures.etag(c30["seed"]))
    doc["base"]["window_ms"] = [0, 10]
    payload = assert_error(plan(c30, doc), 6, "base_changed")
    assert all(set(issue) >= {"code", "path"} for issue in payload["errors"])
    outside = next_doc(c30["seed"], fixtures.etag(c30["seed"]))
    outside["main"]["segments"][-1]["out_sf"] += 100_000
    status, payload = plan(c30, outside)
    assert status == 6
    assert "outside_window" in {issue["code"] for issue in payload["errors"]}


def test_the_camera_layout_needs_a_camera_plan(c30):
    doc = valid("layout_camera__c30")
    payload = assert_error(plan(c30, doc), 8, "analysis_missing")
    assert payload["error"]["ref"] == "camera"
    sha, _path = write_camera(c30["clip"], camera_plan(doc))
    dto = ok(plan(c30, doc))["dto"]
    assert dto["plate"]["plateKey"] == plates.plate_key(doc, camera_sha256=sha)
    assert dto["plate"]["plateKey"] != ok(plan(c30))["dto"]["plate"]["plateKey"]


def test_a_read_only_document_is_planned_with_its_own_words(tmp_path, contexts):
    context = contexts["c30"]
    clip = make_clip(tmp_path, context)
    seed = context.seed
    first = build_plan(seed, words=context.words, camera=None, assets={},
                       resources=Resources(RESOURCES_DIR)).captions.cues[0].words[0]
    # the job re-ran: the seed now names new words, the stored revision the old ones
    words = copy.deepcopy(context.words)
    next(word for word in words["words"] if word["id"] == first.id)["t"] = "diganti"
    new_raw = canonical_bytes(words)
    new_sha = hashlib.sha256(new_raw).hexdigest()
    (clip / f"words.{new_sha[:16]}.json").write_bytes(new_raw)
    new_seed = copy.deepcopy(seed)
    new_seed["base"]["words"]["sha256"] = new_sha
    (clip / "seed.json").chmod(0o600)
    (clip / "seed.json").write_bytes(canonical_bytes(new_seed))
    old = next_doc(seed, fixtures.etag(seed))
    (clip / "edit").mkdir(mode=0o700)
    (clip / "edit" / "doc.json").write_bytes(canonical_bytes(old))
    case = {"root": tmp_path, "seed": seed, "jobId": seed["base"]["job_id"],
            "clipId": seed["clip_id"]}
    dto = ok(plan(case, old))["dto"]
    assert dto["cues"][0]["words"][0] == first.id
    assert dto["cues"][0]["text"].split()[0] == first.text != "diganti"
    new_doc = next_doc(new_seed, fixtures.etag(new_seed))
    assert ok(plan(case, new_doc))["dto"]["cues"][0]["text"].split()[0] == "diganti"


# --- FFmpeg ops on the synthetic job ---------------------------------------------------------------


@pytest.fixture(scope="module")
def job(tmp_path_factory, request):
    request.getfixturevalue("edit_v2_libass")
    return synthetic_job(tmp_path_factory.mktemp("preview-job"))


def job_case(job: dict, index: int = 0) -> dict:
    clip = job["clips"][index]
    seed, _etag = store.seed(clip)
    words = store.load_words(clip, seed["base"]["words"]["sha256"])
    return {"root": job["jobs_root"], "clip": clip, "seed": seed, "words": words,
            "assets": {}, "jobId": job["job_id"], "clipId": clip.name,
            "job_dir": job["job_dir"], "source": job["source"]}


def op(case: dict, name: str, **fields) -> tuple[int, dict]:
    return call(case["root"], op=name, jobId=case["jobId"], clipId=case["clipId"], **fields)


def test_prepare_reports_the_artifacts_and_the_cells_of_the_current_document(job):
    case = job_case(job)
    result = ok(op(case, "prepare", layout=None))
    fps = tm.Fps.from_json(case["seed"]["output"]["fps"])
    assert result["words"] == "ready" and result["camera"] == "not_needed"
    assert result["layout"] == "fit_blur"
    assert result["plateKey"] == plates.plate_key(case["seed"])
    assert result["cellFrames"] == tm.cell_frames(fps)
    assert result["cells"] == list(plates.cells_for_pieces(tm.pieces(case["seed"]), fps))
    assert result["ready"] == [k for k in result["cells"] if (
        case["clip"] / "preview" / "plates" / plates.cell_name(result["plateKey"], k)).exists()]


def test_prepare_builds_the_camera_plan_for_the_face_track_layout(job):
    case = job_case(job, 1)
    doc = with_layout(case["seed"], "camera")
    assert_error(plan(case, doc), 8, "analysis_missing")
    result = ok(op(case, "prepare", layout="camera"))
    assert result["camera"] == "ready" and result["layout"] == "camera"
    files = sorted(case["clip"].glob("camera.*.json"))
    assert len(files) == 1 and stat.S_IMODE(files[0].stat().st_mode) == 0o600
    camera = json.loads(files[0].read_bytes())
    assert camera["window_ms"] == case["seed"]["base"]["window_ms"]
    sha = hashlib.sha256(files[0].read_bytes()).hexdigest()
    assert result["plateKey"] == plates.plate_key(doc, camera_sha256=sha)
    assert ok(plan(case, doc))["dto"]["plate"]["plateKey"] == result["plateKey"]
    again = ok(op(case, "prepare", layout="camera"))  # idempotent: nothing new is written
    assert again["plateKey"] == result["plateKey"]
    assert sorted(case["clip"].glob("camera.*.json")) == files


def test_cells_are_published_once_under_their_plate_key(job):
    case = job_case(job)
    lane = ok(plan(case))["lane"]
    wanted = lane["cells"][:2]
    built = ok(op(case, "cells", layout="fit_blur", cells=wanted, cancelToken=None))
    assert built == {"plateKey": lane["plateKey"], "built": wanted, "present": []}
    for k in wanted:
        path = case["clip"] / "preview" / "plates" / plates.cell_name(lane["plateKey"], k)
        assert path.is_file() and stat.S_IMODE(path.stat().st_mode) == 0o600
        probe = media.probe(path)
        assert (probe["video"]["width"], probe["video"]["height"]) == (720, 1280)
        assert probe["audio"] is None  # plate cells carry no audio
    again = ok(op(case, "cells", layout="fit_blur", cells=wanted, cancelToken=None))
    assert again == {"plateKey": lane["plateKey"], "built": [], "present": wanted}
    dto = ok(plan(case))["dto"]
    states = {cell["k"]: cell["state"] for cell in dto["plate"]["cells"]}
    assert all(states[k] == "ready" for k in wanted)


def test_cells_outside_the_clip_window_are_refused(job):
    case = job_case(job)
    assert_error(op(case, "cells", layout="fit_blur", cells=[9_000_000], cancelToken=None),
                 6, "range_invalid")


def test_a_cancel_marker_stops_a_build_and_publishes_nothing(job):
    case = job_case(job)
    lane = ok(plan(case))["lane"]
    token = "c" * 32
    marker = case["clip"] / "preview" / ".cancel"
    marker.mkdir(mode=0o700, exist_ok=True)
    (marker / token).write_bytes(b"")
    k = lane["cells"][-1]
    assert_error(op(case, "cells", layout="fit_blur", cells=[k], cancelToken=token), 12,
                 "cancelled")
    assert not (case["clip"] / "preview" / "plates" / plates.cell_name(lane["plateKey"],
                                                                        k)).exists()


def test_sigterm_stops_ffmpeg_and_exits_cancelled(job):
    """A lane process told to stop (SIGTERM) kills FFmpeg's own process group and exits 12,
    publishing nothing: python-cli's SIGKILL of the Python group would leave FFmpeg running."""
    import signal
    import time

    case = job_case(job)
    lane = ok(plan(case))["lane"]
    wanted = [k for k in lane["cells"] if not (
        case["clip"] / "preview" / "plates" / plates.cell_name(lane["plateKey"], k)).exists()][:4]
    envelope = {"op": "cells", "jobId": case["jobId"], "clipId": case["clipId"],
                "layout": "fit_blur", "cells": wanted, "cancelToken": None}
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(case["root"]),
           "PYTHONPATH": str(ROOT / "src")}
    process = subprocess.Popen([sys.executable, "-m", "ai_clipper.edit_v2.preview_cli"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env,
                               start_new_session=True)
    process.stdin.write(json.dumps(envelope).encode())
    process.stdin.close()
    deadline = time.monotonic() + 30
    ffmpeg = []
    while time.monotonic() < deadline and not ffmpeg:  # wait until FFmpeg runs
        time.sleep(0.05)
        ffmpeg = [pid for pid in os.listdir("/proc") if pid.isdigit()
                  and _is_child_ffmpeg(int(pid), process.pid)]
    assert ffmpeg, "FFmpeg never started"
    started = time.monotonic()
    os.kill(process.pid, signal.SIGTERM)
    output = process.stdout.read()
    assert process.wait(timeout=10) == 12
    assert time.monotonic() - started < 2.0
    assert json.loads(output)["error"]["code"] == "cancelled"
    time.sleep(0.2)
    assert not any(os.path.exists(f"/proc/{pid}") and _state(int(pid)) != "Z"
                   for pid in ffmpeg), "FFmpeg outlived its lane process"
    for k in wanted:
        assert not (case["clip"] / "preview" / "plates" / plates.cell_name(
            lane["plateKey"], k)).exists()


def _state(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
    except OSError:
        return "Z"


def _is_child_ffmpeg(pid: int, parent: int) -> bool:
    try:
        stat_fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        comm = Path(f"/proc/{pid}/comm").read_text().strip()
    except OSError:
        return False
    return int(stat_fields[1]) == parent and comm in ("ffmpeg", "prlimit")


def reference_pcm(case: dict, doc: dict, tmp_path: Path, loudness=None) -> bytes:
    """The ``reference`` render's s16 PCM of ``doc`` (the final graph before encoding)."""
    words = case["words"]
    built = build_plan(doc, words=words, camera=None, assets=case["assets"],
                       resources=Resources(RESOURCES_DIR))
    job = compile_ffmpeg.compile_job(built, mode="reference", source=case["source"],
                                     assets_root=case["job_dir"] / "analysis" / "assets",
                                     loudness=loudness)
    out = tmp_path / "reference.mkv"
    fd = os.open(out, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(job, output_fd=fd, timeout_s=600)
    finally:
        os.close(fd)
    return media.read_pcm(out).tobytes()


def test_the_preview_mix_is_the_reference_pcm(job, tmp_path):
    case = job_case(job)
    doc = next_doc(case["seed"], store.seed(case["clip"])[1])
    body_seg = doc["main"]["segments"][-1]
    doc["main"]["removals"] = [{"id": "rm_1", "seg": body_seg["id"],
                                "in_sf": body_seg["in_sf"] + 90,
                                "out_sf": body_seg["in_sf"] + 150, "words": [],
                                "reason": "user", "origin": "user"}]
    raw = b64(body(doc))
    result = ok(op(case, "audio", requestRaw=raw, cancelToken=None))
    lane = ok(plan(case, doc))["lane"]
    assert result["audioKey"] == lane["audio"]["key"]
    assert result["built"] is True
    flac = case["clip"] / "preview" / "audio" / result["name"]
    assert result["name"] == f"{result['audioKey'][:16]}.flac"
    pcm = media.read_pcm(flac).tobytes()
    expected = build_plan(doc, words=case["words"], camera=None, assets={},
                          resources=Resources(RESOURCES_DIR))
    assert len(pcm) // 4 == expected.total_samples == result["samples"]
    assert hashlib.md5(pcm).hexdigest() == hashlib.md5(
        reference_pcm(case, doc, tmp_path)).hexdigest()  # P-AUD, server half
    probe = media.probe(flac)["audio"]
    assert (probe["codec_name"], probe["sample_rate"], probe["channels"]) == ("flac", "48000", 2)
    again = ok(op(case, "audio", requestRaw=raw, cancelToken=None))
    assert again["built"] is False and again["name"] == result["name"]
    assert ok(plan(case, doc))["dto"]["audio"]["state"] == "ready"


def test_the_lane_encodes_its_flac_at_the_fastest_level(job):
    """FLAC is lossless: level 0 changes the bytes, never the PCM (P-AUD compares PCM)."""
    case = job_case(job)
    plan_ = build_plan(case["seed"], words=case["words"], camera=None, assets={},
                       resources=Resources(RESOURCES_DIR))
    compiled = compile_ffmpeg.compile_job(plan_, mode="audio_preview", source=case["source"],
                                          assets_root=case["job_dir"] / "analysis" / "assets")
    lane = preview_cli.lane_audio(compiled)
    at = lane.argv.index("flac")
    assert lane.argv[at - 1] == "-c:a" and lane.argv[at + 1:at + 3] == ("-compression_level",
                                                                          "0")
    threads = plates.lane_threads(compiled).argv
    assert lane.argv == threads[:at + 1] + ("-compression_level", "0") + threads[at + 1:]
    with pytest.raises(ValueError):
        preview_cli.lane_audio(compile_ffmpeg.compile_job(
            plan_, mode="audio_measure", source=case["source"],
            assets_root=case["job_dir"] / "analysis" / "assets"))


def test_a_mix_with_music_is_measured_once_and_protected(job, tmp_path):
    case = job_case(job)
    assets = case["job_dir"] / "analysis" / "assets"
    assets.mkdir(exist_ok=True)
    loud = media.AudioSpec(bursts=(media.ToneBurst(0, 60_000, 440, -100),), clicks_ms=())
    music = media.make_audio(tmp_path / "music.m4a", loud, duration_ms=60_000)  # -1 dBFS
    digest = hashlib.sha256(music.read_bytes()).hexdigest()
    (assets / f"{digest}.m4a").write_bytes(music.read_bytes())
    meta = {"kind": "audio", "mime": "audio/mp4", "duration_ms": 60_000, "lufs_c": -1400}
    (assets / f"{digest}.json").write_text(json.dumps(meta))
    asset = f"sha256:{digest}"
    doc = next_doc(case["seed"], store.seed(case["clip"])[1])
    doc["tracks"].append({"id": "tr_mus", "kind": "audio", "role": "music", "items": [{
        "id": "it_music", "type": "audio", "start": {"at": "clip_start"},
        "end": {"at": "clip_end"},
        "payload": {"asset": asset, "src_in_smp": 0, "loop": True, "gain_cdb": 600,
                    "fade_in_f": 15, "fade_out_f": 30,
                    "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30,
                             "release_ms": 400, "hold_ms": 250, "detector": "words"}},
        "origin": "user"}]})
    doc["assets"] = {asset: meta}
    raw = b64(body(doc))
    result = ok(op(case, "audio", requestRaw=raw, cancelToken=None))
    measured = sorted((case["clip"] / "preview" / "audio").glob("*.loudness.json"))
    assert len(measured) == 1
    loudness = json.loads(measured[0].read_text())
    assert set(loudness) == {"i_clufs", "tp_cdb", "mixSha256"}
    assert measured[0].name == f"{loudness['mixSha256'][:16]}.loudness.json"
    assert result["gainCdb"] < 0  # music at +6 dB over the speech: peak protection
    assert any(w["code"].startswith("peak_reduced:") for w in result["warnings"])
    from ai_clipper.edit_v2.loudness import Loudness

    case_with_assets = {**case, "assets": {asset: meta}}
    pcm = media.read_pcm(case["clip"] / "preview" / "audio" / result["name"]).tobytes()
    reference = reference_pcm(case_with_assets, doc, tmp_path,
                              loudness=Loudness(loudness["i_clufs"], loudness["tp_cdb"]))
    assert hashlib.md5(pcm).hexdigest() == hashlib.md5(reference).hexdigest()
    warnings = ok(plan(case, doc))["dto"]["warnings"]
    assert any(w["code"].startswith("peak_reduced:") for w in warnings)
    # another mix of the same pre-master audio (a master setting that mode "off" ignores)
    # reuses the measurement: no second measure pass
    same_premaster = copy.deepcopy(doc)
    same_premaster["audio"]["master"]["target_clufs"] = -1600
    modes = []
    real_run = execute.run

    def counting_run(job_, **kwargs):
        modes.append(job_.expected.get("mode"))
        return real_run(job_, **kwargs)

    execute.run = counting_run
    try:
        again = ok(op(case, "audio", requestRaw=b64(body(same_premaster)), cancelToken=None))
    finally:
        execute.run = real_run
    assert again["built"] is True and again["audioKey"] != result["audioKey"]
    assert modes == ["audio_preview"]
    assert len(sorted((case["clip"] / "preview" / "audio").glob("*.loudness.json"))) == 1
    assert again["gainCdb"] == result["gainCdb"]


def test_the_truth_frame_is_the_compilers_frame_mode_output(job, tmp_path):
    case = job_case(job)
    doc = case["seed"]
    f = 45
    result = ok(op(case, "frame", requestRaw=b64(body(doc, f=f)), cancelToken=None))
    path = case["clip"] / "preview" / "frames" / result["name"]
    assert re.fullmatch(rf"[0-9a-f]{{16}}-{f}-720\.png", result["name"])
    expected_plan_ = build_plan(doc, words=case["words"], camera=None, assets={},
                                resources=Resources(RESOURCES_DIR))
    assert result["planSha256"] == expected_plan_.plan_sha256 and result["built"] is True
    compiled = compile_ffmpeg.compile_job(expected_plan_, mode="frame", frame=f,
                                          source=case["source"],
                                          assets_root=case["job_dir"] / "analysis" / "assets")
    direct = execute.run(compiled, output_fd=None, timeout_s=120).output
    assert path.read_bytes() == direct  # pixel for pixel: the same bytes
    # and within P-ENC of the lossless reference frame (whole frame SSIM >= 0.990)
    reference = compile_ffmpeg.compile_job(expected_plan_, mode="reference",
                                           source=case["source"],
                                           assets_root=case["job_dir"] / "analysis" / "assets")
    ref = tmp_path / "reference.mkv"
    fd = os.open(ref, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(reference, output_fd=fd, timeout_s=600)
    finally:
        os.close(fd)
    # P-ENC's domain (scripts/parity/enc_check.py): BT.709 limited-range 4:4:4 planes
    flags = "flags=accurate_rnd+full_chroma_int+bitexact"
    graph = (f"[1:v]select=eq(n\\,{f}),scale=in_color_matrix=bt709:in_range=tv:"
             f"out_color_matrix=bt709:out_range=tv:{flags},format=yuv444p,setpts=0[r];"
             f"[0:v]scale=out_color_matrix=bt709:out_range=tv:{flags},format=yuv444p,"
             "setpts=0[t];[t][r]ssim")
    out = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
                          "-i", str(ref), "-filter_complex", graph, "-frames:v", "1", "-f",
                          "null", "-"], capture_output=True, text=True, check=True).stderr
    ssim = float(re.search(r"All:([0-9.]+)", out).group(1))
    assert ssim >= 0.990, ssim
    again = ok(op(case, "frame", requestRaw=b64(body(doc, f=f)), cancelToken=None))
    assert again == {**result, "built": False}
    assert_error(op(case, "frame", requestRaw=b64(body(doc, f=expected_plan_.total_frames)),
                    cancelToken=None), 6, "range_invalid")
    assert_error(op(case, "frame", requestRaw=b64(body(doc)), cancelToken=None), 3,
                 "invalid_json")


def test_derived_logos_are_the_exact_box_with_the_opacity_baked_in(job, tmp_path):
    case = job_case(job)
    assets = case["job_dir"] / "analysis" / "assets"
    assets.mkdir(exist_ok=True)
    logo = media.make_logo_png(tmp_path / "logo.png", 256, 128)
    digest = hashlib.sha256(logo.read_bytes()).hexdigest()
    (assets / f"{digest}.png").write_bytes(logo.read_bytes())
    (assets / f"{digest}.json").write_text(json.dumps(
        {"kind": "image", "mime": "image/png", "w": 256, "h": 128}))
    asset = f"sha256:{digest}"
    result = ok(op(case, "derive", asset=asset, w=115, h=58, opacityPm=850, cancelToken=None))
    assert re.fullmatch(r"[0-9a-f]{16}@115x58a850\.png", result["name"]) and result["built"]
    png = (case["clip"] / "preview" / "derived" / result["name"]).read_bytes()
    from ai_clipper.edit_v2.derive import derive_image, png_size

    assert png_size(png) == (115, 58)
    assert png == derive_image(assets / f"{digest}.png", w=115, h=58, opacity_pm=850)
    assert ok(op(case, "derive", asset=asset, w=115, h=58, opacityPm=850,
                 cancelToken=None)) == {**result, "built": False}
    other = ok(op(case, "derive", asset=asset, w=115, h=58, opacityPm=600, cancelToken=None))
    assert other["name"] != result["name"]
    assert_error(op(case, "derive", asset="sha256:" + "0" * 64, w=10, h=10, opacityPm=800,
                    cancelToken=None), 6, "asset_missing")


def test_the_cli_runs_as_a_module_with_its_exit_codes(c30):
    envelope = {"op": "plan", "jobId": c30["jobId"], "clipId": c30["clipId"],
                "requestRaw": b64(body(c30["seed"]))}
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(c30["root"]),
           "PYTHONPATH": str(ROOT / "src")}
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.preview_cli"],
                            input=json.dumps(envelope).encode(), capture_output=True, env=env,
                            check=False, timeout=60)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["dto"]["planSha256"] == expected_plan(c30, c30["seed"]).plan_sha256
    bad = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.preview_cli"],
                         input=b"{}", capture_output=True, env=env, check=False, timeout=60)
    assert bad.returncode == 2
