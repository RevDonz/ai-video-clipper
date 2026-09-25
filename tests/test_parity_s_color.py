"""Tests for the S-COLOR decision (plan §5.2 R5, ``scripts/parity/s_color.py``).

S-COLOR picks the cheapest compositing format that passes P-COLOR and P-ENC on the delivered
MP4 (and P-TXT before the 4:2:0 step); yuv420p wins whenever its delivered text-region SSIM is
within 0.002 of the best candidate.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import s_color


def _candidate(*, cost: float, ptxt: bool = True, pcolor: bool = True, penc: bool = True,
               delivered: float = 0.99) -> dict:
    return {"cost_s": cost, "p_txt_pass": ptxt, "p_color_pass": pcolor, "p_enc_pass": penc,
            "delivered_ssim_text": delivered}


def test_the_cheapest_passing_candidate_wins() -> None:
    candidates = {
        "yuv420p": _candidate(cost=10.0, ptxt=False, delivered=0.970),
        "yuv444p": _candidate(cost=11.0, pcolor=False, delivered=0.985),
        "gbrp": _candidate(cost=13.0, delivered=0.986),
    }
    decision = s_color.decide(candidates)
    assert decision["format"] == "gbrp"
    assert decision["rule"] == "cheapest_passing"
    assert decision["rejected"] == {"yuv420p": ["p_txt"], "yuv444p": ["p_color"]}
    # Only yuv420p carries the delivered-quality condition; other passing candidates are ranked
    # by cost alone.
    candidates["yuv444p"]["p_color_pass"] = True
    candidates["yuv444p"]["delivered_ssim_text"] = 0.95
    assert s_color.decide(candidates)["format"] == "yuv444p"


def test_yuv420p_wins_within_0_002_of_the_best_delivered_text_ssim() -> None:
    candidates = {
        "yuv420p": _candidate(cost=10.0, delivered=0.9845),
        "yuv444p": _candidate(cost=11.0, delivered=0.9860),
        "gbrp": _candidate(cost=13.0, delivered=0.9864),
    }
    decision = s_color.decide(candidates)
    assert decision["format"] == "yuv420p"
    assert decision["rule"] == "yuv420p_within_0.002"
    # 0.0021 behind the best: yuv420p is not eligible, the next cheapest passing one wins.
    candidates["yuv420p"]["delivered_ssim_text"] = 0.9843
    decision = s_color.decide(candidates)
    assert decision["format"] == "yuv444p"
    assert decision["rule"] == "cheapest_passing"
    assert decision["rejected"] == {"yuv420p": ["delivered_ssim_text"]}


def test_yuv420p_still_needs_every_gate() -> None:
    for failing in ("ptxt", "pcolor", "penc"):
        candidates = {
            "yuv420p": _candidate(cost=10.0, delivered=0.9864, **{failing: False}),
            "gbrp": _candidate(cost=13.0, delivered=0.9864),
        }
        assert s_color.decide(candidates)["format"] == "gbrp", failing


def test_no_passing_candidate_is_reported_not_guessed() -> None:
    candidates = {"yuv420p": _candidate(cost=10.0, penc=False),
                  "gbrp": _candidate(cost=13.0, pcolor=False)}
    decision = s_color.decide(candidates)
    assert decision["format"] is None
    assert decision["rule"] == "none_passed"
    assert decision["rejected"] == {"yuv420p": ["p_enc"], "gbrp": ["p_color"]}


def test_pack_variant_choice_prefers_the_planned_variant_when_it_passes() -> None:
    assert s_color.choose_variant({"montserrat": True, "dejavu": True}, preferred="montserrat",
                                  fallback="dejavu") == ("montserrat", "passes P-TXT")
    assert s_color.choose_variant({"montserrat": False, "dejavu": True}, preferred="montserrat",
                                  fallback="dejavu") == ("dejavu", "montserrat fails P-TXT")
    with pytest.raises(ValueError):
        s_color.choose_variant({"montserrat": False, "dejavu": False}, preferred="montserrat",
                               fallback="dejavu")


def test_cost_graphs_use_the_candidate_and_r7_encode() -> None:
    graph = s_color.cost_graph("gbrp", layout="fit_blur", ass="ass=filename=c.ass")
    assert "gblur=sigma=35" in graph
    assert "format=gbrp,ass=filename=c.ass" in graph
    assert graph.endswith("format=yuv420p[v]")
    assert "gblur" not in s_color.cost_graph("yuv420p", layout="fill_center", ass="ass=x")
    with pytest.raises(ValueError):
        s_color.cost_graph("gbrp", layout="camera", ass="ass=x")


def test_recommendation_when_p_enc_fails_for_every_candidate() -> None:
    # The final 4:2:0 + H.264 step is common to every candidate, so a P-ENC failure shared by
    # all of them cannot rank them: the recommendation falls back to P-TXT and P-COLOR and
    # names P-ENC as open. It never overrides the rule when a candidate passes everything.
    candidates = {
        "yuv420p": _candidate(cost=10.0, ptxt=False, pcolor=False, penc=False),
        "yuv444p": _candidate(cost=10.1, ptxt=False, pcolor=False, penc=False),
        "gbrp": _candidate(cost=11.2, penc=False),
    }
    decision = s_color.decide(candidates)
    assert decision["format"] is None
    assert s_color.recommend(candidates, decision) == {
        "format": "gbrp", "basis": "p_enc_fails_for_every_candidate", "open_gates": ["p_enc"]}
    candidates["gbrp"]["p_color_pass"] = False
    decision = s_color.decide(candidates)
    assert s_color.recommend(candidates, decision) == {
        "format": None, "basis": "none_passed", "open_gates": ["p_txt", "p_color", "p_enc"]}
    candidates["yuv444p"] = _candidate(cost=10.1)
    decision = s_color.decide(candidates)
    assert s_color.recommend(candidates, decision) == {
        "format": "yuv444p", "basis": "cheapest_passing", "open_gates": []}
    # One candidate passes P-ENC but fails another gate: P-ENC can rank, so nothing is chosen.
    candidates = {"yuv420p": _candidate(cost=10.0, ptxt=False),
                  "gbrp": _candidate(cost=11.0, penc=False)}
    decision = s_color.decide(candidates)
    assert s_color.recommend(candidates, decision)["format"] is None
