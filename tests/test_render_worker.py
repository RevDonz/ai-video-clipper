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
    RESERVATION_ID,
    RESERVATION_TOKEN,
    V3_TOOLCHAIN,
    V3Job,
    retired_request,
    v3_publish,
    v3_rewrite,
)

from ai_clipper import render_queue as render_queue_module
from ai_clipper import render_worker
from ai_clipper.edit_v2 import api as edit_api
from ai_clipper.edit_v2 import compile_ffmpeg, execute, verify
from ai_clipper.edit_v2 import errors as edit_errors
from ai_clipper.edit_v2 import store as edit_store
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources, build_plan
from ai_clipper.render_queue import (
    cancel_request_v3,
    claim_next,
    create_request_v3,
    get_request,
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


def test_v3_the_backstops_start_with_the_render_not_with_the_snapshot_check(tmp_path,
                                                                          monkeypatch):
    """Hashing a large source snapshot (seconds under load) is not a stalled render."""
    job, request = v3_queued(tmp_path)
    original = render_worker._verify_snapshot

    def slow_verify(job_dir, current):
        time.sleep(0.6)
        original(job_dir, current)

    def render_request(job_dir, current, *, heartbeat, cancel):
        if cancel.is_set():  # a real render stops at once
            raise edit_errors.Cancelled()
        heartbeat("merender", 500)
        v3_publish(job, current)

    monkeypatch.setattr(render_worker, "_verify_snapshot", slow_verify)
    v3_worker(job, renderer_v3=render_request, liveness_seconds=0.2, timeout_seconds=0.4)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("completed", None)


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


def test_the_worker_leaves_retired_candidate_requests_alone(tmp_path):
    job, request = v3_queued(tmp_path)
    in_queue = retired_request(job)  # an export of the retired editor, still queued
    old_queue = job.root / str(uuid.uuid4()) / "analysis" / "render-requests"
    old_queue.mkdir(parents=True)  # another job edited in the retired editor
    (old_queue.parents[1] / "job.json").write_text('{"status":"completed"}')
    stale = retired_request(
        SimpleNamespace(queue=old_queue, request_path=lambda rid: old_queue / f"{rid}.json"),
        version="render-request-v1", state="claimed", at="2020-01-01T00:00:00.000Z")
    files = [job.request_path(in_queue["render_id"]), old_queue / f"{stale['render_id']}.json"]
    before = [path.read_bytes() for path in files]
    rendered = []

    def render_request(job_dir, current, *, heartbeat, cancel):
        rendered.append(current["render_id"])
        v3_publish(job, current)

    assert v3_worker(job, renderer_v3=render_request, lease_seconds=1) == request["render_id"]
    assert v3_worker(job, renderer_v3=render_request, lease_seconds=1) is None
    assert rendered == [request["render_id"]]
    assert [path.read_bytes() for path in files] == before


def test_v3_worker_skips_old_jobs_and_directories_that_are_not_jobs(tmp_path):
    job, request = v3_queued(tmp_path)
    not_a_job = job.root / "000-not-a-job"
    not_a_job.mkdir()
    (not_a_job / "job.json").write_text('{"status":"completed"}')
    old = job.root / str(uuid.uuid4())  # made before the editor: no analysis/ at all
    (old / "output").mkdir(parents=True)
    (old / "job.json").write_text('{"status":"completed"}')
    assert v3_worker(job, renderer_v3=publishing(job)) == request["render_id"]
    assert v3_worker(job, renderer_v3=publishing(job)) is None
    assert sorted(path.name for path in old.iterdir()) == ["job.json", "output"]


def test_v3_worker_writes_nothing_into_a_job_that_was_never_exported(tmp_path):
    """A job with analysis/ but no export has no queue: the worker's scan must not create one
    (render-requests/ and its .queue.lock) in every old job it walks past."""
    job, request = v3_queued(tmp_path)
    untouched = job.root / str(uuid.uuid4())
    (untouched / "analysis").mkdir(parents=True)
    (untouched / "job.json").write_text('{"status":"completed"}')
    assert v3_worker(job, renderer_v3=publishing(job)) == request["render_id"]
    assert v3_worker(job, renderer_v3=publishing(job)) is None
    assert sorted(path.name for path in (untouched / "analysis").iterdir()) == []


def test_v3_worker_heartbeats_during_a_long_render_and_prevents_reclaim(tmp_path, monkeypatch):
    # One fake clock drives the queue's timestamps and the monitor's heartbeat timer: the worker
    # can beat only when the test moves that clock, and the test waits for the beat itself, so
    # the outcome never depends on machine load (wall-clock versions failed on busy CI runners).
    clock = {
        "now": render_queue_module.datetime(2026, 10, 1, 12, 0, tzinfo=render_queue_module.UTC),
        "monotonic": 1_000.0,
    }

    class QueueClock(render_queue_module.datetime):
        @classmethod
        def now(cls, tz=None):
            return clock["now"]

    watching = threading.Event()

    class FakeClockMonitor(render_worker._V3Monitor):
        def __init__(self, **options):
            super().__init__(**options, clock=lambda: clock["monotonic"])

        def run(self, stop):
            # The monitor's first read of the clock is its lease timer's start: the test moves
            # the clock only after it, so the beat below cannot be missed.
            monitor_thread = threading.get_ident()
            fake = self.clock

            def seen_clock():
                if threading.get_ident() == monitor_thread:
                    watching.set()
                return fake()

            self.clock = seen_clock
            super().run(stop)

    monkeypatch.setattr(render_queue_module, "datetime", QueueClock)
    monkeypatch.setattr(render_worker, "_V3Monitor", FakeClockMonitor)
    beats: list[str] = []
    beat = threading.Event()
    queue_heartbeat = render_worker.heartbeat

    def recorded_heartbeat(job_dir, render_id, token):
        result = queue_heartbeat(job_dir, render_id, token)
        beats.append(result["heartbeat_at"])
        beat.set()
        return result

    monkeypatch.setattr(render_worker, "heartbeat", recorded_heartbeat)
    job, request = v3_queued(tmp_path)
    rendering = threading.Event()
    release = threading.Event()

    def render_request(_job_dir, current, *, heartbeat, cancel):
        rendering.set()
        assert release.wait(30)
        v3_publish(job, current, b"long verified render")

    worker = threading.Thread(target=v3_worker, args=(job,), kwargs={
        "renderer_v3": render_request, "lease_seconds": 1, "heartbeat_interval": 0.25})
    worker.start()
    assert rendering.wait(30)
    assert watching.wait(30)
    claimed_at = get_request(job.job, request["render_id"])["heartbeat_at"]
    assert beats == [], "no heartbeat while the clock stands still"
    # The render outlives its lease by ten lease lengths at once (under the 20 s liveness and
    # the request's timeout): the queue's time moves first, so the beat the monitor's timer then
    # triggers carries the new time.
    clock["now"] += render_queue_module.timedelta(seconds=10)
    clock["monotonic"] += 10.0
    later = clock["now"].isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert beat.wait(30), "the worker heartbeats while it renders"
    assert claimed_at != later
    assert beats[0] == later
    assert get_request(job.job, request["render_id"])["heartbeat_at"] == later
    assert claim_next(job.job, lease_seconds=1) is None
    release.set()
    worker.join(30)
    assert not worker.is_alive()
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["attempts"]) == ("completed", 1)
    assert (job.job / request["output_relative"]).read_bytes() == b"long verified render"


def storage_queued(tmp_path):
    reservation = {"reservation_id": RESERVATION_ID, "token": RESERVATION_TOKEN,
                   "reserved_bytes": 4096}
    return v3_queued(tmp_path, storage_reservation=reservation)


def test_v3_storage_lost_during_the_render_never_completes_the_request(tmp_path):
    job, request = storage_queued(tmp_path)
    lost = threading.Event()
    calls = []

    def storage_client(operation, *_args, terminal_state=None):
        calls.append((operation, terminal_state))
        if operation == "heartbeat" and len(calls) > 1:  # the first recheck finds it gone
            lost.set()
            return False
        return True

    def render_request(_job_dir, current, *, heartbeat, cancel):
        assert lost.wait(5) and cancel.wait(5), "a lost reservation stops the render"
        v3_publish(job, current, b"published after the reservation was lost")

    v3_worker(job, renderer_v3=render_request, storage_client=storage_client,
              storage_recheck_interval_ms=10, storage_recheck_bytes=8 * 1024 * 1024)
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "render_failed")
    assert calls[-1] == ("release", "failed")


def test_v3_storage_time_cadence_is_independent_of_the_queue_heartbeat(tmp_path):
    job, request = storage_queued(tmp_path)
    checked = threading.Event()
    beats = []

    def storage_client(operation, *_args, terminal_state=None):
        if operation == "heartbeat":
            beats.append(time.monotonic())
            if len(beats) >= 2:
                checked.set()
        return True

    def render_request(_job_dir, current, *, heartbeat, cancel):
        heartbeat("merender", 10)
        assert checked.wait(5)
        v3_publish(job, current)

    v3_worker(job, renderer_v3=render_request, storage_client=storage_client,
              heartbeat_interval=10, storage_recheck_interval_ms=10,
              storage_recheck_bytes=1 << 30)
    assert len(beats) >= 3  # before the render, during it, and after it
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_storage_byte_growth_triggers_a_recheck_while_the_renderer_blocks(tmp_path):
    job, request = storage_queued(tmp_path)
    checked = threading.Event()
    beats = []

    def storage_client(operation, *_args, terminal_state=None):
        if operation == "heartbeat":
            beats.append(operation)
            if len(beats) >= 2:
                checked.set()
        return True

    def render_request(_job_dir, current, *, heartbeat, cancel):
        heartbeat("merender", 10)
        partial = (job.job / current["output_relative"]).with_name(".growing.tmp")
        partial.write_bytes(b"growing output")
        assert checked.wait(5)
        partial.unlink()
        v3_publish(job, current)

    v3_worker(job, renderer_v3=render_request, storage_client=storage_client,
              heartbeat_interval=10, storage_recheck_interval_ms=60_000,
              storage_recheck_bytes=1)
    assert len(beats) >= 3
    assert get_request(job.job, request["render_id"])["state"] == "completed"


def test_v3_release_transport_failure_does_not_undo_the_terminal_state(tmp_path):
    job, request = storage_queued(tmp_path)

    def storage_client(operation, *_args, terminal_state=None):
        if operation == "release":
            raise OSError("transport failed")
        return True

    assert v3_worker(job, renderer_v3=publishing(job), storage_client=storage_client,
                     storage_recheck_interval_ms=1000,
                     storage_recheck_bytes=8 * 1024 * 1024) == request["render_id"]
    assert get_request(job.job, request["render_id"])["state"] == "completed"


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
