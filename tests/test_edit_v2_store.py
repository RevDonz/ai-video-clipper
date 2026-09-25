"""Per-clip document store: virtual revision 0, PUT rules, receipts, archive (plan §4.1, §4.4).

Includes the in-process QG-PERSIST soak (5,000 consecutive saves) and the ported crash
reconciliation cases of ``test_editor_api.py``. Set ``POTONGIN_GATE_EVIDENCE=1`` to (re)write
the gate evidence under ``docs/editor/evidence/W1/``; ``POTONGIN_GATES=1`` also runs the timing
gate (in-process PUT p95 <= 30 ms for a 100 KB document), which is not a unit test because it
depends on the machine.
"""

from __future__ import annotations

import copy
import gzip
import hashlib
import json
import os
import platform
import stat
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import store
from ai_clipper.edit_v2.doc import canonical_bytes, parse_doc
from ai_clipper.edit_v2.errors import (
    AnalysisMissing,
    DocInvalid,
    DocSemanticInvalid,
    EditV2Error,
    IdempotencyConflict,
    NotFound,
    RevisionConflict,
    SchemaTooNew,
)

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "docs" / "editor" / "evidence" / "W1"
CASES = fixtures.load_cases()
NOW = fixtures.PUT_NOW_MS


# --- helpers (also used by test_edit_v2_api.py) -----------------------------------------------------


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def key() -> str:
    return str(uuid.uuid4())


def make_clip(root: Path, context: fixtures.Context, *, job_id: str | None = None,
              seed: dict | None = None, words: dict | None = None,
              assets: dict | None = None) -> Path:
    """``<root>/<job>/analysis/clips/<clip_id>`` with seed.json, the words file and the job's
    asset store (document-form metadata in ``analysis/assets/<hex>.json``)."""
    seed = context.seed if seed is None else seed
    words = context.words if words is None else words
    job = root / (job_id or seed["base"]["job_id"])
    clip = job / "analysis" / "clips" / seed["clip_id"]
    clip.mkdir(parents=True)
    (clip / "seed.json").write_bytes(canonical_bytes(seed))
    os.chmod(clip / "seed.json", 0o600)
    words_raw = canonical_bytes(words)
    (clip / f"words.{sha(words_raw)[:16]}.json").write_bytes(words_raw)
    asset_dir = job / "analysis" / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    for asset_id, meta in (context.assets if assets is None else assets).items():
        (asset_dir / f"{asset_id.removeprefix('sha256:')}.json").write_text(json.dumps(meta))
    return clip


def next_doc(current: dict, etag: str, **changes) -> dict:
    doc = copy.deepcopy(current)
    doc["revision"] = current["revision"] + 1
    doc["parent_sha256"] = etag
    doc["audit"]["editor"] = "editor-v3/1.0.0"
    doc["audit"]["last_command"] = changes.pop("command", "SetCutFade")
    for path, value in changes.items():
        target = doc
        parts = path.split("__")
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]] = value
    return doc


def put(clip: Path, doc: dict, etag: str, *, idem: str | None = None, now: int = NOW):
    return store.put(clip, expected_etag=etag, idempotency_key=idem or key(),
                     raw=canonical_bytes(doc), now_ms=now)


def tree(root: Path) -> dict[str, tuple[int, int, int]]:
    """Every path under root with (mode, size, mtime_ns): a directory listing to diff."""
    result = {}
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        result[path.relative_to(root).as_posix()] = (info.st_mode, info.st_size,
                                                     info.st_mtime_ns)
    return result


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


@pytest.fixture
def clip(tmp_path, contexts) -> Path:
    return make_clip(tmp_path, contexts["c30"])


@pytest.fixture
def seed_etag(contexts) -> str:
    return fixtures.etag(contexts["c30"].seed)


# --- fixture classification through PUT --------------------------------------------------------------


@pytest.mark.parametrize("case", [c for c in CASES if c.check == "put"],
                         ids=[c.file for c in CASES if c.check == "put"])
def test_every_put_fixture_is_classified_with_its_exact_code(tmp_path, contexts, case):
    context = contexts[case.context]
    clip = make_clip(tmp_path, context)
    etag = fixtures.etag(context.seed)
    before = tree(clip)
    try:
        doc, new_etag, warnings = store.put(clip, expected_etag=etag, idempotency_key=key(),
                                            raw=case.raw(), now_ms=NOW)
    except (DocInvalid, DocSemanticInvalid, SchemaTooNew) as error:
        assert case.code is not None, (case.file, error.code, error.path)
        assert error.code == case.code
        issues = error.issues
        assert issues, case.file
        assert {issue.code for issue in issues} == {case.code}
        assert case.path in {issue.path for issue in issues}
        # A rejected PUT publishes nothing.
        after = tree(clip)
        assert {k: v for k, v in after.items() if k.startswith("edit/doc")} == {}
        assert {k for k in after if k in before} == set(before)
        return
    assert case.code is None, case.file
    assert set(case.warnings) <= {w.code for w in warnings}
    assert doc["revision"] == 1
    assert (clip / store.DOC_FILE).read_bytes() == canonical_bytes(doc)
    assert new_etag == sha(canonical_bytes(doc))


# --- GET ------------------------------------------------------------------------------------------


def test_get_of_a_seed_is_virtual_revision_zero_and_writes_nothing(tmp_path, contexts, clip,
                                                                    seed_etag):
    job = clip.parents[2]
    before = tree(job)
    for _ in range(3):
        doc, etag, is_seed = store.get(clip)
        assert (doc, etag, is_seed) == (contexts["c30"].seed, seed_etag, True)
        assert store.seed(clip) == (contexts["c30"].seed, seed_etag)
    assert tree(job) == before
    assert not (clip / "edit").exists()


def test_get_returns_the_current_revision_after_a_put(clip, contexts, seed_etag):
    saved, etag, _ = put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    doc, current, is_seed = store.get(clip)
    assert (doc, current, is_seed) == (saved, etag, False)
    assert store.seed(clip) == (contexts["c30"].seed, seed_etag)
    job = clip.parents[2]
    before = tree(job)
    store.get(clip)
    assert tree(job) == before


def test_missing_clip_or_seed_is_not_found(tmp_path, clip):
    with pytest.raises(NotFound):
        store.get(tmp_path / "nope")
    (clip / store.SEED_FILE).unlink()
    with pytest.raises(NotFound):
        store.get(clip)
    with pytest.raises(NotFound):
        store.seed(clip)


def test_symlinked_documents_are_never_followed(tmp_path, clip, contexts, seed_etag):
    put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    target = tmp_path / "elsewhere.json"
    target.write_bytes((clip / store.DOC_FILE).read_bytes())
    (clip / store.DOC_FILE).unlink()
    (clip / store.DOC_FILE).symlink_to(target)
    with pytest.raises(EditV2Error) as caught:
        store.get(clip)
    assert caught.value.code == "internal_error"
    link = tmp_path / "link"
    link.symlink_to(clip, target_is_directory=True)
    with pytest.raises(EditV2Error):
        store.get(link)


def test_a_non_canonical_stored_document_is_rejected(clip, contexts, seed_etag):
    saved, _, _ = put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    (clip / store.DOC_FILE).write_bytes(json.dumps(saved, indent=1).encode())
    with pytest.raises(EditV2Error) as caught:
        store.get(clip)
    assert caught.value.code == "internal_error"


# --- PUT rules -----------------------------------------------------------------------------------


def test_put_writes_canonical_0600_files_in_0700_directories(clip, contexts, seed_etag):
    doc, etag, warnings = put(clip, next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=9),
                              seed_etag)
    path = clip / store.DOC_FILE
    assert path.read_bytes() == canonical_bytes(doc)
    assert etag == sha(path.read_bytes())
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    for directory in ("edit", store.RECEIPTS_DIR):
        assert stat.S_IMODE((clip / directory).stat().st_mode) == 0o700
    [receipt] = (clip / store.RECEIPTS_DIR).iterdir()
    assert stat.S_IMODE(receipt.stat().st_mode) == 0o600
    assert doc["main"]["cut_fade_ms"] == 9 and warnings == ()
    assert not list(clip.rglob("*.tmp"))


def test_if_match_must_be_the_current_etag(clip, contexts, seed_etag):
    first, etag1, _ = put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    stale = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=12)
    with pytest.raises(RevisionConflict) as caught:
        put(clip, stale, seed_etag)
    assert (caught.value.current, caught.value.etag) == (first, etag1)
    assert caught.value.code == "revision_conflict"
    assert store.get(clip)[1] == etag1


def test_revision_and_parent_rules(clip, contexts, seed_etag):
    seed = contexts["c30"].seed
    for changes, code, path in (
        ({"revision": 2}, "revision_mismatch", "/revision"),
        ({"revision": 0}, "revision_mismatch", "/revision"),
        ({"parent_sha256": "0" * 64}, "parent_mismatch", "/parent_sha256"),
    ):
        doc = next_doc(seed, seed_etag, **changes)
        with pytest.raises(DocSemanticInvalid) as caught:
            put(clip, doc, seed_etag)
        assert (caught.value.code, caught.value.path) == (code, path)
    assert not (clip / store.DOC_FILE).exists()


def test_base_and_created_at_are_immutable(clip, contexts, seed_etag):
    seed = contexts["c30"].seed
    for changes, path in (
        ({"base__window_ms": [0, 10]}, "/base/window_ms/0"),
        ({"audit__created_at_ms": 1}, "/audit/created_at_ms"),
        ({"clip_id": "clip_" + "1" * 24}, "/clip_id"),
    ):
        with pytest.raises(DocSemanticInvalid) as caught:
            put(clip, next_doc(seed, seed_etag, **changes), seed_etag)
        assert caught.value.code == "base_changed"
        assert path in {issue.path for issue in caught.value.issues}


def test_server_stamps_updated_at(clip, contexts, seed_etag):
    seed = contexts["c30"].seed
    created = seed["audit"]["created_at_ms"]
    # The client's value is ignored; a clock behind the stored revision still moves forward.
    doc = next_doc(seed, seed_etag, audit__updated_at_ms=5)
    saved, etag, _ = put(clip, doc, seed_etag, now=created - 1000)
    assert saved["audit"]["updated_at_ms"] == created + 1
    saved2, etag2, _ = put(clip, next_doc(saved, etag), etag, now=created - 5)
    assert saved2["audit"]["updated_at_ms"] == created + 2
    saved3, _, _ = put(clip, next_doc(saved2, etag2), etag2, now=NOW)
    assert saved3["audit"]["updated_at_ms"] == NOW
    stored = json.loads((clip / store.DOC_FILE).read_bytes())
    assert stored == saved3


def test_client_updated_at_must_still_be_an_integer(clip, contexts, seed_etag):
    doc = next_doc(contexts["c30"].seed, seed_etag, audit__updated_at_ms="later")
    with pytest.raises(DocSemanticInvalid) as caught:
        put(clip, doc, seed_etag)
    assert (caught.value.code, caught.value.path) == ("range_invalid", "/audit/updated_at_ms")
    # Required like every other key: the server stamps it, it never adds it.
    del doc["audit"]["updated_at_ms"]
    with pytest.raises(DocSemanticInvalid) as caught:
        put(clip, doc, seed_etag)
    assert {(i.code, i.path) for i in caught.value.issues} == {
        ("range_invalid", "/audit/updated_at_ms")}
    assert not (clip / store.DOC_FILE).exists()


def test_stamping_a_document_whose_text_mentions_the_audit_key(clip, contexts, seed_etag):
    """The stamped bytes are the canonical bytes of the stamped document, whatever the text."""
    doc = next_doc(contexts["c30"].seed, seed_etag, audit__updated_at_ms=1)
    doc["tracks"][0]["items"][0]["payload"]["text"] = 'Kata "updated_at_ms":1 di hook'
    saved, etag, _ = put(clip, doc, seed_etag)
    assert saved["audit"]["updated_at_ms"] == NOW
    assert saved["tracks"][0]["items"][0]["payload"]["text"] == 'Kata "updated_at_ms":1 di hook'
    assert (clip / store.DOC_FILE).read_bytes() == canonical_bytes(saved)
    assert etag == sha(canonical_bytes(saved))


def test_parse_errors_come_before_the_lock_and_publish_nothing(clip, seed_etag):
    for raw, error_type in ((b"{", DocInvalid),
                            (b'{"schema_minor": 3}', SchemaTooNew)):
        with pytest.raises(error_type):
            store.put(clip, expected_etag=seed_etag, idempotency_key=key(), raw=raw, now_ms=NOW)
    assert not (clip / "edit").exists()


def test_argument_validation(clip, contexts, seed_etag):
    raw = canonical_bytes(next_doc(contexts["c30"].seed, seed_etag))
    for kwargs in ({"expected_etag": "abc"}, {"idempotency_key": "../../x"},
                   {"idempotency_key": "not-a-uuid"}, {"now_ms": -1}, {"now_ms": 1.5}):
        arguments = {"expected_etag": seed_etag, "idempotency_key": key(), "raw": raw,
                     "now_ms": NOW, **kwargs}
        with pytest.raises((ValueError, TypeError)):
            store.put(clip, **arguments)
    assert not (clip / store.DOC_FILE).exists()


def test_missing_words_artifact_is_analysis_missing(clip, contexts, seed_etag):
    for path in clip.glob("words.*.json"):
        path.unlink()
    with pytest.raises(AnalysisMissing):
        put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)


def test_a_words_file_that_does_not_match_its_sha_is_rejected(clip, contexts, seed_etag):
    [path] = clip.glob("words.*.json")
    path.write_bytes(path.read_bytes() + b" ")
    with pytest.raises(EditV2Error) as caught:
        put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    assert caught.value.code == "internal_error"


def test_assets_come_from_the_job_asset_store(tmp_path, contexts):
    context = contexts["c30"]
    clip = make_clip(tmp_path, context, assets={})
    etag = fixtures.etag(context.seed)
    raw = (fixtures.DOC_FIXTURES_DIR / "valid" / "logo__c30.json").read_bytes()
    with pytest.raises(DocSemanticInvalid) as caught:
        store.put(clip, expected_etag=etag, idempotency_key=key(), raw=raw, now_ms=NOW)
    assert caught.value.code == "asset_missing"
    store_dir = clip.parents[1] / "assets"
    for asset_id, meta in context.assets.items():
        (store_dir / f"{asset_id[7:]}.json").write_text(json.dumps({**meta, "extra": 1}))
    doc, _, _ = store.put(clip, expected_etag=etag, idempotency_key=key(), raw=raw, now_ms=NOW)
    assert doc["tracks"][1]["items"][0]["type"] == "image"


def test_concurrent_puts_on_one_etag_have_exactly_one_winner(clip, contexts, seed_etag):
    seed = contexts["c30"].seed
    results: list[object] = []

    def worker(value: int) -> None:
        try:
            results.append(put(clip, next_doc(seed, seed_etag, main__cut_fade_ms=value),
                               seed_etag))
        except RevisionConflict as error:
            results.append(error)

    threads = [threading.Thread(target=worker, args=(value,)) for value in range(10, 18)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    wins = [r for r in results if isinstance(r, tuple)]
    assert len(wins) == 1 and len(results) == 8
    assert store.get(clip)[0] == wins[0][0]


# --- archive ----------------------------------------------------------------------------------------


def test_superseded_revisions_are_archived_as_deterministic_gzip(clip, contexts, seed_etag):
    doc1, etag1, _ = put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    archive = clip / store.ARCHIVE_DIR
    assert not archive.exists() or not list(archive.iterdir())  # revision 0 is seed.json
    put(clip, next_doc(doc1, etag1, main__cut_fade_ms=20), etag1)
    [entry] = archive.iterdir()
    assert entry.name == f"r1.{etag1}.json.gz"
    data = entry.read_bytes()
    assert gzip.decompress(data) == canonical_bytes(doc1)
    assert data == gzip.compress(canonical_bytes(doc1), compresslevel=store.ARCHIVE_GZIP_LEVEL,
                                 mtime=0)
    assert data[4:8] == b"\0\0\0\0"  # gzip MTIME
    assert stat.S_IMODE(entry.stat().st_mode) == 0o600
    assert stat.S_IMODE(archive.stat().st_mode) == 0o700


def test_archive_for_render(clip, contexts, seed_etag):
    seed = contexts["c30"].seed
    clip_id = seed["clip_id"]
    assert store.archive_for_render(clip, seed_etag) == (f"analysis/clips/{clip_id}/seed.json", 0)
    doc1, etag1, _ = put(clip, next_doc(seed, seed_etag), seed_etag)
    relative = f"analysis/clips/{clip_id}/edit/archive/r1.{etag1}.json.gz"
    assert store.archive_for_render(clip, etag1) == (relative, 1)
    job = clip.parents[2]
    assert gzip.decompress((job / relative).read_bytes()) == canonical_bytes(doc1)
    before = tree(job)
    assert store.archive_for_render(clip, etag1) == (relative, 1)  # idempotent
    assert tree(job) == before
    _doc2, etag2, _ = put(clip, next_doc(doc1, etag1, main__cut_fade_ms=3), etag1)
    assert store.archive_for_render(clip, etag1) == (relative, 1)  # archived: still found
    assert store.archive_for_render(clip, etag2)[1] == 2
    with pytest.raises(NotFound):
        store.archive_for_render(clip, "f" * 64)
    with pytest.raises(ValueError):
        store.archive_for_render(clip, "../seed")


# --- idempotency receipts -------------------------------------------------------------------------------


def test_replay_returns_the_same_result_and_a_different_payload_conflicts(clip, contexts,
                                                                          seed_etag):
    idem = key()
    doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=11)
    saved = put(clip, doc, seed_etag, idem=idem)
    replayed = put(clip, doc, seed_etag, idem=idem, now=NOW + 99_999)
    assert replayed == saved
    assert store.get(clip)[0]["revision"] == 1
    # The key is case-insensitive (stored lower case).
    assert put(clip, doc, seed_etag, idem=idem.upper()) == saved
    changed = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=12)
    with pytest.raises(IdempotencyConflict):
        put(clip, changed, seed_etag, idem=idem)
    # A different If-Match with the same key is a different payload too.
    with pytest.raises(IdempotencyConflict):
        put(clip, doc, "0" * 64, idem=idem)


def test_receipts_are_digest_only(clip, contexts, seed_etag):
    idem = key()
    doc = next_doc(contexts["c30"].seed, seed_etag)
    doc["tracks"][0]["items"][0]["payload"]["text"] = "Rahasia teks hook"
    saved, etag, _ = put(clip, doc, seed_etag, idem=idem)
    path = clip / store.RECEIPTS_DIR / f"{idem}.json"
    raw = path.read_bytes()
    receipt = json.loads(raw)
    assert raw == canonical_bytes(receipt)
    assert set(receipt) == {"key", "payload_sha256", "state", "result_etag", "result_revision",
                            "at_ms"}
    assert receipt == {
        "key": idem,
        "payload_sha256": sha(seed_etag.encode() + b"\0" + canonical_bytes(doc)),
        "state": "committed",
        "result_etag": etag,
        "result_revision": 1,
        "at_ms": saved["audit"]["updated_at_ms"],
    }
    assert b"Rahasia" not in raw and len(raw) < 400


def test_replay_of_a_superseded_save_returns_the_archived_revision(clip, contexts, seed_etag):
    idem = key()
    doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=11)
    first = put(clip, doc, seed_etag, idem=idem)
    put(clip, next_doc(first[0], first[1], main__cut_fade_ms=13), first[1])
    assert put(clip, doc, seed_etag, idem=idem) == first
    # Once the archive is gone (retention), the replay is an ordinary conflict.
    for entry in (clip / store.ARCHIVE_DIR).iterdir():
        entry.unlink()
    with pytest.raises(RevisionConflict):
        put(clip, doc, seed_etag, idem=idem)


def _crash(monkeypatch, name: str, *, when=lambda *args, **kwargs: True):
    real = getattr(store, name)

    def failing(*args, **kwargs):
        if when(*args, **kwargs):
            monkeypatch.setattr(store, name, real)
            raise RuntimeError("crash")
        return real(*args, **kwargs)

    monkeypatch.setattr(store, name, failing)


def test_retry_recovers_when_the_process_dies_after_the_pending_receipt(
        clip, contexts, seed_etag, monkeypatch):
    doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=21)
    idem = key()
    _crash(monkeypatch, "_publish")
    with pytest.raises(RuntimeError, match="crash"):
        put(clip, doc, seed_etag, idem=idem, now=NOW)
    assert store.get(clip)[2] is True
    receipt = json.loads((clip / store.RECEIPTS_DIR / f"{idem}.json").read_bytes())
    assert receipt["state"] == "pending"
    recovered = put(clip, doc, seed_etag, idem=idem, now=NOW + 5000)
    # The retry publishes exactly the revision the pending receipt promised.
    assert recovered[1] == receipt["result_etag"]
    assert recovered[0]["audit"]["updated_at_ms"] == receipt["at_ms"] == NOW
    assert put(clip, doc, seed_etag, idem=idem) == recovered
    assert json.loads((clip / store.RECEIPTS_DIR / f"{idem}.json").read_bytes())["state"] == \
        "committed"


def test_retry_recovers_when_the_process_dies_after_the_document_is_published(
        clip, contexts, seed_etag, monkeypatch):
    doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=22)
    idem = key()
    _crash(monkeypatch, "_write_receipt", when=lambda _clip, receipt, **kw:
           receipt["state"] == "committed")
    with pytest.raises(RuntimeError, match="crash"):
        put(clip, doc, seed_etag, idem=idem)
    current = store.get(clip)
    assert current[0]["revision"] == 1
    recovered = put(clip, doc, seed_etag, idem=idem, now=NOW + 777)
    assert recovered[:2] == current[:2]
    assert put(clip, doc, seed_etag, idem=idem)[1] == current[1]


def test_published_then_superseded_pending_save_is_recovered_from_the_archive(
        clip, contexts, seed_etag, monkeypatch):
    doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=23)
    idem = key()
    _crash(monkeypatch, "_write_receipt", when=lambda _clip, receipt, **kw:
           receipt["state"] == "committed")
    with pytest.raises(RuntimeError):
        put(clip, doc, seed_etag, idem=idem)
    published = store.get(clip)
    put(clip, next_doc(published[0], published[1], main__cut_fade_ms=24), published[1])
    recovered = put(clip, doc, seed_etag, idem=idem)
    assert recovered[:2] == published[:2]


def test_pending_transaction_divergence_is_never_reported_as_a_revision_conflict(
        clip, contexts, seed_etag, monkeypatch):
    pending = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=25)
    idem = key()
    _crash(monkeypatch, "_publish")
    with pytest.raises(RuntimeError):
        put(clip, pending, seed_etag, idem=idem)
    put(clip, next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=26), seed_etag)
    with pytest.raises(IdempotencyConflict):
        put(clip, pending, seed_etag, idem=idem)


def test_failure_before_the_pending_receipt_never_publishes(clip, contexts, seed_etag,
                                                            monkeypatch):
    doc = next_doc(contexts["c30"].seed, seed_etag)
    _crash(monkeypatch, "_write_receipt")
    with pytest.raises(RuntimeError, match="crash"):
        put(clip, doc, seed_etag)
    assert store.get(clip)[2] is True
    assert not (clip / store.DOC_FILE).exists()


def test_a_corrupt_receipt_is_an_internal_error_not_a_replay(clip, contexts, seed_etag):
    idem = key()
    doc = next_doc(contexts["c30"].seed, seed_etag)
    put(clip, doc, seed_etag, idem=idem)
    (clip / store.RECEIPTS_DIR / f"{idem}.json").write_text('{"state": "committed"}')
    with pytest.raises(EditV2Error) as caught:
        put(clip, doc, seed_etag, idem=idem)
    assert caught.value.code == "internal_error"


def test_an_empty_receipt_file_reads_as_absent(clip, contexts, seed_etag):
    """A receipt is never written empty; an empty file is a lost unsynced rewrite (power loss):
    the retry is treated like one whose receipt was pruned."""
    idem = key()
    doc = next_doc(contexts["c30"].seed, seed_etag)
    saved, etag, _ = put(clip, doc, seed_etag, idem=idem)
    (clip / store.RECEIPTS_DIR / f"{idem}.json").write_bytes(b"")
    with pytest.raises(RevisionConflict) as caught:
        put(clip, doc, seed_etag, idem=idem)
    assert caught.value.etag == etag
    fresh = key()
    (clip / store.RECEIPTS_DIR / f"{fresh}.json").write_bytes(b"")
    second, _etag2, _ = put(clip, next_doc(saved, etag), etag, idem=fresh)
    assert second["revision"] == 2


def test_a_rejected_save_leaves_no_temporary_file(clip, contexts, seed_etag):
    doc1, etag1, _ = put(clip, next_doc(contexts["c30"].seed, seed_etag), seed_etag)
    before = {p.relative_to(clip).as_posix() for p in clip.rglob("*") if p.is_file()}
    for changes in ({"main__cut_fade_ms": 51}, {"revision": 9}, {"revision": "2"}):
        with pytest.raises(DocSemanticInvalid):
            put(clip, next_doc(doc1, etag1, **changes), etag1)
    after = {p.relative_to(clip).as_posix() for p in clip.rglob("*") if p.is_file()}
    assert after == before
    assert store.get(clip)[1] == etag1


def _write_receipts(clip: Path, count: int, *, state: str, start_ms: int) -> list[str]:
    directory = clip / store.RECEIPTS_DIR
    directory.mkdir(parents=True, exist_ok=True)
    keys = []
    for index in range(count):
        name = key()
        receipt = {"at_ms": start_ms + index, "key": name, "payload_sha256": "a" * 64,
                   "result_etag": "b" * 64, "result_revision": index + 1, "state": state}
        (directory / f"{name}.json").write_bytes(canonical_bytes(receipt))
        keys.append(name)
    return keys


def test_prune_keeps_the_newest_committed_receipts_and_every_pending_one(clip):
    old = _write_receipts(clip, 60, state="committed", start_ms=1_000)
    new = _write_receipts(clip, 200, state="committed", start_ms=5_000)
    pending = _write_receipts(clip, 3, state="pending", start_ms=10)
    assert store.prune_receipts(clip) == 60
    left = {path.stem for path in (clip / store.RECEIPTS_DIR).iterdir()}
    assert left == set(new) | set(pending)
    assert store.prune_receipts(clip) == 0
    assert store.prune_receipts(clip, keep=10) == 190
    left = {path.stem for path in (clip / store.RECEIPTS_DIR).iterdir()}
    assert left == set(new[-10:]) | set(pending)
    assert old  # silence unused


def test_put_prunes_to_200_receipts_and_a_retry_after_pruning_is_a_conflict(clip, contexts,
                                                                             seed_etag):
    first_key = key()
    first_doc = next_doc(contexts["c30"].seed, seed_etag, main__cut_fade_ms=0)
    doc, etag, _ = put(clip, first_doc, seed_etag, idem=first_key)
    for index in range(store.RECEIPTS_KEEP + 5):
        doc, etag, _ = put(clip, next_doc(doc, etag, main__cut_fade_ms=index % 50), etag,
                           now=NOW + index)
        assert len(list((clip / store.RECEIPTS_DIR).iterdir())) <= store.RECEIPTS_KEEP
    assert not (clip / store.RECEIPTS_DIR / f"{first_key}.json").exists()
    with pytest.raises(RevisionConflict) as caught:
        put(clip, first_doc, seed_etag, idem=first_key)
    assert caught.value.etag == etag


# --- QG-PERSIST (in process) -----------------------------------------------------------------------------


def _write_evidence(name: str, payload: dict) -> None:
    if os.environ.get("POTONGIN_GATE_EVIDENCE") != "1":
        return
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / name).write_text(json.dumps(payload, indent=1, sort_keys=True) + "\n")


def _filesystem(path: Path) -> str:
    """The mount type holding ``path`` (fsync cost depends on it), from /proc/mounts."""
    best, kind = "", "unknown"
    try:
        lines = Path("/proc/mounts").read_text().splitlines()
    except OSError:
        return kind
    for line in lines:
        fields = line.split()
        if len(fields) >= 3 and str(path).startswith(fields[1]) and len(fields[1]) > len(best):
            best, kind = fields[1], fields[2]
    return kind


def _environment(path: Path) -> dict:
    return {"python": platform.python_version(), "machine": platform.machine(),
            "cpus": os.cpu_count(), "filesystem": _filesystem(path)}


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def test_qg_persist_5000_consecutive_saves_without_lockout(clip, contexts, seed_etag):
    saves = 5_000
    doc, etag = contexts["c30"].seed, seed_etag
    max_receipts = 0
    timings = []
    started = time.perf_counter()
    for index in range(saves):
        begin = time.perf_counter()
        doc, etag, _ = put(clip, next_doc(doc, etag, main__cut_fade_ms=index % 51), etag,
                           now=NOW + index)
        timings.append((time.perf_counter() - begin) * 1000)
        if index % 50 == 0 or index >= saves - 5:
            max_receipts = max(max_receipts, len(os.listdir(clip / store.RECEIPTS_DIR)))
    elapsed = time.perf_counter() - started
    receipts = os.listdir(clip / store.RECEIPTS_DIR)
    archived = os.listdir(clip / store.ARCHIVE_DIR)
    assert doc["revision"] == saves == store.get(clip)[0]["revision"]
    assert len(receipts) == store.RECEIPTS_KEEP
    assert max_receipts <= store.RECEIPTS_KEEP
    assert len(archived) == saves - 1
    _write_evidence("T1.1-QG-PERSIST.json", {
        "gate": "QG-PERSIST (in process)",
        "saves": saves,
        "failures": 0,
        "final_revision": doc["revision"],
        "receipt_files_final": len(receipts),
        "receipt_files_max_sampled": max_receipts,
        "receipt_limit": store.RECEIPTS_KEEP,
        "archived_revisions": len(archived),
        "doc_bytes": len(canonical_bytes(doc)),
        "put_ms_p50": round(_percentile(timings, 0.50), 3),
        "put_ms_p95": round(_percentile(timings, 0.95), 3),
        "put_ms_max": round(max(timings), 3),
        "elapsed_s": round(elapsed, 2),
        "environment": _environment(clip),
        "pass": True,
    })


def big_document(context: fixtures.Context, target_bytes: int = 100_000) -> dict:
    """A valid revision-1 document of at least ``target_bytes`` canonical bytes: removals and
    word edits, the parts of a document that grow with editing (c25: a 200 s body)."""
    doc = next_doc(context.seed, fixtures.etag(context.seed), command="RemoveWords")
    body = next(s for s in doc["main"]["segments"] if s["role"] == "body")
    fps = context.fps
    words = [w for w in context.words["words"]
             if 2 * body["in_sf"] * 1000 * fps.den <= (w["s"] + w["e"]) * fps.num
             < 2 * body["out_sf"] * 1000 * fps.den]
    index = 0
    while len(canonical_bytes(doc)) < target_bytes:
        start = body["in_sf"] + 3 * index
        assert start + 1 < body["out_sf"] - 200, "body too short for the target size"
        word = words[index % len(words)]["id"]
        doc["main"]["removals"].append({
            "id": f"rm_{index + 1}", "seg": "seg_b1", "in_sf": start, "out_sf": start + 1,
            "words": [word], "reason": "user", "origin": "user"})
        doc["captions"]["word_edits"][word] = {"text": "Kata" + str(index % 97),
                                               "emphasis": index % 2 == 0}
        index += 1
    return doc


def test_the_100_kb_document_used_by_the_timing_gate_is_valid(tmp_path, contexts):
    context = contexts["c25"]
    doc = big_document(context)
    size = len(canonical_bytes(doc))
    assert 100_000 <= size < 101_000
    clip = make_clip(tmp_path, context)
    saved, _etag, _ = put(clip, doc, fixtures.etag(context.seed))
    assert saved["revision"] == 1 and parse_doc(canonical_bytes(saved)) == saved


@pytest.mark.skipif(os.environ.get("POTONGIN_GATES") != "1",
                    reason="timing gate: set POTONGIN_GATES=1 (machine dependent)")
def test_gate_put_p95_at_most_30_ms_for_a_100_kb_document(tmp_path, contexts):
    context = contexts["c25"]
    clip = make_clip(tmp_path, context)
    doc = big_document(context)
    etag = fixtures.etag(context.seed)
    doc, etag, _ = put(clip, doc, etag)
    for index in range(store.RECEIPTS_KEEP + 10):  # warm up past the pruning threshold
        doc, etag, _ = put(clip, next_doc(doc, etag, main__cut_fade_ms=index % 51), etag)
    timings = []
    for index in range(400):
        payload = next_doc(doc, etag, main__cut_fade_ms=index % 51)
        raw = canonical_bytes(payload)
        begin = time.perf_counter()
        doc, etag, _ = store.put(clip, expected_etag=etag, idempotency_key=key(), raw=raw,
                                 now_ms=NOW + index)
        timings.append((time.perf_counter() - begin) * 1000)
    p95 = _percentile(timings, 0.95)
    _write_evidence("T1.1-PUT-p95.json", {
        "gate": "in-process PUT p95 <= 30 ms for a 100 KB document",
        "threshold_ms": 30,
        "doc_bytes": len(canonical_bytes(doc)),
        "samples": len(timings),
        "receipt_files": len(os.listdir(clip / store.RECEIPTS_DIR)),
        "put_ms_p50": round(_percentile(timings, 0.50), 3),
        "put_ms_p95": round(p95, 3),
        "put_ms_max": round(max(timings), 3),
        "environment": _environment(clip),
        "python_executable_is_311": sys.version_info[:2] == (3, 11),
        "pass": p95 <= 30,
    })
    assert p95 <= 30
