import math

import pytest

from ai_clipper.selection_types import (
    FOCUS_MATCHES,
    MAX_CLIP_TRENDS,
    SCORE_DIMENSIONS,
    TREND_KINDS,
    ClipFocus,
    ClipProposal,
    FocusSummary,
    SelectedClip,
    SelectionResult,
    TrendRef,
)

SCORES = {name: 7.0 for name in SCORE_DIMENSIONS}


def proposal(**overrides):
    values = {
        "start_unit": 10,
        "end_unit": 20,
        "hook_unit": 14,
        "payoff_unit": 19,
        "archetype": "insider_secret",
        "title": "Kode rahasia copet di keramaian",
        "hook_text": "Kalau dengar 'mutus-mutus', awas dompetmu",
        "description": "Eks-copet membongkar kode yang dipakai di konser.",
        "hashtags": ("#copet", "#podcast"),
        "reasons": ("Hook berupa rahasia orang dalam.",),
        "scores": SCORES,
        "score": 8.2,
        "source": "llm",
    }
    values.update(overrides)
    return ClipProposal(**values)


def selected(**overrides):
    values = {
        "rank": 1,
        "start": 209.5,
        "end": 245.2,
        "cold_open": (217.4, 221.0),
        "unit_ids": ("S0110", "S0131"),
        "hook_unit_id": "S0114",
        "title": "Kode rahasia copet",
        "hook_text": "Awas kalau dengar kata ini di konser",
        "description": "",
        "hashtags": (),
        "archetype": "insider_secret",
        "score": 8.0,
        "scores": SCORES,
        "reasons": ("Rahasia orang dalam dengan payoff jelas.",),
        "source": "heuristic",
        "text": "Jadi pertama itu, kalau dikramain ada ngomong mutus-mutus...",
    }
    values.update(overrides)
    return SelectedClip(**values)


def test_proposal_accepts_valid_values_and_freezes_scores():
    item = proposal()
    assert item.scores["hook"] == 7.0
    with pytest.raises(TypeError):
        item.scores["hook"] = 1.0  # type: ignore[index]


@pytest.mark.parametrize(
    "overrides",
    [
        {"end_unit": 9},
        {"hook_unit": 21},
        {"payoff_unit": 3},
        {"archetype": "viral"},
        {"score": 11.0},
        {"score": math.nan},
        {"scores": {**SCORES, "trend": 5.0}},
        {"scores": {name: 5.0 for name in SCORE_DIMENSIONS[:-1]}},
        {"title": ""},
        {"hook_text": "x" * 91},
        {"source": "gpt"},
        {"hashtags": ["#list"]},
        {"start_unit": True},
        {"title": "bad\x00title"},
    ],
)
def test_proposal_rejects_invalid_values(overrides):
    with pytest.raises((TypeError, ValueError)):
        proposal(**overrides)


def test_selected_clip_round_trips_to_plain_dict():
    item = selected()
    payload = item.to_dict()
    assert payload["cold_open"] == {"start": 217.4, "end": 221.0}
    assert payload["unit_ids"] == ["S0110", "S0131"]
    assert payload["scores"] == SCORES
    assert item.duration == pytest.approx(35.7)


@pytest.mark.parametrize(
    "overrides",
    [
        {"rank": 0},
        {"start": 10.0, "end": 10.0},
        {"cold_open": (5.0, 4.0)},
        {"cold_open": [1.0, 2.0]},
        {"unit_ids": ("S0001",)},
        {"hook_unit_id": ""},
    ],
)
def test_selected_clip_rejects_invalid_values(overrides):
    with pytest.raises((TypeError, ValueError)):
        selected(**overrides)


def test_selection_result_requires_contiguous_ranks_and_consistent_status():
    first = selected()
    second = selected(rank=2, start=400.0, end=430.0, cold_open=None)
    result = SelectionResult(
        clips=(first, second),
        source="heuristic",
        status="fallback",
        provider=None,
        model=None,
        prompt_version="heuristic-v1",
        warnings=("llm_failed:rate_limited",),
        usage={"input_tokens": 0},
    )
    assert result.to_dict()["clips"][1]["cold_open"] is None
    with pytest.raises(ValueError):
        SelectionResult(
            clips=(second,),
            source="heuristic",
            status="completed",
            provider=None,
            model=None,
            prompt_version="heuristic-v1",
        )
    with pytest.raises(ValueError):
        SelectionResult(
            clips=(first,),
            source="llm",
            status="fallback",
            provider="gemini",
            model="m",
            prompt_version="p",
        )


# --- trends -----------------------------------------------------------------------------------


def trend(index: int = 1, **overrides) -> TrendRef:
    values = {"id": f"0b6f2c1e-{index:04d}", "title": "Kabur Aja Dulu", "kind": "topic"}
    values.update(overrides)
    return TrendRef(**values)


def test_trend_kinds_follow_the_spec():
    assert TREND_KINDS == (
        "topic", "person", "joke", "meme", "sound", "hashtag", "format", "event",
    )


def test_trend_ref_round_trips_to_a_plain_dict():
    assert trend().to_dict() == {
        "id": "0b6f2c1e-0001", "title": "Kabur Aja Dulu", "kind": "topic",
    }


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": ""},
        {"id": "../x"},
        {"id": "a" * 65},
        {"title": ""},
        {"title": "x" * 81},
        {"title": "baris\nbaru"},
        {"kind": "rumor"},
        {"kind": 1},
    ],
)
def test_trend_ref_rejects_invalid_values(overrides):
    with pytest.raises((TypeError, ValueError)):
        trend(**overrides)


def test_clips_without_trends_keep_their_historical_dict_shape():
    payload = selected().to_dict()
    assert "trends" not in payload
    assert list(payload) == [
        "rank", "start", "end", "cold_open", "unit_ids", "hook_unit_id", "title", "hook_text",
        "description", "hashtags", "archetype", "score", "scores", "reasons", "source", "text",
    ]
    assert selected().trends == ()


def test_clips_with_trends_record_them_last():
    item = selected(trends=(trend(1), trend(2, title="Timnas", kind="event")))
    payload = item.to_dict()
    assert list(payload)[-1] == "trends"
    assert payload["trends"] == [
        {"id": "0b6f2c1e-0001", "title": "Kabur Aja Dulu", "kind": "topic"},
        {"id": "0b6f2c1e-0002", "title": "Timnas", "kind": "event"},
    ]


@pytest.mark.parametrize(
    "trends",
    [
        [trend()],
        ({"id": "a", "title": "b", "kind": "topic"},),
        tuple(trend(index) for index in range(MAX_CLIP_TRENDS + 1)),
        (trend(1), trend(1)),
    ],
)
def test_selected_clip_rejects_invalid_trends(trends):
    with pytest.raises((TypeError, ValueError)):
        selected(trends=trends)


def test_proposal_trend_refs_default_to_none_and_are_validated():
    assert proposal().trend_refs == ()
    assert proposal(trend_refs=("T1", "T20")).trend_refs == ("T1", "T20")
    for refs in (["T1"], ("T0",), ("t1",), ("T1", "T1"), ("K1",),
                 tuple(f"T{index}" for index in range(1, 22))):
        with pytest.raises((TypeError, ValueError)):
            proposal(trend_refs=refs)


# --- Fokus klip -------------------------------------------------------------------------------


def test_focus_matches_follow_the_spec():
    assert FOCUS_MATCHES == ("literal", "semantic", "none")


def test_clip_focus_round_trips_to_a_plain_dict():
    assert ClipFocus("literal", ("jomok",), 754.2).to_dict() == {
        "match": "literal", "terms": ["jomok"], "at": 754.2,
    }
    assert ClipFocus("semantic", ("jomok", "jomokers")).to_dict() == {
        "match": "semantic", "terms": ["jomok", "jomokers"], "at": None,
    }
    assert ClipFocus("none").to_dict() == {"match": "none", "terms": [], "at": None}


@pytest.mark.parametrize(
    ("match", "terms", "at"),
    [
        ("maybe", ("jomok",), None),
        ("literal", ("jomok",), None),  # a literal match says where
        ("literal", (), 5.0),
        ("literal", ("jomok",), -1.0),
        ("literal", ("jomok",), math.inf),
        ("literal", ("jomok",), True),
        ("semantic", (), None),
        ("semantic", ("jomok",), 5.0),  # only a literal match has a time
        ("none", ("jomok",), None),
        ("none", (), 5.0),
        ("literal", ["jomok"], 5.0),
        ("literal", ("jomok", "jomok"), 5.0),
        ("literal", ("x" * 41,), 5.0),
        ("literal", ("",), 5.0),
        ("literal", ("baris\nbaru",), 5.0),
        ("semantic", tuple(f"t{index}" for index in range(9)), None),
    ],
)
def test_clip_focus_rejects_invalid_values(match, terms, at):
    with pytest.raises((TypeError, ValueError)):
        ClipFocus(match, terms, at)


def test_clips_with_a_focus_record_it_last_and_others_keep_their_shape():
    assert "focus" not in selected().to_dict()
    assert selected().focus is None
    item = selected(trends=(trend(1),), focus=ClipFocus("literal", ("jomok",), 220.0))
    payload = item.to_dict()
    assert list(payload)[-2:] == ["trends", "focus"]
    assert payload["focus"] == {"match": "literal", "terms": ["jomok"], "at": 220.0}
    with pytest.raises(TypeError):
        selected(focus={"match": "none"})


def test_proposal_focus_claims_are_validated():
    assert proposal().focus is None
    for claim in FOCUS_MATCHES:
        assert proposal(focus=claim).focus == claim
    for claim in ("", "Literal", "ya", 1):
        with pytest.raises((TypeError, ValueError)):
            proposal(focus=claim)


def focus_result(*clips, focus=None) -> SelectionResult:
    return SelectionResult(
        clips=tuple(clips),
        source="heuristic",
        status="completed",
        provider=None,
        model=None,
        prompt_version="heuristic-v3.1",
        focus=focus,
    )


def test_the_selection_summary_counts_matching_clips():
    clips = (
        selected(focus=ClipFocus("literal", ("jomok",), 220.0)),
        selected(rank=2, start=400.0, end=430.0, cold_open=None,
                 focus=ClipFocus("semantic", ("jomok",))),
        selected(rank=3, start=500.0, end=530.0, cold_open=None, focus=ClipFocus("none")),
    )
    result = focus_result(*clips, focus=FocusSummary(terms=("jomok",), requested=5))

    assert result.focus_matched == 2
    payload = result.to_dict()
    assert list(payload)[-1] == "focus"
    assert payload["focus"] == {"terms": ["jomok"], "matched": 2, "requested": 5}
    assert "focus" not in focus_result(selected()).to_dict()


def test_the_selection_focus_and_the_clip_focus_go_together():
    summary = FocusSummary(terms=("jomok",), requested=1)
    with pytest.raises(ValueError):
        focus_result(selected(), focus=summary)  # a clip without its focus label
    with pytest.raises(ValueError):
        focus_result(selected(focus=ClipFocus("none")))  # a label without a job focus
    for bad in (
        {"terms": (), "requested": 1},
        {"terms": ["jomok"], "requested": 1},
        {"terms": ("jomok",), "requested": 0},
        {"terms": ("jomok",), "requested": True},
        {"terms": ("jomok", "Jomok"), "requested": 1},
    ):
        with pytest.raises((TypeError, ValueError)):
            FocusSummary(**bad)
