import io
import json
import multiprocessing
import os
import time
import uuid
from pathlib import Path

import pytest
from test_candidate_api import encoded, task5_artifact

from ai_clipper.candidate_feedback import (
    FeedbackArtifactInvalid,
    FeedbackConflict,
    FeedbackNotFound,
    FeedbackRequestInvalid,
    SelectionChanged,
    process_feedback,
    run,
)
from ai_clipper.ranking import candidate_artifact_lock


def setup_analysis(tmp_path: Path) -> tuple[Path, str]:
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    artifact = task5_artifact()
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))
    return analysis, artifact.candidates[0].candidate_id


def put(candidate_id: str, request_id: str | None = None, **overrides):
    value = {
        "operation": "put",
        "candidateId": candidate_id,
        "decision": "accepted",
        "note": "  useful clip  ",
        "clientRequestId": request_id or str(uuid.uuid4()),
    }
    value.update(overrides)
    return value


def test_put_appends_strict_bound_artifact_and_get_returns_sanitized_state(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    result = process_feedback(analysis, put(candidate_id))

    assert result["created"] is True
    assert result["event"]["candidateId"] == candidate_id
    assert result["event"]["note"] == "useful clip"
    artifact = json.loads((analysis / "candidate-feedback.v1.json").read_bytes())
    assert set(artifact) == {
        "feedback_version",
        "selection_version",
        "candidate_artifact_analysis",
        "events",
    }
    assert artifact["feedback_version"] == "feedback-v1"
    assert artifact["selection_version"] == "selection-v2.0"
    assert artifact["candidate_artifact_analysis"] == {
        "artifact": "analysis/candidates.v2.json",
        "sha256": result["state"]["candidateArtifactSha256"],
    }
    assert len(artifact["events"]) == 1

    state = process_feedback(analysis, {"operation": "get"})
    assert state == result["state"]
    assert state["eventCount"] == 1
    assert state["latestByCandidate"][candidate_id]["decision"] == "accepted"
    serialized = json.dumps(state)
    assert "source" not in serialized and "provenance" not in serialized


def test_same_client_request_is_idempotent_and_changed_payload_conflicts(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    request_id = str(uuid.uuid4())
    first = process_feedback(analysis, put(candidate_id, request_id))
    second = process_feedback(analysis, put(candidate_id, request_id))
    assert second["created"] is False
    assert second["event"] == first["event"]
    assert second["state"]["eventCount"] == 1

    later = process_feedback(analysis, put(candidate_id, decision="undecided"))
    replay = process_feedback(analysis, put(candidate_id, request_id))
    assert replay["created"] is False
    assert replay["event"] == first["event"]
    assert replay["state"]["latestByCandidate"][candidate_id] == later["event"]

    with pytest.raises(FeedbackConflict):
        process_feedback(analysis, put(candidate_id, request_id, decision="rejected"))


@pytest.mark.parametrize(
    "mutate",
    [
        lambda body: body.update(extra=True),
        lambda body: body.pop("note"),
        lambda body: body.update(candidateId="cand_" + "A" * 64),
        lambda body: body.update(candidateId="cand_" + "a" * 63),
        lambda body: body.update(decision="maybe"),
        lambda body: body.update(note="x\x00y"),
        lambda body: body.update(note="x" * 501),
        lambda body: body.update(clientRequestId="not-a-uuid"),
    ],
)
def test_put_request_is_exact_and_bounded_before_write(tmp_path, mutate):
    analysis, candidate_id = setup_analysis(tmp_path)
    body = put(candidate_id)
    mutate(body)
    with pytest.raises(FeedbackRequestInvalid):
        process_feedback(analysis, body)
    assert not (analysis / "candidate-feedback.v1.json").exists()


def test_note_limit_counts_unicode_scalars_and_rejects_controls_before_trimming(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    accepted = process_feedback(analysis, put(candidate_id, note="  " + "😀" * 500 + "  "))
    assert accepted["event"]["note"] == "😀" * 500
    with pytest.raises(FeedbackRequestInvalid):
        process_feedback(analysis, put(candidate_id, note="😀" * 501))
    for note in ("\nvalid", "valid\t"):
        with pytest.raises(FeedbackRequestInvalid):
            process_feedback(analysis, put(candidate_id, note=note))


def test_candidate_must_exist_and_candidate_artifact_tamper_is_rejected(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    with pytest.raises(FeedbackRequestInvalid):
        process_feedback(analysis, put("cand_" + "f" * 64))

    process_feedback(analysis, put(candidate_id))
    candidate_path = analysis / "candidates.v2.json"
    candidate_path.write_bytes(candidate_path.read_bytes() + b" ")
    state = process_feedback(analysis, {"operation": "get"})
    assert state["available"] is False
    assert state["eventCount"] == 0
    assert len(list(analysis.glob("candidate-feedback.v1.json.stale.*"))) == 1


def test_stale_feedback_is_archived_and_put_starts_a_new_generation(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    first = process_feedback(analysis, put(candidate_id))
    candidate_path = analysis / "candidates.v2.json"
    candidate_path.write_bytes(candidate_path.read_bytes() + b" ")

    second = process_feedback(analysis, put(candidate_id, note="new generation"))
    stale = list(analysis.glob("candidate-feedback.v1.json.stale.*"))
    assert len(stale) == 1
    assert first["event"]["eventId"].encode() in stale[0].read_bytes()
    assert second["state"]["eventCount"] == 1
    assert second["state"]["candidateArtifactSha256"] != first["state"]["candidateArtifactSha256"]


def test_external_candidate_replacement_before_success_archives_feedback(tmp_path, monkeypatch):
    analysis, candidate_id = setup_analysis(tmp_path)
    candidate_path = analysis / "candidates.v2.json"
    module = __import__("ai_clipper.candidate_feedback", fromlist=["_atomic_write"])
    original_write = module._atomic_write

    def replacing_write(*args):
        original_write(*args)
        candidate_path.write_bytes(candidate_path.read_bytes() + b" ")

    monkeypatch.setattr("ai_clipper.candidate_feedback._atomic_write", replacing_write)
    with pytest.raises(SelectionChanged):
        process_feedback(analysis, put(candidate_id))
    assert not (analysis / "candidate-feedback.v1.json").exists()
    assert len(list(analysis.glob("candidate-feedback.v1.json.stale.*"))) == 1


def _try_candidate_lock(analysis: str, queue):
    with candidate_artifact_lock(Path(analysis), exclusive=True):
        queue.put("acquired")


def test_candidate_generation_lock_blocks_writer_and_is_fork_safe_when_nested(tmp_path):
    analysis, _candidate_id = setup_analysis(tmp_path)
    ctx = multiprocessing.get_context("fork")
    queue = ctx.Queue()
    with (
        candidate_artifact_lock(analysis, exclusive=False),
        candidate_artifact_lock(analysis, exclusive=False),
    ):
        child = ctx.Process(target=_try_candidate_lock, args=(str(analysis), queue))
        child.start()
        time.sleep(0.15)
        assert child.is_alive()
        assert queue.empty()
    child.join(2)
    assert child.exitcode == 0
    assert queue.get(timeout=1) == "acquired"


def test_fifo_candidate_and_nonregular_lock_files_are_rejected_without_hanging(tmp_path):
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    os.mkfifo(analysis / "candidates.v2.json")
    started = time.monotonic()
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, {"operation": "get"})
    assert time.monotonic() - started < 1

    (analysis / "candidates.v2.json").unlink()
    artifact = task5_artifact()
    (analysis / "candidates.v2.json").write_bytes(encoded(artifact))
    (analysis / ".candidates.v2.lock").unlink()
    (analysis / ".candidates.v2.lock").mkdir()
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, {"operation": "get"})

    (analysis / ".candidates.v2.lock").rmdir()
    (analysis / ".candidate-feedback.lock").mkdir()
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, {"operation": "get"})


def test_existing_feedback_duplicate_keys_unknown_fields_and_symlink_are_rejected(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    process_feedback(analysis, put(candidate_id))
    feedback = analysis / "candidate-feedback.v1.json"
    raw = feedback.read_text()
    feedback.write_text(raw.replace('"events":', '"unknown":1,"events":', 1))
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, {"operation": "get"})

    feedback.unlink()
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    feedback.symlink_to(outside)
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, {"operation": "get"})


def _concurrent_put(args):
    analysis, candidate_id, request_id = args
    return process_feedback(Path(analysis), put(candidate_id, request_id))["created"]


def test_multiprocess_writes_serialize_without_lost_events_and_duplicate_is_single(tmp_path):
    analysis, candidate_id = setup_analysis(tmp_path)
    duplicate = str(uuid.uuid4())
    ids = [duplicate] * 4 + [str(uuid.uuid4()) for _ in range(12)]
    ctx = multiprocessing.get_context("fork")
    with ctx.Pool(8) as pool:
        created = pool.map(_concurrent_put, [(str(analysis), candidate_id, value) for value in ids])
    state = process_feedback(analysis, {"operation": "get"})
    assert sum(created) == 13
    assert state["eventCount"] == 13
    assert (
        len(
            {
                event["client_request_id"]
                for event in json.loads((analysis / "candidate-feedback.v1.json").read_text())[
                    "events"
                ]
            }
        )
        == 13
    )


def test_event_limit_rejects_new_event_but_allows_idempotent_replay(tmp_path, monkeypatch):
    analysis, candidate_id = setup_analysis(tmp_path)
    monkeypatch.setattr("ai_clipper.candidate_feedback.MAX_EVENTS", 1)
    request_id = str(uuid.uuid4())
    process_feedback(analysis, put(candidate_id, request_id))
    assert process_feedback(analysis, put(candidate_id, request_id))["created"] is False
    with pytest.raises(FeedbackArtifactInvalid):
        process_feedback(analysis, put(candidate_id))


def test_atomic_replace_leaves_no_temp_and_readback_is_verified(tmp_path, monkeypatch):
    analysis, candidate_id = setup_analysis(tmp_path)
    process_feedback(analysis, put(candidate_id))
    assert list(analysis.glob(".candidate-feedback.*.tmp")) == []
    assert (analysis / "candidate-feedback.v1.json").stat().st_size < 8 * 1024 * 1024


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (FeedbackRequestInvalid(), 3),
        (FeedbackNotFound(), 4),
        (FeedbackConflict(), 5),
        (FeedbackArtifactInvalid(), 6),
        (OSError(), 7),
        (SelectionChanged(), 8),
    ],
)
def test_cli_uses_fixed_sanitized_exit_codes(tmp_path, monkeypatch, error, expected):
    def fail(*_args):
        raise error

    monkeypatch.setattr("ai_clipper.candidate_feedback.process_feedback", fail)
    stderr = io.StringIO()
    result = run(
        ["--analysis-dir", str(tmp_path), "--operation", "get"],
        io.BytesIO(),
        io.BytesIO(),
        stderr,
    )
    assert result == expected
    assert stderr.getvalue().startswith("candidate_feedback_")
    assert "OSError" not in stderr.getvalue()
