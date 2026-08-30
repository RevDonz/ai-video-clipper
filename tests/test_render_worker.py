import hashlib
import json
import threading
import time
from pathlib import Path

import pytest
from test_render_queue import KEY, fixture

from ai_clipper import render_worker
from ai_clipper.edit_manifest import manifest_sha256
from ai_clipper.render_queue import (
    QueueConflict,
    claim_next,
    create_request,
    get_request,
    publish_completed_output,
    update_request,
)
from ai_clipper.render_worker import run_one


def test_one_shot_worker_claims_renders_and_completes(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    calls = []

    def renderer(src, manifest_path, output, candidate_path, **options):
        calls.append((src, manifest_path, output, candidate_path, options))
        output.write_bytes(b"verified render")

    assert (
        run_one(tmp_path, renderer=renderer, verifier=lambda *_args: None) == request["render_id"]
    )
    final = get_request(job, request["render_id"])
    assert final["state"] == "completed"
    assert calls[0][0] == job / request["source_snapshot_relative"]
    assert calls[0][1] == job / request["edit_manifest_relative"]
    assert calls[0][3] == job / request["candidate_snapshot_relative"]
    assert calls[0][4]["expected_source_content_sha256"] == request["source_content_sha256"]
    assert (job / request["output_relative"]).read_bytes() == b"verified render"
    assert run_one(tmp_path, renderer=renderer, verifier=lambda *_args: None) is None


def test_worker_recovers_already_published_output_without_clobber(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    claimed = claim_next(job)
    update_request(job, request["render_id"], "rendering", lease_token=claimed["lease_token"])
    output = job / request["output_relative"]
    output.parent.mkdir(parents=True)
    output.write_bytes(b"already complete")
    # Simulate lease recovery by making a fresh queued request state through the authority.
    path = job / "analysis" / "render-requests" / f"{request['render_id']}.json"
    value = json.loads(path.read_text())
    value.update(
        state="queued",
        attempts=0,
        claimed_at=None,
        rendering_at=None,
        heartbeat_at=None,
        lease_token=None,
    )
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")))
    rendered = []
    assert (
        run_one(
            tmp_path, renderer=lambda *_a, **_k: rendered.append(True), verifier=lambda *_a: None
        )
        == request["render_id"]
    )
    assert rendered == []
    assert output.read_bytes() == b"already complete"
    assert get_request(job, request["render_id"])["state"] == "completed"


def test_recovery_rejects_tampered_source_snapshot_and_cannot_complete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    source_snapshot = job / request["source_snapshot_relative"]
    source_snapshot.write_bytes(b"tampered after request creation")
    output = job / request["output_relative"]
    output.parent.mkdir(parents=True)
    output.write_bytes(b"already complete")
    monkeypatch.setattr(
        render_worker,
        "_probe_media",
        lambda *_args, **_kwargs: {"has_audio": False},
    )
    monkeypatch.setattr(render_worker, "_verify_output", lambda *_args: None)

    assert run_one(tmp_path) == request["render_id"]
    final = get_request(job, request["render_id"])
    assert final["state"] == "failed"
    assert final["completed_at"] is None
    assert final["error_code"] == "render_failed"


def test_recovery_probes_open_verified_source_fd_despite_path_replacement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    source_snapshot = job / request["source_snapshot_relative"]
    original = source_snapshot.read_bytes()
    assert hashlib.sha256(original).hexdigest() == request["source_content_sha256"]
    output = job / request["output_relative"]
    output.parent.mkdir(parents=True)
    output.write_bytes(b"already complete")
    source_calls = []

    def probe(path, **options):
        if str(path).startswith("/proc/self/fd/"):
            source_calls.append((str(path), options.get("pass_fds")))
            source_snapshot.replace(source_snapshot.with_suffix(".replaced"))
            source_snapshot.write_bytes(b"replacement")
            assert Path(path).read_bytes() == original
            fd = int(str(path).rsplit("/", 1)[1])
            assert options.get("pass_fds") == (fd,)
            return {"has_audio": False}
        return {"has_audio": False}

    monkeypatch.setattr(render_worker, "_probe_media", probe)
    monkeypatch.setattr(render_worker, "_verify_output", lambda *_args: None)

    assert run_one(tmp_path) == request["render_id"]
    assert source_calls
    assert get_request(job, request["render_id"])["state"] == "completed"


def test_worker_heartbeats_during_long_render_and_prevents_reclaim(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    rendering = threading.Event()
    release = threading.Event()

    def renderer(_source, _manifest, output, _candidate, **_options):
        rendering.set()
        assert release.wait(2)
        output.write_bytes(b"long verified render")

    worker = threading.Thread(
        target=run_one,
        args=(tmp_path,),
        kwargs={
            "renderer": renderer,
            "verifier": lambda *_args: None,
            "lease_seconds": 0.08,
            "heartbeat_interval": 0.01,
        },
    )
    worker.start()
    assert rendering.wait(2)
    time.sleep(0.2)
    assert claim_next(job, lease_seconds=0.08) is None
    release.set()
    worker.join(2)

    assert not worker.is_alive()
    assert get_request(job, request["render_id"])["state"] == "completed"
    assert (job / request["output_relative"]).read_bytes() == b"long verified render"
    assert not list((job / "analysis" / "render-staging").iterdir())


def test_lost_lease_worker_cannot_publish_and_cleans_staging(tmp_path: Path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    request = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    rendered = threading.Event()
    release = threading.Event()

    def renderer(_source, _manifest, output, _candidate, **_options):
        output.write_bytes(b"stale worker render")
        rendered.set()
        assert release.wait(2)

    worker = threading.Thread(
        target=run_one,
        args=(tmp_path,),
        kwargs={
            "renderer": renderer,
            "verifier": lambda *_args: None,
            "lease_seconds": 0.05,
            "heartbeat_interval": 10.0,
        },
    )
    worker.start()
    assert rendered.wait(2)
    stale = get_request(job, request["render_id"])
    stale_token = str(stale["lease_token"])
    time.sleep(0.1)
    replacement = claim_next(job, lease_seconds=0.05)
    assert replacement is not None
    update_request(
        job,
        request["render_id"],
        "rendering",
        lease_token=replacement["lease_token"],
    )
    release.set()
    worker.join(2)

    assert not worker.is_alive()
    assert not (job / request["output_relative"]).exists()
    assert not list((job / "analysis" / "render-staging").iterdir())
    stale_staging = (
        job / "analysis" / "render-staging" / f"{request['render_id']}.{stale_token}.mp4"
    )
    with pytest.raises(QueueConflict):
        publish_completed_output(
            job,
            request["render_id"],
            stale_token,
            stale_staging,
        )
