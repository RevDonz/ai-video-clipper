"""clip-edit-v2 document: parse, canonical bytes, hashes and validation (plan §3, T1.1).

The committed fixtures (tests/fixtures/edit_v2/docs/) are classified here at validator level;
``test_edit_v2_store.py`` classifies them again through ``store.put`` (which adds the revision
and parent checks against the stored revision).
"""

from __future__ import annotations

import copy
import hashlib
import json

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import doc as docmod
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import (
    MAX_DOC_BYTES,
    Issue,
    canonical_bytes,
    content_equals_seed,
    content_sha256,
    doc_sha256,
    parse_doc,
    validate_doc,
)
from ai_clipper.edit_v2.errors import (
    PARSE_CODES,
    SEMANTIC_CODES,
    DocInvalid,
    SchemaTooNew,
)

CASES = fixtures.load_cases()
# Checked against the stored revision by store.put, not by validate_doc.
STORE_LEVEL = {"revision_mismatch__skip", "revision_mismatch__large", "parent_mismatch__other_sha"}


def _stem(case: fixtures.FixtureCase) -> str:
    return case.file.rsplit("/", 1)[-1][: -len(".json")]


def _raw(doc: object) -> bytes:
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def rev1(context: fixtures.Context) -> dict:
    """Revision 1 of a context: the seed, unchanged, saved once."""
    doc = copy.deepcopy(context.seed)
    doc["revision"] = 1
    doc["parent_sha256"] = fixtures.etag(context.seed)
    doc["audit"].update(updated_at_ms=fixtures.EDITED_AT_MS, editor="editor-v3/1.0.0",
                        last_command="ResetToSeed")
    return doc


def check(doc: dict, context: fixtures.Context, *, seed: bool = True, words: dict | None = None):
    return validate_doc(doc, words=context.words if words is None else words,
                        assets=context.assets, seed=context.seed if seed else None)


def codes(validation) -> set[str]:
    return {issue.code for issue in validation.errors}


def parse_error(raw: bytes) -> DocInvalid:
    with pytest.raises(DocInvalid) as caught:
        parse_doc(raw)
    return caught.value


# --- fixture classification ---------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=[c.file for c in CASES])
def test_every_fixture_is_classified_with_its_exact_code(case, contexts):
    context = contexts[case.context]
    raw = case.raw()
    if case.code in PARSE_CODES:
        error = parse_error(raw)
        assert error.code == case.code
        assert error.path == case.path
        assert all(issue.code == case.code for issue in error.issues)
        return
    if case.code == "schema_too_new":
        with pytest.raises(SchemaTooNew) as caught:
            parse_doc(raw)
        assert caught.value.path == case.path
        return
    doc = parse_doc(raw)
    validation = validate_doc(doc, words=context.words, assets=context.assets,
                              seed=None if case.check == "validate" else context.seed)
    if case.code is None or _stem(case) in STORE_LEVEL:
        assert validation.errors == ()
        assert validation.ok
        assert set(case.warnings) <= {issue.code for issue in validation.warnings}
        return
    assert case.code in SEMANTIC_CODES
    assert validation.errors, case.file
    assert {issue.code for issue in validation.errors} == {case.code}
    assert case.path in {issue.path for issue in validation.errors}


def test_valid_fixtures_have_no_unexpected_warnings(contexts):
    for case in CASES:
        if case.code is not None:
            continue
        context = contexts[case.context]
        validation = validate_doc(parse_doc(case.raw()), words=context.words,
                                  assets=context.assets,
                                  seed=None if case.check == "validate" else context.seed)
        assert {issue.code for issue in validation.warnings} == set(case.warnings), case.file


# --- parse level ----------------------------------------------------------------------------------


def test_parse_returns_a_plain_dict_equal_to_the_json(contexts):
    doc = rev1(contexts["c30"])
    assert parse_doc(_raw(doc)) == doc
    assert parse_doc(canonical_bytes(doc)) == doc


@pytest.mark.parametrize(
    ("raw", "path"),
    [
        (b'{"a": 1.0}', "/a"),
        (b'{"a": 8e0}', "/a"),
        (b'{"a": 1E+2}', "/a"),
        (b'{"a": -0.0}', "/a"),
        (b'{"a": [1, 2, {"b": 0.5}]}', "/a/2/b"),
        (b'{"a": NaN}', "/a"),
        (b'{"a": {"b": Infinity}}', "/a/b"),
        (b'{"a": [-Infinity]}', "/a/0"),
    ],
)
def test_floats_nan_and_infinity_are_rejected_with_their_pointer(raw, path):
    error = parse_error(raw)
    assert (error.code, error.path) == ("float_not_allowed", path)


@pytest.mark.parametrize(
    ("raw", "code", "path"),
    [
        (b'{"a": 1, "a": 2}', "duplicate_key", "/a"),
        (b'{"x": {"y": [{"k": 1, "k": 1}]}}', "duplicate_key", "/x/y/0/k"),
        (b'{"a/b~c": 1, "a/b~c": 2}', "duplicate_key", "/a~1b~0c"),
        # The first problem in document order wins.
        (b'{"a": 1, "a": 2, "b": 1.5}', "duplicate_key", "/a"),
        (b'{"b": 1.5, "a": 1, "a": 2}', "float_not_allowed", "/b"),
        (b'{"x": {"y": [1, 2.5]}, "x": 1}', "float_not_allowed", "/x/y/1"),
        (b'{"x": {"y": 1, "y": 2}, "z": 0.5}', "duplicate_key", "/x/y"),
    ],
)
def test_duplicate_keys_are_rejected_and_the_first_problem_wins(raw, code, path):
    error = parse_error(raw)
    assert (error.code, error.path) == (code, path)


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"{",
        b"[]",
        b'"text"',
        b"null",
        b"\xef\xbb\xbf{}",
        b'{"a": "\xff"}',
        b'{"a": 1} {}',
        b'{"a": 1,}',
        b"{'a': 1}",
        b'{"a": "raw\ncontrol"}',
        b'{"a": ' + b"1" * 5000 + b"}",
        b'{"a": ' + b"[" * 100_000 + b"]" * 100_000 + b"}",
    ],
)
def test_malformed_json_is_invalid_json(raw):
    error = parse_error(raw)
    assert (error.code, error.path) == ("invalid_json", "")


def test_size_limit_is_exact(contexts):
    base = _raw(rev1(contexts["c30"]))
    exact = base + b" " * (MAX_DOC_BYTES - len(base))
    assert len(exact) == MAX_DOC_BYTES
    assert parse_doc(exact)["revision"] == 1
    error = parse_error(exact + b" ")
    assert (error.code, error.path) == ("too_large", "")
    assert MAX_DOC_BYTES == 1 << 20


def test_raw_must_be_bytes():
    with pytest.raises(DocInvalid):
        parse_doc('{"a": 1}')  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda d: d.update(markers=[]), "/markers"),
        (lambda d: d["base"].update(extra=1), "/base/extra"),
        (lambda d: d["base"]["source"].update(codec="h264"), "/base/source/codec"),
        (lambda d: d["base"]["engine"].update(core_version="1"), "/base/engine/core_version"),
        (lambda d: d["output"].update(quality="standar"), "/output/quality"),
        (lambda d: d["main"]["joins"][0].update(dur_f=0), "/main/joins/0/dur_f"),
        (lambda d: d["captions"].update(offset_ms=0), "/captions/offset_ms"),
        (lambda d: d["captions"]["pack"].update(variant="x"), "/captions/pack/variant"),
        (lambda d: d["layout"]["default"].update(zoom=1), "/layout/default/zoom"),
        (lambda d: d["audio"]["master"].update(limiter=True), "/audio/master/limiter"),
        (lambda d: d["audit"].update(user="x"), "/audit/user"),
        # A hook item has no "end"; the key set is chosen by the track's kind.
        (lambda d: d["tracks"][0]["items"][0].update(end={"at": "clip_end"}),
         "/tracks/0/items/0/end"),
        (lambda d: d["tracks"][0].update(band="over_text"), "/tracks/0/band"),
        (lambda d: d["tracks"][0]["items"][0]["transform"].update(w_e5=10000),
         "/tracks/0/items/0/transform/w_e5"),
        (lambda d: d["tracks"][0]["items"][0]["payload"]["design"].update(accent="#FFFFFF"),
         "/tracks/0/items/0/payload/design/accent"),
        (lambda d: d["tracks"][0]["items"][0]["start"].update(frame=0),
         "/tracks/0/items/0/start/frame"),
    ],
)
def test_unknown_keys_are_rejected_at_every_level(contexts, mutate, path):
    doc = rev1(contexts["c30"])
    mutate(doc)
    error = parse_error(_raw(doc))
    assert (error.code, error.path) == ("unknown_key", path)


def _logo_and_music(context) -> dict:
    doc = rev1(context)
    doc["tracks"].append({"id": "tr_ovr", "kind": "visual", "band": "over_text",
                          "role": "overlay", "items": [{
                              "id": "it_logo", "type": "image", "start": {"at": "clip_start"},
                              "end": {"at": "clip_end"},
                              "transform": {"x_e5": 88000, "y_e5": 7000, "w_e5": 16000,
                                            "opacity_pm": 850},
                              "payload": {"asset": fixtures.LOGO, "mode": "free"},
                              "origin": "user"}]})
    doc["tracks"].append({"id": "tr_mus", "kind": "audio", "role": "music", "items": [{
        "id": "it_music", "type": "audio", "start": {"at": "clip_start"},
        "end": {"at": "clip_end"},
        "payload": {"asset": fixtures.MUSIC, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
                    "fade_in_f": 15, "fade_out_f": 30,
                    "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30,
                             "release_ms": 400, "hold_ms": 250, "detector": "words"}},
        "origin": "user"}]})
    doc["assets"][fixtures.LOGO] = dict(context.assets[fixtures.LOGO])
    doc["assets"][fixtures.MUSIC] = dict(context.assets[fixtures.MUSIC])
    return doc


@pytest.mark.parametrize(
    ("mutate", "path"),
    [
        (lambda d: d["tracks"][1]["items"][0].update(dur_f=30), "/tracks/1/items/0/dur_f"),
        (lambda d: d["tracks"][1]["items"][0]["payload"].update(text="x"),
         "/tracks/1/items/0/payload/text"),
        (lambda d: d["tracks"][2]["items"][0].update(transform={"x_e5": 1, "y_e5": 1}),
         "/tracks/2/items/0/transform"),
        (lambda d: d["tracks"][2]["items"][0]["payload"]["duck"].update(threshold=1),
         "/tracks/2/items/0/payload/duck/threshold"),
        (lambda d: d["assets"][fixtures.LOGO].update(duration_ms=1),
         f"/assets/{fixtures.LOGO}/duration_ms"),
        (lambda d: d["assets"][fixtures.MUSIC].update(w=1), f"/assets/{fixtures.MUSIC}/w"),
    ],
)
def test_item_and_asset_key_sets_follow_the_track_and_asset_kind(contexts, mutate, path):
    doc = _logo_and_music(contexts["c30"])
    parse_doc(_raw(doc))
    mutate(doc)
    error = parse_error(_raw(doc))
    assert (error.code, error.path) == ("unknown_key", path)


def test_other_kinds_use_the_union_of_the_key_sets_and_anchors_the_anchor_union(contexts):
    doc = _logo_and_music(contexts["c30"])
    # A text track (Stage 2) with union keys parses; the validator reports op_disabled.
    doc["tracks"].append({"id": "tr_txt", "kind": "text", "band": "over_text", "role": "overlay",
                          "items": [{"id": "it_txt", "type": "text", "start": {"at": "out", "f": 0},
                                     "end": {"at": "clip_end"}, "dur_f": 30,
                                     "transform": {"x_e5": 1, "y_e5": 1, "w_e5": 1,
                                                   "opacity_pm": 1},
                                     "payload": {"text": "x", "design": {"id": "a", "v": 1},
                                                 "asset": "x", "mode": "free"},
                                     "origin": "user"}]})
    doc["tracks"][1]["items"][0]["start"] = {"at": "word", "word": "w048200", "edge": "start",
                                             "offset_f": 0, "seg": "seg_b1"}
    doc["assets"]["sha256:" + "0" * 64] = {"kind": "video", "mime": "video/mp4", "w": 1, "h": 1,
                                          "duration_ms": 1, "lufs_c": 1}
    assert parse_doc(_raw(doc)) == doc


def test_schema_minor_newer_is_426_before_unknown_keys_but_after_json_problems(contexts):
    doc = rev1(contexts["c30"])
    doc["schema_minor"] = 1
    doc["markers"] = []
    with pytest.raises(SchemaTooNew) as caught:
        parse_doc(_raw(doc))
    assert caught.value.path == "/schema_minor"
    assert caught.value.code == "schema_too_new"
    text = _raw(doc).replace(b'"cut_fade_ms": 8', b'"cut_fade_ms": 8.5')
    assert parse_error(text).code == "float_not_allowed"
    doc["schema_minor"] = "1"
    del doc["markers"]
    parsed = parse_doc(_raw(doc))
    assert codes(check(parsed, contexts["c30"])) == {"range_invalid"}


@pytest.mark.parametrize(
    ("value", "code"),
    [
        ("tab\there", "control_char"),
        ("del\x7f", "control_char"),
        ("c1\x85", "control_char"),
        ("nul\x00", "control_char"),
        ("é", "not_nfc"),
        ("Å", "not_nfc"),  # ANGSTROM SIGN normalises to U+00C5
    ],
)
def test_text_rules_apply_to_every_string(contexts, value, code):
    doc = rev1(contexts["c30"])
    doc["audit"]["editor"] = value
    error = parse_error(_raw(doc))
    assert (error.code, error.path) == (code, "/audit/editor")


def test_text_rules_apply_to_keys_too(contexts):
    doc = rev1(contexts["c30"])
    doc["captions"]["word_edits"] = {"w04\u0007": {"hidden": True}}
    error = parse_error(_raw(doc))
    assert (error.code, error.path) == ("control_char", "/captions/word_edits/w04\u0007")
    doc["captions"]["word_edits"] = {"é": {"hidden": True}}
    assert parse_error(_raw(doc)).code == "not_nfc"


def test_format_characters_and_emoji_are_allowed(contexts):
    doc = rev1(contexts["c30"])
    doc["tracks"][0]["items"][0]["payload"]["text"] = "Ketawa \U0001f602 zero‍width"
    assert parse_doc(_raw(doc))["tracks"][0]["items"][0]["payload"]["text"].startswith("Ketawa")


# --- canonical bytes and hashes --------------------------------------------------------------------


def test_canonical_bytes_are_sorted_compact_utf8(contexts):
    doc = {"b": [1, {"z": "é", "a": None}], "a": True}
    assert canonical_bytes(doc) == '{"a":true,"b":[1,{"a":null,"z":"é"}]}'.encode()
    seed = contexts["c30"].seed
    stored = (fixtures.DOC_FIXTURES_DIR / "contexts" / "c30.seed.json").read_bytes()
    assert canonical_bytes(seed) == stored
    assert doc_sha256(seed) == hashlib.sha256(stored).hexdigest() == fixtures.etag(seed)


def test_canonical_bytes_accept_read_only_mappings(contexts):
    from types import MappingProxyType

    doc = rev1(contexts["c30"])
    proxy = MappingProxyType({**doc, "audit": MappingProxyType(doc["audit"])})
    assert canonical_bytes(proxy) == canonical_bytes(doc)


def test_content_hash_ignores_revision_parent_and_audit_only(contexts):
    context = contexts["c30"]
    doc = rev1(context)
    assert content_sha256(doc) == content_sha256(context.seed)
    assert doc_sha256(doc) != doc_sha256(context.seed)
    assert content_equals_seed(doc, context.seed)
    doc["audit"]["last_command"] = "Anything"
    doc["revision"] = 7
    assert content_equals_seed(doc, context.seed)
    edited = copy.deepcopy(doc)
    edited["main"]["cut_fade_ms"] = 9
    assert not content_equals_seed(edited, context.seed)
    assert content_sha256(edited) != content_sha256(doc)
    content = {k: v for k, v in doc.items() if k not in ("revision", "parent_sha256", "audit")}
    assert content_sha256(doc) == hashlib.sha256(canonical_bytes(content)).hexdigest()


def test_rev1_unchanged_fixtures_equal_their_seed_content(contexts):
    for context_id in fixtures.CONTEXT_IDS:
        raw = (fixtures.DOC_FIXTURES_DIR / "valid" / f"rev1_unchanged__{context_id}.json").read_bytes()
        assert content_equals_seed(parse_doc(raw), contexts[context_id].seed)
    full = (fixtures.DOC_FIXTURES_DIR / "valid" / "full_example__c30.json").read_bytes()
    assert not content_equals_seed(parse_doc(full), contexts["c30"].seed)


# --- semantic rules (§3.3, §3.4, CONTRACTS §5.4) -----------------------------------------------------


def test_every_seed_is_valid_on_its_own(contexts):
    for context in contexts.values():
        validation = check(copy.deepcopy(context.seed), context, seed=False)
        assert validation.ok and validation.errors == ()


def test_validate_does_not_mutate_its_inputs(contexts):
    context = contexts["c30"]
    doc = _logo_and_music(context)
    before = canonical_bytes(doc), canonical_bytes(context.words), canonical_bytes(context.seed)
    check(doc, context)
    assert (canonical_bytes(doc), canonical_bytes(context.words),
            canonical_bytes(context.seed)) == before


def _body(doc: dict) -> dict:
    return next(s for s in doc["main"]["segments"] if s["role"] == "body")


def _removal(doc: dict, *, seg: str = "seg_b1", offset: int = 60, length: int = 10,
             **fields) -> dict:
    segment = next(s for s in doc["main"]["segments"] if s["id"] == seg)
    removal = {"id": f"rm_{len(doc['main']['removals']) + 1}", "seg": seg,
               "in_sf": segment["in_sf"] + offset, "out_sf": segment["in_sf"] + offset + length,
               "words": [], "reason": "user", "origin": "user"}
    removal.update(fields)
    doc["main"]["removals"].append(removal)
    return removal


# (context, mutate, code, path): one targeted violation (or a positive boundary with code None).
RULES = [
    # root
    ("c30", lambda d: d.update(clip_id="clip_XYZ"), "range_invalid", "/clip_id"),
    ("c30", lambda d: d.update(revision=-1), "range_invalid", "/revision"),
    ("c30", lambda d: d.update(revision=True), "range_invalid", "/revision"),
    ("c30", lambda d: d.update(parent_sha256="abc"), "range_invalid", "/parent_sha256"),
    ("c30", lambda d: d.update(revision=0), "parent_mismatch", "/parent_sha256"),
    ("c30", lambda d: d.update(schema_minor=-1), "range_invalid", "/schema_minor"),
    ("c30", lambda d: d.pop("layout"), "range_invalid", "/layout"),
    ("c30", lambda d: d.update(main=[]), "range_invalid", "/main"),
    # base (validated with seed=None, i.e. as a seed would be)
    ("c30", lambda d: d["base"].update(job_id=d["base"]["job_id"].upper()), "range_invalid",
     "/base/job_id"),
    ("c30", lambda d: d["base"]["source"].update(w=15), "range_invalid", "/base/source/w"),
    ("c30", lambda d: d["base"]["source"].update(fps_native=[30, 0]), "range_invalid",
     "/base/source/fps_native"),
    ("c30", lambda d: d["base"]["source"].update(vfr=0), "range_invalid", "/base/source/vfr"),
    ("c30", lambda d: d["base"]["origin"].update(kind="v2_candidate"), "range_invalid",
     "/base/origin/kind"),
    ("c30", lambda d: d["base"]["origin"].update(rank_at_seed=0), "range_invalid",
     "/base/origin/rank_at_seed"),
    ("c30", lambda d: d["base"]["origin"].update(hook_unit_id=None), None, None),
    ("c30", lambda d: d["base"]["origin"].update(selection_source="gpt"), "range_invalid",
     "/base/origin/selection_source"),
    ("c30", lambda d: d["base"].update(window_ms=[5, 5]), "range_invalid", "/base/window_ms"),
    ("c30", lambda d: d["base"]["words"].update(count=-1), "range_invalid", "/base/words/count"),
    ("c30", lambda d: d["base"]["camera"].update(sha256="0" * 64), None, None),
    ("c30", lambda d: d["base"]["camera"].update(sha256="x"), "range_invalid",
     "/base/camera/sha256"),
    ("c30", lambda d: d["base"]["engine"].update(compiler="legacy"), None, None),
    ("c30", lambda d: d["base"]["engine"].update(compiler="edit-v2/2"), "range_invalid",
     "/base/engine/compiler"),
    ("c30", lambda d: d["base"]["engine"].update(render_semantics=0), "range_invalid",
     "/base/engine/render_semantics"),
    # output
    ("c30", lambda d: d["output"].update(w=1080, h=1280), "range_invalid", "/output/h"),
    ("c30", lambda d: d["output"].update(w=640), "range_invalid", "/output/w"),
    ("c30", lambda d: d["output"].update(fps=[60, 1]), "range_invalid", "/output/fps"),
    ("c30", lambda d: d["output"].update(sample_rate=44100), "range_invalid",
     "/output/sample_rate"),
    ("c30", lambda d: d["output"].update(channels=1), "range_invalid", "/output/channels"),
    # segments
    ("c30", lambda d: d["main"].update(segments=[]), "range_invalid", "/main/segments"),
    ("c30", lambda d: d["main"]["segments"].append(dict(_body(d), id="seg_b2")),
     "range_invalid", "/main/segments/2"),
    ("c25", lambda d: d["main"]["segments"].append(dict(_body(d), id="seg_b2")),
     "range_invalid", "/main/segments/1"),
    ("c25", lambda d: _body(d).update(role="cold_open"), "range_invalid", "/main/segments"),
    ("c25", lambda d: _body(d).update(role="intro"), "range_invalid", "/main/segments/0/role"),
    ("c25", lambda d: _body(d).update(out_sf=_body(d)["in_sf"]), "range_invalid",
     "/main/segments/0"),
    ("c25", lambda d: _body(d).update(in_sf=-1), "range_invalid", "/main/segments/0/in_sf"),
    ("c30", lambda d: d["main"]["segments"].append(
        {"id": "seg_x", "role": "insert", "in_sf": 1, "out_sf": 2}),
     "op_disabled", "/main/segments/2"),
    # removals
    ("c30", lambda d: _removal(d, words=["w048201"] * 401), "range_invalid",
     "/main/removals/0/words"),
    ("c30", lambda d: _removal(d, reason="ai_condense"), "op_disabled",
     "/main/removals/0/reason"),
    ("c30", lambda d: _removal(d, reason="timeline"), "op_disabled", "/main/removals/0/reason"),
    ("c30", lambda d: _removal(d, origin="suggestion:x"), "range_invalid",
     "/main/removals/0/origin"),
    ("c30", lambda d: _removal(d, origin="suggestion:cl_9"), None, None),
    ("c30", lambda d: _removal(d, in_sf="1"), "range_invalid", "/main/removals/0/in_sf"),
    ("c30", lambda d: _removal(d, seg=7), "range_invalid", "/main/removals/0/seg"),
    ("c30", lambda d: _removal(d, id="RM-1"), "range_invalid", "/main/removals/0/id"),
    ("c30", lambda d: (_removal(d, offset=60), _removal(d, offset=70)), None, None),
    ("c30", lambda d: (_removal(d, offset=60), _removal(d, offset=69)), "removal_overlap",
     "/main/removals/1"),
    # joins
    ("c30", lambda d: d["main"]["joins"].append(dict(d["main"]["joins"][0])),
     "cold_open_invalid", "/main/joins/1"),
    ("c30", lambda d: d["main"]["joins"][0].update(after="seg_b1"), "cold_open_invalid",
     "/main/joins/0/after"),
    ("c30", lambda d: d["main"]["joins"][0].update(style="dip_black"), "op_disabled",
     "/main/joins/0/style"),
    ("c30", lambda d: d["main"]["joins"][0].update(style="xfade"), "op_disabled",
     "/main/joins/0/style"),
    ("c30", lambda d: d["main"]["joins"][0].update(style="wipe"), "range_invalid",
     "/main/joins/0/style"),
    ("c30", lambda d: d["main"].update(cut_fade_ms=-1), "range_invalid", "/main/cut_fade_ms"),
    # captions
    ("c30", lambda d: d["captions"].update(enabled=1), "range_invalid", "/captions/enabled"),
    ("c30", lambda d: d["captions"]["pack"].update(v="1"), "range_invalid", "/captions/pack/v"),
    ("c30", lambda d: d["captions"]["pack"].update(id=3), "range_invalid", "/captions/pack/id"),
    ("c30", lambda d: d["captions"]["overrides"].update(case="sentence"), "op_disabled",
     "/captions/overrides/case"),
    ("c30", lambda d: d["captions"].update(word_edits={f"w{n:06d}": {"hidden": True}
                                                        for n in range(6001)}),
     "range_invalid", "/captions/word_edits"),
    ("c30", lambda d: d["captions"].update(word_edits={"w048200": {"text": "Ijal",
                                                                    "hidden": True,
                                                                    "emphasis": False}}),
     None, None),
    ("c30", lambda d: d["captions"].update(word_edits={"w048200": {"text": "x" * 40}}),
     None, None),
    ("c30", lambda d: d["captions"].update(word_edits={"w048200": {"emphasis": "yes"}}),
     "range_invalid", "/captions/word_edits/w048200/emphasis"),
    # layout
    ("c30", lambda d: d["layout"]["default"].update(mode="smart_speaker"), "op_disabled",
     "/layout/default/mode"),
    ("c30", lambda d: d["layout"]["default"].update(mode="fit_black"), "op_disabled",
     "/layout/default/mode"),
    ("c30", lambda d: d["layout"]["default"].update(no_face="fail"), "op_disabled",
     "/layout/default/no_face"),
    ("c30", lambda d: d["layout"]["default"].update(no_face="fit_blur"), "op_disabled",
     "/layout/default/no_face"),
    # tracks and items
    ("c30", lambda d: d["tracks"][0].update(kind="banner"), "range_invalid", "/tracks/0/kind"),
    ("c30", lambda d: d["tracks"][0].update(id="track"), "range_invalid", "/tracks/0/id"),
    ("c30", lambda d: d["tracks"][0]["items"][0].update(id="seg_b1"), "range_invalid",
     "/tracks/0/items/0/id"),
    ("c30", lambda d: d["tracks"][0]["items"][0].update(type="sticker"), "op_disabled",
     "/tracks/0/items/0/type"),
    ("c30", lambda d: d["tracks"][0]["items"][0].update(start={"at": "clip_start"}),
     "range_invalid", "/tracks/0/items/0/start"),
    ("c30", lambda d: d["tracks"][0]["items"][0].update(origin="ai"), "range_invalid",
     "/tracks/0/items/0/origin"),
    ("c30", lambda d: d["tracks"][0]["items"][0]["payload"].update(text="a" * 90), None, None),
    ("c30", lambda d: d["tracks"][0]["items"][0]["payload"].update(text=""), "range_invalid",
     "/tracks/0/items/0/payload/text"),
    ("c30", lambda d: d["tracks"][0]["items"][0]["payload"]["design"].update(v=2), "op_disabled",
     "/tracks/0/items/0/payload/design"),
    ("c30", lambda d: d["tracks"][0]["items"][0]["payload"]["design"].update(v="1"),
     "range_invalid", "/tracks/0/items/0/payload/design/v"),
    ("c30", lambda d: d["tracks"][0]["items"][0]["transform"].update(y_e5=40001),
     "range_invalid", "/tracks/0/items/0/transform/y_e5"),
    ("c30", lambda d: d["tracks"][0].update(items=[]), None, None),
    ("c30", lambda d: [d["tracks"].append({"id": f"tr_x{n}", "kind": "text", "items": []})
                       for n in range(3)], "op_disabled", "/tracks/3"),
    # audio and audit
    ("c30", lambda d: d["audio"]["source"].update(gain_cdb=-2401), "range_invalid",
     "/audio/source/gain_cdb"),
    ("c30", lambda d: d["audio"]["master"].update(target_clufs=-2401), "range_invalid",
     "/audio/master/target_clufs"),
    ("c30", lambda d: d["audio"]["master"].update(tp_cdb=-301), "range_invalid",
     "/audio/master/tp_cdb"),
    ("c30", lambda d: d["audit"].update(updated_at_ms=d["audit"]["created_at_ms"] - 1),
     "range_invalid", "/audit/updated_at_ms"),
    ("c30", lambda d: d["audit"].update(editor=""), "range_invalid", "/audit/editor"),
    ("c30", lambda d: d["audit"].update(editor="e" * 65), "range_invalid", "/audit/editor"),
    ("c30", lambda d: d["audit"].update(editor="e" * 64), None, None),
    ("c30", lambda d: d["audit"].update(last_command="A" * 41), "range_invalid",
     "/audit/last_command"),
    ("c30", lambda d: d["audit"].update(created_at_ms=2**53), "range_invalid",
     "/audit/created_at_ms"),
]


@pytest.mark.parametrize(("context_id", "mutate", "code", "path"), RULES)
def test_semantic_rules_positive_and_negative(contexts, context_id, mutate, code, path):
    context = contexts[context_id]
    doc = rev1(context)
    mutate(doc)
    validation = check(doc, context, seed=False)
    if code is None:
        assert validation.errors == ()
        return
    assert codes(validation) == {code}, validation.errors
    assert path in {issue.path for issue in validation.errors}


def _logo_rule(context, **fields):
    doc = _logo_and_music(context)
    item = doc["tracks"][1]["items"][0]
    for key, value in fields.items():
        target, name = key.split("__")
        (item if target == "item" else item[target])[name] = value
    return doc


LOGO_RULES = [
    ({"payload__mode": "pip"}, "op_disabled", "/tracks/1/items/0/payload/mode"),
    ({"payload__mode": "split_top"}, "op_disabled", "/tracks/1/items/0/payload/mode"),
    ({"payload__mode": "tile"}, "range_invalid", "/tracks/1/items/0/payload/mode"),
    ({"item__start": {"at": "out", "f": 0}}, "range_invalid", "/tracks/1/items/0/start"),
    ({"item__end": {"at": "clip_start"}}, "range_invalid", "/tracks/1/items/0/end"),
    ({"item__type": "audio"}, "range_invalid", "/tracks/1/items/0/type"),
    ({"item__type": "video"}, "op_disabled", "/tracks/1/items/0/type"),
    ({"payload__asset": fixtures.MUSIC}, "range_invalid", "/tracks/1/items/0/payload/asset"),
    ({"payload__asset": "sha256:abc"}, "range_invalid", "/tracks/1/items/0/payload/asset"),
    ({"transform__x_e5": 100001}, "range_invalid", "/tracks/1/items/0/transform/x_e5"),
    ({"transform__w_e5": 40001}, "range_invalid", "/tracks/1/items/0/transform/w_e5"),
    ({"transform__opacity_pm": 1000, "transform__w_e5": 40000, "transform__x_e5": 80000},
     "item_out_of_frame", "/tracks/1/items/0"),
    ({"transform__y_e5": 100000}, "item_out_of_frame", "/tracks/1/items/0"),
]


@pytest.mark.parametrize(("fields", "code", "path"), LOGO_RULES)
def test_logo_rules(contexts, fields, code, path):
    context = contexts["c30"]
    validation = check(_logo_rule(context, **fields), context)
    assert codes(validation) == {code}, validation.errors
    assert path in {issue.path for issue in validation.errors}


def test_visual_and_audio_track_roles(contexts):
    context = contexts["c30"]
    for track, key, value, code in (
        (1, "band", "under_text", "op_disabled"),
        (1, "band", "middle", "range_invalid"),
        (1, "role", "broll", "op_disabled"),
        (2, "role", "sfx", "op_disabled"),
        (2, "role", "voice", "op_disabled"),
        (2, "role", "podcast", "range_invalid"),
    ):
        doc = _logo_and_music(context)
        doc["tracks"][track][key] = value
        validation = check(doc, context)
        assert codes(validation) == {code}, (key, value)
        assert f"/tracks/{track}/{key}" in {issue.path for issue in validation.errors}


def test_asset_entries_must_match_the_store_and_the_referencing_item(contexts):
    context = contexts["c30"]
    doc = _logo_and_music(context)
    doc["assets"][fixtures.LOGO]["w"] = 513
    validation = check(doc, context)
    assert codes(validation) == {"range_invalid"}
    assert f"/assets/{fixtures.LOGO}/w" in {issue.path for issue in validation.errors}
    doc = _logo_and_music(context)
    doc["assets"]["sha256:XYZ"] = {"kind": "image", "mime": "image/png", "w": 1, "h": 1}
    assert "/assets/sha256:XYZ" in {i.path for i in check(doc, context).errors}
    doc = _logo_and_music(context)
    doc["assets"][fixtures.MUSIC]["kind"] = "image"
    validation = check(doc, context)
    assert codes(validation) == {"range_invalid"}
    # The store lacking the asset is asset_missing on the item, whatever the document claims.
    doc = _logo_and_music(context)
    assets = {k: v for k, v in context.assets.items() if k != fixtures.MUSIC}
    validation = validate_doc(doc, words=context.words, assets=assets, seed=context.seed)
    assert codes(validation) == {"asset_missing"}
    assert {i.path for i in validation.errors} == {"/tracks/2/items/0/payload/asset"}


def test_music_rules(contexts):
    context = contexts["c30"]
    limit = context.assets[fixtures.MUSIC]["duration_ms"] * 48
    for fields, code, path in (
        ({"src_in_smp": limit - 1}, None, None),
        ({"src_in_smp": limit}, "range_invalid", "/tracks/2/items/0/payload/src_in_smp"),
        ({"loop": 1}, "range_invalid", "/tracks/2/items/0/payload/loop"),
        ({"gain_cdb": 601}, "range_invalid", "/tracks/2/items/0/payload/gain_cdb"),
        ({"fade_out_f": tm.sf_floor(10_000, context.fps)}, None, None),
        ({"fade_out_f": tm.sf_floor(10_000, context.fps) + 1}, "range_invalid",
         "/tracks/2/items/0/payload/fade_out_f"),
    ):
        doc = _logo_and_music(context)
        doc["tracks"][2]["items"][0]["payload"].update(fields)
        validation = check(doc, context)
        if code is None:
            assert validation.errors == (), fields
        else:
            assert codes(validation) == {code}, fields
            assert path in {i.path for i in validation.errors}
    for fields, code, path in (
        ({"release_ms": 49}, "range_invalid", "/tracks/2/items/0/payload/duck/release_ms"),
        ({"hold_ms": 1001}, "range_invalid", "/tracks/2/items/0/payload/duck/hold_ms"),
        ({"on": "yes"}, "range_invalid", "/tracks/2/items/0/payload/duck/on"),
        ({"detector": "loud"}, "range_invalid", "/tracks/2/items/0/payload/duck/detector"),
    ):
        doc = _logo_and_music(context)
        doc["tracks"][2]["items"][0]["payload"]["duck"].update(fields)
        validation = check(doc, context)
        assert codes(validation) == {code}, fields
        assert path in {i.path for i in validation.errors}
    doc = _logo_and_music(context)
    del doc["tracks"][2]["items"][0]["payload"]["duck"]["hold_ms"]
    assert "/tracks/2/items/0/payload/duck/hold_ms" in {i.path for i in check(doc, context).errors}


def test_ids_share_one_namespace(contexts):
    context = contexts["c30"]
    doc = _logo_and_music(context)
    doc["tracks"][2]["id"] = "tr_ovr"
    validation = check(doc, context)
    assert codes(validation) == {"range_invalid"}
    assert {i.path for i in validation.errors} == {"/tracks/2/id"}
    doc = rev1(context)
    _removal(doc, id="seg_b1")
    assert {i.path for i in check(doc, context).errors} == {"/main/removals/0/id"}


def test_an_invalid_value_never_cascades_into_other_codes(contexts):
    context = contexts["c30"]
    doc = rev1(context)
    _body(doc)["out_sf"] = "39284"
    assert {(i.code, i.path) for i in check(doc, context).errors} == {
        ("range_invalid", "/main/segments/1/out_sf")}
    doc = rev1(context)
    _removal(doc, in_sf=None)
    assert codes(check(doc, context)) == {"range_invalid"}
    doc = rev1(context)
    doc["output"]["fps"] = [30000, 1000]
    assert codes(check(doc, context, seed=False)) == {"range_invalid"}
    doc = _logo_and_music(context)
    doc["output"]["w"] = "720"
    assert codes(check(doc, context, seed=False)) == {"range_invalid"}
    doc = _logo_and_music(context)
    doc["assets"].pop(fixtures.MUSIC)
    doc["tracks"][2]["items"][0]["payload"]["src_in_smp"] = 10**9
    assert codes(check(doc, context)) == {"asset_missing"}


def test_hostile_values_never_crash_the_validator(contexts):
    context = contexts["c30"]
    hostile = [None, True, 0, -1, 2**64, "x", "", [], {}, [None], {"": None}]
    doc = rev1(context)
    paths = []

    def walk(node, tokens):
        if isinstance(node, dict):
            for key, value in node.items():
                paths.append(tokens + [key])
                walk(value, tokens + [key])
        elif isinstance(node, list):
            for index, value in enumerate(node):
                paths.append(tokens + [index])
                walk(value, tokens + [index])

    walk(doc, [])
    for tokens in paths:
        for value in hostile:
            mutated = copy.deepcopy(doc)
            target = mutated
            for token in tokens[:-1]:
                target = target[token]
            target[tokens[-1]] = value
            validation = check(mutated, context)
            assert all(isinstance(issue, Issue) for issue in validation.errors)


def test_base_changed_compares_base_output_clip_id_and_created_at(contexts):
    context = contexts["c30"]
    for mutate, path in (
        (lambda d: d["base"]["origin"].update(rank_at_seed=4), "/base/origin/rank_at_seed"),
        (lambda d: d["base"]["engine"].update(compiler="legacy"), "/base/engine/compiler"),
        (lambda d: d["base"]["source"].update(fps_native=[25, 1]), "/base/source/fps_native"),
        (lambda d: d["output"].update(w=1080, h=1920), "/output/w"),
        (lambda d: d["base"]["camera"].update(sha256="0" * 64), "/base/camera/sha256"),
    ):
        doc = rev1(context)
        mutate(doc)
        validation = check(doc, context)
        assert codes(validation) == {"base_changed"}
        assert path in {i.path for i in validation.errors}
        # Without a seed the same document is valid (a seed defines its own base).
        assert check(doc, context, seed=False).errors == ()


# --- warnings --------------------------------------------------------------------------------------


def _pieces_after(doc: dict) -> tuple[tm.Piece, ...]:
    return tm.pieces(doc)


def test_tight_cut_warning_names_the_removal_and_its_output_frame(contexts):
    raw = (fixtures.DOC_FIXTURES_DIR / "valid" / "tight_cut__c30.json").read_bytes()
    doc = parse_doc(raw)
    context = contexts["c30"]
    validation = check(doc, context)
    [warning] = [w for w in validation.warnings if w.code == "tight_cut"]
    removal = doc["main"]["removals"][0]
    assert (warning.ref, warning.path) == (removal["id"], "/main/removals/0")
    after = next(p for p in _pieces_after(doc) if p.seg == "seg_b1"
                 and p.in_sf == removal["out_sf"])
    assert warning.f == after.out_f0


def test_laughter_cut_uses_300_ms_around_points_and_the_inside_of_spans(contexts):
    context = contexts["c25"]  # 25 fps: frame k starts at 40·k ms
    doc = rev1(context)
    body = _body(doc)
    edge_sf = body["in_sf"] + 500
    point = edge_sf * 40 - 300
    words = copy.deepcopy(context.words)
    words["events"] = [{"kind": "laughter", "s": point, "e": point, "src": "yt-caption"}]
    removal = _removal(doc, offset=500, length=5)
    assert removal["in_sf"] == edge_sf
    [warning] = check(doc, context, words=words).warnings
    assert (warning.code, warning.ref, warning.path) == ("laughter_cut", removal["id"],
                                                        "/main/removals/0")
    piece = next(p for p in tm.pieces(doc) if p.in_sf == removal["out_sf"])
    assert warning.f == piece.out_f0
    words["events"][0].update(s=point - 1, e=point - 1)  # 301 ms before the edge
    assert check(doc, context, words=words).warnings == ()
    words["events"][0].update(kind="applause", s=point, e=point)
    assert check(doc, context, words=words).warnings == ()
    span_start = (edge_sf + 2) * 40 + 1
    words["events"] = [{"kind": "laughter", "s": span_start - 1000, "e": span_start,
                        "src": "transcript"}]
    # The out edge (edge_sf + 5) lies after the span; the in edge (edge_sf) lies inside it.
    assert [w.code for w in check(doc, context, words=words).warnings] == ["laughter_cut"]
    words["events"][0].update(s=span_start, e=span_start + 1000)  # starts after the in edge
    assert [w.code for w in check(doc, context, words=words).warnings] == ["laughter_cut"]
    words["events"][0].update(s=(edge_sf + 5) * 40 + 1, e=(edge_sf + 5) * 40 + 900)
    assert check(doc, context, words=words).warnings == ()


def test_music_shorter_than_clip_only_without_loop(contexts):
    context = contexts["c30"]
    fps = context.fps
    doc = _logo_and_music(context)
    item = doc["tracks"][2]["items"][0]
    item["payload"].update(asset=fixtures.MUSIC_SHORT, loop=False)
    doc["assets"].pop(fixtures.MUSIC)
    doc["assets"][fixtures.MUSIC_SHORT] = dict(context.assets[fixtures.MUSIC_SHORT])
    [warning] = check(doc, context).warnings
    available = context.assets[fixtures.MUSIC_SHORT]["duration_ms"] * 48
    assert (warning.code, warning.ref, warning.path) == ("music_shorter_than_clip", "it_music",
                                                        "/tracks/2/items/0")
    assert warning.f == -(-available * fps.num // (48_000 * fps.den))
    item["payload"]["loop"] = True
    assert check(doc, context).warnings == ()
    item["payload"].update(loop=False, asset=fixtures.MUSIC)
    doc["assets"].pop(fixtures.MUSIC_SHORT)
    doc["assets"][fixtures.MUSIC] = dict(context.assets[fixtures.MUSIC])
    assert check(doc, context).warnings == ()


def test_warnings_are_not_computed_for_an_invalid_document(contexts):
    raw = (fixtures.DOC_FIXTURES_DIR / "valid" / "tight_cut__c30.json").read_bytes()
    doc = parse_doc(raw)
    doc["main"]["cut_fade_ms"] = 51
    validation = check(doc, contexts["c30"])
    assert not validation.ok and validation.warnings == ()


def test_issue_wire_form():
    assert Issue("tight_cut", "/main/removals/0", "rm_1", 402).to_json() == {
        "code": "tight_cut", "path": "/main/removals/0", "ref": "rm_1", "f": 402}
    assert Issue("range_invalid", "/revision").to_json() == {"code": "range_invalid",
                                                             "path": "/revision"}
    assert docmod.Validation((), ()).ok
