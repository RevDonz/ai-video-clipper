"""CLI ``python -m ai_clipper.edit_v2.api``: envelope, ops and exit codes (plan §4.2, T1.1)."""

from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import make_clip, next_doc, tree

from ai_clipper.edit_v2 import COMPILER_ID, api, store
from ai_clipper.edit_v2 import seed as seed_module
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.clip_id import clip_id, ms_from_seconds
from ai_clipper.edit_v2.doc import canonical_bytes, doc_sha256
from ai_clipper.edit_v2.errors import MESSAGES
from ai_clipper.selection_types import SelectedClip, SelectionResult
from ai_clipper.selection_v3 import write_selection_artifact

ROOT = Path(__file__).resolve().parents[1]
NOW = fixtures.PUT_NOW_MS
SCORES = {"hook": 7.0, "standalone": 6.0, "payoff": 5.0, "emotion": 4.0, "shareability": 3.0}


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def call(jobs_root: Path, **envelope) -> tuple[int, dict]:
    return api.handle(json.dumps(envelope).encode(), jobs_root=jobs_root, now_ms=NOW)


def raw_call(jobs_root: Path, raw: bytes) -> tuple[int, dict]:
    return api.handle(raw, jobs_root=jobs_root, now_ms=NOW)


def b64(doc: dict) -> str:
    return base64.b64encode(canonical_bytes(doc)).decode()


@pytest.fixture
def clip(tmp_path, contexts) -> Path:
    return make_clip(tmp_path, contexts["c30"])


@pytest.fixture
def ids(contexts) -> dict:
    seed = contexts["c30"].seed
    return {"jobId": seed["base"]["job_id"], "clipId": seed["clip_id"]}


def assert_error(result: tuple[int, dict], exit_code: int, code: str) -> dict:
    status, payload = result
    assert status == exit_code, payload
    error = payload["error"]
    assert set(error) == {"code", "path", "ref", "messageId"}
    assert error["code"] == code
    assert error["messageId"] in {f"edit.{c}" for c in MESSAGES}
    return payload


# --- envelope ----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"not json",
        b"[]",
        b'{"op": "delete", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"}',
        b'{"op": "clips"}',
        b'{"op": "clips", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "extra": 1}',
        b'{"op": "clips", "jobId": "../../etc"}',
        b'{"op": "clips", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55/.."}',
        b'{"op": "get", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clipId": "clip_x"}',
        b'{"op": "get", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clipId": 5}',
        b'{"op": "clips", "jobId": "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "jobId": "x"}',
        b"{" + b" " * (3 << 20) + b"}",
    ],
)
def test_malformed_envelopes_are_usage_errors(tmp_path, raw):
    status, payload = raw_call(tmp_path, raw)
    assert status == 2
    assert payload["error"]["code"] == "internal_error"
    assert str(tmp_path) not in json.dumps(payload)


def test_put_envelope_fields_are_validated(tmp_path, ids, contexts):
    doc = next_doc(contexts["c30"].seed, fixtures.etag(contexts["c30"].seed))
    good = {"op": "put", **ids, "expectedEtag": fixtures.etag(contexts["c30"].seed),
            "idempotencyKey": str(uuid.uuid4()), "docRaw": b64(doc)}
    for change in ({"expectedEtag": "F" * 64}, {"expectedEtag": 1},
                   {"idempotencyKey": "k"}, {"docRaw": "***"}, {"docRaw": None}):
        status, _ = call(tmp_path, **{**good, **change})
        assert status == 2, change
    missing = dict(good)
    del missing["docRaw"]
    assert call(tmp_path, **missing)[0] == 2


def test_jobs_root_must_be_configured(ids):
    status, payload = api.handle(json.dumps({"op": "get", **ids}).encode(), jobs_root=None)
    assert status == 1 and payload["error"]["code"] == "internal_error"


def test_unknown_job_or_clip_is_not_found(tmp_path, clip, ids):
    assert_error(call(tmp_path, op="get", jobId=str(uuid.uuid4()), clipId=ids["clipId"]), 4,
                 "not_found")
    assert_error(call(tmp_path, op="get", jobId=ids["jobId"], clipId="clip_" + "0" * 24), 4,
                 "not_found")
    assert_error(call(tmp_path, op="clips", jobId=str(uuid.uuid4())), 4, "not_found")


# --- get / seed / put / archive ------------------------------------------------------------------


def test_get_returns_the_seed_as_virtual_revision_zero_and_writes_nothing(tmp_path, clip, ids,
                                                                          contexts):
    seed = contexts["c30"].seed
    before = tree(tmp_path)
    status, payload = call(tmp_path, op="get", **ids)
    assert status == 0
    words_sha = seed["base"]["words"]["sha256"]
    assert payload == {
        "doc": seed,
        "etag": fixtures.etag(seed),
        "isSeed": True,
        "seed": seed,
        "seedEtag": fixtures.etag(seed),
        "engine": COMPILER_ID,
        "notices": [],
        "words": {"sha256": words_sha,
                  "url": f"/api/jobs/{ids['jobId']}/clips/{ids['clipId']}/words"},
        "readOnly": False,
        "readOnlyReason": None,
    }
    assert call(tmp_path, op="seed", **ids) == (0, payload)
    assert tree(tmp_path) == before


def test_put_then_get_and_seed(tmp_path, clip, ids, contexts):
    seed = contexts["c30"].seed
    etag = fixtures.etag(seed)
    doc = next_doc(seed, etag, main__cut_fade_ms=12)
    idem = str(uuid.uuid4())
    status, saved = call(tmp_path, op="put", **ids, expectedEtag=etag, idempotencyKey=idem,
                         docRaw=b64(doc))
    assert status == 0
    assert set(saved) == {"doc", "etag", "warnings"}
    assert saved["doc"]["audit"]["updated_at_ms"] == NOW
    assert saved["etag"] == doc_sha256(saved["doc"]) and saved["warnings"] == []
    status, current = call(tmp_path, op="get", **ids)
    assert (current["doc"], current["etag"], current["isSeed"]) == (saved["doc"], saved["etag"],
                                                                    False)
    assert current["seed"] == seed
    status, reset = call(tmp_path, op="seed", **ids)
    assert (reset["doc"], reset["isSeed"]) == (seed, True)
    # Replay through the CLI returns the same result.
    assert call(tmp_path, op="put", **ids, expectedEtag=etag, idempotencyKey=idem,
                docRaw=b64(doc)) == (0, saved)


def test_put_error_mapping(tmp_path, clip, ids, contexts):
    seed = contexts["c30"].seed
    etag = fixtures.etag(seed)
    base = {"op": "put", **ids, "expectedEtag": etag}

    def attempt(raw: bytes, **extra):
        envelope = {**base, "idempotencyKey": str(uuid.uuid4()),
                    "docRaw": base64.b64encode(raw).decode(), **extra}
        return call(tmp_path, **envelope)

    invalid = assert_error(attempt(b'{"revision": 1.5}'), 3, "float_not_allowed")
    assert invalid["error"]["path"] == "/revision"
    assert invalid["errors"] == [{"code": "float_not_allowed", "path": "/revision"}]
    too_new = copy.deepcopy(seed)
    too_new["schema_minor"] = 2
    assert_error(attempt(canonical_bytes(too_new)), 7, "schema_too_new")
    semantic = next_doc(seed, etag, main__cut_fade_ms=99, captions__overrides__size_pm=5)
    payload = assert_error(attempt(canonical_bytes(semantic)), 6, "range_invalid")
    assert {e["path"] for e in payload["errors"]} == {"/main/cut_fade_ms",
                                                      "/captions/overrides/size_pm"}
    status, saved = attempt(canonical_bytes(next_doc(seed, etag)))
    assert status == 0
    conflict = assert_error(attempt(canonical_bytes(next_doc(seed, etag))), 5,
                            "revision_conflict")
    assert (conflict["current"], conflict["etag"]) == (saved["doc"], saved["etag"])
    idem = str(uuid.uuid4())
    first = next_doc(saved["doc"], saved["etag"])
    assert attempt(canonical_bytes(first), idempotencyKey=idem, expectedEtag=saved["etag"])[0] == 0
    other = next_doc(saved["doc"], saved["etag"], main__cut_fade_ms=1)
    assert_error(attempt(canonical_bytes(other), idempotencyKey=idem,
                         expectedEtag=saved["etag"]), 9, "idempotency_conflict")


def test_get_without_the_words_artifact_is_analysis_missing(tmp_path, clip, ids):
    for path in clip.glob("words.*.json"):
        path.unlink()
    assert_error(call(tmp_path, op="get", **ids), 8, "analysis_missing")


def test_a_changed_words_sha_opens_read_only(tmp_path, contexts):
    """The job re-ran: seed.json now names new words, the saved document the old ones."""
    context = contexts["c30"]
    old_seed = context.seed
    clip = make_clip(tmp_path, context)
    etag = fixtures.etag(old_seed)
    saved, saved_etag, _ = store.put(clip, expected_etag=etag, idempotency_key=str(uuid.uuid4()),
                                     raw=canonical_bytes(next_doc(old_seed, etag)), now_ms=NOW)
    new_words = copy.deepcopy(context.words)
    new_words["transcript_sha256"] = "c" * 64
    new_raw = canonical_bytes(new_words)
    new_sha = fixtures.sha256_hex(new_raw)
    (clip / f"words.{new_sha[:16]}.json").write_bytes(new_raw)
    new_seed = copy.deepcopy(old_seed)
    new_seed["base"]["words"]["sha256"] = new_sha
    (clip / "seed.json").write_bytes(canonical_bytes(new_seed))
    ids = {"jobId": old_seed["base"]["job_id"], "clipId": old_seed["clip_id"]}
    status, payload = call(tmp_path, op="get", **ids)
    assert status == 0
    assert (payload["doc"], payload["etag"]) == (saved, saved_etag)
    assert (payload["readOnly"], payload["readOnlyReason"]) == (True, "transcript_changed")
    assert payload["words"]["sha256"] == old_seed["base"]["words"]["sha256"]
    assert payload["seed"] == new_seed
    # Without the old words file the document is still shown read-only, with the new words.
    for path in clip.glob(f"words.{old_seed['base']['words']['sha256'][:16]}.json"):
        path.unlink()
    status, payload = call(tmp_path, op="get", **ids)
    assert status == 0 and payload["readOnly"] and payload["words"]["sha256"] == new_sha
    status, fresh = call(tmp_path, op="seed", **ids)
    assert (fresh["readOnly"], fresh["words"]["sha256"]) == (False, new_sha)
    # Saving the stale document is refused; "Mulai dari versi AI" (the new seed) is accepted.
    stale = next_doc(saved, saved_etag)
    assert_error(call(tmp_path, op="put", **ids, expectedEtag=saved_etag,
                      idempotencyKey=str(uuid.uuid4()), docRaw=b64(stale)), 6, "base_changed")
    restart = next_doc(new_seed, saved_etag)
    restart["revision"] = saved["revision"] + 1
    status, restarted = call(tmp_path, op="put", **ids, expectedEtag=saved_etag,
                             idempotencyKey=str(uuid.uuid4()), docRaw=b64(restart))
    assert status == 0 and restarted["doc"]["base"] == new_seed["base"]
    assert call(tmp_path, op="get", **ids)[1]["readOnly"] is False


def test_legacy_engine_seed_carries_the_notice(tmp_path, contexts):
    context = contexts["c30"]
    legacy = copy.deepcopy(context.seed)
    legacy["base"]["engine"]["compiler"] = "legacy"
    make_clip(tmp_path, context, seed=legacy)
    status, payload = call(tmp_path, op="get", jobId=legacy["base"]["job_id"],
                           clipId=legacy["clip_id"])
    assert status == 0
    assert (payload["engine"], payload["notices"]) == ("legacy", ["legacy_engine"])


def test_archive_op(tmp_path, clip, ids, contexts):
    seed = contexts["c30"].seed
    etag = fixtures.etag(seed)
    assert call(tmp_path, op="archive", **ids, etag=etag) == (
        0, {"relative": f"analysis/clips/{ids['clipId']}/seed.json", "revision": 0})
    _doc, new_etag, _ = store.put(clip, expected_etag=etag, idempotency_key=str(uuid.uuid4()),
                                  raw=canonical_bytes(next_doc(seed, etag)), now_ms=NOW)
    status, payload = call(tmp_path, op="archive", **ids, etag=new_etag)
    assert status == 0 and payload["revision"] == 1
    assert (tmp_path / ids["jobId"] / payload["relative"]).is_file()
    assert_error(call(tmp_path, op="archive", **ids, etag="e" * 64), 4, "not_found")
    assert call(tmp_path, op="archive", **ids, etag="xyz")[0] == 2


# --- clips ------------------------------------------------------------------------------------------

SOURCE_SHA = fixtures.SPECS["c30"].source_sha


def _selected(rank: int, start: float, end: float, cold_open, title: str) -> SelectedClip:
    return SelectedClip(
        rank=rank, start=start, end=end, cold_open=cold_open, unit_ids=("S0001", "S0002"),
        hook_unit_id="S0001", title=title, hook_text=f"Hook {rank}", description="",
        hashtags=("#lucu", "#viral"), archetype="humor", score=7.5, scores=SCORES,
        reasons=("alasan",), source="llm", text="teks klip")


CLIPS = (
    _selected(1, 1241.93, 1309.4, (1275.2, 1279.7), "Klip satu"),
    _selected(2, 100.0, 140.5, None, "Klip dua"),
    _selected(3, 200.25, 260.0, (230.1, 232.6), "Klip tiga"),
)


def _clip_id(clip: SelectedClip, cold_open: bool = True) -> str:
    co = None
    if cold_open and clip.cold_open is not None:
        co = (ms_from_seconds(clip.cold_open[0]), ms_from_seconds(clip.cold_open[1]))
    return clip_id(SOURCE_SHA, ms_from_seconds(clip.start), ms_from_seconds(clip.end), co)


def make_job(root: Path, contexts, *, mode: str = "v3", prepared: bool = True,
             engine: str = COMPILER_ID, cold_open: bool = True, seeds: tuple[int, ...] = (1, 2, 3),
             transcript: bool = True, source: bool = True, selection: bool = True,
             attempts: bool = False) -> tuple[str, Path]:
    job_id = str(uuid.uuid4())
    job = root / job_id
    (job / "input").mkdir(parents=True)
    (job / "output").mkdir()
    (job / "analysis").mkdir()
    source_path = job / "input" / "source.mp4"
    if source:
        source_path.write_bytes(b"not really a video")
    options = {"renderMode": "fit-blur", "limit": 3, "minDuration": 20, "maxDuration": 60,
               "selectionMode": mode}
    if mode == "v3":
        options.update(llmMode="auto", coldOpen=cold_open, hookOverlay=True,
                       captionStyle="karaoke")
    (job / "job.json").write_text(json.dumps({
        "id": job_id, "status": "completed", "source": {"type": "upload"},
        "sourcePath": str(source_path), "options": options, "clips": []}))
    manifest_clips = [{"index": clip.rank, "start": clip.start, "end": clip.end,
                       "title": clip.title, "output": str(job / "output" / f"clip-{clip.rank:02d}.mp4")}
                      for clip in CLIPS]
    (job / "output" / "manifest.json").write_text(json.dumps({"status": "completed",
                                                             "clips": manifest_clips}))
    if transcript:
        (job / "output" / "transcript.json").write_text('{"language": "id", "segments": []}')
    if attempts:
        (job / ".attempts" / "a1" / "analysis").mkdir(parents=True)
    if mode == "v3" and selection:
        write_selection_artifact(job / "analysis" / "selection.v3.json", SelectionResult(
            clips=CLIPS, source="llm", status="completed", provider="openrouter",
            model="m", prompt_version="v3.0"))
    if prepared:
        (job / "analysis" / "source.json").write_text(json.dumps(
            {"content_sha256": SOURCE_SHA, "probe": {}}))
        context = contexts["c30"]
        for rank in seeds:
            clip = CLIPS[rank - 1]
            seed = copy.deepcopy(context.seed)
            seed["clip_id"] = _clip_id(clip, cold_open)
            seed["base"]["job_id"] = job_id
            seed["base"]["engine"]["compiler"] = engine
            make_clip(root, context, job_id=job_id, seed=seed)
    return job_id, job


def by_index(payload: dict) -> dict[int, dict]:
    return {entry["index"]: entry for entry in payload["clips"]}


def test_clips_of_a_prepared_v3_job(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    before = tree(tmp_path)
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 0
    assert tree(tmp_path) == before
    clips = by_index(payload)
    assert sorted(clips) == [1, 2, 3]
    first = clips[1]
    assert first["clipId"] == _clip_id(CLIPS[0]) == contexts["c30"].seed["clip_id"]
    seed = contexts["c30"].seed
    fps = tm.Fps.from_json(seed["output"]["fps"])
    total = tm.total_frames(tm.pieces(seed))
    assert first == {
        "clipId": first["clipId"], "index": 1, "title": "Klip satu", "hookText": "Hook 1",
        "description": None, "hashtags": ["#lucu", "#viral"],
        "durationMs": tm.div_round_half_up(total * 1000 * fps.den, fps.num),
        "engine": COMPILER_ID,
        "edit": {"state": "seed", "revision": 0, "etag": clips[1]["edit"]["etag"],
                 "updatedAtMs": seed["audit"]["updated_at_ms"]},
        "latestRender": None, "openable": True, "reason": None,
    }
    assert {entry["clipId"] for entry in clips.values()} == {_clip_id(c) for c in CLIPS}
    # An edited clip reports its revision.
    clip_dir = job / "analysis" / "clips" / clips[2]["clipId"]
    current, etag, _ = store.get(clip_dir)
    _saved, new_etag, _ = store.put(clip_dir, expected_etag=etag,
                                    idempotency_key=str(uuid.uuid4()),
                                    raw=canonical_bytes(next_doc(current, etag)), now_ms=NOW)
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert by_index(payload)[2]["edit"] == {"state": "edited", "revision": 1, "etag": new_etag,
                                            "updatedAtMs": NOW}


def test_clip_ids_ignore_the_cold_open_when_the_job_ran_without_it(tmp_path, contexts):
    job_id, _job = make_job(tmp_path, contexts, cold_open=False)
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 0
    clips = by_index(payload)
    assert clips[1]["clipId"] == _clip_id(CLIPS[0], cold_open=False) != _clip_id(CLIPS[0])
    assert all(entry["openable"] for entry in clips.values())


def test_clips_of_a_legacy_engine_job(tmp_path, contexts):
    job_id, _job = make_job(tmp_path, contexts, engine="legacy")
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 0
    assert {(e["engine"], e["openable"], e["reason"]) for e in payload["clips"]} == {
        ("legacy", True, None)}


def test_clips_of_an_unprepared_job_need_prepare(tmp_path, contexts):
    job_id, _job = make_job(tmp_path, contexts, prepared=False)
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 0
    for entry in payload["clips"]:
        assert (entry["clipId"], entry["openable"], entry["reason"]) == (None, False,
                                                                         "needs_prepare")
        assert entry["edit"] is None and entry["engine"] is None
    clips = by_index(payload)
    assert clips[3]["durationMs"] == (260_000 - 200_250) + (232_600 - 230_100)
    assert clips[2]["title"] == "Klip dua"


def test_a_clip_whose_seed_is_missing_after_prepare(tmp_path, contexts):
    job_id, _job = make_job(tmp_path, contexts, seeds=(1, 3))
    clips = by_index(call(tmp_path, op="clips", jobId=job_id)[1])
    assert (clips[2]["clipId"], clips[2]["openable"], clips[2]["reason"]) == (
        _clip_id(CLIPS[1]), False, "needs_prepare")
    assert clips[1]["openable"] and clips[3]["openable"]


@pytest.mark.parametrize(
    ("options", "reason", "has_ids"),
    [
        ({"prepared": False, "transcript": False}, "transcript_missing", False),
        ({"source": False}, "source_missing", True),
        ({"source": False, "prepared": False}, "source_missing", False),
        ({"selection": False}, "selection_unreadable", False),
        ({"selection": False, "attempts": True}, "analysis_incomplete", False),
        ({"mode": "v1", "prepared": False}, "not_v3", False),
        ({"mode": "v2-shadow", "prepared": False}, "not_v3", False),
    ],
)
def test_clips_that_cannot_be_opened_say_why(tmp_path, contexts, options, reason, has_ids):
    job_id, _job = make_job(tmp_path, contexts, **options)
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 0
    assert sorted(by_index(payload)) == [1, 2, 3]
    for entry in payload["clips"]:
        assert (entry["openable"], entry["reason"]) == (False, reason)
        assert (entry["clipId"] is not None) == has_ids
    assert reason in MESSAGES


def test_a_corrupt_stored_seed_is_an_internal_error_not_a_usage_error(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts, seeds=(1,))
    seed_path = job / "analysis" / "clips" / _clip_id(CLIPS[0]) / "seed.json"
    broken = json.loads(seed_path.read_bytes())
    body = next(s for s in broken["main"]["segments"] if s["role"] == "body")
    body["out_sf"] = body["in_sf"] - 1  # canonical bytes, impossible geometry
    seed_path.write_bytes(canonical_bytes(broken))
    status, payload = call(tmp_path, op="clips", jobId=job_id)
    assert status == 1 and payload["error"]["code"] == "internal_error"


def test_an_unreadable_selection_artifact(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    (job / "analysis" / "selection.v3.json").write_text("{broken")
    payload = call(tmp_path, op="clips", jobId=job_id)[1]
    assert {e["reason"] for e in payload["clips"]} == {"selection_unreadable"}
    (job / "analysis" / "selection.v3.json").unlink()
    (job / "analysis" / "selection.v3.json").symlink_to(job / "job.json")
    payload = call(tmp_path, op="clips", jobId=job_id)[1]
    assert {e["reason"] for e in payload["clips"]} == {"selection_unreadable"}


# --- prepare_job ------------------------------------------------------------------------------------


def test_prepare_job_runs_the_seed_prepare_contract(tmp_path, contexts, monkeypatch):
    job_id, job = make_job(tmp_path, contexts, prepared=False)
    calls = []

    def fake(job_dir: Path) -> list[dict]:
        calls.append(job_dir)
        return [{"clip_id": "clip_" + "a" * 24, "index": 1, "openable": True, "reason": None},
                {"clip_id": None, "index": 2, "openable": False, "reason": "transcript_missing"}]

    monkeypatch.setattr(seed_module, "prepare_legacy_job", fake)
    status, payload = call(tmp_path, op="prepare_job", jobId=job_id)
    assert status == 0
    assert calls == [job]
    assert payload == {"state": "done", "clips": [
        {"clipId": "clip_" + "a" * 24, "index": 1, "openable": True, "reason": None},
        {"clipId": None, "index": 2, "openable": False, "reason": "transcript_missing"}]}
    assert_error(call(tmp_path, op="prepare_job", jobId=str(uuid.uuid4())), 4, "not_found")


def test_prepare_job_rejects_a_malformed_result(tmp_path, contexts, monkeypatch):
    job_id, _job = make_job(tmp_path, contexts, prepared=False)
    monkeypatch.setattr(seed_module, "prepare_legacy_job",
                        lambda job_dir: [{"clip_id": "../x", "index": 1, "openable": True,
                                          "reason": None}])
    assert_error(call(tmp_path, op="prepare_job", jobId=job_id), 1, "internal_error")


def test_prepare_job_failure_is_a_sanitised_internal_error(tmp_path, contexts, monkeypatch):
    job_id, _job = make_job(tmp_path, contexts, prepared=False)

    def boom(job_dir):
        raise RuntimeError(f"secret path {job_dir}")

    monkeypatch.setattr(seed_module, "prepare_legacy_job", boom)
    status, payload = call(tmp_path, op="prepare_job", jobId=job_id)
    assert status == 1 and payload["error"]["code"] == "internal_error"
    assert "secret" not in json.dumps(payload)


# --- the real process boundary -----------------------------------------------------------------------


def _run_cli(envelope: dict, jobs_root: Path, *args: str) -> subprocess.CompletedProcess:
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(jobs_root),
           "PYTHONPATH": str(ROOT / "src")}
    return subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.api", *args],
                          input=json.dumps(envelope).encode(), capture_output=True, env=env,
                          timeout=60, check=False)


def test_cli_process_writes_one_json_line_and_exits_with_the_fixed_code(tmp_path, clip, ids):
    result = _run_cli({"op": "get", **ids}, tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.endswith(b"\n") and result.stdout.count(b"\n") == 1
    assert json.loads(result.stdout)["isSeed"] is True
    missing = _run_cli({"op": "get", "jobId": ids["jobId"], "clipId": "clip_" + "0" * 24},
                       tmp_path)
    assert missing.returncode == 4
    assert json.loads(missing.stdout)["error"]["messageId"] == "edit.not_found"
    assert _run_cli({"op": "get", **ids}, tmp_path, "--analysis-dir", "/x").returncode == 2
