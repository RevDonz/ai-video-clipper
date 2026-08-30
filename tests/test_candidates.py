import math
from collections.abc import Sequence

import pytest

import ai_clipper.candidates as candidate_module
from ai_clipper.candidates import BoundaryCandidate, generate_candidates, profile_duration_bounds
from ai_clipper.models import ClipProfile, TranscriptSegment


def segments(count: int, *, seconds: float = 10.0) -> list[TranscriptSegment]:
    return [
        TranscriptSegment(index * seconds, (index + 1) * seconds, f"Segment {index}.")
        for index in range(count)
    ]


@pytest.mark.parametrize(
    ("profile", "expected"),
    [
        (ClipProfile.VIRAL_SHORT, (15.0, 45.0)),
        (ClipProfile.STANDARD, (30.0, 90.0)),
        (ClipProfile.DEEP_DIVE, (60.0, 300.0)),
    ],
)
def test_profiles_have_exact_duration_bounds(profile: ClipProfile, expected: tuple[float, float]):
    assert profile_duration_bounds(profile) == expected


def test_emits_multiple_whole_segment_variants_per_anchor():
    source = segments(7, seconds=10.0)

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=3,
        max_candidates=20,
    )

    anchored_at_zero = [candidate for candidate in candidates if candidate.start_index == 0]
    assert [(candidate.start, candidate.end) for candidate in anchored_at_zero] == [
        (0.0, 20.0),
        (0.0, 30.0),
        (0.0, 40.0),
    ]
    assert all(isinstance(candidate, BoundaryCandidate) for candidate in candidates)
    assert all(candidate.start == source[candidate.start_index].start for candidate in candidates)
    assert all(candidate.end == source[candidate.end_index].end for candidate in candidates)


def test_structural_endpoint_duplicates_do_not_underfill_anchor_variants():
    source = [
        TranscriptSegment(index * 5.0, (index + 1) * 5.0, "Shared camera topic detail.")
        for index in range(10)
    ]
    source[2] = TranscriptSegment(10.0, 15.0, "Shared camera topic opening question?")
    source[8] = TranscriptSegment(40.0, 45.0, "Shared camera topic closing question?")

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=3,
        max_candidates=20,
    )

    anchored_at_zero = [candidate for candidate in candidates if candidate.start_index == 0]
    assert len(anchored_at_zero) == 3
    assert len({candidate.end_index for candidate in anchored_at_zero}) == 3


def test_one_variant_per_anchor_is_supported_through_public_api():
    candidates = generate_candidates(
        segments(5, seconds=10.0),
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=1,
        max_candidates=20,
    )

    anchored_at_zero = [candidate for candidate in candidates if candidate.start_index == 0]
    assert [(candidate.start, candidate.end) for candidate in anchored_at_zero] == [(0.0, 20.0)]


def test_exact_profile_duration_boundaries_are_inclusive():
    source = [
        TranscriptSegment(0.0, 15.0, "Exactly the minimum."),
        TranscriptSegment(15.0, 45.0, "Together these reach the exact maximum."),
        TranscriptSegment(45.0, 45.001, "Beyond the maximum."),
    ]

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=4,
        max_candidates=20,
    )

    assert (0.0, 15.0) in {(candidate.start, candidate.end) for candidate in candidates}
    assert (0.0, 45.0) in {(candidate.start, candidate.end) for candidate in candidates}
    assert (0.0, 45.001) not in {(candidate.start, candidate.end) for candidate in candidates}


def test_marks_pause_question_and_lexical_topic_boundaries():
    source = [
        TranscriptSegment(0.0, 20.0, "How can we reduce database latency?"),
        TranscriptSegment(20.0, 35.0, "Cache repeated queries near the application."),
        TranscriptSegment(38.0, 53.0, "Now deploy the service to the Kubernetes cluster."),
        TranscriptSegment(53.0, 68.0, "Pods need explicit memory and CPU limits."),
        TranscriptSegment(68.0, 83.0, "Bananas ripen faster beside an apple."),
        TranscriptSegment(83.0, 98.0, "Keep the fruit in a paper bag."),
    ]

    candidates = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=50)

    question = next(candidate for candidate in candidates if (candidate.start, candidate.end) == (0, 20))
    after_pause = next(candidate for candidate in candidates if candidate.start == 38)
    after_shift = next(candidate for candidate in candidates if candidate.start == 68)
    assert "question" in question.end_boundary_kinds
    assert "pause" in after_pause.start_boundary_kinds
    assert "topic-shift" in after_shift.start_boundary_kinds


def test_indonesian_function_word_overlap_still_allows_topic_shift():
    source = [
        TranscriptSegment(0.0, 15.0, "Kamera digital yang ini untuk dipakai dengan tripod."),
        TranscriptSegment(15.0, 30.0, "Resep dapur yang ini untuk dibuat dengan santan."),
    ]

    candidates = generate_candidates(source, ClipProfile.VIRAL_SHORT)

    after_shift = next(candidate for candidate in candidates if candidate.start_index == 1)
    assert "topic-shift" in after_shift.start_boundary_kinds


def test_indonesian_meaningful_word_overlap_does_not_create_topic_shift():
    source = [
        TranscriptSegment(0.0, 15.0, "Kamera digital yang ini memakai lensa tajam."),
        TranscriptSegment(15.0, 30.0, "Lensa kamera untuk potret menghasilkan detail tajam."),
    ]

    candidates = generate_candidates(source, ClipProfile.VIRAL_SHORT)

    related = next(candidate for candidate in candidates if candidate.start_index == 1)
    assert "topic-shift" not in related.start_boundary_kinds


def test_same_speaker_rhetorical_question_is_not_a_dialogue_turn():
    source = [
        TranscriptSegment(0.0, 20.0, "Why does this matter?"),
        TranscriptSegment(20.0, 40.0, "Because the same speaker is explaining the answer."),
    ]

    candidates = generate_candidates(source, ClipProfile.VIRAL_SHORT)

    rhetorical_question = next(candidate for candidate in candidates if candidate.end == 20.0)
    assert "question" in rhetorical_question.end_boundary_kinds
    assert "dialogue-turn" not in rhetorical_question.end_boundary_kinds


def test_single_segment_over_profile_maximum_emits_nothing():
    assert generate_candidates(
        [TranscriptSegment(0.0, 46.0, "One indivisible segment.")],
        ClipProfile.VIRAL_SHORT,
    ) == []


def test_question_ending_is_preserved_at_transcript_edge():
    candidates = generate_candidates(
        [TranscriptSegment(0.0, 20.0, "Could this be the final question?")],
        ClipProfile.VIRAL_SHORT,
    )

    assert candidates[0].end_boundary_kinds == ("transcript-edge", "question")


@pytest.mark.parametrize(
    "question",
    [
        'Apakah hasilnya sudah benar?"',
        "Apakah hasilnya sudah benar？”",
        "Apakah hasilnya sudah benar？）",
    ],
)
def test_indonesian_quoted_questions_are_structural_boundaries(question: str):
    source = [
        TranscriptSegment(0.0, 20.0, question),
        TranscriptSegment(20.0, 40.0, "Jawabannya dijelaskan setelah pertanyaan."),
    ]

    candidates = generate_candidates(source, ClipProfile.VIRAL_SHORT)

    question_candidate = next(candidate for candidate in candidates if candidate.end_index == 0)
    assert "question" in question_candidate.end_boundary_kinds


def test_structural_end_is_kept_when_variant_cap_requires_selection():
    source = segments(6, seconds=10.0)
    source[2] = TranscriptSegment(20.0, 30.0, "What happens next?")

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=2,
        max_candidates=20,
    )

    anchored_at_zero = [candidate for candidate in candidates if candidate.start_index == 0]
    assert [candidate.end for candidate in anchored_at_zero] == [20.0, 30.0]


def test_output_is_deterministic_unique_predictably_sorted_and_globally_capped():
    source = segments(400, seconds=1.0)

    first = generate_candidates(source, ClipProfile.DEEP_DIVE, max_candidates=17)
    second = generate_candidates(source, ClipProfile.DEEP_DIVE, max_candidates=17)

    intervals = [(candidate.start, candidate.end) for candidate in first]
    assert first == second
    assert len(first) == 17
    assert len(set(intervals)) == len(intervals)
    assert intervals == sorted(intervals)


def test_small_global_cap_preserves_a_strong_late_boundary():
    source = segments(20, seconds=10.0)
    source[17] = TranscriptSegment(170.0, 180.0, "What decisive result appears at the end?")

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=2,
        max_candidates=3,
    )

    assert len(candidates) == 3
    assert any(
        (candidate.end == 180.0 and "question" in candidate.end_boundary_kinds)
        or (candidate.start == 180.0 and "question" in candidate.start_boundary_kinds)
        for candidate in candidates
    )
    assert [(candidate.start, candidate.end) for candidate in candidates] == sorted(
        (candidate.start, candidate.end) for candidate in candidates
    )


def test_public_selection_handles_a_degenerate_anchor_span():
    source = [
        TranscriptSegment(0.0, 15.0, "First ending."),
        TranscriptSegment(15.0, 20.0, "Is this the strongest ending?"),
        TranscriptSegment(20.0, 25.0, "Last ending."),
    ]

    selected = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=3,
        max_candidates=2,
    )

    assert [(candidate.start, candidate.end) for candidate in selected] == [
        (0.0, 20.0),
        (0.0, 25.0),
    ]


def test_public_selection_is_deterministic_with_one_cap_and_sparse_anchors():
    source = [
        TranscriptSegment(0.0, 15.0, "Early material."),
        TranscriptSegment(15.0, 30.0, "More early material."),
        TranscriptSegment(99.0, 114.0, "Late result?"),
    ]

    one = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=1)
    first = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=2)
    second = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=2)

    assert len(one) == 1
    assert one[0].end == 114.0
    assert first == second
    assert len(first) == 2
    assert [candidate.start for candidate in first] == sorted(candidate.start for candidate in first)
    assert any(candidate.end == 114.0 for candidate in first)


class _CountingEnds(Sequence[float]):
    def __init__(self, size: int, step: float) -> None:
        self.size = size
        self.step = step
        self.reads = 0

    def __len__(self) -> int:
        return self.size

    def __getitem__(self, index: int) -> float:
        if not 0 <= index < self.size:
            raise IndexError(index)
        self.reads += 1
        return (index + 1) * self.step


def test_eligible_endpoint_lookup_uses_logarithmic_index_access():
    ends = _CountingEnds(8192, 0.001)

    eligible = candidate_module._eligible_end_range(ends, 0, 0.0, 15.0, 45.0)

    assert eligible is None
    assert ends.reads <= 32


def test_many_tiny_segments_below_minimum_have_bounded_deterministic_output():
    source = segments(8192, seconds=0.001)

    first = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=3)
    second = generate_candidates(source, ClipProfile.VIRAL_SHORT, max_candidates=3)

    assert first == second == []


class _CountingText(str):
    strip_reads = 0

    def strip(self, chars: str | None = None) -> str:
        type(self).strip_reads += 1
        return super().strip(chars)


def test_tiny_segments_materialize_text_only_for_globally_selected_candidates():
    source = [
        TranscriptSegment(
            index * 0.005,
            (index + 1) * 0.005,
            _CountingText(f"Segment {index}."),
        )
        for index in range(4096)
    ]
    _CountingText.strip_reads = 0

    candidates = generate_candidates(
        source,
        ClipProfile.VIRAL_SHORT,
        variants_per_anchor=4,
        max_candidates=3,
    )

    selected_segment_count = sum(
        candidate.end_index - candidate.start_index + 1 for candidate in candidates
    )
    selected_start_indices = [candidate.start_index for candidate in candidates]
    feasible_last_start_index = 1096  # 5.48 seconds leaves the 15-second minimum.
    assert len(candidates) == 3
    assert len(set(selected_start_indices)) == 3
    assert min(selected_start_indices) <= feasible_last_start_index // 4
    assert max(selected_start_indices) >= feasible_last_start_index * 3 // 4
    assert _CountingText.strip_reads == selected_segment_count
    assert all(candidate.text for candidate in candidates)


@pytest.mark.parametrize(
    "source",
    [
        [
            TranscriptSegment(10.0, 20.0, "Later."),
            TranscriptSegment(0.0, 10.0, "Earlier."),
        ],
        [
            TranscriptSegment(0.0, 12.0, "First."),
            TranscriptSegment(10.0, 20.0, "Overlapping."),
        ],
    ],
)
def test_rejects_non_chronological_or_overlapping_segments(source):
    with pytest.raises(ValueError, match="chronological and non-overlapping"):
        generate_candidates(source, ClipProfile.VIRAL_SHORT)


@pytest.mark.parametrize("name", ["variants_per_anchor", "max_candidates"])
@pytest.mark.parametrize("bad_value", [True, 1.5, 0, -1])
def test_caps_must_be_positive_integers(name: str, bad_value):
    kwargs = {name: bad_value}
    with pytest.raises((TypeError, ValueError), match=name):
        generate_candidates(segments(5), ClipProfile.VIRAL_SHORT, **kwargs)


@pytest.mark.parametrize("bad_threshold", [True, math.nan, math.inf, -0.1])
def test_pause_threshold_must_be_a_finite_non_negative_number(bad_threshold):
    with pytest.raises((TypeError, ValueError), match="pause_threshold"):
        generate_candidates(
            segments(5),
            ClipProfile.VIRAL_SHORT,
            pause_threshold=bad_threshold,
        )


def test_rejects_untyped_profile_and_segment_values():
    with pytest.raises(TypeError, match="profile"):
        generate_candidates(segments(5), "viral-short")
    with pytest.raises(TypeError, match="segments"):
        generate_candidates([object()], ClipProfile.VIRAL_SHORT)
