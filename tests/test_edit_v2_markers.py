"""Timeline markers (plan §11.3 T3.7, §3.6, §6.1 "Waveform and markers"): the vectors.

``tests/fixtures/edit_v2/marker-vectors.json`` (written by ``scripts/editor/gen_t37_fixtures.py``)
holds, for documents of the committed contexts, the output frames of every laughter, silence
(≥ 0.6 s) and camera-cut marker. The browser lane (``timeline/lanes/markers.mjs``) must give
exactly these frames (``web/tests/editor-markers.test.mjs``); here they are checked against an
independent rational reference of the time map's midpoint rule (plan §3.4).
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from fractions import Fraction
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "editor" / "gen_t37_fixtures.py"
VECTORS = ROOT / "tests" / "fixtures" / "edit_v2" / "marker-vectors.json"
KINDS = ("laughter", "silence", "camera_cut")


def _generator():
    name = "editor_gen_t37_fixtures"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, GENERATOR)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def vectors() -> dict:
    return json.loads(VECTORS.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def contexts():
    return {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}


def _round_half_up(value: Fraction) -> int:
    return math.floor(value + Fraction(1, 2))


def reference_frames(s: int, e: int, pieces, fps) -> tuple[int, int] | None:
    """Plan §3.4 by rational arithmetic, piece by piece: visible when the frame holding the
    midpoint lies in a piece; frames rounded half up from the piece's source start."""
    per_ms = Fraction(fps.num, 1000 * fps.den)
    mid_frame = math.floor(Fraction(s + e, 2) * per_ms)
    for piece in pieces:
        if piece.in_sf <= mid_frame < piece.out_sf:
            last = piece.out_f0 + piece.frames
            on = piece.out_f0 + _round_half_up(s * per_ms - piece.in_sf)
            off = piece.out_f0 + _round_half_up(e * per_ms - piece.in_sf)
            on = min(max(on, piece.out_f0), last)
            off = max(min(max(off, piece.out_f0), last), on)
            return on, off
    return None


def reference_markers(words: dict, doc: dict) -> list[dict]:
    fps = tm.Fps.from_json(doc["output"]["fps"])
    pieces = tm.pieces(doc)
    segments = list(dict.fromkeys(piece.seg for piece in pieces))
    sources = [("laughter", ev["src"], ev["s"], ev["e"]) for ev in words["events"]
               if ev["kind"] == "laughter"]
    sources += [("silence", "audio_timeline", s, e) for s, e in words["silences"]
                if e - s >= 600]
    sources += [("camera_cut", "audio_timeline", ms, ms) for ms in words["scene_cuts_ms"]]
    out = []
    for kind, src, s, e in sources:
        for seg in segments:
            frames = reference_frames(s, e, [p for p in pieces if p.seg == seg], fps)
            if frames is not None:
                out.append({"kind": kind, "src": src, "seg": seg, "s": s, "e": e,
                            "f0": frames[0], "f1": frames[1]})
    out.sort(key=lambda m: (m["f0"], m["f1"], KINDS.index(m["kind"]), m["s"], m["e"], m["src"],
                            m["seg"]))
    return out


def test_the_committed_vectors_are_current():
    assert _generator().render_markers() == VECTORS.read_bytes(), \
        "regenerate with: uv run python scripts/editor/gen_t37_fixtures.py --write"


def case_words(case: dict, contexts) -> dict:
    """The case's words artifact: its context's, minus the analysis the case strips."""
    return _generator().case_words(contexts[case["context"]].words, case["strip"], case["extra"])


def test_every_vector_document_is_a_valid_document(vectors, contexts):
    for case in vectors["cases"]:
        context = contexts[case["context"]]
        validation = validate_doc(case["doc"], words=case_words(case, contexts),
                                  assets=context.assets, seed=None)
        assert validation.errors == (), (case["name"], validation.errors)


def test_every_expected_marker_matches_the_rational_reference(vectors, contexts):
    total = 0
    for case in vectors["cases"]:
        words = case_words(case, contexts)
        assert case["markers"] == reference_markers(words, case["doc"]), case["name"]
        total += len(case["markers"])
    assert total >= 200


def test_the_expected_markers_equal_the_time_map(vectors, contexts):
    for case in vectors["cases"]:
        doc = case["doc"]
        fps = tm.Fps.from_json(doc["output"]["fps"])
        pieces = tm.pieces(doc)
        for marker in case["markers"]:
            seg_pieces = [p for p in pieces if p.seg == marker["seg"]]
            assert tm.word_frames(marker["s"], marker["e"], seg_pieces, fps) == \
                (marker["f0"], marker["f1"])


def test_unavailable_follows_the_missing_list(vectors, contexts):
    for case in vectors["cases"]:
        missing = set(case_words(case, contexts)["missing"])
        expected = set()
        if "sound_events" in missing:
            expected.add("laughter_tags")
        if "audio_timeline" in missing:
            expected |= {"silence", "camera_cut"}
        assert set(case["unavailable"]) == expected
        assert case["unavailable"] == sorted(case["unavailable"])


def test_stripping_analysis_empties_what_the_missing_list_names(contexts):
    words = _generator().case_words(contexts["c30"].words, ["audio_timeline", "sound_events"])
    assert words["missing"] == ["audio_timeline", "sound_events"]
    assert words["silences"] == [] and words["scene_cuts_ms"] == [] and words["gaps"] == []
    assert {ev["src"] for ev in words["events"]} == {"transcript"}
    assert _generator().case_words(contexts["c30"].words, []) == contexts["c30"].words


def test_the_vectors_cover_every_rule(vectors, contexts):
    names = {case["name"] for case in vectors["cases"]}
    assert {"c30/seed", "c25/seed", "c24/seed"} <= names
    kinds = {(m["kind"], m["src"]) for case in vectors["cases"] for m in case["markers"]}
    assert kinds == {("laughter", "yt-caption"), ("laughter", "transcript"),
                     ("silence", "audio_timeline"), ("camera_cut", "audio_timeline")}
    # the same source moment shown twice: once in the cold open, once in the body
    assert any(len({m["seg"] for m in case["markers"] if (m["kind"], m["s"]) == (k, s)}) == 2
               for case in vectors["cases"]
               for k, s in {(m["kind"], m["s"]) for m in case["markers"]})
    # short silences are never markers (the dense cases hold some); cuts hide what they cut
    short = 0
    for case in vectors["cases"]:
        assert all(m["e"] - m["s"] >= 600 for m in case["markers"] if m["kind"] == "silence")
        short += sum(e - s < 600 for s, e in case_words(case, contexts)["silences"])
    assert short > 0
    assert sum(len(case["markers"]) for case in vectors["cases"] if case["extra"]) >= 300
    seed_case = next(case for case in vectors["cases"] if case["name"] == "c30/seed")
    cut_case = next(case for case in vectors["cases"] if case["name"] == "c30/cuts")
    assert len(cut_case["markers"]) < len(seed_case["markers"])
    assert any("laughter_tags" in case["unavailable"] for case in vectors["cases"])
    assert any(set(case["unavailable"]) == {"camera_cut", "laughter_tags", "silence"}
               for case in vectors["cases"])
