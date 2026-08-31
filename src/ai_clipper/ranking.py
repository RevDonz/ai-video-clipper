"""Standalone Task 5 ranking and audit artifacts.

Artifact paths must live in a trusted, job-owned output directory. Atomic replacement
ensures concurrent readers observe either the old or new complete one-file artifact;
it is not a sandbox against a hostile parent directory. Pipeline wiring is deferred
to Task 6.
"""

from __future__ import annotations

import errno
import hashlib
import heapq
import ipaddress
import json
import math
import os
import re
import stat
import tempfile
import threading
import unicodedata
from bisect import bisect_left, bisect_right
from contextlib import contextmanager
from dataclasses import dataclass, fields, replace
from decimal import Decimal
from numbers import Real
from pathlib import Path
from typing import Literal
from urllib.parse import quote, unquote_to_bytes, urlencode, urlsplit, urlunsplit

from .candidates import BoundaryCandidate
from .features import FeatureExtractionResult
from .media_features import MediaFeatureAnalysis
from .models import ClipCandidate, ClipProfile

try:
    import fcntl
except ImportError:  # pragma: no cover - production artifact publication is POSIX-only
    fcntl = None  # type: ignore[assignment]

SELECTION_VERSION = "selection-v2.0"
MAX_RANKING_INPUTS = 5000
MAX_ARTIFACT_CANDIDATES = 5000
# Artifact readers reject larger files before allocating a JSON tree.
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
_MAX_PARAMETER_NAME_DECODE_DEPTH = 3
_FALLBACK_REASON = "Tidak ada pola positif tambahan; skor berasal dari baseline terukur."
_TEXT_DIMENSIONS = (
    "hook_strength",
    "hook_relevance",
    "standalone_context",
    "payoff_completeness",
    "information_density",
    "topic_value",
    "boundary_quality",
)
_MEDIA_DIMENSIONS = {
    "audio_energy": "audio_energy",
    "audio_energy_change": "energy_change",
    "scene_activity": "scene_activity",
    "motion": "motion",
    "face_activity": "face_activity",
}
_NUMERIC_CONFIG_FIELDS = (
    *_TEXT_DIMENSIONS,
    *_MEDIA_DIMENSIONS,
    "penalty",
    "overlap_threshold",
    "diversity_strength",
)
_SENSITIVE_QUERY_NAMES = frozenset(
    {
        "token",
        "accesstoken",
        "idtoken",
        "refreshtoken",
        "apikey",
        "auth",
        "authorization",
        "credential",
        "password",
        "passwd",
        "secret",
        "signature",
        "sig",
        "xamzsignature",
        "xamzcredential",
        "xamzsecuritytoken",
        "xgoogsignature",
        "xgoogcredential",
        "awsaccesskeyid",
        "policy",
    }
)
_PROHIBITED_REASON_CLAIM = re.compile(
    r"\b(?:viral(?:ity|itas)?|guarantee(?:d|s|ing)?|probab(?:le|ly|ility)|probabilitas|certainty|pasti)\b",
    re.IGNORECASE,
)
_INVALID_PERCENT_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")
_EMBEDDED_MEDIA_SOURCE = re.compile(
    r"(?:data:|(?:audio|video|image)/[a-z0-9.+-]+(?:;[^,]*)?;base64,)",
    re.IGNORECASE,
)
_REASON_TEMPLATES = {
    "hook.direct_question": "Hook berbentuk pertanyaan langsung.",
    "hook.bold_claim": "Hook memuat pola klaim tegas atau kontradiksi literal.",
    "hook.attributed_numeric_claim": "Hook memuat atribusi peran pada angka.",
    "hook.pain_point": "Hook memuat kata masalah atau kesulitan.",
    "hook.open_loop": "Hook memuat pola open loop literal.",
    "relevance.topic_overlap": "Istilah hook muncul kembali pada bagian lanjutan.",
    "relevance.answer_resolution": "Bagian lanjutan memuat pola jawaban yang terkait dengan hook.",
    "context.pronoun_led": "Pembukaan menggunakan rujukan anaforis tanpa konteks mandiri.",
    "context.pronoun_led_penalty": "Rujukan anaforis pada pembukaan menambah penalti.",
    "payoff.answer_marker": "Bagian lanjutan memuat penanda jawaban literal.",
    "payoff.complete_answer": "Jawaban memiliki penutup terminal dan istilah terkait.",
    "density.repetition_filler": "Teks memuat pola filler atau pengulangan.",
    "density.repetition_filler_penalty": "Pola filler atau pengulangan menambah penalti.",
    "penalty.intro": "Pembukaan memuat pola intro literal.",
    "penalty.outro": "Teks memuat pola outro literal.",
    "penalty.sponsor_first": "Klip dimulai dengan pola penyebutan sponsor.",
    "boundary.structured_start": "Awal klip bertepatan dengan batas terstruktur.",
    "boundary.structured_end": "Akhir klip bertepatan dengan batas terstruktur.",
    "boundary.terminal": "Teks kandidat berakhir dengan tanda baca terminal.",
    "topic.extracted_terms": "Teks memuat istilah topik nonfungsi.",
}
_MEDIA_REASON_TEMPLATES = {
    name: f"Pengukuran {name} aktif dengan nilai {{value:.3f}}/10." for name in _MEDIA_DIMENSIONS
}

_candidate_lock_threads = threading.RLock()
_candidate_lock_local = threading.local()
_candidate_lock_fds: set[int] = set()


def _acquire_candidate_locks_before_fork() -> None:
    _candidate_lock_threads.acquire()


def _release_candidate_locks_after_fork_in_parent() -> None:
    _candidate_lock_threads.release()


def _reset_candidate_locks_after_fork() -> None:
    global _candidate_lock_threads, _candidate_lock_local, _candidate_lock_fds
    try:
        for fd in tuple(_candidate_lock_fds):
            try:
                os.close(fd)
            except OSError as error:
                if error.errno != errno.EBADF:
                    raise
    finally:
        _candidate_lock_threads = threading.RLock()
        _candidate_lock_local = threading.local()
        _candidate_lock_fds = set()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(
        before=_acquire_candidate_locks_before_fork,
        after_in_parent=_release_candidate_locks_after_fork_in_parent,
        after_in_child=_reset_candidate_locks_after_fork,
    )


@contextmanager
def candidate_artifact_lock(analysis_dir: str | Path, *, exclusive: bool):
    """Lock candidate publication across threads/processes using a regular lock file."""
    if fcntl is None:  # pragma: no cover
        raise RuntimeError("candidate artifact locking requires fcntl")
    lock_path = Path(analysis_dir) / ".candidates.v2.lock"
    with _candidate_lock_threads:
        states = getattr(_candidate_lock_local, "states", None)
        if states is None:
            states = {}
            _candidate_lock_local.states = states
        key = os.fspath(lock_path.absolute())
        state = states.get(key)
        if state is None:
            flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            try:
                fd = os.open(lock_path, flags, 0o600)
            except OSError as error:
                raise ValueError("candidate lock must be a regular file") from error
            _candidate_lock_fds.add(fd)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ValueError("candidate lock must be a regular file")
                modes = [exclusive]
                fcntl.flock(fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            except BaseException:
                try:
                    os.close(fd)
                finally:
                    _candidate_lock_fds.discard(fd)
                raise
            state = {"fd": fd, "modes": modes, "owner_pid": os.getpid()}
            states[key] = state
        else:
            modes = state["modes"]
            modes.append(exclusive)
            if exclusive and not any(modes[:-1]):
                fcntl.flock(state["fd"], fcntl.LOCK_EX)
        try:
            yield
        finally:
            if state["owner_pid"] == os.getpid():
                modes = state["modes"]
                modes.pop()
                if modes:
                    desired = fcntl.LOCK_EX if any(modes) else fcntl.LOCK_SH
                    fcntl.flock(state["fd"], desired)
                else:
                    try:
                        fcntl.flock(state["fd"], fcntl.LOCK_UN)
                    finally:
                        try:
                            os.close(state["fd"])
                        finally:
                            _candidate_lock_fds.discard(state["fd"])
                            del states[key]


def _finite_nonnegative(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError(f"{name} must be finite and non-negative")
    return result


@dataclass(frozen=True, slots=True)
class WeightConfig:
    """Immutable selection-v2.0 weights and diversity policy."""

    hook_strength: float = 1.4
    hook_relevance: float = 1.2
    standalone_context: float = 1.1
    payoff_completeness: float = 1.4
    information_density: float = 1.0
    topic_value: float = 0.8
    boundary_quality: float = 1.1
    audio_energy: float = 0.5
    audio_energy_change: float = 0.4
    scene_activity: float = 0.3
    motion: float = 0.3
    face_activity: float = 0.2
    penalty: float = 0.6
    overlap_threshold: float = 0.0
    overlap_metric: Literal["iou", "overlap_ratio"] = "overlap_ratio"
    diversity_strength: float = 0.3
    version: str = SELECTION_VERSION

    def __post_init__(self) -> None:
        for name in _NUMERIC_CONFIG_FIELDS:
            object.__setattr__(self, name, _finite_nonnegative(getattr(self, name), name))
        if self.version != SELECTION_VERSION:
            raise ValueError(f"version must be exactly {SELECTION_VERSION}")
        if self.overlap_metric not in ("iou", "overlap_ratio"):
            raise ValueError("overlap_metric must be iou or overlap_ratio")
        if self.overlap_threshold > 1:
            raise ValueError("overlap_threshold must be between 0 and 1")
        if self.diversity_strength > 1:
            raise ValueError("diversity_strength must be between 0 and 1")
        if sum(getattr(self, name) for name in (*_TEXT_DIMENSIONS, *_MEDIA_DIMENSIONS)) <= 0:
            raise ValueError("config requires a positive usable weight total")

    def to_dict(self) -> dict[str, object]:
        return {model_field.name: getattr(self, model_field.name) for model_field in fields(self)}

    @classmethod
    def from_dict(cls, payload: object) -> WeightConfig:
        if type(payload) is not dict:
            raise TypeError("weight config payload must be an object")
        expected = {model_field.name for model_field in fields(cls)}
        if set(payload) != expected:
            raise ValueError("weight config payload has missing or unknown fields")
        return cls(**payload)


def _nonempty_text(value: object, name: str, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value


def _optional_measurement(value: object, name: str) -> float | None:
    if value is None:
        return None
    result = _finite_nonnegative(value, name)
    if result > 10:
        raise ValueError(f"{name} must be at most 10")
    return result


@dataclass(frozen=True, slots=True)
class MediaEvidenceSnapshot:
    """Immutable, standalone evidence actually available to Task 5 ranking."""

    analyzer_version: str
    analysis_id: str | None
    source: str
    interval_start: float
    interval_end: float
    audio_energy: float | None = None
    energy_change: float | None = None
    scene_activity: float | None = None
    motion: float | None = None
    face_activity: float | None = None

    def __post_init__(self) -> None:
        _nonempty_text(self.analyzer_version, "analyzer_version")
        _nonempty_text(self.analysis_id, "analysis_id", optional=True)
        _validate_source(self.source)
        start = _finite_nonnegative(self.interval_start, "interval_start")
        end = _finite_nonnegative(self.interval_end, "interval_end")
        if end <= start:
            raise ValueError("media interval must satisfy 0 <= start < end")
        object.__setattr__(self, "interval_start", start)
        object.__setattr__(self, "interval_end", end)
        for name in (
            "audio_energy",
            "energy_change",
            "scene_activity",
            "motion",
            "face_activity",
        ):
            object.__setattr__(self, name, _optional_measurement(getattr(self, name), name))

    def to_dict(self) -> dict[str, object]:
        return {model_field.name: getattr(self, model_field.name) for model_field in fields(self)}

    @classmethod
    def from_dict(cls, payload: object) -> MediaEvidenceSnapshot:
        if type(payload) is not dict:
            raise TypeError("media evidence snapshot payload must be an object")
        expected = {model_field.name for model_field in fields(cls)}
        if set(payload) != expected:
            raise ValueError("media evidence snapshot has missing or unknown fields")
        return cls(**payload)


@dataclass(frozen=True, slots=True)
class RankingMediaSignals:
    """Strict caller-facing Task 5 signals adapted from Task 4 when requested."""

    analyzer_version: str
    analysis_id: str | None
    source: str
    interval_start: float
    interval_end: float
    audio_energy: float | None = None
    energy_change: float | None = None
    scene_activity: float | None = None
    motion: float | None = None
    face_activity: float | None = None

    def __post_init__(self) -> None:
        snapshot = self.to_snapshot()
        for model_field in fields(self):
            object.__setattr__(self, model_field.name, getattr(snapshot, model_field.name))

    def to_snapshot(self) -> MediaEvidenceSnapshot:
        return MediaEvidenceSnapshot(
            self.analyzer_version,
            self.analysis_id,
            self.source,
            self.interval_start,
            self.interval_end,
            self.audio_energy,
            self.energy_change,
            self.scene_activity,
            self.motion,
            self.face_activity,
        )

    @classmethod
    def from_media_analysis(cls, analysis: MediaFeatureAnalysis) -> RankingMediaSignals:
        """Map typed Task 4 evidence without inferring unavailable measurements."""
        if not isinstance(analysis, MediaFeatureAnalysis):
            raise TypeError("analysis must be a MediaFeatureAnalysis")
        return cls(
            analyzer_version=analysis.analyzer_version,
            analysis_id=analysis.analysis_id,
            source=_canonical_source(analysis.source),
            interval_start=analysis.window_start,
            interval_end=analysis.window_end,
            audio_energy=analysis.audio.energy_score,
            energy_change=analysis.audio.energy_change_score,
            scene_activity=analysis.visual.scene_activity_score,
            motion=analysis.visual.motion_score,
            face_activity=analysis.visual.face_activity_score,
        )


@dataclass(frozen=True, slots=True)
class ScoreContribution:
    """One strictly typed, reconstructable weighted score contribution."""

    name: str
    value: float
    weight: float
    weighted_value: float
    source: Literal["text", "media"]

    def __post_init__(self) -> None:
        allowed = _TEXT_DIMENSIONS if self.source == "text" else tuple(_MEDIA_DIMENSIONS)
        if self.source not in ("text", "media"):
            raise ValueError("contribution source must be text or media")
        if self.name not in allowed:
            raise ValueError("contribution name is unknown for its source")
        value = _finite_nonnegative(self.value, "contribution value")
        weight = _finite_nonnegative(self.weight, "contribution weight")
        weighted_value = _finite_nonnegative(self.weighted_value, "contribution weighted_value")
        if value > 10:
            raise ValueError("contribution value must be at most 10")
        if weight <= 0:
            raise ValueError("contribution weight must be positive")
        if not math.isclose(weighted_value, value * weight, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError("contribution weighted_value does not match value * weight")
        object.__setattr__(self, "value", value)
        object.__setattr__(self, "weight", weight)
        object.__setattr__(self, "weighted_value", weighted_value)

    def to_dict(self) -> dict[str, object]:
        return {model_field.name: getattr(self, model_field.name) for model_field in fields(self)}

    @classmethod
    def from_dict(cls, payload: object) -> ScoreContribution:
        if type(payload) is not dict:
            raise TypeError("score contribution payload must be an object")
        expected = {model_field.name for model_field in fields(cls)}
        if set(payload) != expected:
            raise ValueError("score contribution payload has missing or unknown fields")
        return cls(**payload)


@dataclass(frozen=True, slots=True)
class ScoreBreakdown:
    """Canonical score audit whose arithmetic must reconstruct exactly."""

    candidate_id: str
    selection_version: str
    contributions: tuple[ScoreContribution, ...]
    active_weight_total: float
    weighted_pre_penalty_score: float
    penalty_deduction: float
    diversity_deduction: float
    final_score: float
    media_evidence_sha256: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.candidate_id, str) or not self.candidate_id.strip():
            raise ValueError("breakdown candidate_id must be a non-empty string")
        if self.selection_version != SELECTION_VERSION:
            raise ValueError(f"breakdown selection_version must be exactly {SELECTION_VERSION}")
        if not isinstance(self.contributions, tuple) or any(
            not isinstance(item, ScoreContribution) for item in self.contributions
        ):
            raise TypeError("breakdown contributions must be a tuple of ScoreContribution values")
        names = [item.name for item in self.contributions]
        if len(set(names)) != len(names):
            raise ValueError("duplicate contribution names are not allowed")
        expected_order = [name for name in (*_TEXT_DIMENSIONS, *_MEDIA_DIMENSIONS) if name in names]
        if names != expected_order:
            raise ValueError("breakdown contributions are not in canonical dimension order")
        numeric_names = (
            "active_weight_total",
            "weighted_pre_penalty_score",
            "penalty_deduction",
            "diversity_deduction",
            "final_score",
        )
        for name in numeric_names:
            object.__setattr__(self, name, _finite_nonnegative(getattr(self, name), name))
        if self.final_score > 10:
            raise ValueError("final_score must be at most 10")
        expected_total = sum(item.weight for item in self.contributions)
        if expected_total <= 0 or not math.isclose(
            self.active_weight_total, expected_total, rel_tol=1e-12, abs_tol=1e-12
        ):
            raise ValueError("active_weight_total does not match contributions")
        expected_pre = sum(item.weighted_value for item in self.contributions) / expected_total
        if not math.isclose(
            self.weighted_pre_penalty_score, expected_pre, rel_tol=1e-12, abs_tol=1e-12
        ):
            raise ValueError("weighted_pre_penalty_score does not match contributions")
        expected_final = round(
            min(10.0, max(0.0, expected_pre - self.penalty_deduction - self.diversity_deduction)),
            6,
        )
        if self.final_score != expected_final:
            raise ValueError("final_score does not match score breakdown math")
        if self.media_evidence_sha256 is not None and (
            not isinstance(self.media_evidence_sha256, str)
            or not re.fullmatch(r"[0-9a-f]{64}", self.media_evidence_sha256)
        ):
            raise ValueError("media_evidence_sha256 must be a lowercase SHA-256 digest or None")

    def to_dict(self) -> dict[str, object]:
        return {
            "candidate_id": self.candidate_id,
            "selection_version": self.selection_version,
            "contributions": [item.to_dict() for item in self.contributions],
            "active_weight_total": self.active_weight_total,
            "weighted_pre_penalty_score": self.weighted_pre_penalty_score,
            "penalty_deduction": self.penalty_deduction,
            "diversity_deduction": self.diversity_deduction,
            "final_score": self.final_score,
            "media_evidence_sha256": self.media_evidence_sha256,
        }

    @classmethod
    def from_dict(cls, payload: object) -> ScoreBreakdown:
        if type(payload) is not dict:
            raise TypeError("score breakdown payload must be an object")
        expected = {model_field.name for model_field in fields(cls)}
        if set(payload) != expected:
            raise ValueError("score breakdown payload has missing or unknown fields")
        if type(payload["contributions"]) is not list:
            raise TypeError("score breakdown contributions must be an array")
        if len(payload["contributions"]) > len(_TEXT_DIMENSIONS) + len(_MEDIA_DIMENSIONS):
            raise ValueError("score breakdown has too many contributions")
        return cls(
            candidate_id=payload["candidate_id"],
            selection_version=payload["selection_version"],
            contributions=tuple(
                ScoreContribution.from_dict(item) for item in payload["contributions"]
            ),
            active_weight_total=payload["active_weight_total"],
            weighted_pre_penalty_score=payload["weighted_pre_penalty_score"],
            penalty_deduction=payload["penalty_deduction"],
            diversity_deduction=payload["diversity_deduction"],
            final_score=payload["final_score"],
            media_evidence_sha256=payload["media_evidence_sha256"],
        )


@dataclass(frozen=True, slots=True)
class RankedSelection:
    """Ranked candidates paired one-to-one with canonical score audits and media evidence."""

    candidates: tuple[ClipCandidate, ...]
    breakdowns: tuple[ScoreBreakdown, ...]
    media_snapshots: tuple[MediaEvidenceSnapshot | None, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.candidates, tuple) or any(
            not isinstance(item, ClipCandidate) for item in self.candidates
        ):
            raise TypeError("selection candidates must be a tuple of ClipCandidate values")
        if not isinstance(self.breakdowns, tuple) or any(
            not isinstance(item, ScoreBreakdown) for item in self.breakdowns
        ):
            raise TypeError("selection breakdowns must be a tuple of ScoreBreakdown values")
        if [item.candidate_id for item in self.candidates] != [
            item.candidate_id for item in self.breakdowns
        ]:
            raise ValueError("selection candidates and breakdowns must match in rank order")
        if not self.media_snapshots:
            object.__setattr__(self, "media_snapshots", (None,) * len(self.candidates))
        if len(self.media_snapshots) != len(self.candidates) or any(
            item is not None and not isinstance(item, MediaEvidenceSnapshot)
            for item in self.media_snapshots
        ):
            raise TypeError("selection media snapshots must align with candidates")


@dataclass(frozen=True, slots=True)
class RankedInput:
    """Strict binding between a source-scoped key, interval, and extracted evidence."""

    input_key: str
    candidate: BoundaryCandidate
    extraction: FeatureExtractionResult
    media: RankingMediaSignals | MediaFeatureAnalysis | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.input_key, str):
            raise TypeError("input_key must be a string")
        if not self.input_key.strip():
            raise ValueError("input_key cannot be empty")
        if not isinstance(self.candidate, BoundaryCandidate):
            raise TypeError("candidate must be a BoundaryCandidate")
        if any(
            not isinstance(value, int) or isinstance(value, bool)
            for value in (self.candidate.start_index, self.candidate.end_index)
        ):
            raise TypeError("candidate indices must be integers")
        if self.candidate.start_index < 0 or self.candidate.end_index < self.candidate.start_index:
            raise ValueError("candidate indices must be ordered and non-negative")
        if any(
            not isinstance(value, Real) or isinstance(value, bool)
            for value in (self.candidate.start, self.candidate.end)
        ):
            raise TypeError("candidate timestamps must be numbers")
        if (
            not math.isfinite(self.candidate.start)
            or not math.isfinite(self.candidate.end)
            or self.candidate.start < 0
            or self.candidate.end <= self.candidate.start
        ):
            raise ValueError("candidate timestamps must satisfy 0 <= start < end and be finite")
        if not isinstance(self.candidate.text, str) or not self.candidate.text.strip():
            raise ValueError("candidate text must be a non-empty string")
        for name in ("start_boundary_kinds", "end_boundary_kinds"):
            kinds = getattr(self.candidate, name)
            if not isinstance(kinds, tuple) or any(
                not isinstance(kind, str) or not kind.strip() for kind in kinds
            ):
                raise TypeError(f"candidate {name} must be a tuple of non-empty strings")
        if not isinstance(self.extraction, FeatureExtractionResult):
            raise TypeError("extraction must be a FeatureExtractionResult")
        canonical_terms = _canonical_topic_terms(self.extraction.topic_terms)
        if canonical_terms != self.extraction.topic_terms:
            object.__setattr__(
                self, "extraction", replace(self.extraction, topic_terms=canonical_terms)
            )
        if isinstance(self.media, MediaFeatureAnalysis):
            object.__setattr__(self, "media", RankingMediaSignals.from_media_analysis(self.media))
        if self.media is not None and not isinstance(self.media, RankingMediaSignals):
            raise TypeError("media must be RankingMediaSignals, MediaFeatureAnalysis, or None")


@dataclass(frozen=True, slots=True)
class CandidatesArtifact:
    selection_version: str
    source: str
    provenance: tuple[str, ...]
    weight_config: WeightConfig
    candidates: tuple[ClipCandidate, ...]
    breakdowns: tuple[ScoreBreakdown, ...]
    media_snapshots: tuple[MediaEvidenceSnapshot | None, ...] = ()

    def __post_init__(self) -> None:
        if self.selection_version != SELECTION_VERSION:
            raise ValueError(f"selection_version must be exactly {SELECTION_VERSION}")
        _validate_source(self.source)
        if (
            not isinstance(self.provenance, tuple)
            or not self.provenance
            or any(not isinstance(item, str) or not item.strip() for item in self.provenance)
        ):
            raise TypeError("provenance must be a tuple of non-empty strings")
        if not isinstance(self.weight_config, WeightConfig):
            raise TypeError("weight_config must be a WeightConfig")
        if not isinstance(self.candidates, tuple) or any(
            not isinstance(item, ClipCandidate) for item in self.candidates
        ):
            raise TypeError("candidates must be a tuple of ClipCandidate values")
        if not isinstance(self.breakdowns, tuple) or any(
            not isinstance(item, ScoreBreakdown) for item in self.breakdowns
        ):
            raise TypeError("breakdowns must be a tuple of ScoreBreakdown values")
        if len(self.candidates) > MAX_ARTIFACT_CANDIDATES:
            raise ValueError(f"artifact may contain at most {MAX_ARTIFACT_CANDIDATES} candidates")
        if not self.media_snapshots:
            object.__setattr__(self, "media_snapshots", (None,) * len(self.candidates))
        if len(self.media_snapshots) != len(self.candidates) or any(
            item is not None and not isinstance(item, MediaEvidenceSnapshot)
            for item in self.media_snapshots
        ):
            raise TypeError("artifact media snapshots must align with candidates")

        candidate_ids = [candidate.candidate_id for candidate in self.candidates]
        intervals = [(candidate.start, candidate.end) for candidate in self.candidates]
        if len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("artifact candidate IDs must be unique")
        if len(set(intervals)) != len(intervals):
            raise ValueError("artifact candidate intervals must be unique")
        _validate_artifact_overlaps(self.candidates, self.weight_config)
        for candidate in self.candidates:
            if candidate.topic_terms != _canonical_topic_terms(candidate.topic_terms):
                raise ValueError("artifact candidate topic terms are not canonical")
            expected_id = _derive_candidate_id(
                self.source,
                candidate.profile,
                self.selection_version,
                candidate.start,
                candidate.end,
            )
            if candidate.candidate_id != expected_id:
                raise ValueError("artifact candidate ID does not match its derived identity")
            if any(_has_prohibited_reason_claim(reason) for reason in candidate.reasons):
                raise ValueError("artifact candidate reason contains a prohibited claim")
        if [candidate.candidate_id for candidate in self.candidates] != [
            breakdown.candidate_id for breakdown in self.breakdowns
        ]:
            raise ValueError("artifact candidates and breakdowns must match in rank order")
        prior_candidates: list[ClipCandidate] = []
        for candidate, breakdown, snapshot in zip(
            self.candidates, self.breakdowns, self.media_snapshots, strict=True
        ):
            similarity = max(
                (
                    _topic_similarity(candidate.topic_terms, prior.topic_terms)
                    for prior in prior_candidates
                ),
                default=0.0,
            )
            expected_diversity = self.weight_config.diversity_strength * 10.0 * similarity
            _validate_breakdown_for_artifact(
                candidate,
                breakdown,
                snapshot,
                self.source,
                self.weight_config,
                expected_diversity,
            )
            prior_candidates.append(candidate)
        expected_order = list(range(1, len(self.candidates) + 1))
        if [candidate.rank for candidate in self.candidates] != expected_order:
            raise ValueError("artifact candidate ranks must be contiguous and in selection order")
        if sorted(candidate.display_order for candidate in self.candidates) != expected_order:
            raise ValueError("artifact candidate display orders must be contiguous")
        chronological = sorted(
            self.candidates,
            key=lambda candidate: (candidate.start, candidate.end, candidate.candidate_id),
        )
        chronological_orders = {
            candidate.candidate_id: index for index, candidate in enumerate(chronological, 1)
        }
        if any(
            candidate.display_order != chronological_orders[candidate.candidate_id]
            for candidate in self.candidates
        ):
            raise ValueError("artifact candidate display orders must be chronological")

    def to_dict(self) -> dict[str, object]:
        return {
            "selection_version": self.selection_version,
            "source": self.source,
            "provenance": list(self.provenance),
            "weight_config": self.weight_config.to_dict(),
            "candidates": [candidate.to_dict() for candidate in self.candidates],
            "breakdowns": [breakdown.to_dict() for breakdown in self.breakdowns],
            "media_snapshots": [
                None if snapshot is None else snapshot.to_dict()
                for snapshot in self.media_snapshots
            ],
        }

    @classmethod
    def from_dict(cls, payload: object) -> CandidatesArtifact:
        if type(payload) is not dict:
            raise TypeError("candidates artifact payload must be an object")
        expected = {
            "selection_version",
            "source",
            "provenance",
            "weight_config",
            "candidates",
            "breakdowns",
            "media_snapshots",
        }
        if set(payload) != expected:
            raise ValueError("candidates artifact payload has missing or unknown fields")
        if any(
            type(payload[name]) is not list
            for name in ("provenance", "candidates", "breakdowns", "media_snapshots")
        ):
            raise TypeError(
                "artifact provenance, candidates, breakdowns, and media snapshots must be arrays"
            )
        raw_lengths = tuple(
            len(payload[name]) for name in ("candidates", "breakdowns", "media_snapshots")
        )
        if any(length > MAX_ARTIFACT_CANDIDATES for length in raw_lengths):
            raise ValueError(f"artifact may contain at most {MAX_ARTIFACT_CANDIDATES} candidates")
        if len(set(raw_lengths)) != 1:
            raise ValueError(
                "artifact candidates, breakdowns, and media snapshots must have equal lengths"
            )
        return cls(
            selection_version=payload["selection_version"],
            source=payload["source"],
            provenance=tuple(payload["provenance"]),
            weight_config=WeightConfig.from_dict(payload["weight_config"]),
            candidates=tuple(ClipCandidate.from_dict(item) for item in payload["candidates"]),
            breakdowns=tuple(ScoreBreakdown.from_dict(item) for item in payload["breakdowns"]),
            media_snapshots=tuple(
                None if item is None else MediaEvidenceSnapshot.from_dict(item)
                for item in payload["media_snapshots"]
            ),
        )


def _validate_breakdown_for_artifact(
    candidate: ClipCandidate,
    breakdown: ScoreBreakdown,
    snapshot: MediaEvidenceSnapshot | None,
    artifact_source: str,
    config: WeightConfig,
    expected_diversity: float,
) -> None:
    if snapshot is not None and (
        _canonical_source(snapshot.source) != _canonical_source(artifact_source)
        or (snapshot.interval_start, snapshot.interval_end) != (candidate.start, candidate.end)
    ):
        raise ValueError("media snapshot source or interval does not match candidate binding")
    if breakdown.selection_version != config.version:
        raise ValueError("breakdown version does not match artifact config")
    if breakdown.final_score != candidate.score:
        raise ValueError("breakdown final score does not match candidate score")
    contributions = {item.name: item for item in breakdown.contributions}
    expected_text = {name for name in _TEXT_DIMENSIONS if getattr(config, name) > 0}
    actual_text = {item.name for item in breakdown.contributions if item.source == "text"}
    if actual_text != expected_text:
        raise ValueError("breakdown active text contributions do not match config")
    for name in expected_text:
        item = contributions[name]
        if item.weight != getattr(config, name) or item.value != getattr(candidate.features, name):
            raise ValueError("breakdown text contribution does not match candidate or config")
    for item in breakdown.contributions:
        if item.source == "media" and item.weight != getattr(config, item.name):
            raise ValueError("breakdown media contribution does not match config")
    actual_media = {item.name: item for item in breakdown.contributions if item.source == "media"}
    expected_media = {
        name: getattr(snapshot, attribute)
        for name, attribute in _MEDIA_DIMENSIONS.items()
        if snapshot is not None
        and getattr(snapshot, attribute) is not None
        and getattr(config, name) > 0
    }
    if set(actual_media) != set(expected_media) or any(
        actual_media[name].value != value for name, value in expected_media.items()
    ):
        raise ValueError("breakdown media contributions do not match media evidence snapshot")
    if breakdown.media_evidence_sha256 != _media_snapshot_digest(snapshot):
        raise ValueError("media evidence snapshot identity does not match breakdown")
    expected_penalty = config.penalty * candidate.features.penalty
    if not math.isclose(
        breakdown.penalty_deduction, expected_penalty, rel_tol=1e-12, abs_tol=1e-12
    ):
        raise ValueError("breakdown penalty deduction does not match candidate or config")
    if not math.isclose(
        breakdown.diversity_deduction, expected_diversity, rel_tol=1e-12, abs_tol=1e-12
    ):
        raise ValueError("breakdown diversity deduction does not match config and rank order")


def _strict_percent_decode(value: str) -> str:
    if _INVALID_PERCENT_ESCAPE.search(value):
        raise ValueError("source contains malformed percent encoding")
    try:
        return unquote_to_bytes(value).decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ValueError("source contains invalid UTF-8 encoding") from exc


def _decoded_pairs(value: str) -> list[tuple[str, str]]:
    if value == "":
        return []
    pairs: list[tuple[str, str]] = []
    for component in value.split("&"):
        raw_name, separator, raw_item = component.partition("=")
        name = _strict_percent_decode(raw_name.replace("+", " "))
        item = _strict_percent_decode(raw_item.replace("+", " ")) if separator else ""
        pairs.append((name, item))
    return pairs


def _validate_source(source: object) -> str:
    if not isinstance(source, str):
        raise TypeError("source must be a string")
    stripped = source.strip()
    if not stripped:
        raise ValueError("source cannot be empty")
    if _EMBEDDED_MEDIA_SOURCE.match(stripped):
        raise ValueError("source must not contain embedded media")
    try:
        parsed = urlsplit(stripped)
        username, password = parsed.username, parsed.password
    except ValueError as exc:
        raise ValueError("source URL is malformed") from exc
    is_url = bool(parsed.scheme) and ("://" in stripped or parsed.scheme.casefold() == "file")
    if not is_url:
        return stripped
    # Validate every relevant URL component before interpreting names. No exception
    # includes source material, so malformed credentials cannot leak into logs.
    _strict_percent_decode(parsed.path)
    query_decoded = _strict_percent_decode(parsed.query)
    fragment_decoded = _strict_percent_decode(parsed.fragment)
    if ";" in query_decoded or ("=" in fragment_decoded and ";" in fragment_decoded):
        raise ValueError("source contains an ambiguous parameter separator")
    if username or password:
        raise ValueError("source must not contain credentials")
    if parsed.hostname is not None:
        _canonical_hostname(parsed.hostname)
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("source URL has an invalid port") from exc
    query_pairs = _decoded_pairs(parsed.query)
    fragment_pairs = _decoded_pairs(parsed.fragment) if "=" in fragment_decoded else []
    raw_parameter_names = [component.partition("=")[0] for component in parsed.query.split("&")]
    if fragment_pairs:
        raw_parameter_names.extend(
            component.partition("=")[0] for component in parsed.fragment.split("&")
        )
    if any(_parameter_name_is_sensitive(name) for name in raw_parameter_names) or any(
        _is_sensitive_query_name(name) for name, _ in (*query_pairs, *fragment_pairs)
    ):
        raise ValueError("source must not contain credentials")
    return stripped


def _is_sensitive_query_name(name: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", name.casefold())
    return normalized in _SENSITIVE_QUERY_NAMES


def _parameter_name_is_sensitive(raw_name: str) -> bool:
    """Bound nested decoding so encoded delimiters cannot hide credential names."""
    current = raw_name.replace("+", " ")
    if _is_sensitive_query_name(current):
        return True
    for _ in range(_MAX_PARAMETER_NAME_DECODE_DEPTH):
        if re.search(r"%[0-9A-Fa-f]{2}", current) is None:
            return False
        decoded = _strict_percent_decode(current)
        if any(delimiter in decoded for delimiter in ("&", ";", "=")):
            raise ValueError("source contains an obscured parameter name")
        if _is_sensitive_query_name(decoded):
            return True
        if decoded == current:
            return False
        current = decoded
    if re.search(r"%[0-9A-Fa-f]{2}", current):
        raise ValueError("source parameter name exceeds maximum decode depth")
    return False


def _canonical_url_path(raw_path: str, *, http: bool) -> str:
    absolute = raw_path.startswith("/") or http
    decoded_segments = [_strict_percent_decode(segment) for segment in raw_path.split("/")]
    output: list[str] = []
    for segment in decoded_segments:
        segment = unicodedata.normalize("NFC", segment)
        if segment == ".":
            continue
        if segment == "..":
            if output and output[-1] != "":
                output.pop()
            continue
        output.append(segment)
    trailing = raw_path.endswith(("/", "/.", "/.."))
    encoded = "/".join(
        quote(segment, safe="-._~!$&'()*+,;=:@", encoding="utf-8", errors="strict")
        for segment in output
    )
    if absolute and not encoded.startswith("/"):
        encoded = "/" + encoded
    if trailing and encoded and not encoded.endswith("/"):
        encoded += "/"
    return encoded or ("/" if http else "")


def _canonical_source(source: str) -> str:
    validated = _validate_source(source)
    parsed = urlsplit(validated)
    is_url = bool(parsed.scheme) and ("://" in validated or parsed.scheme.casefold() == "file")
    if not is_url:
        return unicodedata.normalize("NFC", validated)

    scheme = parsed.scheme.casefold()
    hostname = parsed.hostname
    if hostname is None and scheme != "file":
        return unicodedata.normalize("NFC", validated)
    host = "" if hostname is None else _canonical_hostname(hostname)
    if ":" in host:
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("source URL has an invalid port") from exc
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        host = f"{host}:{port}"
    query_pairs = [
        (unicodedata.normalize("NFC", name), unicodedata.normalize("NFC", value))
        for name, value in _decoded_pairs(parsed.query)
    ]
    query = urlencode(sorted(query_pairs), doseq=True, quote_via=quote, safe="~")
    path = _canonical_url_path(parsed.path, http=scheme in ("http", "https"))
    return urlunsplit((scheme, host, path, query, ""))


def _canonical_hostname(hostname: str) -> str:
    normalized = unicodedata.normalize("NFC", hostname)
    if ":" in normalized:
        try:
            return ipaddress.IPv6Address(normalized).compressed.casefold()
        except ipaddress.AddressValueError as exc:
            raise ValueError("source URL has an invalid hostname") from exc
    try:
        return str(ipaddress.IPv4Address(normalized))
    except ipaddress.AddressValueError:
        pass
    try:
        ascii_host = normalized.encode("idna").decode("ascii").casefold()
    except (UnicodeError, ValueError) as exc:
        raise ValueError("source URL has an invalid hostname") from exc
    labels = ascii_host[:-1].split(".") if ascii_host.endswith(".") else ascii_host.split(".")
    if (
        not labels
        or len(ascii_host) > 253
        or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
    ):
        raise ValueError("source URL has an invalid hostname")
    return ascii_host


def _canonical_timestamp(value: float) -> str:
    normalized = Decimal(str(value)).normalize()
    if normalized.is_zero():
        return "0"
    return format(normalized, "f")


def _derive_candidate_id(
    source: str,
    profile: ClipProfile,
    selection_version: str,
    start: float,
    end: float,
) -> str:
    material = json.dumps(
        [
            _canonical_source(source),
            profile.value,
            selection_version,
            _canonical_timestamp(start),
            _canonical_timestamp(end),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return "cand_" + hashlib.sha256(material.encode()).hexdigest()


def _has_prohibited_reason_claim(reason: str) -> bool:
    return _PROHIBITED_REASON_CLAIM.search(reason) is not None


def _canonical_topic_terms(terms: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(terms, tuple):
        raise TypeError("topic terms must be an immutable tuple")
    canonical: list[str] = []
    seen: set[str] = set()
    for term in terms:
        if not isinstance(term, str):
            raise TypeError("topic terms must be strings")
        normalized = unicodedata.normalize("NFC", term).casefold().strip()
        if not normalized:
            raise ValueError("topic terms must be non-empty after canonicalization")
        if normalized not in seen:
            seen.add(normalized)
            canonical.append(normalized)
    return tuple(canonical)


def _media_values(
    media: RankingMediaSignals | MediaEvidenceSnapshot | None,
) -> dict[str, float | None]:
    return {
        name: None if media is None else getattr(media, attribute)
        for name, attribute in _MEDIA_DIMENSIONS.items()
    }


def _media_snapshot_digest(snapshot: MediaEvidenceSnapshot | None) -> str | None:
    if snapshot is None:
        return None
    encoded = json.dumps(
        snapshot.to_dict(),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class _ScoreComponents:
    contributions: tuple[ScoreContribution, ...]
    active_weight_total: float
    weighted_pre_penalty_score: float
    penalty_deduction: float
    topic_set: frozenset[str]

    @property
    def base_score(self) -> float:
        return min(10.0, max(0.0, self.weighted_pre_penalty_score - self.penalty_deduction))


def _score_components(item: RankedInput, config: WeightConfig) -> _ScoreComponents:
    contributions: list[ScoreContribution] = []
    for name in _TEXT_DIMENSIONS:
        weight = getattr(config, name)
        if weight > 0:
            value = getattr(item.extraction.features, name)
            contributions.append(ScoreContribution(name, value, weight, value * weight, "text"))
    media_values = _media_values(item.media)
    for name, value in media_values.items():
        weight = getattr(config, name)
        if value is not None and weight > 0:
            contributions.append(ScoreContribution(name, value, weight, value * weight, "media"))
    total = sum(item.weight for item in contributions)
    if total <= 0:
        raise ValueError("candidate has no positive usable weight total")
    return _ScoreComponents(
        tuple(contributions),
        total,
        sum(item.weighted_value for item in contributions) / total,
        config.penalty * item.extraction.features.penalty,
        frozenset(item.extraction.topic_terms),
    )


def _topic_similarity(
    left: tuple[str, ...] | frozenset[str], right: tuple[str, ...] | frozenset[str]
) -> float:
    left_set = left if isinstance(left, frozenset) else frozenset(left)
    right_set = right if isinstance(right, frozenset) else frozenset(right)
    if not left_set or not right_set:
        return 0.0
    return len(left_set & right_set) / len(left_set | right_set)


def _overlap(
    left: BoundaryCandidate | ClipCandidate,
    right: BoundaryCandidate | ClipCandidate,
    metric: str,
) -> float:
    intersection = max(0.0, min(left.end, right.end) - max(left.start, right.start))
    if intersection == 0:
        return 0.0
    if metric == "iou":
        denominator = max(left.end, right.end) - min(left.start, right.start)
    else:
        denominator = min(left.duration, right.duration)
    return intersection / denominator


def _overlap_violates_policy(
    left: BoundaryCandidate | ClipCandidate,
    right: BoundaryCandidate | ClipCandidate,
    config: WeightConfig,
) -> bool:
    overlap = _overlap(left, right, config.overlap_metric)
    return overlap > 0 and overlap >= config.overlap_threshold


class _SelectedIntervalIndex:
    """Start-sorted selected intervals with a monotonic prefix-max end index."""

    def __init__(self) -> None:
        self.starts: list[float] = []
        self.intervals: list[BoundaryCandidate] = []
        self.prefix_max_ends: list[float] = []

    def violates(self, candidate: BoundaryCandidate, config: WeightConfig) -> bool:
        stop = bisect_left(self.starts, candidate.end)
        first = bisect_right(self.prefix_max_ends, candidate.start, hi=stop)
        return any(
            interval.end > candidate.start and _overlap_violates_policy(candidate, interval, config)
            for interval in self.intervals[first:stop]
        )

    def add(self, candidate: BoundaryCandidate) -> None:
        index = bisect_right(self.starts, candidate.start)
        self.starts.insert(index, candidate.start)
        self.intervals.insert(index, candidate)
        self.prefix_max_ends.insert(index, candidate.end)
        prior_max = self.prefix_max_ends[index - 1] if index else -math.inf
        for position in range(index, len(self.prefix_max_ends)):
            prior_max = max(prior_max, self.intervals[position].end)
            if self.prefix_max_ends[position] == prior_max and position > index:
                break
            self.prefix_max_ends[position] = prior_max


def _validate_artifact_overlaps(
    candidates: tuple[ClipCandidate, ...], config: WeightConfig
) -> None:
    active: list[tuple[float, str, ClipCandidate]] = []
    for candidate in sorted(candidates, key=lambda item: (item.start, item.end, item.candidate_id)):
        while active and active[0][0] <= candidate.start:
            heapq.heappop(active)
        if any(_overlap_violates_policy(candidate, prior, config) for _, _, prior in active):
            raise ValueError("artifact candidates violate overlap policy")
        heapq.heappush(active, (candidate.end, candidate.candidate_id, candidate))


def _reasons(item: RankedInput, contributions: tuple[ScoreContribution, ...]) -> tuple[str, ...]:
    reasons = [
        _REASON_TEMPLATES[evidence.tag]
        for evidence in item.extraction.evidence
        if evidence.tag in _REASON_TEMPLATES
    ]
    reasons.extend(
        _MEDIA_REASON_TEMPLATES[part.name].format(value=part.value)
        for part in contributions
        if part.source == "media" and part.weighted_value > 0
    )
    return tuple(dict.fromkeys(reasons)) or (_FALLBACK_REASON,)


def rank_candidates_with_breakdowns(
    inputs: list[RankedInput],
    *,
    source: str,
    profile: ClipProfile,
    k: int,
    config: WeightConfig | None = None,
) -> RankedSelection:
    """Select candidates and return strict score audits in deterministic MMR order."""
    _validate_source(source)
    if not isinstance(profile, ClipProfile):
        raise TypeError("profile must be a ClipProfile")
    if not isinstance(k, int) or isinstance(k, bool):
        raise TypeError("k must be an integer")
    if k < 0:
        raise ValueError("k must be non-negative")
    if type(inputs) is not list:
        raise TypeError("inputs must be a list of RankedInput values")
    if len(inputs) > MAX_RANKING_INPUTS:
        raise ValueError(f"ranking accepts at most {MAX_RANKING_INPUTS} inputs")
    if any(not isinstance(item, RankedInput) for item in inputs):
        raise TypeError("inputs must be a list of RankedInput values")
    if config is None:
        config = WeightConfig()
    if not isinstance(config, WeightConfig):
        raise TypeError("config must be a WeightConfig")
    keys = [item.input_key for item in inputs]
    intervals = [(item.candidate.start, item.candidate.end) for item in inputs]
    if len(set(keys)) != len(keys):
        raise ValueError("duplicate input IDs are not allowed")
    if len(set(intervals)) != len(intervals):
        raise ValueError("duplicate candidate intervals are not allowed")
    for item in inputs:
        if item.media is not None:
            if _canonical_source(item.media.source) != _canonical_source(source):
                raise ValueError("media source does not match ranking source")
            if (item.media.interval_start, item.media.interval_end) != (
                item.candidate.start,
                item.candidate.end,
            ):
                raise ValueError("media window does not match candidate interval")

    scored = [(item, _score_components(item, config)) for item in inputs]
    scored.sort(
        key=lambda pair: (
            -pair[1].base_score,
            pair[0].candidate.start,
            pair[0].candidate.end,
            pair[0].input_key,
        )
    )
    eligible: list[tuple[RankedInput, _ScoreComponents]] = []
    interval_index = _SelectedIntervalIndex()
    for pair in scored:
        if not interval_index.violates(pair[0].candidate, config):
            eligible.append(pair)
            interval_index.add(pair[0].candidate)

    chosen: list[tuple[RankedInput, _ScoreComponents, float]] = []
    running_max_similarity = [0.0] * len(eligible)
    while eligible and len(chosen) < k:
        best_index = min(
            range(len(eligible)),
            key=lambda index: (
                -(
                    eligible[index][1].base_score
                    - config.diversity_strength * 10.0 * running_max_similarity[index]
                ),
                -eligible[index][1].base_score,
                eligible[index][0].candidate.start,
                eligible[index][0].candidate.end,
                eligible[index][0].input_key,
            ),
        )
        best = eligible.pop(best_index)
        similarity = running_max_similarity.pop(best_index)
        diversity_deduction = config.diversity_strength * 10.0 * similarity
        chosen.append((best[0], best[1], diversity_deduction))
        for index, pair in enumerate(eligible):
            running_max_similarity[index] = max(
                running_max_similarity[index],
                _topic_similarity(pair[1].topic_set, best[1].topic_set),
            )

    ranked: list[ClipCandidate] = []
    breakdowns: list[ScoreBreakdown] = []
    media_snapshots: list[MediaEvidenceSnapshot | None] = []
    for index, (item, components, diversity_deduction) in enumerate(chosen, 1):
        candidate_id = _derive_candidate_id(
            source,
            profile,
            SELECTION_VERSION,
            item.candidate.start,
            item.candidate.end,
        )
        final_score = round(
            min(
                10.0,
                max(
                    0.0,
                    components.weighted_pre_penalty_score
                    - components.penalty_deduction
                    - diversity_deduction,
                ),
            ),
            6,
        )
        ranked.append(
            ClipCandidate(
                candidate_id=candidate_id,
                start=item.candidate.start,
                end=item.candidate.end,
                text=item.candidate.text,
                profile=profile,
                features=item.extraction.features,
                score=final_score,
                reasons=_reasons(item, components.contributions),
                topic_terms=item.extraction.topic_terms,
                rank=index,
                display_order=1,
            )
        )
        snapshot = None if item.media is None else item.media.to_snapshot()
        media_snapshots.append(snapshot)
        breakdowns.append(
            ScoreBreakdown(
                candidate_id,
                SELECTION_VERSION,
                components.contributions,
                components.active_weight_total,
                components.weighted_pre_penalty_score,
                components.penalty_deduction,
                diversity_deduction,
                final_score,
                _media_snapshot_digest(snapshot),
            )
        )
    chronological = sorted(
        ranked, key=lambda candidate: (candidate.start, candidate.end, candidate.candidate_id)
    )
    display_orders = {
        candidate.candidate_id: index for index, candidate in enumerate(chronological, 1)
    }
    ranked = [
        replace(candidate, display_order=display_orders[candidate.candidate_id])
        for candidate in ranked
    ]
    return RankedSelection(tuple(ranked), tuple(breakdowns), tuple(media_snapshots))


def rank_candidates(
    inputs: list[RankedInput],
    *,
    source: str,
    profile: ClipProfile,
    k: int,
    config: WeightConfig | None = None,
) -> list[ClipCandidate]:
    """Compatibility helper returning only candidates; use audits for artifact publication."""
    return list(
        rank_candidates_with_breakdowns(
            inputs, source=source, profile=profile, k=k, config=config
        ).candidates
    )


def write_candidates_artifact(path: str | Path, artifact: CandidatesArtifact) -> None:
    """Atomically publish into a trusted, job-owned analysis directory."""
    if not isinstance(artifact, CandidatesArtifact):
        raise TypeError("artifact must be a CandidatesArtifact")
    destination = Path(path)
    if destination.parent.is_symlink():
        raise ValueError("analysis directory must not be a symlink")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.parent.is_symlink():
        raise ValueError("analysis directory must not be a symlink")
    encoded = (
        json.dumps(artifact.to_dict(), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    ).encode()
    pending: Path | None = None
    with candidate_artifact_lock(destination.parent, exclusive=True):
        try:
            with tempfile.NamedTemporaryFile(
                "wb",
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp",
                delete=False,
            ) as stream:
                pending = Path(stream.name)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(pending, destination)
            descriptor = os.open(destination.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            pending = None
        finally:
            if pending is not None:
                pending.unlink(missing_ok=True)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-standard JSON constant: {value}")


def read_candidates_artifact(path: str | Path) -> CandidatesArtifact:
    """Read a regular artifact bounded by ``MAX_ARTIFACT_BYTES`` and validate."""
    source = Path(path)
    if source.parent.is_symlink():
        raise ValueError("analysis directory must not be a symlink")
    initial = source.stat()
    if not stat.S_ISREG(initial.st_mode):
        raise ValueError("candidates artifact must be a regular file")
    if initial.st_size > MAX_ARTIFACT_BYTES:
        raise ValueError(f"candidates artifact must be at most {MAX_ARTIFACT_BYTES} bytes")
    with source.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode):
            raise ValueError("candidates artifact must be a regular file")
        if opened.st_size > MAX_ARTIFACT_BYTES:
            raise ValueError(f"candidates artifact must be at most {MAX_ARTIFACT_BYTES} bytes")
        encoded = stream.read(MAX_ARTIFACT_BYTES + 1)
    if len(encoded) > MAX_ARTIFACT_BYTES:
        raise ValueError(f"candidates artifact must be at most {MAX_ARTIFACT_BYTES} bytes")
    try:
        document = encoded.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("candidates artifact must contain valid UTF-8") from exc
    payload = json.loads(
        document,
        object_pairs_hook=_reject_duplicate_keys,
        parse_constant=_reject_json_constant,
    )
    return CandidatesArtifact.from_dict(payload)
