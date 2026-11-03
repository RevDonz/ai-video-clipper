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
import shlex
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


@pytest.mark.parametrize("status", ["completed", "failed", "deleting", "cancelled"])
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


def _prune(tmp_path: Path, tags: list[str], *, rm_fails: bool = False) -> tuple[list[str], int]:
    """Run prune_old_images as written, against a fake ``docker`` that logs its calls."""
    text = SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"^prune_old_images\(\) \{\n.*?^\}\n", text, re.DOTALL | re.MULTILINE)
    assert match, "deploy/production.sh no longer defines prune_old_images()"
    log = tmp_path / "docker.log"
    fake = tmp_path / "docker"
    listing = " ".join(shlex.quote(tag) for tag in tags)
    fake.write_text(
        "#!/usr/bin/env bash\n"
        f'printf "%s\\n" "$*" >> {str(log)!r}\n'
        f'if [ "$1 $2" = "image ls" ]; then printf "%s\\n" {listing}; exit 0; fi\n'
        f"exit {1 if rm_fails else 0}\n"
    )
    fake.chmod(0o755)
    script = (
        "set -Eeuo pipefail\n"
        f"PATH={str(tmp_path)!r}:$PATH\n"
        "DEPLOY_SHA=new\nrollback_tag=rollback-new\n"
        f"{match.group(0)}\nprune_old_images\n"
    )
    result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60,
                            check=False)
    return log.read_text().splitlines(), result.returncode


def test_a_deploy_drops_old_tags_and_keeps_the_release_and_its_rollback(tmp_path):
    calls, code = _prune(tmp_path, ["new", "rollback-new", "old", "rollback-old", "<none>"])
    assert code == 0
    assert calls[0].startswith("image ls ai-video-clipper ")
    assert calls[1:] == ["image rm ai-video-clipper:old", "image rm ai-video-clipper:rollback-old"]


def test_pruning_with_nothing_old_succeeds(tmp_path):
    calls, code = _prune(tmp_path, ["new", "rollback-new"])
    assert code == 0
    assert len(calls) == 1


def test_an_image_that_cannot_be_removed_does_not_fail_a_verified_deploy(tmp_path):
    calls, code = _prune(tmp_path, ["new", "rollback-new", "old", "older"], rm_fails=True)
    assert code == 0
    assert len(calls) == 3


def test_pruning_runs_only_after_the_release_is_verified_and_never_forces():
    text = SCRIPT.read_text(encoding="utf-8")
    assert text.index("run_read_only_e2e\nrequire_quiescent\n") < text.index("\nprune_old_images ||")
    assert text.index("deployed=0") < text.index("\nprune_old_images ||")
    assert "docker image prune" not in text and "docker system prune" not in text
    function = re.search(r"^prune_old_images\(\) \{\n.*?^\}\n", text, re.DOTALL | re.MULTILINE).group(0)
    assert " -f" not in function and "--force" not in function
