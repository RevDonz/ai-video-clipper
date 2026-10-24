"""``scripts/perf/plate_invalidation.py``: the after-janitor figure comes from a janitor run."""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from ai_clipper.edit_v2 import janitor

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "perf" / "plate_invalidation.py"


def _module():
    spec = importlib.util.spec_from_file_location("plate_invalidation", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _cell(clip: Path, name: str, size: int) -> Path:
    directory = clip / "preview" / "plates"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(b"x" * size)
    return path


def test_the_janitor_drops_the_old_cells_and_keeps_the_new_ones(tmp_path):
    module = _module()
    job = tmp_path / "job"
    clip = job / "analysis" / "clips" / ("clip_" + "a" * 24)
    old = [_cell(clip, "old-0.mp4", 300), _cell(clip, "old-1.mp4", 200)]
    new = [_cell(clip, "new-0.mp4", 300), _cell(clip, "new-1.mp4", 200)]
    now_ms = 1_800_000_000_000
    for path in new:
        os.utime(path, (now_ms / 1000, now_ms / 1000))

    result = module.janitor_pass(job, [clip], old, now_ms=now_ms)

    assert result["plates_bytes"] == 500
    assert result["cache_files"] == 2 and result["cache_bytes"] == 500
    assert not any(path.exists() for path in old)
    assert all(path.exists() for path in new)


def test_the_old_cells_are_aged_past_the_idle_limit_by_mtime_and_atime(tmp_path):
    module = _module()
    clip = tmp_path / "job" / "analysis" / "clips" / ("clip_" + "b" * 24)
    path = _cell(clip, "old.mp4", 10)
    now_ms = 1_800_000_000_000

    module.age_unused(path, now_ms=now_ms)

    info = path.stat()
    assert now_ms - max(info.st_mtime, info.st_atime) * 1000 > janitor.CACHE_IDLE_MS
