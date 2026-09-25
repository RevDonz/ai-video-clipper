"""T2.Z (W2 integrator): the Python seams between the phase-B modules (plan §11.2 T2.Z).

Each test pins one patch logged in ``docs/editor/GATES.md`` ("Patches by the W2 integrator"):
the worker's default renderer is T2.1's ``render_edit.render_request`` and an edited revision
exports through it (T2.2 R4); the API process no longer imports the analysis stack (T2.2 R5,
PF-SAVE); the font manifest is read once per process (T2.3, PF-PLAN); the codes the Node routes
answer with have Indonesian messages (T2.3).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace

from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import next_doc
from test_render_queue import V3_TOOLCHAIN
from test_render_worker import _make_job_module

from ai_clipper import render_worker
from ai_clipper.edit_v2 import api as edit_api
from ai_clipper.edit_v2 import compile_ffmpeg, errors, glyphs
from ai_clipper.edit_v2 import store as edit_store
from ai_clipper.edit_v2.compile_ffmpeg import decoder_runs, select_expression
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources
from ai_clipper.render_queue import create_request_v3, get_request
from ai_clipper.render_worker import run_one

ROOT = Path(__file__).resolve().parents[1]


def test_the_api_process_does_not_import_the_analysis_stack():
    """``get``/``put`` never need ``seed`` or ``selection_v3`` (PF-SAVE, T2.2 request R5)."""
    code = ("import sys, ai_clipper.edit_v2.api as api; "
            "print(sorted(m for m in ('ai_clipper.edit_v2.seed', 'ai_clipper.selection_v3')"
            " if m in sys.modules))")
    env = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env,
                         check=True, timeout=60).stdout.strip()
    assert out == "[]"


def test_the_font_manifest_is_read_once_for_many_lookups():
    glyphs._manifest_text.cache_clear()
    glyphs._listed_fonts.cache_clear()
    for _ in range(200):
        assert glyphs.font_path("DejaVuSans.ttf") == glyphs.FONTS_DIR / "DejaVuSans.ttf"
    assert glyphs._manifest_text.cache_info().misses == 1
    assert glyphs._listed_fonts.cache_info().misses == 1
    first = glyphs.fonts_manifest()
    first["fonts"].clear()  # a caller changing its copy never changes the next one
    assert glyphs.fonts_manifest()["fonts"]


def test_every_route_code_has_an_indonesian_message():
    assert errors.ROUTE_CODES >= {
        "invalid_request", "csrf_rejected", "rate_limited", "backend_unavailable", "superseded",
        "editor_disabled", "storage_quota_exhausted", "storage_free_space_low",
        "storage_admission_unavailable", "render_finished", "not_cancellable",
    }
    for code in errors.ROUTE_CODES:
        message = errors.message(code)
        assert message and message == message.strip()
        assert errors.message_id(code) == f"edit.{code}"


def test_the_worker_maps_a_reused_render_to_its_completion():
    """``RenderResult.reused`` (T2.1) names how the worker completed the request (T2.2)."""
    assert render_worker._completed_by(SimpleNamespace(reused="auto_file")) == "seed"
    assert render_worker._completed_by(SimpleNamespace(reused="existing")) == "key"
    assert render_worker._completed_by(SimpleNamespace(reused=None)) == "render"
    assert render_worker._completed_by(SimpleNamespace(completed_by="key", reused=None)) == "key"
    assert render_worker._completed_by(object()) == "render"


def test_an_edited_revision_exports_through_the_default_renderer(edit_v2_libass, tmp_path):
    """The queue's request (T2.2) is accepted by T2.1's ``render_request`` as the worker calls
    it by default: the MP4 and its SRT are published under the render key."""
    out = tmp_path / "synthetic"
    index = _make_job_module().build(out, size=(320, 180), only=["main"])
    main = index["jobs"]["main"]
    jobs_root = out / "jobs"
    status, prepared = edit_api.handle(
        json.dumps({"op": "prepare_job", "jobId": main["id"]}).encode(), jobs_root=jobs_root)
    assert status == 0, prepared
    clip_id = prepared["clips"][1]["clipId"]
    job_dir = out / main["dir"]
    clip = job_dir / "analysis" / "clips" / clip_id
    seed_doc, seed_etag = edit_store.seed(clip)
    resources_dir = tmp_path / "resources"
    shutil.copytree(RESOURCES_DIR, resources_dir, ignore=shutil.ignore_patterns("toolchain.json"))
    (resources_dir / "toolchain.json").write_text(json.dumps(V3_TOOLCHAIN, indent=2) + "\n")
    current = next_doc(seed_doc, seed_etag, main__cut_fade_ms=20)
    _saved, etag, _warnings = edit_store.put(
        clip, expected_etag=seed_etag, idempotency_key=str(uuid.uuid4()),
        raw=canonical_bytes(current), now_ms=fixtures.PUT_NOW_MS)
    request = create_request_v3(job_dir, clip_id, etag, str(uuid.uuid4()),
                                resources=Resources(resources_dir))
    assert request["state"] == "queued", request
    assert run_one(jobs_root) == request["render_id"]
    final = get_request(job_dir, request["render_id"])
    assert (final["state"], final["completed_by"], final["error_code"]) == \
        ("completed", "render", None), final
    output = job_dir / final["output_relative"]
    assert output.stat().st_size > 0
    assert output.with_suffix(".srt").read_text().startswith("1\n")


def test_a_decoder_run_of_several_pieces_ends_at_its_last_frame(monkeypatch):
    """R2's ``select`` never ends a stream by itself: without a bound FFmpeg decodes the whole
    rest of the source (a 66 min real source after a removal: ``render_stalled`` at 98 %, the
    W2 e2e flow). The run is bounded by ``trim`` to ``[first in_sf, last out_sf)`` before
    ``select``, which keeps the same grid frames (``pts`` is the grid index after ``fps``)."""
    import test_edit_v2_compile as compile_tests

    for module, name, function in compile_tests.HARNESS.HARNESS_PATCHES:
        monkeypatch.setattr(module, name, function)
    probe = {}
    monkeypatch.setattr(compile_ffmpeg, "probe_source", lambda _path: probe["streams"])
    plan, job = compile_tests.compiled("removals_many__c30", probe, mode="final")
    num, den = plan.fps.num, plan.fps.den
    runs = [run for run in decoder_runs(plan.pieces, plan.fps) if len(run) > 1]
    assert runs
    for run in runs:
        ranges = [(plan.pieces[i].in_sf, plan.pieces[i].out_sf) for i in run]
        bounded = (f"fps={num}/{den},trim=start_pts={ranges[0][0]}:end_pts={ranges[-1][1]},"
                   f"select='{select_expression(ranges)}',setpts=N")
        assert bounded in job.filter_script, run
