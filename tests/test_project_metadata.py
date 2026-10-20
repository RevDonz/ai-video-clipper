"""The project's package name in pyproject.toml and uv.lock.

`uv sync --frozen` (Dockerfile, CI) installs the project from the lock's editable root, so the two
names must match.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict[str, object]:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_project_is_named_ai_video_clipper() -> None:
    project = _pyproject()["project"]
    assert project["name"] == "ai-video-clipper"
    assert "spike" not in project["description"].lower()


def test_lock_root_matches_the_project_name() -> None:
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    roots = [
        package["name"]
        for package in lock["package"]
        if package.get("source") == {"editable": "."}
    ]
    assert roots == [_pyproject()["project"]["name"]]
