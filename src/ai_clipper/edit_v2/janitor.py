"""Editor retention janitor (plan §4.4, §11.4 T4.3).

The primary worker runs it between jobs (``web/scripts/primary-worker.mjs``, never while a job
is active) through ``python -m ai_clipper.edit_v2.janitor``: one envelope
``{"op": "run", "nowMs"?, "capBytes"?, "budgetMs"?, "after"?}`` on stdin, ``JOBS_ROOT`` from the
environment, one JSON report on stdout (exit 0; a malformed envelope is exit 2, anything else 1).

It only removes editor data that is superseded, regenerable or abandoned, never a job, its
source, its renders or exports, a seed, words, peaks or a camera plan (the storage retention
policy, ``docs/operations/STORAGE_RETENTION.md``). Per job directory ``JOBS_ROOT/<uuid>``,
skipping a job that is being deleted (``status: "deleting"`` or a ``.deletions`` tombstone):

* **Receipts** (per clip, under the clip's document lock): the newest ``RECEIPTS_KEEP`` committed
  receipts plus every pending one (``store.prune_receipts``; a save already prunes, the janitor
  catches a clip whose last save did not).
* **Archives** (per clip, under the document lock): revision 1, every revision a render request
  of the job names (``doc_relative``) and the newest ``ARCHIVE_KEEP`` revisions stay; the others
  go. Skipped for the whole job while one of its exports is queued or rendering.
* **Suggestions**: ``suggestions/<uuid>.json`` (and leftover temporaries) older than 30 days.
* **Preview caches** (``preview/{plates,audio,ass,frames,derived}`` of every clip): files not used
  for 30 days go; then the job's cap (``capBytes``, default 1 GiB, K11) evicts the least recently
  used, never a file used in the last ``PROTECT_MS``. "Used" is the later of mtime and atime.
  Temporaries and ``preview/.cancel`` markers older than ``STALE_MS`` go too.
* **Orphan assets**: an asset of ``analysis/assets`` that no current document and no kept
  archive names is recorded with the time it was first seen unreferenced
  (``analysis/assets/.janitor.json``); 30 days later it is deleted (media, peaks, metadata),
  under the asset store's lock. A document that cannot be read keeps every asset of its job.

``budgetMs`` bounds a run: jobs are visited in name order after ``after`` and the report's
``next`` names the last job visited when the budget ran out (``complete: false``), ``null`` when
every job was visited.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import stat
import sys
import time
import zlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from . import assets as _assets
from . import store
from .clip_id import CLIP_ID_PATTERN
from .doc import MAX_DOC_BYTES, iter_asset_ids
from .errors import EditV2Error

DAY_MS = 86_400_000
RECEIPTS_KEEP = store.RECEIPTS_KEEP
ARCHIVE_KEEP = 50
SUGGESTIONS_MAX_AGE_MS = 30 * DAY_MS
CACHE_IDLE_MS = 30 * DAY_MS
ORPHAN_AFTER_MS = 30 * DAY_MS
PROTECT_MS = 10 * 60_000
STALE_MS = 10 * 60_000
DEFAULT_CAP_BYTES = 1 << 30  # K11, as the preview lane
DEFAULT_BUDGET_MS = 60_000
CACHE_DIRS = ("plates", "audio", "ass", "frames", "derived")
STATE_FILE = ".janitor.json"
STATE_SCHEMA = "potongin.janitor/1"
MAX_STATE_BYTES = 1 << 20
MAX_REQUEST_BYTES = 1 << 20
MAX_ENVELOPE_BYTES = 4096
ACTIVE_EXPORTS = frozenset({"queued", "claimed", "rendering"})

_JOB_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_UUID_JSON = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json")
_ARCHIVE = re.compile(r"r(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})\.json\.gz")
_ASSET_FILE = re.compile(r"([0-9a-f]{64})\.(png|m4a|json|peaks\.bin)")
_SHA = re.compile(r"[0-9a-f]{64}")
_REQUEST_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json")
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _real_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _entries(directory: Path) -> Iterator[os.DirEntry]:
    """The entries of a real directory (a symlink or a missing directory yields nothing)."""
    if not _real_dir(directory):
        return iter(())
    try:
        with os.scandir(directory) as scan:
            return iter(list(scan))
    except OSError:
        return iter(())


def _unlink(path: Path) -> int:
    """Remove a regular file; its size, or -1 when it was not removed."""
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode):
            return -1
        os.unlink(path)
        return info.st_size
    except OSError:
        return -1


def _read(path: Path, limit: int) -> bytes | None:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, limit + 1)
        return None if len(data) > limit else data
    finally:
        os.close(fd)


def _json(data: bytes | None) -> Any:
    if data is None:
        return None
    try:
        return json.loads(data)
    except ValueError:
        return None


def _used_ms(info: os.stat_result) -> float:
    return max(info.st_mtime, info.st_atime) * 1000


# --- job selection -------------------------------------------------------------------------------


def _deleting(jobs_root: Path, job: Path) -> bool:
    if os.path.lexists(jobs_root / ".deletions" / f"{job.name}.json"):
        return True
    state = _json(_read(job / "job.json", 4 << 20))
    return not isinstance(state, dict) or state.get("status") == "deleting"


def _clips(job: Path) -> list[Path]:
    return [Path(entry.path) for entry in sorted(_entries(job / "analysis" / "clips"),
                                                 key=lambda entry: entry.name)
            if CLIP_ID_PATTERN.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False)]


def _requests(job: Path) -> tuple[set[str], bool]:
    """(the ``doc_relative`` paths of the job's render requests, an export in flight)."""
    names: set[str] = set()
    busy = False
    for entry in _entries(job / "analysis" / "render-requests"):
        if not _REQUEST_NAME.fullmatch(entry.name):
            continue
        request = _json(_read(Path(entry.path), MAX_REQUEST_BYTES))
        if not isinstance(request, dict):
            continue
        if request.get("state") in ACTIVE_EXPORTS:
            busy = True
        relative = request.get("doc_relative")
        if isinstance(relative, str):
            names.add(relative)
    return names, busy


# --- per clip ------------------------------------------------------------------------------------


def _archives(clip: Path) -> dict[int, str]:
    found: dict[int, str] = {}
    for entry in _entries(clip / store.ARCHIVE_DIR):
        match = _ARCHIVE.fullmatch(entry.name)
        if match is not None and entry.is_file(follow_symlinks=False):
            found[int(match.group(1))] = entry.name
    return found


def _prune_archives(clip: Path, referenced: set[str]) -> int:
    removed = 0
    with store._locked(clip):  # the clip's document lock (every save takes it)
        archives = _archives(clip)
        newest = set(sorted(archives, reverse=True)[:ARCHIVE_KEEP])
        for revision, name in archives.items():
            relative = f"analysis/clips/{clip.name}/{store.ARCHIVE_DIR}/{name}"
            if revision == 1 or revision in newest or relative in referenced:
                continue
            if _unlink(clip / store.ARCHIVE_DIR / name) >= 0:
                removed += 1
    return removed


def _archive_doc(path: Path) -> Any:
    data = _read(path, MAX_DOC_BYTES)
    if data is None:
        return None
    try:
        inflater = zlib.decompressobj(wbits=31)
        raw = inflater.decompress(data, MAX_DOC_BYTES + 1)
    except zlib.error:
        return None
    if len(raw) > MAX_DOC_BYTES or not inflater.eof:
        return None
    return _json(raw)


def _documents(clip: Path) -> Iterator[Any]:
    """The clip's current document (when edited) and every kept archive; ``None`` for one that
    cannot be read."""
    path = clip / store.DOC_FILE
    if os.path.lexists(path):
        yield _json(_read(path, MAX_DOC_BYTES))
    for name in _archives(clip).values():
        yield _archive_doc(clip / store.ARCHIVE_DIR / name)


def _prune_suggestions(clip: Path, now_ms: int) -> int:
    removed = 0
    for entry in _entries(clip / "suggestions"):
        if _UUID_JSON.fullmatch(entry.name):
            limit = SUGGESTIONS_MAX_AGE_MS
        elif entry.name.startswith(".") and entry.name.endswith(".tmp"):
            limit = STALE_MS  # a task that died while writing
        else:
            continue
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        stale = stat.S_ISREG(info.st_mode) and now_ms - info.st_mtime * 1000 > limit
        if stale and _unlink(Path(entry.path)) >= 0:
            removed += 1
    return removed


# --- caches --------------------------------------------------------------------------------------


def _prune_caches(clips: list[Path], now_ms: int, cap_bytes: int) -> tuple[int, int]:
    files: list[tuple[float, int, Path]] = []
    removed = freed = 0

    def drop(path: Path) -> None:
        nonlocal removed, freed
        size = _unlink(path)
        if size >= 0:
            removed += 1
            freed += size

    for clip in clips:
        preview = clip / "preview"
        for entry in _entries(preview / ".cancel"):
            with contextlib.suppress(OSError):
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISREG(info.st_mode) and now_ms - info.st_mtime * 1000 > STALE_MS:
                    _unlink(Path(entry.path))
        for kind in CACHE_DIRS:
            for entry in _entries(preview / kind):
                try:
                    info = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                path = Path(entry.path)
                if entry.name.startswith("."):
                    if entry.name.endswith(".tmp") and now_ms - info.st_mtime * 1000 > STALE_MS:
                        drop(path)
                    continue
                used = _used_ms(info)
                if now_ms - used > CACHE_IDLE_MS:
                    drop(path)
                else:
                    files.append((used, info.st_size, path))
    total = sum(size for _used, size, _path in files)
    if total > cap_bytes:
        for used, size, path in sorted(files, key=lambda item: item[0]):
            if total <= cap_bytes:
                break
            if now_ms - used < PROTECT_MS:
                continue
            before = removed
            drop(path)
            if removed > before:
                total -= size
    return removed, freed


# --- assets --------------------------------------------------------------------------------------


def _write_state(directory: Path, state: dict) -> None:
    temporary = directory / f".{STATE_FILE}.{os.getpid()}.tmp"
    data = json.dumps(state, sort_keys=True, separators=(",", ":")).encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600)
    try:
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temporary, directory / STATE_FILE)


def _prune_assets(job: Path, referenced: set[str], now_ms: int) -> int:
    directory = job / "analysis" / "assets"
    if not _real_dir(directory):
        return 0
    removed = 0
    with _assets._locked(directory):  # the asset store's own lock (ingest takes it)
        stored: dict[str, list[Path]] = {}
        for entry in _entries(directory):
            match = _ASSET_FILE.fullmatch(entry.name)
            if match is not None and entry.is_file(follow_symlinks=False):
                stored.setdefault(match.group(1), []).append(Path(entry.path))
        state = _json(_read(directory / STATE_FILE, MAX_STATE_BYTES))
        seen = state.get("orphans") if isinstance(state, dict) else None
        seen = {sha: at for sha, at in (seen or {}).items()
                if isinstance(sha, str) and _SHA.fullmatch(sha) and type(at) is int}
        orphans: dict[str, int] = {}
        for sha, paths in stored.items():
            if sha in referenced:
                continue
            first = min(seen.get(sha, now_ms), now_ms)
            if now_ms - first >= ORPHAN_AFTER_MS:
                metadata = [path for path in paths if path.name.endswith(".json")]
                for path in [path for path in paths if path not in metadata] + metadata:
                    _unlink(path)  # the metadata last: a half-removed asset reads as missing
                removed += 1
            else:
                orphans[sha] = first
        if orphans != seen:
            _write_state(directory, {"schema": STATE_SCHEMA, "orphans": orphans})
    return removed


# --- a job and a run -----------------------------------------------------------------------------


def clean_job(job_dir: Path, *, now_ms: int, cap_bytes: int = DEFAULT_CAP_BYTES) -> dict:
    """Apply every policy of the module docstring to one job; returns the counts removed and
    ``skipped`` (``exports_in_flight``, ``documents_unreadable``)."""
    job = Path(job_dir)
    report: dict[str, Any] = {"receipts": 0, "archives": 0, "suggestions": 0, "cache_files": 0,
                              "cache_bytes": 0, "assets": 0, "skipped": []}
    clips = _clips(job)
    referenced_requests, busy = _requests(job)
    if busy:
        report["skipped"].append("exports_in_flight")
    assets: set[str] = set()
    readable = True
    for clip in clips:
        with contextlib.suppress(EditV2Error, OSError, ValueError):
            report["receipts"] += store.prune_receipts(clip, keep=RECEIPTS_KEEP)
        if not busy:
            try:
                report["archives"] += _prune_archives(clip, referenced_requests)
            except (EditV2Error, OSError):
                readable = False
        report["suggestions"] += _prune_suggestions(clip, now_ms)
        for document in _documents(clip):
            if not isinstance(document, dict):
                readable = False
                continue
            assets.update(asset.split(":", 1)[1] for asset in iter_asset_ids(document))
    for relative in referenced_requests:  # a requested revision that lives outside archives
        path = job / relative
        if relative.endswith(".json.gz") and path.is_file():
            document = _archive_doc(path)
            if isinstance(document, dict):
                assets.update(asset.split(":", 1)[1] for asset in iter_asset_ids(document))
    report["cache_files"], report["cache_bytes"] = _prune_caches(clips, now_ms, cap_bytes)
    if not readable:
        report["skipped"].append("documents_unreadable")
    elif not busy:
        report["assets"] = _prune_assets(job, assets, now_ms)
    return report


def run(jobs_root: Path, *, now_ms: int, cap_bytes: int = DEFAULT_CAP_BYTES,
        budget_s: float = DEFAULT_BUDGET_MS / 1000, after: str | None = None) -> dict:
    """``clean_job`` over every job of ``jobs_root`` in name order after ``after`` until
    ``budget_s`` is spent (at least one job is visited)."""
    root = Path(jobs_root)
    started = time.monotonic()
    totals: dict[str, Any] = {"jobs": 0, "receipts": 0, "archives": 0, "suggestions": 0,
                              "cache_files": 0, "cache_bytes": 0, "assets": 0, "complete": True,
                              "next": None}
    names = sorted(entry.name for entry in _entries(root)
                   if _JOB_ID.fullmatch(entry.name) and entry.is_dir(follow_symlinks=False))
    names = [name for name in names if after is None or name > after]
    for position, name in enumerate(names):
        job = root / name
        if _deleting(root, job):
            continue
        report = clean_job(job, now_ms=now_ms, cap_bytes=cap_bytes)
        totals["jobs"] += 1
        for key in ("receipts", "archives", "suggestions", "cache_files", "cache_bytes",
                    "assets"):
            totals[key] += report[key]
        if time.monotonic() - started >= budget_s and position < len(names) - 1:
            totals["complete"] = False
            totals["next"] = name
            break
    return totals


# --- CLI ------------------------------------------------------------------------------------------


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _Usage()
    return result


def _integer(value: Any, *, minimum: int) -> int:
    if type(value) is not int or value < minimum:
        raise _Usage()
    return value


def _envelope(raw: bytes) -> dict:
    if not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _value: _Usage())
    except (ValueError, UnicodeDecodeError):
        raise _Usage() from None
    if not isinstance(value, dict) or value.get("op") != "run":
        raise _Usage()
    if set(value) - {"op", "nowMs", "capBytes", "budgetMs", "after"}:
        raise _Usage()
    after = value.get("after")
    if after is not None and (not isinstance(after, str) or not _JOB_ID.fullmatch(after)):
        raise _Usage()
    return {
        "now_ms": _integer(value.get("nowMs", time.time_ns() // 1_000_000), minimum=0),
        "cap_bytes": _integer(value.get("capBytes", DEFAULT_CAP_BYTES), minimum=1),
        "budget_s": _integer(value.get("budgetMs", DEFAULT_BUDGET_MS), minimum=0) / 1000,
        "after": after,
    }


def _emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True) + "\n")
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    del argv
    try:
        arguments = _envelope(sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1))
    except _Usage:
        _emit({"error": {"code": "internal_error", "path": None, "ref": None,
                         "messageId": "edit.internal_error"}})
        return 2
    jobs_root = os.environ.get("JOBS_ROOT", "")
    if not jobs_root or not _real_dir(Path(jobs_root)):
        _emit({"error": {"code": "internal_error", "path": None, "ref": None,
                         "messageId": "edit.internal_error"}})
        return 1
    try:
        _emit(run(Path(jobs_root), **arguments))
    except Exception:  # noqa: BLE001 - one fixed code; nothing about paths leaks
        _emit({"error": {"code": "internal_error", "path": None, "ref": None,
                         "messageId": "edit.internal_error"}})
        return 1
    return 0


__all__ = [
    "ARCHIVE_KEEP",
    "CACHE_IDLE_MS",
    "DEFAULT_CAP_BYTES",
    "ORPHAN_AFTER_MS",
    "PROTECT_MS",
    "RECEIPTS_KEEP",
    "SUGGESTIONS_MAX_AGE_MS",
    "clean_job",
    "main",
    "run",
]


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
