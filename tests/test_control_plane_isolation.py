"""Python stays out of the control plane (rombak 01 §1.3).

The render worker has no mount of /control and no DB path, so a bug there cannot reach the DB, the
backups or the sealed settings. In the app and primary containers the volume is physically
visible to a Python child; the guarantee there is the child's environment plus this static check:
no module of the engine knows the DB, the path or the variable.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from support.workflow_yaml import load

REPO = Path(__file__).resolve().parents[1]
SOURCE = REPO / "src" / "ai_clipper"
FORBIDDEN = (
    re.compile(r"^\s*(?:import|from)\s+sqlite3\b", re.MULTILINE),
    re.compile(r"""["']/control(?:/|["'])"""),
    re.compile(r"POTONGIN_DB_PATH"),
    re.compile(r"potongin\.sqlite"),
)


def _compose() -> dict:
    return load((REPO / "compose.yaml").read_text(encoding="utf-8"))


def _mounts(service: str) -> list[str]:
    return [str(entry) for entry in _compose()["services"][service].get("volumes", [])]


def test_no_engine_module_knows_the_control_plane():
    findings = []
    modules = sorted(SOURCE.rglob("*.py"))
    assert len(modules) > 50, "the walker found the engine"
    for module in modules:
        text = module.read_text(encoding="utf-8")
        findings.extend(
            f"{module.relative_to(REPO)}: {pattern.pattern}"
            for pattern in FORBIDDEN
            if pattern.search(text)
        )
    assert findings == []


def test_the_patterns_catch_what_they_name():
    for line in ("import sqlite3", "from sqlite3 import connect", 'path = "/control/x"',
                 "os.environ['POTONGIN_DB_PATH']", "open('potongin.sqlite')"):
        assert any(pattern.search(line) for pattern in FORBIDDEN), line
    assert not any(pattern.search("# controls the /data dir, control flow") for pattern in FORBIDDEN)


def test_render_worker_has_no_way_to_open_control():
    service = _compose()["services"]["render-worker"]
    assert _mounts("render-worker") == ["clipper_data:/data"]
    for name in ("POTONGIN_DB_PATH", "POTONGIN_SETTINGS_DIR", "POTONGIN_SETTINGS_SECRET",
                 "APP_SESSION_SECRET", "APP_PASSWORD"):
        assert name not in service["environment"], name
    assert "/control" not in str(service)


def test_only_app_and_primary_worker_mount_the_control_volume():
    services = _compose()["services"]
    holders = {name for name in services if any("potongin_control" in m for m in _mounts(name))}
    assert holders == {"app", "primary-worker"}
    for name in holders:
        assert "potongin_control:/control" in _mounts(name), name


def test_the_python_children_of_the_app_never_get_the_db_path():
    allowlist = (REPO / "web" / "lib" / "python-cli.mjs").read_text(encoding="utf-8")
    block = re.search(r"CHILD_ENV_ALLOWLIST = Object\.freeze\(\[(.*?)\]\)", allowlist, re.DOTALL)
    assert block, "python-cli.mjs no longer has the allowlist"
    for name in ("POTONGIN_DB_PATH", "POTONGIN_SETTINGS_SECRET", "APP_SESSION_SECRET", "NODE_OPTIONS"):
        assert name not in block.group(1), name


def test_the_primary_worker_strips_the_db_path_for_run_job():
    worker = (REPO / "web" / "scripts" / "primary-worker.mjs").read_text(encoding="utf-8")
    assert "POTONGIN_DB_PATH: _dbPath" in worker
    assert "env: runnerEnv(env," in worker


def test_only_the_web_ships_sqlite_for_the_control_plane():
    """The boundary test of the other side: nothing the render worker spawns loads web/lib/db."""
    result = subprocess.run(
        ["git", "grep", "-l", "lib/db/", "--", "web/scripts/render-storage-admission.mjs",
         "web/lib/render-storage-admission.mjs", "web/lib/storage-admission.mjs"],
        cwd=REPO, capture_output=True, text=True, check=False,
    )
    assert result.stdout.strip() == ""
