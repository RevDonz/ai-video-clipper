""""Pakai di semua klip": one batch over the clips of a job, and its undo (CONTRACTS §5.53)."""

from __future__ import annotations

import copy
import json
import uuid
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_api import CLIPS, NOW, _clip_id, by_index, call, make_job
from test_edit_v2_store import next_doc

from ai_clipper.edit_v2 import apply_all, store
from ai_clipper.edit_v2.doc import canonical_bytes, content_sha256
from ai_clipper.edit_v2.errors import RevisionConflict

LOGO = "sha256:036ce0c8d1bbde9427d03c28388f2f48cf1b4a1061869b334f0be2adee588148"
WIDE_LOGO = "sha256:0736a9232e8ad3fdadacf971380804b79da31541b80f890636cda9b0ef7b9872"
MUSIC = "sha256:f4eff9f785f6f6b1f32185191b7b66edb3cad91a7313650de54ea5cfdbb56472"
WATERMARK = {"text": "@potongin", "pos": "bottom_right", "size_pm": 1000, "opacity_pm": 800}


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def clip_dir(job: Path, rank: int) -> Path:
    return job / "analysis" / "clips" / _clip_id(CLIPS[rank - 1])


def save(directory: Path, command: str = "SetCaptionOverride", change=None) -> tuple[dict, str]:
    current, etag, _ = store.get(directory)
    doc = next_doc(current, etag, command=command)
    if change is not None:
        change(doc)
    saved, new_etag, _ = store.put(directory, expected_etag=etag,
                                   idempotency_key=str(uuid.uuid4()),
                                   raw=canonical_bytes(doc), now_ms=NOW)
    return saved, new_etag


def run(root: Path, job_id: str, source: Path, group: str, *, batch: str | None = None,
        etag: str | None = None) -> tuple[int, dict]:
    if etag is None:
        etag = store.get(source)[1]
    return call(root, op="apply_all", jobId=job_id, clipId=source.name, etag=etag,
                group=group, batchId=batch or str(uuid.uuid4()))


def undo(root: Path, job_id: str, batch: str) -> tuple[int, dict]:
    return call(root, op="undo_apply_all", jobId=job_id, batchId=batch)


def logo_track(asset: str = LOGO, x_e5: int = 80000) -> dict:
    return {"id": "tr_ovr", "kind": "visual", "band": "over_text", "role": "overlay", "items": [
        {"id": "it_logo", "type": "image", "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
         "transform": {"x_e5": x_e5, "y_e5": 9000, "w_e5": 16000, "opacity_pm": 850},
         "payload": {"asset": asset, "mode": "free"}, "origin": "user"}]}


def music_track() -> dict:
    return {"id": "tr_mus", "kind": "audio", "role": "music", "items": [
        {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
         "end": {"at": "clip_end"},
         "payload": {"asset": MUSIC, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
                     "fade_in_f": 15, "fade_out_f": 30,
                     "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                              "hold_ms": 250, "detector": "words"}},
         "origin": "user"}]}


def with_logo(contexts, asset: str = LOGO, x_e5: int = 80000):
    def change(doc: dict) -> None:
        doc["tracks"] = [*doc["tracks"], logo_track(asset, x_e5)]
        doc["assets"] = {asset: contexts["c30"].assets[asset]}
        doc["watermark"] = dict(WATERMARK)
    return change


def with_music(contexts):
    def change(doc: dict) -> None:
        doc["tracks"] = [*doc["tracks"], music_track()]
        doc["assets"] = {**doc["assets"], MUSIC: contexts["c30"].assets[MUSIC]}
    return change


def bold_captions(doc: dict) -> None:
    doc["captions"]["pack"] = {"id": "bold", "v": 1}
    doc["captions"]["overrides"]["y_e5"] = 60000
    doc["captions"]["overrides"]["entrance"] = "pop"


def entries(payload: dict, name: str) -> list[tuple[int, str | None]]:
    return [(item["index"], item.get("reason")) for item in payload[name]]


# --- apply -----------------------------------------------------------------------------------------


def test_captions_go_to_every_clip_still_at_its_seed(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    source_doc, source_etag = save(source, change=bold_captions)
    target = clip_dir(job, 2)
    # A word edit on a target is not part of the caption settings and survives the batch.
    word = next(iter(contexts["c30"].words["words"]))["id"]
    save(target, command="EditWordText",
         change=lambda doc: doc["captions"]["word_edits"].update({word: {"text": "Halo"}}))
    target_before, target_etag, _ = store.get(target)
    batch = str(uuid.uuid4())
    status, payload = run(tmp_path, job_id, source, "captions", batch=batch, etag=source_etag)
    assert status == 0, payload
    assert payload["batchId"] == batch and payload["group"] == "captions"
    assert entries(payload, "applied") == [(2, None), (3, None)]
    assert payload["skipped"] == [] and payload["unchanged"] == []
    assert {item["clipId"] for item in payload["applied"]} == {target.name, clip_dir(job, 3).name}
    for rank in (2, 3):
        doc, _etag, is_seed = store.get(clip_dir(job, rank))
        assert not is_seed
        assert doc["captions"]["pack"] == {"id": "bold", "v": 1}
        assert doc["captions"]["overrides"] == source_doc["captions"]["overrides"]
        assert doc["audit"]["last_command"] == apply_all.APPLY_COMMAND
    doc, _etag, _ = store.get(target)
    assert doc["revision"] == target_before["revision"] + 1
    assert doc["parent_sha256"] == target_etag
    assert doc["captions"]["word_edits"] == {word: {"text": "Halo"}}
    # The source clip is never written.
    assert store.get(source)[1] == source_etag


def test_a_clip_whose_captions_were_changed_by_hand_is_skipped(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    edited = clip_dir(job, 3)
    _doc, edited_etag = save(edited, change=lambda doc: doc["captions"]["overrides"].update(
        {"size_pm": 1200}))
    # A change to another group does not count: clip 2's hook moved, its captions are the seed's.
    save(clip_dir(job, 2), command="SetHookY",
         change=lambda doc: doc["tracks"][0]["items"][0]["transform"].update({"y_e5": 20000}))
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None)]
    assert entries(payload, "skipped") == [(3, "edited")]
    assert payload["skipped"][0]["clipId"] == edited.name
    assert store.get(edited)[1] == edited_etag


def test_a_clip_already_like_the_source_is_unchanged(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, command="SetHookY",
         change=lambda doc: doc["tracks"][0]["items"][0]["transform"].update({"y_e5": 20000}))
    before = {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)}
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert payload["applied"] == [] and payload["skipped"] == []
    assert entries(payload, "unchanged") == [(2, None), (3, None)]
    assert {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)} == before


def test_clips_without_a_seed_or_with_a_changed_transcript_are_skipped(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts, seeds=(1, 2, 3))
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    # Clip 2's job re-ran with other words: its document is read-only in the editor.
    reran = clip_dir(job, 2)
    seed_doc = json.loads((reran / "seed.json").read_bytes())
    save(reran, command="SetHookY",
         change=lambda doc: doc["tracks"][0]["items"][0]["transform"].update({"y_e5": 20000}))
    seed_doc["base"]["words"]["sha256"] = "f" * 64
    (reran / "seed.json").write_bytes(canonical_bytes(seed_doc))
    # Clip 3 was never prepared.
    for path in sorted(clip_dir(job, 3).rglob("*"), reverse=True):
        path.rmdir() if path.is_dir() else path.unlink()
    clip_dir(job, 3).rmdir()
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert payload["applied"] == []
    assert entries(payload, "skipped") == [(2, "read_only"), (3, "not_ready")]


def test_logo_and_watermark_go_together_and_keep_the_music(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    source_doc, _ = save(source, command="AddLogo", change=with_logo(contexts))
    musical = clip_dir(job, 2)
    save(musical, command="AddMusic", change=with_music(contexts))
    status, payload = run(tmp_path, job_id, source, "logo")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None), (3, None)]
    doc, _etag, _ = store.get(musical)
    assert [track["kind"] for track in doc["tracks"]] == ["hook", "visual", "audio"]
    assert doc["tracks"][1] == source_doc["tracks"][1]
    assert doc["watermark"] == WATERMARK
    assert set(doc["assets"]) == {LOGO, MUSIC}
    plain, _etag, _ = store.get(clip_dir(job, 3))
    assert set(plain["assets"]) == {LOGO}


def test_removing_the_logo_goes_to_every_clip_too(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    # Every seed has the job's default logo; clip 1 removes it.
    for rank in (1, 2, 3):
        directory = clip_dir(job, rank)
        seed_doc = json.loads((directory / "seed.json").read_bytes())
        with_logo(contexts)(seed_doc)
        (directory / "seed.json").write_bytes(canonical_bytes(seed_doc))
    source = clip_dir(job, 1)

    def drop(doc: dict) -> None:
        doc["tracks"] = [track for track in doc["tracks"] if track["kind"] != "visual"]
        doc["assets"] = {}
        del doc["watermark"]
    save(source, command="RemoveLogo", change=drop)
    status, payload = run(tmp_path, job_id, source, "logo")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None), (3, None)]
    doc, _etag, _ = store.get(clip_dir(job, 2))
    assert [track["kind"] for track in doc["tracks"]] == ["hook"]
    assert doc["assets"] == {} and "watermark" not in doc


def test_a_logo_that_does_not_fit_a_clip_is_skipped_as_invalid(tmp_path, contexts, monkeypatch):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, command="AddLogo", change=with_logo(contexts))
    real_put = store.put

    def refusing(directory, **arguments):
        if directory.name == clip_dir(job, 3).name:
            from ai_clipper.edit_v2.errors import DocSemanticInvalid
            raise DocSemanticInvalid("item_out_of_frame", path="/tracks/1/items/0")
        return real_put(directory, **arguments)
    monkeypatch.setattr(apply_all.store, "put", refusing)
    status, payload = run(tmp_path, job_id, source, "logo")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None)]
    assert entries(payload, "skipped") == [(3, "invalid")]


def test_layout_goes_without_the_source_keyframes(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    seed_doc = contexts["c30"].seed
    fps = seed_doc["output"]["fps"]
    first = seed_doc["base"]["window_ms"][0] * fps[0] // (1000 * fps[1]) + 1

    def framed(doc: dict) -> None:
        doc["layout"] = {"default": {"mode": "fill_center", "no_face": "center"},
                         "keyframes": [{"sf": first, "pan_e5": 30000, "move": "cut"}]}
    save(source, command="SetKeyframe", change=framed)
    keyed = clip_dir(job, 3)
    save(keyed, command="SetKeyframe", change=framed)
    status, payload = run(tmp_path, job_id, source, "layout")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None)]
    assert entries(payload, "skipped") == [(3, "edited")]
    doc, _etag, _ = store.get(clip_dir(job, 2))
    assert doc["layout"] == {"default": {"mode": "fill_center", "no_face": "center"}}


def test_layout_split_goes_with_its_crops(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    split = {"top_pm": 500, "top": {"x_e5": 30000, "y_e5": 50000, "zoom_pm": 1000},
             "bottom": {"x_e5": 70000, "y_e5": 50000, "zoom_pm": 1500}}
    save(source, command="SetLayout", change=lambda doc: doc.update(
        layout={"default": {"mode": "split", "no_face": "center"}, "split": split}))
    status, payload = run(tmp_path, job_id, source, "layout")
    assert status == 0, payload
    doc, _etag, _ = store.get(clip_dir(job, 3))
    assert doc["layout"] == {"default": {"mode": "split", "no_face": "center"}, "split": split}


def test_the_source_must_be_the_revision_the_editor_saved(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    _doc, old = save(source, change=bold_captions)
    save(source, command="SetHookY",
         change=lambda doc: doc["tracks"][0]["items"][0]["transform"].update({"y_e5": 20000}))
    status, payload = run(tmp_path, job_id, source, "captions", etag=old)
    assert status == 5 and payload["error"]["code"] == "revision_conflict"
    assert all(store.get(clip_dir(job, rank))[2] for rank in (2, 3))
    assert not (job / apply_all.RECORDS_DIR).exists() or not any(
        path.suffix == ".json" for path in (job / apply_all.RECORDS_DIR).iterdir())


def test_a_clip_saved_while_the_batch_runs_is_skipped_as_a_conflict(tmp_path, contexts,
                                                                    monkeypatch):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    raced = clip_dir(job, 2)
    real_put = store.put

    def racing(directory, **arguments):
        if directory.name == raced.name:
            current, _etag, _ = store.get(raced)
            raise RevisionConflict(current=current, etag="0" * 64)
        return real_put(directory, **arguments)
    monkeypatch.setattr(apply_all.store, "put", racing)
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert entries(payload, "applied") == [(3, None)]
    assert entries(payload, "skipped") == [(2, "conflict")]


def test_the_same_batch_id_replays_its_result(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    _doc, etag = save(source, change=bold_captions)
    batch = str(uuid.uuid4())
    first = run(tmp_path, job_id, source, "captions", batch=batch, etag=etag)
    revisions = {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)}
    assert run(tmp_path, job_id, source, "captions", batch=batch, etag=etag) == first
    assert {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)} == revisions
    status, payload = run(tmp_path, job_id, source, "layout", batch=batch, etag=etag)
    assert status == 9 and payload["error"]["code"] == "idempotency_conflict"


def test_a_batch_cut_short_finishes_on_retry(tmp_path, contexts, monkeypatch):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    _doc, etag = save(source, change=bold_captions)
    real_put = store.put
    calls = []

    def crashing(directory, **arguments):
        calls.append(directory.name)
        if len(calls) == 2:
            raise OSError("power loss")
        return real_put(directory, **arguments)
    monkeypatch.setattr(apply_all.store, "put", crashing)
    batch = str(uuid.uuid4())
    status, _payload = run(tmp_path, job_id, source, "captions", batch=batch, etag=etag)
    assert status == 1
    monkeypatch.setattr(apply_all.store, "put", real_put)
    status, payload = run(tmp_path, job_id, source, "captions", batch=batch, etag=etag)
    assert status == 0, payload
    # Clip 2 was written before the crash: it counts as applied, not as edited by hand.
    assert entries(payload, "applied") == [(2, None), (3, None)]
    assert store.get(clip_dir(job, 2))[0]["revision"] == 1


@pytest.mark.parametrize("change", [{"group": "music"}, {"group": ""}, {"batchId": "x"},
                                    {"etag": "F" * 64}])
def test_the_apply_envelope_is_checked(tmp_path, contexts, change):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    envelope = {"op": "apply_all", "jobId": job_id, "clipId": source.name,
                "etag": store.get(source)[1], "group": "captions", "batchId": str(uuid.uuid4())}
    status, _payload = call(tmp_path, **{**envelope, **change})
    assert status == 2


def test_old_batch_records_are_pruned(tmp_path, contexts, monkeypatch):
    monkeypatch.setattr(apply_all, "RECORDS_KEEP", 2)
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    batches = [str(uuid.uuid4()) for _ in range(3)]
    for batch in batches:
        assert run(tmp_path, job_id, source, "captions", batch=batch)[0] == 0
    names = sorted(path.name for path in (job / apply_all.RECORDS_DIR).glob("*.json"))
    assert names == sorted(f"{batch}.json" for batch in batches[1:])


# --- undo ------------------------------------------------------------------------------------------


def test_undo_restores_every_changed_clip_once(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, command="AddLogo", change=with_logo(contexts))
    musical = clip_dir(job, 2)
    before_doc, before_etag = save(musical, command="AddMusic", change=with_music(contexts))
    seed_content = content_sha256(store.seed(clip_dir(job, 3))[0])
    batch = str(uuid.uuid4())
    status, applied = run(tmp_path, job_id, source, "logo", batch=batch)
    assert status == 0 and len(applied["applied"]) == 2
    status, payload = undo(tmp_path, job_id, batch)
    assert status == 0, payload
    assert payload["batchId"] == batch
    assert entries(payload, "restored") == [(2, None), (3, None)]
    assert payload["skipped"] == []
    doc, etag, _ = store.get(musical)
    assert content_sha256(doc) == content_sha256(before_doc)
    assert doc["revision"] == before_doc["revision"] + 2 and etag != before_etag
    assert doc["audit"]["last_command"] == apply_all.UNDO_COMMAND
    assert content_sha256(store.get(clip_dir(job, 3))[0]) == seed_content
    # A second undo answers the same and writes nothing.
    current = {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)}
    assert undo(tmp_path, job_id, batch) == (0, payload)
    assert {rank: store.get(clip_dir(job, rank))[1] for rank in (2, 3)} == current
    # Its source never moved.
    assert by_index(call(tmp_path, op="clips", jobId=job_id)[1])[1]["edit"]["revision"] == 1


def test_undo_skips_a_clip_changed_after_the_batch(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    batch = str(uuid.uuid4())
    assert run(tmp_path, job_id, source, "captions", batch=batch)[0] == 0
    later_doc, later_etag = save(clip_dir(job, 3), command="SetHookY",
                                 change=lambda doc: doc["tracks"][0]["items"][0][
                                     "transform"].update({"y_e5": 20000}))
    status, payload = undo(tmp_path, job_id, batch)
    assert status == 0, payload
    assert entries(payload, "restored") == [(2, None)]
    assert entries(payload, "skipped") == [(3, "changed")]
    assert store.get(clip_dir(job, 3))[1] == later_etag
    assert later_doc["captions"]["pack"] == {"id": "bold", "v": 1}


def test_undo_of_an_unknown_batch_is_not_found(tmp_path, contexts):
    job_id, _job = make_job(tmp_path, contexts)
    status, payload = undo(tmp_path, job_id, str(uuid.uuid4()))
    assert status == 4 and payload["error"]["code"] == "not_found"


def test_undo_cut_short_finishes_on_retry(tmp_path, contexts, monkeypatch):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    batch = str(uuid.uuid4())
    assert run(tmp_path, job_id, source, "captions", batch=batch)[0] == 0
    real_put = store.put
    calls = []

    def crashing(directory, **arguments):
        calls.append(directory.name)
        if len(calls) == 2:
            raise OSError("power loss")
        return real_put(directory, **arguments)
    monkeypatch.setattr(apply_all.store, "put", crashing)
    assert undo(tmp_path, job_id, batch)[0] == 1
    monkeypatch.setattr(apply_all.store, "put", real_put)
    status, payload = undo(tmp_path, job_id, batch)
    assert status == 0, payload
    assert entries(payload, "restored") == [(2, None), (3, None)]
    for rank in (2, 3):
        doc = store.get(clip_dir(job, rank))[0]
        assert doc["revision"] == 2 and doc["captions"] == contexts["c30"].seed["captions"]


# --- the model -------------------------------------------------------------------------------------


def test_parts_and_with_part(contexts):
    seed_doc = copy.deepcopy(contexts["c30"].seed)
    assert apply_all.part(seed_doc, "captions") == {
        "enabled": True, "pack": {"id": "karaoke", "v": 1},
        "overrides": seed_doc["captions"]["overrides"]}
    assert apply_all.part(seed_doc, "logo") == {"overlay": None, "watermark": None, "assets": {}}
    assert apply_all.part(seed_doc, "layout") == seed_doc["layout"]
    source = copy.deepcopy(seed_doc)
    with_logo(contexts, asset=WIDE_LOGO)(source)
    value = apply_all.copied_part(source, "logo")
    target = apply_all.with_part(seed_doc, "logo", value)
    assert apply_all.part(target, "logo") == apply_all.part(source, "logo")
    assert seed_doc["tracks"] == contexts["c30"].seed["tracks"]  # never mutated
    with pytest.raises(ValueError):
        apply_all.part(seed_doc, "music")


def test_a_second_batch_updates_the_clips_of_the_first(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    assert run(tmp_path, job_id, source, "captions")[0] == 0
    # Applying the same again: every clip already has it.
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0 and payload["applied"] == [] and payload["skipped"] == []
    assert entries(payload, "unchanged") == [(2, None), (3, None)]
    # Clip 3 is changed by hand after the first batch; the source then changes its pack.
    save(clip_dir(job, 3), change=lambda doc: doc["captions"]["overrides"].update({"size_pm": 1200}))
    save(source, change=lambda doc: doc["captions"].update(pack={"id": "box", "v": 1}))
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert entries(payload, "applied") == [(2, None)]
    assert entries(payload, "skipped") == [(3, "edited")]
    assert store.get(clip_dir(job, 2))[0]["captions"]["pack"] == {"id": "box", "v": 1}


def test_an_undone_batch_gives_no_pass_to_its_values(tmp_path, contexts):
    job_id, job = make_job(tmp_path, contexts)
    source = clip_dir(job, 1)
    save(source, change=bold_captions)
    batch = str(uuid.uuid4())
    assert run(tmp_path, job_id, source, "captions", batch=batch)[0] == 0
    assert undo(tmp_path, job_id, batch)[0] == 0
    # Clip 2 is then set by hand to what the undone batch had written.
    save(clip_dir(job, 2), change=bold_captions)
    save(source, change=lambda doc: doc["captions"].update(pack={"id": "box", "v": 1}))
    status, payload = run(tmp_path, job_id, source, "captions")
    assert status == 0, payload
    assert entries(payload, "skipped") == [(2, "edited")]
    assert entries(payload, "applied") == [(3, None)]
