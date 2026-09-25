"""Durable, idempotent filesystem render request queue and CLI authority.

Two request families share ``analysis/render-requests/``:

* ``render-request-v1``/``-v2``: exports of the legacy candidate editor. Their validation and
  every legacy function below are unchanged.
* ``render-request-v3`` (Editor V3 exports, plan §4.6): one revision of a clip's
  ``clip-edit-v2`` document, named by the render key and rendered by the single compiler
  (``render_worker`` hands it to ``edit_v2.render_edit.render_request``). See the section
  "render-request-v3" for the fields, the rules (R10 first, then an existing export of the same
  key, then the queue), cancellation, stage/progress heartbeats and retention.

CLIs: ``python -m ai_clipper.render_queue --job-dir <job>`` is the legacy protocol
(``{"operation": …}``); without arguments the module speaks the Editor V3 envelope of
``docs/editor/CONTRACTS.md`` §5.9 (``{"op": …}``, ``$JOBS_ROOT``, the §5.3 exit codes) for the
v3 routes, which spawn it through ``web/lib/python-cli.mjs``.
"""

from __future__ import annotations

import argparse
import dataclasses
import errno
import fcntl
import hashlib
import itertools
import json
import math
import os
import re
import stat
import subprocess
import sys
import threading
import uuid
import zlib
from collections.abc import Callable, Iterable, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any, BinaryIO, TextIO

from . import edit_manifest as storage
from .edit_manifest import manifest_sha256
from .edit_v2 import errors as edit_errors
from .edit_v2 import store as edit_store
from .edit_v2 import timemap as _timemap
from .edit_v2.clip_id import CLIP_ID_PATTERN
from .edit_v2.doc import content_equals_seed
from .edit_v2.glyphs import RESOURCES_DIR
from .edit_v2.plan import RenderPlan, Resources, build_plan, render_key, toolchain_sha256
from .ranking import MAX_ARTIFACT_BYTES, candidate_artifact_lock, read_candidates_artifact
from .render_manifest import ManifestRenderError, _stream_sha256_regular

MAX_REQUESTS = 1000
MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_COMMAND_BYTES = 64 * 1024
MAX_ATTEMPTS = 3
DEFAULT_LEASE_SECONDS = 300
DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z", re.IGNORECASE
)
_CANDIDATE = re.compile(r"cand_[0-9a-f]{64}\Z")
_SHA = re.compile(r"[0-9a-f]{64}\Z")
_STATES = {"queued", "claimed", "rendering", "completed", "failed"}
_FIELDS = {
    "version",
    "render_id",
    "idempotency_key",
    "state",
    "candidate_id",
    "candidate_artifact_sha256",
    "candidate_snapshot_relative",
    "edit_manifest_sha256",
    "edit_revision",
    "edit_manifest_relative",
    "source_identity_sha256",
    "source_content_sha256",
    "source_snapshot_relative",
    "output_relative",
    "created_at",
    "updated_at",
    "claimed_at",
    "rendering_at",
    "completed_at",
    "failed_at",
    "attempts",
    "error_code",
    "lease_token",
    "heartbeat_at",
}
_STORAGE_FIELDS = {"storage_reservation_id", "storage_reservation_token", "storage_reserved_bytes"}


class QueueError(Exception):
    pass


class QueueInvalid(QueueError):
    pass


class QueueNotFound(QueueError):
    pass


class QueueConflict(QueueError):
    pass


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise QueueInvalid("duplicate JSON key")
        result[key] = value
    return result


def _constant(_value):
    raise QueueInvalid("non-finite JSON number")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_time(value: object) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise QueueInvalid()
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise QueueInvalid() from error
    if parsed.tzinfo is None:
        raise QueueInvalid()
    return parsed


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    except (TypeError, ValueError) as error:
        raise QueueInvalid() from error


def _queue_dir(job: Path) -> Path:
    analysis = job / "analysis"
    storage._validate_analysis_dir(analysis)
    directory = analysis / "render-requests"
    storage._ensure_directory(directory)
    return directory


_thread_lock = threading.RLock()


def _reset_lock():
    global _thread_lock
    _thread_lock = threading.RLock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_lock)


@contextmanager
def _lock(directory: Path):
    path = directory / ".queue.lock"
    try:
        fd = os.open(
            path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600
        )
    except OSError as error:
        raise QueueInvalid() from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise QueueInvalid()
        with _thread_lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _entries(directory: Path) -> list[Path]:
    result = []
    try:
        entries = list(os.scandir(directory))
    except OSError as error:
        raise QueueInvalid() from error
    for entry in entries:
        if entry.name == ".queue.lock" or entry.name.startswith("."):
            continue
        if not entry.name.endswith(".json") or not _UUID.fullmatch(entry.name[:-5]):
            raise QueueInvalid()
        try:
            if not stat.S_ISREG(entry.stat(follow_symlinks=False).st_mode):
                raise QueueInvalid()
            if entry.stat(follow_symlinks=False).st_size > MAX_REQUEST_BYTES:
                raise QueueInvalid()
        except OSError as error:
            raise QueueInvalid() from error
        result.append(Path(entry.path))
    if len(result) > MAX_REQUESTS:
        raise QueueInvalid()
    return sorted(result)


def _validate(value: object) -> dict[str, object]:
    if type(value) is dict and value.get("version") == V3_VERSION:
        return _validate_v3(value)
    if type(value) is not dict or (
        set(value) != _FIELDS and set(value) != _FIELDS | _STORAGE_FIELDS
    ):
        raise QueueInvalid()
    admitted = set(value) == _FIELDS | _STORAGE_FIELDS
    if (
        value["version"] != ("render-request-v2" if admitted else "render-request-v1")
        or value["state"] not in _STATES
    ):
        raise QueueInvalid()
    if admitted and (
        not isinstance(value["storage_reservation_id"], str)
        or not _UUID.fullmatch(value["storage_reservation_id"])
        or not isinstance(value["storage_reservation_token"], str)
        or not _UUID.fullmatch(value["storage_reservation_token"])
        or not isinstance(value["storage_reserved_bytes"], int)
        or isinstance(value["storage_reserved_bytes"], bool)
        or not 0 < value["storage_reserved_bytes"] <= (1 << 64) - 1
    ):
        raise QueueInvalid()
    if not isinstance(value["render_id"], str) or not _UUID.fullmatch(value["render_id"]):
        raise QueueInvalid()
    if not isinstance(value["idempotency_key"], str) or not _UUID.fullmatch(
        value["idempotency_key"]
    ):
        raise QueueInvalid()
    if not isinstance(value["candidate_id"], str) or not _CANDIDATE.fullmatch(
        value["candidate_id"]
    ):
        raise QueueInvalid()
    for field in (
        "candidate_artifact_sha256",
        "edit_manifest_sha256",
        "source_identity_sha256",
        "source_content_sha256",
    ):
        if not isinstance(value[field], str) or not _SHA.fullmatch(value[field]):
            raise QueueInvalid()
    if (
        not isinstance(value["edit_revision"], int)
        or isinstance(value["edit_revision"], bool)
        or value["edit_revision"] < 1
    ):
        raise QueueInvalid()
    expected_manifest = f"analysis/edits/archive/{value['candidate_id']}.edit.v1.r{value['edit_revision']}.{value['edit_manifest_sha256']}.json"
    expected_output = f"output/edits/{value['candidate_id']}/revision-{value['edit_revision']}.mp4"
    expected_candidate = (
        f"analysis/render-inputs/candidates.{value['candidate_artifact_sha256']}.json"
    )
    source_snapshot = value["source_snapshot_relative"]
    if (
        value["edit_manifest_relative"] != expected_manifest
        or value["output_relative"] != expected_output
        or value["candidate_snapshot_relative"] != expected_candidate
        or not isinstance(source_snapshot, str)
        or re.fullmatch(
            rf"analysis/render-inputs/source\.{value['source_content_sha256']}\.[a-z0-9]{{1,10}}",
            source_snapshot,
        )
        is None
    ):
        raise QueueInvalid()
    for field in ("created_at", "updated_at"):
        _parse_time(value[field])
    for field in ("claimed_at", "rendering_at", "completed_at", "failed_at", "heartbeat_at"):
        if value[field] is not None:
            _parse_time(value[field])
    if (
        not isinstance(value["attempts"], int)
        or isinstance(value["attempts"], bool)
        or not 0 <= value["attempts"] <= MAX_ATTEMPTS
    ):
        raise QueueInvalid()
    if value["error_code"] is not None and value["error_code"] not in {
        "render_failed",
        "verification_failed",
        "max_attempts_exceeded",
    }:
        raise QueueInvalid()
    token = value["lease_token"]
    if token is not None and (not isinstance(token, str) or not _UUID.fullmatch(token)):
        raise QueueInvalid()
    state = value["state"]
    if (state in {"claimed", "rendering"}) != (
        token is not None and value["heartbeat_at"] is not None
    ):
        raise QueueInvalid()
    if state == "queued" and (
        value["attempts"] != 0
        or any(
            value[field] is not None
            for field in ("claimed_at", "rendering_at", "completed_at", "failed_at")
        )
        or value["error_code"] is not None
    ):
        raise QueueInvalid()
    if state == "claimed" and (value["claimed_at"] is None or value["rendering_at"] is not None):
        raise QueueInvalid()
    if state == "rendering" and (value["claimed_at"] is None or value["rendering_at"] is None):
        raise QueueInvalid()
    if state == "completed" and (value["completed_at"] is None or value["error_code"] is not None):
        raise QueueInvalid()
    if state == "failed" and (value["failed_at"] is None or value["error_code"] is None):
        raise QueueInvalid()
    return value


def _read(path: Path) -> dict[str, object]:
    try:
        raw = storage._read_regular(path, MAX_REQUEST_BYTES, missing=True)
    except storage.EditManifestNotFound as error:
        raise QueueNotFound() from error
    except (OSError, storage.EditManifestInvalid) as error:
        raise QueueInvalid() from error
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise QueueInvalid() from error
    value = _validate(value)
    if raw != _canonical(value):
        raise QueueInvalid()
    return value


def _write(directory: Path, value: dict[str, object]) -> dict[str, object]:
    value = _validate(value)
    raw = _canonical(value)
    if len(raw) > MAX_REQUEST_BYTES:
        raise QueueInvalid()
    target = directory / f"{value['render_id']}.json"
    storage._atomic_write(directory, target, raw)
    if storage._read_regular(target, MAX_REQUEST_BYTES) != raw:
        raise QueueInvalid()
    return value


def _job_source(job: Path) -> Path:
    """Resolve the exact job-owned source pathname; opening is performed separately."""
    try:
        raw = storage._read_regular(job / "job.json", MAX_REQUEST_BYTES)
        data = json.loads(raw.decode(), object_pairs_hook=_pairs, parse_constant=_constant)
        source_value = data["sourcePath"]
        if data.get("id") != job.name or not isinstance(source_value, str):
            raise QueueInvalid()
        source = Path(source_value)
        if not source.is_absolute():
            raise QueueInvalid()
        source = source.absolute()
        input_dir = job / "input"
        info = input_dir.lstat()
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISDIR(info.st_mode)
            or input_dir.resolve() != input_dir.absolute()
            or source.parent != input_dir.absolute()
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,254}", source.name)
        ):
            raise QueueInvalid()
        return source
    except QueueError:
        raise
    except Exception as error:
        raise QueueInvalid() from error


def estimate_source_bytes(job_dir: Path) -> int:
    job = Path(job_dir).absolute()
    source = _job_source(job)
    fd = None
    try:
        fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size < 0:
            raise QueueInvalid()
        return info.st_size
    except OSError as error:
        raise QueueInvalid() from error
    finally:
        if fd is not None:
            os.close(fd)


def _render_inputs(analysis: Path) -> Path:
    directory = analysis / "render-inputs"
    storage._ensure_directory(directory)
    try:
        os.chmod(directory, 0o700)
    except OSError as error:
        raise QueueInvalid() from error
    return directory


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _publish_snapshot(directory: Path, temporary: Path, target: Path, digest: str) -> None:
    try:
        os.link(temporary, target, follow_symlinks=False)
    except FileExistsError:
        try:
            if _stream_sha256_regular(target, "snapshot") != digest:
                raise QueueInvalid()
        except ManifestRenderError as error:
            raise QueueInvalid() from error
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    _fsync_dir(directory)


def _snapshot_source(job: Path, analysis: Path) -> tuple[str, str]:
    source = _job_source(job)
    extension = source.suffix[1:].lower()
    if not re.fullmatch(r"[a-z0-9]{1,10}", extension):
        extension = "bin"
    try:
        maximum = int(os.environ.get("MAX_UPLOAD_BYTES", str(DEFAULT_MAX_UPLOAD_BYTES)))
        if maximum <= 0:
            raise ValueError
    except ValueError as error:
        raise QueueInvalid() from error
    directory = _render_inputs(analysis)
    temporary = directory / f".source.{uuid.uuid4()}.tmp"
    source_fd = output_fd = None
    try:
        source_fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(source_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise QueueInvalid()
        digest = __import__("hashlib").sha256()
        total = 0
        while chunk := os.read(source_fd, min(1024 * 1024, maximum + 1 - total)):
            total += len(chunk)
            if total > maximum:
                raise QueueInvalid()
            digest.update(chunk)
        hexdigest = digest.hexdigest()
        target = directory / f"source.{hexdigest}.{extension}"
        if target.exists():
            try:
                if _stream_sha256_regular(target, "snapshot") != hexdigest:
                    raise QueueInvalid()
            except ManifestRenderError as error:
                raise QueueInvalid() from error
            return str(target.relative_to(job)), hexdigest
        os.lseek(source_fd, 0, os.SEEK_SET)
        output_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        while chunk := os.read(source_fd, 1024 * 1024):
            offset = 0
            while offset < len(chunk):
                offset += os.write(output_fd, chunk[offset:])
        os.fsync(output_fd)
    except OSError as error:
        raise QueueInvalid() from error
    finally:
        if output_fd is not None:
            os.close(output_fd)
        if source_fd is not None:
            os.close(source_fd)
    target = directory / f"source.{hexdigest}.{extension}"
    _publish_snapshot(directory, temporary, target, hexdigest)
    return str(target.relative_to(job)), hexdigest


def _snapshot_candidates(job: Path, analysis: Path, expected_digest: str) -> str:
    directory = _render_inputs(analysis)
    with candidate_artifact_lock(analysis, exclusive=False):
        try:
            raw = storage._read_regular(analysis / "candidates.v2.json", MAX_ARTIFACT_BYTES)
        except (OSError, storage.EditManifestInvalid) as error:
            raise QueueInvalid() from error
        digest = __import__("hashlib").sha256(raw).hexdigest()
        if digest != expected_digest:
            raise QueueConflict()
        target = directory / f"candidates.{digest}.json"
        if target.exists():
            try:
                if _stream_sha256_regular(target, "snapshot") != digest:
                    raise QueueInvalid()
                read_candidates_artifact(target)
            except (ManifestRenderError, OSError, ValueError) as error:
                raise QueueInvalid() from error
            return str(target.relative_to(job))
        temporary = directory / f".candidates.{uuid.uuid4()}.tmp"
        fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        try:
            offset = 0
            while offset < len(raw):
                offset += os.write(fd, raw[offset:])
            os.fsync(fd)
        finally:
            os.close(fd)
        target = directory / f"candidates.{digest}.json"
        _publish_snapshot(directory, temporary, target, digest)
        try:
            read_candidates_artifact(target)
        except (OSError, ValueError) as error:
            raise QueueInvalid() from error
    return str(target.relative_to(job))


def create_request(
    job_dir: Path,
    candidate_id: str,
    edit_etag: str,
    idempotency_key: str,
    *,
    storage_reservation: dict[str, object] | None = None,
) -> dict[str, object]:
    job = Path(job_dir).absolute()
    if (
        not _UUID.fullmatch(job.name)
        or not _CANDIDATE.fullmatch(candidate_id)
        or not _SHA.fullmatch(edit_etag)
        or not _UUID.fullmatch(idempotency_key)
    ):
        raise QueueInvalid()
    if storage_reservation is not None and (
        type(storage_reservation) is not dict
        or set(storage_reservation) != {"reservation_id", "token", "reserved_bytes"}
        or not isinstance(storage_reservation["reservation_id"], str)
        or not _UUID.fullmatch(storage_reservation["reservation_id"])
        or not isinstance(storage_reservation["token"], str)
        or not _UUID.fullmatch(storage_reservation["token"])
        or not isinstance(storage_reservation["reserved_bytes"], int)
        or isinstance(storage_reservation["reserved_bytes"], bool)
        or not 0 < storage_reservation["reserved_bytes"] <= (1 << 64) - 1
    ):
        raise QueueInvalid()
    key = idempotency_key.lower()
    directory = _queue_dir(job)
    analysis = job / "analysis"
    with _lock(directory), storage._edit_transaction(analysis, candidate_id) as edits:
        entries = _entries(directory)
        for path in entries:
            request = _read(path)
            if request["idempotency_key"] == key:
                if (
                    request.get("candidate_id") != candidate_id  # v3 requests have no candidate
                    or request["edit_manifest_sha256"] != edit_etag
                ):
                    raise QueueConflict()
                return request
        if len(entries) >= MAX_REQUESTS:
            raise QueueInvalid()
        manifest = storage._read_edit_manifest_locked(analysis, edits, candidate_id)
        if manifest_sha256(manifest) != edit_etag:
            raise QueueConflict()
        archive = storage._archive_current(edits, manifest, edit_etag)
        candidate_snapshot = _snapshot_candidates(
            job, analysis, manifest.identity.candidate_artifact_sha256
        )
        source_snapshot, source_digest = _snapshot_source(job, analysis)
        now = _now()
        render_id = str(uuid.uuid4())
        request = {
            "version": "render-request-v2"
            if storage_reservation is not None
            else "render-request-v1",
            "render_id": render_id,
            "idempotency_key": key,
            "state": "queued",
            "candidate_id": candidate_id,
            "candidate_artifact_sha256": manifest.identity.candidate_artifact_sha256,
            "candidate_snapshot_relative": candidate_snapshot,
            "edit_manifest_sha256": edit_etag,
            "edit_revision": manifest.revision,
            "edit_manifest_relative": str(archive.relative_to(job)),
            "source_identity_sha256": manifest.identity.source_sha256,
            "source_content_sha256": source_digest,
            "source_snapshot_relative": source_snapshot,
            "output_relative": f"output/edits/{candidate_id}/revision-{manifest.revision}.mp4",
            "created_at": now,
            "updated_at": now,
            "claimed_at": None,
            "rendering_at": None,
            "completed_at": None,
            "failed_at": None,
            "attempts": 0,
            "error_code": None,
            "lease_token": None,
            "heartbeat_at": None,
        }
        if storage_reservation is not None:
            request.update(
                storage_reservation_id=storage_reservation["reservation_id"],
                storage_reservation_token=storage_reservation["token"],
                storage_reserved_bytes=storage_reservation["reserved_bytes"],
            )
        return _write(directory, request)


def get_request(job_dir: Path, render_id: str) -> dict[str, object]:
    if not isinstance(render_id, str) or not _UUID.fullmatch(render_id):
        raise QueueInvalid()
    directory = _queue_dir(Path(job_dir).absolute())
    with _lock(directory):
        return _read(directory / f"{render_id.lower()}.json")


def claim_next(
    job_dir: Path, *, lease_seconds: float = DEFAULT_LEASE_SECONDS
) -> dict[str, object] | None:
    if (
        isinstance(lease_seconds, bool)
        or not isinstance(lease_seconds, (int, float))
        or not math.isfinite(lease_seconds)
        or lease_seconds <= 0
    ):
        raise QueueInvalid()
    directory = _queue_dir(Path(job_dir).absolute())
    now_dt = datetime.now(UTC)
    now = _now()
    with _lock(directory):
        requests = [_read(path) for path in _entries(directory)]
        available = None
        for request in requests:
            if request["state"] == "queued":
                available = request
                break
            if request["state"] in {"claimed", "rendering"}:
                heartbeat_at = request["heartbeat_at"]
                if heartbeat_at is not None and now_dt - _parse_time(heartbeat_at) > timedelta(
                    seconds=lease_seconds
                ):
                    if (
                        request.get("version") == V3_VERSION
                        and request["cancel_requested_at"] is not None
                    ):
                        # its worker is gone and the user cancelled it: never render it again
                        _write(directory, _v3_ended(request, "cancelled", now))
                        continue
                    if request["attempts"] >= MAX_ATTEMPTS:
                        _write(
                            directory,
                            {
                                **request,
                                "state": "failed",
                                "updated_at": now,
                                "failed_at": now,
                                "error_code": "max_attempts_exceeded",
                                "lease_token": None,
                                "heartbeat_at": None,
                            },
                        )
                        continue
                    available = request
                    break
        if available is None:
            return None
        token = str(uuid.uuid4())
        claimed = {
            **available,
            "state": "claimed",
            "attempts": int(available["attempts"]) + 1,
            "claimed_at": now,
            "rendering_at": None,
            "updated_at": now,
            "lease_token": token,
            "heartbeat_at": now,
        }
        if available.get("version") == V3_VERSION:
            claimed.update(stage="antre", progress_pm=0)
        return _write(directory, claimed)


def heartbeat(job_dir: Path, render_id: str, lease_token: str) -> dict[str, object]:
    directory = _queue_dir(Path(job_dir).absolute())
    now = _now()
    with _lock(directory):
        current = _read(directory / f"{render_id}.json")
        if (
            current["state"] not in {"claimed", "rendering"}
            or current["lease_token"] != lease_token
        ):
            raise QueueConflict()
        return _write(directory, {**current, "heartbeat_at": now, "updated_at": now})


def update_request(
    job_dir: Path,
    render_id: str,
    state: str,
    *,
    lease_token: str,
    error_code: str | None = None,
) -> dict[str, object]:
    directory = _queue_dir(Path(job_dir).absolute())
    now = _now()
    with _lock(directory):
        current = _read(directory / f"{render_id}.json")
        if current["lease_token"] != lease_token:
            raise QueueConflict()
        allowed = {
            ("claimed", "rendering"),
            ("rendering", "completed"),
            ("claimed", "failed"),
            ("rendering", "failed"),
        }
        if (current["state"], state) not in allowed:
            raise QueueConflict()
        patch: dict[str, object] = {"state": state, "updated_at": now}
        if state == "rendering":
            patch.update(rendering_at=now, heartbeat_at=now)
        elif state == "completed":
            patch.update(completed_at=now, error_code=None, lease_token=None, heartbeat_at=None)
        else:
            if error_code not in {"render_failed", "verification_failed"}:
                raise QueueInvalid()
            patch.update(
                failed_at=now,
                error_code=error_code,
                lease_token=None,
                heartbeat_at=None,
            )
        return _write(directory, {**current, **patch})


def publish_completed_output(
    job_dir: Path, render_id: str, lease_token: str, staging: Path
) -> dict[str, object]:
    """Fence publication and completion under the same queue ownership lock."""
    job = Path(job_dir).absolute()
    directory = _queue_dir(job)
    now = _now()
    with _lock(directory):
        current = _read(directory / f"{render_id}.json")
        if current["state"] != "rendering" or current["lease_token"] != lease_token:
            raise QueueConflict()
        expected_staging_parent = job / "analysis" / "render-staging"
        staging = Path(staging).absolute()
        if staging.parent != expected_staging_parent or not re.fullmatch(
            rf"{re.escape(render_id)}\.{re.escape(lease_token)}\.mp4", staging.name
        ):
            raise QueueInvalid()
        try:
            info = staging.lstat()
        except OSError as error:
            raise QueueInvalid() from error
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise QueueInvalid()
        output = job / str(current["output_relative"])
        try:
            os.link(staging, output, follow_symlinks=False)
        except FileExistsError:
            raise QueueConflict() from None
        except OSError as error:
            raise QueueInvalid() from error
        _fsync_dir(output.parent)
        return _write(
            directory,
            {
                **current,
                "state": "completed",
                "updated_at": now,
                "completed_at": now,
                "error_code": None,
                "lease_token": None,
                "heartbeat_at": None,
            },
        )


def process(job: Path, command: object):
    if type(command) is not dict or not isinstance(command.get("operation"), str):
        raise QueueInvalid()
    op = command["operation"]
    if op == "create" and set(command) in (
        {"operation", "candidateId", "editEtag", "idempotencyKey"},
        {"operation", "candidateId", "editEtag", "idempotencyKey", "storageReservation"},
    ):
        return create_request(
            job,
            command["candidateId"],
            command["editEtag"],
            command["idempotencyKey"],
            storage_reservation=command.get("storageReservation"),
        )
    if op == "get" and set(command) == {"operation", "renderId"}:
        return get_request(job, command["renderId"])
    if op == "estimate" and set(command) == {"operation"}:
        return {"sourceBytes": str(estimate_source_bytes(job))}
    if op == "claim" and set(command) <= {"operation", "leaseSeconds"}:
        return claim_next(job, lease_seconds=command.get("leaseSeconds", DEFAULT_LEASE_SECONDS))
    if (
        op == "update"
        and set(command) <= {"operation", "renderId", "state", "leaseToken", "errorCode"}
        and "leaseToken" in command
    ):
        return update_request(
            job,
            command["renderId"],
            command["state"],
            lease_token=command["leaseToken"],
            error_code=command.get("errorCode"),
        )
    if op == "heartbeat" and set(command) == {"operation", "renderId", "leaseToken"}:
        return heartbeat(job, command["renderId"], command["leaseToken"])
    raise QueueInvalid()


def run(argv: list[str], stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO) -> int:
    if not argv:  # the Editor V3 envelope (no --job-dir): see handle_v3
        return run_v3(stdin, stdout)
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--job-dir", required=True)
    try:
        args = parser.parse_args(argv)
        raw = stdin.read(MAX_COMMAND_BYTES + 1)
        if not raw or len(raw) > MAX_COMMAND_BYTES:
            raise QueueInvalid()
        command = json.loads(raw.decode(), object_pairs_hook=_pairs, parse_constant=_constant)
        stdout.write(_canonical(process(Path(args.job_dir), command)) + b"\n")
        return 0
    except QueueConflict:
        stderr.write("render_queue_conflict\n")
        return 5
    except QueueNotFound:
        stderr.write("render_queue_not_found\n")
        return 4
    except Exception:  # noqa: BLE001 - protocol boundary sanitizes every failure
        stderr.write("render_queue_invalid\n")
        return 3


# --- render-request-v3 (Editor V3 exports; plan §4.6, §4.2, §9.1; T2.2) --------------------------
#
# Fields (exact set, canonical JSON like v1/v2):
#   version "render-request-v3", render_id, idempotency_key (lowercase UUID), state, stage,
#   progress_pm; clip_id, doc_sha256, doc_revision, doc_relative (seed.json for revision 0,
#   else edit/archive/r<N>.<sha>.json.gz); render_key, size "output", quality "standar",
#   output_relative (output/edits/<clip_id>/<render_key16>.mp4; the .srt is its sibling);
#   source_content_sha256, source_snapshot_relative (null only for an instant completion);
#   timeout_ms; created/updated/claimed/rendering/completed/failed/cancelled_at,
#   cancel_requested_at; attempts, error_code, warnings, completed_by ("render" | "seed" |
#   "key"); lease_token, heartbeat_at; storage_reservation_id/_token/_reserved_bytes (all
#   null or all set).
#
# Rules:
#   * R10 first: a document whose content equals the seed completes at creation by hard-linking
#     the auto clip (output/clip-NN.mp4 + .srt) after its G1–G2 re-verification against the
#     seed's plan, whatever the toolchain or engine; an auto file that is missing or fails
#     G1–G2 renders normally with the warning ``auto_file_unavailable``.
#   * Otherwise an existing export of the same render key (published only after verification,
#     under a content-addressed name) completes it instantly (``completed_by: "key"``).
#   * Otherwise the source is snapshotted by hard link (verified copy across devices) and the
#     request is queued for the render worker.
#   * The render key is ``plan.render_key(..., measure_sha=None)``: a loudness measurement is a
#     function of inputs the key already holds (the plan with the source content sha, the asset
#     shas and the toolchain), so the queue can name the output before anything is rendered.
#   * Cancel: queued → cancelled at once; claimed/rendering → ``cancel_requested_at``, which the
#     worker polls and turns into a kill of FFmpeg (≤ 2 s) and the state ``cancelled``.
#   * Timeout ``max(120 s, 3 × predicted)`` with ``predicted = duration × cost(layout, size)``
#     (``RENDER_COST_PERMILLE``, the PF-RENDER budget); liveness is the worker's (20 s).
#   * Retention: terminal v3 requests older than 7 days are pruned at every create, keeping the
#     newest 200 terminal ones whatever their age. Legacy requests are never pruned here.

V3_VERSION = "render-request-v3"
V3_STATES = frozenset({"queued", "claimed", "rendering", "completed", "failed", "cancelled"})
V3_TERMINAL = frozenset({"completed", "failed", "cancelled"})
V3_STAGES = ("antre", "merender", "memverifikasi", "selesai")
V3_RENDER_STAGES = frozenset({"merender", "memverifikasi"})
V3_FAILURE_CODES = frozenset(
    {"render_failed", "render_timeout", "render_stalled", "verification_failed"}
)
V3_ERROR_CODES = V3_FAILURE_CODES | {"cancelled", "max_attempts_exceeded"}
V3_COMPLETED_BY = frozenset({"render", "seed", "key"})
V3_WARNING_CODES = edit_errors.WARNING_CODES | {"auto_file_unavailable", "engine_fallback"}
V3_MAX_WARNINGS = 16
RETENTION_DAYS = 7
RETENTION_KEEP = 200
TIMEOUT_FLOOR_MS = 120_000
TIMEOUT_FACTOR = 3
TIMEOUT_MAX_MS = 24 * 3600 * 1000
# Predicted render time per second of output, in per-mille, by (layout, output size): the
# PF-RENDER budget (p95 ≤ 0.6× at 720×1280 on 4 CPUs; face-track adds its crop track, the
# larger size has 2.25× the pixels). T4.3 recalibrates it from measured renders.
RENDER_COST_PERMILLE = {
    ("fit_blur", (720, 1280)): 600,
    ("fill_center", (720, 1280)): 500,
    ("camera", (720, 1280)): 800,
    ("fit_blur", (1080, 1920)): 1350,
    ("fill_center", (1080, 1920)): 1125,
    ("camera", (1080, 1920)): 1800,
}
OUTPUT_BYTES_PER_SECOND = 1_000_000  # storage estimate of an export: 8 Mbit/s of output
SRT_ALLOWANCE_BYTES = 65_536
MAX_DOC_ARCHIVE_BYTES = 1 << 20
MAX_MANIFEST_BYTES = 16 << 20

_V3_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")
_V3_WARNING = re.compile(r"([a-z][a-z_]{0,39})(?::[0-9A-Za-z .+\-]{1,32})?\Z")
_CAMERA_NAME = re.compile(r"camera\.[0-9a-f]{16}\.json\Z")
_V3_FIELDS = frozenset(
    {
        "version", "render_id", "idempotency_key", "state", "stage", "progress_pm",
        "clip_id", "doc_sha256", "doc_revision", "doc_relative",
        "render_key", "size", "quality", "output_relative",
        "source_content_sha256", "source_snapshot_relative", "timeout_ms",
        "created_at", "updated_at", "claimed_at", "rendering_at", "completed_at", "failed_at",
        "cancelled_at", "cancel_requested_at",
        "attempts", "error_code", "warnings", "completed_by", "lease_token", "heartbeat_at",
        "storage_reservation_id", "storage_reservation_token", "storage_reserved_bytes",
    }
)
_V3_STORAGE = ("storage_reservation_id", "storage_reservation_token", "storage_reserved_bytes")
_V3_TIMES = ("claimed_at", "rendering_at", "completed_at", "failed_at", "cancelled_at",
             "cancel_requested_at", "heartbeat_at")


class QueueRevisionConflict(QueueConflict):
    """The edit etag is not a revision of the clip (current or archived)."""


class QueueIdempotencyConflict(QueueConflict):
    """The idempotency key names another request (other clip, revision or version)."""


class QueueSourceMissing(QueueError):
    """The job's source is gone or no longer has the content the document was seeded from."""


class QueueAnalysisMissing(QueueError):
    """The words artifact (or the camera plan) of the document does not exist."""


class QueueUnavailable(QueueError):
    """The render key cannot be computed (no pinned ``resources/toolchain.json``)."""


def _stamp(moment: datetime | None) -> str:
    if moment is None:
        return _now()
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _v3_int(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _v3_sha(value: object) -> bool:
    return isinstance(value, str) and _SHA.fullmatch(value) is not None


def _v3_uuid(value: object) -> bool:
    return isinstance(value, str) and _V3_UUID.fullmatch(value) is not None


def _v3_warning(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = _V3_WARNING.fullmatch(value)
    return match is not None and match.group(1) in V3_WARNING_CODES


def _v3_doc_relative(clip_id: str, revision: int, doc_sha: str) -> str:
    if revision == 0:
        return f"analysis/clips/{clip_id}/{edit_store.SEED_FILE}"
    return f"analysis/clips/{clip_id}/{edit_store.ARCHIVE_DIR}/r{revision}.{doc_sha}.json.gz"


def _v3_output_relative(clip_id: str, key: str) -> str:
    return f"output/edits/{clip_id}/{key[:16]}.mp4"


def srt_relative(output_relative: str) -> str:
    """The ``.srt`` sidecar of an export: the sibling of its ``.mp4``."""
    return output_relative[: -len(".mp4")] + ".srt"


def _validate_v3(value: dict[str, object]) -> dict[str, object]:
    """Strict validation of a render-request-v3 (unknown keys, types, paths, state machine)."""
    if set(value) != _V3_FIELDS or value["version"] != V3_VERSION:
        raise QueueInvalid()
    clip_id, render_key_value = value["clip_id"], value["render_key"]
    if (
        not _v3_uuid(value["render_id"])
        or not _v3_uuid(value["idempotency_key"])
        or not isinstance(clip_id, str)
        or CLIP_ID_PATTERN.fullmatch(clip_id) is None
        or not all(_v3_sha(value[k]) for k in ("doc_sha256", "render_key", "source_content_sha256"))
        or not _v3_int(value["doc_revision"], 0, (1 << 53) - 1)
        or value["doc_relative"]
        != _v3_doc_relative(clip_id, value["doc_revision"], value["doc_sha256"])
        or value["size"] != "output"
        or value["quality"] != "standar"
        or value["output_relative"] != _v3_output_relative(clip_id, render_key_value)
        or value["state"] not in V3_STATES
        or value["stage"] not in V3_STAGES
        or not _v3_int(value["progress_pm"], 0, 1000)
        or not _v3_int(value["timeout_ms"], TIMEOUT_FLOOR_MS, TIMEOUT_MAX_MS)
        or not _v3_int(value["attempts"], 0, MAX_ATTEMPTS)
        or (value["error_code"] is not None and value["error_code"] not in V3_ERROR_CODES)
        or (value["completed_by"] is not None and value["completed_by"] not in V3_COMPLETED_BY)
        or (value["lease_token"] is not None and not _v3_uuid(value["lease_token"]))
    ):
        raise QueueInvalid()
    warnings = value["warnings"]
    if (
        type(warnings) is not list
        or len(warnings) > V3_MAX_WARNINGS
        or len(set(map(str, warnings))) != len(warnings)
        or not all(_v3_warning(item) for item in warnings)
    ):
        raise QueueInvalid()
    snapshot = value["source_snapshot_relative"]
    if snapshot is not None and (
        not isinstance(snapshot, str)
        or re.fullmatch(
            rf"analysis/render-inputs/source\.{value['source_content_sha256']}\.[a-z0-9]{{1,10}}",
            snapshot,
        )
        is None
    ):
        raise QueueInvalid()
    storage_values = [value[field] for field in _V3_STORAGE]
    if any(item is not None for item in storage_values) and not (
        _v3_uuid(storage_values[0])
        and _v3_uuid(storage_values[1])
        and _v3_int(storage_values[2], 1, (1 << 64) - 1)
    ):
        raise QueueInvalid()
    for field in ("created_at", "updated_at"):
        _parse_time(value[field])
    for field in _V3_TIMES:
        if value[field] is not None:
            _parse_time(value[field])
    _validate_v3_state(value)
    return value


def _validate_v3_state(value: Mapping[str, object]) -> None:
    state = value["state"]

    def unset(*fields: str) -> bool:
        return all(value[field] is None for field in fields)

    def set_(*fields: str) -> bool:
        return all(value[field] is not None for field in fields)

    leased = state in {"claimed", "rendering"}
    ok = leased == set_("lease_token", "heartbeat_at")
    ok = ok and (
        value["source_snapshot_relative"] is not None
        or (state == "completed" and value["completed_by"] in {"seed", "key"})
    )
    if state == "queued":
        ok = ok and (
            value["attempts"] == 0
            and value["stage"] == "antre"
            and value["progress_pm"] == 0
            and value["error_code"] is None
            and value["completed_by"] is None
            and unset("claimed_at", "rendering_at", "completed_at", "failed_at", "cancelled_at",
                      "cancel_requested_at")
        )
    elif state == "claimed":
        ok = ok and (
            value["attempts"] >= 1
            and value["stage"] == "antre"
            and value["progress_pm"] == 0
            and value["error_code"] is None
            and value["completed_by"] is None
            and set_("claimed_at")
            and unset("rendering_at", "completed_at", "failed_at", "cancelled_at")
        )
    elif state == "rendering":
        ok = ok and (
            value["attempts"] >= 1
            and value["stage"] in V3_RENDER_STAGES
            and value["error_code"] is None
            and value["completed_by"] is None
            and set_("claimed_at", "rendering_at")
            and unset("completed_at", "failed_at", "cancelled_at")
        )
    elif state == "completed":
        ok = ok and (
            value["stage"] == "selesai"
            and value["progress_pm"] == 1000
            and value["error_code"] is None
            and value["completed_by"] is not None
            and set_("completed_at")
            and unset("failed_at", "cancelled_at")
            and (value["completed_by"] != "render"
                 or (value["attempts"] >= 1 and set_("claimed_at", "rendering_at")))
        )
    elif state == "failed":
        ok = ok and (
            value["attempts"] >= 1
            and value["error_code"] in V3_FAILURE_CODES | {"max_attempts_exceeded"}
            and value["completed_by"] is None
            and set_("failed_at", "claimed_at")
            and unset("completed_at", "cancelled_at")
        )
    else:  # cancelled
        ok = ok and (
            value["error_code"] == "cancelled"
            and value["completed_by"] is None
            and set_("cancelled_at")
            and unset("completed_at", "failed_at")
        )
    if not ok:
        raise QueueInvalid()


def _v3_ended(request: Mapping[str, object], state: str, now: str, *,
              error_code: str | None = None, warnings: Iterable[str] = ()) -> dict[str, object]:
    """A leased or queued request ended as ``failed`` (with ``error_code``) or ``cancelled``."""
    ended: dict[str, object] = {
        **request,
        "state": state,
        "updated_at": now,
        "lease_token": None,
        "heartbeat_at": None,
        "warnings": _merge_warnings(request["warnings"], warnings),
    }
    if state == "cancelled":
        ended.update(cancelled_at=now, error_code="cancelled")
    else:
        ended.update(failed_at=now, error_code=error_code)
    return ended


def _merge_warnings(current: object, extra: Iterable[str]) -> list[str]:
    merged = list(current) if isinstance(current, list) else []
    for item in extra:
        if item not in merged:
            merged.append(item)
    if len(merged) > V3_MAX_WARNINGS or not all(_v3_warning(item) for item in merged):
        raise QueueInvalid()
    return merged


def predicted_render_ms(duration_ms: int, layout: str, size: tuple[int, int]) -> int:
    """Predicted render time of ``duration_ms`` of output (``RENDER_COST_PERMILLE``)."""
    cost = RENDER_COST_PERMILLE[(layout, (size[0], size[1]))]
    return -(-duration_ms * cost // 1000)


def render_timeout_ms(duration_ms: int, layout: str, size: tuple[int, int]) -> int:
    """``max(120 s, 3 × predicted)`` (plan §4.6; fixes D9's fixed 120 s)."""
    return max(TIMEOUT_FLOOR_MS, TIMEOUT_FACTOR * predicted_render_ms(duration_ms, layout, size))


def _duration_ms(doc: Mapping[str, Any]) -> int:
    fps = _timemap.Fps.from_json(doc["output"]["fps"])
    frames = _timemap.total_frames(_timemap.pieces(doc))
    return _timemap.div_round_half_up(frames * 1000 * fps.den, fps.num)


def _check_v3_ids(job: Path, **values: object) -> None:
    patterns = {"clip_id": CLIP_ID_PATTERN, "edit_etag": _SHA, "idempotency_key": _UUID,
                "render_id": _UUID}
    if not _UUID.fullmatch(job.name):
        raise QueueInvalid()
    for name, value in values.items():
        if not isinstance(value, str) or patterns[name].fullmatch(value) is None:
            raise QueueInvalid()


def _check_reservation(reservation: object) -> None:
    if reservation is not None and (
        type(reservation) is not dict
        or set(reservation) != {"reservation_id", "token", "reserved_bytes"}
        or not _v3_uuid(reservation["reservation_id"])
        or not _v3_uuid(reservation["token"])
        or not _v3_int(reservation["reserved_bytes"], 1, (1 << 64) - 1)
    ):
        raise QueueInvalid()


def _real_dir(path: Path, missing: type[QueueError] = QueueNotFound) -> Path:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        raise missing() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise QueueInvalid()
    return path


def _clip_dir(job: Path, clip_id: str) -> Path:
    for part in (job / "analysis", job / "analysis" / "clips"):
        _real_dir(part)
    return _real_dir(job / "analysis" / "clips" / clip_id)


def _private_dir(path: Path) -> Path:
    """Create (0700) or accept a real directory; a symlink or a file is refused."""
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    else:
        _fsync_dir(path.parent)
    return _real_dir(path, QueueInvalid)


def _edits_dir(job: Path, clip_id: str) -> Path:
    output = _private_dir(job / "output")
    return _private_dir(_private_dir(output / "edits") / clip_id)


def _regular(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    return info if stat.S_ISREG(info.st_mode) else None


def _published(job: Path, output_relative: str) -> bool:
    """The export and its .srt exist as regular files (they are linked only after verify)."""
    return (_regular(job / output_relative) is not None
            and _regular(job / srt_relative(output_relative)) is not None)


def _read_doc(job: Path, relative: str, etag: str) -> dict[str, Any]:
    """The document a request names (seed.json or a gzip archive) whose bytes hash to etag."""
    try:
        data = storage._read_regular(job / relative, MAX_DOC_ARCHIVE_BYTES)
    except (OSError, storage.EditManifestError) as error:
        raise QueueInvalid() from error
    if relative.endswith(".gz"):
        try:
            inflater = zlib.decompressobj(wbits=31)
            data = inflater.decompress(data, MAX_DOC_ARCHIVE_BYTES + 1)
        except zlib.error as error:
            raise QueueInvalid() from error
        if len(data) > MAX_DOC_ARCHIVE_BYTES or not inflater.eof:
            raise QueueInvalid()
    if hashlib.sha256(data).hexdigest() != etag:
        raise QueueInvalid()
    try:
        doc = json.loads(data)
    except ValueError as error:
        raise QueueInvalid() from error
    if type(doc) is not dict:
        raise QueueInvalid()
    return doc


def _find_doc(clip: Path, etag: str) -> dict[str, Any]:
    """Read-only lookup of a revision by etag: the seed, the current document or the archive."""
    seed_doc, seed_etag = edit_store.seed(clip)
    if etag == seed_etag:
        return seed_doc
    doc, current_etag, _is_seed = edit_store.get(clip)
    if etag == current_etag:
        return doc
    found = edit_store._find_archive(clip, etag)
    if found is None:
        raise QueueRevisionConflict()
    return found[1]


def _camera_for(clip: Path, doc: Mapping[str, Any]) -> dict[str, Any] | None:
    """The camera plan of a face-track document: the seed's (``base.camera.sha256``), else the
    one plan built on demand for the clip (W3 layout switch)."""
    if doc["layout"]["default"]["mode"] != "camera":
        return None
    sha = doc["base"]["camera"]["sha256"]
    if sha is not None:
        path = clip / f"camera.{sha[:16]}.json"
    else:
        names = sorted(name for name in os.listdir(clip) if _CAMERA_NAME.fullmatch(name))
        if len(names) != 1:
            raise QueueAnalysisMissing()
        path = clip / names[0]
    try:
        raw = storage._read_regular(path, 32 << 20, missing=True)
    except storage.EditManifestNotFound:
        raise QueueAnalysisMissing() from None
    except (OSError, storage.EditManifestError) as error:
        raise QueueInvalid() from error
    if sha is not None and hashlib.sha256(raw).hexdigest() != sha:
        raise QueueInvalid()
    try:
        return json.loads(raw)
    except ValueError as error:
        raise QueueInvalid() from error


def _plan(clip: Path, doc: Mapping[str, Any], resources: Resources) -> RenderPlan:
    try:
        words = edit_store.load_words(clip, doc["base"]["words"]["sha256"])
        camera = _camera_for(clip, doc)
        assets = edit_store.load_assets(clip, doc["assets"].keys())
        return build_plan(doc, words=words, camera=camera, assets=assets, resources=resources)
    except edit_errors.AnalysisMissing:
        raise QueueAnalysisMissing() from None


def _auto_file(job: Path, clip_id: str, seed_doc: Mapping[str, Any]) -> Path | None:
    """The auto render of the clip: ``output/clip-NN.mp4`` with NN the manifest index of the
    clip (``clip_id`` recorded by the new engine), else the seed's rank (``clip-NN`` = rank)."""
    index = seed_doc["base"]["origin"]["rank_at_seed"]
    try:
        manifest = json.loads(storage._read_regular(job / "output" / "manifest.json",
                                                    MAX_MANIFEST_BYTES))
    except (OSError, ValueError, storage.EditManifestError):
        manifest = None
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    for entry in clips if isinstance(clips, list) else ():
        if isinstance(entry, dict) and entry.get("clip_id") == clip_id:
            if type(entry.get("index")) is int and 1 <= entry["index"] <= 999:
                index = entry["index"]
            break
    try:
        _real_dir(job / "output", QueueNotFound)
    except QueueError:
        return None
    path = job / "output" / f"clip-{index:02d}.mp4"
    return path if _regular(path) is not None else None


LEGACY_R10_TOLERANCE_FRAMES = 4


def _video_timing(fd: int) -> tuple[float, bool]:
    """(duration in seconds, constant frame rate) of the first video stream, from its packets."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
         "-show_entries", "stream=time_base:packet=pts,duration", "-of", "json",
         f"/proc/self/fd/{fd}"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, pass_fds=(fd,), timeout=300,
        env={"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
        check=False)
    if result.returncode != 0:
        raise RuntimeError("ffprobe failed")
    data = json.loads(result.stdout)
    base = Fraction(data["streams"][0]["time_base"])
    packets = [(int(item["pts"]), int(item.get("duration") or 0))
               for item in data.get("packets", ()) if "pts" in item]
    if not packets:
        raise RuntimeError("no video packets")
    pts = sorted(value for value, _duration in packets)
    steps = {later - earlier for earlier, later in itertools.pairwise(pts)}
    constant = len(steps) <= 1
    end = pts[-1] + steps.pop() if constant and steps else max(p + d for p, d in packets)
    return float((end - pts[0]) * base), constant


def _legacy_auto_ok(fd: int, plan: RenderPlan, report: Any) -> bool:
    """R10 for an auto clip of the legacy engine (plan §4.4: "Ekspor tanpa perubahan" returns the
    original file). That renderer keeps its own constant rate (60 fps, 23.976 for a VFR source)
    and trims by seconds, so G1 must hold except the document's rate, and G2 holds by duration:
    video and audio within ``LEGACY_R10_TOLERANCE_FRAMES`` output frames of the plan (32 real
    clips measured 0 to 2.5 frames short)."""
    gates = {gate.name: gate for gate in getattr(report, "gates", ())}
    g1, g2 = gates.get("G1"), gates.get("G2")
    if g1 is None or g2 is None or set(g1.problems) - {"frame_rate"}:
        return False
    if any(gate.blocking and not gate.ok for name, gate in gates.items() if name not in {"G1", "G2"}):
        return False
    fps = plan.fps
    samples = g2.values.get("samples")
    if type(samples) is not int or abs(samples - plan.total_samples) > _timemap.smp(
            LEGACY_R10_TOLERANCE_FRAMES, fps):
        return False
    try:
        duration_s, constant = _video_timing(fd)
    except Exception:  # noqa: BLE001 - an unreadable file is not the auto clip
        return False
    planned = Fraction(plan.total_frames * fps.den, fps.num)
    tolerance = Fraction(LEGACY_R10_TOLERANCE_FRAMES * fps.den, fps.num)
    return constant and abs(Fraction(duration_s) - planned) <= tolerance


def verify_auto_file(path: Path, plan: RenderPlan) -> bool:
    """R10's re-verification of the auto clip against the plan of the (seed-equal) document
    (plan §4.6): G1–G2 exactly for a file of the new engine; for a legacy-engine seed, G1 except
    the document rate and G2 by duration (``_legacy_auto_ok``)."""
    from .edit_v2 import verify

    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        return False
    try:
        normalize = plan.doc["audio"]["master"]["mode"] == "normalize"
        verify.verify_output(fd, plan, size=plan.output, normalize=normalize)
        return True
    except edit_errors.VerificationFailed as error:
        if plan.doc["base"]["engine"]["compiler"] != "legacy":
            return False
        return _legacy_auto_ok(fd, plan, getattr(error, "report", None))
    except Exception:  # noqa: BLE001 - an unreadable auto file is simply unavailable
        return False
    finally:
        os.close(fd)


def _write_new(directory: Path, target: Path, data: bytes) -> None:
    """Publish ``data`` at ``target`` by link from a durable temporary file; never replaces."""
    temporary = directory / f".{target.name}.{uuid.uuid4()}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                 0o600)
    try:
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temporary, target, follow_symlinks=False)
    except FileExistsError:
        pass
    finally:
        temporary.unlink(missing_ok=True)


def _copy_fd(source_fd: int, directory: Path, target: Path) -> str:
    """Copy an open file into ``target`` (temp → fsync → rename); the sha256 of what was copied.

    Only content-addressed targets use this: replacing one with the same bytes is harmless."""
    temporary = directory / f".{target.name}.{uuid.uuid4()}.tmp"
    digest = hashlib.sha256()
    os.lseek(source_fd, 0, os.SEEK_SET)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                 0o600)
    try:
        while chunk := os.read(source_fd, 1024 * 1024):
            digest.update(chunk)
            offset = 0
            while offset < len(chunk):
                offset += os.write(fd, chunk[offset:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary, target)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)
    return digest.hexdigest()


def _publish_auto(job: Path, clip_id: str, auto: Path, output_relative: str,
                  plan: RenderPlan) -> str:
    """R10: hard-link the auto clip (+ .srt) under the export name; ``"seed"``, or ``"key"``
    when another verified export already holds that name."""
    directory = _edits_dir(job, clip_id)
    target = job / output_relative
    srt_target = job / srt_relative(output_relative)
    auto_srt = auto.with_suffix(".srt")
    if _regular(srt_target) is None:
        if _regular(auto_srt) is not None:
            try:
                os.link(auto_srt, srt_target, follow_symlinks=False)
            except FileExistsError:
                pass
            except OSError as error:
                if error.errno != errno.EXDEV:
                    raise QueueInvalid() from error
                _write_new(directory, srt_target, auto_srt.read_bytes())
        else:
            _write_new(directory, srt_target, plan.srt().encode("utf-8"))
    try:
        os.link(auto, target, follow_symlinks=False)
    except FileExistsError:
        existing, original = _regular(target), _regular(auto)
        if existing is None or original is None:
            raise QueueInvalid() from None
        return "seed" if os.path.samestat(existing, original) else "key"
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise QueueInvalid() from error
        fd = os.open(auto, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            _copy_fd(fd, directory, target)
        finally:
            os.close(fd)
    _fsync_dir(directory)
    return "seed"


def _snapshot_source_v3(job: Path, expected_sha: str) -> str:
    """Hard-link the job source into ``analysis/render-inputs/source.<sha>.<ext>`` (a verified
    copy when the link crosses devices) after checking its content against the document's
    ``base.source.content_sha256``. An existing snapshot is reused only if it is the same inode
    or its bytes hash to the sha."""
    try:
        source = _job_source(job)
    except QueueInvalid:
        raise QueueSourceMissing() from None
    try:
        fd = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise QueueSourceMissing() from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise QueueSourceMissing()
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != expected_sha:
            raise QueueSourceMissing()
        extension = source.suffix[1:].lower()
        if not re.fullmatch(r"[a-z0-9]{1,10}", extension):
            extension = "bin"
        directory = _render_inputs(job / "analysis")
        target = directory / f"source.{expected_sha}.{extension}"
        for _attempt in range(2):
            existing = _regular(target)
            if existing is not None:
                if os.path.samestat(existing, info):
                    return str(target.relative_to(job))
                try:
                    if _stream_sha256_regular(target, "snapshot") != expected_sha:
                        raise QueueInvalid()
                except ManifestRenderError as error:
                    raise QueueInvalid() from error
                return str(target.relative_to(job))
            try:
                os.link(source, target, follow_symlinks=False)
            except FileExistsError:
                continue
            except OSError as error:
                if error.errno not in {errno.EXDEV, errno.EPERM, errno.EMLINK}:
                    raise QueueInvalid() from error
                if _copy_fd(fd, directory, target) != expected_sha:
                    target.unlink(missing_ok=True)
                    raise QueueSourceMissing() from None
                _fsync_dir(directory)
                return str(target.relative_to(job))
            linked = _regular(target)
            if linked is None or not os.path.samestat(linked, info):
                target.unlink(missing_ok=True)  # the path was replaced between open and link
                raise QueueSourceMissing()
            _fsync_dir(directory)
            return str(target.relative_to(job))
        raise QueueInvalid()
    finally:
        os.close(fd)


@dataclasses.dataclass(frozen=True)
class _Prepared:
    """Everything a new v3 request binds, computed before the queue lock is taken."""

    clip_id: str
    doc_sha256: str
    doc_revision: int
    doc_relative: str
    render_key: str
    output_relative: str
    timeout_ms: int
    source_content_sha256: str
    source_snapshot_relative: str | None
    completed_by: str | None  # "seed" | "key": the request completes at creation
    warnings: tuple[str, ...]


def _default_resources() -> Resources:
    return Resources(RESOURCES_DIR)


def _prepare_v3(job: Path, clip_id: str, edit_etag: str, *, resources: Resources,
                verify_auto: Callable[[Path, RenderPlan], bool] | None) -> _Prepared:
    clip = _clip_dir(job, clip_id)
    try:
        doc_relative, revision = edit_store.archive_for_render(clip, edit_etag)
    except edit_errors.NotFound:
        raise QueueRevisionConflict() from None
    doc = _read_doc(job, doc_relative, edit_etag)
    seed_doc, _seed_etag = edit_store.seed(clip)
    plan = _plan(clip, doc, resources)
    try:
        toolchain = toolchain_sha256(resources)
    except OSError:
        raise QueueUnavailable() from None
    size = (doc["output"]["w"], doc["output"]["h"])
    try:
        key = render_key(plan, size=size, quality="standar", measure_sha=None,
                         toolchain_sha=toolchain)
    except ValueError:
        raise QueueUnavailable() from None
    output_relative = _v3_output_relative(clip_id, key)
    warnings: list[str] = []
    completed_by = None
    if content_equals_seed(doc, seed_doc):  # R10, checked first
        auto = _auto_file(job, clip_id, seed_doc)
        if auto is not None and (verify_auto or verify_auto_file)(auto, plan):
            completed_by = _publish_auto(job, clip_id, auto, output_relative, plan)
        else:
            warnings.append("auto_file_unavailable")
    if completed_by is None and _published(job, output_relative):
        completed_by = "key"
    source_sha = doc["base"]["source"]["content_sha256"]
    snapshot = None if completed_by is not None else _snapshot_source_v3(job, source_sha)
    if completed_by is None:
        _edits_dir(job, clip_id)  # the worker publishes into it
    return _Prepared(
        clip_id=clip_id, doc_sha256=edit_etag, doc_revision=revision, doc_relative=doc_relative,
        render_key=key, output_relative=output_relative,
        timeout_ms=render_timeout_ms(_duration_ms(doc), plan.layout, size),
        source_content_sha256=source_sha, source_snapshot_relative=snapshot,
        completed_by=completed_by, warnings=tuple(warnings))


def _prune_locked(directory: Path, moment: datetime, requests: list[dict[str, object]]) -> int:
    terminal = sorted(
        ((_parse_time(request["updated_at"]), str(request["render_id"]))
         for request in requests
         if request.get("version") == V3_VERSION and request["state"] in V3_TERMINAL),
        reverse=True,
    )
    cutoff = moment - timedelta(days=RETENTION_DAYS)
    removed = 0
    for index, (ended_at, render_id) in enumerate(terminal):
        if index < RETENTION_KEEP or ended_at > cutoff:
            continue
        try:
            (directory / f"{render_id}.json").unlink()
        except FileNotFoundError:
            continue
        removed += 1
    if removed:
        _fsync_dir(directory)
    return removed


def prune_requests_v3(job_dir: Path, *, now: datetime | None = None) -> int:
    """Delete terminal v3 requests older than ``RETENTION_DAYS`` beyond the newest
    ``RETENTION_KEEP``; queued and running requests and legacy requests are kept."""
    directory = _queue_dir(Path(job_dir).absolute())
    with _lock(directory):
        return _prune_locked(directory, now or datetime.now(UTC), _scan(directory))


# Parsed requests by file identity. Every write replaces the file (a new inode, a new ctime),
# so a scan re-parses only what changed since the last one; the cache is bounded and private to
# the process. Callers get copies.
_SCAN_CACHE: dict[tuple[str, int, int, int, int], dict[str, object]] = {}
_SCAN_CACHE_MAX = 8192


def _scan(directory: Path) -> list[dict[str, object]]:
    """Every request of the queue (validated, canonical), like ``_read`` over ``_entries``."""
    result = []
    for path in _entries(directory):
        try:
            info = path.lstat()
        except OSError as error:
            raise QueueInvalid() from error
        identity = (str(path), info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_size)
        cached = _SCAN_CACHE.get(identity)
        if cached is None:
            cached = _read(path)
            if len(_SCAN_CACHE) >= _SCAN_CACHE_MAX:
                _SCAN_CACHE.clear()
            _SCAN_CACHE[identity] = cached
        result.append({key: list(value) if isinstance(value, list) else value
                       for key, value in cached.items()})
    return result


def create_request_v3(
    job_dir: Path,
    clip_id: str,
    edit_etag: str,
    idempotency_key: str,
    *,
    storage_reservation: dict[str, object] | None = None,
    resources: Resources | None = None,
    verify_auto: Callable[[Path, RenderPlan], bool] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Create (or replay) the export of one revision of a clip (plan §4.6).

    Instant completion by R10 or by an existing export of the same key; otherwise a queued
    request with a verified source snapshot. Raises ``QueueInvalid`` (malformed ids),
    ``QueueNotFound`` (no such clip), ``QueueRevisionConflict`` (unknown etag),
    ``QueueIdempotencyConflict``, ``QueueSourceMissing``, ``QueueAnalysisMissing``,
    ``QueueUnavailable`` (no pinned toolchain) or an ``edit_v2`` error of the document.
    """
    job = Path(job_dir).absolute()
    _check_v3_ids(job, clip_id=clip_id, edit_etag=edit_etag, idempotency_key=idempotency_key)
    _check_reservation(storage_reservation)
    key = idempotency_key.lower()
    _clip_dir(job, clip_id)
    directory = _queue_dir(job)
    with _lock(directory):  # a replay returns the original result, whatever changed since
        for request in _scan(directory):
            if request["idempotency_key"] == key:
                return _replay_v3(request, clip_id, edit_etag)
    prepared = _prepare_v3(job, clip_id, edit_etag, resources=resources or _default_resources(),
                           verify_auto=verify_auto)
    moment = now or datetime.now(UTC)
    stamp = _stamp(moment)
    with _lock(directory):
        requests = _scan(directory)
        for request in requests:
            if request["idempotency_key"] == key:
                return _replay_v3(request, clip_id, edit_etag)
        if len(requests) - _prune_locked(directory, moment, requests) >= MAX_REQUESTS:
            raise QueueInvalid()
        instant = prepared.completed_by is not None
        reservation = storage_reservation or {}
        request = {
            "version": V3_VERSION,
            "render_id": str(uuid.uuid4()),
            "idempotency_key": key,
            "state": "completed" if instant else "queued",
            "stage": "selesai" if instant else "antre",
            "progress_pm": 1000 if instant else 0,
            "clip_id": prepared.clip_id,
            "doc_sha256": prepared.doc_sha256,
            "doc_revision": prepared.doc_revision,
            "doc_relative": prepared.doc_relative,
            "render_key": prepared.render_key,
            "size": "output",
            "quality": "standar",
            "output_relative": prepared.output_relative,
            "source_content_sha256": prepared.source_content_sha256,
            "source_snapshot_relative": prepared.source_snapshot_relative,
            "timeout_ms": prepared.timeout_ms,
            "created_at": stamp,
            "updated_at": stamp,
            "claimed_at": None,
            "rendering_at": None,
            "completed_at": stamp if instant else None,
            "failed_at": None,
            "cancelled_at": None,
            "cancel_requested_at": None,
            "attempts": 0,
            "error_code": None,
            "warnings": list(prepared.warnings),
            "completed_by": prepared.completed_by,
            "lease_token": None,
            "heartbeat_at": None,
            "storage_reservation_id": reservation.get("reservation_id"),
            "storage_reservation_token": reservation.get("token"),
            "storage_reserved_bytes": reservation.get("reserved_bytes"),
        }
        return _write(directory, request)


def _replay_v3(request: dict[str, object], clip_id: str, edit_etag: str) -> dict[str, object]:
    if (
        request.get("version") != V3_VERSION
        or request["clip_id"] != clip_id
        or request["doc_sha256"] != edit_etag
    ):
        raise QueueIdempotencyConflict()
    return request


def estimate_v3(job_dir: Path, clip_id: str, edit_etag: str) -> int:
    """Bytes to reserve for exporting a revision (storage admission; writes nothing): the
    output at ``OUTPUT_BYTES_PER_SECOND`` plus the .srt, plus the source when a snapshot would
    have to be copied (the source is on another device than ``analysis/``)."""
    job = Path(job_dir).absolute()
    _check_v3_ids(job, clip_id=clip_id, edit_etag=edit_etag)
    doc = _find_doc(_clip_dir(job, clip_id), edit_etag)
    total = -(-_duration_ms(doc) * OUTPUT_BYTES_PER_SECOND // 1000) + SRT_ALLOWANCE_BYTES
    try:
        source = _job_source(job)
        if source.stat().st_dev != (job / "analysis").stat().st_dev:
            total += source.stat().st_size
    except (QueueError, OSError):
        pass  # create reports a missing source
    return total


def _v3_request(directory: Path, render_id: str) -> dict[str, object]:
    request = _read(directory / f"{render_id}.json")
    if request.get("version") != V3_VERSION or request["render_id"] != render_id:
        raise QueueInvalid()
    return request


def _v3_leased(directory: Path, render_id: str, lease_token: str,
               states: frozenset[str] | set[str]) -> dict[str, object]:
    if not _v3_uuid(render_id) or not isinstance(lease_token, str):
        raise QueueInvalid()
    request = _v3_request(directory, render_id)
    if request["state"] not in states or request["lease_token"] != lease_token:
        raise QueueConflict()
    return request


def start_rendering_v3(job_dir: Path, render_id: str, lease_token: str, *,
                       now: datetime | None = None) -> dict[str, object]:
    """claimed → rendering (stage ``merender``, progress 0)."""
    directory = _queue_dir(Path(job_dir).absolute())
    stamp = _stamp(now)
    with _lock(directory):
        current = _v3_leased(directory, render_id, lease_token, {"claimed"})
        return _write(directory, {**current, "state": "rendering", "stage": "merender",
                                  "progress_pm": 0, "rendering_at": stamp, "heartbeat_at": stamp,
                                  "updated_at": stamp})


def progress_v3(job_dir: Path, render_id: str, lease_token: str, stage: str, progress_pm: int, *,
                now: datetime | None = None) -> dict[str, object]:
    """A heartbeat that carries the stage and progress (also renews the lease)."""
    if stage not in V3_RENDER_STAGES or not _v3_int(progress_pm, 0, 1000):
        raise QueueInvalid()
    directory = _queue_dir(Path(job_dir).absolute())
    stamp = _stamp(now)
    with _lock(directory):
        current = _v3_leased(directory, render_id, lease_token, {"rendering"})
        return _write(directory, {**current, "stage": stage, "progress_pm": progress_pm,
                                  "heartbeat_at": stamp, "updated_at": stamp})


def complete_v3(job_dir: Path, render_id: str, lease_token: str, *,
                completed_by: str = "render", warnings: Iterable[str] = (),
                now: datetime | None = None) -> dict[str, object]:
    """rendering → completed, fenced by the lease: the export and its .srt must be published
    (regular files at ``output_relative``) by the renderer."""
    if completed_by not in V3_COMPLETED_BY:
        raise QueueInvalid()
    job = Path(job_dir).absolute()
    directory = _queue_dir(job)
    stamp = _stamp(now)
    with _lock(directory):
        current = _v3_leased(directory, render_id, lease_token, {"rendering"})
        _edits_dir(job, str(current["clip_id"]))
        if not _published(job, str(current["output_relative"])):
            raise QueueInvalid()
        return _write(directory, {
            **current, "state": "completed", "stage": "selesai", "progress_pm": 1000,
            "completed_at": stamp, "updated_at": stamp, "completed_by": completed_by,
            "warnings": _merge_warnings(current["warnings"], warnings), "error_code": None,
            "lease_token": None, "heartbeat_at": None})


def fail_v3(job_dir: Path, render_id: str, lease_token: str, error_code: str, *,
            warnings: Iterable[str] = (), now: datetime | None = None) -> dict[str, object]:
    """claimed/rendering → failed with a fixed code, or → cancelled (``error_code`` cancelled)."""
    if error_code not in V3_FAILURE_CODES | {"cancelled"}:
        raise QueueInvalid()
    directory = _queue_dir(Path(job_dir).absolute())
    stamp = _stamp(now)
    with _lock(directory):
        current = _v3_leased(directory, render_id, lease_token, {"claimed", "rendering"})
        state = "cancelled" if error_code == "cancelled" else "failed"
        return _write(directory, _v3_ended(current, state, stamp, error_code=error_code,
                                           warnings=warnings))


def cancel_request_v3(job_dir: Path, render_id: str, *,
                      now: datetime | None = None) -> dict[str, object]:
    """Cancel an export: queued → cancelled; claimed/rendering → ``cancel_requested_at`` (the
    worker kills FFmpeg and ends it as cancelled); a finished request, or a legacy one (which
    cannot be cancelled), is returned unchanged."""
    if not _v3_uuid(render_id):
        raise QueueInvalid()
    directory = _queue_dir(Path(job_dir).absolute())
    stamp = _stamp(now)
    with _lock(directory):
        current = _read(directory / f"{render_id}.json")
        if current.get("version") != V3_VERSION:
            return current
        if current["state"] == "queued":
            return _write(directory, _v3_ended(current, "cancelled", stamp))
        if current["state"] in {"claimed", "rendering"} and current["cancel_requested_at"] is None:
            return _write(directory, {**current, "cancel_requested_at": stamp,
                                      "updated_at": stamp})
        return current


def list_requests_v3(job_dir: Path, clip_id: str | None = None) -> list[dict[str, object]]:
    """The v3 requests of a job (or of one clip), newest first."""
    job = Path(job_dir).absolute()
    if clip_id is not None:
        _check_v3_ids(job, clip_id=clip_id)
    directory = _queue_dir(job)
    with _lock(directory):
        requests = _scan(directory)
    selected = [request for request in requests if request.get("version") == V3_VERSION
                and (clip_id is None or request["clip_id"] == clip_id)]
    return sorted(selected, key=lambda item: (str(item["created_at"]), str(item["render_id"])),
                  reverse=True)


# --- the v3 CLI (CONTRACTS §5.9 envelope, §5.3 exit codes) ---------------------------------------

_V3_OPS: dict[str, tuple[frozenset[str], frozenset[str]]] = {
    # op: (required keys, optional keys) besides "op"
    "estimate": (frozenset({"jobId", "clipId", "editEtag"}), frozenset()),
    "create": (frozenset({"jobId", "clipId", "editEtag", "idempotencyKey"}),
               frozenset({"storageReservation"})),
    "get": (frozenset({"jobId", "renderId"}), frozenset()),
    "cancel": (frozenset({"jobId", "renderId"}), frozenset()),
    "list": (frozenset({"jobId", "clipId"}), frozenset()),
}
_V3_ARG_PATTERNS = {"jobId": _V3_UUID, "clipId": CLIP_ID_PATTERN, "editEtag": _SHA,
                    "idempotencyKey": _V3_UUID, "renderId": _V3_UUID}


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _v3_envelope(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_COMMAND_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=_constant)
    except (QueueInvalid, ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict or not isinstance(value.get("op"), str):
        raise _Usage()
    spec = _V3_OPS.get(value["op"])
    keys = set(value) - {"op"}
    if spec is None or not spec[0] <= keys or not keys <= spec[0] | spec[1]:
        raise _Usage()
    for name in keys & set(_V3_ARG_PATTERNS):
        field = value[name]
        if not isinstance(field, str) or _V3_ARG_PATTERNS[name].fullmatch(field.lower()) is None:
            raise _Usage()
        if name != "idempotencyKey" and field != field.lower():
            raise _Usage()
    try:
        _check_reservation(value.get("storageReservation"))
    except QueueInvalid:
        raise _Usage() from None
    return value


def _v3_job(jobs_root: str | os.PathLike | None, job_id: str) -> Path:
    if jobs_root is None or str(jobs_root) == "":
        raise edit_errors.EditV2Error("internal_error")
    try:
        root = Path(jobs_root).resolve(strict=True)
    except OSError:
        raise edit_errors.EditV2Error("internal_error") from None
    return _real_dir(root / job_id)


def _v3_error(code: str) -> dict[str, Any]:
    return {"error": {"code": code, "path": None, "ref": None,
                      "messageId": edit_errors.message_id(code)}}


def handle_v3(raw: bytes, *, jobs_root: str | os.PathLike | None,
              resources: Resources | None = None,
              verify_auto: Callable[[Path, RenderPlan], bool] | None = None,
              ) -> tuple[int, dict[str, Any]]:
    """Run one v3 envelope: (exit code, stdout object). Never raises; never echoes a path or an
    exception text (fixed codes with ``edit.<code>`` message ids only)."""
    try:
        envelope = _v3_envelope(raw)
        job = _v3_job(jobs_root, envelope["jobId"])
        op = envelope["op"]
        if op == "estimate":
            return 0, {"bytes": str(estimate_v3(job, envelope["clipId"], envelope["editEtag"]))}
        if op == "create":
            request = create_request_v3(
                job, envelope["clipId"], envelope["editEtag"], envelope["idempotencyKey"],
                storage_reservation=envelope.get("storageReservation"), resources=resources,
                verify_auto=verify_auto)
            return 0, {"request": request}
        if op == "get":
            return 0, {"request": get_request(job, envelope["renderId"])}
        if op == "cancel":
            return 0, {"request": cancel_request_v3(job, envelope["renderId"])}
        return 0, {"requests": list_requests_v3(job, envelope["clipId"])}
    except _Usage:
        return edit_errors.EXIT_USAGE, _v3_error("internal_error")
    except (QueueNotFound, edit_errors.NotFound, storage.EditManifestNotFound):
        return edit_errors.EXIT_NOT_FOUND, _v3_error("not_found")
    except QueueSourceMissing:
        return edit_errors.EXIT_NOT_FOUND, _v3_error("source_missing")
    except QueueIdempotencyConflict:
        return edit_errors.EXIT_IDEMPOTENCY, _v3_error("idempotency_conflict")
    except QueueRevisionConflict:
        return edit_errors.EXIT_CONFLICT, _v3_error("revision_conflict")
    except QueueAnalysisMissing:
        return edit_errors.EXIT_ANALYSIS_MISSING, _v3_error("analysis_missing")
    except edit_errors.EditV2Error as error:
        code = error.code if error.code in edit_errors.MESSAGES else "internal_error"
        return edit_errors.exit_code_for(error), _v3_error(code)
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        return edit_errors.EXIT_INTERNAL, _v3_error("internal_error")


def run_v3(stdin: BinaryIO, stdout: BinaryIO) -> int:
    code, payload = handle_v3(stdin.read(MAX_COMMAND_BYTES + 1),
                              jobs_root=os.environ.get("JOBS_ROOT"))
    stdout.write(_canonical(payload) + b"\n")
    stdout.flush()
    return code


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer, sys.stderr))
