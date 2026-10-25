"""A clip's reasons read back as codes (rombak 07 §10.4, i18n M5)."""

import inspect
import random

import pytest
from test_hook_heuristics import build, kitchen_moment, neutral, qa_moment

from ai_clipper import hook_heuristics, llm_selection, selection_v3
from ai_clipper.hook_heuristics import _OPENER_REASONS, _TAG_LABELS, propose_heuristic
from ai_clipper.i18n_codes import REASON_CODES, REASON_TAGS, TEXT_REASON
from ai_clipper.reason_codes import _FIXED, _TEMPLATES, reason_code, reason_codes


@pytest.mark.parametrize(
    "reason, expected",
    [
        (_OPENER_REASONS["question"].format(run=12.4), ("open_question", {"run": 12})),
        (_OPENER_REASONS["setup"].format(run=7), ("open_setup", {"run": 7})),
        (_OPENER_REASONS["plain"], ("open_plain", {})),
        (
            "Kalimat hook terkuat di detik ke-4: “Gue keluar dari band”.",
            ("hook_line", {"offset": 4, "text": "Gue keluar dari band"}),
        ),
        (
            "Kalimat hook terkuat di detik ke-0: “Jujur, gue (dulu) nyopet” (pengakuan, angka/uang).",
            (
                "hook_line_tagged",
                {"offset": 0, "text": "Jujur, gue (dulu) nyopet", "tags": ["confession", "number"]},
            ),
        ),
        ("Ditutup di akhir kalimat dengan jeda 1.5 detik.", ("end_pause", {"gap": 1.5})),
        ("Ada 3 tawa di dalam klip.", ("laughs", {"count": 3})),
        (
            "Ritme bicara lega: rasio hening 35% di atas rata-rata episode.",
            ("silence", {"ratio": 0.35}),
        ),
        (
            selection_v3.COLD_OPEN_REASON.format(length="4,5"),
            ("cold_open", {"seconds": 4.5}),
        ),
        (selection_v3.FOCUS_FILL_REASON, ("focus_fill", {})),
        (selection_v3.HEURISTIC_FILL_REASON, ("heuristic_fill", {})),
        ("tren: Piala Dunia", ("trend", {"title": "Piala Dunia"})),
        ("tren: Banjir Jakarta (sensitif)", ("trend_sensitive", {"title": "Banjir Jakarta"})),
        (
            selection_v3.MANUAL_REASON.format(label="10:00–10:30"),
            ("manual_range", {"label": "10:00–10:30"}),
        ),
        ("Peringkat ulang LLM: 7,5/10", ("llm_rerank", {"score": 7.5})),
    ],
)
def test_template_reasons_read_back_as_their_code(reason, expected):
    code, params = expected
    assert reason_code(reason) == {"code": code, "params": params}


@pytest.mark.parametrize(
    "reason",
    [
        "Host bertanya, tamu menjawab dengan cerita lucu.",  # the LLM's own words
        "Kalimat hook terkuat di detik ke-4: “" + "x" * 300,  # cut at 300 characters
        "tren: ",
        "Kalimat hook terkuat di detik ke-3: “Halo” (bukan label).",  # no such tag
        "Ada banyak tawa di dalam klip.",
        "",
    ],
)
def test_anything_else_is_text_shown_as_written(reason):
    assert reason_code(reason) == {"code": TEXT_REASON, "params": {"text": reason}}


def test_every_entry_has_a_listed_code_and_order_is_kept():
    reasons = ["Dimulai di batas kalimat yang bersih.", "Alasan dari AI.", "Ada 2 tawa di dalam klip."]
    assert [item["code"] for item in reason_codes(reasons)] == ["open_plain", "text", "laughs"]
    assert {code for code, _template in _TEMPLATES} == set(REASON_CODES)
    assert set(_TAG_LABELS) == set(REASON_TAGS)


def _source_form(template: str, names: dict[str, str]) -> str:
    for ours, theirs in names.items():
        template = template.replace("{" + ours, "{" + theirs)
    return template


def test_the_templates_are_the_ones_the_selector_writes():
    """The literals of hook_heuristics._reasons and llm_selection._proposal are read back as
    they are written: a changed reason fails here before it shows as untranslated text."""
    heuristics = inspect.getsource(hook_heuristics._reasons)
    for text in _FIXED.values():
        if text not in (selection_v3.FOCUS_FILL_REASON, selection_v3.HEURISTIC_FILL_REASON):
            assert f'"{text}"' in heuristics, text
    templates = dict(_TEMPLATES)
    assert 'f"Kalimat hook terkuat di detik ke-{offset:.0f}: “{hook_text}”{detail}."' in heuristics
    assert 'f" ({\', \'.join(labels)})"' in heuristics
    assert templates["hook_line"].startswith("Kalimat hook terkuat di detik ke-{offset:.0f}: ")
    for code, names in (
        ("end_pause", {"gap": "gap_after"}),
        ("laughs", {"count": "laughs"}),
        ("silence", {"ratio": "window.silence"}),
    ):
        written = _source_form(templates[code], names).replace("{laughs:.0f}", "{laughs}")
        assert f'f"{written}"' in heuristics.replace('"\n            f"', ""), code
    assert 'f"Peringkat ulang LLM: {item.rerank:.1f}/10".replace(".", ",")' in inspect.getsource(
        llm_selection._proposal
    )
    cold_open = inspect.getsource(selection_v3._selected)
    assert '.replace(".", ",")' in cold_open and "COLD_OPEN_REASON.format(length=length)" in cold_open


def test_every_reason_of_heuristic_runs_reads_back_as_a_code():
    rng = random.Random(7)
    seen: set[str] = set()
    for _trial in range(12):
        parts = [neutral(rng.randint(4, 14))]
        for offset in (40, 80, 120):
            moment = rng.choice([qa_moment(), kitchen_moment(), qa_moment(topic="film")])
            parts.append(moment)
            parts.append(neutral(rng.randint(4, 14), offset=offset))
        units, events = build([line for part in parts for line in part])
        for proposal in propose_heuristic(units, min_duration=20, max_duration=60, k=3, events=events):
            for entry in reason_codes(proposal.reasons):
                assert entry["code"] != TEXT_REASON, entry["params"]
                seen.add(entry["code"])
    assert {"hook_line", "hook_line_tagged"} & seen
    assert len(seen) >= 4, seen
