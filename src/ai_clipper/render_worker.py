"""Explicit restart-safe one-shot worker for durable clip exports (``render-request-v3``).

A claimed request goes to ``renderer_v3``, by default
``edit_v2.render_edit.render_request(job_dir, request, *, heartbeat, cancel)`` (T2.1; imported
when first used). Around that call the worker owns:

* the lease (heartbeats), the storage reservation (rechecks, release at the end) and the
  stage/progress the renderer reports through ``heartbeat(stage, progress_pm)``, persisted at
  most every ``PROGRESS_WRITE_SECONDS``;
* cancellation: the DELETE route sets ``cancel_requested_at``; the worker polls it every
  ``cancel_poll_seconds`` (0.5 s) and sets ``cancel``, which ``execute.run`` turns into a kill
  of FFmpeg's process group within 50 ms (plan §4.2: within 2 s);
* the backstops (plan §4.6, D9): the request's scaled ``timeout_ms`` and liveness — while the
  stage is ``merender`` the renderer must call ``heartbeat`` at least every
  ``LIVENESS_SECONDS`` (20 s); either one sets ``cancel`` and ends the request as
  ``render_timeout`` / ``render_stalled``;
* the fixed failure codes (``render_failed``, ``render_timeout``, ``render_stalled``,
  ``verification_failed``, ``cancelled``) and the fenced completion: the renderer must have
  published ``output_relative`` and its ``.srt``.

Requests of the retired candidate editor left in old queues are never claimed (``render_queue``).
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import math
import os
import re
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path

from .edit_v2 import errors as edit_errors
from .render_queue import (
    QueueConflict,
    QueueError,
    claim_next,
    complete_v3,
    fail_v3,
    get_request,
    heartbeat,
    progress_v3,
    srt_relative,
    start_rendering_v3,
)

_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)


class WorkerError(Exception):
    """A directory or a source snapshot the worker must not use."""


def parse_storage_recheck_config(
    env: dict[str, str] | os._Environ[str] = os.environ,
) -> tuple[float, int]:
    """Parse the worker side of the shared strict storage cadence contract."""
    try:
        interval_raw = env["JOBS_STORAGE_RECHECK_INTERVAL_MS"]
        bytes_raw = env["JOBS_STORAGE_RECHECK_BYTES"]
        if not re.fullmatch(r"[1-9][0-9]*", interval_raw) or not re.fullmatch(
            r"[1-9][0-9]*", bytes_raw
        ):
            raise ValueError
        interval_ms = int(interval_raw)
        recheck_bytes = int(bytes_raw)
        if interval_ms > 300_000 or not 8 * 1024 * 1024 <= recheck_bytes <= 16 * 1024 * 1024:
            raise ValueError
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("invalid render storage recheck configuration") from error
    return interval_ms / 1000, recheck_bytes


def render_storage_operation(
    operation: str, reservation_id: str, token: str, terminal_state: str | None = None
) -> bool:
    cli = os.environ.get("RENDER_STORAGE_CLI", "/app/scripts/render-storage-admission.mjs")
    command = {"operation": operation, "reservationId": reservation_id, "token": token}
    if terminal_state is not None:
        command["terminalState"] = terminal_state
    try:
        result = subprocess.run(
            [os.environ.get("NODE_BIN", "node"), cli],
            input=json.dumps(command, separators=(",", ":")).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60,
            shell=False,
        )
        return result.returncode == 0 and result.stdout == b'{"ok":true}\n'
    except (OSError, subprocess.SubprocessError):
        return False


def _regular_directory(path: Path) -> None:
    info = path.lstat()
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or path.resolve() != path.absolute()
    ):
        raise WorkerError("worker directory is invalid")


def _job_directories(root: Path):
    _regular_directory(root)
    for entry in sorted(os.scandir(root), key=lambda item: item.name):
        if not _UUID.fullmatch(entry.name):
            continue
        try:
            if stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode):
                yield Path(entry.path)
        except OSError:
            continue


def run_one(
    jobs_root: Path,
    *,
    lease_seconds: float = 300,
    heartbeat_interval: float | None = None,
    storage_client: Callable[..., bool] = render_storage_operation,
    storage_recheck_interval_ms: int | None = None,
    storage_recheck_bytes: int | None = None,
    renderer_v3: Callable | None = None,
    liveness_seconds: float | None = None,
    cancel_poll_seconds: float | None = None,
    timeout_seconds: float | None = None,
) -> str | None:
    """Claim and finish at most one export across all jobs (``timeout_seconds`` defaults to the
    request's ``timeout_ms``)."""
    root = Path(jobs_root).absolute()
    for job in _job_directories(root):
        analysis = job / "analysis"
        try:
            analysis_info = analysis.lstat()
        except FileNotFoundError:
            continue  # jobs made before the analysis artifacts have nothing to export
        if stat.S_ISLNK(analysis_info.st_mode) or not stat.S_ISDIR(analysis_info.st_mode):
            continue
        # No queue yet means no export was ever requested; claim_next would create one (and
        # its lock file) in every old job the scan walks past.
        if not os.path.lexists(analysis / "render-requests"):
            continue
        try:
            request = claim_next(job, lease_seconds=lease_seconds)
        except QueueError:
            continue
        if request is None:
            continue
        return _run_v3(
            job,
            request,
            renderer=renderer_v3 or _render_request_v3,
            lease_seconds=lease_seconds,
            heartbeat_interval=heartbeat_interval,
            storage_client=storage_client,
            storage_recheck_interval_ms=storage_recheck_interval_ms,
            storage_recheck_bytes=storage_recheck_bytes,
            liveness_seconds=LIVENESS_SECONDS if liveness_seconds is None else liveness_seconds,
            cancel_poll_seconds=CANCEL_POLL_SECONDS
            if cancel_poll_seconds is None
            else cancel_poll_seconds,
            timeout_seconds=timeout_seconds,
        )
    return None


# --- render-request-v3 (Editor V3 exports; plan §4.6) --------------------------------------------

LIVENESS_SECONDS = 20.0  # plan §4.6: progress must advance within 20 s
CANCEL_POLL_SECONDS = 0.5  # DELETE → cancel event; FFmpeg dies ≤ 50 ms later (execute.run)
PROGRESS_WRITE_SECONDS = 0.5  # the request file is rewritten at most this often for progress
_MONITOR_TICK_SECONDS = 0.02


def v3_timeout_seconds(request: Mapping[str, object]) -> float:
    """The request's scaled timeout, ``max(120 s, 3 × predicted)`` computed at creation."""
    return int(request["timeout_ms"]) / 1000  # type: ignore[call-overload]


def _render_request_v3(job_dir: Path, request: Mapping[str, object], *,
                       heartbeat: Callable[[str, int], None], cancel: threading.Event):
    """T2.1's ``edit_v2.render_edit.render_request`` (Appendix A), imported when first used so
    the queue keeps working (with ``render_failed``) where the module is absent."""
    try:
        render_edit = importlib.import_module("ai_clipper.edit_v2.render_edit")
    except ImportError as error:
        raise edit_errors.RenderFailed("render_failed") from error
    return render_edit.render_request(job_dir, request, heartbeat=heartbeat, cancel=cancel)


def _result_warnings(result: object) -> list[str]:
    """Warning codes a renderer reports (``RenderResult.warnings``: codes or ``doc.Issue``)."""
    warnings = getattr(result, "warnings", ()) or ()
    codes = []
    for item in warnings if isinstance(warnings, Iterable) else ():
        code = getattr(item, "code", item)
        if isinstance(code, str) and code not in codes:
            codes.append(code)
    return codes


_REUSED_COMPLETION = {"auto_file": "seed", "existing": "key"}


def _completed_by(result: object) -> str:
    """How the renderer finished: ``completed_by`` when it names one, else from T2.1's
    ``RenderResult.reused`` (``auto_file`` = R10 by the seed, ``existing`` = the render key)."""
    completed_by = getattr(result, "completed_by", None)
    if completed_by in {"render", "seed", "key"}:
        return completed_by
    return _REUSED_COMPLETION.get(getattr(result, "reused", None), "render")


def _failure_code(error: BaseException, reason: str | None) -> str:
    if reason in {"cancelled", "render_timeout", "render_stalled"}:
        return reason
    if isinstance(error, edit_errors.VerificationFailed):
        return "verification_failed"
    if isinstance(error, edit_errors.RenderFailed) and error.code in {
        "render_failed", "render_timeout", "render_stalled"
    }:
        return error.code
    return "render_failed"


def _directory_bytes(directory: Path) -> int:
    total = 0
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return 0
    for entry in entries:
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode):
            total += max(info.st_size, info.st_blocks * 512)
    return total


class _V3Monitor:
    """The thread around one v3 render: lease and progress heartbeats, cancel polling, the
    timeout and liveness backstops and the storage rechecks. ``beat`` is the renderer's
    ``heartbeat(stage, progress_pm)``; it is thread-safe and never raises."""

    def __init__(self, *, job: Path, request: Mapping[str, object], token: str,
                 lease_interval: float, timeout_s: float, liveness_s: float,
                 cancel_poll_s: float, storage_client: Callable[..., bool],
                 storage_reservation: tuple[str, str] | None, storage_interval: float,
                 storage_recheck_bytes: int, clock: Callable[[], float] = time.monotonic):
        self.job = job
        self.render_id = str(request["render_id"])
        self.token = token
        self.lease_interval = lease_interval
        self.timeout_s = timeout_s
        self.liveness_s = liveness_s
        self.cancel_poll_s = cancel_poll_s
        self.storage_client = storage_client
        self.storage_reservation = storage_reservation
        self.storage_interval = storage_interval
        self.storage_recheck_bytes = storage_recheck_bytes
        self.growth_dir = job / str(request["output_relative"]).rsplit("/", 1)[0]
        self.clock = clock
        self.cancel = threading.Event()
        self.lost = threading.Event()
        self.reason: str | None = None
        self._lock = threading.Lock()
        self._stage, self._progress = "merender", 0
        self._beat_at = self._started = clock()
        self._armed = False  # the timeout and liveness count from the renderer's start

    def beat(self, stage: str, progress_pm: int) -> None:
        with self._lock:
            self._beat_at = self.clock()
            if stage in {"merender", "memverifikasi"} and type(progress_pm) is int \
                    and 0 <= progress_pm <= 1000:
                self._stage, self._progress = stage, progress_pm

    def arm(self) -> None:
        """Start the timeout and liveness clocks (just before the renderer is called)."""
        with self._lock:
            self._beat_at = self._started = self.clock()
            self._armed = True

    def _stop(self, reason: str) -> None:
        if self.reason is None:
            self.reason = reason
        self.cancel.set()

    def run(self, stop: threading.Event) -> None:
        now = self.clock()
        last_lease = last_write = last_poll = last_storage = now
        written = ("merender", 0)
        last_bytes = 0
        while not stop.wait(_MONITOR_TICK_SECONDS):
            try:
                now = self.clock()
                with self._lock:
                    current, beat_at, started = (self._stage, self._progress), self._beat_at, \
                        self._started
                    armed = self._armed
                seen = None
                if current != written and now - last_write >= PROGRESS_WRITE_SECONDS:
                    seen = progress_v3(self.job, self.render_id, self.token, *current)
                    written, last_write, last_lease = current, now, now
                elif now - last_lease >= self.lease_interval:
                    seen = heartbeat(self.job, self.render_id, self.token)
                    last_lease = now
                if now - last_poll >= self.cancel_poll_s:
                    seen = seen or get_request(self.job, self.render_id)
                    last_poll = now
                    if seen.get("lease_token") != self.token:
                        raise QueueConflict()
                    if seen["cancel_requested_at"] is not None:
                        self._stop("cancelled")
                if armed and now - started > self.timeout_s:
                    self._stop("render_timeout")
                elif armed and current[0] == "merender" and now - beat_at > self.liveness_s:
                    self._stop("render_stalled")
                if self.storage_reservation is not None:
                    grown = _directory_bytes(self.growth_dir)
                    if (now - last_storage >= self.storage_interval
                            or grown - last_bytes >= self.storage_recheck_bytes):
                        if not self.storage_client("heartbeat", *self.storage_reservation):
                            raise QueueError()
                        last_storage, last_bytes = now, grown
            except Exception:  # noqa: BLE001 - lease or storage lost: stop the render, fail closed
                self.lost.set()
                self.cancel.set()
                return


def _verify_snapshot(job: Path, request: Mapping[str, object]) -> None:
    """The source snapshot still has the content the request bound (plan §4.6)."""
    relative = request["source_snapshot_relative"]
    expected = request["source_content_sha256"]
    if not isinstance(relative, str) or not isinstance(expected, str):
        raise WorkerError("request source binding mismatch")
    path = job / relative
    if path.parent != job / "analysis" / "render-inputs":
        raise WorkerError("request source binding mismatch")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as error:
        raise WorkerError("source snapshot is invalid") from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise WorkerError("source snapshot is invalid")
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024 * 1024):
            digest.update(chunk)
    finally:
        os.close(fd)
    if digest.hexdigest() != expected:
        raise WorkerError("source snapshot digest mismatch")


def _published_v3(job: Path, request: Mapping[str, object]) -> bool:
    output = str(request["output_relative"])
    for relative in (output, srt_relative(output)):
        try:
            info = (job / relative).lstat()
        except (FileNotFoundError, NotADirectoryError):
            return False
        if not stat.S_ISREG(info.st_mode):
            return False
    return True


def _run_v3(
    job: Path,
    request: dict[str, object],
    *,
    renderer: Callable,
    lease_seconds: float,
    heartbeat_interval: float | None,
    storage_client: Callable[..., bool],
    storage_recheck_interval_ms: int | None,
    storage_recheck_bytes: int | None,
    liveness_seconds: float,
    cancel_poll_seconds: float,
    timeout_seconds: float | None,
) -> str:
    render_id = str(request["render_id"])
    token = str(request["lease_token"])
    reservation = None
    if request["storage_reservation_id"] is not None:
        reservation = (str(request["storage_reservation_id"]),
                       str(request["storage_reservation_token"]))
    storage_interval, recheck_bytes = 1.0, 1
    if reservation is not None:
        if storage_recheck_interval_ms is None or storage_recheck_bytes is None:
            storage_interval, recheck_bytes = parse_storage_recheck_config()
        else:
            storage_interval, recheck_bytes = (storage_recheck_interval_ms / 1000,
                                               storage_recheck_bytes)
    monitor = _V3Monitor(
        job=job, request=request, token=token,
        lease_interval=min(lease_seconds / 4, 30.0) if heartbeat_interval is None
        else heartbeat_interval,
        timeout_s=v3_timeout_seconds(request) if timeout_seconds is None else timeout_seconds,
        liveness_s=liveness_seconds, cancel_poll_s=cancel_poll_seconds,
        storage_client=storage_client, storage_reservation=reservation,
        storage_interval=storage_interval, storage_recheck_bytes=recheck_bytes)
    stop = threading.Event()
    thread: threading.Thread | None = None
    terminal_state: str | None = None
    try:
        if reservation is not None and not storage_client("heartbeat", *reservation):
            raise QueueError()
        request = start_rendering_v3(job, render_id, token)
        thread = threading.Thread(target=monitor.run, args=(stop,), daemon=True)
        thread.start()
        if _published_v3(job, request):  # an export of the same key was published meanwhile
            complete_v3(job, render_id, token, completed_by="key")
            terminal_state = "completed"
            return render_id
        _verify_snapshot(job, request)
        monitor.arm()
        result = renderer(job, dict(request), heartbeat=monitor.beat, cancel=monitor.cancel)
        if monitor.lost.is_set():
            raise QueueError()
        if reservation is not None and not storage_client("heartbeat", *reservation):
            raise QueueError()
        complete_v3(job, render_id, token, completed_by=_completed_by(result),
                    warnings=_result_warnings(result))
        terminal_state = "completed"
    except Exception as error:  # noqa: BLE001 - the request records a fixed code only
        code = _failure_code(error, monitor.reason)
        try:
            fail_v3(job, render_id, token, code)
            terminal_state = "failed"
        except QueueError:
            pass  # the lease was lost: the new owner decides
    finally:
        stop.set()
        if thread is not None:
            thread.join()
        if terminal_state is not None and reservation is not None:
            try:
                storage_client("release", *reservation, terminal_state=terminal_state)
            except Exception:  # noqa: BLE001, S110 - terminal state is authoritative
                pass
    return render_id


def run_forever(
    jobs_root: Path,
    *,
    lease_seconds: float = 300,
    poll_seconds: float = 2,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Continuously drain durable render requests without busy-spinning."""
    if not math.isfinite(poll_seconds) or poll_seconds < 0.1 or poll_seconds > 60:
        raise ValueError("poll_seconds must be between 0.1 and 60")
    while True:
        render_id = run_one(jobs_root, lease_seconds=lease_seconds)
        if render_id is None:
            sleep(poll_seconds)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs-root", default=os.environ.get("JOBS_ROOT", "/data/jobs"))
    parser.add_argument("--lease-seconds", type=float, default=300)
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--poll-seconds", type=float, default=2)
    args = parser.parse_args(argv)
    try:
        if args.watch:
            run_forever(
                Path(args.jobs_root),
                lease_seconds=args.lease_seconds,
                poll_seconds=args.poll_seconds,
            )
            return 0
        render_id = run_one(Path(args.jobs_root), lease_seconds=args.lease_seconds)
        if render_id:
            print(render_id)
        return 0
    except Exception:  # noqa: BLE001 - executable boundary does not leak details
        print("render_worker_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
