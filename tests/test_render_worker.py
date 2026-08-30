import hashlib
import json
import threading
import time
from pathlib import Path

import pytest
from test_render_queue import KEY, RESERVATION_ID, RESERVATION_TOKEN, fixture

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
from ai_clipper.render_worker import run_forever, run_one


def test_one_shot_worker_claims_renders_and_completes(tmp_path: Path):
    legacy = tmp_path / "000-legacy-v1"
    legacy.mkdir()
    (legacy / "job.json").write_text('{"status":"completed"}')
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


def test_watch_worker_sleeps_only_when_queue_is_empty(tmp_path: Path, monkeypatch):
    calls = iter(["render-a", None, "render-b", None])
    observed: list[float] = []

    monkeypatch.setattr(
        "ai_clipper.render_worker.run_one",
        lambda *_args, **_kwargs: next(calls),
    )

    class StopWatch(Exception):
        pass

    def stop_after_second_idle(seconds: float) -> None:
        observed.append(seconds)
        if len(observed) == 2:
            raise StopWatch

    with pytest.raises(StopWatch):
        run_forever(tmp_path, poll_seconds=0.25, sleep=stop_after_second_idle)
    assert observed == [0.25, 0.25]


@pytest.mark.parametrize("poll_seconds", [0, 0.09, 61, float("nan")])
def test_watch_worker_rejects_unsafe_poll_intervals(tmp_path: Path, poll_seconds: float):
    with pytest.raises(ValueError):
        run_forever(tmp_path, poll_seconds=poll_seconds)


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


def test_admitted_worker_rechecks_heartbeats_and_releases_storage(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    request = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )
    calls = []

    def storage_client(operation, reservation_id, token, terminal_state=None):
        calls.append((operation, reservation_id, token, terminal_state))
        return True

    assert (
        run_one(
            tmp_path,
            renderer=lambda _s, _m, output, _c, **_o: output.write_bytes(b"render"),
            verifier=lambda *_a: None,
            storage_client=storage_client,
            heartbeat_interval=0.01,
            storage_recheck_interval_ms=10,
            storage_recheck_bytes=8 * 1024 * 1024,
        )
        == request["render_id"]
    )
    assert calls[0][:3] == ("heartbeat", RESERVATION_ID, RESERVATION_TOKEN)
    assert ("release", RESERVATION_ID, RESERVATION_TOKEN, "completed") in calls


def test_worker_fails_closed_when_storage_watermark_recheck_fails(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    request = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )
    rendered = []
    assert (
        run_one(
            tmp_path,
            renderer=lambda *_a, **_o: rendered.append(True),
            verifier=lambda *_a: None,
            storage_client=lambda *_a, **_o: False,
            storage_recheck_interval_ms=1000,
            storage_recheck_bytes=8 * 1024 * 1024,
        )
        == request["render_id"]
    )
    assert rendered == []
    assert get_request(job, request["render_id"])["state"] == "failed"


def test_periodic_storage_recheck_loss_prevents_publication(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    request = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )
    storage_lost = threading.Event()
    heartbeat_calls = 0

    def storage_client(operation, *_args, **_kwargs):
        nonlocal heartbeat_calls
        if operation == "release":
            return True
        heartbeat_calls += 1
        if heartbeat_calls > 1:
            storage_lost.set()
            return False
        return True

    def renderer(_source, _manifest, output, _candidate, **_options):
        assert storage_lost.wait(2)
        output.write_bytes(b"must not publish")

    assert (
        run_one(
            tmp_path,
            renderer=renderer,
            verifier=lambda *_args: None,
            storage_client=storage_client,
            heartbeat_interval=0.01,
            storage_recheck_interval_ms=10,
            storage_recheck_bytes=8 * 1024 * 1024,
        )
        == request["render_id"]
    )
    assert get_request(job, request["render_id"])["state"] == "failed"
    assert not (job / request["output_relative"]).exists()


def test_storage_time_cadence_is_independent_of_queue_heartbeat(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )
    checked = threading.Event()
    calls = 0

    def storage_client(operation, *_args, **_kwargs):
        nonlocal calls
        if operation == "release":
            return True
        calls += 1
        if calls >= 2:
            checked.set()
        return True

    def renderer(_source, _manifest, output, _candidate, **_options):
        assert checked.wait(2)
        output.write_bytes(b"render")

    run_one(
        tmp_path,
        renderer=renderer,
        verifier=lambda *_args: None,
        storage_client=storage_client,
        heartbeat_interval=10,
        storage_recheck_interval_ms=10,
        storage_recheck_bytes=1 << 30,
    )
    assert calls >= 3  # initial, periodic, and final


def test_storage_byte_growth_triggers_recheck_while_renderer_blocks(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )
    checked = threading.Event()
    calls = 0

    def storage_client(operation, *_args, **_kwargs):
        nonlocal calls
        if operation == "release":
            return True
        calls += 1
        if calls >= 2:
            checked.set()
        return True

    def renderer(_source, _manifest, output, _candidate, **_options):
        output.write_bytes(b"growing output")
        assert checked.wait(2)

    run_one(
        tmp_path,
        renderer=renderer,
        verifier=lambda *_args: None,
        storage_client=storage_client,
        heartbeat_interval=10,
        storage_recheck_interval_ms=60_000,
        storage_recheck_bytes=1,
    )
    assert calls >= 3


def test_render_storage_recheck_config_is_strict(monkeypatch):
    valid = {
        "JOBS_STORAGE_RECHECK_INTERVAL_MS": "100",
        "JOBS_STORAGE_RECHECK_BYTES": str(8 * 1024 * 1024),
    }
    assert render_worker.parse_storage_recheck_config(valid) == (0.1, 8 * 1024 * 1024)
    for field, value in [
        ("JOBS_STORAGE_RECHECK_INTERVAL_MS", "0"),
        ("JOBS_STORAGE_RECHECK_BYTES", "1.5"),
    ]:
        invalid = {**valid, field: value}
        with pytest.raises(ValueError):
            render_worker.parse_storage_recheck_config(invalid)
    with pytest.raises(ValueError):
        render_worker.parse_storage_recheck_config({})


def test_release_transport_failure_does_not_undo_terminal_request(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    request = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 4096,
        },
    )

    def storage_client(operation, *_args, **_kwargs):
        if operation == "release":
            raise OSError("transport failed")
        return True

    assert (
        run_one(
            tmp_path,
            renderer=lambda _s, _m, output, _c, **_o: output.write_bytes(b"render"),
            verifier=lambda *_args: None,
            storage_client=storage_client,
            storage_recheck_interval_ms=1000,
            storage_recheck_bytes=8 * 1024 * 1024,
        )
        == request["render_id"]
    )
    assert get_request(job, request["render_id"])["state"] == "completed"
