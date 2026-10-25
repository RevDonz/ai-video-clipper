"""Take every Otomatis clip back to Latar blur, for a rollback below the reframe floor.

Rombak 04 §A8.4. Release 1 (RF-M3) is the floor: every image from it on renders a document with
``layout.default.mode = "auto"``. An older image rejects such a document (``range_invalid`` for
``auto``, ``unknown_key`` for ``base.shots`` and ``layout.ranges``), so before rolling back to it,
run this script with the app and the workers stopped (``docs/editor/OPERASIONAL.md``)::

    uv run python scripts/ops/auto_layout_downgrade.py --jobs-root /data/jobs          # dry run
    uv run python scripts/ops/auto_layout_downgrade.py --jobs-root /data/jobs --apply

Per job (every job under ``--jobs-root``, or only the ``--job`` ones):

* ``job.json`` ``options.renderMode = "auto"`` becomes ``"fit-blur"``, under the primary queue
  lock (``<jobs-root>/.primary-queue.lock``, the protocol of ``web/lib/primary-job-queue.mjs``);
* an automatic ``seed.json`` (revision 0) is kept as ``seed.auto.json`` and replaced by its
  Latar blur form: ``layout`` without ``ranges`` and the split's bands, ``base`` without
  ``shots``, a new ``base.seed_sha256``;
* an automatic current revision (``edit/doc.json``) gets one new revision through the document
  store (``store.put``: validated, the old one archived): the same edit in Latar blur, the
  seed's new ``base``, ``audit.last_command = "Downgrade"``. A ``layout.ranges`` under another
  layout is dropped the same way.

Nothing is deleted: the auto file (R10), the shot plans and the camera plans stay. Without
``--apply`` nothing is written. Every change is one JSON line on stdout, then a summary line;
exit 1 when any job or clip could not be read or changed. Run twice, the second run finds
nothing to change. Symlinks and paths that leave ``--jobs-root`` are refused.
"""

from __future__ import annotations

import argparse
import copy
import errno
import json
import os
import re
import socket
import stat
import sys
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ai_clipper import job_files
from ai_clipper.edit_v2 import errors as edit_errors
from ai_clipper.edit_v2 import seed as seed_module
from ai_clipper.edit_v2 import store
from ai_clipper.edit_v2.clip_id import CLIP_ID_PATTERN
from ai_clipper.edit_v2.doc import canonical_bytes

AUTO = "auto"
DOWNGRADED_MODE = "fit_blur"
DOWNGRADED_RENDER_MODE = "fit-blur"
LAST_COMMAND = "Downgrade"
SEED_BACKUP = "seed.auto.json"
QUEUE_LOCK = ".primary-queue.lock"
QUEUE_LOCK_TIMEOUT_S = 10.0
MAX_JOB_BYTES = 4 * 1024 * 1024
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class Refused(Exception):
    """A path this script must not touch (a symlink, or outside the jobs root)."""


def _is_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(os.lstat(path).st_mode)
    except OSError:
        return False


def _inside(root: Path, path: Path) -> Path:
    """``path`` as a real directory inside ``root`` (never through a symlink)."""
    if os.path.islink(path) or not _is_dir(path):
        raise Refused(f"not a directory: {path.name}")
    real = Path(os.path.realpath(path))
    if os.path.commonpath([real, root]) != str(root) or real == root:
        raise Refused(f"outside the jobs root: {path.name}")
    return real


def is_automatic(doc: Mapping[str, Any]) -> bool:
    """Whether an older image would refuse ``doc`` for the automatic layout's keys."""
    layout = doc["layout"]
    return (layout["default"]["mode"] == AUTO or "ranges" in layout
            or "shots" in doc["base"])


def downgraded_layout(layout: Mapping[str, Any]) -> dict[str, Any]:
    """``layout`` without the automatic layout: Latar blur for ``auto``, no ranges (their
    ``split_xy`` with them), the split's bands only under the split layout."""
    mode = layout["default"]["mode"]
    changed = {key: copy.deepcopy(value) for key, value in layout.items() if key != "ranges"}
    if mode == AUTO:
        changed["default"] = {**layout["default"], "mode": DOWNGRADED_MODE, "no_face": "center"}
        mode = DOWNGRADED_MODE
    if mode != "split":
        changed.pop("split", None)
    return changed


def downgraded_seed(seed: Mapping[str, Any]) -> dict[str, Any]:
    """The Latar blur form of an automatic seed, with its new ``base.seed_sha256``."""
    changed = copy.deepcopy(dict(seed))
    changed["layout"] = downgraded_layout(seed["layout"])
    changed["base"].pop("shots", None)
    changed["audit"] = {**seed["audit"], "last_command": LAST_COMMAND}
    changed["base"]["seed_sha256"] = seed_module.seed_sha256(changed)
    return changed


def downgraded_revision(current: Mapping[str, Any], etag: str,
                        seed: Mapping[str, Any]) -> dict[str, Any]:
    """The next revision of an automatic ``current``: the same edit in Latar blur."""
    changed = copy.deepcopy(dict(current))
    changed["layout"] = downgraded_layout(current["layout"])
    changed["base"] = copy.deepcopy(seed["base"])
    changed["revision"] = current["revision"] + 1
    changed["parent_sha256"] = etag
    changed["audit"] = {**current["audit"], "last_command": LAST_COMMAND}
    return changed


def _line(**fields: Any) -> None:
    print(json.dumps(fields, sort_keys=True, ensure_ascii=False), flush=True)


@contextmanager
def queue_lock(jobs_root: Path, *, timeout_s: float | None = None) -> Iterator[None]:
    """The primary queue lock (``web/lib/primary-job-queue.mjs``): a 0700 directory with an
    ``owner.json``; held only while ``job.json`` files are rewritten (well under the lock's
    30 s stale time, so no heartbeat)."""
    lock = jobs_root / QUEUE_LOCK
    deadline = time.monotonic() + (QUEUE_LOCK_TIMEOUT_S if timeout_s is None else timeout_s)
    while True:
        try:
            os.mkdir(lock, 0o700)
            break
        except FileExistsError:
            if os.path.islink(lock):
                raise Refused("the queue lock is a symlink") from None
            if time.monotonic() >= deadline:
                raise TimeoutError("the primary queue lock is held") from None
            time.sleep(0.05)
    token = str(uuid.uuid4())
    at = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    owner = {"token": token, "pid": os.getpid(), "hostname": socket.gethostname(),
             "createdAt": at, "heartbeatAt": at}
    try:
        job_files.atomic_write(lock, lock / "owner.json", json.dumps(owner).encode())
        yield
    finally:
        try:
            current = json.loads(job_files.read_regular(lock / "owner.json", 64 * 1024))
            if current.get("token") == token:
                os.unlink(lock / "owner.json")
                os.rmdir(lock)
        except (OSError, ValueError):
            pass


def _load_job(job_dir: Path) -> dict[str, Any]:
    job = json.loads(job_files.read_regular(job_dir / "job.json", MAX_JOB_BYTES))
    if type(job) is not dict:
        raise ValueError("job.json is not an object")
    return job


def _job_change(job_dir: Path) -> bool:
    options = _load_job(job_dir).get("options")
    return isinstance(options, dict) and options.get("renderMode") == AUTO


def _rewrite_job(job_dir: Path) -> None:
    job = _load_job(job_dir)
    options = job.get("options")
    if isinstance(options, dict) and options.get("renderMode") == AUTO:
        options["renderMode"] = DOWNGRADED_RENDER_MODE
        raw = (json.dumps(job, indent=2, ensure_ascii=False) + "\n").encode()
        job_files.atomic_write(job_dir, job_dir / "job.json", raw)


def _clip_dirs(job_dir: Path, root: Path) -> list[Path]:
    clips = job_dir / "analysis" / "clips"
    if not os.path.lexists(clips):
        return []
    _inside(root, job_dir / "analysis")
    _inside(root, clips)
    found = []
    for entry in sorted(os.listdir(clips)):
        if CLIP_ID_PATTERN.fullmatch(entry):
            found.append(_inside(root, clips / entry))
    return found


def _publish_seed(clip: Path, seed: Mapping[str, Any], raw: bytes) -> None:
    """``seed.auto.json`` (the original bytes, never overwritten), then the new ``seed.json``,
    under the clip's lock."""
    with store._locked(clip):
        backup = clip / SEED_BACKUP
        if os.path.lexists(backup):
            if job_files.read_regular(backup, len(raw) + 1) != raw:
                raise FileExistsError(errno.EEXIST, "another seed.auto.json exists")
        else:
            job_files.atomic_write(clip, backup, raw)
        job_files.atomic_write(clip, clip / store.SEED_FILE, seed_module.encode_seed(seed))


def _downgrade_clip(job_id: str, clip: Path, apply: bool) -> int:
    changes = 0
    seed, _seed_etag = store.seed(clip)
    seed_raw = job_files.read_regular(clip / store.SEED_FILE, 1 << 20)
    if is_automatic(seed):
        new_seed = downgraded_seed(seed)
        if apply:
            _publish_seed(clip, new_seed, seed_raw)
        _line(job=job_id, clip=clip.name, change="seed", applied=apply,
              mode=[seed["layout"]["default"]["mode"], new_seed["layout"]["default"]["mode"]])
        changes += 1
        seed = new_seed
    current, etag, is_seed = store.get(clip)
    if not is_seed and is_automatic(current):
        revision = downgraded_revision(current, etag, seed)
        if apply:
            store.put(clip, expected_etag=etag, idempotency_key=str(uuid.uuid4()),
                      raw=canonical_bytes(revision), now_ms=time.time_ns() // 1_000_000)
        _line(job=job_id, clip=clip.name, change="revision", applied=apply,
              revision=[current["revision"], revision["revision"]],
              mode=[current["layout"]["default"]["mode"], revision["layout"]["default"]["mode"]])
        changes += 1
    return changes


def _job_dirs(root: Path, wanted: Sequence[str]) -> list[tuple[str, Path]]:
    names = list(wanted) if wanted else sorted(
        entry for entry in os.listdir(root) if _UUID.fullmatch(entry))
    return [(name, root / name) for name in names]


def run(jobs_root: Path, *, apply: bool, jobs: Sequence[str] = ()) -> int:
    """Downgrade (or, without ``apply``, list) every automatic job and clip; the exit code."""
    if os.path.islink(jobs_root) or not _is_dir(jobs_root):
        _line(error="jobs_root_invalid")
        return 1
    root = Path(os.path.realpath(jobs_root))
    for name in jobs:
        if not _UUID.fullmatch(name):
            _line(error="job_invalid")
            return 1
    changes = errors = 0
    rewrite: list[tuple[str, Path]] = []
    seen = 0
    for job_id, path in _job_dirs(root, jobs):
        seen += 1
        try:
            job_dir = _inside(root, path)
            if _job_change(job_dir):
                rewrite.append((job_id, job_dir))
            for clip in _clip_dirs(job_dir, root):
                try:
                    changes += _downgrade_clip(job_id, clip, apply)
                except (OSError, ValueError, KeyError, TypeError,
                        edit_errors.EditV2Error) as error:
                    errors += 1
                    _line(job=job_id, clip=clip.name, error=type(error).__name__)
        except (Refused, OSError, ValueError, KeyError, TypeError) as error:
            errors += 1
            _line(job=job_id, error=type(error).__name__)
    if rewrite:
        try:
            if apply:
                with queue_lock(root):
                    for _job_id, job_dir in rewrite:
                        _rewrite_job(job_dir)
            for job_id, _job_dir in rewrite:
                _line(job=job_id, change="job_render_mode", applied=apply,
                      render_mode=[AUTO, DOWNGRADED_RENDER_MODE])
                changes += 1
        except (Refused, OSError, ValueError, TimeoutError) as error:
            errors += 1
            _line(error=type(error).__name__, change="job_render_mode")
    _line(summary={"jobs": seen, "changes": changes, "errors": errors, "applied": apply})
    return 1 if errors else 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--jobs-root", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="write (default: dry run)")
    parser.add_argument("--job", action="append", default=[], metavar="UUID",
                        help="only this job (repeatable)")
    args = parser.parse_args(argv)
    return run(args.jobs_root, apply=args.apply, jobs=args.job)


if __name__ == "__main__":
    sys.exit(main())
