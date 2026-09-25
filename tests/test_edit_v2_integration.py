"""W1 integration (T1.Z): the modules of T1.1–T1.5 connected, without stand-ins.

* String goldens of the **joined** graph (real caption track, real envelopes and audio
  fragment, S-COLOR composite) in ``tests/fixtures/edit_v2/goldens/integration/``; T1.3's own
  goldens keep the stand-ins and pin only the compiler's part. Regenerate after an intended
  change with ``EDIT_V2_UPDATE_GOLDENS=1 uv run pytest tests/test_edit_v2_integration.py``.
* Every fixture seed validates and compiles in every mode.
* The synthetic job goes through ``python -m ai_clipper.edit_v2.api prepare_job`` (the CLI the
  routes call, backed by ``seed.prepare_legacy_job``), its seeds validate, and one clip renders
  and passes ``verify`` with a render key over a ``toolchain.json``.

The full 3 clips × 3 layouts chain with frame and sample checks is the gate script
``scripts/parity/w1_chain.py`` (run in the pinned image).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_compile import fake_probe, render_golden
from test_edit_v2_plan import camera_for, load_doc

from ai_clipper.edit_v2 import compile_ffmpeg, doc, execute, store, toolchain, verify
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.loudness import Loudness
from ai_clipper.edit_v2.plan import Resources, build_plan, render_key, toolchain_sha256

ROOT = Path(__file__).resolve().parents[1]
GOLDENS = ROOT / "tests" / "fixtures" / "edit_v2" / "goldens" / "integration"
SOURCE = Path("/jobs/job-1/source.mp4")
ASSETS_ROOT = Path("/jobs/job-1/analysis/assets")
IMAGE_RESOURCES = Resources(Path("/app/resources"))
DPKG = ("ffmpeg\t7:5.1.9-0+deb12u1\nfontconfig\t2.14.1-4\nlibass9:amd64\t1:0.17.1-1+deb12u1\n"
        "libfreetype6:amd64\t2.12.1+dfsg-5+deb12u4\nlibfribidi0:amd64\t1.0.8-2.1\n"
        "libharfbuzz0b:amd64\t6.0.0+dfsg-3\n")


@pytest.fixture
def probe(monkeypatch):
    state = {}
    monkeypatch.setattr(compile_ffmpeg, "probe_source", lambda path: state["streams"])
    return state


def real_plan(name: str, *, resources: Resources = IMAGE_RESOURCES):
    context = fixtures.load_context(name.rsplit("__", 1)[1])
    document = load_doc(name)
    camera = camera_for(document) if document["layout"]["default"]["mode"] == "camera" else None
    return build_plan(document, words=context.words, camera=camera, assets=context.assets,
                      resources=resources)


GOLDEN_CASES = {
    "final__seed__c30": ("seed__c30", {"mode": "final"}),
    "final__seed__c25": ("seed__c25", {"mode": "final"}),
    "final__full_example__c30": ("full_example__c30",
                                 {"mode": "final", "loudness": Loudness(-1900, -300)}),
    "reference__music__c30": ("music__c30", {"mode": "reference",
                                             "loudness": Loudness(-1650, -40)}),
    "audio_measure__music__c30": ("music__c30", {"mode": "audio_measure"}),
    "audio_preview__full_example__c30": ("full_example__c30",
                                         {"mode": "audio_preview",
                                          "loudness": Loudness(-1900, -300)}),
    "frame__seed__c24": ("seed__c24", {"mode": "frame", "frame": 40}),
    "plate_cells__seed__c25": ("seed__c25", {"mode": "plate_cells", "cells": (300, 301)}),
}


@pytest.mark.parametrize("golden", sorted(GOLDEN_CASES))
def test_joined_graph_goldens(probe, golden):
    name, kwargs = GOLDEN_CASES[golden]
    plan = real_plan(name)
    probe["streams"] = fake_probe(plan.doc)
    job = compile_ffmpeg.compile_job(plan, source=SOURCE, assets_root=ASSETS_ROOT, **kwargs)
    text = render_golden(job)
    path = GOLDENS / f"{golden}.txt"
    if os.environ.get("EDIT_V2_UPDATE_GOLDENS") == "1":
        GOLDENS.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    assert path.is_file(), f"missing golden {path.name} (EDIT_V2_UPDATE_GOLDENS=1 writes it)"
    assert text == path.read_text(encoding="utf-8"), golden


def test_no_stale_integration_goldens():
    assert {path.stem for path in GOLDENS.glob("*.txt")} == set(GOLDEN_CASES)


def test_the_real_modules_are_in_the_graph(probe):
    plan = real_plan("full_example__c30")
    probe["streams"] = fake_probe(plan.doc)
    job = compile_ffmpeg.compile_job(plan, mode="final", source=SOURCE, assets_root=ASSETS_ROOT,
                                     loudness=Loudness(-1650, 50))
    graph = job.filter_script
    assert "format=gbrp,ass=filename=captions.ass:fontsdir=fonts:shaping=complex" in graph
    assert "amultiply" in graph and "amix=inputs=2:normalize=0:duration=first" in graph
    assert "atrim=start_pts=" in graph and ",pan=stereo|FL=FL+FC|FR=FR+FC,asetpts" in graph
    ass = job.sidecars["captions.ass"].decode("utf-8")
    assert ass == plan.ass and "Style: Bold" in ass  # the pack of the full example
    assert "audio-speech.f32" in job.sidecars and "audio-music.f32" in job.sidecars
    # peak protection of a hot measurement (+0.50 dBTP): down to -1.0 dBTP minus the 1.0 dB
    # encode headroom (loudness.ENCODE_HEADROOM_CDB)
    assert job.expected["gain_cdb"] == -250
    assert "[apre]volume=-2.50dB,aresample=48000," in graph
    assert [w["code"] for w in job.expected["warnings"]] == ["peak_reduced:-2.50 dB"]


@pytest.mark.parametrize("context_id", fixtures.CONTEXT_IDS)
def test_every_fixture_seed_validates_and_compiles_in_every_mode(probe, context_id):
    context = fixtures.load_context(context_id)
    seed = context.seed
    validation = doc.validate_doc(seed, words=context.words, assets=context.assets, seed=seed)
    assert validation.ok, validation.errors
    plan = real_plan(f"seed__{context_id}")
    probe["streams"] = fake_probe(plan.doc)
    assert doc.content_equals_seed(plan.doc, seed)
    size = tm.cell_frames(plan.fps)
    kwargs = {"final": {}, "reference": {}, "audio_preview": {}, "audio_measure": {},
              "frame": {"frame": plan.total_frames - 1},
              "plate_cells": {"cells": (plan.pieces[0].in_sf // size,)}}
    for mode, extra in kwargs.items():
        job = compile_ffmpeg.compile_job(plan, mode=mode, source=SOURCE, assets_root=ASSETS_ROOT,
                                         **extra)
        assert job.argv[0] == "ffmpeg", mode


# --- the synthetic job through the API CLI -------------------------------------------------------


def _make_job_module():
    name = "editor_fixture_make_job"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "scripts" / "editor_fixture" / "make_job.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def api(jobs_root: Path, envelope: dict) -> tuple[int, dict]:
    env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8",
           "JOBS_ROOT": str(jobs_root), "PYTHONPATH": str(ROOT / "src")}
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.api"],
                            input=json.dumps(envelope).encode(), capture_output=True, env=env,
                            timeout=600, check=False)
    return result.returncode, json.loads(result.stdout or b"{}")


@pytest.fixture(scope="module")
def synthetic_jobs(tmp_path_factory):
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        pytest.skip("ffmpeg/ffprobe not available")
    out = tmp_path_factory.mktemp("synthetic-jobs")
    index = _make_job_module().build(out, size=(320, 180), only=["main", "old", "stranded", "v1"])
    return out, index


def test_prepare_job_through_the_api_cli(synthetic_jobs):
    out, index = synthetic_jobs
    jobs_root = out / "jobs"
    main = index["jobs"]["main"]
    code, before = api(jobs_root, {"op": "clips", "jobId": main["id"]})
    assert code == 0 and [clip["reason"] for clip in before["clips"]] == ["needs_prepare"] * 3
    code, prepared = api(jobs_root, {"op": "prepare_job", "jobId": main["id"]})
    assert code == 0, prepared
    assert prepared["state"] == "done"
    assert [clip["openable"] for clip in prepared["clips"]] == [True, True, True]
    code, again = api(jobs_root, {"op": "prepare_job", "jobId": main["id"]})
    assert code == 0 and again == prepared  # idempotent
    code, listing = api(jobs_root, {"op": "clips", "jobId": main["id"]})
    assert code == 0
    assert [(clip["openable"], clip["edit"]["state"], clip["engine"])
            for clip in listing["clips"]] == [(True, "seed", "legacy")] * 3
    for clip in prepared["clips"]:
        code, edit = api(jobs_root, {"op": "get", "jobId": main["id"], "clipId": clip["clipId"]})
        assert code == 0 and edit["isSeed"] and not edit["readOnly"], edit
        clip_dir = out / main["dir"] / "analysis" / "clips" / clip["clipId"]
        words = store.load_words(clip_dir, edit["doc"]["base"]["words"]["sha256"])
        validation = doc.validate_doc(edit["doc"], words=words, assets={}, seed=edit["seed"])
        assert validation.ok, validation.errors  # T1.5's gate: every seed passes T1.1
        assert edit["notices"] == ["legacy_engine"]
    code, old = api(jobs_root, {"op": "prepare_job", "jobId": index["jobs"]["old"]["id"]})
    assert code == 0 and [clip["openable"] for clip in old["clips"]] == [True, True, True]
    code, stranded = api(jobs_root, {"op": "prepare_job", "jobId": index["jobs"]["stranded"]["id"]})
    assert code == 0 and {clip["reason"] for clip in stranded["clips"]} == {"analysis_incomplete"}
    code, v1 = api(jobs_root, {"op": "clips", "jobId": index["jobs"]["v1"]["id"]})
    assert code == 0 and {clip["reason"] for clip in v1["clips"]} == {"not_v3"}


def test_a_prepared_clip_renders_verifies_and_has_a_render_key(synthetic_jobs, tmp_path):
    out, index = synthetic_jobs
    main = index["jobs"]["main"]
    code, prepared = api(out / "jobs", {"op": "prepare_job", "jobId": main["id"]})
    assert code == 0
    job_dir = out / main["dir"]
    clip = prepared["clips"][1]
    clip_dir = job_dir / "analysis" / "clips" / clip["clipId"]
    seed_doc, _etag = store.seed(clip_dir)
    words = store.load_words(clip_dir, seed_doc["base"]["words"]["sha256"])
    resources = tmp_path / "resources"
    shutil.copytree(RESOURCES_DIR, resources, ignore=shutil.ignore_patterns("toolchain.json"))
    toolchain.write(resources / "toolchain.json", apt_snapshot="20260924T000000Z",
                    base_image="node:20-bookworm-slim@sha256:" + "2c" * 32, dpkg_output=DPKG)
    plan = build_plan(seed_doc, words=words, camera=None, assets={},
                      resources=Resources(resources))
    key = render_key(plan, size=plan.output, quality="standar", measure_sha=None,
                     toolchain_sha=toolchain_sha256(Resources(resources)))
    assert len(key) == 64
    job = compile_ffmpeg.compile_job(plan, mode="final", source=out / main["source"],
                                     assets_root=job_dir / "analysis" / "assets")
    output = tmp_path / "clip.mp4"
    fd = os.open(output, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(job, output_fd=fd, timeout_s=900)
    finally:
        os.close(fd)
    fd = os.open(output, os.O_RDONLY)
    try:
        report = verify.verify_output(fd, plan, size=plan.output, normalize=False)
    finally:
        os.close(fd)
    assert report.ok
    gates = {gate.name: gate.to_json() for gate in report.gates}
    assert gates["G1"]["ok"] and gates["G2"]["ok"]
    assert hashlib.sha256(job.sidecars["captions.ass"]).hexdigest() == plan.ass_sha256


# --- source edges ---------------------------------------------------------------------------------
# A document that validates must render every planned frame, also at the first and the last
# frame of the source (W1 verifier: a body ending at sf_ceil(duration_ms) rendered 150 of 151
# frames; a video starting at 0.041 s has no grid frame 0).

EDGE_WORDS = {"schema": "potongin.words/1", "words": [], "units": [], "bounds": [], "gaps": [],
              "events": [], "silences": [], "scene_cuts_ms": [], "missing": []}
EDGE_JOB = {"id": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "seedAtMs": 0,
            "options": {"renderMode": "center-crop", "captionStyle": "classic",
                        "coldOpen": False, "hookOverlay": False, "selectionMode": "v3"}}
EDGE_CASES = {
    # 902 frames at 29.97 (30,096.73 ms): the clip runs to the end of the source
    "end_29.97": (dict(fps=(30000, 1001), frames=902), "end"),
    # the video starts 41 ms after the audio: the clip starts at t = 0
    "delayed_23.976": (dict(fps=(24000, 1001), frames=240, video_delay_ms=41), "start"),
}


def _edge_clip(start_s: float, end_s: float):
    from ai_clipper.selection_types import SCORE_DIMENSIONS, SelectedClip

    return SelectedClip(
        rank=1, start=start_s, end=end_s, cold_open=None, unit_ids=("S0001", "S0002"),
        hook_unit_id="S0001", title="Tepi", hook_text="Tepi sumber", description="",
        hashtags=(), archetype="story_twist", score=7.0,
        scores={name: 7.0 for name in SCORE_DIMENSIONS}, reasons=("tepi",), source="heuristic",
        text="tepi sumber")


@pytest.mark.parametrize("case", sorted(EDGE_CASES))
def test_a_seed_at_the_source_edges_renders_every_planned_frame(case, edit_v2_media_factory,
                                                                tmp_path):
    from support import edit_v2_media as media

    from ai_clipper.edit_v2 import seed, source_info

    options, edge = EDGE_CASES[case]
    path = edit_v2_media_factory(media.VideoSpec(width=320, height=180, **options))
    probe = source_info.probe_source(path)
    info = {"content_sha256": source_info.file_sha256(path), "probe": probe}
    start_s = 25.0 if edge == "end" else 0.0
    seed_doc = seed.build_seed(
        clip=_edge_clip(start_s, probe["duration_ms"] / 1000), job=EDGE_JOB, source_info=info,
        words_sha=hashlib.sha256(fixtures.canonical_bytes(EDGE_WORDS)).hexdigest(),
        words_count=0, camera_sha=None, selection_sha="c" * 64)
    fps = tm.Fps.from_json(seed_doc["output"]["fps"])
    first, end = source_info.grid_range(probe, fps)
    body = seed_doc["main"]["segments"][-1]
    if edge == "end":
        assert body["out_sf"] == end == options["frames"]
    else:
        assert body["in_sf"] == first == 1
    assert doc.validate_doc(seed_doc, words=EDGE_WORDS, assets={}, seed=None).ok
    beyond = json.loads(json.dumps(seed_doc))
    if edge == "end":
        beyond["main"]["segments"][-1]["out_sf"] = end + 1
    else:
        beyond["main"]["segments"][-1]["in_sf"] = first - 1
    codes = {issue.code for issue in doc.validate_doc(beyond, words=EDGE_WORDS, assets={},
                                                       seed=None).errors}
    assert "outside_window" in codes
    plan = build_plan(seed_doc, words=EDGE_WORDS, camera=None, assets={},
                      resources=Resources(RESOURCES_DIR))
    job = compile_ffmpeg.compile_job(plan, mode="final", source=path,
                                     assets_root=tmp_path / "assets")
    output = tmp_path / "edge.mp4"
    fd = os.open(output, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(job, output_fd=fd, timeout_s=600)
    finally:
        os.close(fd)
    fd = os.open(output, os.O_RDONLY)
    try:
        report = verify.verify_output(fd, plan, size=plan.output, normalize=False)
    finally:
        os.close(fd)
    gates = {gate.name: gate.to_json() for gate in report.gates}
    assert gates["G2"]["ok"], gates["G2"]
    assert report.ok
