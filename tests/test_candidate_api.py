import io
import json
from copy import deepcopy

import pytest

import ai_clipper.ranking as ranking_module
from ai_clipper.candidate_api import MAX_INPUT_BYTES, artifact_bytes_to_presentation, run
from ai_clipper.candidates import BoundaryCandidate
from ai_clipper.features import FeatureEvidence, FeatureExtractionResult
from ai_clipper.models import CandidateFeatures, ClipProfile
from ai_clipper.ranking import (
    SELECTION_VERSION,
    CandidatesArtifact,
    RankedInput,
    RankingMediaSignals,
    WeightConfig,
    rank_candidates_with_breakdowns,
)


def task5_artifact() -> CandidatesArtifact:
    source = "https://EXAMPLE.test:443/a/./video.mp4?b=2&a=1"
    canonical_media_source = "https://example.test/a/video.mp4?a=1&b=2"
    features = CandidateFeatures(
        hook_strength=8.0,
        hook_relevance=0.0,
        standalone_context=6.0,
        payoff_completeness=9.0,
        information_density=5.0,
        emotion_energy=0.0,
        dialogue_dynamics=0.0,
        visual_activity=0.0,
        topic_value=4.0,
        boundary_quality=10.0,
        penalty=0.0,
    )
    extraction = FeatureExtractionResult(
        features,
        (FeatureEvidence("hook.direct_question", "hook_strength", "positive", "why?"),),
        ("cloud",),
    )
    ranked = RankedInput(
        "one",
        BoundaryCandidate(0, 1, 0.0, 30.0, "Why are cloud bills high?", ("segment",), ("segment",)),
        extraction,
        RankingMediaSignals(
            "media-features-v1",
            "internal-analysis-id",
            canonical_media_source,
            0.0,
            30.0,
            0.0,
            None,
            2.0,
            0.0,
            6.0,
        ),
    )
    config = WeightConfig(
        hook_strength=1.0,
        hook_relevance=0.0,
        standalone_context=0.0,
        payoff_completeness=0.0,
        information_density=0.0,
        topic_value=0.0,
        boundary_quality=0.0,
        audio_energy=1.0,
        audio_energy_change=0.0,
        scene_activity=0.0,
        motion=0.0,
        face_activity=1.0,
        penalty=0.0,
        overlap_threshold=0.0,
        diversity_strength=0.0,
    )
    selection = rank_candidates_with_breakdowns(
        [ranked], source=source, profile=ClipProfile.STANDARD, k=1, config=config
    )
    return CandidatesArtifact(
        SELECTION_VERSION,
        source,
        (
            "Task 3 lexical evidence",
            "https://private.invalid/?token=never-disclose",
            "password=never-disclose",
        ),
        config,
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )


def encoded(artifact: CandidatesArtifact | None = None) -> bytes:
    return json.dumps((artifact or task5_artifact()).to_dict(), allow_nan=False).encode()


def two_candidate_artifact() -> CandidatesArtifact:
    config = WeightConfig(overlap_threshold=0.2, diversity_strength=0.3)
    features = CandidateFeatures(8.0, 7.0, 6.0, 9.0, 5.0, 0.0, 0.0, 0.0, 4.0, 10.0, 0.0)

    def item(key: str, start: float, end: float, term: str) -> RankedInput:
        return RankedInput(
            key,
            BoundaryCandidate(
                int(start), int(start) + 1, start, end, f"Clip {term}", ("segment",), ("segment",)
            ),
            FeatureExtractionResult(features, (), (term,)),
            None,
        )

    source = "a.mp4"
    selection = rank_candidates_with_breakdowns(
        [item("one", 0.0, 30.0, "cloud"), item("two", 40.0, 70.0, "billing")],
        source=source,
        profile=ClipProfile.STANDARD,
        k=2,
        config=config,
    )
    return CandidatesArtifact(
        SELECTION_VERSION,
        source,
        ("task5",),
        config,
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )


def test_authoritative_validator_presents_actual_task5_artifact_without_sensitive_fields():
    dto = artifact_bytes_to_presentation(encoded())

    assert dto["available"] is True
    assert dto["selectionVersion"] == SELECTION_VERSION
    assert dto["provenance"] == ["selection-v2.0", "media-features-v1"]
    assert len(dto["candidates"]) == 1
    candidate = dto["candidates"][0]
    assert candidate["start"] == 0.0
    assert candidate["features"]["hookRelevance"] == 0.0
    assert candidate["scoreBreakdown"]["contributions"][1]["value"] == 0.0
    assert candidate["measuredMedia"] == {
        "intervalStart": 0.0,
        "intervalEnd": 30.0,
        "measurements": {
            "audioEnergy": 0.0,
            "energyChange": None,
            "sceneActivity": 2.0,
            "motion": 0.0,
            "faceActivity": 6.0,
        },
    }
    serialized = json.dumps(dto)
    for forbidden in (
        "EXAMPLE.test",
        "private.invalid",
        "never-disclose",
        "internal-analysis-id",
        "weight_config",
        "media_evidence_sha256",
        "candidate_id",
    ):
        assert forbidden not in serialized


def test_presentation_is_sorted_by_display_order():
    artifact = task5_artifact()
    first = artifact.candidates[0]
    payload = artifact.to_dict()
    # An authoritative two-candidate artifact is easier to obtain by ranking two inputs.
    second_input = RankedInput(
        "two",
        BoundaryCandidate(2, 3, 40.0, 70.0, "Cloud answer.", ("segment",), ("segment",)),
        FeatureExtractionResult(first.features, (), ("answer",)),
        None,
    )
    first_input = RankedInput(
        "one",
        BoundaryCandidate(0, 1, 0.0, 30.0, first.text, ("segment",), ("segment",)),
        FeatureExtractionResult(first.features, (), ("cloud",)),
        None,
    )
    selection = rank_candidates_with_breakdowns(
        [second_input, first_input],
        source=artifact.source,
        profile=ClipProfile.STANDARD,
        k=2,
        config=WeightConfig(diversity_strength=0.0),
    )
    multi = CandidatesArtifact(
        SELECTION_VERSION,
        artifact.source,
        ("raw provenance is ignored",),
        WeightConfig(diversity_strength=0.0),
        selection.candidates,
        selection.breakdowns,
        selection.media_snapshots,
    )
    payload = artifact_bytes_to_presentation(encoded(multi))
    assert [item["displayOrder"] for item in payload["candidates"]] == [1, 2]
    assert [item["start"] for item in payload["candidates"]] == [0.0, 40.0]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["candidates"][0].__setitem__("candidate_id", "tampered"),
        lambda value: value["candidates"][0].__setitem__("end", 60.0),
        lambda value: value["breakdowns"][0].__setitem__("diversity_deduction", 1.0),
        lambda value: value["breakdowns"][0].__setitem__("final_score", 1.0),
        lambda value: value["media_snapshots"][0].__setitem__("face_activity", 5.0),
    ],
)
def test_candidates_artifact_rejects_identity_overlap_mmr_and_evidence_tampering(mutate):
    payload = deepcopy(task5_artifact().to_dict())
    mutate(payload)
    with pytest.raises((TypeError, ValueError)):
        artifact_bytes_to_presentation(json.dumps(payload).encode())


def test_authoritative_validator_rejects_overlap_even_when_tampered_identity_is_rederived():
    artifact = two_candidate_artifact()
    payload = artifact.to_dict()
    index = next(i for i, value in enumerate(payload["candidates"]) if value["start"] == 40.0)
    candidate = payload["candidates"][index]
    candidate["start"] = 20.0
    candidate["end"] = 50.0
    candidate["candidate_id"] = ranking_module._derive_candidate_id(
        artifact.source, ClipProfile.STANDARD, SELECTION_VERSION, 20.0, 50.0
    )
    payload["breakdowns"][index]["candidate_id"] = candidate["candidate_id"]

    with pytest.raises(ValueError, match="overlap"):
        artifact_bytes_to_presentation(json.dumps(payload).encode())


def test_authoritative_validator_recomputes_mmr_diversity_from_rank_order():
    payload = two_candidate_artifact().to_dict()
    payload["candidates"][1]["topic_terms"] = payload["candidates"][0]["topic_terms"]

    with pytest.raises(ValueError, match="diversity"):
        artifact_bytes_to_presentation(json.dumps(payload).encode())


def test_strict_json_rejects_duplicate_keys_nonfinite_and_invalid_utf8():
    valid = encoded().decode()
    duplicate = valid.replace(
        '"selection_version": "selection-v2.0"',
        '"selection_version": "selection-v2.0", "selection_version": "selection-v2.0"',
        1,
    ).encode()
    for raw in (duplicate, valid.replace("0.0", "NaN", 1).encode(), b"\xff"):
        with pytest.raises((TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError)):
            artifact_bytes_to_presentation(raw)


def test_input_limit_is_enforced_at_exact_boundary_plus_one():
    with pytest.raises(ValueError, match="size"):
        artifact_bytes_to_presentation(b" " * (MAX_INPUT_BYTES + 1))


def test_cli_errors_are_fixed_sanitized_and_nonzero():
    secret = b'{"source":"https://private.invalid/?token=never-disclose"}'
    stdout = io.BytesIO()
    stderr = io.StringIO()

    status = run(io.BytesIO(secret), stdout, stderr)

    assert status != 0
    assert stdout.getvalue() == b""
    assert stderr.getvalue() == "candidate_api_error\n"
    assert "never-disclose" not in stderr.getvalue()


def test_cli_reads_at_most_limit_plus_one_and_emits_json():
    class CountingInput(io.BytesIO):
        def __init__(self, value: bytes):
            super().__init__(value)
            self.requested = []

        def read(self, size: int = -1) -> bytes:
            self.requested.append(size)
            return super().read(size)

    stream = CountingInput(encoded())
    stdout = io.BytesIO()
    status = run(stream, stdout, io.StringIO())
    assert status == 0
    assert stream.requested == [MAX_INPUT_BYTES + 1]
    assert json.loads(stdout.getvalue())["available"] is True
