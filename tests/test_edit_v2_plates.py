"""Plate cells of the preview lane: keys, names, cell sets, camera plans, lane threads, builds
(plan §3.4 "Plate cells", §4.1 ``preview/plates``, §5.1 ``plate_cells``, §2.6, T2.3).

The FFmpeg tests run on the synthetic V3 job of ``scripts/editor_fixture/make_job.py`` (a 180 s
barcode + column-ruler source at 29.97, seeded through ``seed.prepare_legacy_job``).
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import make_clip

from ai_clipper.edit_v2 import compile_ffmpeg, errors, plates, store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.camera import camera_file_name, encode_camera_plan
from ai_clipper.edit_v2.compile_ffmpeg import FfmpegJob, InputSpec
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources
from ai_clipper.edit_v2.timemap import Fps, Piece

ROOT = Path(__file__).resolve().parents[1]
KEY = "ab" * 32


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def with_layout(doc: dict, layout: str) -> dict:
    changed = copy.deepcopy(doc)
    changed["layout"]["default"]["mode"] = layout
    return changed


def camera_plan(doc: dict, **changes) -> dict:
    """A valid camera plan (``potongin.camera-plan/1``) for ``doc``'s window, fps and output."""
    window = doc["base"]["window_ms"]
    plan = {
        "schema": "potongin.camera-plan/1",
        "source_content_sha256": doc["base"]["source"]["content_sha256"],
        "window_ms": list(window),
        "fps": list(doc["output"]["fps"]),
        "source": {"w": doc["base"]["source"]["w"], "h": doc["base"]["source"]["h"]},
        "output": {"w": doc["output"]["w"], "h": doc["output"]["h"]},
        "sample_ms": 750,
        "samples": [[window[0], 400], [window[1], 600]],
        "cuts": [False, False],
        "no_face": [],
    }
    plan.update(changes)
    return plan


def write_camera(clip: Path, plan: dict) -> tuple[str, Path]:
    raw = encode_camera_plan(plan)
    path = clip / camera_file_name(raw)
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), path


# --- keys and names ------------------------------------------------------------------------------


def test_plate_key_is_a_sha256_that_ignores_edits_which_do_not_change_plate_pixels(contexts):
    seed = contexts["c30"].seed
    key = plates.plate_key(seed)
    assert len(key) == 64 and int(key, 16) >= 0
    assert plates.plate_key(copy.deepcopy(seed)) == key
    edited = copy.deepcopy(seed)
    edited["revision"] = 7
    edited["parent_sha256"] = "1" * 64
    edited["audit"]["updated_at_ms"] += 99
    edited["main"]["segments"][-1]["out_sf"] -= 30  # a trim
    edited["main"]["removals"] = [{"id": "rm_1", "seg": "seg_b1", "in_sf": 37300,
                                   "out_sf": 37330, "words": [], "reason": "user",
                                   "origin": "user"}]
    edited["captions"]["pack"] = {"id": "bold", "v": 1}
    edited["tracks"] = []
    edited["audio"]["source"]["gain_cdb"] = 600
    assert plates.plate_key(edited) == key


@pytest.mark.parametrize("change", [
    lambda d: d["layout"]["default"].update(mode="fill_center"),
    lambda d: d["output"].update(fps=[25, 1]),
    lambda d: d["output"].update(w=1080, h=1920),
    lambda d: d["base"]["source"].update(content_sha256="c" * 64),
    lambda d: d["base"].update(window_ms=[d["base"]["window_ms"][0] + 1000,
                                          d["base"]["window_ms"][1]]),
])
def test_plate_key_changes_with_what_the_plate_pixels_depend_on(contexts, change):
    seed = contexts["c30"].seed
    changed = copy.deepcopy(seed)
    change(changed)
    assert plates.plate_key(changed) != plates.plate_key(seed)


def test_plate_key_names_the_camera_plan_and_the_toolchain(contexts):
    seed = contexts["c30"].seed
    camera = with_layout(seed, "camera")
    assert plates.plate_key(camera, camera_sha256="1" * 64) != plates.plate_key(
        camera, camera_sha256="2" * 64)
    # a camera plan means nothing to the other layouts
    assert plates.plate_key(seed, camera_sha256="1" * 64) == plates.plate_key(seed)
    assert plates.plate_key(seed, toolchain_sha256="3" * 64) != plates.plate_key(seed)
    with pytest.raises(ValueError):
        plates.plate_key(camera)  # the camera layout needs its plan
    with pytest.raises(ValueError):
        plates.plate_key(seed, toolchain_sha256="nope")


def test_cell_names_are_flat_content_keyed_names():
    assert plates.cell_name(KEY, 0) == "abababababababab-c0000000.mp4"
    assert plates.cell_name(KEY, 620) == "abababababababab-c0000620.mp4"
    assert plates.CELL_FILE.fullmatch(plates.cell_name(KEY, 9_999_999))
    for key, k in ((KEY, -1), (KEY, 10_000_000), (KEY, True), ("AB" * 32, 1), ("ab", 1)):
        with pytest.raises(ValueError):
            plates.cell_name(key, k)


# --- cells of a document -------------------------------------------------------------------------


def piece(i: int, in_sf: int, out_sf: int, out_f0: int) -> Piece:
    return Piece(i, "seg_b1", "body", in_sf, out_sf, out_f0, out_sf - in_sf)


def test_cells_cover_every_piece_once_in_output_order():
    fps = Fps(30000, 1001)  # 60 frames per cell
    pieces = (piece(0, 120, 200, 0), piece(1, 30, 50, 80), piece(2, 205, 300, 100))
    assert plates.cells_for_pieces(pieces, fps) == (2, 3, 0, 4)
    assert plates.cells_for_pieces((piece(0, 60, 120, 0),), fps) == (1,)
    assert plates.cells_for_pieces((piece(0, 59, 61, 0),), fps) == (0, 1)
    assert plates.cells_for_pieces((piece(0, 100, 150, 0),), Fps(25, 1)) == (2,)
    assert plates.cells_for_pieces((piece(0, 96, 97, 0),), Fps(24000, 1001)) == (2,)
    assert plates.cells_for_pieces((), fps) == ()


def test_cells_of_the_fixture_seed_match_the_time_map(contexts):
    seed = contexts["c30"].seed
    fps = Fps.from_json(seed["output"]["fps"])
    size = tm.cell_frames(fps)
    expected = []
    for p in tm.pieces(seed):
        for k in range(p.in_sf // size, (p.out_sf - 1) // size + 1):
            if k not in expected:
                expected.append(k)
    assert plates.cells_for_pieces(tm.pieces(seed), fps) == tuple(expected)


# --- camera plans ----------------------------------------------------------------------------------


def test_layouts_without_a_camera_need_no_plan(tmp_path, contexts):
    clip = make_clip(tmp_path, contexts["c30"])
    assert plates.camera_for(clip, contexts["c30"].seed) == (None, None)


def test_the_camera_plan_named_by_the_document_is_used(tmp_path, contexts):
    doc = with_layout(contexts["c30"].seed, "camera")
    clip = make_clip(tmp_path, contexts["c30"])
    sha, _path = write_camera(clip, camera_plan(doc))
    other_sha, _other = write_camera(clip, camera_plan(doc, samples=[[doc["base"]["window_ms"][0],
                                                                      100]], cuts=[False]))
    doc["base"]["camera"]["sha256"] = other_sha
    plan, found = plates.camera_for(clip, doc)
    assert found == other_sha and plan["samples"][0][1] == 100
    assert sha != other_sha


def test_a_matching_camera_plan_is_found_when_the_seed_named_none(tmp_path, contexts):
    doc = with_layout(contexts["c30"].seed, "camera")
    assert doc["base"]["camera"]["sha256"] is None
    clip = make_clip(tmp_path, contexts["c30"])
    window = doc["base"]["window_ms"]
    for bad in (camera_plan(doc, window_ms=[window[0] + 1, window[1]]),
                camera_plan(doc, fps=[25, 1]),
                camera_plan(doc, output={"w": 1080, "h": 1920}),
                camera_plan(doc, source_content_sha256="d" * 64),
                camera_plan(doc, schema="potongin.camera-plan/9")):
        write_camera(clip, bad)
    (clip / ("camera." + "0" * 16 + ".json")).write_bytes(b"{not json")
    with pytest.raises(errors.AnalysisMissing) as missing:
        plates.camera_for(clip, doc)
    assert missing.value.ref == "camera"
    first, _ = write_camera(clip, camera_plan(doc))
    second, _ = write_camera(clip, camera_plan(doc, no_face=[[window[0], window[0] + 2000]]))
    plan, found = plates.camera_for(clip, doc)
    assert found == min((first, second), key=lambda sha: sha[:16])  # deterministic: by name
    assert plan["schema"] == "potongin.camera-plan/1"


def test_a_symlinked_or_misnamed_camera_plan_is_ignored(tmp_path, contexts):
    doc = with_layout(contexts["c30"].seed, "camera")
    clip = make_clip(tmp_path, contexts["c30"])
    raw = encode_camera_plan(camera_plan(doc))
    outside = tmp_path / "outside.json"
    outside.write_bytes(raw)
    os.symlink(outside, clip / camera_file_name(raw))
    # a name that is not the sha of its bytes (the files are immutable and content-named)
    (clip / ("camera." + "e" * 16 + ".json")).write_bytes(raw)
    with pytest.raises(errors.AnalysisMissing):
        plates.camera_for(clip, doc)
    named = with_layout(doc, "camera")
    named["base"]["camera"]["sha256"] = hashlib.sha256(raw).hexdigest()
    with pytest.raises(errors.AnalysisMissing):
        plates.camera_for(clip, named)  # the named plan is the symlink: refused too


# --- lane threads --------------------------------------------------------------------------------


def fake_job() -> FfmpegJob:
    argv = ("ffmpeg", "-nostdin", "-threads", "4", "-ss", "1.0", "-i", "@in:0",
            "-filter_complex_script", "filter_graph.txt", "-filter_complex_threads", "4",
            "-map", "[cell0]", "-c:v", "libx264", "-x264-params", "threads=4",
            "-threads", "4", "c%07d.mp4")
    return FfmpegJob(argv=argv, filter_script="", inputs=(InputSpec("source", "source"),),
                     sidecars={}, expected={"output": "cells"})


def test_lane_jobs_use_two_threads_everywhere():
    capped = plates.lane_threads(fake_job())
    assert capped.argv == ("ffmpeg", "-nostdin", "-threads", "2", "-ss", "1.0", "-i", "@in:0",
                           "-filter_complex_script", "filter_graph.txt",
                           "-filter_complex_threads", "2", "-map", "[cell0]", "-c:v",
                           "libx264", "-x264-params", "threads=2", "-threads", "2",
                           "c%07d.mp4")
    assert capped.filter_script == "" and capped.expected == {"output": "cells"}
    with_offset = fake_job()
    argv = list(with_offset.argv)
    argv[argv.index("threads=4")] = "threads=4:chroma-qp-offset=-12"
    capped = plates.lane_threads(FfmpegJob(tuple(argv), "", with_offset.inputs, {}, {}))
    assert "threads=2:chroma-qp-offset=-12" in capped.argv


def test_lane_threads_refuses_a_job_it_does_not_recognise():
    job = fake_job()
    argv = tuple(a for a in job.argv if a not in ("-filter_complex_threads",))
    with pytest.raises(ValueError):
        plates.lane_threads(FfmpegJob(argv, "", job.inputs, {}, {}))
    with pytest.raises(ValueError):
        plates.lane_threads(job, threads=0)


# --- source resolution ---------------------------------------------------------------------------


def test_the_source_is_a_regular_file_inside_the_job_input(tmp_path):
    job = tmp_path / "job"
    (job / "input").mkdir(parents=True)
    source = job / "input" / "source.mp4"
    source.write_bytes(b"video")
    (job / "job.json").write_text(json.dumps({"sourcePath": "/elsewhere/input/source.mp4"}))
    assert plates.source_path(job) == source
    (job / "job.json").write_text(json.dumps({"sourcePath": str(source)}))
    assert plates.source_path(job) == source
    outside = tmp_path / "other.mp4"
    outside.write_bytes(b"x")
    (job / "job.json").write_text(json.dumps({"sourcePath": str(outside)}))
    with pytest.raises(errors.NotFound):
        plates.source_path(job)
    source.unlink()
    os.symlink(outside, source)
    (job / "job.json").write_text(json.dumps({"sourcePath": "source.mp4"}))
    with pytest.raises(errors.NotFound):
        plates.source_path(job)
    (job / "job.json").write_text("[]")
    with pytest.raises(errors.NotFound):
        plates.source_path(job)


# --- FFmpeg ----------------------------------------------------------------------------------------


def _load_make_job():
    name = "editor_fixture_make_job"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "scripts" / "editor_fixture" / "make_job.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def synthetic_job(root: Path) -> dict:
    """The synthetic ``main`` job (320×180 barcode, 29.97, fit-blur, karaoke, cold open, hook),
    prepared: ``{jobs_root, job_id, job_dir, source, clips: [clip_dir…]}``."""
    make_job = _load_make_job()
    index = make_job.build(root, size=(320, 180), only=["main"])
    entry = index["jobs"]["main"]
    job_dir = root / entry["dir"]
    from ai_clipper.edit_v2 import seed as seed_module

    prepared = seed_module.prepare_legacy_job(job_dir)
    clips = [job_dir / "analysis" / "clips" / clip["clip_id"] for clip in prepared]
    return {"jobs_root": root / "jobs", "job_id": entry["id"], "job_dir": job_dir,
            "source": root / entry["source"], "clips": clips}


@pytest.fixture(scope="module")
def job(tmp_path_factory, request):
    request.getfixturevalue("edit_v2_libass")
    return synthetic_job(tmp_path_factory.mktemp("plates-job"))


def keyframes(path: Path) -> list[int]:
    rows = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "frame=key_frame", "-of", "csv=p=0", str(path)],
                          capture_output=True, text=True, check=True).stdout.split()
    return [i for i, row in enumerate(rows) if row.startswith("1")]


def test_cells_are_built_with_the_lane_threads_and_exact_frames(job, tmp_path):
    clip = job["clips"][0]
    seed, _etag = store.seed(clip)
    fps = Fps.from_json(seed["output"]["fps"])
    size = tm.cell_frames(fps)
    wanted = plates.cells_for_pieces(tm.pieces(seed), fps)[:3]
    plan = plates.plate_plan(seed, camera=None, resources=Resources(RESOURCES_DIR))
    compiled = compile_ffmpeg.compile_job(plan, mode="plate_cells", source=job["source"],
                                          assets_root=job["job_dir"] / "analysis" / "assets",
                                          cells=wanted)
    assert "threads=4" in compiled.argv  # the compiler's default, capped by the lane
    built = plates.build_cells(plan, source=job["source"],
                               assets_root=job["job_dir"] / "analysis" / "assets",
                               cells=wanted, timeout_s=300)
    assert sorted(built) == sorted(wanted)
    for k, data in built.items():
        path = tmp_path / f"{k}.mp4"
        path.write_bytes(data)
        frames = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams",
                                 "v:0", "-show_entries", "stream=nb_read_frames,width,height",
                                 "-of", "csv=p=0", str(path)], capture_output=True, text=True,
                                check=True).stdout.strip().split(",")
        assert frames == ["720", "1280", str(size)]
        assert keyframes(path) == [0]


def test_a_cancelled_build_publishes_nothing(job):
    clip = job["clips"][0]
    seed, _etag = store.seed(clip)
    fps = Fps.from_json(seed["output"]["fps"])
    plan = plates.plate_plan(seed, camera=None, resources=Resources(RESOURCES_DIR))
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(errors.Cancelled):
        plates.build_cells(plan, source=job["source"],
                           assets_root=job["job_dir"] / "analysis" / "assets",
                           cells=plates.cells_for_pieces(tm.pieces(seed), fps)[:1],
                           cancel=cancel, timeout_s=60)
