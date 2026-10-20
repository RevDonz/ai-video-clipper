"""The Pengaturan default text watermark in a job, as ``web/lib/default-watermark.mjs`` copies it
(CONTRACTS §5.40): ``<job>/watermark.json``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

WATERMARK = {"text": "@potongin.klip", "pos": "top_center", "size_pm": 1000, "opacity_pm": 850}


def write_job_watermark(job_dir: Path, value: dict[str, Any] | None = None, *,
                        schema: str = "potongin.job-watermark/1") -> Path:
    """Write ``<job_dir>/watermark.json`` with ``value`` (default ``WATERMARK``)."""
    path = Path(job_dir) / "watermark.json"
    body = {"schema": schema, **(WATERMARK if value is None else value)}
    path.write_text(json.dumps(body) + "\n", encoding="utf-8")
    return path
