"""Explicit restart-safe one-shot worker for durable render requests."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .render_manifest import (
    ManifestRenderError,
    _load_bound_manifest,
    _probe_media,
    _verify_output,
    render_from_manifest,
)
from .render_queue import (
    QueueError,
    claim_next,
    heartbeat,
    publish_completed_output,
    update_request,
)

_UUID = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z",
    re.IGNORECASE,
)


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
        raise ManifestRenderError("worker directory is invalid")


def _output_parent(job: Path, candidate_id: str) -> Path:
    output = job / "output"
    if not output.exists():
        output.mkdir(mode=0o700)
    _regular_directory(output)
    edits = output / "edits"
    if not edits.exists():
        edits.mkdir(mode=0o700)
    _regular_directory(edits)
    candidate = edits / candidate_id
    if not candidate.exists():
        candidate.mkdir(mode=0o700)
    _regular_directory(candidate)
    return candidate


def _verify_existing(
    job: Path,
    request: dict[str, object],
    source: Path,
    output: Path | None = None,
    timeout: float = 120.0,
) -> None:
    candidate_path = job / str(request["candidate_snapshot_relative"])
    manifest_path = job / str(request["edit_manifest_relative"])
    manifest = _load_bound_manifest(manifest_path, candidate_path)
    if (
        manifest.identity.candidate_artifact_sha256 != request["candidate_artifact_sha256"]
        or manifest.identity.source_sha256 != request["source_identity_sha256"]
    ):
        raise ManifestRenderError("request identity binding mismatch")

    source_relative = request["source_snapshot_relative"]
    expected_digest = request["source_content_sha256"]
    if (
        not isinstance(source_relative, str)
        or not isinstance(expected_digest, str)
        or re.fullmatch(
            rf"analysis/render-inputs/source\.{re.escape(expected_digest)}\.[a-z0-9]{{1,10}}",
            source_relative,
        )
        is None
        or source.absolute() != (job / source_relative).absolute()
        or source.parent != job / "analysis" / "render-inputs"
    ):
        raise ManifestRenderError("request source binding mismatch")

    source_fd: int | None = None
    try:
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        if not stat.S_ISREG(os.fstat(source_fd).st_mode):
            raise ManifestRenderError("source snapshot is invalid")
        digest = hashlib.sha256()
        while chunk := os.read(source_fd, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != expected_digest:
            raise ManifestRenderError("source snapshot digest mismatch")
        os.lseek(source_fd, 0, os.SEEK_SET)
        source_meta = _probe_media(
            f"/proc/self/fd/{source_fd}", timeout=timeout, pass_fds=(source_fd,)
        )
    except OSError as error:
        raise ManifestRenderError("source snapshot is invalid") from error
    finally:
        if source_fd is not None:
            os.close(source_fd)

    output_meta = _probe_media(
        job / str(request["output_relative"]) if output is None else output, timeout=timeout
    )
    _verify_output(
        output_meta, manifest.timeline.end - manifest.timeline.start, bool(source_meta["has_audio"])
    )


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


def _heartbeat_loop(
    stop: threading.Event,
    lost: threading.Event,
    interval: float,
    job: Path,
    render_id: str,
    token: str,
    storage_client: Callable[..., bool],
    storage_reservation: tuple[str, str] | None,
    storage_interval: float,
    storage_recheck_bytes: int,
    growth_path: Callable[[], Path | None],
) -> None:
    last_queue = last_storage = time.monotonic()
    last_bytes = 0
    poll = min(interval, storage_interval, 0.05)
    while not stop.wait(poll):
        try:
            now = time.monotonic()
            if now - last_queue >= interval:
                heartbeat(job, render_id, token)
                last_queue = now
            if storage_reservation is not None:
                target = growth_path()
                current_bytes = 0
                if target is not None:
                    try:
                        info = target.stat(follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            raise OSError
                        current_bytes = max(info.st_size, info.st_blocks * 512)
                    except FileNotFoundError:
                        current_bytes = 0
                if (
                    now - last_storage >= storage_interval
                    or current_bytes - last_bytes >= storage_recheck_bytes
                ):
                    if not storage_client("heartbeat", *storage_reservation):
                        lost.set()
                        return
                    last_storage = now
                    last_bytes = current_bytes
        except Exception:  # noqa: BLE001 - heartbeat boundary fails closed
            lost.set()
            return


def _storage_reservation(request: dict[str, object]) -> tuple[str, str] | None:
    if request.get("version") != "render-request-v2":
        return None
    return (
        str(request["storage_reservation_id"]),
        str(request["storage_reservation_token"]),
    )


def _growth_path(reference: list[Path | None]) -> Path | None:
    return reference[0]


def run_one(
    jobs_root: Path,
    *,
    renderer: Callable = render_from_manifest,
    verifier: Callable = _verify_existing,
    lease_seconds: float = 300,
    heartbeat_interval: float | None = None,
    storage_client: Callable[..., bool] = render_storage_operation,
    storage_recheck_interval_ms: int | None = None,
    storage_recheck_bytes: int | None = None,
) -> str | None:
    """Claim and finish at most one request across all jobs."""
    root = Path(jobs_root).absolute()
    for job in _job_directories(root):
        analysis = job / "analysis"
        try:
            analysis_info = analysis.lstat()
        except FileNotFoundError:
            # Legacy V1 jobs predate editor/render analysis artifacts.
            continue
        if stat.S_ISLNK(analysis_info.st_mode) or not stat.S_ISDIR(analysis_info.st_mode):
            continue
        try:
            request = claim_next(job, lease_seconds=lease_seconds)
        except QueueError:
            continue
        if request is None:
            continue
        render_id = str(request["render_id"])
        token = str(request["lease_token"])
        stop = threading.Event()
        lost = threading.Event()
        interval = (
            min(lease_seconds / 4, 30.0) if heartbeat_interval is None else heartbeat_interval
        )

        thread: threading.Thread | None = None
        staging: Path | None = None
        terminal_state: str | None = None
        storage_reservation = _storage_reservation(request)
        storage_interval = 1.0
        if storage_reservation is not None:
            if storage_recheck_interval_ms is None or storage_recheck_bytes is None:
                storage_interval, storage_recheck_bytes = parse_storage_recheck_config()
            else:
                if (
                    not isinstance(storage_recheck_interval_ms, int)
                    or isinstance(storage_recheck_interval_ms, bool)
                    or storage_recheck_interval_ms < 1
                    or not isinstance(storage_recheck_bytes, int)
                    or isinstance(storage_recheck_bytes, bool)
                    or storage_recheck_bytes < 1
                ):
                    raise ValueError("invalid render storage recheck configuration")
                storage_interval = storage_recheck_interval_ms / 1000
        staging_ref: list[Path | None] = [None]

        try:
            if storage_reservation is not None and not storage_client(
                "heartbeat", *storage_reservation
            ):
                raise QueueError()
            request = update_request(job, render_id, "rendering", lease_token=token)
            thread = threading.Thread(
                target=_heartbeat_loop,
                args=(
                    stop,
                    lost,
                    interval,
                    job,
                    render_id,
                    token,
                    storage_client,
                    storage_reservation,
                    storage_interval,
                    storage_recheck_bytes or 1,
                    lambda reference=staging_ref: _growth_path(reference),
                ),
                daemon=True,
            )
            thread.start()
            source = job / str(request["source_snapshot_relative"])
            parent = _output_parent(job, str(request["candidate_id"]))
            output = job / str(request["output_relative"])
            if output.parent != parent:
                raise ManifestRenderError("request output binding mismatch")
            if output.exists():
                info = output.lstat()
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                    raise ManifestRenderError("existing output is invalid")
                verifier(job, request, source)
                heartbeat(job, render_id, token)
                if storage_reservation is not None and not storage_client(
                    "heartbeat", *storage_reservation
                ):
                    raise QueueError()
                if lost.is_set():
                    raise QueueError()
                update_request(job, render_id, "completed", lease_token=token)
                terminal_state = "completed"
            else:
                staging_parent = job / "analysis" / "render-staging"
                if not staging_parent.exists():
                    staging_parent.mkdir(mode=0o700)
                _regular_directory(staging_parent)
                staging = staging_parent / f"{render_id}.{token}.mp4"
                staging_ref[0] = staging
                renderer(
                    source,
                    job / str(request["edit_manifest_relative"]),
                    staging,
                    job / str(request["candidate_snapshot_relative"]),
                    expected_source_content_sha256=str(request["source_content_sha256"]),
                )
                verifier(job, request, source, staging)
                heartbeat(job, render_id, token)
                if storage_reservation is not None and not storage_client(
                    "heartbeat", *storage_reservation
                ):
                    raise QueueError()
                if lost.is_set():
                    raise QueueError()
                publish_completed_output(job, render_id, token, staging)
                terminal_state = "completed"
        except Exception:  # noqa: BLE001 - worker persists a fixed failure code
            try:
                update_request(
                    job,
                    render_id,
                    "failed",
                    lease_token=token,
                    error_code="render_failed",
                )
                terminal_state = "failed"
            except QueueError:
                pass
        finally:
            stop.set()
            if thread is not None:
                thread.join()
            if staging is not None:
                try:
                    staging.unlink()
                except FileNotFoundError:
                    pass
            if terminal_state is not None and storage_reservation is not None:
                try:
                    storage_client("release", *storage_reservation, terminal_state=terminal_state)
                except Exception:  # noqa: BLE001, S110 - terminal state is authoritative
                    pass
        return render_id
    return None


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
