"""The deploy's quiescence guard (``deploy/production.sh``, ``active_jobs``), run as written.

Every CI deploy, and the "revert PR" rollback, aborts while the guard reports durable work. The
guard's embedded Python is taken from the script unchanged; only its jobs root moves to a
temporary folder. Terminal export states must never count as live work: a cancelled export
stays on disk (retention keeps the newest 200 terminal requests per job), so treating it as
active would block every later deploy until someone deletes files on the server.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from ai_clipper import render_queue

SCRIPT = Path(__file__).resolve().parents[1] / "deploy" / "production.sh"
JOBS_ROOT_LITERAL = 'Path("/data/jobs")'


def _guard_source(root: Path) -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"active_jobs\(\) \{\n[^\n]*python - <<'PY'\n(.*?)\nPY\n\}", text,
                      re.DOTALL)
    assert match, "deploy/production.sh no longer embeds the guard as active_jobs() <<'PY'"
    source = match.group(1)
    assert source.count(JOBS_ROOT_LITERAL) == 1
    return source.replace(JOBS_ROOT_LITERAL, f"Path({str(root)!r})")


def _guard(root: Path) -> object:
    result = subprocess.run(
        [sys.executable, "-"], input=_guard_source(root), capture_output=True, text=True,
        check=True, timeout=60,
    )
    return json.loads(result.stdout)


def _job(root: Path, status: str = "completed") -> Path:
    job = root / str(uuid.uuid4())
    (job / "analysis").mkdir(parents=True)
    (job / "job.json").write_text(json.dumps({"id": job.name, "status": status}))
    return job


def _request(job: Path, state: str) -> str:
    queue = job / "analysis" / "render-requests"
    queue.mkdir(exist_ok=True)
    render_id = str(uuid.uuid4())
    (queue / f"{render_id}.json").write_text(json.dumps(
        {"version": render_queue.V3_VERSION, "render_id": render_id, "state": state}))
    return render_id


def test_a_cancelled_export_does_not_block_a_deploy(tmp_path):
    job = _job(tmp_path)
    _request(job, "completed")
    _request(job, "cancelled")
    (job / "analysis" / "render-requests" / ".queue.lock").touch()
    assert _guard(tmp_path) == []


@pytest.mark.parametrize("state", ["completed", "failed", "cancelled"])
def test_terminal_export_states_are_quiet(tmp_path, state):
    _request(_job(tmp_path), state)
    assert _guard(tmp_path) == []


@pytest.mark.parametrize("state", ["queued", "claimed", "rendering"])
def test_an_export_in_flight_blocks_a_deploy(tmp_path, state):
    render_id = _request(_job(tmp_path), state)
    assert _guard(tmp_path) == [{"kind": "render", "id": render_id, "state": state}]


def test_the_guard_follows_the_queue_states():
    """Every terminal state of render-request-v3 is quiet, every other one is live work."""
    quiet = set(render_queue.V3_TERMINAL)
    assert quiet <= set(render_queue.V3_STATES)
    assert set(render_queue.V3_STATES) - quiet == {"queued", "claimed", "rendering"}
    source = _guard_source(Path("/nonexistent"))
    allowed = re.search(r'if state not in (\{[^}]*\}):', source)
    assert allowed, "the render-request allow-list moved"
    assert set(json.loads(allowed.group(1).replace("{", "[").replace("}", "]"))) == quiet


@pytest.mark.parametrize("status", ["completed", "failed", "deleting"])
def test_finished_or_deleting_jobs_are_quiet(tmp_path, status):
    _job(tmp_path, status)
    assert _guard(tmp_path) == []


@pytest.mark.parametrize("status", ["queued", "running"])
def test_a_running_job_blocks_a_deploy(tmp_path, status):
    job = _job(tmp_path, status)
    assert _guard(tmp_path) == [{"kind": "primary", "id": job.name, "state": status}]


def test_an_unreadable_request_still_blocks_a_deploy(tmp_path):
    """Unreadable durable state fails closed, as before: the guard names the file."""
    queue = _job(tmp_path) / "analysis" / "render-requests"
    queue.mkdir()
    (queue / f"{uuid.uuid4()}.json").write_text("{not json")
    report = _guard(tmp_path)
    assert isinstance(report, dict) and report["errors"][0]["error"] == "JSONDecodeError"
