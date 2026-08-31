import math

import pytest

from ai_clipper.models import CandidateFeatures, CaptionStyle, ClipCandidate, ClipProfile


def features(**overrides):
    values = {
        "hook_strength": 8.0,
        "hook_relevance": 8.0,
        "standalone_context": 7.0,
        "payoff_completeness": 9.0,
        "information_density": 7.0,
        "emotion_energy": 5.0,
        "dialogue_dynamics": 6.0,
        "visual_activity": 4.0,
        "topic_value": 8.0,
        "boundary_quality": 9.0,
        "penalty": 1.0,
    }
    values.update(overrides)
    return CandidateFeatures(**values)


def test_clip_profiles_are_explicit_and_stable():
    assert ClipProfile("viral-short") is ClipProfile.VIRAL_SHORT
    assert ClipProfile("standard") is ClipProfile.STANDARD
    assert ClipProfile("deep-dive") is ClipProfile.DEEP_DIVE
    with pytest.raises(ValueError):
        ClipProfile("viral-guaranteed")


@pytest.mark.parametrize("bad_score", [-0.1, 10.1, math.nan, math.inf])
def test_candidate_feature_scores_are_finite_and_bounded(bad_score):
    with pytest.raises(ValueError, match="0 and 10"):
        features(hook_strength=bad_score)


def test_boolean_values_are_not_accepted_as_numeric_scores_or_limits():
    with pytest.raises(TypeError, match="hook_strength"):
        features(hook_strength=True)
    with pytest.raises(TypeError, match="score"):
        ClipCandidate(
            "bad",
            0.0,
            20.0,
            "teks",
            ClipProfile.STANDARD,
            features(),
            True,
            ("alasan",),
        )
    with pytest.raises(TypeError, match="max_words"):
        CaptionStyle(max_words=True)


def test_candidate_carries_explainable_breakdown_and_reasons():
    candidate = ClipCandidate(
        candidate_id="candidate-001",
        start=10.0,
        end=48.5,
        text="Kenapa banyak orang mengalami masalah ini? Ternyata ada satu penyebab utama.",
        profile=ClipProfile.VIRAL_SHORT,
        features=features(),
        score=8.2,
        reasons=("Pertanyaan langsung", "Payoff lengkap"),
        topic_terms=("masalah", "penyebab"),
        rank=1,
        display_order=2,
    )

    assert candidate.duration == 38.5
    assert candidate.features.payoff_completeness == 9.0
    assert candidate.reasons == ("Pertanyaan langsung", "Payoff lengkap")

    payload = candidate.to_dict()
    assert ClipCandidate.from_dict(payload) == candidate


def test_candidate_json_boundary_rejects_unknown_nested_fields_and_wrong_arrays():
    candidate = ClipCandidate(
        "candidate-001",
        10.0,
        48.5,
        "Pertanyaan dan payoff.",
        ClipProfile.VIRAL_SHORT,
        features(),
        8.2,
        ("Pertanyaan langsung",),
    )
    payload = candidate.to_dict()
    payload["features"]["unknown"] = 3
    with pytest.raises(ValueError, match="unknown"):
        ClipCandidate.from_dict(payload)

    payload = candidate.to_dict()
    payload["reasons"] = "bukan-array"
    with pytest.raises(TypeError, match="arrays"):
        ClipCandidate.from_dict(payload)


def test_candidate_rejects_invalid_timestamps_score_and_empty_reasons():
    with pytest.raises(ValueError, match="timestamps"):
        ClipCandidate(
            "bad", 20.0, 10.0, "teks", ClipProfile.STANDARD, features(), 5.0, ("alasan",)
        )
    with pytest.raises(ValueError, match="score"):
        ClipCandidate(
            "bad", 0.0, 20.0, "teks", ClipProfile.STANDARD, features(), 11.0, ("alasan",)
        )
    with pytest.raises(ValueError, match="reason"):
        ClipCandidate(
            "bad", 0.0, 20.0, "teks", ClipProfile.STANDARD, features(), 5.0, ()
        )
    with pytest.raises(TypeError, match="profile"):
        ClipCandidate(
            "bad", 0.0, 20.0, "teks", "viral-guaranteed", features(), 5.0, ("alasan",)
        )


@pytest.mark.parametrize("rank", [True, 1.5, math.nan, 0, -1])
def test_candidate_rank_must_be_a_positive_integer(rank):
    with pytest.raises((TypeError, ValueError), match="rank"):
        ClipCandidate(
            "bad",
            0.0,
            20.0,
            "teks",
            ClipProfile.STANDARD,
            features(),
            5.0,
            ("alasan",),
            rank=rank,
        )


def test_candidate_requires_typed_features_and_immutable_string_evidence():
    with pytest.raises(TypeError, match="features"):
        ClipCandidate(
            "bad", 0.0, 20.0, "teks", ClipProfile.STANDARD, {}, 5.0, ("alasan",)
        )
    with pytest.raises(TypeError, match="reasons"):
        ClipCandidate(
            "bad", 0.0, 20.0, "teks", ClipProfile.STANDARD, features(), 5.0, ["alasan"]
        )
    with pytest.raises(ValueError, match="topic"):
        ClipCandidate(
            "bad",
            0.0,
            20.0,
            "teks",
            ClipProfile.STANDARD,
            features(),
            5.0,
            ("alasan",),
            ("",),
        )


def test_caption_style_validates_preset_colors_and_cue_limits():
    style = CaptionStyle(
        preset="bold-keyword",
        position="lower-middle",
        base_color="#FFFFFF",
        keyword_color="#DFFF58",
        max_words=5,
        max_lines=2,
    )
    assert style.preset == "bold-keyword"

    with pytest.raises(ValueError, match="preset"):
        CaptionStyle(preset="exploding-neon")
    with pytest.raises(ValueError, match="color"):
        CaptionStyle(base_color="white")
    with pytest.raises(ValueError, match="max_words"):
        CaptionStyle(max_words=0)
