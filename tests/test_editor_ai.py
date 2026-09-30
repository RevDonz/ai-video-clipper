"""Hook suggestions for the clip editor (plan §7, §7.1, K13; T3.4): ``ai_clipper.editor_ai``.

The instant variants, the LLM task (scripted clients only; no network), grounding and format
validation, the 20 s deadline, the task file and the CLI envelope. The clip is the committed
``c30`` context with coherent Indonesian sentences written into the units of its body.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import os
import re
import stat
import threading
import time
import uuid
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_store import make_clip

from ai_clipper import editor_ai
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.hook_heuristics import _analyse_unit
from ai_clipper.llm import (
    CachedLLMClient,
    FailoverLLMClient,
    LLMError,
    LLMUnavailable,
    OpenAICompatibleClient,
    ScriptedLLMClient,
)
from ai_clipper.selection_types import SelectedClip, SelectionResult
from ai_clipper.selection_v3 import write_selection_artifact
from ai_clipper.sentences import SentenceUnit

C30 = fixtures.load_context("c30")
JOB = C30.seed["base"]["job_id"]
CLIP = C30.seed["clip_id"]
SCORES = {"hook": 7.0, "standalone": 6.0, "payoff": 5.0, "emotion": 4.0, "shareability": 3.0}
ID = re.compile(r"[a-z]{2,3}_[0-9a-z]{1,16}")
TASK = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

# Coherent sentences for the units the c30 body plays (S0418–S0439), one token per word slot.
SENTENCES = {
    "S0418": "Gue tuh dulu kerja jadi security.",
    "S0419": "Waktu itu ada syuting film di mall tempat gue.",
    "S0420": "Kenapa dia nggak boleh masuk?",
    "S0421": "Dia nggak bawa kartu kru sama sekali.",
    "S0422": "Jadi gue tahan dia di pintu masuk belakang.",
    "S0423": "Eh ternyata dia sutradaranya.",
    "S0424": "Dia tuh malu banget kan?",
    "S0425": "Malu banget gue asli.",
    "S0426": "Semua kru pada ketawa.",
    "S0427": "Katanya baru kali ini sutradara ditahan di film sendiri.",
    "S0428": "Jujur gue gue nggak nyangka ee dia sutradaranya sendiri.",
    "S0429": "Sampai sekarang masih diomongin orang.",
    "S0430": "Gajinya cuma dua juta sebulan waktu itu.",
    "S0431": "Tapi gue tetap betah kerja.",
    "S0432": "Raditya bilang gue security paling galak sedunia.",
    "S0433": "Terus dia ngajak gue jadi figuran juga.",
    "S0434": "Makanya gue masuk film itu.",
    "S0435": "Keren nggak tuh ceritanya bro?",
    "S0436": "Iya iya bener banget.",
    "S0437": "Jangan lupa subscribe dan nyalakan lonceng ya teman.",
    "S0438": "Video ini disponsori oleh aplikasi kopi kesayangan.",
    "S0439": "Sampai jumpa lagi di episode minggu depan ya.",
}
SEED_HOOK = C30.seed["tracks"][0]["items"][0]["payload"]["text"]
TITLE = "Security nahan sutradara di lokasi syutingnya"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def coherent_words(sentences=SENTENCES) -> dict:
    words = copy.deepcopy(C30.words)
    slots: dict[str, list[dict]] = {}
    for word in words["words"]:
        slots.setdefault(word["u"], []).append(word)
    for unit, sentence in sentences.items():
        tokens = sentence.split()
        assert len(tokens) == len(slots[unit]), unit
        for word, token in zip(slots[unit], tokens, strict=True):
            word["t"] = token
    return words


def _selected(rank, start, end, cold_open, *, title, source="llm", hook_unit="S0428"):
    return SelectedClip(
        rank=rank, start=start, end=end, cold_open=cold_open, unit_ids=("S0418", "S0439"),
        hook_unit_id=hook_unit, title=title, hook_text=f"Hook {rank}", description="",
        hashtags=("#podcast",), archetype="story_twist", score=7.5, scores=SCORES,
        reasons=("alasan",), source=source, text="teks klip")


# Words the episode says elsewhere (outside the clip): common words a hook may open with.
EPISODE_TEXT = ("pas itu cerita rahasia sisi lain momen kata orang kenapa bisa begitu, "
                "sakitnya ditahan itu beda.")


def write_transcript(job: Path, sentences) -> None:
    """``output/transcript.json``: the episode vocabulary (one line elsewhere, then the clip)."""
    segments = [{"start": 10.0, "end": 14.0, "text": EPISODE_TEXT}]
    for index, (_unit, sentence) in enumerate(sorted(sentences.items())):
        segments.append({"start": 1242.0 + 3 * index, "end": 1244.5 + 3 * index,
                         "text": sentence})
    (job / "output").mkdir(exist_ok=True)
    (job / "output" / "transcript.json").write_text(
        json.dumps({"language": "id", "segments": segments}, ensure_ascii=False))


def make_job(root: Path, *, sentences=SENTENCES, origin=None, selection=True,
             selection_source="llm", title=TITLE, transcript=True) -> dict:
    words = coherent_words(sentences)
    seed = copy.deepcopy(C30.seed)
    seed["base"]["words"]["sha256"] = sha(canonical_bytes(words))
    seed["base"]["origin"].update(origin or {})
    clip = make_clip(root, C30, seed=seed, words=words)
    job = root / JOB
    (job / "job.json").write_text(json.dumps({"id": JOB, "options": {"selectionMode": "v3",
                                                                      "coldOpen": True}}))
    if transcript:
        write_transcript(job, sentences)
    if selection:
        clips = (
            _selected(1, 100.0, 140.5, None, title="Klip satu", source=selection_source),
            _selected(2, 200.25, 260.0, None, title="Klip dua", source=selection_source),
            _selected(3, 1241.93, 1309.4, (1275.2, 1279.7), title=title, source=selection_source,
                      hook_unit=seed["base"]["origin"]["hook_unit_id"]),
        )
        write_selection_artifact(job / "analysis" / "selection.v3.json", SelectionResult(
            clips=clips, source=selection_source,
            status="completed" if selection_source == "llm" else "fallback",
            provider="openrouter" if selection_source == "llm" else None,
            model="m" if selection_source == "llm" else None, prompt_version="v3.0"))
    return {"root": root, "job": job, "clip": clip, "seed": seed, "words": words}


def body(doc: dict, **extra) -> bytes:
    return json.dumps({"task": "hooks", "doc": doc, **extra}, ensure_ascii=False).encode()


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def context(case: dict, doc: dict | None = None) -> editor_ai.HookContext:
    return editor_ai.load_context(case["job"], case["clip"],
                                  body(case["seed"] if doc is None else doc))


def with_hook(doc: dict, text: str) -> dict:
    doc = copy.deepcopy(doc)
    doc["tracks"][0]["items"][0]["payload"]["text"] = text
    return doc


def unit_word_ids(words: dict, unit: str) -> list[str]:
    return [word["id"] for word in words["words"] if word["u"] == unit]


def remove_unit(case: dict, doc: dict, unit: str) -> dict:
    """``doc`` with the words of ``unit`` cut out of the body (bounds of the words artifact)."""
    doc = copy.deepcopy(doc)
    ids = unit_word_ids(case["words"], unit)
    bounds = case["words"]["bounds"]
    start = next(b["sf"] for b in bounds if b["before"] == ids[0])
    end = next(b["sf"] for b in bounds if b["after"] == ids[-1])
    doc["main"]["removals"].append({"id": "rm_t1", "seg": "seg_b1", "in_sf": start, "out_sf": end,
                                    "words": ids, "reason": "user", "origin": "user"})
    doc["main"]["removals"].sort(key=lambda removal: removal["in_sf"])
    return doc


@pytest.fixture
def case(tmp_path):
    return make_job(tmp_path)


# --- the fixture itself ------------------------------------------------------------------------------


def _unit(text: str, q: bool = False) -> SentenceUnit:
    return SentenceUnit(unit_id="S0001", index=0, start=0.0, end=1.0, text=text,
                        segment_start=0, segment_end=0, word_count=len(text.split()),
                        is_question=q, gap_before=0.0, suspect=False, words=())


def test_the_fixture_sentences_carry_the_flags_the_rules_skip():
    assert _analyse_unit(_unit(SENTENCES["S0438"])).sponsor
    assert _analyse_unit(_unit(SENTENCES["S0437"])).outro
    assert _analyse_unit(_unit(SENTENCES["S0436"])).backchannel
    assert _analyse_unit(_unit(SENTENCES["S0424"], q=True)).pronoun_led


# --- visible lines and the clip text ----------------------------------------------------------------


def test_visible_lines_follow_the_output_order_with_edits_and_without_removed_or_hidden_words(case):
    lines = editor_ai.visible_lines(case["seed"], case["words"])
    assert [line.id for line in lines] == [f"L{index:04d}" for index in range(1, len(lines) + 1)]
    assert lines[0].cold_open and not lines[-1].cold_open
    assert lines[0].unit == "S0428"  # the cold open plays first
    body_units = [line.unit for line in lines if not line.cold_open]
    assert body_units == sorted(body_units) and "S0427" in body_units
    doc = copy.deepcopy(case["seed"])
    raditya = unit_word_ids(case["words"], "S0432")[0]
    doc["captions"]["word_edits"][raditya] = {"text": "Radit"}
    hidden = unit_word_ids(case["words"], "S0425")[1]  # "banget"
    doc["captions"]["word_edits"][hidden] = {"hidden": True}
    doc = remove_unit(case, doc, "S0433")
    lines = editor_ai.visible_lines(doc, case["words"])
    text = " ".join(line.text for line in lines)
    assert "Radit bilang" in text and "Raditya" not in text
    assert "Malu gue asli." in text
    assert "figuran" not in text


def test_visible_lines_strip_prompt_fences_from_transcript_text(tmp_path):
    sentences = dict(SENTENCES, S0425="Malu <<<banget>>> gue asli.")
    lines = editor_ai.visible_lines(make_job(tmp_path, sentences=sentences)["seed"],
                                    coherent_words(sentences))
    assert not any("<<" in line.text or ">>" in line.text for line in lines)


# --- instant variants (plan §7.1) ---------------------------------------------------------------------


def test_instant_variants_are_labelled_by_source_and_bounded(case):
    variants = editor_ai.instant_variants(context(case))
    assert 3 <= len(variants) <= editor_ai.MAX_INSTANT
    assert [v["kind"] for v in variants[:2]] == ["v3_hook", "v3_title"]
    assert variants[0]["text"] == SEED_HOOK and variants[0]["source"] == "ai_selection"
    assert variants[1]["text"] == TITLE and variants[1]["source"] == "ai_selection"
    assert all(v["source"] == "heuristic" for v in variants[2:])
    assert len({v["id"] for v in variants}) == len(variants)
    for variant in variants:
        assert ID.fullmatch(variant["id"])
        assert 0 < len(variant["text"]) <= editor_ai.HOOK_MAX_CHARS
        assert isinstance(variant["fits"], bool)
        assert set(variant) >= {"id", "text", "source", "kind", "fits"}
    for index, first in enumerate(variants):
        for second in variants[index + 1:]:
            assert editor_ai.similarity(first["text"], second["text"]) < editor_ai.SIMILARITY_MAX


def test_a_heuristic_selection_is_never_labelled_ai(tmp_path):
    case = make_job(tmp_path, origin={"selection_source": "heuristic"},
                    selection_source="heuristic")
    variants = editor_ai.instant_variants(context(case))
    assert {v["source"] for v in variants} == {"heuristic"}


def test_the_hook_unit_sentence_is_tidied_and_fits_60_characters(case):
    variants = editor_ai.instant_variants(context(case))
    unit = next(v for v in variants if v["kind"] == "hook_unit")
    assert unit["unit"] == "S0428"
    assert "gue gue" not in unit["text"].casefold() and " ee " not in f" {unit['text']} "
    assert "sutradaranya" in unit["text"]
    assert len(unit["text"]) <= editor_ai.HOOK_PREFERRED_CHARS
    assert not unit["text"].endswith(("…", "."))


def test_a_question_hook_unit_gets_a_question_form(tmp_path):
    case = make_job(tmp_path, origin={"hook_unit_id": "S0420"})
    variants = editor_ai.instant_variants(context(case))
    question = [v for v in variants if v["kind"] in {"hook_unit", "question"}]
    assert question and all(v["unit"] == "S0420" for v in question)
    assert any(v["text"].endswith("?") for v in question)


def test_the_strongest_other_sentence_skips_sponsor_outro_backchannel_and_pronoun_led(case):
    ctx = context(case)
    strongest = next(v for v in editor_ai.instant_variants(ctx) if v["kind"] == "strongest")
    assert strongest["unit"] not in {"S0428", "S0437", "S0438", "S0436", "S0424", "S0439"}
    doc = remove_unit(case, case["seed"], strongest["unit"])
    again = next(v for v in editor_ai.instant_variants(context(case, doc))
                 if v["kind"] == "strongest")
    assert again["unit"] != strongest["unit"]


def test_the_fit_flag_comes_from_the_render_layout(case):
    ctx = context(case)
    assert editor_ai.fits("Dia ditahan security", ctx) is True
    long_text = " ".join(["sutradaranya"] * 12)[:90]
    assert editor_ai.fits(long_text, ctx) is False


def test_without_a_selection_artifact_the_title_variant_is_skipped(tmp_path):
    case = make_job(tmp_path, selection=False)
    variants = editor_ai.instant_variants(context(case))
    assert "v3_title" not in {v["kind"] for v in variants}
    assert variants[0]["kind"] == "v3_hook"


# --- prompt -------------------------------------------------------------------------------------------


def test_the_prompt_is_the_packaged_resource_within_the_token_budget(case):
    ctx = context(case)
    system, user = editor_ai.build_prompt(ctx)
    assert system == editor_ai.load_prompt()
    assert '"hooks"' in system and "evidence" in system
    assert editor_ai.estimate_tokens(system) <= 1200
    assert editor_ai.estimate_tokens(system) + editor_ai.estimate_tokens(user) <= 3000
    assert "story_twist" in user and SEED_HOOK in user
    assert "L0001 (cold open)" in user
    for line in ctx.lines:
        assert f"{line.id}" in user


def test_a_long_transcript_is_cut_to_the_budget(case):
    ctx = context(case)
    long_lines = tuple(editor_ai.Line(f"L{i:04d}", "kata " * 60, "S0418", False)
                       for i in range(1, 200))
    long_ctx = editor_ai.HookContext(**{**ctx.__dict__, "lines": long_lines})
    system, user = editor_ai.build_prompt(long_ctx)
    assert editor_ai.estimate_tokens(system) + editor_ai.estimate_tokens(user) <= 3000
    assert "L0001" in user and "L0199" not in user


# --- grounding and validation (plan §7.1 "Validation") --------------------------------------------------


@pytest.mark.parametrize(("text", "code"), [
    ("Gajinya cuma 3 juta sebulan", "ungrounded_number"),
    ("Gaji 5.000.000 tapi tetap betah", "ungrounded_number"),
    ("Kata Deddy dia security paling galak", "ungrounded_name"),
    ("Security galak versi Jakarta Selatan", "ungrounded_name"),
    ('Dia bilang "sumpah gue benci horor mistis"', "ungrounded_quote"),
    ("Deddy ditahan di pintu belakang", "ungrounded_name"),
    ("Cek potongin.com buat cerita lengkap", "url"),
    ("Cerita lengkap di https://contoh.id/klip", "url"),
    ("Kata @raditya_dika dia paling galak", "handle"),
    ("Security paling galak sedunia #fyp", "hashtag"),
    ("Sutradara ditahan security 😂", "emoji"),
    ("Gue gue nggak nyangka dia sutradaranya", "disfluent"),
    ("x" * 91, "too_long"),
    ("   ", "empty"),
])
def test_hook_problems(case, text, code):
    assert editor_ai.hook_problem(text, context(case)) == code


@pytest.mark.parametrize("text", [
    "Gaji 2 juta tapi betah jadi security",
    "Gaji dua juta, tapi tetap betah",
    "Kata Raditya, gue security paling galak",
    "Pas Filmnya syuting, sutradara ditahan",
    '"Baru kali ini sutradara ditahan di film sendiri"',
    "Kenapa sutradara ini nggak boleh masuk?",
])
def test_grounded_hooks_pass(case, text):
    assert editor_ai.hook_problem(text, context(case)) is None


def test_number_words_and_split_years_ground_digits():
    clip = "tahun 2000 16 gajinya dua puluh lima juta, seratus orang"
    for number in ("2016", "25", "25.000.000", "100"):
        assert editor_ai.grounding_problem(f"Gaji {number} bikin kaget", clip) is None, number
    assert editor_ai.grounding_problem("Gaji 26 juta", clip) == "ungrounded_number"
    assert editor_ai.grounding_problem("Tiga orang datang", clip) == "ungrounded_number"


def scripted(*items):
    return ScriptedLLMClient(list(items), provider="scripted", model="m1")


def hooks(*entries) -> dict:
    return {"hooks": [{"text": text, "style": style, "evidence": evidence}
                      for text, style, evidence in entries]}


LONG_OK = "Security paling galak di mall itu ternyata nahan sutradara filmnya sendiri pas syuting"


def test_validate_drops_invalid_items_with_their_reasons(case):
    assert editor_ai.HOOK_PREFERRED_CHARS < len(LONG_OK) <= editor_ai.HOOK_MAX_CHARS
    ctx = context(case)
    instant = editor_ai.instant_variants(ctx)
    data = hooks(
        ("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan", ["L0003"]),
        ("Kenapa sutradara ini nggak boleh masuk ya?", "pertanyaan", ["L0003"]),
        (SEED_HOOK, "klaim", ["L0002"]),
        ("Gajinya cuma 3 juta sebulan", "angka", ["L0010"]),
        ("Security paling galak ditahan teman", "klaim", []),
        ("Security paling galak ketemu sutradara", "klaim", ["L9999"]),
        (LONG_OK, "klaim", ["L0004"]),
    )
    data["hooks"].append({"style": "klaim", "evidence": ["L0001"]})
    accepted, dropped = editor_ai.validate_hooks(data, ctx, taken=instant, task_id=TASK)
    assert [item["text"] for item in accepted] == [
        "Kenapa sutradara ini nggak boleh masuk?",
        LONG_OK,
    ]
    assert {d["code"] for d in dropped} == {"near_duplicate", "same_as_current",
                                            "ungrounded_number", "evidence", "format"}
    for item in accepted:
        assert item["source"] == "llm" and item["kind"] == "llm" and ID.fullmatch(item["id"])
        assert item["style"] in editor_ai.STYLES and item["evidence"]
        assert item["basis"] and len(item["basis"]) <= 140
        assert isinstance(item["fits"], bool)


def test_unknown_styles_are_kept_without_a_style(case):
    ctx = context(case)
    accepted, _ = editor_ai.validate_hooks(hooks(("Security paling galak ketemu sutradara", "drama",
                                                   ["L0010"])), ctx, taken=(), task_id=TASK)
    assert accepted[0]["style"] is None


@pytest.mark.parametrize("data", [
    {"hooks": "Security paling galak"},
    {"hook": [{"text": "Security paling galak", "evidence": ["L0001"]}]},
    {"hooks": [1, "dua", None]},
    {"hooks": []},
])
def test_malformed_payloads_are_invalid_output(case, data):
    with pytest.raises(editor_ai.InvalidOutput):
        editor_ai.validate_hooks(data, context(case), taken=(), task_id=TASK)


# --- the LLM task ---------------------------------------------------------------------------------------


def run(case, client, *, doc=None, task_id=TASK, deadline_s=editor_ai.DEADLINE_S, env=None):
    return editor_ai.run_task(case["job"], case["clip"], task_id=task_id,
                              request_raw=body(case["seed"] if doc is None else doc),
                              env={} if env is None else env,
                              client_factory=lambda _env, _cache: client,
                              deadline_s=deadline_s)


def task_file(case, task_id=TASK) -> Path:
    return case["clip"] / "suggestions" / f"{task_id}.json"


def test_a_task_writes_its_file_atomically_with_accepted_and_dropped_items(case):
    client = scripted(hooks(("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan", ["L0003"]),
                            ("Kata Deddy dia paling galak", "klaim", ["L0010"])))
    result = run(case, client)
    assert result["state"] == "done" and result["error"] is None
    assert [s["text"] for s in result["suggestions"]] == ["Kenapa sutradara ini nggak boleh masuk?"]
    path = task_file(case)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    record = json.loads(path.read_text(encoding="utf-8"))
    assert record["schema"] == editor_ai.TASK_SCHEMA and record["taskId"] == TASK
    assert record["state"] == "done" and record["task"] == "hooks" and record["clipId"] == CLIP
    assert record["dropped"] == [{"index": 1, "code": "ungrounded_name",
                                  "text": "Kata Deddy dia paling galak"}]
    assert record["llm"]["provider"] == "scripted" and record["llm"]["model"] == "m1"
    assert record["promptVersion"] == editor_ai.PROMPT_VERSION
    assert re.fullmatch(r"[0-9a-f]{64}", record["promptSha256"])
    assert record["suggestions"] == result["suggestions"]
    assert not [p for p in path.parent.iterdir() if p.name != path.name]
    call = client.calls[0]
    assert call["max_output_tokens"] == editor_ai.MAX_OUTPUT_TOKENS
    assert call["system"] == editor_ai.load_prompt()


@pytest.mark.parametrize(("error", "code"), [
    (LLMUnavailable("config_invalid", "Tidak ada penyedia."), "llm_unavailable"),
    (LLMError("rate_limited", "Kuota habis."), "llm_unavailable"),
    (LLMError("bad_json", "Bukan JSON."), "invalid_output"),
    (LLMError("timeout", "Lambat."), "timeout"),
])
def test_llm_failures_become_failed_tasks(case, error, code):
    result = run(case, scripted(error))
    assert result["state"] == "failed" and result["suggestions"] == []
    assert result["error"] == {"code": code, "messageId": f"editor_ai.{code}"}
    record = json.loads(task_file(case).read_text(encoding="utf-8"))
    assert record["error"]["code"] == code and record["llmCode"] == error.code


def test_malformed_json_text_is_rejected(case):
    result = run(case, scripted('{"hooks": [ {"text": "Security"'))
    assert result["state"] == "failed" and result["error"]["code"] == "invalid_output"


def test_the_deadline_stops_the_task(case):
    release = threading.Event()

    def slow(system, user):
        release.wait(5)
        return hooks(("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan", ["L0003"]))

    started = time.monotonic()
    try:
        result = run(case, scripted(slow), deadline_s=0.3)
    finally:
        release.set()
    assert time.monotonic() - started < 2.0
    assert result["state"] == "failed" and result["error"]["code"] == "timeout"
    assert editor_ai.DEADLINE_S == 20.0


def test_llm_off_fails_without_asking_for_a_client(case):
    asked = []
    result = editor_ai.run_task(case["job"], case["clip"], task_id=TASK,
                                request_raw=body(case["seed"]), env={"POTONGIN_LLM": "off"},
                                client_factory=lambda env, cache: asked.append(1))
    assert asked == [] and result["error"]["code"] == "llm_disabled"


def test_no_configured_client_is_llm_unavailable(case):
    result = editor_ai.run_task(case["job"], case["clip"], task_id=TASK,
                                request_raw=body(case["seed"]), env={},
                                client_factory=lambda env, cache: None)
    assert result["error"]["code"] == "llm_unavailable"


def test_a_task_id_is_never_reused(case):
    run(case, scripted(hooks(("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan", ["L0003"]))))
    before = task_file(case).read_bytes()
    with pytest.raises(editor_ai.TaskExists):
        run(case, scripted(hooks(("Security paling galak", "klaim", ["L0010"]))))
    assert task_file(case).read_bytes() == before


def test_task_files_older_than_30_days_are_pruned(case):
    folder = case["clip"] / "suggestions"
    folder.mkdir(mode=0o700)
    old, fresh = folder / f"{uuid.uuid4()}.json", folder / f"{uuid.uuid4()}.json"
    other = folder / "notes.txt"
    for path in (old, fresh, other):
        path.write_text("{}")
    stale = time.time() - 31 * 86400
    os.utime(old, (stale, stale))
    os.utime(other, (stale, stale))
    run(case, scripted(hooks(("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan", ["L0003"]))))
    assert not old.exists() and fresh.exists() and other.exists()


def test_the_editor_client_is_cached_and_bounded(tmp_path):
    env = {"POTONGIN_LLM_PROVIDERS": "groq,openrouter", "GROQ_API_KEY": "gsk_testkey1234567890",
           "OPENROUTER_API_KEY": "sk-or-test123456789", "POTONGIN_LLM_GROQ_TIMEOUT": "120",
           "POTONGIN_LLM_OPENROUTER_REASONING_EFFORT": "high",
           "POTONGIN_LLM_EDITOR_MODELS": "groq/llama-3.1-8b-instant,openrouter/meta-llama/x:free"}
    client = editor_ai.editor_client(env, cache_dir=tmp_path / "llm-cache")
    assert isinstance(client, CachedLLMClient) and client.cache_dir == tmp_path / "llm-cache"
    inner = client.inner
    assert isinstance(inner, FailoverLLMClient)
    groq, openrouter = inner.clients
    assert isinstance(groq, OpenAICompatibleClient)
    assert groq.config.model_chain == ("llama-3.1-8b-instant",)
    assert openrouter.config.model_chain == ("meta-llama/x:free",)
    for provider in (groq, openrouter):
        assert provider.config.timeout <= editor_ai.REQUEST_TIMEOUT_S
        assert provider.config.max_retries == 0
    assert openrouter.config.reasoning_effort == "low"
    assert editor_ai.editor_client({"POTONGIN_LLM": "off"}, cache_dir=tmp_path) is None


def test_free_only_drops_paid_editor_models(tmp_path):
    env = {"POTONGIN_LLM_PROVIDERS": "openrouter", "OPENROUTER_API_KEY": "sk-or-test123456789",
           "POTONGIN_LLM_FREE_ONLY": "1",
           "POTONGIN_LLM_EDITOR_MODELS": "openrouter/paid/model,openrouter/free/model:free"}
    client = editor_ai.editor_client(env, cache_dir=tmp_path)
    assert client.inner.config.model_chain == ("free/model:free",)


# --- QG-AI offline hard gates (plan §7.1): 100 adversarial responses -----------------------------------


def adversarial_responses():
    """50 responses with ungrounded or forbidden items (each labelled) and 50 malformed ones."""
    grounded = [("Kenapa sutradara ini nggak boleh masuk?", ["L0003"]),
                ("Security paling galak ketemu sutradara", ["L0010"]),
                ("Gaji dua juta, tapi tetap betah", ["L0012"])]
    bad = [
        "Gajinya cuma {n} juta sebulan", "Kata {name} dia security paling galak",
        "Security {name} nahan sutradara", 'Dia bilang "{quote}"', "Cek {url} sekarang",
        "Cerita @{handle} di lokasi", "Security paling galak #{tag}", "Sutradara ditahan {emoji}",
        "Tahun {year} sutradara ditahan", "{name} ditahan di pintu belakang",
    ]
    names = ["Deddy", "Raffi", "Nagita", "Jakarta", "Bandung", "Netflix", "Marvel", "Sule", "Andre",
             "Baim", "KPK", "Surabaya"]
    quotes = ["sumpah gue benci horor mistis", "ini film terburuk sepanjang masa",
              "kita bakal bangkrut tahun depan"]
    responses = []
    for index in range(50):
        pattern = bad[index % len(bad)]
        text = pattern.format(n=3 + index % 7, name=names[index % len(names)],
                              quote=quotes[index % len(quotes)], url=f"klip{index}.com",
                              handle=f"akun{index}", tag=f"fyp{index}", emoji="😂🔥"[index % 2],
                              year=1990 + index)
        good = grounded[index % len(grounded)]
        responses.append(({"hooks": [{"text": text, "style": "klaim", "evidence": ["L0010"]},
                                     {"text": good[0], "style": "klaim", "evidence": good[1]}]},
                          {text}))
    malformed = ['{"hooks": [ {"text": "Security"', "bukan json sama sekali", "```json\n{]```",
                 '{"hooks": "Security paling galak"}', '{"hook": []}', '{"hooks": [1, 2, 3]}',
                 '{"hooks": [{"txt": "Security paling galak"}]}', '[{"text": "Security"}]',
                 '{"hooks": null}', '{"hooks": [{"text": 5, "evidence": ["L0001"]}]}']
    for index in range(50):
        responses.append((malformed[index % len(malformed)], None))
    return responses


def test_qg_ai_offline_no_ungrounded_entity_and_no_malformed_output_is_accepted(case):
    ctx = context(case)
    instant = editor_ai.instant_variants(ctx)
    ungrounded_accepted = malformed_accepted = grounded_accepted = 0
    responses = adversarial_responses()
    assert len(responses) == 100
    for data, bad_texts in responses:
        client = scripted(data)
        try:
            response = client.complete_json(system="s", user="u")
            accepted, _dropped = editor_ai.validate_hooks(response.data, ctx, taken=instant,
                                                          task_id=TASK)
        except (LLMError, editor_ai.InvalidOutput):
            accepted = []
        if bad_texts is None:
            malformed_accepted += len(accepted)
            continue
        ungrounded_accepted += sum(1 for item in accepted if item["text"] in bad_texts)
        grounded_accepted += sum(1 for item in accepted if item["text"] not in bad_texts)
    evidence = {"gate": "QG-AI offline", "responses": len(responses),
                "adversarial_items": 50, "malformed_responses": 50,
                "ungrounded_accepted": ungrounded_accepted,
                "malformed_accepted": malformed_accepted,
                "grounded_accepted": grounded_accepted}
    out = os.environ.get("EDITOR_AI_EVIDENCE")
    if out:
        Path(out).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    assert ungrounded_accepted == 0 and malformed_accepted == 0
    assert grounded_accepted > 0


# --- the CLI envelope ------------------------------------------------------------------------------------


def call(case, **envelope):
    return editor_ai.handle(json.dumps(envelope).encode(), jobs_root=case["root"], env={},
                            client_factory=lambda env, cache: scripted(
                                hooks(("Kenapa sutradara ini nggak boleh masuk?", "pertanyaan",
                                       ["L0003"]))))


def test_the_heuristic_op_returns_the_instant_variants(case):
    status, payload = call(case, op="heuristic", jobId=JOB, clipId=CLIP,
                           requestRaw=b64(body(case["seed"])))
    assert status == 0 and set(payload) == {"heuristic"}
    assert payload["heuristic"] == editor_ai.instant_variants(context(case))
    assert not (case["clip"] / "suggestions").exists()


def test_the_run_task_op_runs_and_reports(case):
    status, payload = call(case, op="run-task", jobId=JOB, clipId=CLIP, taskId=TASK,
                           requestRaw=b64(body(case["seed"])))
    assert status == 0 and payload["state"] == "done" and payload["taskId"] == TASK
    assert task_file(case).is_file()


@pytest.mark.parametrize("envelope", [
    {"op": "nope", "jobId": JOB, "clipId": CLIP},
    {"op": "heuristic", "jobId": "not-a-uuid", "clipId": CLIP, "requestRaw": ""},
    {"op": "heuristic", "jobId": JOB, "clipId": "clip_x", "requestRaw": ""},
    {"op": "heuristic", "jobId": JOB, "clipId": CLIP, "requestRaw": "!!", },
    {"op": "heuristic", "jobId": JOB, "clipId": CLIP, "requestRaw": "", "extra": 1},
    {"op": "run-task", "jobId": JOB, "clipId": CLIP, "taskId": "123", "requestRaw": ""},
    {"op": "run-task", "jobId": JOB, "clipId": CLIP, "requestRaw": ""},
])
def test_malformed_envelopes_are_usage_errors(case, envelope):
    status, payload = call(case, **envelope)
    assert status == 2 and payload["error"]["code"] == "internal_error"


@pytest.mark.parametrize("request_body", [
    {"doc": "DOC"},
    {"task": "hooks", "doc": "DOC", "provider": "openai"},
    {"task": "hooks", "doc": "DOC", "model": "gpt"},
    {"task": "judul", "doc": "DOC"},
    {"task": "hooks", "doc": "DOC", "baseUrl": "http://x"},
])
def test_the_request_body_is_exactly_task_and_doc(case, request_body):
    raw = json.dumps({key: (case["seed"] if value == "DOC" else value)
                      for key, value in request_body.items()}).encode()
    status, payload = call(case, op="heuristic", jobId=JOB, clipId=CLIP, requestRaw=b64(raw))
    assert status == 3 and payload["error"]["code"] == "invalid_json"


def test_an_invalid_document_is_422_material(case):
    doc = copy.deepcopy(case["seed"])
    doc["main"]["segments"][1]["out_sf"] = doc["main"]["segments"][1]["in_sf"] + 10
    status, payload = call(case, op="heuristic", jobId=JOB, clipId=CLIP, requestRaw=b64(body(doc)))
    assert status == 6 and payload["errors"]


def test_unknown_jobs_and_clips_are_not_found(case):
    other = str(uuid.uuid4())
    status, _ = call(case, op="heuristic", jobId=other, clipId=CLIP,
                     requestRaw=b64(body(case["seed"])))
    assert status == 4
    status, _ = call(case, op="heuristic", jobId=JOB, clipId="clip_" + "0" * 24,
                     requestRaw=b64(body(case["seed"])))
    assert status == 4


def test_the_time_map_matches_the_clip(case):
    # Guard for the fixture: the body plays S0418–S0439 and the cold open part of S0428.
    pieces = tm.pieces(case["seed"])
    fps = tm.Fps.from_json(case["seed"]["output"]["fps"])
    shown = {w["u"] for w in case["words"]["words"]
             if tm.word_frames(w["s"], w["e"], pieces, fps) is not None}
    assert shown == set(SENTENCES)
