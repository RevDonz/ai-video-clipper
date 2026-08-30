import hashlib
import io
import json
import unicodedata
import uuid
from dataclasses import replace
from pathlib import Path

import pytest
from test_candidate_api import encoded, task5_artifact

from ai_clipper import editor_api
from ai_clipper.edit_manifest import read_edit_manifest
from ai_clipper.editor_api import (
    EditorConflict,
    EditorIdempotencyConflict,
    EditorSelectionChanged,
    EditorSemanticInvalid,
    process_editor,
    run,
)

REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000"


def setup_analysis(tmp_path: Path):
    analysis = tmp_path / "analysis"
    analysis.mkdir(parents=True)
    artifact = task5_artifact()
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))
    return analysis, artifact.candidates[0]


def test_get_durably_creates_deterministic_default_manifest(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)

    first = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    second = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})

    assert first == second
    assert first["created"] is True
    assert first["manifest"]["revision"] == 1
    assert first["manifest"]["captions"] == [
        {
            "cue_id": "cue-0001",
            "index": 0,
            "start": candidate.start,
            "end": candidate.end,
            "text": candidate.text,
            "original_text_sha256": hashlib.sha256(candidate.text.encode()).hexdigest(),
        }
    ]
    target = analysis / "edits" / f"{candidate.candidate_id}.edit.v1.json"
    assert (
        target.read_bytes()
        == json.dumps(
            first["manifest"], ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    )
    assert first["etag"] == hashlib.sha256(target.read_bytes()).hexdigest()


def test_put_saves_revision_and_same_idempotency_key_replays(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    manifest = current["manifest"]
    manifest["revision"] = 2
    manifest["parent_revision_sha256"] = current["etag"]
    manifest["captions"][0]["text"] = "Edited caption"
    manifest["audit"]["updated_at"] = "1970-01-01T00:00:00.001Z"
    command = {
        "operation": "put",
        "candidateId": candidate.candidate_id,
        "expectedEtag": current["etag"],
        "idempotencyKey": REQUEST_ID,
        "manifest": manifest,
    }

    saved = process_editor(analysis, command)
    replayed = process_editor(analysis, command)

    assert saved["created"] is True and saved["manifest"]["revision"] == 2
    assert replayed == {**saved, "created": False}
    receipts = list((analysis / "edits" / "receipts").glob(f"{candidate.candidate_id}.*.json"))
    assert len(receipts) == 1
    receipt_raw = receipts[0].read_text()
    assert json.loads(receipt_raw)["status"] == "committed"
    assert task5_artifact().source not in receipt_raw

    changed = json.loads(json.dumps(command))
    changed["manifest"]["captions"][0]["text"] = "Different"
    with pytest.raises(EditorIdempotencyConflict):
        process_editor(analysis, changed)


def test_stale_put_returns_current_conflict_and_candidate_reselection_is_distinct(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    stale = json.loads(json.dumps(current["manifest"]))
    stale["revision"] = 2
    stale["parent_revision_sha256"] = current["etag"]
    stale["audit"]["updated_at"] = "1970-01-01T00:00:00.001Z"

    with pytest.raises(EditorConflict) as caught:
        process_editor(
            analysis,
            {
                "operation": "put",
                "candidateId": candidate.candidate_id,
                "expectedEtag": "f" * 64,
                "idempotencyKey": REQUEST_ID,
                "manifest": stale,
            },
        )
    assert caught.value.current["etag"] == current["etag"]

    (analysis / "candidates.v2.json").write_bytes(encoded(task5_artifact()) + b" ")
    with pytest.raises(EditorSelectionChanged):
        process_editor(
            analysis,
            {
                "operation": "put",
                "candidateId": candidate.candidate_id,
                "expectedEtag": current["etag"],
                "idempotencyKey": REQUEST_ID,
                "manifest": stale,
            },
        )


def test_cli_transports_bounded_commands_and_sanitized_conflicts(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    stdout = io.BytesIO()
    stderr = io.StringIO()
    command = json.dumps({"operation": "get", "candidateId": candidate.candidate_id}).encode()
    assert run(["--analysis-dir", str(analysis)], io.BytesIO(command), stdout, stderr) == 0
    assert json.loads(stdout.getvalue())["manifest"]["revision"] == 1

    stdout = io.BytesIO()
    stderr = io.StringIO()
    invalid = b"x" * (2 * 1024 * 1024 + 1)
    assert run(["--analysis-dir", str(analysis)], io.BytesIO(invalid), stdout, stderr) == 3
    assert stderr.getvalue() == "editor_invalid_request\n"


def test_full_receipt_journal_rejects_before_manifest_is_changed(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    manifest = json.loads(json.dumps(current["manifest"]))
    manifest["revision"] = 2
    manifest["parent_revision_sha256"] = current["etag"]
    manifest["audit"]["updated_at"] = "1970-01-01T00:00:00.001Z"
    receipt_dir = analysis / "edits" / "receipts"
    receipt_dir.mkdir()
    for _ in range(1000):
        (receipt_dir / f"{candidate.candidate_id}.{uuid.uuid4()}.json").write_text("{}")

    with pytest.raises(EditorSemanticInvalid):
        process_editor(
            analysis,
            {
                "operation": "put",
                "candidateId": candidate.candidate_id,
                "expectedEtag": current["etag"],
                "idempotencyKey": REQUEST_ID,
                "manifest": manifest,
            },
        )
    assert (
        process_editor(
            analysis,
            {
                "operation": "get",
                "candidateId": candidate.candidate_id,
            },
        )["manifest"]["revision"]
        == 1
    )


def put_command(current, candidate_id, *, key=REQUEST_ID, text="Edited caption"):
    manifest = json.loads(json.dumps(current["manifest"]))
    manifest["revision"] += 1
    manifest["parent_revision_sha256"] = current["etag"]
    manifest["captions"][0]["text"] = text
    manifest["audit"]["updated_at"] = "1970-01-01T00:00:00.001Z"
    return {
        "operation": "put",
        "candidateId": candidate_id,
        "expectedEtag": current["etag"],
        "idempotencyKey": key,
        "manifest": manifest,
    }


def test_retry_recovers_when_process_dies_after_pending_receipt(tmp_path, monkeypatch):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    command = put_command(current, candidate.candidate_id)
    real_publish = editor_api._publish_manifest_locked
    monkeypatch.setattr(
        editor_api,
        "_publish_manifest_locked",
        lambda *_args, **_kw: (_ for _ in ()).throw(RuntimeError("crash")),
    )

    with pytest.raises(RuntimeError, match="crash"):
        process_editor(analysis, command)
    assert read_edit_manifest(analysis, candidate.candidate_id).revision == 1

    monkeypatch.setattr(editor_api, "_publish_manifest_locked", real_publish)
    recovered = process_editor(analysis, command)
    assert recovered["manifest"]["revision"] == 2
    assert process_editor(analysis, command) == {**recovered, "created": False}


def test_retry_recovers_when_process_dies_after_manifest_publish(tmp_path, monkeypatch):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    command = put_command(current, candidate.candidate_id)
    real_write = editor_api._write_receipt
    failed = False

    def fail_final(edits, receipt):
        nonlocal failed
        if receipt["status"] == "committed" and not failed:
            failed = True
            raise RuntimeError("crash after manifest")
        return real_write(edits, receipt)

    monkeypatch.setattr(editor_api, "_write_receipt", fail_final)
    with pytest.raises(RuntimeError, match="crash after manifest"):
        process_editor(analysis, command)
    assert read_edit_manifest(analysis, candidate.candidate_id).revision == 2

    recovered = process_editor(analysis, command)
    assert recovered["manifest"]["revision"] == 2
    assert process_editor(analysis, command)["etag"] == recovered["etag"]


def test_pending_transaction_divergence_is_never_reported_as_revision_conflict(
    tmp_path, monkeypatch
):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    pending = put_command(current, candidate.candidate_id, text="Pending edit")
    real_publish = editor_api._publish_manifest_locked
    monkeypatch.setattr(
        editor_api,
        "_publish_manifest_locked",
        lambda *_args, **_kw: (_ for _ in ()).throw(RuntimeError("crash")),
    )
    with pytest.raises(RuntimeError):
        process_editor(analysis, pending)

    monkeypatch.setattr(editor_api, "_publish_manifest_locked", real_publish)
    competing = put_command(
        current,
        candidate.candidate_id,
        key="423e4567-e89b-42d3-a456-426614174000",
        text="Other edit",
    )
    process_editor(analysis, competing)
    with pytest.raises(EditorSemanticInvalid):
        process_editor(analysis, pending)


def test_failure_before_pending_never_publishes_manifest(tmp_path, monkeypatch):
    analysis, candidate = setup_analysis(tmp_path)
    current = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    command = put_command(current, candidate.candidate_id)
    monkeypatch.setattr(
        editor_api, "_write_receipt", lambda *_args: (_ for _ in ()).throw(RuntimeError("disk"))
    )

    with pytest.raises(RuntimeError, match="disk"):
        process_editor(analysis, command)
    assert read_edit_manifest(analysis, candidate.candidate_id).revision == 1


def test_default_manifest_sanitizes_and_bounds_any_valid_candidate_text(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    original = "Cafe\u0301\x00\n\t" + "😀" * 501
    artifact = task5_artifact()
    changed = replace(artifact.candidates[0], text=original)
    artifact = replace(artifact, candidates=(changed, *artifact.candidates[1:]))
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))

    result = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    cue = result["manifest"]["captions"][0]
    assert cue["text"] == unicodedata.normalize("NFC", "Café " + "😀" * 495)
    assert len(cue["text"]) == 500
    assert cue["original_text_sha256"] == hashlib.sha256(original.encode("utf-8")).hexdigest()


def test_default_manifest_uses_fallback_when_sanitized_candidate_text_is_empty(tmp_path):
    analysis, candidate = setup_analysis(tmp_path)
    artifact = task5_artifact()
    changed = replace(artifact.candidates[0], text="\x00\n\t")
    artifact = replace(artifact, candidates=(changed, *artifact.candidates[1:]))
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))

    result = process_editor(analysis, {"operation": "get", "candidateId": candidate.candidate_id})
    cue = result["manifest"]["captions"][0]
    assert cue["text"] == "Caption kandidat"
    assert cue["original_text_sha256"] == hashlib.sha256(b"\x00\n\t").hexdigest()


def test_missing_candidate_is_not_found_in_process_and_cli(tmp_path):
    analysis, _candidate = setup_analysis(tmp_path)
    missing = "cand_" + "f" * 64
    command = {"operation": "get", "candidateId": missing}

    stdout = io.BytesIO()
    stderr = io.StringIO()
    assert (
        run(
            ["--analysis-dir", str(analysis)],
            io.BytesIO(json.dumps(command).encode()),
            stdout,
            stderr,
        )
        == 4
    )
    assert stderr.getvalue() == "editor_not_found\n"
