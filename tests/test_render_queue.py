import copy
import dataclasses
import errno
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_manifest import make_manifest
from test_edit_v2_store import make_clip, next_doc

from ai_clipper import render_queue
from ai_clipper.edit_manifest import manifest_sha256, write_edit_manifest
from ai_clipper.edit_v2 import PACK_IDS
from ai_clipper.edit_v2 import errors as edit_errors
from ai_clipper.edit_v2 import store as edit_store
from ai_clipper.edit_v2 import verify as edit_verify
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.plan import Resources, build_plan, render_key, toolchain_sha256
from ai_clipper.render_queue import (
    OUTPUT_BYTES_PER_SECOND,
    RENDER_COST_PERMILLE,
    RETENTION_DAYS,
    RETENTION_KEEP,
    TIMEOUT_FACTOR,
    TIMEOUT_FLOOR_MS,
    V3_VERSION,
    QueueAnalysisMissing,
    QueueConflict,
    QueueIdempotencyConflict,
    QueueInvalid,
    QueueNotFound,
    QueueRevisionConflict,
    QueueSourceMissing,
    cancel_request_v3,
    claim_next,
    complete_v3,
    create_request,
    create_request_v3,
    estimate_v3,
    fail_v3,
    get_request,
    heartbeat,
    list_requests_v3,
    predicted_render_ms,
    progress_v3,
    prune_requests_v3,
    render_timeout_ms,
    start_rendering_v3,
    update_request,
)

KEY = "323e4567-e89b-42d3-a456-426614174000"
RESERVATION_ID = "423e4567-e89b-42d3-a456-426614174000"
RESERVATION_TOKEN = "523e4567-e89b-42d3-a456-426614174000"


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


def test_admitted_request_durably_carries_fenced_storage_reservation(tmp_path: Path):
    job, _analysis, manifest, source = fixture(tmp_path)
    request = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        KEY,
        storage_reservation={
            "reservation_id": RESERVATION_ID,
            "token": RESERVATION_TOKEN,
            "reserved_bytes": source.stat().st_size + 1024,
        },
    )

    assert request["version"] == "render-request-v2"
    assert request["storage_reservation_id"] == RESERVATION_ID
    assert request["storage_reservation_token"] == RESERVATION_TOKEN
    assert request["storage_reserved_bytes"] == source.stat().st_size + 1024
    assert get_request(job, request["render_id"]) == request


def test_content_addressed_snapshots_are_verified_and_reused_without_temp_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    job, _analysis, manifest, _source = fixture(tmp_path)
    create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    original_open = render_queue.os.open

    def no_snapshot_temporary(path, flags, *args, **kwargs):
        if Path(path).name.startswith((".source.", ".candidates.")) and Path(path).name.endswith(
            ".tmp"
        ):
            pytest.fail("verified content-addressed snapshot must be reused before temp copy")
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(render_queue.os, "open", no_snapshot_temporary)
    second = create_request(
        job,
        manifest.identity.candidate_id,
        manifest_sha256(manifest),
        "623e4567-e89b-42d3-a456-426614174000",
    )
    assert (job / second["source_snapshot_relative"]).is_file()
    assert (job / second["candidate_snapshot_relative"]).is_file()


# --- render-request-v3 (Editor V3 exports, plan §4.6; T2.2) ------------------------------------
#
# The legacy cases above are unchanged. Everything below drives the v3 functions against a clip
# directory built from the c30 document context (tests/support/edit_v2_fixtures.py), with a
# test resources/ tree that carries a toolchain.json (the image writes the real one, E10).

V3_SOURCE_BYTES = b"editor v3 downloaded source bytes"
V3_NOW = datetime(2026, 9, 25, 12, 0, 0, tzinfo=UTC)
V3_FRAMES = 2023 + 136  # c30: body + cold open at 30000/1001
V3_DURATION_MS = (V3_FRAMES * 1000 * 1001 * 2 + 30000) // (2 * 30000)
V3_TOOLCHAIN = {
    "schema": "potongin.toolchain/1",
    "base_image": "node:20-bookworm-slim@sha256:" + "cd" * 32,
    "apt_snapshot": "20260924T000000Z",
    "packages": {"ffmpeg": "7:5.1.9-0+deb12u1", "libass9": "1:0.17.1-1",
                 "libfreetype6": "2.12.1+dfsg-5+deb12u4", "libharfbuzz0b": "6.0.0+dfsg-3",
                 "libfribidi0": "1.0.8-2.1", "fontconfig": "2.14.1-4"},
}
V3_SRT = b"1\n00:00:00,000 --> 00:00:01,000\nhai\n"


def v3_sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def v3_resources(root: Path, toolchain: dict | None = None) -> Resources:
    """A resources/ tree as the image ships it (fonts.json, packs, hook design, toolchain.json)."""
    (root / "fonts").mkdir(parents=True)
    (root / "fonts" / "fonts.json").write_text('{"fonts": []}')
    for pack in PACK_IDS:
        (root / "caption-packs" / pack).mkdir(parents=True)
        (root / "caption-packs" / pack / "v1.json").write_text(json.dumps({"id": pack, "v": 1}))
    (root / "hook-designs" / "legacy-bar").mkdir(parents=True)
    (root / "hook-designs" / "legacy-bar" / "v1.json").write_text('{"id": "legacy-bar", "v": 1}')
    (root / "toolchain.json").write_text(json.dumps(toolchain or V3_TOOLCHAIN, indent=2) + "\n")
    return Resources(root)


def v3_accept(_path: Path, _plan) -> bool:
    return True


class V3Job:
    """A V3 job with one prepared clip (c30 context: rank 3, cold open, hook, fit_blur)."""

    def __init__(self, tmp_path: Path, *, engine: str = "edit-v2/1", auto: bool = False):
        self.context = fixtures.load_context("c30")
        seed = copy.deepcopy(self.context.seed)
        seed["base"]["source"]["content_sha256"] = v3_sha(V3_SOURCE_BYTES)
        seed["base"]["engine"]["compiler"] = engine
        self.job_id = seed["base"]["job_id"]
        self.root = tmp_path / "jobs"
        self.clip = make_clip(self.root, self.context, seed=seed)
        self.clip_id = seed["clip_id"]
        self.seed = seed
        self.seed_etag = fixtures.etag(seed)
        self.job = self.root / self.job_id
        (self.job / "input").mkdir()
        self.source = self.job / "input" / "source.mp4"
        self.source.write_bytes(V3_SOURCE_BYTES)
        (self.job / "job.json").write_text(
            json.dumps({"id": self.job_id, "sourcePath": str(self.source)}))
        (self.job / "output").mkdir()
        if auto:
            self.write_auto()
        self.resources = v3_resources(tmp_path / "resources")

    @property
    def queue(self) -> Path:
        return self.job / "analysis" / "render-requests"

    def write_auto(self, data: bytes = b"auto clip bytes") -> None:
        (self.job / "output" / "clip-03.mp4").write_bytes(data)
        (self.job / "output" / "clip-03.srt").write_bytes(V3_SRT)

    def save(self, **changes) -> tuple[dict, str]:
        current, etag, _is_seed = edit_store.get(self.clip)
        doc = next_doc(current, etag, **changes)
        saved, new_etag, _warnings = edit_store.put(
            self.clip, expected_etag=etag, idempotency_key=str(uuid.uuid4()),
            raw=canonical_bytes(doc), now_ms=fixtures.PUT_NOW_MS + current["revision"])
        return saved, new_etag

    def expected_key(self, doc: dict, resources: Resources | None = None) -> str:
        resources = resources or self.resources
        plan = build_plan(doc, words=self.context.words, camera=None, assets={},
                          resources=resources)
        return render_key(plan, size=(720, 1280), quality="standar", measure_sha=None,
                          toolchain_sha=toolchain_sha256(resources))

    def create(self, etag: str | None = None, key: str | None = None, **options) -> dict:
        options.setdefault("resources", self.resources)
        options.setdefault("verify_auto", v3_accept)
        return create_request_v3(self.job, self.clip_id, etag or self.seed_etag,
                                 key or str(uuid.uuid4()), **options)

    def request_path(self, render_id: str) -> Path:
        return self.queue / f"{render_id}.json"

    def requests(self) -> list[dict]:
        return [get_request(self.job, path.stem) for path in sorted(self.queue.glob("*.json"))]


def v3_write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def v3_rewrite(job: V3Job, target: str, /, **changes) -> None:
    path = job.request_path(target)
    v3_write(path, {**json.loads(path.read_text()), **changes})


def v3_stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def v3_publish(job: V3Job, request: dict, data: bytes = b"verified export") -> Path:
    output = job.job / request["output_relative"]
    output.with_suffix(".srt").write_bytes(V3_SRT)
    output.write_bytes(data)
    return output


def v3_rendering(job: V3Job, request: dict) -> str:
    """Claim ``request`` (the only queued one) and start rendering it; the lease token."""
    claimed = claim_next(job.job)
    assert claimed is not None and claimed["render_id"] == request["render_id"]
    start_rendering_v3(job.job, request["render_id"], claimed["lease_token"])
    return claimed["lease_token"]


def test_v3_create_binds_the_archived_revision_render_key_and_hard_linked_source(tmp_path):
    job = V3Job(tmp_path)
    doc, etag = job.save(main__cut_fade_ms=20)
    key = job.expected_key(doc)
    request = job.create(etag, KEY)

    assert request["version"] == V3_VERSION == "render-request-v3"
    assert (request["state"], request["stage"], request["progress_pm"]) == ("queued", "antre", 0)
    assert request["attempts"] == 0 and request["error_code"] is None
    assert (request["clip_id"], request["doc_sha256"], request["doc_revision"]) == (
        job.clip_id, etag, 1)
    assert request["doc_relative"] == (
        f"analysis/clips/{job.clip_id}/edit/archive/r1.{etag}.json.gz")
    assert (job.job / request["doc_relative"]).is_file()
    assert request["render_key"] == key
    assert (request["size"], request["quality"]) == ("output", "standar")
    assert request["output_relative"] == f"output/edits/{job.clip_id}/{key[:16]}.mp4"
    assert request["warnings"] == [] and request["completed_by"] is None
    assert request["cancel_requested_at"] is None
    assert request["source_content_sha256"] == v3_sha(V3_SOURCE_BYTES)
    assert request["source_snapshot_relative"] == (
        f"analysis/render-inputs/source.{v3_sha(V3_SOURCE_BYTES)}.mp4")
    snapshot = job.job / request["source_snapshot_relative"]
    assert os.path.samestat(snapshot.stat(), job.source.stat())  # a hard link, not a copy
    assert request["timeout_ms"] == render_timeout_ms(V3_DURATION_MS, "fit_blur", (720, 1280))
    assert get_request(job.job, request["render_id"]) == request
    assert not (job.job / request["output_relative"]).exists()


def test_v3_timeout_formula_is_the_scaled_prediction_with_a_floor():
    assert (TIMEOUT_FLOOR_MS, TIMEOUT_FACTOR) == (120_000, 3)
    for layout in ("fit_blur", "fill_center", "camera"):
        for size in ((720, 1280), (1080, 1920)):
            cost = RENDER_COST_PERMILLE[(layout, size)]
            assert predicted_render_ms(60_000, layout, size) == -(-60_000 * cost // 1000)
            for duration in (3_000, 60_000, 300_000):
                predicted = predicted_render_ms(duration, layout, size)
                assert render_timeout_ms(duration, layout, size) == max(120_000, 3 * predicted)
    assert render_timeout_ms(3_000, "fit_blur", (720, 1280)) == 120_000
    assert render_timeout_ms(300_000, "camera", (720, 1280)) > 120_000
    small, large = (720, 1280), (1080, 1920)
    assert RENDER_COST_PERMILLE[("camera", small)] >= RENDER_COST_PERMILLE[("fit_blur", small)]
    assert RENDER_COST_PERMILLE[("fit_blur", large)] > RENDER_COST_PERMILLE[("fit_blur", small)]


def test_v3_create_is_idempotent_and_a_reused_key_with_other_content_conflicts(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    first = job.create(etag, KEY)
    assert job.create(etag, KEY.upper()) == first
    assert len(list(job.queue.glob("*.json"))) == 1
    _doc2, etag2 = job.save(main__cut_fade_ms=30)
    with pytest.raises(QueueIdempotencyConflict):
        job.create(etag2, KEY)


def test_v3_create_rejects_unknown_revisions_clips_and_malformed_ids(tmp_path):
    job = V3Job(tmp_path)
    with pytest.raises(QueueRevisionConflict):
        job.create("e" * 64)
    with pytest.raises(QueueNotFound):
        create_request_v3(job.job, "clip_" + "0" * 24, job.seed_etag, KEY,
                          resources=job.resources)
    for clip_id, etag, key in (("clip_x", job.seed_etag, KEY), (job.clip_id, "E" * 64, KEY),
                               (job.clip_id, job.seed_etag, "not-a-uuid"),
                               ("../" + job.clip_id, job.seed_etag, KEY)):
        with pytest.raises(QueueInvalid):
            create_request_v3(job.job, clip_id, etag, key, resources=job.resources)
    assert not job.queue.exists() or not list(job.queue.glob("*.json"))


def test_v3_an_older_archived_revision_can_be_exported(tmp_path):
    job = V3Job(tmp_path)
    _doc1, etag1 = job.save(main__cut_fade_ms=20)
    job.save(main__cut_fade_ms=30)
    request = job.create(etag1)
    assert request["doc_revision"] == 1
    assert request["doc_relative"].endswith(f"/edit/archive/r1.{etag1}.json.gz")


def test_v3_missing_or_changed_source_and_missing_analysis_are_named(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    job.source.write_bytes(b"a different download")
    with pytest.raises(QueueSourceMissing):
        job.create(etag)
    job.source.unlink()
    with pytest.raises(QueueSourceMissing):
        job.create(etag)
    job.source.write_bytes(V3_SOURCE_BYTES)
    for words in job.clip.glob("words.*.json"):
        words.unlink()
    with pytest.raises(QueueAnalysisMissing):
        job.create(etag)
    assert not job.queue.exists() or not list(job.queue.glob("*.json"))


def test_v3_source_snapshot_falls_back_to_a_verified_copy_across_devices(tmp_path, monkeypatch):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    original_link = render_queue.os.link

    def cross_device(source, target, *args, **kwargs):
        if Path(target).name.startswith("source."):
            raise OSError(errno.EXDEV, "cross-device link")
        return original_link(source, target, *args, **kwargs)

    monkeypatch.setattr(render_queue.os, "link", cross_device)
    request = job.create(etag)
    snapshot = job.job / request["source_snapshot_relative"]
    assert snapshot.read_bytes() == V3_SOURCE_BYTES
    assert not os.path.samestat(snapshot.stat(), job.source.stat())
    assert snapshot.stat().st_mode & 0o777 == 0o600
    assert not [path for path in snapshot.parent.iterdir() if path.name.endswith(".tmp")]


def test_v3_existing_snapshot_is_reused_only_when_its_content_matches(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    first = job.create(etag)
    assert job.create(etag)["source_snapshot_relative"] == first["source_snapshot_relative"]
    snapshot = job.job / first["source_snapshot_relative"]
    snapshot.unlink()
    snapshot.write_bytes(b"tampered snapshot")
    with pytest.raises(QueueInvalid):
        job.create(etag)


def test_v3_r10_seed_content_completes_instantly_by_hard_linking_the_auto_file(tmp_path):
    job = V3Job(tmp_path, auto=True)
    checked = []

    def verify_auto(path, plan):
        checked.append((path, plan.total_frames))
        return True

    request = job.create(job.seed_etag, KEY, verify_auto=verify_auto)
    assert (request["state"], request["stage"], request["progress_pm"]) == (
        "completed", "selesai", 1000)
    assert request["completed_by"] == "seed" and request["attempts"] == 0
    assert request["doc_relative"] == f"analysis/clips/{job.clip_id}/seed.json"
    assert request["doc_revision"] == 0
    assert request["render_key"] == job.expected_key(job.seed)
    auto = job.job / "output" / "clip-03.mp4"
    output = job.job / request["output_relative"]
    assert os.path.samestat(output.stat(), auto.stat())  # the auto file itself (same inode)
    assert os.path.samestat(output.with_suffix(".srt").stat(),
                            (job.job / "output" / "clip-03.srt").stat())
    assert checked == [(auto, V3_FRAMES)]
    assert request["source_snapshot_relative"] is None  # nothing to render
    assert get_request(job.job, request["render_id"]) == request


def test_v3_r10_after_every_edit_was_undone_and_with_a_changed_toolchain(tmp_path):
    job = V3Job(tmp_path, auto=True)
    job.save(main__cut_fade_ms=20)
    undone, etag = job.save(main__cut_fade_ms=8)
    assert undone["revision"] == 2
    first = job.create(etag)
    assert first["completed_by"] == "seed" and first["doc_revision"] == 2
    rebuilt = v3_resources(tmp_path / "rebuilt",
                           {**V3_TOOLCHAIN, "apt_snapshot": "20270101T000000Z"})
    second = job.create(etag, resources=rebuilt)
    assert second["render_key"] != first["render_key"]
    assert second["completed_by"] == "seed"
    auto = (job.job / "output" / "clip-03.mp4").stat()
    for request in (first, second):
        assert os.path.samestat((job.job / request["output_relative"]).stat(), auto)


def test_v3_r10_covers_a_legacy_engine_clip(tmp_path):
    job = V3Job(tmp_path, engine="legacy", auto=True)
    request = job.create(job.seed_etag)
    assert request["completed_by"] == "seed"
    assert os.path.samestat((job.job / request["output_relative"]).stat(),
                            (job.job / "output" / "clip-03.mp4").stat())


def test_v3_r10_prefers_the_manifest_clip_id_over_the_seed_rank(tmp_path):
    job = V3Job(tmp_path, auto=True)
    (job.job / "output" / "clip-07.mp4").write_bytes(b"new engine auto clip")
    (job.job / "output" / "clip-07.srt").write_bytes(V3_SRT)
    (job.job / "output" / "manifest.json").write_text(
        json.dumps({"clips": [{"index": 7, "clip_id": job.clip_id}]}))
    request = job.create(job.seed_etag)
    assert request["completed_by"] == "seed"
    assert (job.job / request["output_relative"]).read_bytes() == b"new engine auto clip"


def test_v3_r10_writes_the_plan_srt_when_the_auto_srt_is_missing(tmp_path):
    job = V3Job(tmp_path, auto=True)
    (job.job / "output" / "clip-03.srt").unlink()
    request = job.create(job.seed_etag)
    srt = (job.job / request["output_relative"]).with_suffix(".srt")
    assert request["completed_by"] == "seed"
    assert srt.read_text().startswith("1\n") and srt.stat().st_mode & 0o777 == 0o600


def test_v3_unavailable_auto_file_renders_normally_with_a_warning(tmp_path):
    job = V3Job(tmp_path)
    missing = job.create(job.seed_etag)
    assert (missing["state"], missing["warnings"]) == ("queued", ["auto_file_unavailable"])
    assert missing["source_snapshot_relative"] is not None
    job.write_auto()
    failing = job.create(job.seed_etag, verify_auto=lambda _path, _plan: False)
    assert (failing["state"], failing["warnings"]) == ("queued", ["auto_file_unavailable"])
    assert not (job.job / failing["output_relative"]).exists()


def test_v3_the_default_auto_file_check_is_g1_g2_of_the_seed_plan(tmp_path, monkeypatch):
    job = V3Job(tmp_path, auto=True)
    seen = []

    def failing_verify(fd, plan, *, size, normalize):
        seen.append((os.fstat(fd).st_ino, plan.total_frames, tuple(size), normalize))
        raise edit_errors.VerificationFailed("verification_failed")

    monkeypatch.setattr(edit_verify, "verify_output", failing_verify)
    request = job.create(job.seed_etag, verify_auto=None)
    auto = job.job / "output" / "clip-03.mp4"
    assert seen == [(auto.stat().st_ino, V3_FRAMES, (720, 1280), False)]
    assert request["warnings"] == ["auto_file_unavailable"]
    monkeypatch.setattr(edit_verify, "verify_output",
                        lambda fd, plan, *, size, normalize: None)
    assert job.create(job.seed_etag, verify_auto=None)["completed_by"] == "seed"


def test_v3_an_existing_verified_export_of_the_same_key_completes_instantly(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    first = job.create(etag)
    token = v3_rendering(job, first)
    output = v3_publish(job, first)
    complete_v3(job.job, first["render_id"], token)
    job.save(main__cut_fade_ms=30)
    _doc3, etag3 = job.save(main__cut_fade_ms=20)  # revision 3 has revision 1's content
    again = job.create(etag3)
    assert again["render_key"] == first["render_key"]
    assert (again["state"], again["completed_by"]) == ("completed", "key")
    assert again["output_relative"] == first["output_relative"]
    assert output.read_bytes() == b"verified export"
    # the file alone is enough (its request may have been pruned): it was published after
    # verification, under a content-addressed name
    job.request_path(first["render_id"]).unlink()
    assert job.create(etag)["completed_by"] == "key"


def test_v3_complete_requires_the_published_mp4_and_srt(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    request = job.create(etag)
    token = v3_rendering(job, request)
    with pytest.raises(QueueInvalid):
        complete_v3(job.job, request["render_id"], token)
    output = job.job / request["output_relative"]
    output.write_bytes(b"mp4 only")
    with pytest.raises(QueueInvalid):
        complete_v3(job.job, request["render_id"], token)
    output.with_suffix(".srt").symlink_to(output)
    with pytest.raises(QueueInvalid):
        complete_v3(job.job, request["render_id"], token)
    output.with_suffix(".srt").unlink()
    output.with_suffix(".srt").write_bytes(V3_SRT)
    with pytest.raises(QueueConflict):
        complete_v3(job.job, request["render_id"], str(uuid.uuid4()))
    done = complete_v3(job.job, request["render_id"], token,
                       warnings=("peak_reduced:-3.80 dB",))
    assert (done["state"], done["stage"], done["progress_pm"], done["completed_by"]) == (
        "completed", "selesai", 1000, "render")
    assert done["warnings"] == ["peak_reduced:-3.80 dB"] and done["lease_token"] is None
    assert done["completed_at"] is not None and done["heartbeat_at"] is None


def test_v3_heartbeat_carries_stage_and_progress_under_the_lease(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    request = job.create(etag)
    claimed = claim_next(job.job)
    assert (claimed["state"], claimed["stage"], claimed["attempts"]) == ("claimed", "antre", 1)
    token = claimed["lease_token"]
    with pytest.raises(QueueConflict):
        progress_v3(job.job, request["render_id"], token, "merender", 10)  # not rendering yet
    rendering = start_rendering_v3(job.job, request["render_id"], token)
    assert (rendering["state"], rendering["stage"], rendering["progress_pm"]) == (
        "rendering", "merender", 0)
    beat = progress_v3(job.job, request["render_id"], token, "merender", 420)
    assert (beat["stage"], beat["progress_pm"]) == ("merender", 420)
    assert beat["heartbeat_at"] >= rendering["heartbeat_at"]
    verifying = progress_v3(job.job, request["render_id"], token, "memverifikasi", 1000)
    assert verifying["stage"] == "memverifikasi"
    for stage, progress in (("selesai", 10), ("antre", 10), ("merender", -1),
                            ("merender", 1001), ("merender", True)):
        with pytest.raises(QueueInvalid):
            progress_v3(job.job, request["render_id"], token, stage, progress)
    with pytest.raises(QueueConflict):
        progress_v3(job.job, request["render_id"], str(uuid.uuid4()), "merender", 1)
    assert heartbeat(job.job, request["render_id"], token)["state"] == "rendering"


def test_v3_failures_record_their_fixed_code(tmp_path):
    job = V3Job(tmp_path)
    codes = ("render_failed", "render_timeout", "render_stalled", "verification_failed")
    for index, code in enumerate(codes):
        _doc, etag = job.save(main__cut_fade_ms=20 + index)
        request = job.create(etag)
        token = v3_rendering(job, request)
        failed = fail_v3(job.job, request["render_id"], token, code)
        assert (failed["state"], failed["error_code"]) == ("failed", code)
        assert failed["failed_at"] is not None and failed["lease_token"] is None
    _doc, etag = job.save(main__cut_fade_ms=40)
    request = job.create(etag)
    token = claim_next(job.job)["lease_token"]
    for code in ("max_attempts_exceeded", "disk on fire", None):
        with pytest.raises(QueueInvalid):
            fail_v3(job.job, request["render_id"], token, code)
    cancelled = fail_v3(job.job, request["render_id"], token, "cancelled")
    assert (cancelled["state"], cancelled["error_code"]) == ("cancelled", "cancelled")
    assert cancelled["cancelled_at"] is not None and cancelled["failed_at"] is None


def test_v3_cancel_from_queued_is_immediate_and_from_rendering_is_requested(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    queued = job.create(etag)
    cancelled = cancel_request_v3(job.job, queued["render_id"])
    assert (cancelled["state"], cancelled["error_code"], cancelled["stage"]) == (
        "cancelled", "cancelled", "antre")
    assert cancelled["cancelled_at"] is not None
    assert claim_next(job.job) is None  # a cancelled request is never claimed
    assert cancel_request_v3(job.job, queued["render_id"]) == cancelled  # idempotent

    _doc, etag = job.save(main__cut_fade_ms=21)
    running = job.create(etag)
    token = v3_rendering(job, running)
    requested = cancel_request_v3(job.job, running["render_id"])
    assert requested["state"] == "rendering" and requested["cancel_requested_at"] is not None
    assert requested["lease_token"] == token
    fail_v3(job.job, running["render_id"], token, "cancelled")

    _doc, etag = job.save(main__cut_fade_ms=22)
    done = job.create(etag)
    token = v3_rendering(job, done)
    v3_publish(job, done)
    finished = complete_v3(job.job, done["render_id"], token)
    assert cancel_request_v3(job.job, done["render_id"]) == finished  # nothing to cancel
    with pytest.raises(QueueNotFound):
        cancel_request_v3(job.job, str(uuid.uuid4()))


def test_v3_a_stale_cancel_requested_render_is_cancelled_not_reclaimed(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    request = job.create(etag)
    v3_rendering(job, request)
    cancel_request_v3(job.job, request["render_id"])
    v3_rewrite(job, request["render_id"], heartbeat_at="2020-01-01T00:00:00.000Z")
    assert claim_next(job.job, lease_seconds=1) is None
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("cancelled", "cancelled")


def test_v3_stale_renders_are_reclaimed_with_their_stage_reset_then_bounded(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    request = job.create(etag)
    for attempt in (1, 2, 3):
        claimed = claim_next(job.job, lease_seconds=1)
        assert (claimed["attempts"], claimed["stage"], claimed["progress_pm"]) == (
            attempt, "antre", 0)
        start_rendering_v3(job.job, request["render_id"], claimed["lease_token"])
        progress_v3(job.job, request["render_id"], claimed["lease_token"], "merender", 500)
        v3_rewrite(job, request["render_id"], heartbeat_at="2020-01-01T00:00:00.000Z")
    assert claim_next(job.job, lease_seconds=1) is None
    final = get_request(job.job, request["render_id"])
    assert (final["state"], final["error_code"]) == ("failed", "max_attempts_exceeded")


def test_v3_request_files_are_validated_strictly(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    request = job.create(etag)
    render_id = request["render_id"]
    path = job.request_path(render_id)
    pristine = path.read_bytes()
    bad_changes = [
        {"extra": 1},
        {"version": "render-request-v4"},
        {"state": "paused"},
        {"stage": "selesai"},
        {"progress_pm": 1001},
        {"clip_id": "clip_" + "f" * 24},
        {"doc_revision": -1},
        {"doc_relative": f"analysis/clips/{job.clip_id}/seed.json"},
        {"output_relative": f"output/edits/{job.clip_id}/../../x.mp4"},
        {"size": "1080x1920"},
        {"quality": "tinggi"},
        {"timeout_ms": 1_000},
        {"warnings": ["not a code"]},
        {"warnings": ["tight_cut"] * 17},
        {"completed_by": "seed"},
        {"source_snapshot_relative": None},
        {"storage_reservation_id": RESERVATION_ID},
        {"attempts": 4},
        {"error_code": "render_failed"},
        {"cancel_requested_at": v3_stamp(V3_NOW)},
        {"render_id": "../../etc/passwd"},
    ]
    for change in bad_changes:
        v3_rewrite(job, render_id, **change)
        with pytest.raises(QueueInvalid):
            get_request(job.job, render_id)
        path.write_bytes(pristine)
    path.write_bytes(pristine.replace(b'"attempts":0', b'"attempts": 0'))
    with pytest.raises(QueueInvalid):
        get_request(job.job, render_id)  # canonical bytes only
    path.write_bytes(pristine)
    assert get_request(job.job, render_id) == request


def test_v3_request_carries_its_storage_reservation(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    reservation = {"reservation_id": RESERVATION_ID, "token": RESERVATION_TOKEN,
                   "reserved_bytes": 4096}
    request = job.create(etag, storage_reservation=reservation)
    assert (request["storage_reservation_id"], request["storage_reservation_token"],
            request["storage_reserved_bytes"]) == (RESERVATION_ID, RESERVATION_TOKEN, 4096)
    for bad in ({**reservation, "reserved_bytes": 0}, {**reservation, "token": "x"},
                {**reservation, "extra": 1}):
        with pytest.raises(QueueInvalid):
            job.create(etag, storage_reservation=bad)


def test_legacy_create_is_unaffected_by_v3_requests_in_the_same_queue(tmp_path):
    job, _analysis, manifest, _source = fixture(tmp_path)
    v3 = V3Job(tmp_path / "v3")
    _doc, etag = v3.save(main__cut_fade_ms=20)
    v3_request = v3.create(etag, KEY)
    queue = job / "analysis" / "render-requests"
    queue.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(v3.request_path(v3_request["render_id"]),
                    queue / f"{v3_request['render_id']}.json")
    legacy = create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest),
                            "723e4567-e89b-42d3-a456-426614174000")
    assert legacy["version"] == "render-request-v1"
    with pytest.raises(QueueConflict):  # the key belongs to the v3 request
        create_request(job, manifest.identity.candidate_id, manifest_sha256(manifest), KEY)
    assert get_request(job, v3_request["render_id"])["version"] == "render-request-v3"


def test_v3_retention_prunes_old_terminal_requests_keeping_the_newest_200(tmp_path):
    assert (RETENTION_DAYS, RETENTION_KEEP) == (7, 200)
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    template = job.create(etag)
    base = json.loads(job.request_path(template["render_id"]).read_text())
    job.request_path(template["render_id"]).unlink()
    ids = []
    for index in range(260):  # one terminal request per hour, the newest last
        at = v3_stamp(V3_NOW - timedelta(hours=260 - index))
        render_id = str(uuid.uuid4())
        v3_write(job.request_path(render_id), {
            **base, "render_id": render_id, "idempotency_key": str(uuid.uuid4()),
            "state": "failed", "failed_at": at, "error_code": "render_failed", "attempts": 1,
            "claimed_at": at, "created_at": at, "updated_at": at})
        ids.append(render_id)
    month_ago = v3_stamp(V3_NOW - timedelta(days=30))
    queued_id = str(uuid.uuid4())
    v3_write(job.request_path(queued_id), {**base, "render_id": queued_id,
                                           "idempotency_key": str(uuid.uuid4()),
                                           "created_at": month_ago, "updated_at": month_ago})
    legacy_job, _analysis, manifest, _source = fixture(tmp_path / "legacy")
    legacy = create_request(legacy_job, manifest.identity.candidate_id,
                            manifest_sha256(manifest), KEY)
    legacy_path = legacy_job / "analysis" / "render-requests" / f"{legacy['render_id']}.json"
    shutil.copyfile(legacy_path, job.request_path(legacy["render_id"]))

    removed = prune_requests_v3(job.job, now=V3_NOW)
    left = {path.stem for path in job.queue.glob("*.json")}
    # 167 of the 260 are younger than 7 days; the newest 200 are kept regardless of age.
    assert removed == 60
    assert set(ids[60:]) <= left and not set(ids[:60]) & left
    assert queued_id in left  # a request that is not terminal is never pruned
    assert legacy["render_id"] in left  # legacy requests are not touched


def test_v3_1500_requests_created_over_time_never_hit_a_ceiling(tmp_path, monkeypatch):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    template = job.create(etag, now=V3_NOW - timedelta(days=30))
    cancel_request_v3(job.job, template["render_id"], now=V3_NOW - timedelta(days=30))
    prepared = render_queue._prepare_v3(job.job, job.clip_id, etag, resources=job.resources,
                                        verify_auto=v3_accept)

    def instant(_job_dir, _clip_id, _edit_etag, **_options):
        # each request is a new export whose file already exists (a key reuse)
        key = v3_sha(uuid.uuid4().bytes)
        return dataclasses.replace(
            prepared, render_key=key, completed_by="key", source_snapshot_relative=None,
            output_relative=f"output/edits/{job.clip_id}/{key[:16]}.mp4")

    monkeypatch.setattr(render_queue, "_prepare_v3", instant)
    peak = 0
    for index in range(1500):
        request = job.create(etag, now=V3_NOW + timedelta(hours=index))
        assert (request["state"], request["completed_by"]) == ("completed", "key")
        peak = max(peak, len(list(job.queue.glob("*.json"))))
    assert peak <= RETENTION_KEEP + 1  # one per hour: 168 per week, under the newest 200
    assert template["render_id"] not in {path.stem for path in job.queue.glob("*.json")}


def test_v3_list_is_newest_first_and_scoped_to_the_clip(tmp_path):
    job = V3Job(tmp_path)
    created = []
    for index in range(3):
        _doc, etag = job.save(main__cut_fade_ms=20 + index)
        created.append(job.create(etag, now=V3_NOW + timedelta(minutes=index)))
    listed = list_requests_v3(job.job, job.clip_id)
    assert [item["render_id"] for item in listed] == [r["render_id"] for r in reversed(created)]
    assert list_requests_v3(job.job, "clip_" + "0" * 24) == []


def test_v3_estimate_counts_the_output_and_never_writes(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    archive = job.clip / "edit" / "archive"
    before = sorted(path.name for path in archive.iterdir()) if archive.exists() else []
    expected = -(-V3_DURATION_MS * OUTPUT_BYTES_PER_SECOND // 1000) + 65_536
    assert estimate_v3(job.job, job.clip_id, etag) == expected
    assert estimate_v3(job.job, job.clip_id, job.seed_etag) == expected
    with pytest.raises(QueueRevisionConflict):
        estimate_v3(job.job, job.clip_id, "e" * 64)
    assert not job.queue.exists() or not list(job.queue.glob("*.json"))
    assert (sorted(path.name for path in archive.iterdir()) if archive.exists() else []) == before


# --- the v3 CLI (python -m ai_clipper.render_queue without --job-dir; CONTRACTS §5.9 envelope) --


def v3_cli(job: V3Job, **envelope) -> tuple[int, dict]:
    return render_queue.handle_v3(json.dumps(envelope).encode(), jobs_root=job.root,
                                  resources=job.resources, verify_auto=v3_accept)


def test_v3_cli_create_get_list_cancel_and_estimate(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    ids = {"jobId": job.job_id, "clipId": job.clip_id}
    status, estimate = v3_cli(job, op="estimate", **ids, editEtag=etag)
    assert status == 0 and int(estimate["bytes"]) > 0
    status, created = v3_cli(job, op="create", **ids, editEtag=etag, idempotencyKey=KEY,
                             storageReservation={"reservation_id": RESERVATION_ID,
                                                 "token": RESERVATION_TOKEN,
                                                 "reserved_bytes": 4096})
    assert status == 0 and created["request"]["state"] == "queued"
    render_id = created["request"]["render_id"]
    assert v3_cli(job, op="get", jobId=job.job_id, renderId=render_id) == (0, created)
    status, listed = v3_cli(job, op="list", **ids)
    assert status == 0 and [item["render_id"] for item in listed["requests"]] == [render_id]
    status, cancelled = v3_cli(job, op="cancel", jobId=job.job_id, renderId=render_id)
    assert status == 0 and cancelled["request"]["state"] == "cancelled"


@pytest.mark.parametrize(
    ("envelope", "status", "code"),
    [
        ({"op": "get", "renderId": "923e4567-e89b-42d3-a456-426614174000"}, 4, "not_found"),
        ({"op": "create", "clipId": "CLIP", "editEtag": "a" * 64, "idempotencyKey": KEY}, 2,
         "internal_error"),
        ({"op": "create", "editEtag": "e" * 64, "idempotencyKey": KEY}, 5, "revision_conflict"),
        ({"op": "drop"}, 2, "internal_error"),
        ({"op": "get", "renderId": "923e4567-e89b-42d3-a456-426614174000", "extra": 1}, 2,
         "internal_error"),
        ({"op": "get", "renderId": "../../../etc"}, 2, "internal_error"),
    ],
)
def test_v3_cli_failures_are_fixed_codes_without_paths(tmp_path, envelope, status, code):
    job = V3Job(tmp_path)
    envelope = {"jobId": job.job_id, **envelope}
    if envelope["op"] == "create" and "clipId" not in envelope:
        envelope["clipId"] = job.clip_id
    result_status, payload = v3_cli(job, **envelope)
    assert result_status == status
    assert payload["error"]["code"] == code
    assert payload["error"]["messageId"] == f"edit.{code}"
    assert str(tmp_path) not in json.dumps(payload)


def test_v3_cli_idempotency_and_source_codes(tmp_path):
    job = V3Job(tmp_path)
    _doc, etag = job.save(main__cut_fade_ms=20)
    ids = {"jobId": job.job_id, "clipId": job.clip_id}
    assert v3_cli(job, op="create", **ids, editEtag=etag, idempotencyKey=KEY)[0] == 0
    _doc2, etag2 = job.save(main__cut_fade_ms=30)
    status, payload = v3_cli(job, op="create", **ids, editEtag=etag2, idempotencyKey=KEY)
    assert (status, payload["error"]["code"]) == (9, "idempotency_conflict")
    job.source.unlink()
    status, payload = v3_cli(job, op="create", **ids, editEtag=etag2,
                             idempotencyKey="823e4567-e89b-42d3-a456-426614174000")
    assert (status, payload["error"]["code"]) == (4, "source_missing")


def test_v3_cli_runs_as_a_module_with_jobs_root_from_the_environment(tmp_path):
    job = V3Job(tmp_path)
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(job.root),
           "PYTHONPATH": os.pathsep.join(sys.path)}
    envelope = {"op": "list", "jobId": job.job_id, "clipId": job.clip_id}
    result = subprocess.run([sys.executable, "-m", "ai_clipper.render_queue"],
                            input=json.dumps(envelope).encode(), capture_output=True, env=env,
                            timeout=60, check=False)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"requests": []}
    legacy = subprocess.run([sys.executable, "-m", "ai_clipper.render_queue", "--job-dir",
                             str(job.job)], input=b'{"operation":"drop"}', capture_output=True,
                            env=env, timeout=60, check=False)
    assert (legacy.returncode, legacy.stderr) == (3, b"render_queue_invalid\n")
