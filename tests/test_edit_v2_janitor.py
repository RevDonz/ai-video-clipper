"""T4.3: the editor janitor (plan §4.4, §11.4): receipts, archives, suggestions, preview caches
and orphan assets, per job, under the clip's document lock.

Every job here is synthetic (files only, no FFmpeg): a clip directory with ``edit/`` receipts and
archives, ``suggestions/``, ``preview/`` caches, the job asset store and render requests.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import threading
import time
import uuid
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import janitor, store

DAY_MS = 86_400_000
NOW_MS = 1_790_000_000_000  # 2026-09-21
CLIP = "clip_" + "a" * 24
OTHER_CLIP = "clip_" + "b" * 24


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def set_age(path: Path, age_ms: int, now_ms: int = NOW_MS) -> None:
    at = (now_ms - age_ms) / 1000
    os.utime(path, (at, at))


def make_job(root: Path, *, status: str = "completed") -> Path:
    job_id = str(uuid.uuid4())
    job = root / job_id
    (job / "analysis" / "clips").mkdir(parents=True)
    (job / "job.json").write_text(json.dumps({"id": job_id, "status": status}))
    return job


def make_clip(job: Path, clip_id: str = CLIP) -> Path:
    clip = job / "analysis" / "clips" / clip_id
    (clip / "edit" / "archive").mkdir(parents=True)
    (clip / "edit" / "receipts").mkdir()
    return clip


def doc(revision: int, assets: tuple[str, ...] = ()) -> dict:
    return {"revision": revision, "assets": {f"sha256:{a}": {} for a in assets}, "tracks": []}


def write_archive(clip: Path, revision: int, assets: tuple[str, ...] = ()) -> Path:
    raw = json.dumps(doc(revision, assets), sort_keys=True).encode()
    etag = hashlib.sha256(raw).hexdigest()
    path = clip / "edit" / "archive" / f"r{revision}.{etag}.json.gz"
    path.write_bytes(gzip.compress(raw, mtime=0))
    return path


def write_current(clip: Path, revision: int, assets: tuple[str, ...] = ()) -> None:
    (clip / "edit" / "doc.json").write_text(json.dumps(doc(revision, assets), sort_keys=True))


def write_request(job: Path, name: str, *, clip_id: str = CLIP, relative: str | None = None,
                  state: str = "completed") -> None:
    directory = job / "analysis" / "render-requests"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.json").write_text(json.dumps({
        "version": "render-request-v3", "render_id": name, "clip_id": clip_id,
        "doc_relative": relative, "state": state}))


def write_receipt(clip: Path, at_ms: int, state: str) -> Path:
    key = str(uuid.uuid4())
    body = {"at_ms": at_ms, "key": key, "payload_sha256": "0" * 64, "result_etag": "1" * 64,
            "result_revision": 1, "state": state}
    path = clip / "edit" / "receipts" / f"{key}.json"
    path.write_text(json.dumps(body, sort_keys=True, separators=(",", ":")))
    return path


def write_asset(job: Path, name: str, kind: str = "image", *, age_ms: int = 60 * DAY_MS) -> str:
    digest = sha(name)
    store_dir = job / "analysis" / "assets"
    store_dir.mkdir(parents=True, exist_ok=True)
    media = store_dir / (f"{digest}.png" if kind == "image" else f"{digest}.m4a")
    media.write_bytes(b"media-" + name.encode())
    meta = {"kind": kind, "mime": "image/png" if kind == "image" else "audio/mp4",
            "created_at_ms": NOW_MS - age_ms}
    (store_dir / f"{digest}.json").write_text(json.dumps(meta))
    if kind == "audio":
        (store_dir / f"{digest}.peaks.bin").write_bytes(b"\0\0")
    return digest


def asset_files(job: Path, digest: str) -> list[str]:
    return sorted(path.name for path in (job / "analysis" / "assets").glob(f"{digest}.*"))


def clean(job: Path, *, now_ms: int = NOW_MS, cap_bytes: int = 1 << 30) -> dict:
    return janitor.clean_job(job, now_ms=now_ms, cap_bytes=cap_bytes)


# --- receipts --------------------------------------------------------------------------------------


def test_receipts_keep_the_newest_200_committed_and_every_pending_one(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    committed = [write_receipt(clip, NOW_MS - DAY_MS + i, "committed") for i in range(230)]
    pending = [write_receipt(clip, NOW_MS - 90 * DAY_MS + i, "pending") for i in range(3)]
    report = clean(job)
    left = {path.name for path in (clip / "edit" / "receipts").iterdir()}
    assert {path.name for path in committed[-200:]} <= left
    assert {path.name for path in pending} <= left
    assert len(left) == 203 and report["receipts"] == 30


# --- archives (plan §4.4) ---------------------------------------------------------------------------


def test_archives_keep_revision_1_render_references_and_the_newest_50(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    paths = {revision: write_archive(clip, revision) for revision in range(1, 61)}
    write_current(clip, 61)
    relative = paths[5].relative_to(job).as_posix()
    write_request(job, "r-five", relative=relative)
    write_request(job, "r-other", clip_id=OTHER_CLIP,
                  relative=f"analysis/clips/{OTHER_CLIP}/edit/archive/r7.{'c' * 64}.json.gz")
    report = clean(job)
    left = sorted(int(path.name.split(".")[0][1:]) for path in (clip / "edit" / "archive").iterdir())
    assert left == [1, 5, *range(11, 61)]
    assert report["archives"] == 8
    clean(job)  # nothing more to do
    assert len(list((clip / "edit" / "archive").iterdir())) == 52


def test_archives_wait_while_an_export_of_the_job_is_in_flight(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    for revision in range(1, 61):
        write_archive(clip, revision)
    write_request(job, "busy", relative=None, state="rendering")
    report = clean(job)
    assert report["archives"] == 0 and len(list((clip / "edit" / "archive").iterdir())) == 60
    assert report["skipped"] == ["exports_in_flight"]


def test_archive_pruning_takes_the_clip_document_lock(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    for revision in range(1, 53):
        write_archive(clip, revision)
    held = threading.Event()
    release = threading.Event()

    def hold():
        with store._locked(clip):
            held.set()
            release.wait(timeout=10)

    thread = threading.Thread(target=hold)
    thread.start()
    assert held.wait(timeout=10)
    timer = threading.Timer(0.3, release.set)
    timer.start()
    started = time.monotonic()
    report = clean(job)
    waited = time.monotonic() - started
    thread.join()
    assert report["archives"] == 1 and waited >= 0.25


def test_files_that_are_not_archives_are_never_touched(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    for revision in range(1, 60):
        write_archive(clip, revision)
    stray = clip / "edit" / "archive" / "notes.txt"
    stray.write_text("mine")
    clean(job)
    assert stray.read_text() == "mine"


# --- suggestions -------------------------------------------------------------------------------------


def test_suggestions_are_kept_30_days(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    folder = clip / "suggestions"
    folder.mkdir()
    old, fresh = (folder / f"{uuid.uuid4()}.json" for _ in range(2))
    for path in (old, fresh):
        path.write_text("{}")
    set_age(old, 31 * DAY_MS)
    set_age(fresh, 29 * DAY_MS)
    leftover = folder / ".task.json.1234.tmp"
    leftover.write_text("{}")
    set_age(leftover, DAY_MS)
    other = folder / "README"
    other.write_text("x")
    set_age(other, 90 * DAY_MS)
    report = clean(job)
    assert sorted(path.name for path in folder.iterdir()) == sorted([fresh.name, "README"])
    assert report["suggestions"] == 2


# --- preview caches -------------------------------------------------------------------------------------


def cache_file(clip: Path, kind: str, name: str, size: int, age_ms: int) -> Path:
    path = clip / "preview" / kind / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    set_age(path, age_ms)
    return path


def test_caches_idle_30_days_go_and_the_job_cap_evicts_the_least_recently_used(tmp_path):
    job = make_job(tmp_path)
    clip, other = make_clip(job), make_clip(job, OTHER_CLIP)
    idle = cache_file(clip, "plates", "a" * 16 + "-c0000001.mp4", 10, 31 * DAY_MS)
    oldest = cache_file(clip, "audio", "b" * 16 + ".flac", 400, 3 * DAY_MS)
    older = cache_file(other, "frames", "c" * 16 + "-1-720.png", 400, 2 * DAY_MS)
    recent = cache_file(other, "ass", "d" * 16 + ".ass", 400, DAY_MS)
    in_use = cache_file(clip, "derived", "e" * 16 + "@10x10a1000.png", 400, 60_000)
    report = clean(job, cap_bytes=1000)
    assert not idle.exists() and not oldest.exists() and not older.exists()
    assert recent.exists() and in_use.exists()  # 800 bytes ≤ the cap
    assert report["cache_files"] == 3 and report["cache_bytes"] == 810


def test_files_used_in_the_last_10_minutes_survive_the_cap(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    busy = [cache_file(clip, "plates", f"{'f' * 16}-c{i:07d}.mp4", 600, 60_000) for i in range(3)]
    clean(job, cap_bytes=1000)
    assert all(path.exists() for path in busy)


def test_stale_temporaries_and_cancel_markers_are_removed(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    stale = cache_file(clip, "plates", ".c0000001.mp4.abcd.tmp", 5, 11 * 60_000)
    writing = cache_file(clip, "plates", ".c0000002.mp4.abcd.tmp", 5, 60_000)
    marker = cache_file(clip, ".cancel", "a" * 32, 0, 11 * 60_000)
    fresh_marker = cache_file(clip, ".cancel", "b" * 32, 0, 1_000)
    clean(job)
    assert not stale.exists() and not marker.exists()
    assert writing.exists() and fresh_marker.exists()


def test_a_symlinked_cache_directory_is_not_followed(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / ("a" * 16 + ".flac")
    victim.write_bytes(b"keep")
    set_age(victim, 90 * DAY_MS)
    (clip / "preview").mkdir()
    (clip / "preview" / "audio").symlink_to(outside, target_is_directory=True)
    clean(job)
    assert victim.read_bytes() == b"keep"


# --- orphan assets ---------------------------------------------------------------------------------------


def test_an_asset_unreferenced_for_30_days_is_deleted(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    used = write_asset(job, "logo")
    in_archive = write_asset(job, "old-logo")
    orphan = write_asset(job, "music", kind="audio")
    write_archive(clip, 1, (in_archive,))
    write_current(clip, 2, (used,))
    first = clean(job)
    assert first["assets"] == 0  # first seen unreferenced: the 30 days start now
    assert asset_files(job, orphan) == sorted([f"{orphan}.json", f"{orphan}.m4a",
                                               f"{orphan}.peaks.bin"])
    clean(job, now_ms=NOW_MS + 29 * DAY_MS)
    assert asset_files(job, orphan)
    last = clean(job, now_ms=NOW_MS + 30 * DAY_MS)
    assert last["assets"] == 1 and asset_files(job, orphan) == []
    assert asset_files(job, used) and asset_files(job, in_archive)


def test_an_asset_used_again_restarts_its_30_days(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    asset = write_asset(job, "logo")
    write_current(clip, 1)
    clean(job)
    write_current(clip, 2, (asset,))
    clean(job, now_ms=NOW_MS + 10 * DAY_MS)
    write_current(clip, 3)
    clean(job, now_ms=NOW_MS + 31 * DAY_MS)
    assert asset_files(job, asset)  # unreferenced again only since day 31
    clean(job, now_ms=NOW_MS + 61 * DAY_MS)
    assert asset_files(job, asset) == []


def test_a_fresh_upload_is_not_an_orphan_yet(tmp_path):
    job = make_job(tmp_path)
    make_clip(job)
    asset = write_asset(job, "just-uploaded", age_ms=60_000)
    clean(job)
    clean(job, now_ms=NOW_MS + 30 * DAY_MS)
    assert asset_files(job, asset) == []  # unreferenced for 30 days after the first look
    fresh = write_asset(job, "brand-new", age_ms=0)
    clean(job, now_ms=NOW_MS + 30 * DAY_MS)
    assert asset_files(job, fresh)


def test_an_unreadable_document_keeps_every_asset(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    asset = write_asset(job, "logo")
    (clip / "edit" / "doc.json").write_text("{not json")
    clean(job)
    report = clean(job, now_ms=NOW_MS + 90 * DAY_MS)
    assert report["assets"] == 0 and asset_files(job, asset)


def test_assets_referenced_only_by_pruned_archives_become_orphans(tmp_path):
    job = make_job(tmp_path)
    clip = make_clip(job)
    asset = write_asset(job, "early-logo")
    write_archive(clip, 2, (asset,))  # neither revision 1 nor among the newest 50
    for revision in range(3, 60):
        write_archive(clip, revision)
    write_archive(clip, 1)
    write_current(clip, 60)
    clean(job)
    clean(job, now_ms=NOW_MS + 30 * DAY_MS)
    assert asset_files(job, asset) == []


# --- jobs and the run ---------------------------------------------------------------------------------------


def test_jobs_being_deleted_and_other_directories_are_left_alone(tmp_path):
    deleting = make_job(tmp_path, status="deleting")
    clip = make_clip(deleting)
    for revision in range(1, 60):
        write_archive(clip, revision)
    tombstoned = make_job(tmp_path)
    tomb_clip = make_clip(tombstoned)
    for revision in range(1, 60):
        write_archive(tomb_clip, revision)
    (tmp_path / ".deletions").mkdir()
    (tmp_path / ".deletions" / f"{tombstoned.name}.json").write_text("{}")
    (tmp_path / "not-a-job").mkdir()
    report = janitor.run(tmp_path, now_ms=NOW_MS)
    assert len(list((clip / "edit" / "archive").iterdir())) == 59
    assert len(list((tomb_clip / "edit" / "archive").iterdir())) == 59
    assert report["jobs"] == 0 and report["complete"] is True


def test_the_run_visits_every_job_and_resumes_after_its_budget(tmp_path):
    jobs = sorted((make_job(tmp_path) for _ in range(3)), key=lambda job: job.name)
    for job in jobs:
        clip = make_clip(job)
        for revision in range(1, 53):
            write_archive(clip, revision)
    first = janitor.run(tmp_path, now_ms=NOW_MS, budget_s=0)
    assert first["jobs"] == 1 and first["complete"] is False and first["next"] == jobs[0].name
    rest = janitor.run(tmp_path, now_ms=NOW_MS, after=first["next"])
    assert rest["jobs"] == 2 and rest["complete"] is True and rest["next"] is None
    for job in jobs:
        assert len(list((job / "analysis" / "clips" / CLIP / "edit" / "archive").iterdir())) == 51


def test_the_cli_runs_one_envelope_from_stdin(tmp_path, monkeypatch, capsys):
    job = make_job(tmp_path)
    clip = make_clip(job)
    for revision in range(1, 53):
        write_archive(clip, revision)
    monkeypatch.setenv("JOBS_ROOT", str(tmp_path))
    envelope = json.dumps({"op": "run", "nowMs": NOW_MS, "capBytes": 1 << 30, "budgetMs": 60000})
    monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(envelope.encode())))
    assert janitor.main([]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["archives"] == 1 and result["complete"] is True


@pytest.mark.parametrize("envelope", [
    b"", b"[]", b'{"op": "nope"}', b'{"op": "run", "nowMs": -1}',
    b'{"op": "run", "nowMs": 1.5}', b'{"op": "run", "capBytes": 0}', b'{"op": "run", "x": 1}',
    b'{"op": "run", "after": "../etc"}'])
def test_the_cli_refuses_a_malformed_envelope(tmp_path, monkeypatch, capsys, envelope):
    monkeypatch.setenv("JOBS_ROOT", str(tmp_path))
    monkeypatch.setattr("sys.stdin", io.TextIOWrapper(io.BytesIO(envelope)))
    assert janitor.main([]) == 2
    assert str(tmp_path) not in capsys.readouterr().out
