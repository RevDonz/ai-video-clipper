"""Caption and hook track of a document (plan §3.4, §5.4; T1.2a).

Gates: the ASS goldens (every pack + hook) and P-TIME, FFmpeg side. The full P-TIME run is
measured in the reference image (``python -m support.edit_v2_text ptime``); the PR subset below
runs on any FFmpeg with libass.
"""

from __future__ import annotations

import copy
import hashlib
import json

import pytest
from support import edit_v2_fixtures as fixtures
from support import edit_v2_text

from ai_clipper.captions_ass import (
    HookSpec,
    WatermarkSpec,
    build_ass_v2,
    fit_cues,
    layout_hook,
    load_pack,
)
from ai_clipper.edit_v2 import errors
from ai_clipper.edit_v2.captions import CaptionResult, caption_track
from ai_clipper.edit_v2.doc import Issue
from ai_clipper.edit_v2.timemap import Fps, pieces, safe_cs, total_frames, word_frames
from ai_clipper.subtitles import SourceWord, build_frame_cues


def _doc(name: str) -> dict:
    return json.loads((fixtures.DOC_FIXTURES_DIR / "valid" / f"{name}.json").read_bytes())


def _track(doc, context_id: str) -> CaptionResult:
    return caption_track(doc, fixtures.load_context(context_id).words, pieces(doc))


def _valid_cases():
    return [case for case in fixtures.load_cases() if case.file.startswith("valid/")]


def _cue_ids(result: CaptionResult) -> list[str]:
    return [word.id for cue in result.cues for word in cue.words]


def _dialogues(ass: str) -> list[list[str]]:
    return [line.removeprefix("Dialogue: ").split(",", 9) for line in ass.splitlines()
            if line.startswith("Dialogue: ")]


def _cs(timestamp: str) -> int:
    hours, minutes, rest = timestamp.split(":")
    seconds, cents = rest.split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 100 + int(cents)


def test_caption_track_of_every_valid_fixture_is_hashed_and_deterministic():
    for case in _valid_cases():
        doc = json.loads(case.raw())
        result = _track(doc, case.context)
        assert isinstance(result, CaptionResult)
        assert result.ass_sha256 == hashlib.sha256(result.ass.encode("utf-8")).hexdigest()
        assert _track(copy.deepcopy(doc), case.context) == result, case.file
        total = total_frames(pieces(doc))
        for cue in result.cues:
            assert 0 <= cue.f0 < cue.f1 <= total
        for issue in result.warnings:
            assert isinstance(issue, Issue)
            assert errors.base_code(issue.code) in errors.WARNING_CODES
            assert errors.message(issue.code)


def test_cues_never_cross_the_cold_open_join():
    doc = _doc("seed__c30")
    co = [piece for piece in pieces(doc) if piece.seg == "seg_co"]
    co_end = co[-1].out_f0 + co[-1].frames

    result = _track(doc, "c30")

    assert {cue.seg for cue in result.cues} == {"seg_co", "seg_b1"}
    for cue in result.cues:
        assert cue.f1 <= co_end if cue.seg == "seg_co" else cue.f0 >= co_end
    assert len(_dialogues(result.ass)) == len(result.cues) + len(result.hook_lines)


def test_revision_zero_captions_every_visible_word_once_per_segment():
    for name, context_id in (("seed__c30", "c30"), ("seed__c25", "c25"), ("seed__c24", "c24"),
                             ("body_max_300s__c25", "c25")):
        doc = _doc(name)
        words = fixtures.load_context(context_id).words["words"]
        doc_pieces = pieces(doc)
        expected = []
        for segment in doc["main"]["segments"]:
            scope = tuple(p for p in doc_pieces if p.seg == segment["id"])
            expected += [w["id"] for w in words
                         if word_frames(w["s"], w["e"], scope, Fps.from_json(doc["output"]["fps"]))
                         is not None]

        result = _track(doc, context_id)

        assert _cue_ids(result) == expected, name
    assert len(_cue_ids(_track(_doc("body_max_300s__c25"), "c25"))) >= 300


def test_hidden_words_are_excluded_and_edits_are_applied():
    doc = _doc("word_edits__c30")
    edits = doc["captions"]["word_edits"]
    hidden = [word_id for word_id, edit in edits.items() if edit.get("hidden")]

    result = _track(doc, "c30")

    placed = {word.id: word for cue in result.cues for word in cue.words}
    assert hidden and not set(hidden) & set(placed)
    for word_id, edit in edits.items():
        if edit.get("hidden"):
            continue
        if "text" in edit:
            assert placed[word_id].text == edit["text"]
        assert placed[word_id].emphasis == bool(edit.get("emphasis"))
    seed_ids = _cue_ids(_track(_doc("seed__c30"), "c30"))
    assert set(seed_ids) - set(placed) == set(hidden)
    assert "\\1c&H8A5CFF&\\2c&H8A5CFF&}" in result.ass  # karaoke emphasis (defect #6)
    assert "Ijal" in result.ass


def test_removed_words_are_excluded():
    doc = _doc("removal_single__c30")
    removed = {word_id for removal in doc["main"]["removals"] for word_id in removal["words"]}

    result = _track(doc, "c30")

    body_ids = [word.id for cue in result.cues if cue.seg == "seg_b1" for word in cue.words]
    assert removed and not removed & set(body_ids)
    seed = _track(_doc("seed__c30"), "c30")
    seed_body = [word.id for cue in seed.cues if cue.seg == "seg_b1" for word in cue.words]
    assert removed <= set(seed_body)


def test_captions_disabled_keeps_only_the_hook():
    result = _track(_doc("captions_disabled__c30"), "c30")

    assert result.cues == ()
    dialogues = _dialogues(result.ass)
    assert dialogues and {fields[3] for fields in dialogues} == {"Hook"}
    assert len(dialogues) == len(result.hook_lines) >= 1


def test_no_hook_track_means_no_hook_events():
    result = _track(_doc("seed__c25"), "c25")

    assert result.hook_lines == ()
    assert {fields[3] for fields in _dialogues(result.ass)} == {"Caption"}


def test_the_hook_follows_its_item_and_is_frame_safe():
    doc = _doc("hook_y_max__c30")
    item = doc["tracks"][0]["items"][0]
    fps = Fps.from_json(doc["output"]["fps"])

    result = _track(doc, "c30")

    layout = layout_hook(item["payload"]["text"], play_res=(720, 1280),
                         y_e5=item["transform"]["y_e5"])
    assert result.hook_lines == layout.lines
    hook_events = [fields for fields in _dialogues(result.ass) if fields[3] == "Hook"]
    assert [(_cs(f[1]), _cs(f[2])) for f in hook_events] == [
        (0, safe_cs(item["dur_f"], fps))] * len(layout.lines)
    assert layout.top == 40000 * 1280 // 100000


def test_hook_overflow_warning_names_the_item():
    doc = _doc("seed__c30")
    item = doc["tracks"][0]["items"][0]
    item["payload"]["text"] = ("WWWWWWWWW " * 9).strip()

    result = _track(doc, "c30")

    overflow = [issue for issue in result.warnings if issue.code == "hook_overflow"]
    assert overflow == [Issue("hook_overflow", "/tracks/0/items/0/payload/text", "it_hook", 0)]
    assert len(result.hook_lines) == 3 and result.hook_lines[-1].endswith("…")
    assert not [i for i in _track(_doc("seed__c30"), "c30").warnings
                if i.code == "hook_overflow"]


# --- hook designs (CONTRACTS §5.33) ---------------------------------------------------------


def _with_design(design: str, text: str | None = None) -> dict:
    doc = _doc("seed__c30")
    item = doc["tracks"][0]["items"][0]
    item["payload"]["design"] = {"id": design, "v": 1}
    if text is not None:
        item["payload"]["text"] = text
    return doc


@pytest.mark.parametrize("design", ["kicker", "blok", "kotak"])
def test_the_items_hook_design_draws_the_hook(design):
    doc = _with_design(design)
    item = doc["tracks"][0]["items"][0]
    fps = Fps.from_json(doc["output"]["fps"])

    result = _track(doc, "c30")

    layout = layout_hook(item["payload"]["text"], play_res=(720, 1280),
                         y_e5=item["transform"]["y_e5"], design=(design, 1))
    assert result.hook_lines == layout.lines
    hook_events = [fields for fields in _dialogues(result.ass) if fields[3] == "Hook"]
    assert [fields[9] for fields in hook_events] == list(layout.events)
    assert {(_cs(f[1]), _cs(f[2])) for f in hook_events} == {(0, safe_cs(item["dur_f"], fps))}
    assert result.ass != _track(_doc("seed__c30"), "c30").ass


@pytest.mark.parametrize("design", ["kicker", "blok", "kotak"])
def test_hook_overflow_is_reported_for_every_design(design):
    result = _track(_with_design(design, ("WWWWWWWWWWWWW " * 6).strip()), "c30")

    overflow = [issue for issue in result.warnings if issue.code == "hook_overflow"]
    assert overflow == [Issue("hook_overflow", "/tracks/0/items/0/payload/text", "it_hook", 0)]
    assert result.hook_lines[-1].endswith("…")
    assert not [issue for issue in _track(_with_design(design), "c30").warnings
                if issue.code == "hook_overflow"]


def test_glyph_unsupported_follows_the_hook_designs_font():
    # DejaVu Sans Bold (the bar) has ♥; Montserrat ExtraBold (the other designs) lacks it.
    text = "Suka ♥ banget"
    bar = _track(_with_design("legacy-bar", text), "c30")
    assert not [issue for issue in bar.warnings if issue.code.startswith("glyph")]
    for design in ("kicker", "blok", "kotak"):
        result = _track(_with_design(design, text), "c30")
        assert [(i.code, i.path, i.ref) for i in result.warnings
                if i.code.startswith("glyph")] == [
            ("glyph_unsupported:U+2665", "/tracks/0/items/0/payload/text", "it_hook")], design


def _with_word_text(doc: dict, context_id: str, text: str, pack: str | None = None) -> tuple:
    doc = copy.deepcopy(doc)
    if pack is not None:
        doc["captions"]["pack"]["id"] = pack
    result = _track(doc, context_id)
    word = result.cues[3].words[0]
    doc["captions"]["word_edits"] = {word.id: {"text": text}}
    return doc, word


def test_glyph_unsupported_is_raised_for_characters_the_pack_font_lacks():
    seed = _doc("seed__c30")
    doc, word = _with_word_text(seed, "c30", "api🔥")  # karaoke: DejaVu Sans Bold

    result = _track(doc, "c30")

    glyph = [issue for issue in result.warnings if issue.code.startswith("glyph_unsupported")]
    assert [(i.code, i.path, i.ref) for i in glyph] == [
        ("glyph_unsupported:U+1F525", f"/captions/word_edits/{word.id}/text", word.id)]
    assert glyph[0].f == next(w.f0 for c in result.cues for w in c.words if w.id == word.id)
    # DejaVu Sans 2.37 maps 😂, so a DejaVu pack does not flag it; Montserrat packs do.
    doc, _ = _with_word_text(seed, "c30", "ketawa😂")
    assert not [i for i in _track(doc, "c30").warnings if i.code.startswith("glyph")]
    for pack in ("bold", "box"):
        doc, word = _with_word_text(seed, "c30", "ketawa😂", pack=pack)
        codes = [i.code for i in _track(doc, "c30").warnings if i.ref == word.id]
        assert codes == ["glyph_unsupported:U+1F602"], pack


def test_glyph_unsupported_is_raised_for_the_hook_text():
    doc = _doc("seed__c30")
    doc["tracks"][0]["items"][0]["payload"]["text"] = "Harga ₿ naik"

    result = _track(doc, "c30")

    assert [(i.code, i.path, i.ref) for i in result.warnings
            if i.code.startswith("glyph")] == [
        ("glyph_unsupported:U+20BF", "/tracks/0/items/0/payload/text", "it_hook")]


def test_unsafe_zone_warnings_for_captions_and_hook():
    seed = _track(_doc("seed__c30"), "c30")
    zone = [issue for issue in seed.warnings if issue.code == "unsafe_zone"]
    # K5: the seed keeps today's 17% bottom margin, inside TikTok's 280 px bottom zone.
    assert zone == [Issue("unsafe_zone", "/captions/overrides/y_e5", None, seed.cues[0].f0)]

    raised = _doc("seed__c30")
    raised["captions"]["overrides"]["y_e5"] = 72000
    assert not [i for i in _track(raised, "c30").warnings if i.code == "unsafe_zone"]

    high_hook = _doc("hook_y_min__c30")
    high_hook["captions"]["overrides"]["y_e5"] = 72000
    assert [issue for issue in _track(high_hook, "c30").warnings
            if issue.code == "unsafe_zone"] == [
        Issue("unsafe_zone", "/tracks/0/items/0/transform/y_e5", "it_hook", 0)]


def test_caption_track_is_build_frame_cues_plus_build_ass_v2():
    doc = _doc("full_example__c30")
    context = fixtures.load_context("c30")
    fps = Fps.from_json(doc["output"]["fps"])
    edits = doc["captions"]["word_edits"]
    source = tuple(
        SourceWord(w["id"], w["s"], w["e"], edits.get(w["id"], {}).get("text", w["t"]),
                   bool(edits.get(w["id"], {}).get("emphasis")))
        for w in context.words["words"] if not edits.get(w["id"], {}).get("hidden"))
    pack = load_pack(doc["captions"]["pack"]["id"], 1)
    overrides = doc["captions"]["overrides"]
    doc_pieces = pieces(doc)
    cues = fit_cues(build_frame_cues(source, doc_pieces, fps, max_words=pack.words_per_cue),
                    pack=pack, play_res=(720, 1280), overrides=overrides)
    item = doc["tracks"][0]["items"][0]
    hook = HookSpec(item["payload"]["text"], 0, item["dur_f"], item["transform"]["y_e5"])

    result = caption_track(doc, context.words, doc_pieces)

    assert result.cues == cues
    assert result.ass == build_ass_v2(cues, play_res=(720, 1280), fps=fps,
                                      total_frames=total_frames(doc_pieces), pack=pack,
                                      overrides=overrides, hook=hook)


# --- "Kata per baris" (words_max) and the existing packs (CONTRACTS §5.30) ----------------------


@pytest.mark.parametrize("words_max", [1, 2, 3, 4])
def test_words_max_caps_every_line_and_keeps_every_word(words_max):
    seed = _doc("seed__c30")
    doc = copy.deepcopy(seed)
    doc["captions"]["overrides"]["words_max"] = words_max

    result = _track(doc, "c30")

    reference = _track(seed, "c30")
    assert _cue_ids(result) == _cue_ids(reference)
    assert all(1 <= len(cue.words) <= words_max for cue in result.cues)
    assert max(len(cue.words) for cue in result.cues) == words_max
    if words_max < 4:
        assert len(result.cues) > len(reference.cues)
        assert result.ass != reference.ass


@pytest.mark.parametrize("pack", ["classic", "karaoke", "bold", "box"])
def test_the_pack_count_written_out_changes_no_cue_and_no_byte(pack):
    # Automatic clips stay as they were: their seeds carry no words_max, and a document that
    # names the pack's own count compiles to the same cues, ASS and warnings.
    doc = _doc("seed__c30")
    doc["captions"]["pack"]["id"] = pack
    assert "words_max" not in doc["captions"]["overrides"]
    explicit = copy.deepcopy(doc)
    explicit["captions"]["overrides"]["words_max"] = load_pack(pack, 1).words_per_cue

    assert _track(explicit, "c30") == _track(doc, "c30")


def test_seeds_and_pack_defaults_of_the_existing_packs_are_unchanged():
    from ai_clipper.edit_v2 import PACK_DEFAULT_OVERRIDES

    for pack in ("classic", "karaoke", "bold", "box"):
        assert dict(PACK_DEFAULT_OVERRIDES[pack]) == {
            "y_e5": 83000, "size_pm": 1000, "case": "upper" if pack == "bold" else "asis",
            "highlight": "#FFE14D", "emphasis": "#FF5C8A"}
    for context_id in ("c24", "c25", "c30"):
        seed = json.loads((fixtures.DOC_FIXTURES_DIR / "contexts" / f"{context_id}.seed.json")
                          .read_bytes())
        assert set(seed["captions"]["overrides"]) == {"y_e5", "size_pm", "case", "highlight",
                                                      "emphasis"}


def test_sorot_seed_document_compiles_one_box_per_spoken_word():
    doc = _doc("pack_sorot__c30")

    result = _track(doc, "c30")

    events = _dialogues(result.ass)
    boxes = [fields for fields in events if "\\p1}" in fields[9]]
    words = sum(len(cue.words) for cue in result.cues)
    assert 0 < len(boxes) <= words
    assert {fields[3] for fields in events} == {"Sorot", "Hook"}


# --- "Animasi masuk" (entrance) on a document (CONTRACTS §5.39) -------------------------------


@pytest.mark.parametrize("pack", ["classic", "karaoke", "bold", "box", "sorot"])
def test_no_entrance_and_an_explicit_none_compile_to_the_same_track(pack):
    # Automatic clips stay as they were: their seeds carry no entrance, and "none" written out
    # compiles to the same cues, ASS and warnings.
    doc = _doc("seed__c30")
    doc["captions"]["pack"]["id"] = pack
    assert "entrance" not in doc["captions"]["overrides"]
    explicit = copy.deepcopy(doc)
    explicit["captions"]["overrides"]["entrance"] = "none"

    assert _track(explicit, "c30") == _track(doc, "c30")


@pytest.mark.parametrize(("name", "opening"), [
    ("entrance_fade__c30", "{\\fad("),
    ("entrance_pop__c30", "{\\fscx70\\fscy70\\t(0,"),
    ("entrance_blur__c30", "{\\fad("),
])
def test_an_entrance_opens_every_line_and_moves_no_cue(name, opening):
    doc = _doc(name)
    plain = copy.deepcopy(doc)
    del plain["captions"]["overrides"]["entrance"]

    result, reference = _track(doc, "c30"), _track(plain, "c30")

    assert result.cues == reference.cues and result.warnings == reference.warnings
    events, before = _dialogues(result.ass), _dialogues(reference.ass)
    assert [fields[:9] for fields in events] == [fields[:9] for fields in before]
    starts = {max(0, safe_cs(cue.f0, Fps(30000, 1001))) for cue in result.cues}
    captions = [fields for fields in events if fields[3] != "Hook"]
    opened = [fields for fields in captions if _cs(fields[1]) in starts]
    assert opened and all(fields[9].startswith(opening) for fields in opened)
    assert all(not fields[9].startswith(opening) for fields in captions if fields not in opened)


# --- The text watermark on a document (CONTRACTS §5.43) ---------------------------------------


def test_the_documents_watermark_is_the_first_event_and_moves_nothing_else():
    doc = _doc("seed__c30")
    plain = _track(doc, "c30")
    doc["watermark"] = {"text": "@potongin.klip", "pos": "bottom_right", "size_pm": 1200,
                        "opacity_pm": 700}

    result = _track(doc, "c30")

    item = doc["tracks"][0]["items"][0]
    hook = HookSpec(item["payload"]["text"], 0, item["dur_f"], item["transform"]["y_e5"])
    spec = WatermarkSpec("@potongin.klip", "bottom_right", 1200, 700)
    assert result.ass == build_ass_v2(
        result.cues, play_res=(720, 1280), fps=Fps(30000, 1001),
        total_frames=total_frames(pieces(doc)), pack=load_pack("karaoke", 1),
        overrides=doc["captions"]["overrides"], hook=hook, watermark=spec)
    assert result.cues == plain.cues and result.warnings == plain.warnings
    events = _dialogues(result.ass)
    assert events[0][3] == "Watermark" and events[1:] == _dialogues(plain.ass)


def test_glyph_unsupported_is_raised_for_the_watermark_text():
    doc = _doc("captions_disabled__c30")
    doc["watermark"] = {"text": "Harga ₿ naik", "pos": "top_left", "size_pm": 1000,
                        "opacity_pm": 850}

    result = _track(doc, "c30")

    assert [(i.code, i.path, i.ref, i.f) for i in result.warnings
            if i.path == "/watermark/text"] == [
        ("glyph_unsupported:U+20BF", "/watermark/text", None, 0)]


# --- gate: ASS goldens (5 packs + every hook design) ----------------------------------------


def test_ass_goldens_cover_every_pack_and_the_hook():
    names = {name for name, _file, _context in edit_v2_text.GOLDEN_CASES}
    assert {"classic__c30", "karaoke__c30", "bold__c30", "box__c30", "sorot__c30", "hook__c30",
            "words_max_1__c30", "hook_kicker__c30", "hook_blok__c30", "hook_kotak__c30",
            "entrance_fade__c30", "entrance_pop__c30", "entrance_blur__c30",
            "watermark__c30", "watermark_max__c30", "watermark_min__c24"} <= names
    styles = set()
    for name in names:
        text = (edit_v2_text.GOLDEN_DIR / f"{name}.ass").read_text(encoding="utf-8")
        styles |= {fields[3] for fields in _dialogues(text)}
    assert styles == {"Caption", "Karaoke", "Bold", "Box", "Sorot", "Hook", "Watermark"}


def test_ass_goldens_on_disk_equal_a_fresh_render():
    rendered = edit_v2_text.render_goldens()
    on_disk = {path.name: path.read_bytes() for path in edit_v2_text.GOLDEN_DIR.glob("*.ass")}
    assert sorted(on_disk) == sorted(rendered)
    for name, data in rendered.items():
        assert on_disk[name] == data, name


# --- gate: P-TIME, FFmpeg side --------------------------------------------------------------


def test_ptime_expected_events_match_the_emitted_events():
    for case in edit_v2_text.ptime_cases(quick=False):
        ass = edit_v2_text.case_ass(case)
        expected = edit_v2_text.expected_events(case)
        emitted = _dialogues(ass)
        assert len(emitted) == len(expected), case.name
        for fields, event in zip(emitted, expected, strict=True):
            assert (_cs(fields[1]), _cs(fields[2])) == (
                max(0, safe_cs(event.a, case.fps)), safe_cs(event.b, case.fps)), case.name
    counts = edit_v2_text.ptime_counts(edit_v2_text.ptime_cases(quick=False))
    assert counts["hazard_boundaries"] > 0
    assert set(counts["rates"]) == {"24/1", "25/1", "30/1", "24000/1001", "30000/1001"}


def test_ptime_ffmpeg_subset_has_no_mismatch(edit_v2_libass):
    report = edit_v2_text.run_ptime(quick=True, jobs=2)

    assert report["events"] > 0 and report["onsets"] > 0
    assert report["hazard_boundaries"] > 0
    assert report["mismatches"] == 0, report["mismatch_details"]


@pytest.mark.parametrize("frame", [0, 1, 7])
def test_hook_fade_makes_frame_zero_transparent_only(frame):
    # \fad(150,250) at now == Start is fully transparent (libass and JASSUB alike); the frame-safe
    # rule keeps every later frame at least 2 ms after Start, so only frame 0 can be affected.
    fps = Fps(30000, 1001)
    event = edit_v2_text.ExpectedEvent(0, 120, (), True, "hook")
    assert edit_v2_text.expected_visible(event, frame, fps, start_cs=0) is (frame != 0)


def test_quick_ptime_is_a_subset_with_hazard_frames():
    cases = edit_v2_text.ptime_cases(quick=True)
    assert all(case.cues or case.hook for case in cases)
    assert {f"{c.fps.num}/{c.fps.den}" for c in cases} == {"25/1", "30000/1001"}
    assert {case.pack for case in cases} == {"classic", "karaoke", "bold", "box", "sorot"}
    counts = edit_v2_text.ptime_counts(cases)
    assert counts["hazard_boundaries"] > 0
    assert counts["events"] < edit_v2_text.ptime_counts(edit_v2_text.ptime_cases())["events"]


# --- the \p box variant (plan §5.4: the fallback if BorderStyle 3 fails P-TXT) ---------------


def test_ptime_measures_the_vector_box_variant_too():
    for quick, rates in ((False, 5), (True, 2)):
        cases = [case for case in edit_v2_text.ptime_cases(quick) if case.box_style == "vector"]
        assert len(cases) == rates
        for case in cases:
            assert (case.pack, case.background) == ("box", "gray")
            texts = [fields[9] for fields in _dialogues(edit_v2_text.case_ass(case))
                     if fields[3] == "Box"]
            rectangles = [text for text in texts if "\\p1}m 0 0 l " in text]
            assert rectangles and len(texts) == 2 * len(rectangles)


def test_vector_box_covers_the_same_pixels_as_the_border_style_3_box(edit_v2_libass):
    # Inside the BorderStyle 3 box (text and fill) the two variants are identical; the edges
    # move by at most one pixel (padding H/100 rounded to whole pixels, crisp rectangle edges).
    report = edit_v2_text.box_vector_geometry()

    assert len(report["samples"]) == len(edit_v2_text.BOX_GEOMETRY_TEXTS)
    for sample in report["samples"]:
        assert sample["interior_differing_px"] == 0, sample
        assert sample["max_edge_shift_px"] <= 1, sample
    assert report["failures"] == 0
