"""Durable, idempotent filesystem render request queue and CLI authority."""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import re
import stat
import sys
import threading
import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import BinaryIO, TextIO

from . import edit_manifest as storage
from .edit_manifest import manifest_sha256
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
    if type(value) is not dict or set(value) != _FIELDS:
        raise QueueInvalid()
    if value["version"] != "render-request-v1" or value["state"] not in _STATES:
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
        output_fd = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
        )
        digest = __import__("hashlib").sha256()
        total = 0
        while chunk := os.read(source_fd, min(1024 * 1024, maximum + 1 - total)):
            total += len(chunk)
            if total > maximum:
                raise QueueInvalid()
            digest.update(chunk)
            offset = 0
            while offset < len(chunk):
                offset += os.write(output_fd, chunk[offset:])
        os.fsync(output_fd)
        hexdigest = digest.hexdigest()
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
    job_dir: Path, candidate_id: str, edit_etag: str, idempotency_key: str
) -> dict[str, object]:
    job = Path(job_dir).absolute()
    if (
        not _UUID.fullmatch(job.name)
        or not _CANDIDATE.fullmatch(candidate_id)
        or not _SHA.fullmatch(edit_etag)
        or not _UUID.fullmatch(idempotency_key)
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
                    request["candidate_id"] != candidate_id
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
            "version": "render-request-v1",
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
        return _write(
            directory,
            {
                **available,
                "state": "claimed",
                "attempts": int(available["attempts"]) + 1,
                "claimed_at": now,
                "rendering_at": None,
                "updated_at": now,
                "lease_token": token,
                "heartbeat_at": now,
            },
        )


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
    if op == "create" and set(command) == {
        "operation",
        "candidateId",
        "editEtag",
        "idempotencyKey",
    }:
        return create_request(
            job, command["candidateId"], command["editEtag"], command["idempotencyKey"]
        )
    if op == "get" and set(command) == {"operation", "renderId"}:
        return get_request(job, command["renderId"])
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


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer, sys.stderr))
