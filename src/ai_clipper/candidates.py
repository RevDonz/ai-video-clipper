"""Deterministic transcript-boundary candidate generation."""

from __future__ import annotations

import math
import re
from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from numbers import Real

from .models import ClipProfile, TranscriptSegment

_PROFILE_BOUNDS: dict[ClipProfile, tuple[float, float]] = {
    ClipProfile.VIRAL_SHORT: (15.0, 45.0),
    ClipProfile.STANDARD: (30.0, 90.0),
    ClipProfile.DEEP_DIVE: (60.0, 300.0),
}


@dataclass(frozen=True, slots=True)
class BoundaryCandidate:
    """A whole-segment interval awaiting feature extraction and scoring."""

    start_index: int
    end_index: int
    start: float
    end: float
    text: str
    start_boundary_kinds: tuple[str, ...]
    end_boundary_kinds: tuple[str, ...]

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class _ProvisionalCandidate:
    """Lightweight candidate metadata used before the global cap is applied."""

    start_index: int
    end_index: int
    start: float
    end: float
    start_boundary_kinds: tuple[str, ...]
    end_boundary_kinds: tuple[str, ...]


def profile_duration_bounds(profile: ClipProfile) -> tuple[float, float]:
    """Return the exact inclusive duration bounds for a V2 profile."""
    if not isinstance(profile, ClipProfile):
        raise TypeError("profile must be a ClipProfile")
    return _PROFILE_BOUNDS[profile]


def _variant_indices(first: int, last: int, cap: int, preferred: list[int]) -> list[int]:
    available = last - first + 1
    if available <= cap:
        return list(range(first, last + 1))

    selected: list[int] = []
    selected_set: set[int] = set()

    def add(index: int) -> None:
        if len(selected) < cap and index not in selected_set:
            selected.append(index)
            selected_set.add(index)

    for index in (first, *preferred, last):
        add(index)
    if cap > 1:
        for step in range(1, cap - 1):
            add(first + round(step * (available - 1) / (cap - 1)))
    for index in range(first, last + 1):
        add(index)
        if len(selected) == cap:
            break
    return sorted(selected)


def _eligible_end_range(
    ends: Sequence[float],
    start_index: int,
    start: float,
    minimum: float,
    maximum: float,
) -> tuple[int, int] | None:
    """Find the inclusive eligible endpoint range with binary searches."""
    first = bisect_left(ends, start + minimum, lo=start_index)
    after_last = bisect_right(ends, start + maximum, lo=first)
    if first == after_last:
        return None
    return first, after_last - 1


_WORDS = re.compile(r"[\w']+")
_TOPIC_STOP_WORDS = {
    # Conservative bilingual filtering: transcript language is not available,
    # so only common English and Indonesian function words are excluded.
    "a",
    "adalah",
    "akan",
    "an",
    "and",
    "atau",
    "can",
    "dalam",
    "dan",
    "dari",
    "dengan",
    "di",
    "how",
    "ini",
    "in",
    "itu",
    "juga",
    "karena",
    "ke",
    "near",
    "tidak",
    "now",
    "pada",
    "sebagai",
    "sudah",
    "the",
    "to",
    "untuk",
    "we",
    "yang",
}

_QUESTION_CLOSERS = frozenset("\"'”’»)]}）］｝")


def _is_terminal_question(text: str) -> bool:
    """Recognize a question mark before optional common closing punctuation."""
    stripped = text.rstrip()
    while stripped and stripped[-1] in _QUESTION_CLOSERS:
        stripped = stripped[:-1].rstrip()
    return stripped.endswith(("?", "？"))


def _topic_words(text: str) -> set[str]:
    return {
        word
        for word in _WORDS.findall(text.casefold())
        if len(word) > 2 and word not in _TOPIC_STOP_WORDS
    }


def _boundary_kinds(
    segments: list[TranscriptSegment], position: int, pause_threshold: float
) -> tuple[str, ...]:
    if position == 0:
        return ("transcript-edge",)
    if position == len(segments):
        kinds = ["transcript-edge"]
        if _is_terminal_question(segments[-1].text):
            kinds.append("question")
        return tuple(kinds)

    previous = segments[position - 1]
    following = segments[position]
    kinds = ["segment"]
    if following.start - previous.end >= pause_threshold and following.start > previous.end:
        kinds.append("pause")
    if _is_terminal_question(previous.text):
        kinds.append("question")
    previous_words = _topic_words(previous.text)
    following_words = _topic_words(following.text)
    if len(previous_words) >= 2 and len(following_words) >= 2:
        overlap = len(previous_words & following_words) / len(previous_words | following_words)
        if overlap <= 0.1:
            kinds.append("topic-shift")
    return tuple(kinds)


_BOUNDARY_WEIGHTS = {
    "pause": 2,
    "question": 2,
    "topic-shift": 2,
    "transcript-edge": 1,
}


def _structural_salience(candidate: _ProvisionalCandidate) -> int:
    return sum(
        _BOUNDARY_WEIGHTS.get(kind, 0)
        for kind in candidate.start_boundary_kinds + candidate.end_boundary_kinds
    )


def _globally_select(
    candidates: list[_ProvisionalCandidate],
    cap: int,
) -> list[_ProvisionalCandidate]:
    """Select salient candidates across their feasible start-anchor range."""
    if len(candidates) <= cap:
        return sorted(candidates, key=lambda candidate: (candidate.start, candidate.end))

    anchor_start = min(candidate.start for candidate in candidates)
    anchor_end = max(candidate.start for candidate in candidates)
    anchor_span = anchor_end - anchor_start
    if anchor_span <= 0:
        selected = sorted(
            candidates,
            key=lambda candidate: (-_structural_salience(candidate), candidate.end),
        )[:cap]
        return sorted(selected, key=lambda candidate: (candidate.start, candidate.end))

    buckets: list[list[_ProvisionalCandidate]] = [[] for _ in range(cap)]
    for candidate in candidates:
        bucket_index = min(
            cap - 1,
            int((candidate.start - anchor_start) * cap / anchor_span),
        )
        buckets[bucket_index].append(candidate)

    selected: list[_ProvisionalCandidate] = []
    for bucket_index, bucket in enumerate(buckets):
        if not bucket:
            continue
        bucket_center = anchor_start + (bucket_index + 0.5) * anchor_span / cap
        selected.append(
            min(
                bucket,
                key=lambda candidate: (
                    -_structural_salience(candidate),
                    abs(candidate.start - bucket_center),
                    candidate.start,
                    candidate.end,
                ),
            )
        )

    if len(selected) < cap:
        selected_set = set(selected)
        remaining = sorted(
            (candidate for candidate in candidates if candidate not in selected_set),
            key=lambda candidate: (
                -_structural_salience(candidate),
                candidate.start,
                candidate.end,
            ),
        )
        selected.extend(remaining[: cap - len(selected)])

    return sorted(selected, key=lambda candidate: (candidate.start, candidate.end))


def generate_candidates(
    segments: list[TranscriptSegment],
    profile: ClipProfile,
    *,
    variants_per_anchor: int = 4,
    max_candidates: int = 200,
    pause_threshold: float = 1.0,
) -> list[BoundaryCandidate]:
    """Generate bounded interval variants using only whole transcript segments."""
    minimum, maximum = profile_duration_bounds(profile)
    if not isinstance(segments, list) or any(
        not isinstance(segment, TranscriptSegment) for segment in segments
    ):
        raise TypeError("segments must be a list of TranscriptSegment values")
    for previous, following in pairwise(segments):
        if following.start < previous.end:
            raise ValueError("segments must be chronological and non-overlapping")
    for name, value in (
        ("variants_per_anchor", variants_per_anchor),
        ("max_candidates", max_candidates),
    ):
        if not isinstance(value, int) or isinstance(value, bool):
            raise TypeError(f"{name} must be an integer")
        if value <= 0:
            raise ValueError(f"{name} must be positive")
    if not isinstance(pause_threshold, Real) or isinstance(pause_threshold, bool):
        raise TypeError("pause_threshold must be a number")
    if not math.isfinite(pause_threshold) or pause_threshold < 0:
        raise ValueError("pause_threshold must be finite and non-negative")

    candidates: list[_ProvisionalCandidate] = []
    ends = [segment.end for segment in segments]
    boundary_kinds = [
        _boundary_kinds(segments, position, pause_threshold)
        for position in range(len(segments) + 1)
    ]
    structural_end_indices = [
        position - 1
        for position, kinds in enumerate(boundary_kinds[1:], start=1)
        if kinds not in (("segment",), ("transcript-edge",))
    ]

    for start_index, first in enumerate(segments):
        eligible_range = _eligible_end_range(
            ends, start_index, first.start, minimum, maximum
        )
        if eligible_range is not None:
            first_eligible, last_eligible = eligible_range
            preferred_start = bisect_left(structural_end_indices, first_eligible)
            preferred_stop = bisect_right(structural_end_indices, last_eligible)
            preferred = structural_end_indices[
                preferred_start : min(
                    preferred_stop, preferred_start + variants_per_anchor
                )
            ]
            for end_index in _variant_indices(
                first_eligible, last_eligible, variants_per_anchor, preferred
            ):
                last = segments[end_index]
                candidates.append(
                    _ProvisionalCandidate(
                        start_index,
                        end_index,
                        first.start,
                        last.end,
                        boundary_kinds[start_index],
                        boundary_kinds[end_index + 1],
                    )
                )
    if not candidates:
        return []
    selected = _globally_select(candidates, max_candidates)
    return [
        BoundaryCandidate(
            candidate.start_index,
            candidate.end_index,
            candidate.start,
            candidate.end,
            " ".join(
                segment.text.strip()
                for segment in segments[candidate.start_index : candidate.end_index + 1]
            ),
            candidate.start_boundary_kinds,
            candidate.end_boundary_kinds,
        )
        for candidate in selected
    ]
