"""Bounded Task 5 artifact validator and presentation-only JSON bridge.

This module is intentionally executable so the web process can delegate every
artifact semantic decision to :class:`CandidatesArtifact`. Input is read from
stdin to avoid reopening a path after the web process has securely opened it.
"""

from __future__ import annotations

import json
import sys
from typing import BinaryIO, TextIO

from .media_features import ANALYZER_VERSION
from .ranking import MAX_ARTIFACT_BYTES, CandidatesArtifact

MAX_INPUT_BYTES = MAX_ARTIFACT_BYTES
_ERROR = "candidate_api_error\n"


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> object:
    raise ValueError("non-standard JSON number")


def _strict_payload(encoded: bytes) -> object:
    if not isinstance(encoded, bytes):
        raise TypeError("artifact input must be bytes")
    if len(encoded) > MAX_INPUT_BYTES:
        raise ValueError("artifact input exceeds size limit")
    document = encoded.decode("utf-8")
    return json.loads(
        document,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_json_constant,
    )


def _present_breakdown(value: object) -> dict[str, object]:
    breakdown = value
    return {
        "contributions": [
            {
                "name": contribution.name,
                "value": contribution.value,
                "weight": contribution.weight,
                "weightedValue": contribution.weighted_value,
                "source": contribution.source,
            }
            for contribution in breakdown.contributions
        ],
        "activeWeightTotal": breakdown.active_weight_total,
        "weightedPrePenaltyScore": breakdown.weighted_pre_penalty_score,
        "penaltyDeduction": breakdown.penalty_deduction,
        "diversityDeduction": breakdown.diversity_deduction,
        "finalScore": breakdown.final_score,
    }


def _present_media(value: object | None) -> dict[str, object] | None:
    if value is None:
        return None
    snapshot = value
    return {
        "intervalStart": snapshot.interval_start,
        "intervalEnd": snapshot.interval_end,
        "measurements": {
            "audioEnergy": snapshot.audio_energy,
            "energyChange": snapshot.energy_change,
            "sceneActivity": snapshot.scene_activity,
            "motion": snapshot.motion,
            "faceActivity": snapshot.face_activity,
        },
    }


def present_candidates(artifact: CandidatesArtifact) -> dict[str, object]:
    """Create a presentation DTO with no source, raw provenance, or audit IDs."""
    breakdowns = {item.candidate_id: item for item in artifact.breakdowns}
    snapshots = {
        candidate.candidate_id: snapshot
        for candidate, snapshot in zip(artifact.candidates, artifact.media_snapshots, strict=True)
    }
    provenance = [artifact.selection_version]
    if any(
        snapshot is not None and snapshot.analyzer_version == ANALYZER_VERSION
        for snapshot in artifact.media_snapshots
    ):
        provenance.append(ANALYZER_VERSION)

    candidates = []
    for candidate in sorted(artifact.candidates, key=lambda item: item.display_order):
        candidates.append(
            {
                "id": candidate.candidate_id,
                "start": candidate.start,
                "end": candidate.end,
                "duration": candidate.end - candidate.start,
                "text": candidate.text,
                "profile": candidate.profile.value,
                "score": candidate.score,
                "reasons": list(candidate.reasons),
                "topicTerms": list(candidate.topic_terms),
                "rank": candidate.rank,
                "displayOrder": candidate.display_order,
                "features": {
                    "hookStrength": candidate.features.hook_strength,
                    "hookRelevance": candidate.features.hook_relevance,
                    "standaloneContext": candidate.features.standalone_context,
                    "payoffCompleteness": candidate.features.payoff_completeness,
                    "informationDensity": candidate.features.information_density,
                    "emotionEnergy": candidate.features.emotion_energy,
                    "dialogueDynamics": candidate.features.dialogue_dynamics,
                    "visualActivity": candidate.features.visual_activity,
                    "topicValue": candidate.features.topic_value,
                    "boundaryQuality": candidate.features.boundary_quality,
                    "penalty": candidate.features.penalty,
                },
                "scoreBreakdown": _present_breakdown(breakdowns[candidate.candidate_id]),
                "measuredMedia": _present_media(snapshots[candidate.candidate_id]),
            }
        )
    return {
        "available": True,
        "selectionVersion": artifact.selection_version,
        "provenance": provenance,
        "candidates": candidates,
    }


def artifact_bytes_to_presentation(encoded: bytes) -> dict[str, object]:
    """Strictly parse and authoritatively validate an encoded Task 5 artifact."""
    artifact = CandidatesArtifact.from_dict(_strict_payload(encoded))
    return present_candidates(artifact)


def run(stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO) -> int:
    """Run the bounded stdin/stdout protocol with fixed, sanitized failures."""
    try:
        encoded = stdin.read(MAX_INPUT_BYTES + 1)
        presentation = artifact_bytes_to_presentation(encoded)
        output = json.dumps(
            presentation,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        stdout.write(output)
        stdout.write(b"\n")
        return 0
    except Exception:  # noqa: BLE001 - protocol boundary must never leak failure details
        stderr.write(_ERROR)
        return 2


def main() -> int:
    return run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
