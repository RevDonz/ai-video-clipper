"""Frozen Editor V3 contracts (plan Appendix A, §3, §4.2, §4.3; docs/editor/CONTRACTS.md).

These tests pin names and shapes that the phase-B tasks build on. They stay valid after the
stubs are implemented: they check signatures, not behaviour.
"""

from __future__ import annotations

import ast
import dataclasses
import importlib
import inspect
import json
import sys
import unicodedata
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper import edit_v2
from ai_clipper.edit_v2 import errors

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "src" / "ai_clipper" / "edit_v2"
CONTRACTS = ROOT / "docs" / "editor" / "CONTRACTS.md"

STUB_MODULES = (
    "doc",
    "store",
    "api",
    "captions",
    "glyphs",
    "plan",
    "compile_ffmpeg",
    "layouts",
    "execute",
    "verify",
    "derive",
    "audio_graph",
    "envelope",
    "loudness",
    "source_info",
    "words",
    "peaks",
    "camera",
    "seed",
)

P = inspect.Parameter
POS = P.POSITIONAL_OR_KEYWORD
KW = P.KEYWORD_ONLY
NO_DEFAULT = P.empty

# (module, function): [(name, kind, default)]
SIGNATURES = {
    ("timemap", "pieces"): [("doc", POS, NO_DEFAULT)],
    ("timemap", "total_frames"): [("pieces", POS, NO_DEFAULT)],
    ("timemap", "smp"): [("n", POS, NO_DEFAULT), ("fps", POS, NO_DEFAULT), ("rate", POS, 48_000)],
    ("timemap", "sf_floor"): [("ms", POS, NO_DEFAULT), ("fps", POS, NO_DEFAULT)],
    ("timemap", "sf_ceil"): [("ms", POS, NO_DEFAULT), ("fps", POS, NO_DEFAULT)],
    ("timemap", "word_frames"): [
        ("s_ms", POS, NO_DEFAULT),
        ("e_ms", POS, NO_DEFAULT),
        ("pieces", POS, NO_DEFAULT),
        ("fps", POS, NO_DEFAULT),
    ],
    ("timemap", "out_to_src"): [("n", POS, NO_DEFAULT), ("pieces", POS, NO_DEFAULT)],
    ("timemap", "now_ms"): [("n", POS, NO_DEFAULT), ("fps", POS, NO_DEFAULT)],
    ("timemap", "safe_cs"): [("n", POS, NO_DEFAULT), ("fps", POS, NO_DEFAULT)],
    ("timemap", "cell_frames"): [("fps", POS, NO_DEFAULT)],
    ("timemap", "div_round_half_up"): [
        ("numerator", POS, NO_DEFAULT),
        ("denominator", POS, NO_DEFAULT),
    ],
    ("timemap", "speech_spans"): [
        ("words", POS, NO_DEFAULT),
        ("pieces", POS, NO_DEFAULT),
        ("fps", POS, NO_DEFAULT),
        ("rate", POS, 48_000),
    ],
    ("timemap", "logo_box"): [
        ("x_e5", KW, NO_DEFAULT),
        ("y_e5", KW, NO_DEFAULT),
        ("w_e5", KW, NO_DEFAULT),
        ("asset_w", KW, NO_DEFAULT),
        ("asset_h", KW, NO_DEFAULT),
        ("out_w", KW, NO_DEFAULT),
        ("out_h", KW, NO_DEFAULT),
    ],
    ("clip_id", "clip_id"): [
        ("source_content_sha256", POS, NO_DEFAULT),
        ("start_ms", POS, NO_DEFAULT),
        ("end_ms", POS, NO_DEFAULT),
        ("cold_open_ms", POS, NO_DEFAULT),
    ],
    ("clip_id", "ms_from_seconds"): [("seconds", POS, NO_DEFAULT)],
    ("doc", "parse_doc"): [("raw", POS, NO_DEFAULT)],
    ("doc", "canonical_bytes"): [("doc", POS, NO_DEFAULT)],
    ("doc", "doc_sha256"): [("doc", POS, NO_DEFAULT)],
    ("doc", "content_sha256"): [("doc", POS, NO_DEFAULT)],
    ("doc", "content_equals_seed"): [("doc", POS, NO_DEFAULT), ("seed", POS, NO_DEFAULT)],
    ("doc", "validate_doc"): [
        ("doc", POS, NO_DEFAULT),
        ("words", KW, NO_DEFAULT),
        ("assets", KW, NO_DEFAULT),
        ("seed", KW, NO_DEFAULT),
    ],
    ("store", "get"): [("clip_dir", POS, NO_DEFAULT)],
    ("store", "seed"): [("clip_dir", POS, NO_DEFAULT)],
    ("store", "put"): [
        ("clip_dir", POS, NO_DEFAULT),
        ("expected_etag", KW, NO_DEFAULT),
        ("idempotency_key", KW, NO_DEFAULT),
        ("raw", KW, NO_DEFAULT),
        ("now_ms", KW, NO_DEFAULT),
    ],
    ("store", "archive_for_render"): [("clip_dir", POS, NO_DEFAULT), ("etag", POS, NO_DEFAULT)],
    ("store", "prune_receipts"): [("clip_dir", POS, NO_DEFAULT), ("keep", KW, 200)],
    ("api", "main"): [("argv", POS, None)],
    ("captions", "caption_track"): [
        ("doc", POS, NO_DEFAULT),
        ("words", POS, NO_DEFAULT),
        ("pieces", POS, NO_DEFAULT),
    ],
    ("glyphs", "missing_glyphs"): [("text", POS, NO_DEFAULT), ("font_file", POS, NO_DEFAULT)],
    ("glyphs", "advance_px"): [
        ("text", POS, NO_DEFAULT),
        ("font_file", POS, NO_DEFAULT),
        ("font_size", POS, NO_DEFAULT),
    ],
    ("envelope", "speech_envelope"): [
        ("pieces", POS, NO_DEFAULT),
        ("joins", POS, NO_DEFAULT),
        ("cut_fade_ms", POS, NO_DEFAULT),
        ("fps", POS, NO_DEFAULT),
        ("gain_cdb", POS, NO_DEFAULT),
    ],
    ("envelope", "music_envelope"): [
        ("speech_spans", POS, NO_DEFAULT),
        ("item", POS, NO_DEFAULT),
        ("total_samples", POS, NO_DEFAULT),
        ("fps", POS, NO_DEFAULT),
    ],
    ("envelope", "expand_f32"): [("env", POS, NO_DEFAULT), ("total_samples", POS, NO_DEFAULT)],
    ("audio_graph", "audio_fragment"): [
        ("plan", POS, NO_DEFAULT),
        ("mode", KW, NO_DEFAULT),
        ("first_input_index", KW, NO_DEFAULT),
    ],
    ("loudness", "parse_ebur128"): [("stderr", POS, NO_DEFAULT)],
    ("loudness", "master_gain"): [
        ("measured", POS, NO_DEFAULT),
        ("target_clufs", POS, NO_DEFAULT),
        ("tp_cdb", POS, NO_DEFAULT),
    ],
    ("loudness", "needs_measurement"): [("doc", POS, NO_DEFAULT)],
    ("loudness", "output_gain"): [("doc", POS, NO_DEFAULT), ("measured", POS, NO_DEFAULT)],
    ("plan", "build_plan"): [
        ("doc", POS, NO_DEFAULT),
        ("words", KW, NO_DEFAULT),
        ("camera", KW, NO_DEFAULT),
        ("assets", KW, NO_DEFAULT),
        ("resources", KW, NO_DEFAULT),
    ],
    ("plan", "render_key"): [
        ("plan", POS, NO_DEFAULT),
        ("size", KW, NO_DEFAULT),
        ("quality", KW, NO_DEFAULT),
        ("measure_sha", KW, NO_DEFAULT),
        ("toolchain_sha", KW, NO_DEFAULT),
    ],
    ("compile_ffmpeg", "compile_job"): [
        ("plan", POS, NO_DEFAULT),
        ("mode", KW, NO_DEFAULT),
        ("source", KW, NO_DEFAULT),
        ("assets_root", KW, NO_DEFAULT),
        ("size", KW, None),
        ("quality", KW, "standar"),
        ("cells", KW, ()),
        ("frame", KW, None),
        ("loudness", KW, None),
    ],
    ("execute", "run"): [
        ("job", POS, NO_DEFAULT),
        ("output_fd", KW, NO_DEFAULT),
        ("timeout_s", KW, NO_DEFAULT),
        ("on_progress", KW, None),
        ("cancel", KW, None),
    ],
    ("verify", "verify_output"): [
        ("fd", POS, NO_DEFAULT),
        ("plan", POS, NO_DEFAULT),
        ("size", KW, NO_DEFAULT),
        ("normalize", KW, NO_DEFAULT),
    ],
    ("derive", "derive_image"): [
        ("asset", POS, NO_DEFAULT),
        ("w", KW, NO_DEFAULT),
        ("h", KW, NO_DEFAULT),
        ("opacity_pm", KW, NO_DEFAULT),
        ("timeout_s", KW, 20.0),
    ],
    ("source_info", "ensure_source_info"): [
        ("job_dir", POS, NO_DEFAULT),
        ("source", POS, NO_DEFAULT),
    ],
    ("peaks", "build_peaks"): [
        ("source", POS, NO_DEFAULT),
        ("window_ms", POS, NO_DEFAULT),
        ("per_sec", KW, 100),
    ],
    ("words", "build_words_artifact"): [
        ("transcription", POS, NO_DEFAULT),
        ("clip_id", KW, NO_DEFAULT),
        ("window_ms", KW, NO_DEFAULT),
        ("fps", KW, NO_DEFAULT),
        ("audio", KW, NO_DEFAULT),
        ("events", KW, NO_DEFAULT),
        ("peaks", KW, NO_DEFAULT),
    ],
    ("camera", "build_camera_plan"): [
        ("source", POS, NO_DEFAULT),
        ("window_ms", POS, NO_DEFAULT),
        ("fps", POS, NO_DEFAULT),
        ("out_w", KW, NO_DEFAULT),
        ("out_h", KW, NO_DEFAULT),
        ("detector", KW, "<detect_face_track>"),
    ],
    ("seed", "build_seed"): [
        ("clip", KW, NO_DEFAULT),
        ("job", KW, NO_DEFAULT),
        ("source_info", KW, NO_DEFAULT),
        ("words_sha", KW, NO_DEFAULT),
        ("words_count", KW, NO_DEFAULT),
        ("camera_sha", KW, NO_DEFAULT),
        ("selection_sha", KW, NO_DEFAULT),
    ],
    ("seed", "prepare_legacy_job"): [("job_dir", POS, NO_DEFAULT)],
}

DATACLASS_FIELDS = {
    ("timemap", "Fps"): ("num", "den"),
    ("timemap", "Piece"): ("i", "seg", "role", "in_sf", "out_sf", "out_f0", "frames"),
    ("doc", "Issue"): ("code", "path", "ref", "f"),
    ("doc", "Validation"): ("errors", "warnings"),
    ("captions", "CaptionResult"): ("cues", "ass", "ass_sha256", "hook_lines", "warnings"),
    ("audio_graph", "AudioFragment"): ("graph", "inputs", "sidecars", "mix_sha256"),
    ("loudness", "Loudness"): ("i_clufs", "tp_cdb"),
    ("compile_ffmpeg", "InputSpec"): ("kind", "name", "options"),
    ("compile_ffmpeg", "FfmpegJob"): ("argv", "filter_script", "inputs", "sidecars", "expected"),
}

RENDER_PLAN_REQUIRED = (
    "doc",
    "fps",
    "output",
    "pieces",
    "total_frames",
    "total_samples",
    "speech_spans",
    "assets",
    "plan_sha256",
)


def _module(name: str):
    return importlib.import_module(f"ai_clipper.edit_v2.{name}")


def test_package_constants():
    assert edit_v2.COMPILER_VERSION == "edit-v2/1.0.0"
    assert edit_v2.COMPILER_ID == "edit-v2/1"
    assert edit_v2.RENDER_SEMANTICS == 1


@pytest.mark.parametrize("name", STUB_MODULES + ("timemap", "clip_id", "errors"))
def test_every_module_imports(name):
    assert _module(name).__doc__


@pytest.mark.parametrize(("module", "function"), sorted(SIGNATURES))
def test_signatures_match_the_frozen_contract(module, function):
    target = getattr(_module(module), function)
    parameters = list(inspect.signature(target).parameters.values())
    actual = []
    for parameter in parameters:
        default = parameter.default
        if callable(default) and getattr(default, "__name__", "") == "detect_face_track":
            default = "<detect_face_track>"
        actual.append((parameter.name, parameter.kind, default))
    assert actual == SIGNATURES[(module, function)]


@pytest.mark.parametrize(("module", "name"), sorted(DATACLASS_FIELDS))
def test_contract_dataclasses_have_the_frozen_fields(module, name):
    cls = getattr(_module(module), name)
    assert dataclasses.is_dataclass(cls)
    assert cls.__dataclass_params__.frozen
    assert tuple(field.name for field in dataclasses.fields(cls)) == DATACLASS_FIELDS[(module, name)]


def test_render_plan_carries_the_fields_other_tasks_read():
    from ai_clipper.edit_v2.plan import RenderPlan

    assert dataclasses.is_dataclass(RenderPlan)
    names = [field.name for field in dataclasses.fields(RenderPlan)]
    assert names[: len(RENDER_PLAN_REQUIRED)] == list(RENDER_PLAN_REQUIRED)
    # Later fields (added by T1.3) must have defaults so the fixture builder keeps working.
    for field in dataclasses.fields(RenderPlan)[len(RENDER_PLAN_REQUIRED) :]:
        assert field.default is not dataclasses.MISSING or field.default_factory is not dataclasses.MISSING
    assert callable(RenderPlan.to_json)


def test_compile_modes_and_api_ops_are_frozen():
    from ai_clipper.edit_v2 import api, compile_ffmpeg, layouts

    assert compile_ffmpeg.MODES == (
        "final",
        "reference",
        "plate_cells",
        "frame",
        "audio_preview",
        "audio_measure",
        "derive_image",
    )
    assert api.OPS == ("clips", "prepare_job", "get", "put", "seed", "archive")
    assert layouts.LAYOUT_MODES == ("fit_blur", "camera", "fill_center")


def test_edit_v2_package_is_stdlib_only():
    allowed = set(sys.stdlib_module_names) | {"ai_clipper"}
    for path in sorted(PACKAGE.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:
                    continue
                roots = [(node.module or "").split(".")[0]]
            else:
                continue
            for root in roots:
                assert root in allowed, f"{path.name} imports {root}"


# --- errors ----------------------------------------------------------------------------------


def test_error_classes_carry_code_path_ref_and_protocol_numbers():
    expected = {
        errors.EditV2Error: ("internal_error", 500, 1),
        errors.DocInvalid: ("invalid_json", 422, 3),
        errors.NotFound: ("not_found", 404, 4),
        errors.RevisionConflict: ("revision_conflict", 409, 5),
        errors.DocSemanticInvalid: ("range_invalid", 422, 6),
        errors.SchemaTooNew: ("schema_too_new", 426, 7),
        errors.AnalysisMissing: ("analysis_missing", 409, 8),
        errors.IdempotencyConflict: ("idempotency_conflict", 409, 9),
        errors.RenderFailed: ("render_failed", 500, 10),
        errors.VerificationFailed: ("verification_failed", 500, 11),
        errors.Cancelled: ("cancelled", 409, 12),
    }
    for cls, (code, status, exit_code) in expected.items():
        assert issubclass(cls, errors.EditV2Error)
        error = cls()
        assert (error.code, error.http_status, error.exit_code) == (code, status, exit_code)
        assert error.path is None and error.ref is None
        assert errors.exit_code_for(error) == exit_code
    error = errors.DocInvalid("float_not_allowed", path="/main/cut_fade_ms", ref="rm_01")
    assert (error.code, error.path, error.ref) == ("float_not_allowed", "/main/cut_fade_ms", "rm_01")
    assert error.message_id == "edit.float_not_allowed"
    assert errors.exit_code_for(ValueError("boom")) == 1


def test_revision_conflict_carries_the_current_document_and_etag():
    current = {"revision": 3}
    error = errors.RevisionConflict(current=current, etag="a" * 64)
    assert error.current == current and error.etag == "a" * 64
    assert error.code == "revision_conflict"


def test_every_documented_code_has_an_indonesian_message():
    for code in (
        errors.PARSE_CODES
        | errors.SEMANTIC_CODES
        | errors.WARNING_CODES
        | errors.PROTOCOL_CODES
        | errors.RENDER_CODES
        | errors.CLIP_REASONS
        | errors.READ_ONLY_REASONS
    ):
        message = errors.MESSAGES[code]
        assert message and message == message.strip()
        assert errors.message(code) == message
    assert errors.PARSE_CODES == {
        "invalid_json",
        "float_not_allowed",
        "duplicate_key",
        "unknown_key",
        "too_large",
        "not_nfc",
        "control_char",
    }
    assert errors.SEMANTIC_CODES == {
        "base_changed",
        "outside_window",
        "range_invalid",
        "cold_open_invalid",
        "duration_out_of_bounds",
        "removal_outside_segment",
        "removal_overlap",
        "unknown_word",
        "asset_missing",
        "pack_unknown",
        "op_disabled",
        "item_out_of_frame",
        "revision_mismatch",
        "parent_mismatch",
    }
    assert errors.WARNING_CODES == {
        "tight_cut",
        "laughter_cut",
        "hook_overflow",
        "glyph_unsupported",
        "no_face",
        "unsafe_zone",
        "loudness_clamped",
        "peak_reduced",
        "music_shorter_than_clip",
    }
    assert errors.CLIP_REASONS == {
        "needs_prepare",
        "source_missing",
        "selection_unreadable",
        "transcript_missing",
        "analysis_incomplete",
        "not_v3",
    }


def test_parameterised_codes_share_the_base_message():
    assert errors.base_code("glyph_unsupported:U+1F602") == "glyph_unsupported"
    assert "U+1F602" in errors.message("glyph_unsupported:U+1F602")
    assert errors.message_id("engine_fallback:3") == "edit.engine_fallback"
    with pytest.raises(KeyError):
        errors.message("no_such_code")


def test_messages_mapping_is_read_only():
    with pytest.raises(TypeError):
        errors.MESSAGES["tight_cut"] = "x"  # type: ignore[index]


# --- contracts document ----------------------------------------------------------------------


def test_contracts_document_lists_every_frozen_name():
    text = CONTRACTS.read_text(encoding="utf-8")
    for module, function in SIGNATURES:
        assert f"def {function}(" in text, function
    for _module_name, name in DATACLASS_FIELDS:
        assert f"class {name}" in text, name
    for heading in ("Appendix A", "§3", "§4.2", "§4.3", "T1.0 resolutions"):
        assert heading in text


# --- document fixtures -----------------------------------------------------------------------


def test_doc_fixtures_on_disk_are_current():
    rendered = fixtures.render_doc_fixtures()
    on_disk = {
        path.relative_to(fixtures.DOC_FIXTURES_DIR).as_posix(): path.read_bytes()
        for path in sorted(fixtures.DOC_FIXTURES_DIR.rglob("*.json"))
    }
    assert sorted(on_disk) == sorted(rendered)
    for name, data in rendered.items():
        assert on_disk[name] == data, name


def test_doc_fixture_counts_and_names():
    index = fixtures.load_index()
    valid = [case for case in index["fixtures"] if case["file"].startswith("valid/")]
    invalid = [case for case in index["fixtures"] if case["file"].startswith("invalid/")]
    assert len(valid) >= 40
    assert len(invalid) >= 60
    known = errors.PARSE_CODES | errors.SEMANTIC_CODES | {"schema_too_new"}
    covered = set()
    for case in invalid:
        stem = Path(case["file"]).stem
        code = stem.split("__")[0]
        assert case["code"] == code
        assert code in known
        assert case["check"] in {"put", "validate"}
        assert isinstance(case["path"], str)
        covered.add(code)
    assert covered == known
    for case in valid:
        assert case["check"] in {"put", "validate"}
        assert set(case.get("warnings", [])) <= errors.WARNING_CODES
    files = {case["file"] for case in index["fixtures"]}
    assert len(files) == len(index["fixtures"])
    for case in index["fixtures"]:
        assert (fixtures.DOC_FIXTURES_DIR / case["file"]).is_file()
        assert case["context"] in index["contexts"]


def test_valid_fixtures_are_integer_json_that_the_time_map_accepts():
    index = fixtures.load_index()
    for case in index["fixtures"]:
        if not case["file"].startswith("valid/"):
            continue
        raw = (fixtures.DOC_FIXTURES_DIR / case["file"]).read_bytes()
        doc = json.loads(raw.decode("utf-8"), parse_float=_no_float)
        context = fixtures.load_context(case["context"])
        plan = fixtures.make_render_plan(doc, context.words)
        assert plan.total_frames > 0
        if case["check"] == "put":
            assert doc["revision"] == 1
            assert doc["parent_sha256"] == fixtures.etag(context.seed)


def _no_float(value: str):
    raise AssertionError(f"float in a valid fixture: {value}")


class _JsonProblem(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _json_level_code(raw: bytes) -> str | None:
    """The JSON-level parse code of raw bytes (the part of parse_doc that needs no schema)."""
    if len(raw) > fixtures.MAX_DOC_BYTES:
        return "too_large"
    try:
        text = raw.decode("utf-8")  # strict: a BOM is not stripped, invalid UTF-8 fails
    except UnicodeDecodeError:
        return "invalid_json"

    def pairs(items):
        keys = [key for key, _value in items]
        if len(keys) != len(set(keys)):
            raise _JsonProblem("duplicate_key")
        return dict(items)

    def reject(_value):
        raise _JsonProblem("float_not_allowed")

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_float=reject,
                           parse_constant=reject)
    except _JsonProblem as problem:
        return problem.code
    except ValueError:
        return "invalid_json"
    if not isinstance(value, dict):
        return "invalid_json"

    def strings(node):
        if isinstance(node, str):
            yield node
        elif isinstance(node, dict):
            for key, item in node.items():
                yield key
                yield from strings(item)
        elif isinstance(node, list):
            for item in node:
                yield from strings(item)

    for string in strings(value):
        if any(unicodedata.category(char) in ("Cc", "Cs") for char in string):
            return "control_char"
        if unicodedata.normalize("NFC", string) != string:
            return "not_nfc"
    return None


def test_json_level_fixtures_fail_exactly_as_named_and_all_others_parse():
    json_codes = {"invalid_json", "float_not_allowed", "duplicate_key", "too_large", "not_nfc",
                  "control_char"}
    for case in fixtures.load_cases():
        found = _json_level_code(case.raw())
        if case.code in json_codes:
            assert found == case.code, case.file
        else:
            assert found is None, case.file


def test_contexts_are_self_consistent():
    for context_id in fixtures.CONTEXT_IDS:
        context = fixtures.load_context(context_id)
        seed = context.seed
        words_bytes = fixtures.canonical_bytes(context.words)
        assert seed["base"]["words"] == {
            "sha256": fixtures.sha256_hex(words_bytes),
            "count": len(context.words["words"]),
        }
        blank = json.loads(json.dumps(seed))
        blank["base"]["seed_sha256"] = None
        assert seed["base"]["seed_sha256"] == fixtures.sha256_hex(fixtures.canonical_bytes(blank))
        assert seed["revision"] == 0 and seed["parent_sha256"] is None
        assert context.words["clip_id"] == seed["clip_id"]
        ids = [word["id"] for word in context.words["words"]]
        assert ids == sorted(ids) and len(set(ids)) == len(ids)
