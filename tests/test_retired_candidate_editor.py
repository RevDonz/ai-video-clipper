"""The candidate editor is retired (owner decision 2026-09-30; plan §11.4 T4.1 as changed by the
owner): its backend modules are gone, the render queue and worker keep only the clip-edit
exports, and the editor's store no longer imports the selection code it carried along."""

import importlib.util
import inspect
import subprocess
import sys

import pytest

from ai_clipper import render_queue, render_worker

RETIRED_MODULES = (
    "ai_clipper.editor_api",
    "ai_clipper.edit_manifest",
    "ai_clipper.render_manifest",
    "ai_clipper.candidate_api",
    "ai_clipper.candidate_cues",
    "ai_clipper.candidate_feedback",
)


@pytest.mark.parametrize("name", RETIRED_MODULES)
def test_the_candidate_editor_modules_are_gone(name):
    assert importlib.util.find_spec(name) is None


def test_the_render_queue_keeps_no_candidate_request_api():
    for name in ("create_request", "update_request", "publish_completed_output", "process",
                 "estimate_source_bytes"):
        assert not hasattr(render_queue, name), name
    assert render_queue.RETIRED_VERSIONS == frozenset({"render-request-v1", "render-request-v2"})


def test_the_render_worker_renders_clip_exports_only():
    parameters = inspect.signature(render_worker.run_one).parameters
    assert "renderer" not in parameters and "verifier" not in parameters
    assert "renderer_v3" in parameters
    for name in ("render_from_manifest", "_verify_existing", "_output_parent", "_heartbeat_loop"):
        assert not hasattr(render_worker, name), name


def test_the_editor_backend_imports_no_selection_or_ranking_code():
    code = ("import sys, ai_clipper.edit_v2.store, ai_clipper.edit_v2.api, ai_clipper.render_queue, "
            "ai_clipper.render_worker; "
            "print(' '.join(sorted(m for m in sys.modules if m.startswith('ai_clipper.'))))")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                            check=True, timeout=60)
    loaded = set(result.stdout.split())
    assert "ai_clipper.render_queue" in loaded and "ai_clipper.job_files" in loaded
    for name in ("ai_clipper.ranking", "ai_clipper.candidates", "ai_clipper.features",
                 "ai_clipper.media_features", *RETIRED_MODULES):
        assert name not in loaded, name
