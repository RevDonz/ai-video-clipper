"""Shared Selection V3 value objects exchanged by the LLM, heuristic, and render stages."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from numbers import Real
from types import MappingProxyType

SELECTION_V3_VERSION = "selection-v3.0"
SELECTION_SOURCES = frozenset({"llm", "heuristic"})
SELECTION_STATUSES = frozenset({"completed", "fallback"})
SCORE_DIMENSIONS = ("hook", "standalone", "payoff", "emotion", "shareability")
ARCHETYPES = frozenset(
    {
        "curiosity_gap",
        "controversial_claim",
        "confession",
        "insider_secret",
        "story_twist",
        "number_proof",
        "conflict",
        "humor",
        "relatable_pain",
        "emotional",
        "practical_tip",
        "other",
    }
)
MAX_TITLE_CHARS = 100
MAX_HOOK_TEXT_CHARS = 90
MAX_DESCRIPTION_CHARS = 600
MAX_REASON_CHARS = 300
MAX_HASHTAGS = 10


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _finite(value: object, name: str) -> float:
    if not _is_number(value):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _score(value: object, name: str) -> float:
    result = _finite(value, name)
    if not 0.0 <= result <= 10.0:
        raise ValueError(f"{name} must be between 0 and 10")
    return result


def _text(value: object, name: str, maximum: int, *, empty: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if not empty and not value.strip():
        raise ValueError(f"{name} cannot be empty")
    if len(value) > maximum:
        raise ValueError(f"{name} must be at most {maximum} characters")
    if any(ord(character) < 32 and character not in "\n\t" for character in value):
        raise ValueError(f"{name} contains control characters")
    return value


def _index(value: object, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value < 0:
        raise ValueError(f"{name} must be non-negative")
    return value


def _scores(value: object) -> Mapping[str, float]:
    if not isinstance(value, Mapping):
        raise TypeError("scores must be a mapping")
    if set(value) != set(SCORE_DIMENSIONS):
        raise ValueError(f"scores must contain exactly {', '.join(SCORE_DIMENSIONS)}")
    return MappingProxyType({name: _score(value[name], f"scores.{name}") for name in SCORE_DIMENSIONS})


def _strings(value: object, name: str, maximum_items: int, maximum_chars: int) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{name} must be a tuple")
    if len(value) > maximum_items:
        raise ValueError(f"{name} must contain at most {maximum_items} items")
    return tuple(_text(item, f"{name} item", maximum_chars) for item in value)


def _common_packaging(item: ClipProposal | SelectedClip) -> None:
    if item.archetype not in ARCHETYPES:
        raise ValueError(f"unknown archetype: {item.archetype}")
    _text(item.title, "title", MAX_TITLE_CHARS)
    _text(item.hook_text, "hook_text", MAX_HOOK_TEXT_CHARS)
    _text(item.description, "description", MAX_DESCRIPTION_CHARS, empty=True)
    _strings(item.hashtags, "hashtags", MAX_HASHTAGS, 40)
    _strings(item.reasons, "reasons", 8, MAX_REASON_CHARS)
    object.__setattr__(item, "scores", _scores(item.scores))
    object.__setattr__(item, "score", _score(item.score, "score"))
    if item.source not in SELECTION_SOURCES:
        raise ValueError("source must be llm or heuristic")


@dataclass(frozen=True, slots=True)
class ClipProposal:
    """A moment expressed in sentence-unit indices, before boundary snapping."""

    start_unit: int
    end_unit: int
    hook_unit: int
    payoff_unit: int | None
    archetype: str
    title: str
    hook_text: str
    description: str
    hashtags: tuple[str, ...]
    reasons: tuple[str, ...]
    scores: Mapping[str, float]
    score: float
    source: str

    def __post_init__(self) -> None:
        start = _index(self.start_unit, "start_unit")
        end = _index(self.end_unit, "end_unit")
        hook = _index(self.hook_unit, "hook_unit")
        if end < start:
            raise ValueError("end_unit must not precede start_unit")
        if not start <= hook <= end:
            raise ValueError("hook_unit must lie inside the proposal")
        if self.payoff_unit is not None:
            payoff = _index(self.payoff_unit, "payoff_unit")
            if not start <= payoff <= end:
                raise ValueError("payoff_unit must lie inside the proposal")
        _common_packaging(self)


@dataclass(frozen=True, slots=True)
class SelectedClip:
    """A final, snapped clip in source seconds with everything needed to render and post."""

    rank: int
    start: float
    end: float
    cold_open: tuple[float, float] | None
    unit_ids: tuple[str, str]
    hook_unit_id: str
    title: str
    hook_text: str
    description: str
    hashtags: tuple[str, ...]
    archetype: str
    score: float
    scores: Mapping[str, float]
    reasons: tuple[str, ...]
    source: str
    text: str

    def __post_init__(self) -> None:
        if not isinstance(self.rank, int) or isinstance(self.rank, bool) or self.rank <= 0:
            raise ValueError("rank must be a positive integer")
        start = _finite(self.start, "start")
        end = _finite(self.end, "end")
        if start < 0 or end <= start:
            raise ValueError("clip must satisfy 0 <= start < end")
        object.__setattr__(self, "start", start)
        object.__setattr__(self, "end", end)
        if self.cold_open is not None:
            if not isinstance(self.cold_open, tuple) or len(self.cold_open) != 2:
                raise TypeError("cold_open must be a (start, end) tuple")
            teaser_start = _finite(self.cold_open[0], "cold_open start")
            teaser_end = _finite(self.cold_open[1], "cold_open end")
            if teaser_start < 0 or teaser_end <= teaser_start:
                raise ValueError("cold_open must satisfy 0 <= start < end")
            object.__setattr__(self, "cold_open", (teaser_start, teaser_end))
        if (
            not isinstance(self.unit_ids, tuple)
            or len(self.unit_ids) != 2
            or not all(isinstance(item, str) and item for item in self.unit_ids)
        ):
            raise TypeError("unit_ids must be a (first, last) tuple of unit IDs")
        if not isinstance(self.hook_unit_id, str) or not self.hook_unit_id:
            raise TypeError("hook_unit_id must be a non-empty string")
        _text(self.text, "text", 200_000)
        _common_packaging(self)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict[str, object]:
        return {
            "rank": self.rank,
            "start": self.start,
            "end": self.end,
            "cold_open": None
            if self.cold_open is None
            else {"start": self.cold_open[0], "end": self.cold_open[1]},
            "unit_ids": list(self.unit_ids),
            "hook_unit_id": self.hook_unit_id,
            "title": self.title,
            "hook_text": self.hook_text,
            "description": self.description,
            "hashtags": list(self.hashtags),
            "archetype": self.archetype,
            "score": self.score,
            "scores": dict(self.scores),
            "reasons": list(self.reasons),
            "source": self.source,
            "text": self.text,
        }


@dataclass(frozen=True, slots=True)
class SelectionResult:
    """The outcome of one V3 selection run, including provenance for the artifact."""

    clips: tuple[SelectedClip, ...]
    source: str
    status: str
    provider: str | None
    model: str | None
    prompt_version: str
    warnings: tuple[str, ...] = ()
    usage: Mapping[str, int] = field(default_factory=dict)
    selection_version: str = SELECTION_V3_VERSION

    def __post_init__(self) -> None:
        if not isinstance(self.clips, tuple) or any(
            not isinstance(item, SelectedClip) for item in self.clips
        ):
            raise TypeError("clips must be a tuple of SelectedClip values")
        if [item.rank for item in self.clips] != list(range(1, len(self.clips) + 1)):
            raise ValueError("clip ranks must be contiguous from 1 in rank order")
        if self.source not in SELECTION_SOURCES:
            raise ValueError("source must be llm or heuristic")
        if self.status not in SELECTION_STATUSES:
            raise ValueError("status must be completed or fallback")
        if self.status == "fallback" and self.source != "heuristic":
            raise ValueError("a fallback selection must come from the heuristic")
        for name in ("provider", "model"):
            value = getattr(self, name)
            if value is not None:
                _text(value, name, 200)
        _text(self.prompt_version, "prompt_version", 64)
        _strings(self.warnings, "warnings", 200, 200)
        if not isinstance(self.usage, Mapping) or any(
            not isinstance(key, str)
            or not isinstance(value, int)
            or isinstance(value, bool)
            or value < 0
            for key, value in self.usage.items()
        ):
            raise TypeError("usage must map strings to non-negative integers")
        object.__setattr__(self, "usage", MappingProxyType(dict(self.usage)))
        if self.selection_version != SELECTION_V3_VERSION:
            raise ValueError(f"selection_version must be {SELECTION_V3_VERSION}")

    def to_dict(self) -> dict[str, object]:
        return {
            "selection_version": self.selection_version,
            "source": self.source,
            "status": self.status,
            "provider": self.provider,
            "model": self.model,
            "prompt_version": self.prompt_version,
            "warnings": list(self.warnings),
            "usage": dict(self.usage),
            "clips": [item.to_dict() for item in self.clips],
        }
