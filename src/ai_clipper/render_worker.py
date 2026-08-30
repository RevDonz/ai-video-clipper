"""Explicit restart-safe one-shot worker for durable render requests."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
import threading
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
) -> None:
    while not stop.wait(interval):
        try:
            heartbeat(job, render_id, token)
        except QueueError:
            lost.set()
            return


def run_one(
    jobs_root: Path,
    *,
    renderer: Callable = render_from_manifest,
    verifier: Callable = _verify_existing,
    lease_seconds: float = 300,
    heartbeat_interval: float | None = None,
) -> str | None:
    """Claim and finish at most one request across all jobs."""
    root = Path(jobs_root).absolute()
    for job in _job_directories(root):
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
        try:
            request = update_request(job, render_id, "rendering", lease_token=token)
            thread = threading.Thread(
                target=_heartbeat_loop,
                args=(stop, lost, interval, job, render_id, token),
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
                update_request(job, render_id, "completed", lease_token=token)
            else:
                staging_parent = job / "analysis" / "render-staging"
                if not staging_parent.exists():
                    staging_parent.mkdir(mode=0o700)
                _regular_directory(staging_parent)
                staging = staging_parent / f"{render_id}.{token}.mp4"
                renderer(
                    source,
                    job / str(request["edit_manifest_relative"]),
                    staging,
                    job / str(request["candidate_snapshot_relative"]),
                    expected_source_content_sha256=str(request["source_content_sha256"]),
                )
                verifier(job, request, source, staging)
                heartbeat(job, render_id, token)
                if lost.is_set():
                    raise QueueError()
                publish_completed_output(job, render_id, token, staging)
        except Exception:  # noqa: BLE001 - worker persists a fixed failure code
            try:
                update_request(
                    job,
                    render_id,
                    "failed",
                    lease_token=token,
                    error_code="render_failed",
                )
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
        return render_id
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs-root", default=os.environ.get("JOBS_ROOT", "/data/jobs"))
    parser.add_argument("--lease-seconds", type=float, default=300)
    args = parser.parse_args(argv)
    try:
        render_id = run_one(Path(args.jobs_root), lease_seconds=args.lease_seconds)
        if render_id:
            print(render_id)
        return 0
    except Exception:  # noqa: BLE001 - executable boundary does not leak details
        print("render_worker_failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
