import json
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from test_edit_manifest import make_manifest

from ai_clipper import render_queue
from ai_clipper.edit_manifest import manifest_sha256, write_edit_manifest
from ai_clipper.render_queue import (
    QueueConflict,
    QueueInvalid,
    claim_next,
    create_request,
    get_request,
    heartbeat,
    update_request,
)

KEY = "323e4567-e89b-42d3-a456-426614174000"


def fixture(tmp_path: Path):
    job = tmp_path / "123e4567-e89b-42d3-a456-426614174000"
    analysis, _artifact, manifest = make_manifest(job)
    write_edit_manifest(analysis, manifest, expected_revision_sha256=None)
    source = job / "input" / "source.mp4"
    source.parent.mkdir()
    source.write_bytes(b"downloaded source bytes")
    (job / "job.json").write_text(json.dumps({"id": job.name, "sourcePath": str(source)}))
    return job, analysis, manifest, source


def test_create_is_durable_content_bound_and_idempotent(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    etag = manifest_sha256(manifest)
    first = create_request(job, manifest.identity.candidate_id, etag, KEY)
    replay = create_request(job, manifest.identity.candidate_id, etag, KEY.upper())

    assert first == replay
    assert first["version"] == "render-request-v1"
    assert first["state"] == "queued" and first["attempts"] == 0
    assert (
        first["source_content_sha256"]
        == __import__("hashlib").sha256(source.read_bytes()).hexdigest()
    )
    assert first["candidate_artifact_sha256"] == manifest.identity.candidate_artifact_sha256
    assert (job / first["source_snapshot_relative"]).read_bytes() == b"downloaded source bytes"
    assert (job / first["candidate_snapshot_relative"]).read_bytes() == (
        job / "analysis" / "candidates.v2.json"
    ).read_bytes()
    assert (job / first["source_snapshot_relative"]).stat().st_mode & 0o777 == 0o600
    assert first["edit_manifest_sha256"] == etag
    assert (
        first["output_relative"] == f"output/edits/{manifest.identity.candidate_id}/revision-1.mp4"
    )
    archive = job / first["edit_manifest_relative"]
    assert archive.is_file()
    assert get_request(job, first["render_id"]) == first

    with pytest.raises(QueueConflict):
        create_request(job, manifest.identity.candidate_id, "0" * 64, KEY)


def test_claim_has_one_winner_and_state_machine_is_exact(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    created = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    outcomes = []

    def run():
        outcomes.append(claim_next(job))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    claimed = [item for item in outcomes if item is not None]
    assert len(claimed) == 1 and claimed[0]["state"] == "claimed"
    token = claimed[0]["lease_token"]
    assert claimed[0]["attempts"] == 1 and token
    rendering = update_request(job, created["render_id"], "rendering", lease_token=token)
    assert rendering["state"] == "rendering"
    beat = heartbeat(job, created["render_id"], token)
    assert beat["heartbeat_at"] is not None
    completed = update_request(job, created["render_id"], "completed", lease_token=token)
    assert completed["state"] == "completed" and completed["error_code"] is None


def test_stale_claim_requeues_then_bounded_attempts_fail(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    stale = (datetime.now(UTC) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
    path = job / "analysis" / "render-requests" / f"{request['render_id']}.json"
    tokens = []
    for attempts in (0, 1, 2):
        value = claim_next(job)
        assert value is not None
        tokens.append(value["lease_token"])
        raw = json.loads(path.read_text())
        raw["heartbeat_at"] = stale
        raw["updated_at"] = stale
        path.write_text(json.dumps(raw, sort_keys=True, separators=(",", ":")))
    assert claim_next(job, lease_seconds=1) is None
    final = get_request(job, request["render_id"])
    assert final["state"] == "failed" and final["attempts"] == 3
    assert final["error_code"] == "max_attempts_exceeded"
    with pytest.raises(QueueConflict):
        update_request(job, request["render_id"], "completed", lease_token=tokens[0])


def test_enqueue_snapshots_are_immutable_and_ignore_later_mutation(tmp_path: Path):
    job, analysis, manifest, source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    source_snapshot = job / request["source_snapshot_relative"]
    candidate_snapshot = job / request["candidate_snapshot_relative"]
    source.replace(source.with_suffix(".old"))
    source.write_bytes(b"replacement")
    (analysis / "candidates.v2.json").write_bytes(b"replacement")
    assert source_snapshot.read_bytes() == b"downloaded source bytes"
    assert candidate_snapshot.read_bytes() != b"replacement"


def test_source_snapshot_copy_consumes_open_fd_after_path_replacement(tmp_path: Path, monkeypatch):
    job, _analysis, manifest, source = fixture(tmp_path)
    original_open = render_queue.os.open
    replaced = False

    def adversarial_open(path, flags, *args, **kwargs):
        nonlocal replaced
        fd = original_open(path, flags, *args, **kwargs)
        if Path(path) == source and not replaced:
            replaced = True
            source.replace(source.with_suffix(".original"))
            source.write_bytes(b"replacement after secure open")
        return fd

    monkeypatch.setattr(render_queue.os, "open", adversarial_open)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)

    assert replaced
    assert (job / request["source_snapshot_relative"]).read_bytes() == b"downloaded source bytes"
    assert source.read_bytes() == b"replacement after secure open"


def test_heartbeat_prevents_reclaim_but_expired_owner_is_fenced(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    first = claim_next(job, lease_seconds=1)
    assert first is not None
    heartbeat(job, request["render_id"], first["lease_token"])
    assert claim_next(job, lease_seconds=60) is None
    path = job / "analysis" / "render-requests" / f"{request['render_id']}.json"
    raw = json.loads(path.read_text())
    raw["heartbeat_at"] = "2020-01-01T00:00:00.000Z"
    path.write_text(json.dumps(raw, sort_keys=True, separators=(",", ":")))
    second = claim_next(job, lease_seconds=1)
    assert second is not None and second["lease_token"] != first["lease_token"]
    with pytest.raises(QueueConflict):
        update_request(job, request["render_id"], "rendering", lease_token=first["lease_token"])


def test_queue_rejects_symlink_duplicate_nonfinite_and_oversize(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    path = job / "analysis" / "render-requests" / f"{request['render_id']}.json"
    path.write_text('{"version":"render-request-v1","version":"render-request-v1"}')
    with pytest.raises(QueueInvalid):
        get_request(job, request["render_id"])
    path.write_text('{"x":1e999}')
    with pytest.raises(QueueInvalid):
        get_request(job, request["render_id"])
    path.unlink()
    outside = tmp_path / "outside"
    outside.write_text("{}")
    path.symlink_to(outside)
    with pytest.raises(QueueInvalid):
        get_request(job, request["render_id"])
