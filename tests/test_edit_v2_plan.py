"""Render plan: resolution, plan hash (R9 inputs), render key and resources (plan §5.1, §5.2).

``caption_track`` (T1.2a) and the envelopes (T1.4) are consumed through their Appendix A
contracts; until the integrator connects them these tests use the deterministic stand-ins of
``scripts/parity/frame_identity.py`` (the same ones the gate script uses).
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import (
    COMPILER_VERSION,
    PACK_IDS,
    RENDER_SEMANTICS,
    captions,
    envelope,
    errors,
)
from ai_clipper.edit_v2 import doc as doc_module
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.plan import (
    PLAN_SCHEMA,
    RENDER_KEY_PREFIX,
    LogoPlacement,
    RenderPlan,
    Resources,
    build_plan,
    render_key,
    srt_text,
    toolchain_sha256,
)

ROOT = Path(__file__).resolve().parents[1]
DOCS = fixtures.DOC_FIXTURES_DIR
TOOLCHAIN_JSON = {
    "schema": "potongin.toolchain/1",
    "base_image": "node:20-bookworm-slim@sha256:" + "ab" * 32,
    "packages": {
        "ffmpeg": "7:5.1.9-0+deb12u1",
        "libass9": "1:0.17.1-1",
        "libfreetype6": "2.12.1+dfsg-5+deb12u4",
        "libharfbuzz0b": "6.0.0+dfsg-3",
        "libfribidi0": "1.0.8-2.1",
        "fontconfig": "2.14.1-4",
    },
}


def load_harness():
    name = "edit_v2_frame_identity"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "scripts" / "parity" / "frame_identity.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


HARNESS = load_harness()


@pytest.fixture
def harness(monkeypatch):
    for module, name, function in HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    return HARNESS


def write_resources(root: Path) -> Resources:
    """A resources/ tree as the image ships it (fonts.json, packs, hook design, toolchain.json).

    ``toolchain.json`` is written by the image build (T1.Z, plan E10); this is its test fixture.
    """
    (root / "fonts").mkdir(parents=True)
    (root / "fonts" / "fonts.json").write_text(
        json.dumps({"fonts": [{"file": "DejaVuSans.ttf", "sha256": "0" * 64}]}), encoding="utf-8")
    (root / "fontconfig").mkdir()
    (root / "fontconfig" / "fonts.conf").write_text("<fontconfig/>\n", encoding="utf-8")
    for pack in PACK_IDS:
        (root / "caption-packs" / pack).mkdir(parents=True)
        (root / "caption-packs" / pack / "v1.json").write_text(
            json.dumps({"id": pack, "v": 1}), encoding="utf-8")
    (root / "hook-designs" / "legacy-bar").mkdir(parents=True)
    (root / "hook-designs" / "legacy-bar" / "v1.json").write_text(
        json.dumps({"id": "legacy-bar", "v": 1}), encoding="utf-8")
    (root / "toolchain.json").write_text(json.dumps(TOOLCHAIN_JSON, indent=2) + "\n",
                                         encoding="utf-8")
    return Resources(root)


@pytest.fixture
def resources(tmp_path) -> Resources:
    return write_resources(tmp_path / "resources")


def load_doc(name: str) -> dict:
    return json.loads((DOCS / "valid" / f"{name}.json").read_text(encoding="utf-8"))


def context_for(name: str) -> fixtures.Context:
    return fixtures.load_context(name.rsplit("__", 1)[1])


def camera_for(doc: dict) -> dict:
    source = doc["base"]["source"]
    return HARNESS.make_camera(source["duration_ms"], tuple(doc["output"]["fps"]),
                               (source["w"], source["h"]),
                               (doc["output"]["w"], doc["output"]["h"]))


def plan_for(name: str, resources: Resources, *, doc: dict | None = None, words=None,
             camera="auto") -> RenderPlan:
    context = context_for(name)
    doc = load_doc(name) if doc is None else doc
    if camera == "auto":
        camera = camera_for(doc) if doc["layout"]["default"]["mode"] == "camera" else None
    return build_plan(doc, words=context.words if words is None else words, camera=camera,
                      assets=context.assets, resources=resources)


PLAN_CASES = (
    "seed__c30",
    "seed__c25",
    "seed__c24",
    "full_example__c30",
    "removals_many__c30",
    "removal_leaves_sliver__c30",
    "cold_open_added__c25",
    "logo_wide__c24",
    "music__c30",
    "layout_camera__c30",
    "captions_disabled__c30",
)


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


# --- the frozen fields ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", PLAN_CASES)
def test_frozen_fields_equal_the_time_map(harness, resources, name):
    context = context_for(name)
    doc = load_doc(name)
    plan = plan_for(name, resources, doc=doc)
    reference = fixtures.make_render_plan(doc, context.words)
    assert plan.doc == doc
    assert plan.fps == reference.fps
    assert plan.output == reference.output
    assert plan.pieces == reference.pieces
    assert plan.total_frames == reference.total_frames
    assert plan.total_samples == tm.smp(plan.total_frames, plan.fps)
    assert plan.speech_spans == reference.speech_spans
    assert plan.assets == doc["assets"]
    assert len(plan.plan_sha256) == 64


def test_plan_carries_the_caption_track_and_resource_hashes(harness, resources):
    plan = plan_for("full_example__c30", resources)
    expected = harness.harness_caption_track(plan.doc, context_for("full_example__c30").words,
                                             plan.pieces)
    assert plan.captions == expected
    assert plan.ass == expected.ass
    assert plan.ass_sha256 == expected.ass_sha256
    assert plan.fonts_sha256 == hashlib.sha256(
        (resources.root / "fonts" / "fonts.json").read_bytes()).hexdigest()
    assert len(plan.packs_sha256) == 64
    assert plan.resources == resources
    assert plan.words_sha256 == sha(context_for("full_example__c30").words)
    assert plan.content_sha256 == sha(
        {k: v for k, v in plan.doc.items() if k not in ("revision", "parent_sha256", "audit")})


def test_plan_sha_is_the_hash_of_its_json(harness, resources):
    plan = plan_for("full_example__c30", resources)
    body = plan.to_json()
    assert body["schema"] == PLAN_SCHEMA
    assert "plan_sha256" not in body and "planSha256" not in body
    assert plan.plan_sha256 == hashlib.sha256(canonical(body)).hexdigest()
    assert body["render_semantics"] == RENDER_SEMANTICS
    assert body["content_sha256"] == plan.content_sha256
    assert body["pieces"] == [piece.to_dto() for piece in plan.pieces]
    assert body["ass_sha256"] == plan.ass_sha256


def test_to_json_works_on_a_fixture_built_plan():
    context = fixtures.load_context("c30")
    plan = fixtures.make_render_plan(load_doc("seed__c30"), context.words)
    body = plan.to_json()
    assert body["total_frames"] == plan.total_frames
    assert body["ass_sha256"] is None


# --- plan_sha256: what it covers and what it ignores --------------------------------------------


def test_plan_sha_ignores_revision_parent_and_audit(harness, resources):
    doc = load_doc("full_example__c30")
    first = plan_for("full_example__c30", resources, doc=doc)
    other = copy.deepcopy(doc)
    other["revision"] = 17
    other["parent_sha256"] = "f" * 64
    other["audit"].update(updated_at_ms=other["audit"]["updated_at_ms"] + 99_000,
                          editor="editor-v3/9.9.9", last_command="SetHookText")
    second = plan_for("full_example__c30", resources, doc=other)
    assert second.plan_sha256 == first.plan_sha256
    assert second.content_sha256 == first.content_sha256


def test_the_seed_and_an_unchanged_revision_share_the_plan(harness, resources):
    seed = plan_for("seed__c30", resources)
    unchanged = plan_for("rev1_unchanged__c30", resources)
    assert seed.plan_sha256 == unchanged.plan_sha256


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda d: d["main"].__setitem__("cut_fade_ms", 9), id="cut_fade"),
        pytest.param(lambda d: d["captions"]["overrides"].__setitem__("y_e5", 80000), id="caption_y"),
        pytest.param(lambda d: d["layout"]["default"].__setitem__("mode", "fill_center"),
                     id="layout"),
        pytest.param(lambda d: d["main"]["segments"][1].__setitem__(
            "out_sf", d["main"]["segments"][1]["out_sf"] - 30), id="trim"),
        pytest.param(lambda d: d["audio"]["source"].__setitem__("gain_cdb", -300), id="gain"),
    ],
)
def test_plan_sha_covers_the_content(harness, resources, mutate):
    doc = load_doc("full_example__c30")
    first = plan_for("full_example__c30", resources, doc=doc)
    other = copy.deepcopy(doc)
    mutate(other)
    assert plan_for("full_example__c30", resources, doc=other).plan_sha256 != first.plan_sha256


def test_plan_sha_covers_words_camera_ass_and_envelopes(harness, resources, monkeypatch):
    name = "layout_camera__c30"
    doc = load_doc(name)
    words = context_for(name).words
    camera = camera_for(doc)
    base = plan_for(name, resources, doc=doc, camera=camera).plan_sha256

    other_words = copy.deepcopy(words)
    other_words["transcript_sha256"] = "e" * 64
    assert plan_for(name, resources, doc=doc, words=other_words, camera=camera).plan_sha256 != base

    other_camera = copy.deepcopy(camera)
    other_camera["samples"][5][1] += 40
    assert plan_for(name, resources, doc=doc, camera=other_camera).plan_sha256 != base

    real_track = harness.harness_caption_track

    def other_ass(doc, words, pieces):
        result = real_track(doc, words, pieces)
        ass = result.ass + "Comment: 0,0:00:00.00,0:00:00.01,Default,,0,0,0,,x\n"
        return dataclasses.replace(result, ass=ass,
                                   ass_sha256=hashlib.sha256(ass.encode()).hexdigest())

    monkeypatch.setattr(captions, "caption_track", other_ass)
    assert plan_for(name, resources, doc=doc, camera=camera).plan_sha256 != base
    monkeypatch.setattr(captions, "caption_track", real_track)

    monkeypatch.setattr(envelope, "speech_envelope",
                        lambda pieces, joins, cut_fade_ms, fps, gain_cdb: ((0, 999_999),))
    assert plan_for(name, resources, doc=doc, camera=camera).plan_sha256 != base


def test_music_envelope_is_part_of_the_plan(harness, resources, monkeypatch):
    base = plan_for("music__c30", resources)
    assert base.music is not None and base.music["id"] == "it_music"
    assert base.music_envelope == harness.harness_music_envelope(
        base.speech_spans, base.music, base.total_samples, base.fps)
    monkeypatch.setattr(envelope, "music_envelope",
                        lambda spans, item, total, fps: ((0, 1), (total, 2)))
    assert plan_for("music__c30", resources).plan_sha256 != base.plan_sha256


def test_envelope_arguments_follow_the_document(resources, monkeypatch, harness):
    seen = {}

    def spy(pieces, joins, cut_fade_ms, fps, gain_cdb):
        seen.update(pieces=pieces, joins=dict(joins), cut_fade_ms=cut_fade_ms, fps=fps,
                    gain_cdb=gain_cdb)
        return ((0, 1_000_000),)

    monkeypatch.setattr(envelope, "speech_envelope", spy)
    doc = load_doc("join_fade_250__c30")
    plan = plan_for("join_fade_250__c30", resources, doc=doc)
    assert seen == {"pieces": plan.pieces, "joins": {"seg_co": 250}, "cut_fade_ms": 8,
                    "fps": plan.fps, "gain_cdb": 0}


def test_build_plan_is_deterministic_in_process(harness, resources):
    first = plan_for("full_example__c30", resources)
    second = plan_for("full_example__c30", resources)
    assert first == second
    assert canonical(first.to_json()) == canonical(second.to_json())


def test_build_plan_is_deterministic_across_processes(harness, resources):
    """G-DET: another interpreter (another hash seed) yields the same plan hash and JSON."""
    plan = plan_for("full_example__c30", resources)
    code = (
        "import json, sys, importlib.util\n"
        "from pathlib import Path\n"
        "spec = importlib.util.spec_from_file_location('h', sys.argv[1])\n"
        "h = importlib.util.module_from_spec(spec); sys.modules['h'] = h\n"
        "spec.loader.exec_module(h)\n"
        "h.install_harness()\n"
        "from support import edit_v2_fixtures as f\n"
        "from ai_clipper.edit_v2.plan import Resources, build_plan\n"
        "ctx = f.load_context('c30')\n"
        "doc = json.loads(Path(sys.argv[2]).read_text())\n"
        "p = build_plan(doc, words=ctx.words, camera=None, assets=ctx.assets,\n"
        "               resources=Resources(Path(sys.argv[3])))\n"
        "print(p.plan_sha256)\n"
    )
    env = dict(os.environ, PYTHONPATH=os.pathsep.join([str(ROOT / "src"), str(ROOT / "tests")]),
               PYTHONHASHSEED="4242")
    output = subprocess.run(
        [sys.executable, "-c", code, str(ROOT / "scripts" / "parity" / "frame_identity.py"),
         str(DOCS / "valid" / "full_example__c30.json"), str(resources.root)],
        capture_output=True, text=True, env=env, check=True, timeout=120,
    ).stdout.strip()
    assert output == plan.plan_sha256


# --- resolution details -------------------------------------------------------------------------


def test_logo_placement_uses_the_frozen_logo_box(harness, resources):
    plan = plan_for("logo_wide__c24", resources)
    item = next(t for t in plan.doc["tracks"] if t["kind"] == "visual")["items"][0]
    meta = context_for("logo_wide__c24").assets[item["payload"]["asset"]]
    x0, y0, w, h = tm.logo_box(
        x_e5=item["transform"]["x_e5"], y_e5=item["transform"]["y_e5"],
        w_e5=item["transform"]["w_e5"], asset_w=meta["w"], asset_h=meta["h"],
        out_w=plan.output[0], out_h=plan.output[1])
    assert plan.logo == LogoPlacement(asset=item["payload"]["asset"], x=x0, y=y0, w=w, h=h,
                                      opacity_pm=item["transform"]["opacity_pm"])
    assert plan.to_json()["logo"] == {"asset": item["payload"]["asset"], "x": x0, "y": y0,
                                      "w": w, "h": h, "opacity_pm": item["transform"]["opacity_pm"]}


def test_plans_without_logo_or_music(harness, resources):
    plan = plan_for("seed__c30", resources)
    assert plan.logo is None and plan.music is None and plan.music_envelope is None


def test_camera_layout_needs_a_camera_plan(harness, resources):
    with pytest.raises(errors.AnalysisMissing) as caught:
        plan_for("layout_camera__c30", resources, camera=None)
    assert caught.value.code == "analysis_missing"
    assert caught.value.ref == "camera"


def test_other_layouts_ignore_a_camera_plan(harness, resources):
    doc = load_doc("seed__c30")
    with_camera = plan_for("seed__c30", resources, camera=camera_for(doc))
    assert with_camera.plan_sha256 == plan_for("seed__c30", resources).plan_sha256
    assert with_camera.camera is None


def test_an_asset_missing_from_the_store_is_rejected(harness, resources):
    context = context_for("logo__c30")
    doc = load_doc("logo__c30")
    store = {k: v for k, v in context.assets.items() if k not in doc["assets"]}
    with pytest.raises(errors.DocSemanticInvalid) as caught:
        build_plan(doc, words=context.words, camera=None, assets=store, resources=resources)
    assert caught.value.code == "asset_missing"


def test_no_face_spans_become_warnings_with_output_frames(harness, resources):
    name = "layout_camera__c30"
    doc = load_doc(name)
    camera = camera_for(doc)
    fps = tm.Fps.from_json(doc["output"]["fps"])
    body = doc["main"]["segments"][1]
    start_ms = body["in_sf"] * 1000 * fps.den // fps.num + 2000
    camera["no_face"] = [[start_ms, start_ms + 2500]]
    plan = plan_for(name, resources, doc=doc, camera=camera)
    faces = [issue for issue in plan.warnings if issue.code == "no_face"]
    assert len(faces) == 1
    piece = next(p for p in plan.pieces if p.seg == "seg_b1")
    expected_f = piece.out_f0 + tm.sf_floor(start_ms, fps) - piece.in_sf
    assert faces[0].f == expected_f
    assert faces[0].path == "/layout/default/mode"


def test_no_face_is_only_reported_for_the_camera_layout(harness, resources):
    doc = load_doc("seed__c30")
    plan = plan_for("seed__c30", resources, camera=camera_for(doc))
    assert not [issue for issue in plan.warnings if issue.code == "no_face"]


def test_caption_warnings_are_carried(harness, resources, monkeypatch):
    real = harness.harness_caption_track
    issue = doc_module.Issue("hook_overflow", "/tracks/0/items/0/payload/text", ref="it_hook")
    monkeypatch.setattr(captions, "caption_track",
                        lambda d, w, p: dataclasses.replace(real(d, w, p), warnings=(issue,)))
    plan = plan_for("seed__c30", resources)
    assert issue in plan.warnings


def test_logo_in_the_ui_zone_is_reported(harness, resources):
    plan = plan_for("logo__c30", resources)  # top-right corner, inside the TikTok UI zone
    zones = [issue for issue in plan.warnings if issue.code == "unsafe_zone"]
    assert [issue.ref for issue in zones] == ["it_logo"]


def test_srt_text_uses_frame_times():
    fps = tm.Fps(30000, 1001)
    word = SimpleNamespace
    cues = (
        SimpleNamespace(f0=0, f1=45, seg="seg_b1",
                        words=(word(text="Halo"), word(text="semua"))),
        SimpleNamespace(f0=107892, f1=107900, seg="seg_b1", words=(word(text="akhir"),)),
    )
    assert srt_text(cues, fps) == (
        "1\n00:00:00,000 --> 00:00:01,502\nHalo semua\n\n"
        "2\n00:59:59,996 --> 01:00:00,263\nakhir\n"  # 107892·1001/30 = 3599996.4 ms
    )
    assert srt_text((), fps) == ""


def test_plan_srt_follows_its_caption_cues(harness, resources, monkeypatch):
    real = harness.harness_caption_track
    cue = SimpleNamespace(f0=3, f1=33, seg="seg_b1", words=(SimpleNamespace(text="Ijal"),))
    monkeypatch.setattr(captions, "caption_track",
                        lambda d, w, p: dataclasses.replace(real(d, w, p), cues=(cue,)))
    plan = plan_for("seed__c30", resources)
    assert plan.srt() == "1\n00:00:00,100 --> 00:00:01,101\nIjal\n"


# --- render key (R9) --------------------------------------------------------------------------------


def expected_key(plan, *, size, quality, measure_sha, toolchain_sha):
    parts = [plan.plan_sha256, COMPILER_VERSION, str(RENDER_SEMANTICS), toolchain_sha,
             plan.fonts_sha256, plan.packs_sha256, f"{size[0]}x{size[1]}", quality,
             measure_sha or "-"]
    return hashlib.sha256(RENDER_KEY_PREFIX + "\0".join(parts).encode("ascii")).hexdigest()


def test_render_key_composition(harness, resources):
    plan = plan_for("full_example__c30", resources)
    toolchain = toolchain_sha256(resources)
    assert RENDER_KEY_PREFIX == b"potongin-render-v1\0"
    for measure in (None, "c" * 64):
        key = render_key(plan, size=(720, 1280), quality="standar", measure_sha=measure,
                         toolchain_sha=toolchain)
        assert key == expected_key(plan, size=(720, 1280), quality="standar",
                                   measure_sha=measure, toolchain_sha=toolchain)
    keys = {
        render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                   toolchain_sha=toolchain),
        render_key(plan, size=(720, 1280), quality="standar", measure_sha="c" * 64,
                   toolchain_sha=toolchain),
        render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                   toolchain_sha="d" * 64),
        render_key(dataclasses.replace(plan, fonts_sha256="1" * 64), size=(720, 1280),
                   quality="standar", measure_sha=None, toolchain_sha=toolchain),
        render_key(dataclasses.replace(plan, packs_sha256="2" * 64), size=(720, 1280),
                   quality="standar", measure_sha=None, toolchain_sha=toolchain),
        render_key(dataclasses.replace(plan, plan_sha256="3" * 64), size=(720, 1280),
                   quality="standar", measure_sha=None, toolchain_sha=toolchain),
    }
    assert len(keys) == 6


def test_render_key_rejects_invalid_inputs(harness, resources):
    plan = plan_for("seed__c30", resources)
    good = {"size": (720, 1280), "quality": "standar", "measure_sha": None,
            "toolchain_sha": "a" * 64}
    for bad in (
        {"size": (1080, 1920)},  # Essentials: the document's output size only
        {"size": (719, 1280)},
        {"quality": "tinggi"},
        {"measure_sha": "xyz"},
        {"toolchain_sha": "A" * 64},
        {"toolchain_sha": ""},
    ):
        with pytest.raises(ValueError):
            render_key(plan, **{**good, **bad})


def test_render_key_needs_the_resource_hashes():
    context = fixtures.load_context("c30")
    plan = fixtures.make_render_plan(load_doc("seed__c30"), context.words)
    with pytest.raises(ValueError, match="resources"):
        render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                   toolchain_sha="a" * 64)


def test_toolchain_sha_reads_resources_toolchain_json(resources):
    data = (resources.root / "toolchain.json").read_bytes()
    assert toolchain_sha256(resources) == hashlib.sha256(data).hexdigest()
    (resources.root / "toolchain.json").write_text("{}", encoding="utf-8")
    assert toolchain_sha256(resources) == hashlib.sha256(b"{}").hexdigest()


def test_a_missing_toolchain_json_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        toolchain_sha256(Resources(tmp_path))


def test_resource_files_move_the_render_key(harness, resources):
    plan = plan_for("seed__c30", resources)
    before = render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                        toolchain_sha=toolchain_sha256(resources))
    (resources.root / "fonts" / "fonts.json").write_text('{"fonts": [1]}', encoding="utf-8")
    fonts_changed = plan_for("seed__c30", resources)
    assert fonts_changed.plan_sha256 == plan.plan_sha256
    assert fonts_changed.fonts_sha256 != plan.fonts_sha256
    pack = plan.doc["captions"]["pack"]["id"]
    (resources.root / "caption-packs" / pack / "v1.json").write_text('{"x": 1}', encoding="utf-8")
    pack_changed = plan_for("seed__c30", resources)
    assert pack_changed.packs_sha256 != fonts_changed.packs_sha256
    after = render_key(pack_changed, size=(720, 1280), quality="standar", measure_sha=None,
                       toolchain_sha=toolchain_sha256(resources))
    assert after != before


def test_a_pack_that_the_document_does_not_use_does_not_move_the_key(harness, resources):
    plan = plan_for("seed__c30", resources)  # karaoke
    (resources.root / "caption-packs" / "box" / "v1.json").write_text("{}", encoding="utf-8")
    assert plan_for("seed__c30", resources).packs_sha256 == plan.packs_sha256


def test_missing_resource_files_leave_the_hashes_unset(harness, tmp_path):
    plan = plan_for("seed__c30", Resources(tmp_path / "empty"))
    assert plan.fonts_sha256 is None and plan.packs_sha256 is None
    with pytest.raises(ValueError, match="resources"):
        render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                   toolchain_sha="a" * 64)


# --- R10 content identity (doc.content_equals_seed, T1.1) ------------------------------------


def _content_equals_seed():
    try:
        doc_module.content_equals_seed({"a": 1}, {"a": 1})
    except NotImplementedError:
        pytest.skip("doc.content_equals_seed is T1.1's; connected by the W1 integrator")
    return doc_module.content_equals_seed


def test_content_equals_seed_vectors():
    equals = _content_equals_seed()
    for context_id in fixtures.CONTEXT_IDS:
        seed = fixtures.load_context(context_id).seed
        unchanged = load_doc(f"rev1_unchanged__{context_id}")
        assert equals(unchanged, seed)
        assert equals(seed, seed)
        touched = copy.deepcopy(unchanged)
        touched["audit"]["last_command"] = "Undo"
        touched["revision"] = 40
        assert equals(touched, seed)
    seed = fixtures.load_context("c30").seed
    for name in ("removal_single__c30", "cut_fade_0__c30", "hook_removed__c30",
                 "pack_bold__c30", "logo__c30"):
        assert not equals(load_doc(name), seed), name


def test_content_equality_agrees_with_the_plan_hash(harness, resources):
    equals = _content_equals_seed()
    seed = fixtures.load_context("c30").seed
    seed_plan = plan_for("seed__c30", resources)
    for name in ("rev1_unchanged__c30", "removal_single__c30", "pack_bold__c30"):
        same_plan = plan_for(name, resources).plan_sha256 == seed_plan.plan_sha256
        assert equals(load_doc(name), seed) == same_plan, name
