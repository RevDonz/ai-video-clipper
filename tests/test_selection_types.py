import math

import pytest

from ai_clipper.selection_types import (
    SCORE_DIMENSIONS,
    ClipProposal,
    SelectedClip,
    SelectionResult,
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
