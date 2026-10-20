"""The Pengaturan default logo in a job, as ``web/lib/default-logo.mjs`` copies it (plan 2026-10-20 A6).

``rgba_png`` builds a normalised logo (8-bit RGBA, only IHDR/IDAT/IEND) with the stdlib, and
``write_job_logo`` writes the ``<job>/logo/<sha>.{png,json}`` pair the web copies into a new job.
"""

from __future__ import annotations

import hashlib
import json
import struct
import zlib
from pathlib import Path


def _chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def rgba_png(width: int, height: int, *, colour: tuple[int, int, int, int] = (34, 102, 204, 153)
             ) -> bytes:
    """An RGBA PNG of one colour (filter 0 on every row)."""
    row = b"\x00" + bytes(colour) * width
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(row * height, 9)) + _chunk(b"IEND", b""))


def logo_meta(png: bytes, width: int, height: int, *, name: str | None = "logo.png") -> bytes:
    """The asset metadata the ingest writes beside a stored logo (canonical JSON)."""
    meta = {"schema": "potongin.asset/1", "kind": "image", "mime": "image/png", "w": width,
            "h": height, "name": name, "bytes": len(png), "created_at_ms": 1_790_000_000_000,
            "source": {"format": "png", "w": width, "h": height, "orientation": 1}}
    return json.dumps(meta, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def write_job_logo(job_dir: Path, width: int = 512, height: int = 512, *,
                   png: bytes | None = None, meta: bytes | None = None) -> str:
    """Write ``<job_dir>/logo/<sha>.png`` and ``.json``; returns the sha256 of the PNG."""
    png = rgba_png(width, height) if png is None else png
    sha = hashlib.sha256(png).hexdigest()
    directory = Path(job_dir) / "logo"
    directory.mkdir(mode=0o700, exist_ok=True)
    (directory / f"{sha}.png").write_bytes(png)
    (directory / f"{sha}.json").write_bytes(logo_meta(png, width, height) if meta is None else meta)
    return sha
