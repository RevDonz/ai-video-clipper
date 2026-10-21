""""Hook di video" on the project page: the hook overlay of one clip on or off (CONTRACTS §5.57)."""

from __future__ import annotations

import copy
import uuid
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_api import by_index, call, make_job
from test_edit_v2_apply_all import clip_dir, save

from ai_clipper.edit_v2 import hook_toggle, store
from ai_clipper.edit_v2.doc import canonical_bytes

MUSIC = "sha256:f4eff9f785f6f6b1f32185191b7b66edb3cad91a7313650de54ea5cfdbb56472"


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def toggle(root: Path, job_id: str, directory: Path, hook: str, *, etag: str | None = None,
           key: str | None = None) -> tuple[int, dict]:
    if etag is None:
        etag = store.get(directory)[1]
    return call(root, op="set_hook", jobId=job_id, clipId=directory.name, etag=etag, hook=hook,
                idempotencyKey=key or str(uuid.uuid4()))


def hook_tracks(doc: dict) -> list[dict]:
    return [track for track in doc["tracks"] if track["kind"] == "hook"]


def listed(root: Path, job_id: str, rank: int) -> dict:
    status, payload = call(root, op="clips", jobId=job_id)
    assert status == 0, payload
    return by_index(payload)[rank]


def test_off_saves_a_revision_without_the_hook(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    seed, seed_etag = store.seed(directory)
    assert hook_tracks(seed), "the c30 seed has a hook"
    assert listed(tmp_path, job_id, 1)["hook"] == {"on": True, "available": True}

    status, payload = toggle(tmp_path, job_id, directory, "off", etag=seed_etag)
    assert status == 0, payload
    doc, etag, is_seed = store.get(directory)
    assert not is_seed and doc["revision"] == 1 and doc["parent_sha256"] == seed_etag
    assert hook_tracks(doc) == []
    assert doc["audit"]["last_command"] == hook_toggle.COMMAND == "SetHookEnabled"
    # Nothing but the hook track changes.
    rest = {key: value for key, value in doc.items()
            if key not in ("tracks", "revision", "parent_sha256", "audit")}
    assert rest == {key: value for key, value in seed.items()
                    if key not in ("tracks", "revision", "parent_sha256", "audit")}
    assert [t for t in doc["tracks"] if t["kind"] != "hook"] == \
        [t for t in seed["tracks"] if t["kind"] != "hook"]
    assert payload == {"etag": etag, "revision": 1, "changed": True,
                       "hook": {"on": False, "available": True}}
    entry = listed(tmp_path, job_id, 1)
    assert entry["hook"] == {"on": False, "available": True}
    assert entry["edit"]["etag"] == etag and entry["edit"]["state"] == "edited"


def test_on_restores_the_seed_hook(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    seed, _ = store.seed(directory)
    assert toggle(tmp_path, job_id, directory, "off")[0] == 0
    status, payload = toggle(tmp_path, job_id, directory, "on")
    assert status == 0, payload
    doc, etag, _ = store.get(directory)
    assert doc["revision"] == 2 and doc["tracks"] == seed["tracks"]
    assert payload == {"etag": etag, "revision": 2, "changed": True,
                       "hook": {"on": True, "available": True}}


def test_on_puts_the_hook_first_before_other_tracks(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    seed, _ = store.seed(directory)
    music = {"id": "tr_mus", "kind": "audio", "role": "music", "items": [
        {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
         "end": {"at": "clip_end"},
         "payload": {"asset": MUSIC, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
                     "fade_in_f": 15, "fade_out_f": 30,
                     "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30,
                              "release_ms": 400, "hold_ms": 250, "detector": "words"}},
         "origin": "user"}]}

    def without_hook_with_music(doc: dict) -> None:
        doc["tracks"] = [music]
        doc["assets"] = {MUSIC: contexts["c30"].assets[MUSIC]}

    save(directory, command="SetMusic", change=without_hook_with_music)
    status, payload = toggle(tmp_path, job_id, directory, "on")
    assert status == 0, payload
    doc, _, _ = store.get(directory)
    assert [track["kind"] for track in doc["tracks"]] == ["hook", "audio"]
    assert hook_tracks(doc) == hook_tracks(seed)


def test_a_switch_to_the_current_state_writes_nothing(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    _before, etag, _ = store.get(directory)
    status, payload = toggle(tmp_path, job_id, directory, "on", etag=etag)
    assert status == 0, payload
    assert payload == {"etag": etag, "revision": 0, "changed": False,
                       "hook": {"on": True, "available": True}}
    assert store.get(directory)[2] is True, "still the seed: no revision written"


def test_an_edited_hook_text_is_kept_while_on_and_back_to_the_seed_after_off_on(tmp_path,
                                                                                 contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)

    def custom_text(doc: dict) -> None:
        doc["tracks"][0]["items"][0]["payload"]["text"] = "Teks dari editor"
        doc["tracks"][0]["items"][0]["origin"] = "user"

    _, etag = save(directory, command="SetHookText", change=custom_text)
    status, payload = toggle(tmp_path, job_id, directory, "on", etag=etag)
    assert (status, payload["changed"]) == (0, False)
    assert toggle(tmp_path, job_id, directory, "off")[0] == 0
    assert toggle(tmp_path, job_id, directory, "on")[0] == 0
    seed, _ = store.seed(directory)
    assert hook_tracks(store.get(directory)[0]) == hook_tracks(seed)


def test_a_stale_etag_is_a_revision_conflict(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    seed_etag = store.seed(directory)[1]
    save(directory)
    status, payload = toggle(tmp_path, job_id, directory, "off", etag=seed_etag)
    assert status == 5, payload
    assert payload["error"]["code"] == "revision_conflict"
    # The same switch on an older revision whose hook is already off is still a conflict.
    assert toggle(tmp_path, job_id, directory, "off")[0] == 0
    old = store.get(directory)[1]
    assert toggle(tmp_path, job_id, directory, "on")[0] == 0
    assert toggle(tmp_path, job_id, directory, "off", etag=old)[0] == 5
    assert toggle(tmp_path, job_id, directory, "on", etag="f" * 64)[0] == 5


def test_a_retried_request_replays_its_save(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    seed_etag = store.seed(directory)[1]
    key = str(uuid.uuid4())
    first = toggle(tmp_path, job_id, directory, "off", etag=seed_etag, key=key)
    again = toggle(tmp_path, job_id, directory, "off", etag=seed_etag, key=key)
    assert first == again and first[0] == 0
    assert store.get(directory)[0]["revision"] == 1
    # The key of a finished switch reused for another one.
    other = toggle(tmp_path, job_id, directory, "on", etag=first[1]["etag"], key=key)
    assert other[0] == 9 and other[1]["error"]["code"] == "idempotency_conflict"


def test_a_clip_without_a_hook_cannot_turn_it_on(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 2)

    def no_hook(doc: dict) -> None:
        doc["tracks"] = [track for track in doc["tracks"] if track["kind"] != "hook"]

    seed = store.seed(directory)[0]
    plain = copy.deepcopy(seed)
    no_hook(plain)
    (directory / "seed.json").write_bytes(canonical_bytes(plain))
    assert listed(tmp_path, job_id, 2)["hook"] == {"on": False, "available": False}
    status, payload = toggle(tmp_path, job_id, directory, "on")
    assert status == 6 and payload["error"]["code"] == "range_invalid"
    assert store.get(directory)[2] is True


def test_a_read_only_clip_is_refused(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    directory = clip_dir(job, 1)
    context = contexts["c30"]
    _saved, etag = save(directory)
    new_words = copy.deepcopy(context.words)
    new_words["transcript_sha256"] = "c" * 64
    raw = canonical_bytes(new_words)
    sha = fixtures.sha256_hex(raw)
    (directory / f"words.{sha[:16]}.json").write_bytes(raw)
    seed = store.seed(directory)[0]
    seed["base"]["words"]["sha256"] = sha
    (directory / "seed.json").write_bytes(canonical_bytes(seed))
    assert listed(tmp_path, job_id, 1)["hook"] == {"on": True, "available": False}
    status, payload = toggle(tmp_path, job_id, directory, "off", etag=etag)
    assert status == 6 and payload["error"]["code"] == "op_disabled"
    assert store.get(directory)[1] == etag


def test_an_unprepared_clip_lists_no_hook_and_is_not_found(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts, seeds=(1,))
    assert listed(tmp_path, job_id, 2)["hook"] is None
    directory = clip_dir(job, 2)
    status, payload = call(tmp_path, op="set_hook", jobId=job_id, clipId=directory.name,
                           etag="a" * 64, hook="off", idempotencyKey=str(uuid.uuid4()))
    assert status == 4, payload


@pytest.mark.parametrize("hook", ["ON", "true", "", "1"])
def test_the_envelope_names_on_or_off(tmp_path, contexts, hook):
    job_id, job = make_job(tmp_path, contexts)
    status, _ = toggle(tmp_path, job_id, clip_dir(job, 1), hook)
    assert status == 2


def test_the_state_helper():
    seed = {"tracks": [{"kind": "hook", "items": [{"id": "h"}]}],
            "base": {"words": {"sha256": "a"}}}
    plain = {"tracks": [], "base": {"words": {"sha256": "a"}}}
    assert hook_toggle.state(seed, seed) == {"on": True, "available": True}
    assert hook_toggle.state(plain, seed) == {"on": False, "available": True}
    assert hook_toggle.state(plain, plain) == {"on": False, "available": False}
    other = {"tracks": [], "base": {"words": {"sha256": "b"}}}
    assert hook_toggle.state(other, seed) == {"on": False, "available": False}
