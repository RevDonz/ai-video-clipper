"""Per-clip document store: virtual revision 0, PUT rules, receipts, archive (plan §4.1, §4.4).

Owner: T1.1. ``clip_dir`` is ``JOBS_ROOT/<job>/analysis/clips/<clip_id>``. It reuses the private
helpers of ``edit_manifest.py`` (``_read_regular``, ``_fsync_directory`` and the ``flock`` and
tmp → fsync → rename patterns of ``_edit_lock`` and ``_atomic_write``) without modifying them.

Layout (relative to ``clip_dir``): ``seed.json`` (revision 0, written by the seed builder, never
here), ``words.<sha16>.json`` (the words artifact named by ``base.words.sha256``),
``edit/doc.json`` (the current revision), ``edit/archive/r<N>.<etag>.json.gz`` (superseded and
render-referenced revisions), ``edit/receipts/<idempotency-key>.json`` and ``edit/.lock``.
The job asset store is ``<job>/analysis/assets/<hex>.json``: document-form metadata
(``{kind, mime, w, h}`` or ``{kind, mime, duration_ms, lufs_c}``; other keys are ignored).

Rules (plan §4.4):

* **Virtual revision 0.** Without ``edit/doc.json`` the current document is ``seed.json`` with
  ``ETag = sha256(seed canonical bytes)``. :func:`get` and :func:`seed` never write.
* **PUT** (under the clip's ``flock``): ``If-Match`` must be the current etag (else
  ``RevisionConflict`` carrying the current document), ``revision == current + 1``
  (``revision_mismatch``), ``parent_sha256 == current etag`` (``parent_mismatch``), then
  :func:`~ai_clipper.edit_v2.doc.validate_doc` against the seed, the words artifact and the asset
  store. ``audit.updated_at_ms`` is required and the server replaces it with
  ``max(now, previous + 1)``; the superseded revision (≥ 1; revision 0 is ``seed.json``) is
  archived; ``edit/doc.json`` is replaced atomically (tmp → fsync → rename → directory fsync,
  ``O_NOFOLLOW``, 0600 files, 0700 directories).
* **Durability and ordering.** Every file is fsynced before it is renamed into place, so a name
  that survives a power loss always has its full content. The visible order is: pending receipt
  → archive of the superseded revision → ``edit/doc.json`` → committed receipt. The three files
  of one save are staged before the document is validated (written to temporary names and
  fsynced in background threads, so the fsyncs overlap with each other and with the
  validation); a rejected save removes them without renaming anything. The directories of the
  three renames are fsynced together after the document is renamed, before PUT returns. A power
  loss can therefore lose a pending receipt whose document survived; its retry gets 409 and the
  client's rebase finds its document on the server (the same path as a retry after pruning,
  plan §4.4). The committed rewrite of a receipt is not fsynced: losing it leaves the pending
  receipt, which the retry reconciles (an empty receipt file, the trace of a lost rewrite on
  some filesystems, reads as absent).
* **Receipts** are digest-only: ``{key, payload_sha256, state, result_etag, result_revision,
  at_ms}`` with ``payload_sha256 = sha256(expected_etag ‖ 0x00 ‖ canonical(client document))``
  and ``at_ms`` the server stamp. A pending receipt (written durably before the document) already
  names the revision it will publish, so a retry after a crash is reconciled exactly: the result
  is current → commit; it is archived → commit; nothing was published and the stored revision is
  still the expected one → publish the same stamped revision; anything else is an
  ``IdempotencyConflict`` (an uncertain transaction is never downgraded to a revision
  conflict). A replay of a committed receipt returns its revision (current or archived); when
  that revision is no longer retrievable the replay is an ordinary ``RevisionConflict``.
* **Pruning** after every commit: the newest ``RECEIPTS_KEEP`` committed receipts (by
  ``at_ms``) plus every pending one are kept (defect #7). A retry whose receipt was pruned gets
  409: its ``If-Match`` is no longer current.
"""

from __future__ import annotations

import copy
import errno
import fcntl
import gc
import gzip
import hashlib
import json
import os
import re
import stat
import threading
import uuid
import zlib
from collections.abc import Callable, Iterable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path

from .. import edit_manifest as _v1
from .doc import (
    MAX_DOC_BYTES,
    Issue,
    canonical_bytes,
    iter_asset_ids,
    parse_doc,
    validate_doc,
)
from .errors import (
    AnalysisMissing,
    DocInvalid,
    DocSemanticInvalid,
    EditV2Error,
    IdempotencyConflict,
    NotFound,
    RevisionConflict,
)

# Plan §4.1, relative to clip_dir.
SEED_FILE = "seed.json"
DOC_FILE = "edit/doc.json"
ARCHIVE_DIR = "edit/archive"  # r<N>.<sha>.json.gz
RECEIPTS_DIR = "edit/receipts"  # <idempotency-key>.json, digest only
LOCK_FILE = "edit/.lock"
RECEIPTS_KEEP = 200
ARCHIVE_GZIP_LEVEL = 1  # archives are written on every save; level 1 is 3x faster than 6
# Relative to clip_dir: the words artifact and the job asset store (plan §3.6, §4.1).
WORDS_FILE = "words.{sha16}.json"
ASSETS_DIR = "../../assets"

MAX_WORDS_BYTES = 32 << 20
MAX_RECEIPT_BYTES = 4096
MAX_ASSET_META_BYTES = 64 << 10
_SHA = re.compile(r"[0-9a-f]{64}")
_KEY = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_ARCHIVE_NAME = re.compile(r"r(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})\.json\.gz")
_RECEIPT_NAME = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json")
_RECEIPT_KEYS = frozenset({"key", "payload_sha256", "state", "result_etag", "result_revision",
                           "at_ms"})
# A receipt's canonical bytes start with at_ms and end with state (sorted keys): enough to prune.
_RECEIPT_ORDER = re.compile(rb'\{"at_ms":(0|[1-9][0-9]{0,15}),.*"state":"(pending|committed)"\}',
                            re.DOTALL)
_ASSET_FIELDS = {"image": ("kind", "mime", "w", "h"),
                 "audio": ("kind", "mime", "duration_ms", "lufs_c")}
_NEW_FILE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
# The server stamp in canonical bytes: a key followed by its integer (a string or a key holding
# the same characters has an escaped quote, so exactly one match is the audit key itself).
_UPDATED_AT = re.compile(rb'"updated_at_ms":(-?[0-9]+)')


def _corrupt() -> EditV2Error:
    """A stored file that is not what this module wrote (fixed code, no path or detail)."""
    return EditV2Error("internal_error")


# --- files -----------------------------------------------------------------------------------------


def _read(path: Path, limit: int) -> bytes | None:
    """A regular, non-symlink file's bytes (≤ limit), or None when it does not exist."""
    try:
        return _v1._read_regular(path, limit)
    except FileNotFoundError:
        return None
    except _v1.EditManifestError:
        raise _corrupt() from None
    except OSError as error:
        if error.errno in {errno.ENOENT, errno.ENOTDIR}:
            return None
        raise


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def _unlink(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


class _Staged:
    """A file written under a temporary name next to ``target`` whose fsync runs in a background
    thread, so that the fsyncs of one save overlap (the filesystem commits them together)."""

    __slots__ = ("error", "fd", "target", "temp", "thread")

    def __init__(self, target: Path, data: bytes) -> None:
        self.target = target
        self.temp = target.parent / f".{target.name}.{uuid.uuid4()}.tmp"
        self.error: BaseException | None = None
        self.thread: threading.Thread | None = None
        self.fd = os.open(self.temp, _NEW_FILE, 0o600)
        try:
            _write_all(self.fd, data)
            thread = threading.Thread(target=self._sync, daemon=True)
            thread.start()
            self.thread = thread  # only a started thread is ever joined
        except BaseException:
            self.discard()
            raise

    def _sync(self) -> None:
        try:
            os.fsync(self.fd)
        except BaseException as error:  # noqa: BLE001 - re-raised by wait() in the caller
            self.error = error

    def wait(self) -> Path:
        """Wait for the fsync; the temporary path, whose content is now durable."""
        if self.thread is not None:
            self.thread.join()
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1
        if self.error is not None:
            raise self.error
        return self.temp

    def discard(self) -> None:
        """Wait for the fsync (if any) and remove the temporary file (idempotent)."""
        if self.thread is not None:
            self.thread.join()
        if self.fd >= 0:
            os.close(self.fd)
            self.fd = -1
        _unlink(self.temp)


def _fsync_directories(paths: Iterable[Path]) -> Callable[[], None]:
    """Start fsyncing several directories concurrently (one journal commit on ext4/XFS); the
    returned function waits for all of them and raises the first error. Idempotent."""
    errors: list[BaseException] = []

    def sync(path: Path) -> None:
        try:
            _v1._fsync_directory(path)
        except BaseException as error:  # noqa: BLE001 - re-raised by wait()
            errors.append(error)

    threads: list[threading.Thread] = []

    def wait() -> None:
        for thread in threads:
            thread.join()
        if errors:
            raise errors[0]

    try:
        for path in dict.fromkeys(paths):
            thread = threading.Thread(target=sync, args=(path,), daemon=True)
            thread.start()
            threads.append(thread)
    except BaseException:
        for thread in threads:  # join the started ones; the start failure is what is raised
            thread.join()
        raise
    return wait


def _clip(clip_dir: Path | str) -> Path:
    """The clip directory: it must exist, be a real directory and have no symlinked part."""
    path = Path(clip_dir)
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise NotFound() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise _corrupt()
    if path.resolve() != path.absolute():
        raise _corrupt()
    return path


def _ensure_dir(path: Path) -> Path:
    """Create a 0700 directory (fsyncing its parent when created); refuse anything else."""
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    else:
        _v1._fsync_directory(path.parent)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise _corrupt()
    return path


_collector_lock = threading.Lock()
_collector_holds = 0
_collector_was_enabled = False


@contextmanager
def _collector_paused() -> Iterator[None]:
    """Pause the cyclic garbage collector while a save runs, then restore its state.

    A save allocates tens of thousands of short-lived JSON containers (the client document, the
    current revision, the words artifact); they are acyclic and freed by reference counting, so
    collections during the save only add pauses (a full one over a large heap costs tens of ms).
    Nested and concurrent saves share one pause; a collector the caller disabled stays so.
    """
    global _collector_holds, _collector_was_enabled
    with _collector_lock:
        if _collector_holds == 0:
            _collector_was_enabled = gc.isenabled()
            gc.disable()
        _collector_holds += 1
    try:
        yield
    finally:
        with _collector_lock:
            _collector_holds -= 1
            if _collector_holds == 0 and _collector_was_enabled:
                gc.enable()


@contextmanager
def _locked(clip_dir: Path) -> Iterator[None]:
    """Exclusive ``flock`` on ``edit/.lock`` (the V1 lock pattern: no-follow regular file)."""
    _ensure_dir(clip_dir / "edit")
    try:
        fd = os.open(clip_dir / LOCK_FILE,
                     os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, 0o600)
    except OSError as error:
        raise _corrupt() from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise _corrupt()
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _load(path: Path, *, verify: bool = True) -> tuple[dict, str, bytes] | None:
    """A stored canonical document: (document, etag, bytes), or None when absent.

    ``verify`` re-encodes the document to prove the file is canonical. PUT skips it for
    ``edit/doc.json`` (which only this module writes, from canonical bytes): the etag is the
    sha256 of the bytes either way.
    """
    raw = _read(path, MAX_DOC_BYTES)
    if raw is None:
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        raise _corrupt() from None
    if type(doc) is not dict or (verify and canonical_bytes(doc) != raw):
        raise _corrupt()
    return doc, hashlib.sha256(raw).hexdigest(), raw


def _seed(clip_dir: Path) -> tuple[dict, str, bytes]:
    found = _load(clip_dir / SEED_FILE)
    if found is None:
        raise NotFound()
    return found


def _current(clip_dir: Path, *, verify: bool = True) -> tuple[dict, str, bytes, bool]:
    """(document, etag, bytes, is_seed) of the current revision."""
    found = _load(clip_dir / DOC_FILE, verify=verify)
    if found is not None:
        return (*found, False)
    return (*_seed(clip_dir), True)


def get(clip_dir: Path) -> tuple[dict, str, bool]:
    """The current document, its ETag and whether it is the seed (virtual revision 0).

    Writes nothing (plan §4.4): without ``edit/doc.json`` it returns ``seed.json``.
    """
    doc, etag, _raw, is_seed = _current(_clip(clip_dir))
    return doc, etag, is_seed


def seed(clip_dir: Path) -> tuple[dict, str]:
    """``seed.json`` and its ETag (``?seed=1``, "Kembali ke versi AI")."""
    doc, etag, _raw = _seed(_clip(clip_dir))
    return doc, etag


def load_words(clip_dir: Path, words_sha256: str) -> dict:
    """The words artifact ``words.<sha16>.json`` whose bytes hash to ``words_sha256``.

    ``AnalysisMissing`` when it does not exist yet; a file whose bytes do not match the sha is
    corrupt (``internal_error``).
    """
    if not isinstance(words_sha256, str) or _SHA.fullmatch(words_sha256) is None:
        raise _corrupt()
    raw = _read(Path(clip_dir) / WORDS_FILE.format(sha16=words_sha256[:16]), MAX_WORDS_BYTES)
    if raw is None:
        raise AnalysisMissing()
    if hashlib.sha256(raw).hexdigest() != words_sha256:
        raise _corrupt()
    try:
        words = json.loads(raw)
    except ValueError:
        raise _corrupt() from None
    if type(words) is not dict:
        raise _corrupt()
    return words


def words_exist(clip_dir: Path, words_sha256: object) -> bool:
    """Whether the words file named by ``words_sha256`` exists (no read, no hash)."""
    if not isinstance(words_sha256, str) or _SHA.fullmatch(words_sha256) is None:
        return False
    try:
        info = (Path(clip_dir) / WORDS_FILE.format(sha16=words_sha256[:16])).lstat()
    except (FileNotFoundError, NotADirectoryError):
        return False
    return stat.S_ISREG(info.st_mode)


def load_assets(clip_dir: Path, asset_ids: Iterable[str]) -> dict[str, dict]:
    """Document-form metadata of the given assets from the job asset store (missing: absent)."""
    directory = Path(clip_dir) / ASSETS_DIR
    result: dict[str, dict] = {}
    for asset_id in asset_ids:
        if not isinstance(asset_id, str) or not asset_id.startswith("sha256:") \
                or _SHA.fullmatch(asset_id[7:]) is None:
            continue
        raw = _read(directory / f"{asset_id[7:]}.json", MAX_ASSET_META_BYTES)
        if raw is None:
            continue
        try:
            meta = json.loads(raw)
        except ValueError:
            continue
        kind = meta.get("kind") if isinstance(meta, dict) else None
        fields = _ASSET_FIELDS.get(kind) if isinstance(kind, str) else None
        if fields is not None and all(key in meta for key in fields):
            result[asset_id] = {key: meta[key] for key in fields}
    return result


# --- archive ---------------------------------------------------------------------------------------


def _archive_name(revision: int, etag: str) -> str:
    return f"r{revision}.{etag}.json.gz"


def _read_archive(path: Path, etag: str) -> dict | None:
    data = _read(path, MAX_DOC_BYTES)
    if data is None:
        return None
    try:
        inflater = zlib.decompressobj(wbits=31)
        raw = inflater.decompress(data, MAX_DOC_BYTES + 1)
    except zlib.error:
        raise _corrupt() from None
    if len(raw) > MAX_DOC_BYTES or not inflater.eof or hashlib.sha256(raw).hexdigest() != etag:
        raise _corrupt()
    try:
        doc = json.loads(raw)
    except ValueError:
        raise _corrupt() from None
    if type(doc) is not dict:
        raise _corrupt()
    return doc


def _archive_dir(clip_dir: Path) -> Path:
    return _ensure_dir(_ensure_dir(clip_dir / "edit") / "archive")


def _archive_exists(target: Path, etag: str) -> bool:
    """Whether ``target`` already holds the archive of ``etag`` (a different file is corrupt)."""
    try:
        target.lstat()
    except FileNotFoundError:
        return False
    if _read_archive(target, etag) is None:
        raise _corrupt()
    return True


def _link_archive(temp: Path, target: Path, etag: str) -> None:
    """Publish a durable temporary archive under its name; never replaces an existing one."""
    try:
        os.link(temp, target, follow_symlinks=False)
    except FileExistsError:
        if _read_archive(target, etag) is None:
            raise _corrupt() from None


def _stage_archive(clip_dir: Path, revision: int, etag: str, raw: bytes) -> _Staged | None:
    """Start writing ``edit/archive/r<N>.<etag>.json.gz`` (None when it already exists)."""
    target = _archive_dir(clip_dir) / _archive_name(revision, etag)
    if _archive_exists(target, etag):
        return None
    return _Staged(target, gzip.compress(raw, compresslevel=ARCHIVE_GZIP_LEVEL, mtime=0))


def _archive(clip_dir: Path, revision: int, etag: str, raw: bytes) -> str:
    """Write ``edit/archive/r<N>.<etag>.json.gz`` once, durably (never overwritten); its name."""
    staged = _stage_archive(clip_dir, revision, etag, raw)
    name = _archive_name(revision, etag)
    if staged is None:
        return name
    try:
        _link_archive(staged.wait(), staged.target, etag)
        _v1._fsync_directory(staged.target.parent)
    finally:
        staged.discard()
    return name


def _find_archive(clip_dir: Path, etag: str, revision: int | None = None) -> tuple[int, dict] | None:
    """The archived revision with ``etag`` (optionally a known revision number)."""
    directory = clip_dir / ARCHIVE_DIR
    if revision is not None:
        doc = _read_archive(directory / _archive_name(revision, etag), etag)
        return None if doc is None else (revision, doc)
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return None
    for name in names:
        match = _ARCHIVE_NAME.fullmatch(name)
        if match is not None and match.group(2) == etag:
            doc = _read_archive(directory / name, etag)
            if doc is not None:
                return int(match.group(1)), doc
    return None


def _relative(clip_dir: Path, name: str) -> str:
    return f"analysis/clips/{clip_dir.name}/{name}"


def archive_for_render(clip_dir: Path, etag: str) -> tuple[str, int]:
    """Archive the revision with ``etag`` for a render request; (relative path, revision).

    The path is relative to the job directory (plan §4.6 ``doc_relative``). Revision 0 points at
    ``seed.json``; an older revision already in the archive is found there; an unknown etag is
    ``NotFound``.
    """
    if not isinstance(etag, str) or _SHA.fullmatch(etag) is None:
        raise ValueError("etag must be 64 lowercase hex characters")
    clip = _clip(clip_dir)
    with _locked(clip):
        _seed_doc, seed_etag, _raw = _seed(clip)
        if etag == seed_etag:
            return _relative(clip, SEED_FILE), 0
        doc, current_etag, raw, is_seed = _current(clip)
        if not is_seed and etag == current_etag:
            name = _archive(clip, doc["revision"], etag, raw)
            return _relative(clip, f"{ARCHIVE_DIR}/{name}"), doc["revision"]
        found = _find_archive(clip, etag)
        if found is None:
            raise NotFound()
        return _relative(clip, f"{ARCHIVE_DIR}/{_archive_name(found[0], etag)}"), found[0]


# --- receipts --------------------------------------------------------------------------------------


def _receipt_path(clip_dir: Path, key: str) -> Path:
    return clip_dir / RECEIPTS_DIR / f"{key}.json"


def _decode_receipt(raw: bytes, key: str | None) -> dict:
    try:
        receipt = json.loads(raw)
    except ValueError:
        raise _corrupt() from None
    if (type(receipt) is not dict or set(receipt) != _RECEIPT_KEYS
            or canonical_bytes(receipt) != raw
            or receipt["state"] not in ("pending", "committed")
            or not isinstance(receipt["key"], str) or _KEY.fullmatch(receipt["key"]) is None
            or (key is not None and receipt["key"] != key)
            or not all(isinstance(receipt[name], str) and _SHA.fullmatch(receipt[name])
                       for name in ("payload_sha256", "result_etag"))
            or not all(type(receipt[name]) is int and receipt[name] >= 0
                       for name in ("result_revision", "at_ms"))):
        raise _corrupt()
    return receipt


def _read_receipt(clip_dir: Path, key: str) -> dict | None:
    """The receipt of ``key``, or None. An empty file is the trace of a committed receipt whose
    unsynced rewrite was lost with the power (it is never written empty): treated as absent."""
    raw = _read(_receipt_path(clip_dir, key), MAX_RECEIPT_BYTES)
    return None if not raw else _decode_receipt(raw, key)


def _write_receipt(clip_dir: Path, receipt: dict, *, durable: bool = True,
                   staged: _Staged | None = None) -> None:
    """Replace a receipt atomically (tmp → rename). ``staged`` is the receipt already written
    to a temporary file (its fsync running); otherwise it is written here, fsynced when
    ``durable``. Its directory is fsynced together with the document's (module docstring). The
    committed rewrite is not fsynced: if it is lost, the pending receipt is reconciled on the
    retry."""
    target = _receipt_path(clip_dir, receipt["key"])
    if staged is not None:
        os.replace(staged.wait(), target)
        return
    directory = _ensure_dir(_ensure_dir(clip_dir / "edit") / "receipts")
    temp = directory / f".{target.name}.{uuid.uuid4()}.tmp"
    fd = os.open(temp, _NEW_FILE, 0o600)
    try:
        try:
            _write_all(fd, canonical_bytes(receipt))
            if durable:
                os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, target)
    finally:
        _unlink(temp)


def _receipt_order(name: str, directory_fd: int) -> tuple[int, bool] | None:
    """(at_ms, committed) of a receipt file for pruning; None when it vanished. A file that is
    not a receipt this module wrote sorts as the oldest committed one."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                     dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    except OSError:
        return -1, True
    try:
        data = os.read(fd, MAX_RECEIPT_BYTES + 1)
    finally:
        os.close(fd)
    match = _RECEIPT_ORDER.fullmatch(data) if len(data) <= MAX_RECEIPT_BYTES else None
    if match is None:
        return -1, True
    return int(match.group(1)), match.group(2) == b"committed"


def _prune_locked(clip_dir: Path, keep: int) -> int:
    try:
        directory_fd = os.open(clip_dir / RECEIPTS_DIR, _DIRECTORY)
    except FileNotFoundError:
        return 0
    try:
        names = [name for name in os.listdir(directory_fd) if _RECEIPT_NAME.fullmatch(name)]
        if len(names) <= keep:
            return 0
        committed: list[tuple[int, str]] = []
        for name in names:
            order = _receipt_order(name, directory_fd)
            if order is not None and order[1]:
                committed.append((order[0], name))
        committed.sort(reverse=True)
        removed = 0
        for _at_ms, name in committed[keep:]:
            try:
                os.unlink(name, dir_fd=directory_fd)
                removed += 1
            except FileNotFoundError:
                pass
        return removed
    finally:
        os.close(directory_fd)


def prune_receipts(clip_dir: Path, *, keep: int = 200) -> int:
    """Keep the newest ``keep`` committed receipts plus every pending one; returns the count
    deleted (plan §4.4, defect #7)."""
    if type(keep) is not int or keep < 0:
        raise ValueError("keep must be a non-negative integer")
    clip = _clip(clip_dir)
    with _locked(clip):
        return _prune_locked(clip, keep)


# --- PUT -------------------------------------------------------------------------------------------


def _publish(clip_dir: Path, document: _Staged,
             archive: tuple[_Staged, str] | None) -> Callable[[], None]:
    """Publish a save: the archive ``(staged file, etag)`` of the superseded revision, then
    ``edit/doc.json``, each after its fsync; then start fsyncing the directories of the three
    renames. Returns the function that waits for those fsyncs (the save is durable after it)."""
    directories = [document.target.parent, clip_dir / RECEIPTS_DIR]
    if archive is not None:
        staged, etag = archive
        _link_archive(staged.wait(), staged.target, etag)
        directories.append(staged.target.parent)
    os.replace(document.wait(), document.target)
    return _fsync_directories(directories)


def _stamp(client: dict, at_ms: int) -> dict:
    """The client document with the server's ``audit.updated_at_ms`` (a shallow copy)."""
    stamped = copy.copy(client)
    audit = client.get("audit")
    if isinstance(audit, dict):
        stamped["audit"] = {**audit, "updated_at_ms": at_ms}
    return stamped


def _stamped_bytes(stamped: dict, client_raw: bytes, at_ms: int) -> bytes:
    """Canonical bytes of the stamped document, derived from the client's canonical bytes when
    the stamp is found exactly once (the canonical encoding of an int is its decimal digits)."""
    matches = list(_UPDATED_AT.finditer(client_raw))
    if len(matches) != 1:
        return canonical_bytes(stamped)
    start, end = matches[0].span(1)
    return client_raw[:start] + str(at_ms).encode("ascii") + client_raw[end:]


def _check(clip_dir: Path, client: dict, stamped: dict, raw: bytes, current: Mapping, etag: str,
           seed_doc: Mapping) -> tuple[Issue, ...]:
    """Validate a stamped PUT body against the stored revision; its warnings. Raises
    ``DocSemanticInvalid`` with every issue (``DocInvalid`` when the stamped bytes are too
    large)."""
    issues: list[Issue] = []
    revision = client.get("revision")
    if type(revision) is int and revision != current["revision"] + 1:
        issues.append(Issue("revision_mismatch", "/revision"))
    parent = client.get("parent_sha256")
    if (parent is None or isinstance(parent, str)) and parent != etag:
        issues.append(Issue("parent_mismatch", "/parent_sha256"))
    audit = client.get("audit")
    if isinstance(audit, dict) and (type(audit.get("updated_at_ms")) is not int
                                    or audit["updated_at_ms"] < 0):
        issues.append(Issue("range_invalid", "/audit/updated_at_ms"))
    words = load_words(clip_dir, seed_doc["base"]["words"]["sha256"])
    assets = load_assets(clip_dir, iter_asset_ids(stamped))
    validation = validate_doc(stamped, words=words, assets=assets, seed=seed_doc)
    for issue in validation.errors:
        if all((issue.code, issue.path) != (known.code, known.path) for known in issues):
            issues.append(issue)
    if issues:
        first = issues[0]
        raise DocSemanticInvalid(first.code, path=first.path, ref=first.ref, issues=issues)
    if len(raw) > MAX_DOC_BYTES:
        raise DocInvalid("too_large", path="", issues=(Issue("too_large", ""),))
    return validation.warnings


def _warnings(clip_dir: Path, doc: Mapping, seed_doc: Mapping) -> tuple[Issue, ...]:
    words = load_words(clip_dir, seed_doc["base"]["words"]["sha256"])
    assets = load_assets(clip_dir, iter_asset_ids(doc))
    return validate_doc(doc, words=words, assets=assets, seed=seed_doc).warnings


def _save(clip_dir: Path, *, key: str, payload: str, client: dict, client_raw: bytes,
          current: Mapping, etag: str, current_raw: bytes, is_seed: bool, seed_doc: Mapping,
          at_ms: int, expected_result: str | None = None) -> tuple[dict, str, tuple[Issue, ...]]:
    """Validate and publish one revision: pending receipt → archive of the superseded revision
    → ``edit/doc.json`` → committed receipt → prune.

    The three files are staged first (written to temporary names and fsynced in background
    threads), so their fsyncs overlap with the validation; nothing is renamed into place unless
    the document is valid, and the pending receipt is renamed before anything else.
    """
    stamped = _stamp(client, at_ms)
    raw = _stamped_bytes(stamped, client_raw, at_ms)
    result = hashlib.sha256(raw).hexdigest()
    if expected_result is not None and result != expected_result:
        raise _corrupt()  # a pending receipt that its own payload does not reproduce
    revision = stamped.get("revision")
    receipt = {"key": key, "payload_sha256": payload, "state": "pending",
               "result_etag": result, "result_revision": revision, "at_ms": at_ms}
    staged: list[_Staged] = []
    try:
        pending = document = None
        archive: tuple[_Staged, str] | None = None
        if type(revision) is int and revision >= 0 and len(raw) <= MAX_DOC_BYTES:
            receipts = _ensure_dir(_ensure_dir(clip_dir / "edit") / "receipts")
            pending = _Staged(receipts / f"{key}.json", canonical_bytes(receipt))
            staged.append(pending)
            if not is_seed:
                previous = _stage_archive(clip_dir, current["revision"], etag, current_raw)
                if previous is not None:
                    staged.append(previous)
                    archive = (previous, etag)
            document = _Staged(clip_dir / DOC_FILE, raw)
            staged.append(document)
        warnings = _check(clip_dir, client, stamped, raw, current, etag, seed_doc)
        if pending is None or document is None:  # unreachable: the checks above reject it
            raise _corrupt()
        _write_receipt(clip_dir, receipt, staged=pending)
        durable = _publish(clip_dir, document, archive)
    finally:
        for item in staged:
            item.discard()
    try:  # while the directory fsyncs run; PUT returns only once they are done
        _write_receipt(clip_dir, {**receipt, "state": "committed"}, durable=False)
        _prune_locked(clip_dir, RECEIPTS_KEEP)
    finally:
        durable()
    return stamped, result, warnings


def _replay(clip_dir: Path, receipt: dict, seed_doc: Mapping) -> tuple[dict, str,
                                                                        tuple[Issue, ...]]:
    doc, etag, _raw, _is_seed = _current(clip_dir)
    if etag != receipt["result_etag"]:
        found = _find_archive(clip_dir, receipt["result_etag"], receipt["result_revision"])
        if found is None:
            raise RevisionConflict(current=doc, etag=etag)
        doc = found[1]
    return doc, receipt["result_etag"], _warnings(clip_dir, doc, seed_doc)


def _reconcile(clip_dir: Path, receipt: dict, client: dict, client_raw: bytes,
               expected_etag: str, seed_doc: Mapping) -> tuple[dict, str, tuple[Issue, ...]]:
    """A pending receipt with the same payload: finish or prove the interrupted transaction."""
    doc, etag, raw, is_seed = _current(clip_dir)
    result = receipt["result_etag"]
    published = etag == result or _find_archive(
        clip_dir, result, receipt["result_revision"]) is not None
    if not published:
        if etag != expected_etag:
            raise IdempotencyConflict()
        return _save(clip_dir, key=receipt["key"], payload=receipt["payload_sha256"],
                     client=client, client_raw=client_raw, current=doc, etag=etag,
                     current_raw=raw, is_seed=is_seed, seed_doc=seed_doc,
                     at_ms=receipt["at_ms"], expected_result=result)
    _write_receipt(clip_dir, {**receipt, "state": "committed"}, durable=False)
    _prune_locked(clip_dir, RECEIPTS_KEEP)
    return _replay(clip_dir, receipt, seed_doc)


def _put_arguments(expected_etag: object, idempotency_key: object, now_ms: object) -> str:
    if not isinstance(expected_etag, str) or _SHA.fullmatch(expected_etag) is None:
        raise ValueError("expected_etag must be 64 lowercase hex characters")
    if not isinstance(idempotency_key, str) or _KEY.fullmatch(idempotency_key.lower()) is None:
        raise ValueError("idempotency_key must be a UUID")
    if type(now_ms) is not int:
        raise TypeError("now_ms must be an integer")
    if now_ms < 0:
        raise ValueError("now_ms must not be negative")
    return idempotency_key.lower()


def put(
    clip_dir: Path, *, expected_etag: str, idempotency_key: str, raw: bytes, now_ms: int
) -> tuple[dict, str, tuple[Issue, ...]]:
    """Save a full document under the clip lock; returns (document, etag, warnings).

    ``If-Match`` = ``expected_etag``; ``revision == current + 1``; ``parent_sha256 == current
    etag``; ``base`` unchanged; the server stamps ``audit.updated_at_ms = max(now_ms, previous
    + 1)``; digest-only idempotency receipts; the superseded revision is archived. Parse errors
    (``DocInvalid``, ``SchemaTooNew``) are raised before the lock and write nothing. The cyclic
    garbage collector is paused while it runs (``_collector_paused``).
    """
    with _collector_paused():
        key = _put_arguments(expected_etag, idempotency_key, now_ms)
        return _put(_clip(clip_dir), key, expected_etag, raw, now_ms)


def _put(clip: Path, key: str, expected_etag: str, raw: bytes,
         now_ms: int) -> tuple[dict, str, tuple[Issue, ...]]:
    client = parse_doc(raw)
    client_raw = canonical_bytes(client)
    payload = hashlib.sha256(expected_etag.encode("ascii") + b"\0" + client_raw).hexdigest()
    with _locked(clip):
        seed_doc, _seed_etag, _seed_raw = _seed(clip)
        receipt = _read_receipt(clip, key)
        if receipt is not None:
            if receipt["payload_sha256"] != payload:
                raise IdempotencyConflict()
            if receipt["state"] == "committed":
                return _replay(clip, receipt, seed_doc)
            return _reconcile(clip, receipt, client, client_raw, expected_etag, seed_doc)
        current, etag, current_raw, is_seed = _current(clip, verify=False)
        if expected_etag != etag:
            raise RevisionConflict(current=current, etag=etag)
        return _save(clip, key=key, payload=payload, client=client, client_raw=client_raw,
                     current=current, etag=etag, current_raw=current_raw, is_seed=is_seed,
                     seed_doc=seed_doc, at_ms=max(now_ms, current["audit"]["updated_at_ms"] + 1))


__all__ = [
    "ARCHIVE_DIR",
    "ARCHIVE_GZIP_LEVEL",
    "ASSETS_DIR",
    "DOC_FILE",
    "LOCK_FILE",
    "RECEIPTS_DIR",
    "RECEIPTS_KEEP",
    "SEED_FILE",
    "WORDS_FILE",
    "archive_for_render",
    "get",
    "load_assets",
    "load_words",
    "prune_receipts",
    "put",
    "seed",
    "words_exist",
]
