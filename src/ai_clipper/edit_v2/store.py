"""Per-clip document store: virtual revision 0, PUT rules, receipts, archive (plan §4.1, §4.4).

Owner: T1.1. Stub landed by T1.0 with the frozen Appendix A signatures. ``clip_dir`` is
``JOBS_ROOT/<job>/analysis/clips/<clip_id>``. It reuses the private helpers of
``edit_manifest.py`` (``_read_regular``, ``_atomic_write``, ``_fsync_directory``, the lock
pattern) without modifying them.
"""

from __future__ import annotations

from pathlib import Path

from .doc import Issue

# Plan §4.1, relative to clip_dir.
SEED_FILE = "seed.json"
DOC_FILE = "edit/doc.json"
ARCHIVE_DIR = "edit/archive"  # r<N>.<sha>.json.gz
RECEIPTS_DIR = "edit/receipts"  # <idempotency-key>.json, digest only
LOCK_FILE = "edit/.lock"
RECEIPTS_KEEP = 200


def get(clip_dir: Path) -> tuple[dict, str, bool]:
    """The current document, its ETag and whether it is the seed (virtual revision 0).

    Writes nothing (plan §4.4): without ``edit/doc.json`` it returns ``seed.json``.
    """
    raise NotImplementedError("T1.1: edit_v2.store.get (plan §4.4)")


def seed(clip_dir: Path) -> tuple[dict, str]:
    """``seed.json`` and its ETag (``?seed=1``, "Kembali ke versi AI")."""
    raise NotImplementedError("T1.1: edit_v2.store.seed (plan §4.4)")


def put(
    clip_dir: Path, *, expected_etag: str, idempotency_key: str, raw: bytes, now_ms: int
) -> tuple[dict, str, tuple[Issue, ...]]:
    """Save a full document under the clip lock; returns (document, etag, warnings).

    ``If-Match`` = ``expected_etag``; ``revision == current + 1``; ``parent_sha256 == current
    etag``; ``base`` unchanged; the server stamps ``audit.updated_at_ms = max(now_ms, previous
    + 1)``; digest-only idempotency receipts; the superseded revision is archived.
    """
    raise NotImplementedError("T1.1: edit_v2.store.put (plan §4.4)")


def archive_for_render(clip_dir: Path, etag: str) -> tuple[str, int]:
    """Archive the revision with ``etag`` for a render request; (relative path, revision).

    Revision 0 points at ``seed.json`` (plan §4.6 ``doc_relative``).
    """
    raise NotImplementedError("T1.1: edit_v2.store.archive_for_render (plan §4.6)")


def prune_receipts(clip_dir: Path, *, keep: int = 200) -> int:
    """Keep the newest ``keep`` committed receipts plus every pending one; returns the count
    deleted (plan §4.4, defect #7)."""
    raise NotImplementedError("T1.1: edit_v2.store.prune_receipts (plan §4.4)")


__all__ = [
    "ARCHIVE_DIR",
    "DOC_FILE",
    "LOCK_FILE",
    "RECEIPTS_DIR",
    "RECEIPTS_KEEP",
    "SEED_FILE",
    "archive_for_render",
    "get",
    "prune_receipts",
    "put",
    "seed",
]
