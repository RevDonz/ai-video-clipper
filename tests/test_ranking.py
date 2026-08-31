import dataclasses
import errno
import json
import math
import os
import select
import signal
import threading
import time
import unicodedata
from pathlib import Path

import pytest

import ai_clipper.ranking as ranking_module
from ai_clipper.candidates import BoundaryCandidate
from ai_clipper.features import FeatureEvidence, FeatureExtractionResult
from ai_clipper.media_features import (
    ANALYZER_VERSION,
    AudioFeatures,
    MediaFeatureAnalysis,
    VisualFeatures,
)
from ai_clipper.models import CandidateFeatures, ClipProfile
from ai_clipper.ranking import (
    MAX_ARTIFACT_BYTES,
    MAX_ARTIFACT_CANDIDATES,
    MAX_RANKING_INPUTS,
    SELECTION_VERSION,
    CandidatesArtifact,
    MediaEvidenceSnapshot,
    RankedInput,
    RankingMediaSignals,
    ScoreBreakdown,
    ScoreContribution,
    WeightConfig,
    candidate_artifact_lock,
    rank_candidates,
    rank_candidates_with_breakdowns,
    read_candidates_artifact,
    write_candidates_artifact,
)


def feature_values(**overrides: float) -> CandidateFeatures:
    values = {
        "hook_strength": 8.0,
        "hook_relevance": 7.0,
        "standalone_context": 6.0,
        "payoff_completeness": 9.0,
        "information_density": 5.0,
        "emotion_energy": 5.0,
        "dialogue_dynamics": 5.0,
        "visual_activity": 5.0,
        "topic_value": 4.0,
        "boundary_quality": 10.0,
        "penalty": 0.0,
    }
    values.update(overrides)
    return CandidateFeatures(**values)


def boundary(key: int, start: float, end: float, text: str) -> BoundaryCandidate:
    return BoundaryCandidate(key, key + 1, start, end, text, ("segment",), ("segment",))


def extracted(
    features: CandidateFeatures,
    terms: tuple[str, ...],
    *,
    reason: str = "Hook memuat tanda tanya langsung (?/？).",
) -> FeatureExtractionResult:
    evidence = (FeatureEvidence("hook.direct_question", "hook_strength", "positive", reason),)
    return FeatureExtractionResult(features, evidence, terms)


def ranked_input(
    key: str,
    start: float,
    end: float,
    text: str,
    *,
    features: CandidateFeatures | None = None,
    terms: tuple[str, ...] = (),
    media: RankingMediaSignals | MediaFeatureAnalysis | None = None,
    reason: str = "Hook memuat tanda tanya langsung (?/？).",
) -> RankedInput:
    candidate = boundary(int(start), start, end, text)
    result = extracted(
        features or feature_values(), terms or tuple(text.casefold().split()), reason=reason
    )
    return RankedInput(key, candidate, result, media)


def weights(**overrides: object) -> WeightConfig:
    values: dict[str, object] = {
        "hook_strength": 1.0,
        "hook_relevance": 0.0,
        "standalone_context": 0.0,
        "payoff_completeness": 1.0,
        "information_density": 0.0,
        "topic_value": 0.0,
        "boundary_quality": 0.0,
        "audio_energy": 1.0,
        "audio_energy_change": 0.0,
        "scene_activity": 0.0,
        "motion": 0.0,
        "face_activity": 0.0,
        "penalty": 1.0,
        "overlap_threshold": 0.5,
        "overlap_metric": "overlap_ratio",
        "diversity_strength": 0.3,
    }
    values.update(overrides)
    return WeightConfig(**values)


def media(
    source: str,
    start: float,
    end: float,
    *,
    energy: float | None = None,
    change: float | None = None,
    scene: float | None = None,
    motion: float | None = None,
    face: float | None = None,
) -> RankingMediaSignals:
    return RankingMediaSignals(
        analyzer_version="media-features-v1",
        analysis_id=f"m-{start}-{end}",
        source=source,
        interval_start=start,
        interval_end=end,
        audio_energy=energy,
        energy_change=change,
        scene_activity=scene,
        motion=motion,
        face_activity=face,
    )


def task4_analysis(
    source: str = "a.mp4", start: float = 0.0, end: float = 30.0
) -> MediaFeatureAnalysis:
    return MediaFeatureAnalysis(
        analyzer_version=ANALYZER_VERSION,
        analysis_id="analysis-task4",
        source=source,
        source_duration=max(end, 60.0),
        window_start=start,
        window_end=end,
        audio=AudioFeatures(None, 2.0, (), None, 3.0, 10),
        visual=VisualFeatures((), 4.0, 5.0, 0.5, 6.0, 10),
        warnings=(),
        provenance=("typed fixture",),
    )


def artifact_from_separately_ranked_intervals(
    intervals: tuple[tuple[float, float], ...], config: WeightConfig
) -> CandidatesArtifact:
    candidates = []
    breakdowns = []
    for index, (start, end) in enumerate(intervals, 1):
        selection = rank_candidates_with_breakdowns(
            [ranked_input(str(index), start, end, f"Candidate {index}", terms=(str(index),))],
            source="a.mp4",
            profile=ClipProfile.STANDARD,
            k=1,
            config=config,
        )
        candidates.append(
            dataclasses.replace(selection.candidates[0], rank=index, display_order=index)
        )
        breakdowns.append(selection.breakdowns[0])
    return CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("separately ranked test fixtures",),
        config,
        tuple(candidates),
        tuple(breakdowns),
    )


def test_weight_config_is_versioned_immutable_and_strict():
    config = weights()

    assert config.version == SELECTION_VERSION == "selection-v2.0"
    with pytest.raises(dataclasses.FrozenInstanceError):
        config.hook_strength = 2.0  # type: ignore[misc]
    assert WeightConfig.from_dict(config.to_dict()) == config
    with pytest.raises(ValueError, match="unknown"):
        WeightConfig.from_dict({**config.to_dict(), "mystery": 1.0})


@pytest.mark.parametrize("field", ["hook_strength", "penalty", "diversity_strength"])
@pytest.mark.parametrize("value", [True, -0.1, math.inf, math.nan])
def test_weight_config_rejects_boolean_negative_and_nonfinite_values(field: str, value: object):
    with pytest.raises((TypeError, ValueError), match=field):
        weights(**{field: value})


def test_weight_config_requires_positive_usable_weight_total_and_exact_version():
    with pytest.raises(ValueError, match="positive usable weight"):
        weights(hook_strength=0.0, payoff_completeness=0.0, audio_energy=0.0)
    with pytest.raises(ValueError, match="version"):
        weights(version="selection-v2.1")


def test_weighted_score_renormalizes_when_optional_media_is_missing():
    item = ranked_input("a", 0.0, 30.0, "Cloud costs explained", terms=("cloud", "costs"))

    selected = rank_candidates(
        [item], source="video-a.mp4", profile=ClipProfile.STANDARD, k=1, config=weights()
    )

    assert selected[0].score == pytest.approx(8.5)


def test_measured_optional_media_enters_its_weight_and_text_placeholders_do_not_double_count():
    item = ranked_input(
        "a",
        0.0,
        30.0,
        "Cloud costs explained",
        terms=("cloud", "costs"),
        media=media("video-a.mp4", 0.0, 30.0, energy=1.0),
    )

    selected = rank_candidates(
        [item], source="video-a.mp4", profile=ClipProfile.STANDARD, k=1, config=weights()
    )

    assert selected[0].score == pytest.approx(6.0)
    assert selected[0].features.emotion_energy == 5.0


def test_penalty_is_explicitly_subtracted_and_score_is_bounded():
    clean = ranked_input("clean", 0.0, 30.0, "Clean topic", features=feature_values())
    penalized = ranked_input(
        "penalized", 40.0, 70.0, "Penalized topic", features=feature_values(penalty=3.0)
    )

    selected = rank_candidates(
        [clean, penalized],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=weights(audio_energy=0.0, diversity_strength=0.0),
    )

    scores = {candidate.text: candidate.score for candidate in selected}
    assert scores["Clean topic"] == pytest.approx(8.5)
    assert scores["Penalized topic"] == pytest.approx(5.5)


def test_ranked_selection_exposes_strict_machine_readable_score_breakdown():
    item = ranked_input(
        "a",
        0.0,
        30.0,
        "Cloud costs",
        features=feature_values(penalty=0.5),
        media=media("a.mp4", 0.0, 30.0, energy=1.0),
    )
    config = weights(diversity_strength=0.0)

    selection = rank_candidates_with_breakdowns(
        [item], source="a.mp4", profile=ClipProfile.STANDARD, k=1, config=config
    )

    candidate = selection.candidates[0]
    breakdown = selection.breakdowns[0]
    assert breakdown.candidate_id == candidate.candidate_id
    assert [(part.name, part.source) for part in breakdown.contributions] == [
        ("hook_strength", "text"),
        ("payoff_completeness", "text"),
        ("audio_energy", "media"),
    ]
    assert breakdown.active_weight_total == pytest.approx(3.0)
    assert breakdown.weighted_pre_penalty_score == pytest.approx(6.0)
    assert breakdown.penalty_deduction == pytest.approx(0.5)
    assert breakdown.diversity_deduction == 0.0
    assert breakdown.final_score == candidate.score == pytest.approx(5.5)
    assert ScoreBreakdown.from_dict(breakdown.to_dict()) == breakdown


def test_score_breakdown_rejects_unknown_missing_and_duplicate_contributions():
    contribution = ScoreContribution("hook_strength", 8.0, 1.0, 8.0, "text")
    with pytest.raises(ValueError, match="duplicate contribution"):
        ScoreBreakdown(
            "cand_x",
            SELECTION_VERSION,
            (contribution, contribution),
            2.0,
            8.0,
            0.0,
            0.0,
            8.0,
        )
    with pytest.raises(ValueError, match="unknown"):
        ScoreContribution.from_dict({**contribution.to_dict(), "extra": 1})
    payload = contribution.to_dict()
    del payload["weight"]
    with pytest.raises(ValueError, match="missing"):
        ScoreContribution.from_dict(payload)


def test_overlap_ratio_removes_contained_candidates_deterministically():
    best = ranked_input("best", 0.0, 60.0, "Cloud audit", features=feature_values(hook_strength=10))
    contained = ranked_input("inside", 10.0, 40.0, "Cloud contained", features=feature_values())
    separate = ranked_input("separate", 70.0, 100.0, "Tax planning", features=feature_values())

    selected = rank_candidates(
        [contained, separate, best],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=10,
        config=weights(audio_energy=0.0, diversity_strength=0.0),
    )

    assert [candidate.text for candidate in selected] == ["Cloud audit", "Tax planning"]


def test_mmr_prefers_distinct_topic_over_semantic_duplicate():
    cloud_best = ranked_input(
        "cloud-best",
        0.0,
        30.0,
        "Cloud server costs",
        features=feature_values(hook_strength=10),
        terms=("cloud", "server", "costs"),
    )
    cloud_duplicate = ranked_input(
        "cloud-copy",
        40.0,
        70.0,
        "Cloud server costs again",
        features=feature_values(hook_strength=9.5),
        terms=("cloud", "server", "costs"),
    )
    tax_distinct = ranked_input(
        "tax",
        80.0,
        110.0,
        "Tax planning guide",
        features=feature_values(hook_strength=8),
        terms=("tax", "planning", "guide"),
    )

    selected = rank_candidates(
        [cloud_duplicate, tax_distinct, cloud_best],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=weights(audio_energy=0.0, diversity_strength=0.4),
    )

    assert [candidate.text for candidate in selected] == [
        "Cloud server costs",
        "Tax planning guide",
    ]
    assert selected[1].score == pytest.approx(8.5)


def test_distinct_high_quality_topics_keep_quality_order():
    items = [
        ranked_input(
            "b",
            40.0,
            70.0,
            "Tax planning",
            features=feature_values(hook_strength=9),
            terms=("tax",),
        ),
        ranked_input(
            "a",
            0.0,
            30.0,
            "Cloud costs",
            features=feature_values(hook_strength=10),
            terms=("cloud",),
        ),
    ]
    selected = rank_candidates(
        items,
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=weights(audio_energy=0.0, diversity_strength=1.0),
    )
    assert [candidate.text for candidate in selected] == ["Cloud costs", "Tax planning"]


def test_ties_are_input_order_independent_with_documented_chronological_then_key_policy():
    later = ranked_input("a", 40.0, 70.0, "Later", terms=("later",))
    earlier_z = ranked_input("z", 0.0, 30.0, "Earlier Z", terms=("earlier", "z"))
    earlier_a = ranked_input("a2", 0.0, 35.0, "Earlier A", terms=("earlier", "a"))
    config = weights(
        audio_energy=0.0,
        diversity_strength=0.0,
        overlap_threshold=1.0,
        overlap_metric="iou",
    )

    forward = rank_candidates(
        [later, earlier_z, earlier_a],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=3,
        config=config,
    )
    reverse = rank_candidates(
        [earlier_a, earlier_z, later],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=3,
        config=config,
    )

    assert [candidate.candidate_id for candidate in forward] == [
        candidate.candidate_id for candidate in reverse
    ]
    assert [candidate.text for candidate in forward] == ["Earlier Z", "Earlier A", "Later"]


def test_rank_is_selection_order_while_display_order_is_chronological():
    later_best = ranked_input(
        "later", 50.0, 80.0, "Later best", features=feature_values(hook_strength=10)
    )
    earlier = ranked_input(
        "earlier", 0.0, 30.0, "Earlier", features=feature_values(hook_strength=6)
    )

    selected = rank_candidates(
        [earlier, later_best],
        source="video-a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=weights(audio_energy=0.0, diversity_strength=0.0),
    )

    assert [(item.text, item.rank, item.display_order) for item in selected] == [
        ("Later best", 1, 2),
        ("Earlier", 2, 1),
    ]


def test_artifact_score_breakdowns_roundtrip_and_reject_candidate_or_math_tampering(tmp_path: Path):
    config = weights(audio_energy=0.0, diversity_strength=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("lexical",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    path = tmp_path / "candidates.v2.json"
    write_candidates_artifact(path, artifact)

    assert read_candidates_artifact(path) == artifact
    payload = artifact.to_dict()
    payload["breakdowns"][0]["candidate_id"] = "cand_mismatch"
    with pytest.raises(ValueError, match="match"):
        CandidatesArtifact.from_dict(payload)

    payload = artifact.to_dict()
    payload["breakdowns"][0]["final_score"] += 0.1
    with pytest.raises(ValueError, match="math"):
        CandidatesArtifact.from_dict(payload)


def test_artifact_rejects_diversity_deduction_not_derived_from_config_and_rank_order():
    config = weights(audio_energy=0.0, diversity_strength=0.5)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs", terms=("cloud",))],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    original = selection.breakdowns[0]
    tampered_breakdown = dataclasses.replace(
        original,
        diversity_deduction=0.25,
        final_score=round(original.final_score - 0.25, 6),
    )
    tampered_candidate = dataclasses.replace(
        selection.candidates[0], score=tampered_breakdown.final_score
    )

    with pytest.raises(ValueError, match="diversity deduction"):
        CandidatesArtifact(
            SELECTION_VERSION,
            "a.mp4",
            ("lexical",),
            config,
            (tampered_candidate,),
            (tampered_breakdown,),
        )


def test_artifact_rejects_contiguous_but_nonchronological_display_order(tmp_path: Path):
    config = weights(audio_energy=0.0, diversity_strength=0.0)
    selection = rank_candidates_with_breakdowns(
        [
            ranked_input(
                "later", 50.0, 80.0, "Later best", features=feature_values(hook_strength=10)
            ),
            ranked_input("earlier", 0.0, 30.0, "Earlier", features=feature_values(hook_strength=6)),
        ],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=config,
    )
    tampered = (
        dataclasses.replace(selection.candidates[0], display_order=1),
        dataclasses.replace(selection.candidates[1], display_order=2),
    )

    with pytest.raises(ValueError, match="chronological"):
        CandidatesArtifact(
            SELECTION_VERSION, "a.mp4", ("lexical",), config, tampered, selection.breakdowns
        )

    valid = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("lexical",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    payload = valid.to_dict()
    payload["candidates"][0]["display_order"] = 1
    payload["candidates"][1]["display_order"] = 2
    path = tmp_path / "candidates.v2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="chronological"):
        read_candidates_artifact(path)


def test_stable_ids_repeat_but_are_separated_by_source_and_profile():
    item = ranked_input("source-key", 0.0, 30.0, "Cloud costs")
    config = weights(audio_energy=0.0)

    def one(source: str, profile: ClipProfile = ClipProfile.STANDARD) -> str:
        return rank_candidates([item], source=source, profile=profile, k=1, config=config)[
            0
        ].candidate_id

    assert one("a.mp4") == one("a.mp4")
    assert one("a.mp4") != one("b.mp4")
    assert one("a.mp4") != one("a.mp4", ClipProfile.VIRAL_SHORT)


def test_candidate_identity_is_independent_of_binding_input_key():
    first = ranked_input("transient-binding-a", 0.0, 30.0, "Cloud costs")
    second = dataclasses.replace(first, input_key="transient-binding-b")

    first_id = rank_candidates([first], source="a.mp4", profile=ClipProfile.STANDARD, k=1)[
        0
    ].candidate_id
    second_id = rank_candidates([second], source="a.mp4", profile=ClipProfile.STANDARD, k=1)[
        0
    ].candidate_id

    assert first_id == second_id


def test_candidate_identity_canonicalizes_negative_zero_and_equivalent_urls():
    negative_zero = ranked_input("a", -0.0, 30.0, "Cloud costs")
    positive_zero = ranked_input("b", 0.0, 30.0, "Cloud costs")

    first_id = rank_candidates(
        [negative_zero],
        source=" HTTPS://Example.TEST:443/a%7Eb?z=2&name=hello%20world#fragment ",
        profile=ClipProfile.STANDARD,
        k=1,
    )[0].candidate_id
    second_id = rank_candidates(
        [positive_zero],
        source="https://example.test/a~b?name=hello+world&z=2",
        profile=ClipProfile.STANDARD,
        k=1,
    )[0].candidate_id

    assert first_id == second_id


def test_candidate_identity_separates_version_and_meaningful_timestamps():
    base = ranking_module._derive_candidate_id(
        "a.mp4", ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.0
    )

    assert base != ranking_module._derive_candidate_id(
        "a.mp4", ClipProfile.STANDARD, "selection-v2.1", 0.0, 30.0
    )
    assert base != ranking_module._derive_candidate_id(
        "a.mp4", ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.000000000000004
    )


def test_artifact_rejects_candidate_id_not_derived_from_its_identity(tmp_path: Path):
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    candidate = selection.candidates[0]

    with pytest.raises(ValueError, match="derived identity"):
        CandidatesArtifact(
            SELECTION_VERSION,
            "a.mp4",
            ("lexical",),
            config,
            (dataclasses.replace(candidate, candidate_id="cand_tampered"),),
            selection.breakdowns,
        )

    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("lexical",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    payload = artifact.to_dict()
    payload["candidates"][0]["candidate_id"] = "cand_tampered"
    path = tmp_path / "candidates.v2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="derived identity"):
        read_candidates_artifact(path)


def test_k_caps_results_and_rejects_invalid_types_and_duplicate_bindings():
    first = ranked_input("first", 0.0, 30.0, "First")
    second = ranked_input("second", 40.0, 70.0, "Second")
    config = weights(audio_energy=0.0)

    assert (
        rank_candidates(
            [first, second], source="a.mp4", profile=ClipProfile.STANDARD, k=0, config=config
        )
        == []
    )
    assert (
        len(
            rank_candidates(
                [first, second], source="a.mp4", profile=ClipProfile.STANDARD, k=20, config=config
            )
        )
        == 2
    )
    with pytest.raises(TypeError, match="k"):
        rank_candidates(
            [first], source="a.mp4", profile=ClipProfile.STANDARD, k=True, config=config
        )
    with pytest.raises(ValueError, match="duplicate input IDs"):
        rank_candidates(
            [first, dataclasses.replace(second, input_key="first")],
            source="a.mp4",
            profile=ClipProfile.STANDARD,
            k=2,
            config=config,
        )
    with pytest.raises(ValueError, match="duplicate candidate intervals"):
        rank_candidates(
            [first, dataclasses.replace(second, candidate=first.candidate)],
            source="a.mp4",
            profile=ClipProfile.STANDARD,
            k=2,
            config=config,
        )


def test_strict_binding_rejects_wrong_types_and_mismatched_media():
    item = ranked_input("first", 0.0, 30.0, "First")
    with pytest.raises(TypeError, match="candidate"):
        RankedInput("bad", object(), item.extraction)  # type: ignore[arg-type]
    wrong_source = dataclasses.replace(item, media=media("other.mp4", 0.0, 30.0, energy=5.0))
    with pytest.raises(ValueError, match="source"):
        rank_candidates([wrong_source], source="a.mp4", profile=ClipProfile.STANDARD, k=1)
    wrong_window = dataclasses.replace(item, media=media("a.mp4", 1.0, 30.0, energy=5.0))
    with pytest.raises(ValueError, match="window"):
        rank_candidates([wrong_window], source="a.mp4", profile=ClipProfile.STANDARD, k=1)


def test_optional_media_fields_only_influence_the_matching_configured_measurement():
    base = ranked_input(
        "base", 0.0, 30.0, "Cloud costs", media=media("a.mp4", 0.0, 30.0, energy=2.0, motion=9.0)
    )
    changed_motion = dataclasses.replace(
        base, media=media("a.mp4", 0.0, 30.0, energy=2.0, motion=0.0)
    )
    config = weights(hook_strength=0.0, payoff_completeness=0.0, audio_energy=1.0, motion=0.0)

    first = rank_candidates(
        [base], source="a.mp4", profile=ClipProfile.STANDARD, k=1, config=config
    )[0]
    second = rank_candidates(
        [changed_motion], source="a.mp4", profile=ClipProfile.STANDARD, k=1, config=config
    )[0]
    assert first.score == second.score == 2.0


def test_reasons_are_literal_evidence_or_honest_fallback_and_never_claim_probability():
    item = ranked_input("first", 0.0, 30.0, "Cloud costs")
    selected = rank_candidates(
        [item],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(audio_energy=0.0),
    )[0]

    assert selected.reasons == ("Hook berbentuk pertanyaan langsung.",)
    assert all(
        term not in " ".join(selected.reasons).casefold()
        for term in ("viral", "probability", "virality")
    )


def test_artifact_exact_roundtrip_rejects_unknown_fields_and_tampered_version(tmp_path: Path):
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("Task 3 lexical evidence",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    path = tmp_path / "analysis" / "candidates.v2.json"

    write_candidates_artifact(path, artifact)

    assert read_candidates_artifact(path) == artifact
    payload = json.loads(path.read_text())
    with pytest.raises(ValueError, match="unknown"):
        CandidatesArtifact.from_dict({**payload, "raw_media": "forbidden"})
    payload["selection_version"] = "selection-v2.1"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="selection_version"):
        read_candidates_artifact(path)


def test_artifact_atomic_replacement_uses_unique_temp_and_leaves_no_pending_files(
    tmp_path: Path, monkeypatch
):
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("lexical",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    path = tmp_path / "analysis" / "candidates.v2.json"
    real_replace = os.replace
    pending_names: list[str] = []

    def capture_replace(source, destination):
        pending_names.append(Path(source).name)
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", capture_replace)
    write_candidates_artifact(path, artifact)
    write_candidates_artifact(
        path, dataclasses.replace(artifact, provenance=("lexical", "reranked"))
    )

    assert len(set(pending_names)) == 2
    assert read_candidates_artifact(path).provenance == ("lexical", "reranked")
    assert list(path.parent.glob("*.tmp")) == []


def test_artifact_rejects_credentials_empty_provenance_and_noncontiguous_ranks():
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    candidate = selection.candidates[0]
    with pytest.raises(ValueError, match="credentials"):
        CandidatesArtifact(
            SELECTION_VERSION,
            "https://user:pass@example.test/video",
            ("lexical",),
            config,
            (candidate,),
            selection.breakdowns,
        )
    with pytest.raises((TypeError, ValueError), match="provenance"):
        CandidatesArtifact(
            SELECTION_VERSION, "a.mp4", (), config, (candidate,), selection.breakdowns
        )
    with pytest.raises(ValueError, match="rank"):
        CandidatesArtifact(
            SELECTION_VERSION,
            "a.mp4",
            ("lexical",),
            config,
            (dataclasses.replace(candidate, rank=2),),
            selection.breakdowns,
        )


@pytest.mark.parametrize(
    "credential_name",
    [
        "token",
        "ACCESS_TOKEN",
        "id-token",
        "refresh.token",
        "apiKey",
        "api_key",
        "auth",
        "Authorization",
        "credential",
        "password",
        "passwd",
        "secret",
        "signature",
        "sig",
        "x-amz-signature",
        "x-amz-credential",
        "X-Amz-Security-Token",
        "x_amz_security_token",
        "x.amz.security-token",
        "x-goog-signature",
        "x-goog-credential",
        "aws-access-key-id",
        "policy",
    ],
)
def test_source_rejects_comprehensive_normalized_credential_query_names(
    credential_name: str,
):
    source = f"https://media.example.test/video.mp4?{credential_name}=do-not-persist"

    with pytest.raises(ValueError, match="credentials") as error:
        rank_candidates([], source=source, profile=ClipProfile.STANDARD, k=0)

    assert "do-not-persist" not in str(error.value)


@pytest.mark.parametrize(
    "source",
    [
        "data:video/mp4;base64,AAAA",
        "DaTa:audio/mpeg;base64,AAAA",
        " video/webm;base64,AAAA ",
    ],
)
def test_source_rejects_data_uris_and_obvious_embedded_media_payloads(source: str):
    with pytest.raises(ValueError, match="embedded media"):
        rank_candidates([], source=source, profile=ClipProfile.STANDARD, k=0)


def test_source_rejects_userinfo_password_and_accepts_ordinary_query_names():
    with pytest.raises(ValueError, match="credentials"):
        rank_candidates(
            [],
            source="https://user:password@example.test/video.mp4",
            profile=ClipProfile.STANDARD,
            k=0,
        )

    assert (
        rank_candidates(
            [],
            source="https://example.test/video.mp4?monkey=capuchin&author=Ada&chapter=",
            profile=ClipProfile.STANDARD,
            k=0,
        )
        == []
    )
    assert (
        rank_candidates(
            [],
            source="https://example.test/video.mp4?tokenizer=bpe&secretary=Ada",
            profile=ClipProfile.STANDARD,
            k=0,
        )
        == []
    )


@pytest.mark.parametrize("fragment", ["access_token=hidden", "x-amz-signature=hidden"])
def test_source_rejects_credentials_in_key_value_fragments_without_leaking_value(fragment: str):
    with pytest.raises(ValueError, match="credentials") as error:
        rank_candidates(
            [],
            source=f"https://example.test/video.mp4#chapter=2&{fragment}",
            profile=ClipProfile.STANDARD,
            k=0,
        )

    assert "hidden" not in str(error.value)


def test_default_overlap_policy_rejects_one_second_overlap_but_accepts_touching_endpoints():
    best = ranked_input("best", 0.0, 30.0, "Best", features=feature_values(hook_strength=10))
    overlaps = ranked_input("overlap", 29.0, 59.0, "Overlap")
    touches = ranked_input("touch", 30.0, 60.0, "Touch")

    selected = rank_candidates(
        [overlaps, touches, best],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=3,
        config=WeightConfig(diversity_strength=0.0),
    )

    assert WeightConfig().overlap_threshold == 0.0
    assert [candidate.text for candidate in selected] == ["Best", "Touch"]


def test_custom_overlap_threshold_allows_small_positive_overlap():
    best = ranked_input("best", 0.0, 30.0, "Best", features=feature_values(hook_strength=10))
    small_overlap = ranked_input("small", 29.0, 59.0, "Small overlap")

    selected = rank_candidates(
        [small_overlap, best],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=2,
        config=weights(overlap_threshold=0.5, audio_energy=0.0, diversity_strength=0.0),
    )

    assert [candidate.text for candidate in selected] == ["Best", "Small overlap"]


@pytest.mark.parametrize("intervals", [((0.0, 30.0), (29.0, 59.0)), ((0.0, 30.0), (5.0, 20.0))])
def test_constructed_artifact_rejects_default_positive_overlap(intervals):
    with pytest.raises(ValueError, match="overlap policy"):
        artifact_from_separately_ranked_intervals(intervals, WeightConfig(diversity_strength=0.0))


def test_constructed_artifact_accepts_touching_endpoints():
    artifact = artifact_from_separately_ranked_intervals(
        ((0.0, 30.0), (30.0, 60.0)), WeightConfig(diversity_strength=0.0)
    )

    assert [(candidate.start, candidate.end) for candidate in artifact.candidates] == [
        (0.0, 30.0),
        (30.0, 60.0),
    ]


@pytest.mark.parametrize(
    ("metric", "accepted_threshold", "rejected_threshold"),
    [("overlap_ratio", 0.51, 0.5), ("iou", 0.34, 1 / 3)],
)
def test_artifact_custom_overlap_threshold_accepts_below_and_rejects_at_threshold(
    metric: str, accepted_threshold: float, rejected_threshold: float
):
    accepted = artifact_from_separately_ranked_intervals(
        ((0.0, 10.0), (5.0, 15.0)),
        WeightConfig(
            overlap_metric=metric,
            overlap_threshold=accepted_threshold,
            diversity_strength=0.0,
        ),
    )
    assert len(accepted.candidates) == 2

    with pytest.raises(ValueError, match="overlap policy"):
        artifact_from_separately_ranked_intervals(
            ((0.0, 10.0), (5.0, 15.0)),
            WeightConfig(
                overlap_metric=metric,
                overlap_threshold=rejected_threshold,
                diversity_strength=0.0,
            ),
        )


def test_artifact_from_dict_rejects_json_shaped_overlap_tampering():
    artifact = artifact_from_separately_ranked_intervals(
        ((0.0, 10.0), (10.0, 20.0)), WeightConfig(diversity_strength=0.0)
    )
    payload = artifact.to_dict()
    payload["candidates"][1]["start"] = 9.0
    tampered_id = ranking_module._derive_candidate_id(
        "a.mp4", ClipProfile.STANDARD, SELECTION_VERSION, 9.0, 20.0
    )
    payload["candidates"][1]["candidate_id"] = tampered_id
    payload["breakdowns"][1]["candidate_id"] = tampered_id

    with pytest.raises(ValueError, match="overlap policy"):
        CandidatesArtifact.from_dict(payload)


def test_artifact_reader_rejects_duplicate_json_keys_and_nonstandard_constants(tmp_path: Path):
    path = tmp_path / "candidates.v2.json"
    path.write_text('{"selection_version":"selection-v2.0","selection_version":"selection-v2.0"}')
    with pytest.raises(ValueError, match="duplicate JSON key"):
        read_candidates_artifact(path)

    path.write_text('{"selection_version": NaN}')
    with pytest.raises(ValueError, match="non-standard JSON constant"):
        read_candidates_artifact(path)


def test_ranked_input_rejects_malformed_boundary_candidate_fields():
    valid = ranked_input("valid", 0.0, 30.0, "Cloud costs")
    malformed = BoundaryCandidate(True, 1, 0.0, math.nan, "Cloud costs", ("segment",), ("segment",))
    with pytest.raises((TypeError, ValueError), match="candidate"):
        RankedInput("bad", malformed, valid.extraction)


def test_prohibited_claim_in_upstream_reason_is_not_published():
    candidate = boundary(0, 0.0, 30.0, "Cloud costs")
    extraction = extracted(
        feature_values(),
        ("cloud", "costs"),
        reason="Guaranteed viral probability.",
    )
    selected = rank_candidates(
        [RankedInput("bad-reason", candidate, extraction)],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(audio_energy=0.0),
    )[0]

    assert selected.reasons == ("Hook berbentuk pertanyaan langsung.",)


def test_guaranteed_claim_in_upstream_reason_is_not_published():
    candidate = boundary(0, 0.0, 30.0, "Cloud costs")
    extraction = extracted(
        feature_values(),
        ("cloud", "costs"),
        reason="Guaranteed engagement after publishing.",
    )

    selected = rank_candidates(
        [RankedInput("bad-reason", candidate, extraction)],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(audio_energy=0.0),
    )[0]

    assert selected.reasons == ("Hook berbentuk pertanyaan langsung.",)


@pytest.mark.parametrize(
    "reason",
    [
        "This will go viral.",
        "Virality is certain.",
        "Viralitas tinggi.",
        "Guaranteed engagement.",
        "Guaranteeing high engagement.",
        "Guarantees high performance.",
        "Probably high performance.",
        "Probable high performance.",
        "High performance probability.",
        "Probabilitas performa tinggi.",
        "Performance certainty.",
        "Performa pasti tinggi.",
    ],
)
def test_artifact_ingestion_rejects_prohibited_reason_claims(reason: str):
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    candidate = selection.candidates[0]

    with pytest.raises(ValueError, match="prohibited claim"):
        CandidatesArtifact(
            SELECTION_VERSION,
            "a.mp4",
            ("lexical",),
            config,
            (dataclasses.replace(candidate, reasons=(reason,)),),
            selection.breakdowns,
        )


@pytest.mark.parametrize(
    "reason",
    [
        "Viralitas tinggi.",
        "Guaranteeing engagement.",
        "Probably high performance.",
        "Performance certainty.",
        "Performa pasti tinggi.",
    ],
)
def test_ranking_sanitizes_prohibited_claim_morphology(reason: str):
    candidate = boundary(0, 0.0, 30.0, "Cloud costs")
    extraction = extracted(feature_values(), ("cloud", "costs"), reason=reason)

    selected = rank_candidates(
        [RankedInput("claim", candidate, extraction)],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(audio_energy=0.0),
    )[0]

    assert selected.reasons == ("Hook berbentuk pertanyaan langsung.",)


def test_artifact_reader_rejects_json_tampered_with_prohibited_reason(tmp_path: Path):
    config = weights(audio_energy=0.0)
    selection = rank_candidates_with_breakdowns(
        [ranked_input("first", 0.0, 30.0, "Cloud costs")],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=config,
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("lexical",),
        config,
        selection.candidates,
        selection.breakdowns,
    )
    payload = artifact.to_dict()
    payload["candidates"][0]["reasons"] = ["Probabilitas performa tinggi."]
    path = tmp_path / "candidates.v2.json"
    path.write_text(json.dumps(payload))

    with pytest.raises(ValueError, match="prohibited claim"):
        read_candidates_artifact(path)


@pytest.mark.parametrize(
    "source",
    [
        "https://example.test/v?ok=1;access_token=hidden",
        "https://example.test/v#chapter=1;access_token=hidden",
        "https://example.test/v?access%5Ftoken=hidden",
        "https://example.test/%FF",
        "https://example.test/v?name=%FE",
        "https://example.test/v?bad=%",
        "https://example.test/v#bad=%G0",
    ],
)
def test_source_rejects_ambiguous_or_invalid_url_encoding_without_leaking(source: str):
    with pytest.raises(ValueError) as error:
        rank_candidates([], source=source, profile=ClipProfile.STANDARD, k=0)
    assert "hidden" not in str(error.value)
    assert source not in str(error.value)


def test_candidate_identity_canonicalizes_root_dot_segments_and_unicode_nfc():
    item = ranked_input("a", 0.0, 30.0, "Cloud costs")

    def identity(source: str) -> str:
        return rank_candidates([item], source=source, profile=ClipProfile.STANDARD, k=1)[
            0
        ].candidate_id

    composed = unicodedata.normalize("NFC", "cafe\u0301")
    decomposed = unicodedata.normalize("NFD", composed)
    assert identity("https://EXAMPLE.test") == identity("https://example.test/")
    assert identity("https://example.test/a/./b/../c") == identity("https://example.test/a/c")
    assert identity(f"https://example.test/{decomposed}") == identity(
        f"https://example.test/{composed}"
    )


def test_empty_query_has_no_pair_but_explicit_empty_name_pair_remains_distinct():
    assert ranking_module._decoded_pairs("") == []
    assert ranking_module._decoded_pairs("=") == [("", "")]
    assert ranking_module._canonical_source("https://example.test") == "https://example.test/"
    assert ranking_module._derive_candidate_id(
        "https://example.test", ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.0
    ) != ranking_module._derive_candidate_id(
        "https://example.test?=", ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.0
    )


@pytest.mark.parametrize(
    "name",
    ["access_token", "access%5Ftoken", "access%255Ftoken", "access%25255Ftoken"],
)
def test_source_rejects_sensitive_parameter_name_at_every_supported_decode_stage(name: str):
    with pytest.raises(ValueError, match="credentials") as error:
        rank_candidates(
            [],
            source=f"https://example.test/v?{name}=never-disclose",
            profile=ClipProfile.STANDARD,
            k=0,
        )
    assert "never-disclose" not in str(error.value)


@pytest.mark.parametrize("name", ["access%2525255Ftoken", "safe%25252526access_token"])
def test_source_rejects_excessively_nested_or_residual_obscured_parameter_names(name: str):
    with pytest.raises(ValueError) as error:
        rank_candidates(
            [],
            source=f"https://example.test/v?{name}=never-disclose",
            profile=ClipProfile.STANDARD,
            k=0,
        )
    assert "never-disclose" not in str(error.value)


def test_ordinary_percent_encoded_utf8_parameter_name_is_accepted():
    assert (
        rank_candidates(
            [],
            source="https://example.test/v?caf%C3%A9=oui",
            profile=ClipProfile.STANDARD,
            k=0,
        )
        == []
    )


def test_unicode_hostname_nfc_and_idna_forms_have_one_identity_and_bind_media():
    unicode_host = "https://cafe\u0301.example/video"
    ascii_host = "https://xn--caf-dma.example/video"
    item = ranked_input("a", 0.0, 30.0, "Cloud", media=media(unicode_host, 0.0, 30.0, energy=2.0))
    assert ranking_module._derive_candidate_id(
        unicode_host, ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.0
    ) == ranking_module._derive_candidate_id(
        ascii_host, ClipProfile.STANDARD, SELECTION_VERSION, 0.0, 30.0
    )
    assert len(rank_candidates([item], source=ascii_host, profile=ClipProfile.STANDARD, k=1)) == 1


def test_invalid_idna_hostname_is_rejected_without_source_content():
    source = "https://bad host.example/secret-path"
    with pytest.raises(ValueError, match="hostname") as error:
        rank_candidates([], source=source, profile=ClipProfile.STANDARD, k=0)
    assert source not in str(error.value)


def test_ranked_input_canonicalizes_topic_terms_stably():
    item = ranked_input("a", 0.0, 30.0, "Topics", terms=("Cloud", "cloud", " Cafe\u0301 ", "Café"))
    assert item.extraction.topic_terms == ("cloud", "café")
    selected = rank_candidates([item], source="a.mp4", profile=ClipProfile.STANDARD, k=1)[0]
    assert selected.topic_terms == ("cloud", "café")


def test_media_snapshot_is_persisted_and_exactly_binds_contributions():
    item = ranked_input(
        "a",
        0.0,
        30.0,
        "Cloud",
        media=media("a.mp4", 0.0, 30.0, energy=2.0, motion=7.0),
    )
    config = weights(motion=0.0, diversity_strength=0.0)
    selection = rank_candidates_with_breakdowns(
        [item], source="a.mp4", profile=ClipProfile.STANDARD, k=1, config=config
    )
    snapshot = selection.media_snapshots[0]
    assert snapshot == MediaEvidenceSnapshot(
        "media-features-v1", "m-0.0-30.0", "a.mp4", 0.0, 30.0, 2.0, None, None, 7.0
    )
    artifact = CandidatesArtifact(
        SELECTION_VERSION,
        "a.mp4",
        ("bound media",),
        config,
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )
    assert CandidatesArtifact.from_dict(artifact.to_dict()) == artifact

    for field, value in (
        ("analysis_id", "tampered"),
        ("source", "other.mp4"),
        ("interval_start", 1.0),
        ("analyzer_version", "tampered"),
        ("audio_energy", 3.0),
        ("face_activity", 8.0),
    ):
        payload = artifact.to_dict()
        payload["media_snapshots"][0][field] = value
        with pytest.raises(ValueError):
            CandidatesArtifact.from_dict(payload)

    payload = artifact.to_dict()
    payload["media_snapshots"][0] = None
    with pytest.raises(ValueError, match="media"):
        CandidatesArtifact.from_dict(payload)


@pytest.mark.parametrize("value", [True, -1.0, 10.1, math.inf, math.nan])
def test_media_snapshot_rejects_invalid_measurements(value: object):
    with pytest.raises((TypeError, ValueError)):
        RankingMediaSignals("v1", "id", "a.mp4", 0.0, 30.0, value, None, None, None)


def test_media_reasons_only_describe_active_nonzero_breakdown_contributions():
    item = ranked_input(
        "a",
        0.0,
        30.0,
        "Cloud",
        media=media("a.mp4", 0.0, 30.0, energy=2.0, motion=7.0),
    )
    candidate = rank_candidates(
        [item],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(audio_energy=1.0, motion=0.0),
    )[0]
    joined = " ".join(candidate.reasons)
    assert "audio_energy" in joined
    assert "motion" not in joined


def test_task4_typed_analysis_adapter_maps_all_measured_signals_including_face():
    analysis = task4_analysis()
    signals = RankingMediaSignals.from_media_analysis(analysis)
    assert signals == RankingMediaSignals(
        ANALYZER_VERSION,
        "analysis-task4",
        "a.mp4",
        0.0,
        30.0,
        2.0,
        3.0,
        4.0,
        5.0,
        6.0,
    )
    with pytest.raises(TypeError, match="MediaFeatureAnalysis"):
        RankingMediaSignals.from_media_analysis(object())  # type: ignore[arg-type]
    unicode_source = dataclasses.replace(analysis, source="HTTPS://cafe\u0301.example:443/video")
    assert (
        RankingMediaSignals.from_media_analysis(unicode_source).source
        == "https://xn--caf-dma.example/video"
    )


def test_ranked_input_accepts_real_task4_analysis_and_face_contributes_and_is_bound():
    item = ranked_input("a", 0.0, 30.0, "Cloud", media=task4_analysis())
    selection = rank_candidates_with_breakdowns(
        [item],
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=1,
        config=weights(
            hook_strength=0.0,
            payoff_completeness=0.0,
            audio_energy=0.0,
            face_activity=1.0,
            diversity_strength=0.0,
        ),
    )
    assert [(part.name, part.value) for part in selection.breakdowns[0].contributions] == [
        ("face_activity", 6.0)
    ]
    assert selection.candidates[0].score == 6.0
    assert selection.media_snapshots[0].face_activity == 6.0

    with pytest.raises(ValueError, match="source"):
        rank_candidates(
            [ranked_input("b", 0.0, 30.0, "Cloud", media=task4_analysis("other.mp4"))],
            source="a.mp4",
            profile=ClipProfile.STANDARD,
            k=1,
        )
    with pytest.raises(ValueError, match="window"):
        rank_candidates(
            [ranked_input("c", 0.0, 30.0, "Cloud", media=task4_analysis(start=1.0))],
            source="a.mp4",
            profile=ClipProfile.STANDARD,
            k=1,
        )


def test_ranking_reasons_use_safe_tag_templates_not_upstream_free_text():
    item = ranked_input("a", 0.0, 30.0, "Cloud", reason="Attacker controlled sentence.")
    candidate = rank_candidates([item], source="a.mp4", profile=ClipProfile.STANDARD, k=1)[0]
    assert "Attacker controlled" not in " ".join(candidate.reasons)
    assert candidate.reasons[0] == "Hook berbentuk pertanyaan langsung."


def test_breakdown_rejects_global_text_media_interleaving():
    text = ScoreContribution("hook_strength", 8.0, 1.0, 8.0, "text")
    payoff = ScoreContribution("payoff_completeness", 9.0, 1.0, 9.0, "text")
    media_part = ScoreContribution("audio_energy", 2.0, 1.0, 2.0, "media")
    with pytest.raises(ValueError, match="canonical"):
        ScoreBreakdown(
            "x", SELECTION_VERSION, (text, media_part, payoff), 3.0, 19 / 3, 0, 0, 6.333333
        )


def test_public_untrusted_input_and_artifact_bounds_are_enforced_without_allocating_thousands():
    assert MAX_RANKING_INPUTS == MAX_ARTIFACT_CANDIDATES == 5000
    oversized = [ranked_input("0", 0.0, 30.0, "0")] * 2

    class OversizedList(list):
        def __len__(self):
            return MAX_RANKING_INPUTS + 1

    with pytest.raises(TypeError, match="list"):
        rank_candidates(OversizedList(oversized), source="a.mp4", profile=ClipProfile.STANDARD, k=1)


def test_artifact_from_dict_rejects_nonexact_or_misaligned_arrays_before_conversion(monkeypatch):
    artifact = artifact_from_separately_ranked_intervals(
        ((0.0, 30.0),), weights(audio_energy=0.0, diversity_strength=0.0)
    )
    payload = artifact.to_dict()

    class DeceptiveList(list):
        def __len__(self):
            raise AssertionError("subclass length must not be consulted")

    payload["candidates"] = DeceptiveList(payload["candidates"])
    with pytest.raises(TypeError, match="arrays"):
        CandidatesArtifact.from_dict(payload)

    payload = artifact.to_dict()
    payload["media_snapshots"] = []
    monkeypatch.setattr(
        ranking_module.ClipCandidate, "from_dict", lambda _: pytest.fail("converted")
    )
    with pytest.raises(ValueError, match="equal lengths"):
        CandidatesArtifact.from_dict(payload)


def test_artifact_rejects_oversized_raw_arrays_and_contributions_before_conversion(monkeypatch):
    artifact = artifact_from_separately_ranked_intervals(
        ((0.0, 30.0),), weights(audio_energy=0.0, diversity_strength=0.0)
    )
    payload = artifact.to_dict()
    monkeypatch.setattr(ranking_module, "MAX_ARTIFACT_CANDIDATES", 0)
    monkeypatch.setattr(
        ranking_module.ClipCandidate, "from_dict", lambda _: pytest.fail("converted")
    )
    with pytest.raises(ValueError, match="at most"):
        CandidatesArtifact.from_dict(payload)

    breakdown = artifact.breakdowns[0].to_dict()
    breakdown["contributions"] = [breakdown["contributions"][0]] * 13
    monkeypatch.setattr(
        ranking_module.ScoreContribution, "from_dict", lambda _: pytest.fail("converted")
    )
    with pytest.raises(ValueError, match="contributions"):
        ScoreBreakdown.from_dict(breakdown)


def test_artifact_reader_enforces_regular_file_and_bounded_binary_read(tmp_path: Path, monkeypatch):
    assert MAX_ARTIFACT_BYTES == 16 * 1024 * 1024
    directory = tmp_path / "directory"
    directory.mkdir()
    with pytest.raises(ValueError, match="regular file"):
        read_candidates_artifact(directory)

    path = tmp_path / "oversized.json"
    path.write_bytes(b"{}")
    monkeypatch.setattr(ranking_module, "MAX_ARTIFACT_BYTES", 1)
    with pytest.raises(ValueError, match="at most") as error:
        read_candidates_artifact(path)
    assert "{}" not in str(error.value)


def test_mmr_similarity_calls_grow_at_most_once_per_remaining_candidate_per_selection(monkeypatch):
    count = 0
    real_similarity = ranking_module._topic_similarity

    def counted(left, right):
        nonlocal count
        count += 1
        return real_similarity(left, right)

    monkeypatch.setattr(ranking_module, "_topic_similarity", counted)
    size, selected_count = 600, 20
    inputs = [
        ranked_input(str(i), i * 40.0, i * 40.0 + 30.0, f"topic{i}", terms=(f"topic{i}",))
        for i in range(size)
    ]
    result = rank_candidates(
        inputs,
        source="a.mp4",
        profile=ClipProfile.STANDARD,
        k=selected_count,
        config=weights(audio_energy=0.0),
    )
    assert len(result) == selected_count
    assert count <= size * selected_count


def test_artifact_rejects_symlink_analysis_directory(tmp_path: Path):
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "analysis"
    link.symlink_to(real, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        write_candidates_artifact(
            link / "candidates.v2.json",
            artifact_from_separately_ranked_intervals(
                ((0.0, 30.0),), weights(audio_energy=0.0, diversity_strength=0.0)
            ),
        )


def test_candidate_lock_rejects_nonregular_lock_path(tmp_path: Path):
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    (analysis / ".candidates.v2.lock").mkdir()
    with (
        pytest.raises(ValueError, match="regular"),
        candidate_artifact_lock(analysis, exclusive=True),
    ):
        pass


@pytest.mark.skipif(not hasattr(os, "fork"), reason="requires POSIX fork")
@pytest.mark.parametrize("owner_exclusive", [False, True], ids=["shared", "exclusive"])
def test_fork_child_reacquires_candidate_lock_after_abrupt_parent_exit(
    tmp_path: Path, owner_exclusive: bool
):
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    read_fd, write_fd = os.pipe()
    lock_owner = os.fork()
    if lock_owner == 0:  # pragma: no cover - assertions run in the parent process
        os.close(read_fd)
        with candidate_artifact_lock(analysis, exclusive=owner_exclusive):
            contender = os.fork()
            if contender == 0:
                try:
                    signal.alarm(3)
                    with candidate_artifact_lock(analysis, exclusive=True):
                        os.write(write_fd, b"acquired\n")
                    os._exit(0)
                except (OSError, RuntimeError, ValueError) as error:
                    os.write(write_fd, f"error:{error!r}\n".encode())
                    os._exit(1)
            os.write(write_fd, f"pid:{contender}\n".encode())
            os._exit(0)

    os.close(write_fd)
    contender_pid = None
    output = b""
    try:
        waited_pid, status = os.waitpid(lock_owner, 0)
        assert waited_pid == lock_owner
        assert os.waitstatus_to_exitcode(status) == 0
        deadline = time.monotonic() + 5
        while b"acquired\n" not in output and time.monotonic() < deadline:
            readable, _, _ = select.select([read_fd], [], [], deadline - time.monotonic())
            if not readable:
                break
            chunk = os.read(read_fd, 4096)
            if not chunk:
                break
            output += chunk
        for line in output.splitlines():
            if line.startswith(b"pid:"):
                contender_pid = int(line.removeprefix(b"pid:"))
        assert b"acquired\n" in output
    finally:
        os.close(read_fd)
        if contender_pid is not None and b"acquired\n" not in output:
            try:
                os.kill(contender_pid, 9)
            except ProcessLookupError:
                pass


@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="requires Linux procfs")
def test_candidate_lock_registry_is_exact_across_nested_locks_and_repeated_forks(tmp_path: Path):
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    initial_fd_count = len(list(Path("/proc/self/fd").iterdir()))

    with candidate_artifact_lock(analysis, exclusive=False):
        assert len(ranking_module._candidate_lock_fds) == 1
        candidate_fd = next(iter(ranking_module._candidate_lock_fds))
        held_fd_count = len(list(Path("/proc/self/fd").iterdir()))
        with candidate_artifact_lock(analysis, exclusive=False):
            assert ranking_module._candidate_lock_fds == {candidate_fd}
            for _ in range(3):
                child = os.fork()
                if child == 0:  # pragma: no cover - assertions run through the exit status
                    registry_was_reset = ranking_module._candidate_lock_fds == set()
                    try:
                        os.fstat(candidate_fd)
                    except OSError as error:
                        descriptor_was_closed = error.errno == errno.EBADF
                    else:
                        descriptor_was_closed = False
                    os._exit(0 if registry_was_reset and descriptor_was_closed else 1)
                _, status = os.waitpid(child, 0)
                assert os.waitstatus_to_exitcode(status) == 0
                assert ranking_module._candidate_lock_fds == {candidate_fd}
                assert len(list(Path("/proc/self/fd").iterdir())) == held_fd_count

    assert ranking_module._candidate_lock_fds == set()
    assert len(list(Path("/proc/self/fd").iterdir())) == initial_fd_count


def test_atomic_writer_reader_stress_never_observes_partial_json(tmp_path: Path):
    path = tmp_path / "analysis" / "candidates.v2.json"
    base = artifact_from_separately_ranked_intervals(
        ((0.0, 30.0),), weights(audio_energy=0.0, diversity_strength=0.0)
    )
    write_candidates_artifact(path, base)
    errors: list[Exception] = []

    def writer():
        try:
            for i in range(50):
                write_candidates_artifact(
                    path, dataclasses.replace(base, provenance=(f"write-{i}",))
                )
        except (OSError, TypeError, ValueError) as exc:
            errors.append(exc)

    thread = threading.Thread(target=writer)
    thread.start()
    while thread.is_alive():
        try:
            assert read_candidates_artifact(path).provenance[0].startswith(("write-", "separately"))
        except (AssertionError, OSError, TypeError, ValueError) as exc:
            errors.append(exc)
    thread.join()
    assert errors == []
