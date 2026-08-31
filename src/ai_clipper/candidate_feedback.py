"""Authoritative append-only candidate feedback validation and storage.

The web process supplies a verified analysis directory, while this module owns
all semantic validation and performs locked, no-follow, bounded, durable writes.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import unicodedata
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, TextIO

from .candidate_api import artifact_bytes_to_presentation
from .ranking import MAX_ARTIFACT_BYTES, SELECTION_VERSION, candidate_artifact_lock

FEEDBACK_VERSION = "feedback-v1"
MAX_FEEDBACK_BYTES = 8 * 1024 * 1024
MAX_COMMAND_BYTES = 4096
MAX_EVENTS = 10_000
MAX_NOTE_CHARS = 500
_CANDIDATE_ID = re.compile(r"cand_[0-9a-f]{64}\Z")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)
_CREATED_AT = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
_DECISIONS = frozenset({"accepted", "rejected", "undecided"})
_BINDING_PATH = "analysis/candidates.v2.json"


class FeedbackError(Exception):
    """Base class for fixed protocol failures."""


class FeedbackNotFound(FeedbackError):
    pass


class FeedbackRequestInvalid(FeedbackError):
    pass


class FeedbackConflict(FeedbackError):
    pass


class FeedbackArtifactInvalid(FeedbackError):
    pass


class SelectionChanged(FeedbackError):
    pass


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _constant(_value: str) -> object:
    raise ValueError("non-standard number")


def _decode(raw: bytes) -> object:
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant)


def _exact(value: object, fields: set[str]) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("unexpected object shape")
    return value


def _valid_uuid(value: object) -> bool:
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


def _read_fd(fd: int, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        chunk = os.read(fd, min(64 * 1024, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > limit:
        raise FeedbackArtifactInvalid()
    return b"".join(chunks)


def _open_read(path: Path, limit: int, *, missing: bool = False) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        if missing:
            raise FeedbackNotFound() from None
        raise
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise FeedbackArtifactInvalid() from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise FeedbackArtifactInvalid()
        return _read_fd(fd, limit)
    finally:
        os.close(fd)


def _candidate_context(analysis_dir: Path) -> tuple[bytes, str, set[str]]:
    raw = _open_read(analysis_dir / "candidates.v2.json", MAX_ARTIFACT_BYTES, missing=True)
    try:
        presentation = artifact_bytes_to_presentation(raw)
    except Exception as error:
        raise FeedbackArtifactInvalid() from error
    if presentation.get("selectionVersion") != SELECTION_VERSION:
        raise FeedbackArtifactInvalid()
    candidate_ids = {item["id"] for item in presentation["candidates"]}
    if any(_CANDIDATE_ID.fullmatch(value) is None for value in candidate_ids):
        raise FeedbackArtifactInvalid()
    return raw, hashlib.sha256(raw).hexdigest(), candidate_ids


def _validate_event(value: object) -> dict[str, object]:
    event = _exact(
        value, {"event_id", "client_request_id", "candidate_id", "decision", "note", "created_at"}
    )
    if not _valid_uuid(event["event_id"]) or not _valid_uuid(event["client_request_id"]):
        raise ValueError("invalid event UUID")
    if not isinstance(event["candidate_id"], str) or not _CANDIDATE_ID.fullmatch(
        event["candidate_id"]
    ):
        raise ValueError("invalid candidate id")
    if event["decision"] not in _DECISIONS:
        raise ValueError("invalid decision")
    if not isinstance(event["note"], str) or len(event["note"]) > MAX_NOTE_CHARS:
        raise ValueError("invalid note")
    if event["note"] != event["note"].strip() or any(
        unicodedata.category(char) == "Cc" for char in event["note"]
    ):
        raise ValueError("invalid note")
    if not isinstance(event["created_at"], str):
        raise TypeError("invalid created_at")
    if _CREATED_AT.fullmatch(event["created_at"]) is None:
        raise ValueError("created_at must be a UTC ISO timestamp")
    parsed = datetime.fromisoformat(event["created_at"])
    if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        raise ValueError("created_at must be UTC")
    return event


def _new_artifact(sha256: str) -> dict[str, object]:
    return {
        "feedback_version": FEEDBACK_VERSION,
        "selection_version": SELECTION_VERSION,
        "candidate_artifact_analysis": {"artifact": _BINDING_PATH, "sha256": sha256},
        "events": [],
    }


def _parse_feedback(raw: bytes, sha256: str, candidate_ids: set[str]) -> dict[str, object]:
    try:
        artifact = _exact(
            _decode(raw),
            {"feedback_version", "selection_version", "candidate_artifact_analysis", "events"},
        )
        binding = _exact(artifact["candidate_artifact_analysis"], {"artifact", "sha256"})
        if artifact["feedback_version"] != FEEDBACK_VERSION:
            raise ValueError("feedback version")
        if artifact["selection_version"] != SELECTION_VERSION:
            raise ValueError("selection version")
        if binding != {"artifact": _BINDING_PATH, "sha256": sha256}:
            raise ValueError("candidate binding")
        if not isinstance(artifact["events"], list) or len(artifact["events"]) > MAX_EVENTS:
            raise ValueError("event bound")
        client_ids: set[str] = set()
        event_ids: set[str] = set()
        for raw_event in artifact["events"]:
            event = _validate_event(raw_event)
            if event["candidate_id"] not in candidate_ids:
                raise ValueError("unknown candidate")
            if event["client_request_id"] in client_ids or event["event_id"] in event_ids:
                raise ValueError("duplicate event identity")
            client_ids.add(event["client_request_id"])
            event_ids.add(event["event_id"])
        return artifact
    except FeedbackArtifactInvalid:
        raise
    except Exception as error:
        raise FeedbackArtifactInvalid() from error


def _read_feedback(path: Path, sha256: str, candidate_ids: set[str]) -> dict[str, object]:
    try:
        raw = _open_read(path, MAX_FEEDBACK_BYTES)
    except FileNotFoundError:
        return _new_artifact(sha256)
    return _parse_feedback(raw, sha256, candidate_ids)


def _feedback_binding_sha(raw: bytes) -> str:
    try:
        artifact = _exact(
            _decode(raw),
            {"feedback_version", "selection_version", "candidate_artifact_analysis", "events"},
        )
        binding = _exact(artifact["candidate_artifact_analysis"], {"artifact", "sha256"})
        sha256 = binding["sha256"]
        if binding["artifact"] != _BINDING_PATH or not isinstance(sha256, str):
            raise ValueError("candidate binding")
        if re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
            raise ValueError("candidate digest")
        return sha256
    except Exception as error:
        raise FeedbackArtifactInvalid() from error


def _validate_command(command: object) -> tuple[str, dict[str, object] | None]:
    try:
        if (
            isinstance(command, dict)
            and set(command) == {"operation"}
            and command["operation"] == "get"
        ):
            return "get", None
        body = _exact(command, {"operation", "candidateId", "decision", "note", "clientRequestId"})
        if body["operation"] != "put":
            raise ValueError("operation")
        if not isinstance(body["candidateId"], str) or not _CANDIDATE_ID.fullmatch(
            body["candidateId"]
        ):
            raise ValueError("candidate")
        if body["decision"] not in _DECISIONS:
            raise ValueError("decision")
        if not isinstance(body["note"], str):
            raise TypeError("note")
        if any(unicodedata.category(char) == "Cc" for char in body["note"]):
            raise ValueError("note")
        note = body["note"].strip()
        if len(note) > MAX_NOTE_CHARS:
            raise ValueError("note")
        if not _valid_uuid(body["clientRequestId"]):
            raise ValueError("request UUID")
        return "put", {
            "candidate_id": body["candidateId"],
            "decision": body["decision"],
            "note": note,
            "client_request_id": body["clientRequestId"],
        }
    except Exception as error:
        raise FeedbackRequestInvalid() from error


def _present_event(event: dict[str, object]) -> dict[str, object]:
    return {
        "eventId": event["event_id"],
        "clientRequestId": event["client_request_id"],
        "candidateId": event["candidate_id"],
        "decision": event["decision"],
        "note": event["note"],
        "createdAt": event["created_at"],
    }


def _state(
    artifact: dict[str, object], sha256: str, *, available: bool = True
) -> dict[str, object]:
    latest: dict[str, object] = {}
    events = artifact["events"]
    assert isinstance(events, list)
    for event in events:
        latest[event["candidate_id"]] = _present_event(event)
    return {
        "available": available,
        "selectionVersion": SELECTION_VERSION,
        "candidateArtifactSha256": sha256,
        "latestByCandidate": latest,
        "eventCount": len(events),
    }


def read_candidate_feedback_state(path: str | Path, candidate_raw: bytes) -> dict[str, object]:
    """Read strictly validated feedback bound to the supplied candidate artifact bytes."""
    try:
        presentation = artifact_bytes_to_presentation(candidate_raw)
        if presentation.get("selectionVersion") != SELECTION_VERSION:
            raise ValueError("selection version")
        candidate_ids = {item["id"] for item in presentation["candidates"]}
        if any(_CANDIDATE_ID.fullmatch(value) is None for value in candidate_ids):
            raise ValueError("candidate id")
        sha256 = hashlib.sha256(candidate_raw).hexdigest()
        raw = _open_read(Path(path), MAX_FEEDBACK_BYTES, missing=True)
        return _state(_parse_feedback(raw, sha256, candidate_ids), sha256)
    except FeedbackArtifactInvalid:
        raise
    except Exception as error:
        raise FeedbackArtifactInvalid() from error


def _encode(artifact: dict[str, object]) -> bytes:
    raw = (
        json.dumps(artifact, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    ).encode()
    if len(raw) > MAX_FEEDBACK_BYTES:
        raise FeedbackArtifactInvalid()
    return raw


def _atomic_write(analysis_dir: Path, target: Path, raw: bytes) -> None:
    temp = analysis_dir / f".candidate-feedback.{uuid.uuid4()}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600
        )
        written = 0
        while written < len(raw):
            written += os.write(fd, raw[written:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temp, target)
        directory_fd = os.open(analysis_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _fsync_directory(analysis_dir: Path) -> None:
    directory_fd = os.open(analysis_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _archive_feedback(analysis_dir: Path, feedback_path: Path) -> Path | None:
    try:
        info = feedback_path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise FeedbackArtifactInvalid()
    while True:
        archived = analysis_dir / f"{feedback_path.name}.stale.{uuid.uuid4()}"
        try:
            os.link(feedback_path, archived, follow_symlinks=False)
            break
        except FileExistsError:
            continue
    feedback_path.unlink()
    _fsync_directory(analysis_dir)
    return archived


def _ensure_candidate_unchanged(
    analysis_dir: Path, expected_sha256: str, feedback_path: Path
) -> None:
    try:
        current = _open_read(analysis_dir / "candidates.v2.json", MAX_ARTIFACT_BYTES, missing=True)
    except Exception as error:
        _archive_feedback(analysis_dir, feedback_path)
        raise SelectionChanged() from error
    if hashlib.sha256(current).hexdigest() != expected_sha256:
        _archive_feedback(analysis_dir, feedback_path)
        raise SelectionChanged()


def process_feedback(analysis_dir: Path, command: object) -> dict[str, object]:
    """Process one GET/PUT command while serializing candidate identity and feedback IO."""
    operation, payload = _validate_command(command)
    analysis_dir = Path(analysis_dir)
    try:
        info = analysis_dir.lstat()
        if (
            stat.S_ISLNK(info.st_mode)
            or not stat.S_ISDIR(info.st_mode)
            or analysis_dir.resolve() != analysis_dir.absolute()
        ):
            raise FeedbackArtifactInvalid()
    except FileNotFoundError:
        raise FeedbackNotFound() from None

    feedback_path = analysis_dir / "candidate-feedback.v1.json"
    try:
        with candidate_artifact_lock(analysis_dir, exclusive=False):
            _raw_candidates, sha256, candidate_ids = _candidate_context(analysis_dir)
            lock_path = analysis_dir / ".candidate-feedback.lock"
            try:
                lock_fd = os.open(
                    lock_path,
                    os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                )
            except OSError as error:
                raise FeedbackArtifactInvalid() from error
            locked = False
            try:
                if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
                    raise FeedbackArtifactInvalid()
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
                locked = True
                try:
                    feedback_raw = _open_read(feedback_path, MAX_FEEDBACK_BYTES)
                except FileNotFoundError:
                    artifact = _new_artifact(sha256)
                    stale = False
                else:
                    if _feedback_binding_sha(feedback_raw) != sha256:
                        _archive_feedback(analysis_dir, feedback_path)
                        artifact = _new_artifact(sha256)
                        stale = True
                    else:
                        artifact = _parse_feedback(feedback_raw, sha256, candidate_ids)
                        stale = False

                if operation == "get":
                    _ensure_candidate_unchanged(analysis_dir, sha256, feedback_path)
                    return _state(artifact, sha256, available=not stale)

                assert payload is not None
                if payload["candidate_id"] not in candidate_ids:
                    raise FeedbackRequestInvalid()
                events = artifact["events"]
                assert isinstance(events, list)
                existing = next(
                    (
                        event
                        for event in events
                        if event["client_request_id"] == payload["client_request_id"]
                    ),
                    None,
                )
                if existing is not None:
                    comparable = {key: existing[key] for key in payload}
                    if comparable != payload:
                        raise FeedbackConflict()
                    _ensure_candidate_unchanged(analysis_dir, sha256, feedback_path)
                    return {
                        "created": False,
                        "event": _present_event(existing),
                        "state": _state(artifact, sha256),
                    }
                if len(events) >= MAX_EVENTS:
                    raise FeedbackArtifactInvalid()
                event = {
                    "event_id": str(uuid.uuid4()),
                    "client_request_id": payload["client_request_id"],
                    "candidate_id": payload["candidate_id"],
                    "decision": payload["decision"],
                    "note": payload["note"],
                    "created_at": datetime.now(UTC)
                    .isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z"),
                }
                events.append(event)
                raw = _encode(artifact)
                _atomic_write(analysis_dir, feedback_path, raw)
                # Validate a fresh descriptor while both locks are still held.
                verified = _read_feedback(feedback_path, sha256, candidate_ids)
                if _encode(verified) != raw:
                    raise FeedbackArtifactInvalid()
                _ensure_candidate_unchanged(analysis_dir, sha256, feedback_path)
                return {
                    "created": True,
                    "event": _present_event(event),
                    "state": _state(verified, sha256),
                }
            finally:
                if locked:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
    except ValueError as error:
        raise FeedbackArtifactInvalid() from error


def run(argv: list[str], stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--analysis-dir", required=True)
    parser.add_argument("--operation", choices=("get", "put"))
    try:
        args = parser.parse_args(argv)
        raw = stdin.read(MAX_COMMAND_BYTES + 1)
        if len(raw) > MAX_COMMAND_BYTES:
            raise FeedbackRequestInvalid()
        if args.operation == "get":
            if raw.strip():
                raise FeedbackRequestInvalid()
            command: object = {"operation": "get"}
        elif args.operation == "put":
            body = _decode(raw)
            if not isinstance(body, dict) or set(body) != {
                "candidateId",
                "decision",
                "note",
                "clientRequestId",
            }:
                raise FeedbackRequestInvalid()
            command = {"operation": "put", **body}
        else:
            command = _decode(raw)
        result = process_feedback(Path(args.analysis_dir), command)
        stdout.write(
            (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        )
        return 0
    except (FeedbackRequestInvalid, ValueError, UnicodeError):
        stderr.write("candidate_feedback_invalid_request\n")
        return 3
    except FeedbackNotFound:
        stderr.write("candidate_feedback_not_found\n")
        return 4
    except FeedbackConflict:
        stderr.write("candidate_feedback_conflict\n")
        return 5
    except FeedbackArtifactInvalid:
        stderr.write("candidate_feedback_invalid_artifact\n")
        return 6
    except SelectionChanged:
        stderr.write("candidate_feedback_selection_changed\n")
        return 8
    except Exception:  # noqa: BLE001 - protocol boundary must sanitize every failure
        stderr.write("candidate_feedback_error\n")
        return 7


def main() -> int:
    return run(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
