"""Data models for the clipping spike."""

import math
import re
from dataclasses import dataclass, fields
from enum import Enum
from numbers import Real


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start: float
    end: float
    text: str

    def __post_init__(self) -> None:
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError("segment timestamps must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("segment timestamps must satisfy 0 <= start < end")
        if not self.text.strip():
            raise ValueError("segment text cannot be empty")


@dataclass(frozen=True, slots=True)
class Highlight:
    start: float
    end: float
    text: str
    score: float

    def __post_init__(self) -> None:
        if not all(math.isfinite(value) for value in (self.start, self.end, self.score)):
            raise ValueError("highlight timestamps and score must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("highlight timestamps must satisfy 0 <= start < end")


@dataclass(frozen=True, slots=True)
class Transcription:
    language: str
    segments: list[TranscriptSegment]


class ClipProfile(str, Enum):
    """Editorial duration intent used by candidate generation and ranking."""

    VIRAL_SHORT = "viral-short"
    STANDARD = "standard"
    DEEP_DIVE = "deep-dive"


@dataclass(frozen=True, slots=True)
class CandidateFeatures:
    """Explainable 0–10 dimensions used to rank a clip candidate."""

    hook_strength: float
    hook_relevance: float
    standalone_context: float
    payoff_completeness: float
    information_density: float
    emotion_energy: float
    dialogue_dynamics: float
    visual_activity: float
    topic_value: float
    boundary_quality: float
    penalty: float = 0.0

    def __post_init__(self) -> None:
        for model_field in fields(self):
            value = getattr(self, model_field.name)
            if not _is_number(value):
                raise TypeError(f"{model_field.name} must be a number")
            if not math.isfinite(value) or not 0.0 <= value <= 10.0:
                raise ValueError(f"{model_field.name} must be finite and between 0 and 10")

    def to_dict(self) -> dict[str, float]:
        return {model_field.name: getattr(self, model_field.name) for model_field in fields(self)}

    @classmethod
    def from_dict(cls, payload: object) -> "CandidateFeatures":
        if type(payload) is not dict:
            raise TypeError("candidate features payload must be an object")
        expected = {model_field.name for model_field in fields(cls)}
        if set(payload) != expected:
            raise ValueError("candidate features payload has missing or unknown fields")
        return cls(**payload)


@dataclass(frozen=True, slots=True)
class ClipCandidate:
    """One editable and explainable candidate interval."""

    candidate_id: str
    start: float
    end: float
    text: str
    profile: ClipProfile
    features: CandidateFeatures
    score: float
    reasons: tuple[str, ...]
    topic_terms: tuple[str, ...] = ()
    rank: int | None = None
    display_order: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str):
            raise TypeError("candidate ID must be a string")
        if not self.candidate_id.strip():
            raise ValueError("candidate ID cannot be empty")
        if not _is_number(self.start) or not _is_number(self.end):
            raise TypeError("candidate timestamps must be numbers")
        if not math.isfinite(self.start) or not math.isfinite(self.end):
            raise ValueError("candidate timestamps must be finite")
        if self.start < 0 or self.end <= self.start:
            raise ValueError("candidate timestamps must satisfy 0 <= start < end")
        if not isinstance(self.text, str):
            raise TypeError("candidate text must be a string")
        if not self.text.strip():
            raise ValueError("candidate text cannot be empty")
        if not isinstance(self.profile, ClipProfile):
            raise TypeError("candidate profile must be a ClipProfile")
        if not isinstance(self.features, CandidateFeatures):
            raise TypeError("candidate features must be CandidateFeatures")
        if not _is_number(self.score):
            raise TypeError("candidate score must be a number")
        if not math.isfinite(self.score) or not 0.0 <= self.score <= 10.0:
            raise ValueError("candidate score must be finite and between 0 and 10")
        if not isinstance(self.reasons, tuple):
            raise TypeError("candidate reasons must be an immutable tuple")
        if not self.reasons or any(
            not isinstance(reason, str) or not reason.strip() for reason in self.reasons
        ):
            raise ValueError("candidate must contain at least one non-empty reason")
        if not isinstance(self.topic_terms, tuple):
            raise TypeError("candidate topic terms must be an immutable tuple")
        if any(not isinstance(term, str) or not term.strip() for term in self.topic_terms):
            raise ValueError("candidate topic terms must be non-empty strings")
        if self.rank is not None and (
            not isinstance(self.rank, int) or isinstance(self.rank, bool)
        ):
            raise TypeError("candidate rank must be an integer")
        if self.rank is not None and self.rank <= 0:
            raise ValueError("candidate rank must be positive")
        if self.display_order is not None and (
            not isinstance(self.display_order, int) or isinstance(self.display_order, bool)
        ):
            raise TypeError("candidate display order must be an integer")
        if self.display_order is not None and self.display_order <= 0:
            raise ValueError("candidate display order must be positive")

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "profile": self.profile.value,
            "features": self.features.to_dict(),
            "score": self.score,
            "reasons": list(self.reasons),
            "topic_terms": list(self.topic_terms),
            "rank": self.rank,
            "display_order": self.display_order,
        }

    @classmethod
    def from_dict(cls, payload: object) -> "ClipCandidate":
        if type(payload) is not dict:
            raise TypeError("candidate payload must be an object")
        expected = {
            "candidate_id",
            "start",
            "end",
            "text",
            "profile",
            "features",
            "score",
            "reasons",
            "topic_terms",
            "rank",
            "display_order",
        }
        if set(payload) != expected:
            raise ValueError("candidate payload has missing or unknown fields")
        if not isinstance(payload["reasons"], list) or not isinstance(
            payload["topic_terms"], list
        ):
            raise TypeError("candidate JSON reasons and topic_terms must be arrays")
        if not isinstance(payload["profile"], str):
            raise TypeError("candidate JSON profile must be a string")
        return cls(
            candidate_id=payload["candidate_id"],
            start=payload["start"],
            end=payload["end"],
            text=payload["text"],
            profile=ClipProfile(payload["profile"]),
            features=CandidateFeatures.from_dict(payload["features"]),
            score=payload["score"],
            reasons=tuple(payload["reasons"]),
            topic_terms=tuple(payload["topic_terms"]),
            rank=payload["rank"],
            display_order=payload["display_order"],
        )


_CAPTION_PRESETS = {"clean", "bold-keyword", "karaoke", "podcast", "minimal"}
_CAPTION_POSITIONS = {"upper", "middle", "lower-middle", "lower"}
_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


@dataclass(frozen=True, slots=True)
class CaptionStyle:
    """Version-independent caption controls shared by preview and final render."""

    preset: str = "clean"
    position: str = "lower-middle"
    base_color: str = "#FFFFFF"
    keyword_color: str = "#DFFF58"
    max_words: int = 5
    max_lines: int = 2

    def __post_init__(self) -> None:
        if self.preset not in _CAPTION_PRESETS:
            raise ValueError(f"unknown caption preset: {self.preset}")
        if self.position not in _CAPTION_POSITIONS:
            raise ValueError(f"unknown caption position: {self.position}")
        if not _HEX_COLOR.fullmatch(self.base_color) or not _HEX_COLOR.fullmatch(
            self.keyword_color
        ):
            raise ValueError("caption color must use #RRGGBB format")
        if not isinstance(self.max_words, int) or isinstance(self.max_words, bool):
            raise TypeError("caption max_words must be an integer")
        if not 1 <= self.max_words <= 20:
            raise ValueError("caption max_words must be between 1 and 20")
        if not isinstance(self.max_lines, int) or isinstance(self.max_lines, bool):
            raise TypeError("caption max_lines must be an integer")
        if not 1 <= self.max_lines <= 3:
            raise ValueError("caption max_lines must be between 1 and 3")
