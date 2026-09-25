"""Revision 0 (the seed) of a V3 clip, and the prepare step for older jobs (plan §3.5, §4.4).

Owner: T1.5 (T4.1 adds ``seed_from_candidate``). Stub landed by T1.0 with the frozen Appendix A
signatures. The seed is written once as ``analysis/clips/<clip_id>/seed.json`` (canonical,
immutable, 0600); ``base.seed_sha256`` is defined in docs/editor/CONTRACTS.md.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..selection_types import SelectedClip


def build_seed(
    *,
    clip: SelectedClip,
    job: Mapping,
    source_info: Mapping,
    words_sha: str,
    words_count: int,
    camera_sha: str | None,
    selection_sha: str,
) -> dict:
    """The seed document of ``clip`` following every row of the plan §3.5 table."""
    raise NotImplementedError("T1.5: edit_v2.seed.build_seed (plan §3.5)")


def prepare_legacy_job(job_dir: Path) -> list[dict]:
    """Persist source.json, words, peaks and seed.json once for every openable clip of a job
    rendered before Essentials; returns ``[{clip_id | None, index, openable, reason}]``."""
    raise NotImplementedError("T1.5: edit_v2.seed.prepare_legacy_job (plan §3.5, §4.2)")


__all__ = ["build_seed", "prepare_legacy_job"]
