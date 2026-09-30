"""Cold-open candidates for the cold-open panel (plan §7.2, §11.3 T3.7): ``edit_v2.coldopen``.

The heuristic runs on the committed document contexts (units rebuilt from the words artifact)
and on the synthetic job of ``scripts/editor_fixture/make_job.py`` after prepare (units from the
transcript, as Selection V3 builds them). Every candidate must be a valid cold open for the
clip's revision 0: word-snapped through ``bounds`` and accepted by ``doc.validate_doc``.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import coldopen
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc
from ai_clipper.hook_heuristics import _analyse_unit
from ai_clipper.models import TranscriptWord
from ai_clipper.sentences import SentenceUnit

ROOT = Path(__file__).resolve().parents[1]
MAKE_JOB = ROOT / "scripts" / "editor_fixture" / "make_job.py"
GENERATOR = ROOT / "scripts" / "editor" / "gen_t37_fixtures.py"
COLDOPEN_VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "coldopen-vectors.json"
CANDIDATE_KEYS = {"id", "source", "firstWord", "lastWord", "inSf", "outSf", "frames", "durMs",
                  "unitIds", "text", "question", "laughTail", "reason"}
SOURCES = {"selection", "hook", "strong"}
STRONG_TEXT = "Ternyata gue hampir dipecat gara gara rahasia kantor"


# --- helpers -------------------------------------------------------------------------------------


def with_cold_open(seed: dict, in_sf: int, out_sf: int) -> dict:
    """The seed with ``[in_sf, out_sf)`` as its cold open, exactly as SetColdOpen builds it."""
    doc = copy.deepcopy(seed)
    main = doc["main"]
    fade = main["joins"][0]["audio_fade_ms"] if main["joins"] else 30
    main["segments"] = [{"id": "seg_co", "role": "cold_open", "in_sf": in_sf, "out_sf": out_sf}] \
        + [s for s in main["segments"] if s["role"] == "body"]
    main["removals"] = [r for r in main["removals"] if r["seg"] != "seg_co"]
    main["joins"] = [{"after": "seg_co", "style": "cut", "audio_fade_ms": fade}]
    return doc


def snapped(words: dict, first: str, last: str) -> tuple[int, int]:
    before = {b["before"]: b["sf"] for b in words["bounds"] if b["before"] is not None}
    after = {b["after"]: b["sf"] for b in words["bounds"] if b["after"] is not None}
    return before[first], after[last]


def is_valid_cold_open(seed: dict, words: dict, first: str, last: str) -> bool:
    in_sf, out_sf = snapped(words, first, last)
    if in_sf >= out_sf:
        return False
    doc = with_cold_open(seed, in_sf, out_sf)
    return not validate_doc(doc, words=words, assets={}, seed=None).errors


def assert_valid_candidates(seed: dict, words: dict, candidates) -> None:
    fps = tm.Fps.from_json(seed["output"]["fps"])
    order = {w["id"]: i for i, w in enumerate(words["words"])}
    body = next(s for s in seed["main"]["segments"] if s["role"] == "body")
    spans = []
    for number, candidate in enumerate(candidates, start=1):
        assert candidate.id == f"co_{number}"
        assert candidate.source in SOURCES
        assert order[candidate.first_word] <= order[candidate.last_word]
        # word-snapped: the edges are the bounds frames of the first and last word (§3.6)
        assert (candidate.in_sf, candidate.out_sf) == snapped(words, candidate.first_word,
                                                              candidate.last_word)
        frames = candidate.out_sf - candidate.in_sf
        assert candidate.frames == frames
        assert tm.sf_ceil(500, fps) <= frames <= tm.sf_floor(8000, fps)
        assert candidate.in_sf != body["in_sf"]
        assert candidate.dur_ms == tm.div_round_half_up(frames * 1000 * fps.den, fps.num)
        doc = with_cold_open(seed, candidate.in_sf, candidate.out_sf)
        validation = validate_doc(doc, words=words, assets={}, seed=None)
        assert validation.errors == (), (candidate, validation.errors)
        spans.append((candidate.in_sf, candidate.out_sf))
    assert len(set(spans)) == len(spans), "duplicate candidates"


def unit_words(words: dict, unit_id: str) -> list[dict]:
    return [w for w in words["words"] if w["u"] == unit_id]


def body_units(seed: dict, words: dict) -> list[str]:
    """Units whose every word lies inside the seed body (midpoint rule), in order."""
    fps = tm.Fps.from_json(seed["output"]["fps"])
    body = next(s for s in seed["main"]["segments"] if s["role"] == "body")
    inside: dict[str, bool] = {}
    for w in words["words"]:
        mid = Fraction(w["s"] + w["e"], 2) * fps.num / (1000 * fps.den)
        inside[w["u"]] = inside.get(w["u"], True) and body["in_sf"] <= mid < body["out_sf"]
    return [unit for unit, ok in inside.items() if ok]


def usable_units(seed: dict, words: dict) -> list[dict]:
    """Body units other than the hook sentence that make a valid 1–6 s cold open."""
    hook = seed["base"]["origin"]["hook_unit_id"]
    inside = set(body_units(seed, words))
    out = []
    for unit in words["units"]:
        members = unit_words(words, unit["id"])
        if unit["id"] in inside and unit["id"] != hook and 1000 <= unit["e"] - unit["s"] <= 6000 \
                and is_valid_cold_open(seed, words, members[0]["id"], members[-1]["id"]):
            out.append(unit)
    return out


def with_texts(units: list[SentenceUnit], texts: dict[str, str], *,
               default: str | None = None) -> list[SentenceUnit]:
    """The units with some texts replaced (``default`` for every other unit); timing unchanged."""
    out = []
    for unit in units:
        text = texts.get(unit.unit_id, default if default is not None else unit.text)
        out.append(SentenceUnit(unit.unit_id, unit.index, unit.start, unit.end, text,
                                unit.segment_start, unit.segment_end, unit.word_count,
                                text.rstrip().endswith("?") or (unit.is_question and
                                                                 text == unit.text),
                                unit.gap_before, unit.suspect, unit.words))
    return out


def laughter_pair(seed: dict, words: dict) -> tuple[str, str]:
    """Two consecutive usable body units, the second starting within the laugh tail."""
    usable = {u["id"] for u in usable_units(seed, words)}
    order = [u["id"] for u in words["units"]]
    inside = set(body_units(seed, words))
    for a, b in pairwise(order):
        members_b = unit_words(words, b)
        if a in usable and b in inside and len(members_b) >= 2 \
                and members_b[0]["s"] - unit_words(words, a)[-1]["e"] <= coldopen.LAUGH_TAIL_MS:
            return a, b
    raise AssertionError("no unit pair for the laughter case")


# --- contexts (units from the words artifact) ----------------------------------------------------


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


@pytest.mark.parametrize("context_id", fixtures.CONTEXT_IDS)
def test_every_candidate_is_a_valid_word_snapped_cold_open(contexts, context_id):
    context = contexts[context_id]
    candidates = coldopen.build_candidates(context.seed, context.words)
    assert candidates, "every context has at least one candidate"
    assert len(candidates) <= coldopen.MAX_CANDIDATES
    assert_valid_candidates(context.seed, context.words, candidates)


def test_the_seed_cold_open_comes_first_as_its_words(contexts):
    context = contexts["c30"]
    seed, words = context.seed, context.words
    fps = tm.Fps.from_json(seed["output"]["fps"])
    co = next(s for s in seed["main"]["segments"] if s["role"] == "cold_open")
    inside = [w for w in words["words"]
              if co["in_sf"] <= (w["s"] + w["e"]) * fps.num // (2000 * fps.den) < co["out_sf"]]
    first = coldopen.build_candidates(seed, words)[0]
    assert first.source == "selection"
    assert (first.first_word, first.last_word) == (inside[0]["id"], inside[-1]["id"])
    assert first.text == " ".join(w["t"] for w in inside)
    assert "dipakai" in first.reason.lower()


def test_the_hook_sentence_is_offered_when_it_makes_a_valid_cold_open(contexts):
    for context in contexts.values():
        seed, words = context.seed, context.words
        hook_unit = seed["base"]["origin"]["hook_unit_id"]
        members = unit_words(words, hook_unit)
        candidates = coldopen.build_candidates(seed, words)
        hooks = [c for c in candidates if c.source == "hook"]
        selection = [c for c in candidates if c.source == "selection"]
        valid = is_valid_cold_open(seed, words, members[0]["id"], members[-1]["id"])
        duplicate = any(c.unit_ids == (hook_unit,) for c in selection)
        if valid and not duplicate:
            assert [(c.first_word, c.last_word) for c in hooks] == \
                [(members[0]["id"], members[-1]["id"])], context.id
            assert hooks[0].unit_ids == (hook_unit,)
        else:
            assert hooks == [], context.id


def test_the_selection_cold_open_from_the_artifact_when_the_seed_has_none(contexts):
    context = contexts["c25"]
    seed, words = context.seed, context.words
    assert [s["role"] for s in seed["main"]["segments"]] == ["body"]
    target = usable_units(seed, words)[2]
    candidates = coldopen.build_candidates(
        seed, words, selection_cold_open_ms=(target["s"] - 80, target["e"] + 120))
    first = candidates[0]
    assert first.source == "selection"
    assert first.unit_ids == (target["id"],)
    assert "disarankan" in first.reason.lower()
    assert_valid_candidates(seed, words, candidates)


def test_strong_sentences_skip_sponsor_greeting_outro_backchannel_and_pronoun_led(contexts):
    context = contexts["c25"]
    seed, words = context.seed, context.words
    usable = usable_units(seed, words)
    assert len(usable) >= 6
    texts = {
        usable[0]["id"]: "Jangan lupa pakai kode promo diskon ternyata rahasia dipecat",
        usable[1]["id"]: "Halo semuanya selamat datang ternyata rahasia dipecat",
        usable[2]["id"]: "Jangan lupa subscribe ternyata rahasia dipecat sampai jumpa",
        usable[3]["id"]: "Dia ternyata dipecat karena rahasia kantor bocor",
        usable[4]["id"]: "Iya iya",
        usable[5]["id"]: STRONG_TEXT,
    }
    analysed = {unit_id: _analyse_unit(unit) for unit_id, unit in
                ((u.unit_id, u) for u in with_texts(coldopen.units_from_words(words), texts))
                if unit_id in texts}
    assert analysed[usable[0]["id"]].sponsor and analysed[usable[1]["id"]].greeting
    assert analysed[usable[2]["id"]].outro and analysed[usable[3]["id"]].pronoun_led
    assert analysed[usable[4]["id"]].backchannel
    units = with_texts(coldopen.units_from_words(words), texts, default="biasa saja kok")
    candidates = coldopen.build_candidates(seed, words, units=units)
    assert [c.unit_ids for c in candidates if c.source == "strong"] == [(usable[5]["id"],)]


def test_strong_sentences_rank_by_hook_strength_and_stop_at_three(contexts):
    context = contexts["c25"]
    seed, words = context.seed, context.words
    usable = usable_units(seed, words)
    texts = {
        usable[0]["id"]: "Gue kira biasa aja ternyata",
        usable[1]["id"]: "Jujur gue malu banget ternyata hampir dipecat",
        usable[2]["id"]: "Rahasia kantor ternyata bocor ke polisi",
        usable[3]["id"]: "Gue pertama kali ke kantor waktu itu",
        usable[4]["id"]: "Ternyata sutradara dipecat karena utang",
    }
    units = with_texts(coldopen.units_from_words(words), texts, default="biasa saja kok")
    strength = {u.unit_id: _analyse_unit(u).strength for u in units}
    candidates = coldopen.build_candidates(seed, words, units=units)
    strong = [c.unit_ids[0] for c in candidates if c.source == "strong"]
    assert len(strong) == coldopen.STRONG_LIMIT == 3
    assert [strength[u] for u in strong] == sorted((strength[u] for u in strong), reverse=True)
    assert all(strength[u] <= strength[strong[-1]] for u in texts if u not in strong)


def test_sentences_outside_the_clip_body_are_never_suggested(contexts):
    context = contexts["c25"]
    seed, words = context.seed, context.words
    inside = set(body_units(seed, words))
    outside = [u["id"] for u in words["units"] if u["id"] not in inside]
    assert outside, "the context window reaches beyond the body"
    texts = dict.fromkeys(outside, "Ternyata rahasia kantor bocor dan gue hampir dipecat polisi")
    units = with_texts(coldopen.units_from_words(words), texts, default="biasa saja kok")
    candidates = coldopen.build_candidates(seed, words, units=units)
    assert [c for c in candidates if c.source == "strong"] == []


def test_laughter_right_after_the_sentence_extends_the_out_point(contexts):
    context = contexts["c25"]
    seed = context.seed
    words = copy.deepcopy(context.words)
    unit_a, unit_b = laughter_pair(seed, words)
    members_b = unit_words(words, unit_b)
    for word in members_b:  # the next unit is spelled-out laughter ("wkwk"), timing unchanged
        word["t"] = "wkwk"
        words["events"].append({"kind": "laughter", "s": word["s"], "e": word["e"],
                                "src": "transcript"})
    words["events"].sort(key=lambda item: (item["s"], item["e"], item["kind"], item["src"]))
    texts = {unit_a: STRONG_TEXT, unit_b: " ".join("wkwk" for _ in members_b)}
    units = with_texts(coldopen.units_from_words(words), texts, default="biasa saja kok")
    candidates = coldopen.build_candidates(seed, words, units=units)
    chosen = next(c for c in candidates if c.unit_ids[0] == unit_a)
    limit = members_b[0]["e"] + coldopen.LAUGH_TAIL_MS
    expected_last = [w for w in members_b if w["s"] < limit][-1]
    assert chosen.laugh_tail is True
    assert chosen.last_word == expected_last["id"]
    assert chosen.unit_ids == (unit_a, unit_b)
    assert "tawa" in chosen.reason
    assert_valid_candidates(seed, words, candidates)


def test_a_real_sentence_after_the_laugh_is_never_pulled_in(contexts):
    context = contexts["c25"]
    seed = context.seed
    words = copy.deepcopy(context.words)
    unit_a, unit_b = laughter_pair(seed, words)
    a_last = unit_words(words, unit_a)[-1]
    words["events"].append({"kind": "laughter", "s": a_last["e"] + 100, "e": a_last["e"] + 100,
                            "src": "yt-caption"})
    words["events"].sort(key=lambda item: (item["s"], item["e"], item["kind"], item["src"]))
    texts = {unit_a: STRONG_TEXT,
             unit_b: "Terus produser datang dan minta maaf ke semua kru film"}
    units = with_texts(coldopen.units_from_words(words), texts, default="biasa saja kok")
    chosen = next(c for c in coldopen.build_candidates(seed, words, units=units)
                  if c.unit_ids[0] == unit_a)
    assert chosen.last_word == a_last["id"]
    assert chosen.laugh_tail is False
    assert chosen.unit_ids == (unit_a,)


def test_candidates_are_deterministic_and_serialise_to_the_route_shape(contexts):
    context = contexts["c30"]
    first = coldopen.build_candidates(context.seed, context.words)
    second = coldopen.build_candidates(copy.deepcopy(context.seed),
                                       copy.deepcopy(context.words))
    assert first == second
    for candidate in first:
        payload = candidate.to_json()
        assert set(payload) == CANDIDATE_KEYS
        assert payload["unitIds"] == list(candidate.unit_ids)
        assert all(type(payload[key]) is int for key in ("inSf", "outSf", "frames", "durMs"))
        assert coldopen.Candidate.from_json(payload) == candidate


@pytest.mark.parametrize("context_id", fixtures.CONTEXT_IDS)
def test_reason_copy_is_plain_indonesian(contexts, context_id):
    context = contexts[context_id]
    for candidate in coldopen.build_candidates(context.seed, context.words):
        assert candidate.reason and candidate.reason == candidate.reason.strip()
        assert "—" not in candidate.reason
        for word in ("V1", "V2", "V3", "versi", "mesin", "heuristik", "LLM"):
            assert word.lower() not in candidate.reason.lower()


def test_the_committed_coldopen_vectors_are_current(contexts):
    spec = importlib.util.spec_from_file_location("editor_gen_t37_fixtures_co", GENERATOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.render_coldopen() == COLDOPEN_VECTORS.read_bytes(), \
        "regenerate with: uv run python scripts/editor/gen_t37_fixtures.py --write"
    committed = json.loads(COLDOPEN_VECTORS.read_text(encoding="utf-8"))
    for context_id, entry in committed["contexts"].items():
        context = contexts[context_id]
        assert entry["wordsSha256"] == context.seed["base"]["words"]["sha256"]
        assert_valid_candidates(context.seed, context.words,
                                [coldopen.Candidate.from_json(item) for item in entry["candidates"]])
    assert any(item["source"] == "strong" for item in committed["contexts"]["c25"]["candidates"])
    assert len(committed["contexts"]["c30"]["candidates"]) >= 2


def test_units_from_words_follow_the_artifact(contexts):
    words = contexts["c30"].words
    units = coldopen.units_from_words(words)
    assert [u.unit_id for u in units] == [u["id"] for u in words["units"]]
    for unit, entry in zip(units, words["units"], strict=True):
        members = unit_words(words, entry["id"])
        assert unit.text == " ".join(w["t"] for w in members)
        assert unit.is_question is entry["q"]
        assert unit.word_count == len(members)
        assert all(isinstance(word, TranscriptWord) for word in unit.words)


# --- the synthetic job (units from the transcript) -----------------------------------------------


def _load_make_job():
    name = "editor_fixture_make_job"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, MAKE_JOB)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def synthetic(tmp_path_factory, edit_v2_ffmpeg):
    make_job = _load_make_job()
    root = tmp_path_factory.mktemp("coldopen_fixture")
    index = make_job.build(root, size=(256, 144), only=("main", "vfr", "old"))
    from ai_clipper.edit_v2 import seed as seed_module

    prepared = {name: seed_module.prepare_legacy_job(root / entry["dir"])
                for name, entry in index["jobs"].items()}
    return root, index, prepared


def _clip(synthetic, name: str, rank: int) -> tuple[str, str, Path]:
    root, index, prepared = synthetic
    entry = next(item for item in prepared[name] if item["index"] == rank)
    assert entry["openable"], entry
    return index["jobs"][name]["id"], entry["clip_id"], root / "jobs"


def _call(jobs_root: Path | None, **envelope) -> tuple[int, dict]:
    return coldopen.handle(json.dumps(envelope).encode(), jobs_root=jobs_root)


def _stored(jobs_root: Path, job_id: str, clip_id: str) -> tuple[dict, dict]:
    clip_dir = jobs_root / job_id / "analysis" / "clips" / clip_id
    seed = json.loads((clip_dir / "seed.json").read_text())
    sha = seed["base"]["words"]["sha256"]
    words = json.loads((clip_dir / f"words.{sha[:16]}.json").read_text())
    return seed, words


def _candidates(payload: dict) -> list[coldopen.Candidate]:
    return [coldopen.Candidate.from_json(item) for item in payload["candidates"]]


def test_cli_lists_the_candidates_of_a_prepared_clip(synthetic):
    job_id, clip_id, jobs_root = _clip(synthetic, "main", 1)
    status, payload = _call(jobs_root, op="list", jobId=job_id, clipId=clip_id)
    assert status == 0, payload
    assert set(payload) == {"wordsSha256", "candidates"}
    seed, words = _stored(jobs_root, job_id, clip_id)
    assert payload["wordsSha256"] == seed["base"]["words"]["sha256"]
    candidates = _candidates(payload)
    assert_valid_candidates(seed, words, candidates)
    first = candidates[0]
    assert first.source == "selection"
    assert first.text == "Kenapa security nahan sutradara di film sendiri?"
    assert first.question is True
    assert all(set(item) == CANDIDATE_KEYS for item in payload["candidates"])


def test_a_job_that_ran_without_cold_open_still_offers_the_selection_one(synthetic):
    job_id, clip_id, jobs_root = _clip(synthetic, "vfr", 1)
    seed, words = _stored(jobs_root, job_id, clip_id)
    assert [s["role"] for s in seed["main"]["segments"]] == ["body"]
    status, payload = _call(jobs_root, op="list", jobId=job_id, clipId=clip_id)
    assert status == 0, payload
    candidates = _candidates(payload)
    assert candidates[0].source == "selection"
    assert candidates[0].text == "Kenapa security nahan sutradara di film sendiri?"
    assert "disarankan" in candidates[0].reason.lower()
    assert_valid_candidates(seed, words, candidates)


def test_clip_2_offers_its_hook_sentence_up_to_the_laughter(synthetic):
    job_id, clip_id, jobs_root = _clip(synthetic, "main", 2)
    seed, words = _stored(jobs_root, job_id, clip_id)
    status, payload = _call(jobs_root, op="list", jobId=job_id, clipId=clip_id)
    assert status == 0, payload
    candidates = _candidates(payload)
    hook = next(c for c in candidates if c.source == "hook")
    assert hook.text == "Pas sampai di set semua kru langsung ketawa wkwk."
    # the next sentence ("Produser minta maaf …") is a real sentence: never pulled in
    assert hook.laugh_tail is False
    assert_valid_candidates(seed, words, candidates)


def test_every_clip_of_every_synthetic_job_gets_valid_candidates(synthetic):
    root, index, prepared = synthetic
    for name, entries in prepared.items():
        for entry in entries:
            job_id, clip_id = index["jobs"][name]["id"], entry["clip_id"]
            status, payload = _call(root / "jobs", op="list", jobId=job_id, clipId=clip_id)
            assert status == 0, (name, entry, payload)
            seed, words = _stored(root / "jobs", job_id, clip_id)
            assert payload["candidates"], (name, entry["index"])
            assert_valid_candidates(seed, words, _candidates(payload))


def test_without_the_transcript_the_words_artifact_is_enough(synthetic, tmp_path):
    root, _index, _prepared = synthetic
    job_id, clip_id, _jobs = _clip(synthetic, "main", 3)
    copy_root = tmp_path / "jobs"
    shutil.copytree(root / "jobs" / job_id, copy_root / job_id, symlinks=True)
    (copy_root / job_id / "output" / "transcript.json").unlink()
    status, payload = _call(copy_root, op="list", jobId=job_id, clipId=clip_id)
    assert status == 0, payload
    seed, words = _stored(copy_root, job_id, clip_id)
    assert_valid_candidates(seed, words, _candidates(payload))
    with_transcript = _call(root / "jobs", op="list", jobId=job_id, clipId=clip_id)[1]
    assert payload["candidates"][0] == with_transcript["candidates"][0]


_JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55"
_CLIP = "clip_9b2e41c07d3a5f18e6c2a0b4"


@pytest.mark.parametrize("raw", [
    b"",
    b"not json",
    b"[]",
    b'{"op": "list"}',
    json.dumps({"op": "list", "jobId": _JOB}).encode(),
    json.dumps({"op": "list", "jobId": "../etc", "clipId": _CLIP}).encode(),
    json.dumps({"op": "list", "jobId": _JOB, "clipId": "clip_x"}).encode(),
    json.dumps({"op": "delete", "jobId": _JOB, "clipId": _CLIP}).encode(),
    json.dumps({"op": "list", "jobId": _JOB, "clipId": _CLIP, "extra": 1}).encode(),
    f'{{"op": "list", "op": "list", "jobId": "{_JOB}", "clipId": "{_CLIP}"}}'.encode(),
])
def test_a_malformed_envelope_is_a_usage_error(tmp_path, raw):
    status, payload = coldopen.handle(raw, jobs_root=tmp_path)
    assert status == 2
    assert payload["error"]["code"] == "internal_error"


def test_unknown_ids_are_not_found_and_missing_words_is_analysis_missing(synthetic, tmp_path):
    root, _index, _prepared = synthetic
    job_id, clip_id, jobs_root = _clip(synthetic, "main", 1)
    status, payload = _call(jobs_root, op="list", jobId="0f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55",
                            clipId=clip_id)
    assert (status, payload["error"]["code"]) == (4, "not_found")
    status, payload = _call(jobs_root, op="list", jobId=job_id,
                            clipId="clip_000000000000000000000000")
    assert (status, payload["error"]["code"]) == (4, "not_found")
    copy_root = tmp_path / "jobs"
    shutil.copytree(root / "jobs" / job_id, copy_root / job_id, symlinks=True)
    for words_file in (copy_root / job_id / "analysis" / "clips" / clip_id).glob("words.*.json"):
        words_file.unlink()
    status, payload = _call(copy_root, op="list", jobId=job_id, clipId=clip_id)
    assert (status, payload["error"]["code"]) == (8, "analysis_missing")
    assert payload["error"]["messageId"] == "edit.analysis_missing"
    status, _payload = _call(None, op="list", jobId=job_id, clipId=clip_id)
    assert status == 1


def test_the_cli_runs_as_a_module_with_only_the_allowlisted_environment(synthetic):
    job_id, clip_id, jobs_root = _clip(synthetic, "main", 1)
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(jobs_root), "LANG": "C.UTF-8",
           "PYTHONPATH": str(ROOT / "src")}
    envelope = json.dumps({"op": "list", "jobId": job_id, "clipId": clip_id}).encode()
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.coldopen"],
                            input=envelope, capture_output=True, env=env, timeout=60,
                            check=False)
    assert result.returncode == 0, result.stderr.decode()[-2000:]
    assert result.stdout.endswith(b"\n")
    assert json.loads(result.stdout)["candidates"][0]["source"] == "selection"
    usage = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.coldopen", "extra"],
                           capture_output=True, env=env, timeout=60, check=False)
    assert usage.returncode == 2
