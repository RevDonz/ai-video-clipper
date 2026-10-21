"""Automatic pause trimming in the seed of an automatic clip (CONTRACTS §5.58).

``cleanup.auto_pause_removals`` turns the Rapikan ``gap_silent`` items that lie inside the body
into the removals ``ApplyCleanup`` would write, so the automatic file and the editor's revision 0
carry the same cuts. Words artifacts come from the production builder (see
``test_edit_v2_cleanup.build``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_cleanup import build, items_of, loud_peaks
from test_edit_v2_seed import _fixture_seed

from ai_clipper.edit_v2 import cleanup
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc
from ai_clipper.edit_v2.seed import SeedError, build_seed
from ai_clipper.edit_v2.timemap import Fps

PAUSE = ["kita", "pergi", ("pulang", 1200), "sore", "ini", "juga", "nanti", "malam", "lagi",
         "pergi"]


def body_of(artifact: dict, *, first: int = 0, last: int = -1) -> dict:
    fps = Fps.from_json(artifact["fps"])
    words = artifact["words"]
    return {"id": "seg_b1", "role": "body", "in_sf": tm.sf_floor(words[first]["s"], fps),
            "out_sf": tm.sf_ceil(words[last]["e"], fps)}


def test_a_silent_gap_in_the_body_becomes_the_removal_rapikan_would_apply():
    artifact = build(PAUSE, silent_before=[2])
    (item,) = items_of(cleanup.build_cleanup(artifact), "gap_silent")
    removals = cleanup.auto_pause_removals(artifact, body=body_of(artifact))
    assert removals == [{"id": "rm_1", "seg": "seg_b1", "in_sf": item["inSf"],
                         "out_sf": item["outSf"], "words": [], "reason": "gap_silent",
                         "origin": f"suggestion:{item['id']}"}]


def test_every_silent_gap_gets_its_own_removal_in_order():
    artifact = build(["kita", ("pergi", 900), "ke", ("pasar", 1500), *PAUSE[3:]],
                     silent_before=[1, 3])
    removals = cleanup.auto_pause_removals(artifact, body=body_of(artifact))
    assert [removal["id"] for removal in removals] == ["rm_1", "rm_2"]
    assert removals[0]["out_sf"] < removals[1]["in_sf"]


def test_voiced_and_laughter_gaps_are_never_trimmed():
    voiced = build(PAUSE)
    assert voiced["gaps"][0]["class"] == "voiced"
    assert cleanup.auto_pause_removals(voiced, body=body_of(voiced)) == []
    start = 100_000 + 2 * 300 + 100  # the end of "pergi"
    laughing = build(PAUSE, silent_before=[2], laughs=[start + 400])
    assert laughing["gaps"][0]["class"] == "laughter"
    assert cleanup.auto_pause_removals(laughing, body=body_of(laughing)) == []


@pytest.mark.parametrize("kind", ["music", "applause", "cheer"])
def test_a_silent_gap_next_to_music_or_applause_is_kept(kind):
    gap_start = 100_000 + 2 * 300 + 100
    gap_end = gap_start + 1200
    near = build(PAUSE, silent_before=[2], tags=[(gap_end + 500, kind)])
    assert near["gaps"][0]["class"] == "silent"
    assert cleanup.auto_pause_removals(near, body=body_of(near)) == []
    before = build(PAUSE, silent_before=[2], tags=[(gap_start - 500, kind)])
    assert cleanup.auto_pause_removals(before, body=body_of(before)) == []
    far = build(PAUSE, silent_before=[2], tags=[(gap_end + 501, kind)])
    assert len(cleanup.auto_pause_removals(far, body=body_of(far))) == 1


def test_other_tags_do_not_lock_a_gap():
    gap_start = 100_000 + 2 * 300 + 100
    artifact = build(PAUSE, silent_before=[2], tags=[(gap_start + 300, "cough")])
    assert len(cleanup.auto_pause_removals(artifact, body=body_of(artifact))) == 1


def test_only_gaps_between_two_words_of_the_body_are_trimmed():
    artifact = build(PAUSE, silent_before=[2])
    # the body ends with "pergi" (the gap follows it) or starts at "pulang" (the gap precedes it)
    assert cleanup.auto_pause_removals(artifact, body=body_of(artifact, last=1)) == []
    assert cleanup.auto_pause_removals(artifact, body=body_of(artifact, first=2)) == []
    assert len(cleanup.auto_pause_removals(artifact, body=body_of(artifact, first=1))) == 1


def test_a_gap_without_a_quiet_cut_is_not_trimmed():
    artifact = build(PAUSE, silent_before=[2])
    gap = artifact["gaps"][0]
    peaks = loud_peaks(artifact, [(gap["s"], gap["e"])])
    assert cleanup.auto_pause_removals(artifact, body=body_of(artifact), peaks=peaks) == []


def test_no_trim_leaves_the_body_shorter_than_three_seconds():
    tokens = ["kita", ("pergi", 1500), "pulang", "sore", "ini", "juga", "ya", "kan"]
    artifact = build(tokens, silent_before=[1])
    body = body_of(artifact)
    fps = Fps.from_json(artifact["fps"])
    (removal,) = cleanup.auto_pause_removals(artifact, body=body)
    trimmed = body["out_sf"] - body["in_sf"] - (removal["out_sf"] - removal["in_sf"])
    assert trimmed >= tm.sf_ceil(3000, fps)
    short = dict(body, out_sf=body["in_sf"] + tm.sf_ceil(3000, fps)
                 + (removal["out_sf"] - removal["in_sf"]) - 1)
    assert short["out_sf"] >= tm.sf_ceil(artifact["words"][2]["e"], fps)
    assert cleanup.auto_pause_removals(artifact, body=short) == []


@pytest.mark.parametrize("context_id", fixtures.CONTEXT_IDS)
def test_a_seed_with_its_pause_trims_is_a_valid_document(context_id, edit_v2_doc_contexts):
    context = edit_v2_doc_contexts[context_id]
    plain = _fixture_seed(context_id, edit_v2_doc_contexts)
    body = next(s for s in plain["main"]["segments"] if s["role"] == "body")
    removals = cleanup.auto_pause_removals(context.words, body=body)
    trimmed = _fixture_seed(context_id, edit_v2_doc_contexts, pauseRemovals=removals)
    assert trimmed["main"]["removals"] == removals
    assert trimmed["clip_id"] == plain["clip_id"]  # the clip is the same moment
    if removals:
        assert trimmed["base"]["seed_sha256"] != plain["base"]["seed_sha256"]
    validation = validate_doc(trimmed, words=context.words, assets=context.assets, seed=None)
    assert validation.errors == (), validation.errors


def test_at_least_one_fixture_clip_has_a_pause_to_trim(edit_v2_doc_contexts):
    found = 0
    for context_id in fixtures.CONTEXT_IDS:
        context = edit_v2_doc_contexts[context_id]
        body = next(s for s in context.seed["main"]["segments"] if s["role"] == "body")
        found += len(cleanup.auto_pause_removals(context.words, body=body))
    assert found > 0


def _seed_with(removals, **extra):
    from test_edit_v2_seed import _clip, _job, _source_info

    job = {**_job(coldOpen=False), "pauseRemovals": removals, **extra}
    return build_seed(clip=_clip(), job=job, source_info=_source_info(), words_sha="b" * 64,
                      words_count=321, camera_sha=None, selection_sha="c" * 64)


def test_the_seed_refuses_removals_that_are_not_pause_trims_inside_the_body():
    body = _seed_with([])["main"]["segments"][0]
    good = {"id": "rm_1", "seg": "seg_b1", "in_sf": body["in_sf"] + 30,
            "out_sf": body["in_sf"] + 45, "words": [], "reason": "gap_silent",
            "origin": "suggestion:cl_3"}
    assert _seed_with([good])["main"]["removals"] == [good]
    bad = [
        dict(good, in_sf=body["in_sf"] - 1),
        dict(good, out_sf=body["out_sf"] + 1),
        dict(good, out_sf=good["in_sf"]),
        dict(good, seg="seg_co"),
        dict(good, reason="user"),
        dict(good, origin="user"),
        dict(good, words=["w000001"]),
        dict(good, id="x"),
        {**good, "extra": 1},
    ]
    for removal in bad:
        with pytest.raises(SeedError):
            _seed_with([removal])
    later = dict(good, id="rm_2", in_sf=good["out_sf"] + 10, out_sf=good["out_sf"] + 20)
    assert len(_seed_with([good, later])["main"]["removals"]) == 2
    with pytest.raises(SeedError):
        _seed_with([later, good])  # unsorted
    with pytest.raises(SeedError):
        _seed_with([good, dict(later, in_sf=good["out_sf"] - 1)])  # overlapping
    with pytest.raises(SeedError):
        _seed_with([good, dict(later, id="rm_1")])  # the same id twice
    whole = dict(good, in_sf=body["in_sf"] + 1, out_sf=body["out_sf"] - 1)
    with pytest.raises(SeedError):
        _seed_with([whole])  # the body would be shorter than 3 s
    with pytest.raises(SeedError):
        _seed_with([good], seedBy="prepare")  # a legacy file was rendered without trims


def test_an_empty_or_missing_pause_list_seeds_exactly_like_before():
    from test_edit_v2_seed import _clip, _job, _source_info

    plain = build_seed(clip=_clip(), job=_job(coldOpen=False), source_info=_source_info(),
                       words_sha="b" * 64, words_count=321, camera_sha=None,
                       selection_sha="c" * 64)
    assert _seed_with([]) == plain
    assert _seed_with(None) == plain


# --- the committed c30 trims (read by web/tests/editor-cleanup.test.mjs) -------------------------

AUTO_PAUSES_C30 = (Path(__file__).resolve().parent / "fixtures" / "edit_v2"
                   / "auto-pauses-c30.json")


def test_the_committed_c30_pause_trims_are_current(edit_v2_doc_contexts):
    """The web test applies these items with the editor's ApplyCleanup and expects exactly these
    removals. Regenerate with ``POTONGIN_WRITE_FIXTURES=1 uv run pytest
    tests/test_edit_v2_auto_pauses.py``."""
    context = edit_v2_doc_contexts["c30"]
    body = next(s for s in context.seed["main"]["segments"] if s["role"] == "body")
    removals = cleanup.auto_pause_removals(context.words, body=body)
    by_id = {item["id"]: item for item in cleanup.build_cleanup(context.words)["items"]}
    expected = {"schema": "potongin.auto-pauses-fixture/1", "context": "c30",
                "items": [by_id[removal["origin"].removeprefix("suggestion:")]
                          for removal in removals],
                "removals": removals}
    if os.environ.get("POTONGIN_WRITE_FIXTURES") == "1":
        AUTO_PAUSES_C30.write_text(json.dumps(expected, sort_keys=True, indent=1) + "\n")
    assert json.loads(AUTO_PAUSES_C30.read_text()) == expected
    assert len(removals) >= 2
