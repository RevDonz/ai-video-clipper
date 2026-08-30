"""Authenticated web editor's authoritative durable document service.

The Next.js route only resolves a job and transports bytes. This module owns
manifest semantics, optimistic concurrency, idempotency receipts, and storage.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, TextIO

from . import edit_manifest as storage
from .edit_manifest import (
    CaptionCueEdit,
    ClipEditManifest,
    EditManifestConflict,
    EditManifestInvalid,
    EditManifestNotFound,
    canonical_manifest_bytes,
    create_edit_manifest,
    manifest_from_bytes,
    manifest_sha256,
)

MAX_MANIFEST_BODY_BYTES = 2 * 1024 * 1024
MAX_COMMAND_BYTES = 3 * 1024 * 1024
MAX_RECEIPTS = 1000
MAX_RECEIPT_BYTES = MAX_MANIFEST_BODY_BYTES + 64 * 1024
_CANDIDATE_ID = re.compile(r"cand_[0-9a-f]{64}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)


class EditorError(Exception):
    """Base fixed-protocol editor error."""


class EditorRequestInvalid(EditorError):
    pass


class EditorNotFound(EditorError):
    pass


class EditorSemanticInvalid(EditorError):
    pass


class EditorSelectionChanged(EditorError):
    pass


class EditorIdempotencyConflict(EditorError):
    pass


class EditorConflict(EditorError):
    def __init__(self, current: dict[str, object]):
        super().__init__("edit revision conflict")
        self.current = current


def _exact(value: object, fields: set[str]) -> dict[str, object]:
    if type(value) is not dict or set(value) != fields:
        raise EditorRequestInvalid()
    return value


def _manifest_document(manifest: ClipEditManifest) -> dict[str, object]:
    return json.loads(canonical_manifest_bytes(manifest))


def _result(manifest: ClipEditManifest, *, created: bool) -> dict[str, object]:
    return {
        "created": created,
        "etag": manifest_sha256(manifest),
        "manifest": _manifest_document(manifest),
    }


@contextmanager
def _service_lock(analysis: Path, candidate_id: str):
    edits = analysis / "edits"
    storage._ensure_directory(edits)
    path = edits / f".{candidate_id}.editor-api.lock"
    try:
        fd = os.open(
            path,
            os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
    except OSError as error:
        raise EditorSemanticInvalid() from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise EditorSemanticInvalid()
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield edits
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _default_manifest(analysis: Path, candidate_id: str, candidate: object) -> ClipEditManifest:
    original_text = candidate.text
    normalized = unicodedata.normalize("NFC", original_text)
    without_controls = "".join(
        " " if unicodedata.category(char) in {"Cc", "Cs"} else char for char in normalized
    )
    text = " ".join(without_controls.split())[:500] or "Caption kandidat"
    cue = CaptionCueEdit(
        cue_id="cue-0001",
        index=0,
        start=candidate.start,
        end=candidate.end,
        text=text,
        original_text_sha256=hashlib.sha256(original_text.encode("utf-8")).hexdigest(),
    )
    return create_edit_manifest(
        analysis / "candidates.v2.json",
        candidate_id,
        captions=(cue,),
        created_at="1970-01-01T00:00:00.000Z",
        editor_schema="editor-web-v1",
    )


def _receipt_directory(edits: Path) -> Path:
    directory = edits / "receipts"
    storage._ensure_directory(directory)
    return directory


def _receipt_path(edits: Path, candidate_id: str, key: str) -> Path:
    return _receipt_directory(edits) / f"{candidate_id}.{key.lower()}.json"


def _receipt_entries(edits: Path, candidate_id: str) -> list[Path]:
    directory = _receipt_directory(edits)
    prefix = f"{candidate_id}."
    result: list[Path] = []
    try:
        entries = list(os.scandir(directory))
    except OSError as error:
        raise EditorSemanticInvalid() from error
    for entry in entries:
        if not entry.name.startswith(prefix):
            continue
        suffix = entry.name[len(prefix) :]
        if not suffix.endswith(".json") or not _UUID.fullmatch(suffix[:-5]):
            raise EditorSemanticInvalid()
        try:
            if not stat.S_ISREG(entry.stat(follow_symlinks=False).st_mode):
                raise EditorSemanticInvalid()
        except OSError as error:
            raise EditorSemanticInvalid() from error
        result.append(Path(entry.path))
    if len(result) > MAX_RECEIPTS:
        raise EditorSemanticInvalid()
    return result


def _decode_receipt(raw: bytes, candidate_id: str) -> tuple[dict[str, object], ClipEditManifest]:
    required = {
        "version",
        "status",
        "idempotency_key",
        "candidate_id",
        "payload_sha256",
        "expected_etag",
        "candidate_artifact_sha256",
        "desired_manifest_sha256",
        "desired_manifest",
        "result_etag",
        "revision",
    }
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=storage._pairs)
        if type(value) is not dict or set(value) != required or value["version"] != 1:
            raise ValueError("receipt shape")
        if value["status"] not in {"pending", "committed"}:
            raise ValueError("receipt status")
        if value["candidate_id"] != candidate_id or not _UUID.fullmatch(value["idempotency_key"]):
            raise ValueError("receipt identity")
        for field in (
            "payload_sha256",
            "expected_etag",
            "candidate_artifact_sha256",
            "desired_manifest_sha256",
        ):
            if not isinstance(value[field], str) or not _SHA256.fullmatch(value[field]):
                raise ValueError("receipt digest")
        if value["status"] == "committed":
            if not isinstance(value["result_etag"], str) or not _SHA256.fullmatch(
                value["result_etag"]
            ):
                raise ValueError("receipt result")
        elif value["result_etag"] is not None:
            raise ValueError("pending receipt result")
        if not isinstance(value["revision"], int) or isinstance(value["revision"], bool):
            raise TypeError("receipt revision")
        desired_raw = json.dumps(
            value["desired_manifest"],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        desired = manifest_from_bytes(desired_raw)
        if (
            desired.identity.candidate_id != candidate_id
            or desired.revision != value["revision"]
            or manifest_sha256(desired) != value["desired_manifest_sha256"]
        ):
            raise ValueError("receipt manifest binding")
        canonical = json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        if raw != canonical:
            raise ValueError("noncanonical receipt")
        return value, desired
    except Exception as error:
        raise EditorSemanticInvalid() from error


def _read_receipt(
    edits: Path, candidate_id: str, key: str
) -> tuple[dict[str, object], ClipEditManifest] | None:
    path = _receipt_path(edits, candidate_id, key)
    try:
        raw = storage._read_regular(path, MAX_RECEIPT_BYTES)
    except FileNotFoundError:
        return None
    return _decode_receipt(raw, candidate_id)


def _write_receipt(edits: Path, receipt: dict[str, object]) -> None:
    raw = json.dumps(
        receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    if len(raw) > MAX_RECEIPT_BYTES:
        raise EditorSemanticInvalid()
    directory = _receipt_directory(edits)
    path = _receipt_path(edits, receipt["candidate_id"], receipt["idempotency_key"])
    storage._atomic_write(directory, path, raw)
    if storage._read_regular(path, MAX_RECEIPT_BYTES) != raw:
        raise EditorSemanticInvalid()


def _publish_manifest_locked(
    analysis: Path, edits: Path, manifest: ClipEditManifest, expected_etag: str
) -> str:
    return storage._write_edit_manifest_locked(
        analysis, edits, manifest, expected_revision_sha256=expected_etag
    )


def process_editor(analysis_dir: Path, command: object) -> dict[str, object]:
    """Create/read or conditionally replace one candidate's edit manifest."""
    analysis = Path(analysis_dir)
    try:
        storage._validate_analysis_dir(analysis)
        body = command if isinstance(command, dict) else None
        if body is None or body.get("operation") not in {"get", "put"}:
            raise EditorRequestInvalid()
        candidate_id = body.get("candidateId")
        if not isinstance(candidate_id, str) or not _CANDIDATE_ID.fullmatch(candidate_id):
            raise EditorRequestInvalid()

        with (
            _service_lock(analysis, candidate_id),
            storage._edit_transaction(analysis, candidate_id) as edits,
        ):
            artifact, candidate, artifact_raw = storage._candidate_context(
                analysis / "candidates.v2.json", candidate_id
            )
            expected_identity = storage._expected_identity(artifact, candidate, artifact_raw)
            if body["operation"] == "get":
                _exact(body, {"operation", "candidateId"})
                try:
                    current = storage._read_edit_manifest_locked(analysis, edits, candidate_id)
                except EditManifestNotFound:
                    current = _default_manifest(analysis, candidate_id, candidate)
                    storage._write_edit_manifest_locked(
                        analysis, edits, current, expected_revision_sha256=None
                    )
                except EditManifestInvalid as error:
                    raise EditorSelectionChanged() from error
                if current.identity != expected_identity:
                    raise EditorSelectionChanged()
                return _result(current, created=True)

            put = _exact(
                body,
                {"operation", "candidateId", "expectedEtag", "idempotencyKey", "manifest"},
            )
            etag = put["expectedEtag"]
            key = put["idempotencyKey"]
            if not isinstance(etag, str) or not _SHA256.fullmatch(etag):
                raise EditorRequestInvalid()
            if not isinstance(key, str) or not _UUID.fullmatch(key):
                raise EditorRequestInvalid()
            key = key.lower()
            try:
                manifest_raw = json.dumps(
                    put["manifest"],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ).encode("utf-8")
                manifest = manifest_from_bytes(manifest_raw)
            except Exception as error:
                raise EditorSemanticInvalid() from error
            if manifest.identity.candidate_id != candidate_id:
                raise EditorSemanticInvalid()
            if manifest.identity != expected_identity:
                raise EditorSelectionChanged()
            desired_raw = canonical_manifest_bytes(manifest)
            desired_sha = hashlib.sha256(desired_raw).hexdigest()
            payload_sha = hashlib.sha256(etag.encode("ascii") + b"\0" + desired_raw).hexdigest()

            entries = _receipt_entries(edits, candidate_id)
            found = _read_receipt(edits, candidate_id, key)
            if found is not None:
                receipt, desired = found
                if receipt["payload_sha256"] != payload_sha or receipt["expected_etag"] != etag:
                    raise EditorIdempotencyConflict()
                if (
                    receipt["candidate_artifact_sha256"]
                    != expected_identity.candidate_artifact_sha256
                ):
                    raise EditorSelectionChanged()
                if desired != manifest:
                    raise EditorIdempotencyConflict()
                if receipt["status"] == "committed":
                    if receipt["result_etag"] != desired_sha:
                        raise EditorSemanticInvalid()
                    return _result(desired, created=False)
                try:
                    current = storage._read_edit_manifest_locked(analysis, edits, candidate_id)
                except EditManifestNotFound as error:
                    raise EditorSemanticInvalid() from error
                current_sha = manifest_sha256(current)
                if current_sha == desired_sha:
                    result_etag = desired_sha
                elif current_sha == etag:
                    try:
                        result_etag = _publish_manifest_locked(analysis, edits, desired, etag)
                    except (EditManifestConflict, EditManifestInvalid) as error:
                        raise EditorSemanticInvalid() from error
                else:
                    # An uncertain transaction must never be downgraded to an
                    # ordinary optimistic-concurrency conflict.
                    raise EditorSemanticInvalid()
                committed = {**receipt, "status": "committed", "result_etag": result_etag}
                _write_receipt(edits, committed)
                return _result(desired, created=False)

            current = storage._read_edit_manifest_locked(analysis, edits, candidate_id)
            if manifest_sha256(current) != etag:
                raise EditorConflict(_result(current, created=False))
            if len(entries) >= MAX_RECEIPTS:
                raise EditorSemanticInvalid()
            receipt = {
                "version": 1,
                "status": "pending",
                "idempotency_key": key,
                "candidate_id": candidate_id,
                "payload_sha256": payload_sha,
                "expected_etag": etag,
                "candidate_artifact_sha256": expected_identity.candidate_artifact_sha256,
                "desired_manifest_sha256": desired_sha,
                "desired_manifest": _manifest_document(manifest),
                "result_etag": None,
                "revision": manifest.revision,
            }
            _write_receipt(edits, receipt)
            try:
                result_etag = _publish_manifest_locked(analysis, edits, manifest, etag)
            except (EditManifestConflict, EditManifestInvalid) as error:
                raise EditorSemanticInvalid() from error
            _write_receipt(edits, {**receipt, "status": "committed", "result_etag": result_etag})
            verified = storage._read_edit_manifest_locked(analysis, edits, candidate_id)
            if manifest_sha256(verified) != result_etag:
                raise EditorSemanticInvalid()
            return _result(verified, created=True)
    except EditorError:
        raise
    except EditManifestNotFound as error:
        raise EditorNotFound() from error
    except EditManifestInvalid as error:
        raise EditorSemanticInvalid() from error


def _decode_command(raw: bytes) -> object:
    command = json.loads(
        raw.decode("utf-8"), object_pairs_hook=storage._pairs, parse_constant=storage._constant
    )
    if isinstance(command, dict) and command.get("operation") == "put" and "manifestRaw" in command:
        command = _exact(
            command,
            {"operation", "candidateId", "expectedEtag", "idempotencyKey", "manifestRaw"},
        )
        encoded = command.pop("manifestRaw")
        if not isinstance(encoded, str):
            raise EditorRequestInvalid()
        try:
            manifest_raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as error:
            raise EditorRequestInvalid() from error
        if not manifest_raw or len(manifest_raw) > MAX_MANIFEST_BODY_BYTES:
            raise EditorRequestInvalid()
        manifest = manifest_from_bytes(manifest_raw)
        command["manifest"] = _manifest_document(manifest)
    return command


def run(argv: list[str], stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--analysis-dir", required=True)
    try:
        args = parser.parse_args(argv)
        raw = stdin.read(MAX_COMMAND_BYTES + 1)
        if not raw or len(raw) > MAX_COMMAND_BYTES:
            raise EditorRequestInvalid()
        result = process_editor(Path(args.analysis_dir), _decode_command(raw))
        stdout.write(
            (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        )
        return 0
    except (EditorRequestInvalid, ValueError, UnicodeError):
        stderr.write("editor_invalid_request\n")
        return 3
    except EditManifestInvalid:
        stderr.write("editor_semantic_invalid\n")
        return 6
    except EditorNotFound:
        stderr.write("editor_not_found\n")
        return 4
    except EditorConflict as error:
        stdout.write(
            (json.dumps(error.current, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        )
        stderr.write("editor_revision_conflict\n")
        return 5
    except EditorSemanticInvalid:
        stderr.write("editor_semantic_invalid\n")
        return 6
    except EditorSelectionChanged:
        stderr.write("editor_selection_changed\n")
        return 8
    except EditorIdempotencyConflict:
        stderr.write("editor_idempotency_conflict\n")
        return 9
    except Exception:  # noqa: BLE001 - sanitize the process protocol boundary
        stderr.write("editor_backend_error\n")
        return 7


def main() -> int:
    return run(sys.argv[1:], sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
