import gzip
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import threading
import time
import types
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import next_doc
from test_render_queue import (
    KEY,
    RESERVATION_ID,
    RESERVATION_TOKEN,
    V3_TOOLCHAIN,
    V3Job,
    fixture,
    v3_publish,
    v3_rewrite,
)

from ai_clipper import render_worker
from ai_clipper.edit_manifest import manifest_sha256
from ai_clipper.edit_v2 import api as edit_api
from ai_clipper.edit_v2 import compile_ffmpeg, execute, verify
from ai_clipper.edit_v2 import errors as edit_errors
from ai_clipper.edit_v2 import store as edit_store
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan
from ai_clipper.render_queue import (
    QueueConflict,
    cancel_request_v3,
    claim_next,
    create_request,
    create_request_v3,
    get_request,
    publish_completed_output,
    update_request,
)
from ai_clipper.render_worker import run_forever, run_one

ROOT = Path(__file__).resolve().parents[1]


def _make_job_module():
    name = "editor_fixture_make_job"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "scripts" / "editor_fixture" / "make_job.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


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


# --- render-request-v3 (Editor V3 exports, plan §4.6; T2.2) ------------------------------------
#
# The worker hands a v3 request to ``renderer_v3``, whose default is T2.1's
# ``edit_v2.render_edit.render_request(job_dir, request, *, heartbeat, cancel)`` (Appendix A).
# The fakes below follow that seam: render the document of ``doc_relative`` to exactly
# ``output_relative`` (+ ``.srt``), report ``heartbeat(stage, progress_pm)``, stop and raise
# ``Cancelled`` when ``cancel`` is set.


def v3_worker(job: V3Job, **options) -> str | None:
    options.setdefault("heartbeat_interval", 0.05)
    options.setdefault("cancel_poll_seconds", 0.05)
    options.setdefault("renderer", lambda *_a, **_k: pytest.fail("legacy renderer used for v3"))
    return run_one(job.root, **options)


def v3_queued(tmp_path: Path, **create_options) -> tuple[V3Job, dict]:
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    return job, job.create(etag, **create_options)


def publishing(job: V3Job, data: bytes = b"rendered through the seam", **result):
    def render_request(_job_dir, request, *, heartbeat, cancel):
        heartbeat("merender", 500)
        heartbeat("memverifikasi", 1000)
        v3_publish(job, request, data)
        return SimpleNamespace(**result)

    return render_request


def test_v3_worker_renders_through_render_request_and_completes(tmp_path):
    job, request = v3_queued(tmp_path)
    calls = []

    def render_request(job_dir, seen, *, heartbeat, cancel):
        calls.append((job_dir, dict(seen), cancel))
        assert (seen["state"], seen["stage"]) == ("rendering", "merender")
        heartbeat("merender", 500)
        heartbeat("memverifikasi", 1000)
        v3_publish(job, seen, b"rendered through the seam")
        return SimpleNamespace(warnings=("peak_reduced:-3.80 dB",))

    assert v3_worker(job, renderer_v3=render_request) == request["render_id"]
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["stage"], final["progress_pm"], final["completed_by"]) == (
        "completed", "selesai", 1000, "render")
    assert final["warnings"] == ["peak_reduced:-3.80 dB"]
    assert final["attempts"] == 1 and final["lease_token"] is None
    job_dir, seen, cancel = calls[0]
    assert job_dir == job.job and isinstance(cancel, threading.Event) and not cancel.is_set()
    assert seen["render_id"] == request["render_id"]
    assert (job.job / request["output_relative"]).read_bytes() == b"rendered through the seam"
    assert v3_worker(job, renderer_v3=render_request) is None


def test_v3_worker_persists_progress_while_rendering(tmp_path):
    job, request = v3_queued(tmp_path)
    seen = []

    def render_request(_job_dir, current, *, heartbeat, cancel):
        heartbeat("merender", 250)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = get_request(job.job, request["render_id"])
            if value["progress_pm"] == 250:
                seen.append((value["state"], value["stage"], value["progress_pm"]))
                break
            time.sleep(0.02)
        v3_publish(job, current)

    v3_worker(job, renderer_v3=render_request)
    assert seen == [("rendering", "merender", 250)]
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_cancel_while_rendering_stops_ffmpeg_within_two_seconds(tmp_path):
    job, request = v3_queued(tmp_path)
    started = threading.Event()
    observed = {}

    def render_request(_job_dir, _request, *, heartbeat, cancel):
        heartbeat("merender", 10)
        started.set()
        while not cancel.wait(0.02):
            heartbeat("merender", 10)
        observed["stopped"] = time.monotonic()
        raise edit_errors.Cancelled()

    worker = threading.Thread(target=v3_worker, args=(job,),
                              kwargs={"renderer_v3": render_request, "cancel_poll_seconds": 0.5})
    worker.start()
    assert started.wait(5)
    requested = time.monotonic()
    cancel_request_v3(job.job, request["render_id"])
    worker.join(10)
    assert not worker.is_alive()
    assert observed["stopped"] - requested < 2.0
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("cancelled", "cancelled")
    assert final["cancelled_at"] is not None


def test_v3_liveness_kills_a_render_without_heartbeats(tmp_path):
    job, request = v3_queued(tmp_path)

    def render_request(_job_dir, _request, *, heartbeat, cancel):
        heartbeat("merender", 5)
        assert cancel.wait(10), "the worker must cancel a silent render"
        raise edit_errors.Cancelled()

    started = time.monotonic()
    v3_worker(job, renderer_v3=render_request, liveness_seconds=0.3)
    assert time.monotonic() - started < 5
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_stalled")


def test_v3_liveness_applies_while_rendering_not_while_verifying(tmp_path):
    job, request = v3_queued(tmp_path)

    def render_request(_job_dir, current, *, heartbeat, cancel):
        heartbeat("memverifikasi", 0)
        time.sleep(0.6)  # a long verification reports nothing
        assert not cancel.is_set()
        v3_publish(job, current)

    v3_worker(job, renderer_v3=render_request, liveness_seconds=0.2)
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_timeout_kills_a_render_that_keeps_running(tmp_path):
    job, request = v3_queued(tmp_path)

    def render_request(_job_dir, _request, *, heartbeat, cancel):
        progress = 0
        while not cancel.wait(0.02):
            progress = min(progress + 1, 999)
            heartbeat("merender", progress)
        raise edit_errors.Cancelled()

    v3_worker(job, renderer_v3=render_request, timeout_seconds=0.4, liveness_seconds=5)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_timeout")


def test_v3_the_timeout_is_the_request_scaled_timeout(tmp_path):
    _job, request = v3_queued(tmp_path)
    assert render_worker.v3_timeout_seconds(request) == request["timeout_ms"] / 1000
    assert render_worker.LIVENESS_SECONDS == 20


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (edit_errors.RenderFailed("render_failed"), "render_failed"),
        (edit_errors.RenderFailed("render_timeout"), "render_timeout"),
        (edit_errors.RenderFailed("render_stalled"), "render_stalled"),
        (edit_errors.VerificationFailed("verification_failed"), "verification_failed"),
        (edit_errors.Cancelled(), "render_failed"),  # nobody asked for it
        (RuntimeError("/data/jobs/secret path"), "render_failed"),
    ],
)
def test_v3_renderer_failures_map_to_fixed_codes(tmp_path, error, code):
    job, request = v3_queued(tmp_path)

    def render_request(*_args, **_kwargs):
        raise error

    v3_worker(job, renderer_v3=render_request)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", code)
    assert not (job.job / request["output_relative"]).exists()


def test_v3_a_render_that_publishes_nothing_fails(tmp_path):
    job, request = v3_queued(tmp_path)
    v3_worker(job, renderer_v3=lambda *_a, **_k: None)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_failed")


def test_v3_tampered_source_snapshot_fails_before_rendering(tmp_path):
    job, request = v3_queued(tmp_path)
    snapshot = job.job / request["source_snapshot_relative"]
    snapshot.unlink()
    snapshot.write_bytes(b"replaced after the request was created")
    rendered = []
    v3_worker(job, renderer_v3=lambda *_a, **_k: rendered.append(True))
    assert rendered == []
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_failed")


def test_v3_an_output_published_meanwhile_completes_without_rendering(tmp_path):
    job, request = v3_queued(tmp_path)
    v3_publish(job, request, b"published by an earlier request with the same key")
    rendered = []
    v3_worker(job, renderer_v3=lambda *_a, **_k: rendered.append(True))
    assert rendered == []
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["completed_by"]) == ("completed", "key")


def test_v3_storage_reservation_is_rechecked_and_released(tmp_path):
    reservation = {"reservation_id": RESERVATION_ID, "token": RESERVATION_TOKEN,
                   "reserved_bytes": 4096}
    job, request = v3_queued(tmp_path, storage_reservation=reservation)
    calls = []

    def storage_client(operation, reservation_id, token, terminal_state=None):
        calls.append((operation, reservation_id, token, terminal_state))
        return True

    v3_worker(job, renderer_v3=publishing(job), storage_client=storage_client,
              storage_recheck_interval_ms=10, storage_recheck_bytes=8 * 1024 * 1024)
    assert calls[0] == ("heartbeat", RESERVATION_ID, RESERVATION_TOKEN, None)
    assert calls[-1] == ("release", RESERVATION_ID, RESERVATION_TOKEN, "completed")
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_cancelled_render_releases_its_reservation_as_failed(tmp_path):
    reservation = {"reservation_id": RESERVATION_ID, "token": RESERVATION_TOKEN,
                   "reserved_bytes": 4096}
    job, request = v3_queued(tmp_path, storage_reservation=reservation)
    calls = []

    def render_request(_job_dir, _request, *, heartbeat, cancel):
        cancel_request_v3(job.job, request["render_id"])
        assert cancel.wait(5)
        raise edit_errors.Cancelled()

    def storage_client(operation, reservation_id, token, terminal_state=None):
        calls.append((operation, terminal_state))
        return True

    v3_worker(job, renderer_v3=render_request, storage_client=storage_client,
              storage_recheck_interval_ms=1000, storage_recheck_bytes=8 * 1024 * 1024)
    assert get_request(job.job, request["render_id"])["state"] == "cancelled"
    assert calls[-1] == ("release", "failed")


def test_v3_lost_storage_fails_closed_before_rendering(tmp_path):
    reservation = {"reservation_id": RESERVATION_ID, "token": RESERVATION_TOKEN,
                   "reserved_bytes": 4096}
    job, request = v3_queued(tmp_path, storage_reservation=reservation)
    rendered = []
    v3_worker(job, renderer_v3=lambda *_a, **_k: rendered.append(True),
              storage_client=lambda *_a, **_k: False, storage_recheck_interval_ms=1000,
              storage_recheck_bytes=8 * 1024 * 1024)
    assert rendered == []
    assert get_request(job.job, request["render_id"])["state"] == "failed"


def test_v3_lost_lease_is_left_to_the_new_owner(tmp_path):
    job, request = v3_queued(tmp_path)

    def render_request(_job_dir, current, *, heartbeat, cancel):
        v3_rewrite(job, request["render_id"], heartbeat_at="2020-01-01T00:00:00.000Z")
        replacement = claim_next(job.job, lease_seconds=1)
        assert replacement is not None
        v3_publish(job, current)

    v3_worker(job, renderer_v3=render_request, heartbeat_interval=60)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["attempts"]) == ("claimed", 2)  # the new owner decides


def test_mixed_queue_dispatches_legacy_and_v3_requests(tmp_path):
    v3, v3_request = v3_queued(tmp_path)
    legacy_job, _analysis, manifest, _source = fixture(v3.root)
    legacy = create_request(legacy_job, manifest.identity.candidate_id,
                            manifest_sha256(manifest), KEY)
    legacy_calls = []

    def renderer(src, manifest_path, output, candidate_path, **options):
        legacy_calls.append(output)
        output.write_bytes(b"legacy render")

    done = {run_one(v3.root, renderer=renderer, verifier=lambda *_args: None,
                    renderer_v3=publishing(v3), heartbeat_interval=0.05) for _ in range(2)}
    assert done == {legacy["render_id"], v3_request["render_id"]}
    assert len(legacy_calls) == 1
    assert get_request(legacy_job, legacy["render_id"])["state"] == "completed"
    assert get_request(v3.job, v3_request["render_id"])["completed_by"] == "render"


def test_v3_default_renderer_is_render_edit_render_request(tmp_path, monkeypatch):
    job, request = v3_queued(tmp_path)
    module = types.ModuleType("ai_clipper.edit_v2.render_edit")
    calls = []

    def render_request(job_dir, current, *, heartbeat, cancel):
        calls.append(current["render_id"])
        v3_publish(job, current)

    module.render_request = render_request
    monkeypatch.setitem(sys.modules, "ai_clipper.edit_v2.render_edit", module)
    v3_worker(job)
    assert calls == [request["render_id"]]
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_without_render_edit_the_request_fails_with_a_fixed_code(tmp_path, monkeypatch):
    job, request = v3_queued(tmp_path)
    monkeypatch.setitem(sys.modules, "ai_clipper.edit_v2.render_edit", None)
    v3_worker(job)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_failed")


# --- the seam with the real W1 compiler (FFmpeg + libass; synthetic 320x180 job) ---------------


def reference_render_request(resources: Resources):
    """What ``render_edit.render_request`` must do, built only from the W1 modules: the
    document of ``doc_relative`` → ``compile_job(final)`` → ``execute.run`` (timeout, progress,
    cancel) → ``verify_output`` → ``.srt`` and ``.mp4`` published by link, no-clobber."""

    def render_request(job_dir, request, *, heartbeat, cancel):
        clip = job_dir / "analysis" / "clips" / request["clip_id"]
        raw = (job_dir / request["doc_relative"]).read_bytes()
        if request["doc_relative"].endswith(".gz"):
            raw = gzip.decompress(raw)
        assert hashlib.sha256(raw).hexdigest() == request["doc_sha256"]
        document = json.loads(raw)
        words = edit_store.load_words(clip, document["base"]["words"]["sha256"])
        plan = build_plan(document, words=words, camera=None, assets={}, resources=resources)
        ffmpeg_job = compile_ffmpeg.compile_job(
            plan, mode="final", source=job_dir / request["source_snapshot_relative"],
            assets_root=job_dir / "analysis" / "assets")
        output = job_dir / request["output_relative"]
        temporary = output.with_name(f".{output.name}.{uuid.uuid4()}.tmp")
        fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            execute.run(ffmpeg_job, output_fd=fd, timeout_s=request["timeout_ms"] / 1000,
                        cancel=cancel, on_progress=lambda frames: heartbeat(
                            "merender", min(999, frames * 1000 // plan.total_frames)))
            heartbeat("memverifikasi", 0)
            verify.verify_output(fd, plan, size=plan.output, normalize=False)
            srt_temporary = output.with_name(f".{output.stem}.{uuid.uuid4()}.srt.tmp")
            srt_temporary.write_text(plan.srt(), encoding="utf-8")
            os.link(srt_temporary, output.with_suffix(".srt"))
            srt_temporary.unlink()
            os.link(temporary, output)
        finally:
            os.close(fd)
            temporary.unlink(missing_ok=True)
        return SimpleNamespace(warnings=(), completed_by="render")

    return render_request


def test_v3_real_compiler_r10_link_and_edited_export_through_the_worker(
        edit_v2_libass, tmp_path):
    out = tmp_path / "synthetic"
    make_job = _make_job_module()
    index = make_job.build(out, size=(320, 180), only=["main"])
    main = index["jobs"]["main"]
    jobs_root = out / "jobs"
    status, prepared = edit_api.handle(
        json.dumps({"op": "prepare_job", "jobId": main["id"]}).encode(), jobs_root=jobs_root)
    assert status == 0, prepared
    clip_entry = prepared["clips"][1]
    job_dir = out / main["dir"]
    clip = job_dir / "analysis" / "clips" / clip_entry["clipId"]
    seed_doc, seed_etag = edit_store.seed(clip)
    resources_dir = tmp_path / "resources"
    shutil.copytree(RESOURCES_DIR, resources_dir,
                    ignore=shutil.ignore_patterns("toolchain.json"))
    (resources_dir / "toolchain.json").write_text(json.dumps(V3_TOOLCHAIN, indent=2) + "\n")
    resources = Resources(resources_dir)
    renderer = reference_render_request(resources)

    # the auto render of this clip (what the pipeline publishes as output/clip-NN.mp4)
    rank = seed_doc["base"]["origin"]["rank_at_seed"]
    auto_request = {
        "clip_id": clip_entry["clipId"], "doc_relative": f"analysis/clips/{clip.name}/seed.json",
        "doc_sha256": seed_etag, "timeout_ms": 900_000,
        "source_snapshot_relative": os.path.relpath(out / main["source"], job_dir),
        "output_relative": f"output/clip-{rank:02d}.mp4"}
    (job_dir / "output").mkdir(exist_ok=True)
    renderer(job_dir, auto_request, heartbeat=lambda *_a: None, cancel=threading.Event())

    # R10: an unchanged export is the auto file itself, after G1–G2 of the real file
    unchanged = create_request_v3(job_dir, clip.name, seed_etag, str(uuid.uuid4()),
                                  resources=resources)
    assert unchanged["completed_by"] == "seed", unchanged
    assert os.path.samestat((job_dir / unchanged["output_relative"]).stat(),
                            (job_dir / "output" / f"clip-{rank:02d}.mp4").stat())

    # an edited revision renders through the worker and the seam
    current = next_doc(seed_doc, seed_etag, main__cut_fade_ms=20)
    _saved, etag, _warnings = edit_store.put(
        clip, expected_etag=seed_etag, idempotency_key=str(uuid.uuid4()),
        raw=canonical_bytes(current), now_ms=fixtures.PUT_NOW_MS)
    edited = create_request_v3(job_dir, clip.name, etag, str(uuid.uuid4()),
                               resources=resources)
    assert edited["state"] == "queued"
    progress = []

    def watched(job_path, request, *, heartbeat, cancel):
        def beat(stage, value):
            progress.append((stage, value))
            heartbeat(stage, value)
        return renderer(job_path, request, heartbeat=beat, cancel=cancel)

    assert run_one(jobs_root, renderer_v3=watched) == edited["render_id"]
    final = get_request(job_dir, edited["render_id"])
    assert (final["state"], final["completed_by"]) == ("completed", "render"), final
    assert any(stage == "merender" and value > 0 for stage, value in progress)
    output = job_dir / final["output_relative"]
    assert output.with_suffix(".srt").read_text().startswith("1\n")
    assert not os.path.samestat(output.stat(), (job_dir / "output" / f"clip-{rank:02d}.mp4").stat())
