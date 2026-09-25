"""``analysis/source.json``: content sha and probe of the job source, written once per job.

Owner: T1.5. Stub landed by T1.0 with the frozen Appendix A signature (plan §4.1, §2.5).
"""

from __future__ import annotations

from pathlib import Path


def ensure_source_info(job_dir: Path, source: Path) -> dict:
    """Return ``{content_sha256, probe}``, computing and writing it immutably on first use."""
    raise NotImplementedError("T1.5: edit_v2.source_info.ensure_source_info (plan §4.1)")


__all__ = ["ensure_source_info"]
