"""Deterministic, privacy-safe offline V1-versus-V2 evaluation reports.

The harness reads metadata artifacts only. It deliberately reports descriptive
comparison and proxy metrics, never a quality winner, virality probability, or
training-performance claim.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import ipaddress
import json
import math
import os
import re
import stat
import sys
import unicodedata
import uuid
from collections import Counter
from itertools import pairwise
from pathlib import Path
from statistics import median
from urllib.parse import quote, unquote_to_bytes, urlsplit, urlunsplit

from .candidate_feedback import FeedbackArtifactInvalid, read_candidate_feedback_state
from .models import TranscriptSegment
from .ranking import MAX_ARTIFACT_BYTES, CandidatesArtifact

SCHEMA_VERSION = "evaluation-v1.0"
REGISTRY_VERSION = "source-registry-v1.0"
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_TRANSCRIPT_CUES = 100_000
MAX_V1_CLIPS = 5_000
MAX_JOBS = 1_000
OUTPUT_JSON = "evaluation.json"
OUTPUT_MARKDOWN = "evaluation.md"
_SENSITIVE_QUERY = {
    "token",
    "access_token",
    "id_token",
    "refresh_token",
    "api_key",
    "apikey",
    "auth",
    "authorization",
    "credential",
    "password",
    "passwd",
    "secret",
    "signature",
    "sig",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "x-goog-signature",
    "x-goog-credential",
    "awsaccesskeyid",
    "policy",
}
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


class EvaluationError(ValueError):
    """A sanitized evaluation input, binding, or output failure."""


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise EvaluationError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _constant(value: str) -> object:
    raise EvaluationError(f"non-standard JSON number: {value}")


def _regular_bytes(path: Path, limit: int, label: str) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        raise EvaluationError(f"{label} is required") from None
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise EvaluationError(f"{label} must be a regular file") from None
        raise EvaluationError(f"cannot read {label}") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise EvaluationError(f"{label} must be a regular file")
        if info.st_size > limit:
            raise EvaluationError(f"{label} must be at most {limit} bytes")
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(fd, min(64 * 1024, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise EvaluationError(f"{label} must be at most {limit} bytes")
        return b"".join(chunks)
    finally:
        os.close(fd)


def _decode_json(raw: bytes, label: str) -> object:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise EvaluationError(f"{label} must contain valid UTF-8") from error
    try:
        value = json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
        _validate_unicode_scalars(value, label)
        return value
    except EvaluationError:
        raise
    except Exception as error:
        raise EvaluationError(f"{label} must contain valid strict JSON") from error


def _validate_unicode_scalars(value: object, label: str) -> None:
    if isinstance(value, str):
        if any(unicodedata.category(char) == "Cs" for char in value):
            raise EvaluationError(f"{label} contains a non-Unicode scalar value")
    elif isinstance(value, dict):
        for key, item in value.items():
            _validate_unicode_scalars(key, label)
            _validate_unicode_scalars(item, label)
    elif isinstance(value, list):
        for item in value:
            _validate_unicode_scalars(item, label)


def _json_file(path: Path, limit: int, label: str) -> tuple[object, bytes]:
    raw = _regular_bytes(path, limit, label)
    return _decode_json(raw, label), raw


def _exact(value: object, fields: set[str], label: str) -> dict[str, object]:
    if type(value) is not dict or set(value) != fields:
        raise EvaluationError(f"{label} has missing or unknown fields")
    return value


def _number(value: object, label: str, *, nonnegative: bool = True) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise EvaluationError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result) or (nonnegative and result < 0):
        raise EvaluationError(f"{label} must be finite and non-negative")
    return result


def _safe_directory(path: Path, label: str, *, create: bool = False) -> Path:
    path = path.absolute()
    if create:
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            raise EvaluationError(f"cannot create {label}") from error
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise EvaluationError(f"{label} does not exist") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or path.resolve() != path:
        raise EvaluationError(f"{label} must be a real directory without symlink traversal")
    return path


def _open_output_directory(path: Path, *, create: bool = True) -> int:
    """Securely create/walk an output path and return its held directory descriptor."""
    absolute = path.is_absolute()
    parts = path.parts[1:] if absolute else path.parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    current = os.open("/" if absolute else ".", flags)
    try:
        for part in parts:
            if part in {"", "."}:
                continue
            if part == "..":
                raise EvaluationError(
                    "output directory must be a real directory without symlink traversal"
                )
            try:
                child = os.open(part, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise EvaluationError("output directory does not exist") from None
                try:
                    os.mkdir(part, 0o700, dir_fd=current)
                    os.fsync(current)
                    child = os.open(part, flags, dir_fd=current)
                except OSError as error:
                    raise EvaluationError("cannot create output directory") from error
            except OSError as error:
                raise EvaluationError(
                    "output directory must be a real directory without symlink traversal"
                ) from error
            os.close(current)
            current = child
        return current
    except Exception:
        os.close(current)
        raise


def _read_transcript(job: Path) -> tuple[list[TranscriptSegment], str, bytes]:
    payload, raw = _json_file(job / "transcript.json", MAX_INPUT_BYTES, "transcript")
    document = _exact(payload, {"language", "segments"}, "transcript")
    if not isinstance(document["language"], str) or not document["language"].strip():
        raise EvaluationError("transcript language must be a non-empty string")
    raw_segments = document["segments"]
    if type(raw_segments) is not list or not 1 <= len(raw_segments) <= MAX_TRANSCRIPT_CUES:
        raise EvaluationError(f"transcript must contain 1..{MAX_TRANSCRIPT_CUES} cues")
    segments: list[TranscriptSegment] = []
    previous_end = 0.0
    for index, raw_segment in enumerate(raw_segments):
        item = _exact(raw_segment, {"start", "end", "text"}, f"transcript cue {index}")
        start = _number(item["start"], f"transcript cue {index} start")
        end = _number(item["end"], f"transcript cue {index} end")
        if not isinstance(item["text"], str):
            raise EvaluationError(f"transcript cue {index} text must be a string")
        try:
            segment = TranscriptSegment(start, end, item["text"])
        except (TypeError, ValueError) as error:
            raise EvaluationError(f"transcript cue {index} is invalid") from error
        if index and start < previous_end:
            raise EvaluationError("transcript cues must be chronological and non-overlapping")
        previous_end = end
        segments.append(segment)
    return segments, document["language"], raw


def _read_manifest(job: Path, duration: float) -> list[tuple[float, float]] | None:
    path = job / "manifest.json"
    if not os.path.lexists(path):
        return None
    payload, _raw = _json_file(path, MAX_INPUT_BYTES, "V1 manifest")
    allowed = {
        "source",
        "render_mode",
        "status",
        "language",
        "transcript",
        "clips",
        "selection_v2",
    }
    required = allowed - {"selection_v2"}
    if type(payload) is not dict or not required <= set(payload) <= allowed:
        raise EvaluationError("V1 manifest has missing or unknown fields")
    if payload["status"] != "completed" or type(payload["clips"]) is not list:
        raise EvaluationError("V1 manifest must be completed and contain clips")
    if len(payload["clips"]) > MAX_V1_CLIPS:
        raise EvaluationError(f"V1 manifest may contain at most {MAX_V1_CLIPS} clips")
    windows: list[tuple[float, float]] = []
    expected_clip_fields = {
        "index",
        "start",
        "end",
        "duration",
        "score",
        "text",
        "output",
        "subtitles",
    }
    indices: set[int] = set()
    for position, raw_clip in enumerate(payload["clips"]):
        clip = _exact(raw_clip, expected_clip_fields, f"V1 clip {position}")
        index = clip["index"]
        if not isinstance(index, int) or isinstance(index, bool) or index <= 0 or index in indices:
            raise EvaluationError("V1 clip indices must be unique positive integers")
        indices.add(index)
        start = _number(clip["start"], f"V1 clip {position} start")
        end = _number(clip["end"], f"V1 clip {position} end")
        stated_duration = _number(clip["duration"], f"V1 clip {position} duration")
        _number(clip["score"], f"V1 clip {position} score", nonnegative=False)
        if (
            end <= start
            or end > duration
            or not math.isclose(end - start, stated_duration, abs_tol=1e-3)
        ):
            raise EvaluationError("V1 clip window is out of bounds or duration is inconsistent")
        if any(not isinstance(clip[name], str) for name in ("text", "output", "subtitles")):
            raise EvaluationError("V1 clip text and paths must be strings")
        windows.append((start, end))
    if len(set(windows)) != len(windows):
        raise EvaluationError("V1 clip windows must be unique")
    return windows


def _candidate_path(job: Path) -> Path | None:
    canonical = job / "analysis" / "candidates.v2.json"
    alternate = job / "candidates.v2.json"
    present = [path for path in (canonical, alternate) if os.path.lexists(path)]
    if len(present) > 1:
        raise EvaluationError("multiple V2 candidate artifacts are ambiguous")
    return present[0] if present else None


def _read_candidates(job: Path, duration: float) -> tuple[CandidatesArtifact | None, bytes | None]:
    path = _candidate_path(job)
    if path is None:
        return None, None
    try:
        raw = _regular_bytes(path, MAX_ARTIFACT_BYTES, "V2 candidates")
        artifact = CandidatesArtifact.from_dict(_decode_json(raw, "V2 candidates"))
    except EvaluationError:
        raise
    except Exception as error:
        raise EvaluationError(
            "V2 candidates failed strict CandidatesArtifact validation"
        ) from error
    if any(candidate.end > duration for candidate in artifact.candidates):
        raise EvaluationError("V2 candidate window exceeds transcript duration")
    return artifact, raw


def _read_feedback(
    job: Path, artifact: CandidatesArtifact | None, raw_candidates: bytes | None
) -> dict[str, object] | None:
    candidates_path = _candidate_path(job)
    if candidates_path is None:
        feedback_paths = (
            job / "analysis" / "candidate-feedback.v1.json",
            job / "candidate-feedback.v1.json",
        )
    else:
        feedback_paths = (candidates_path.parent / "candidate-feedback.v1.json",)
    present = [path for path in feedback_paths if os.path.lexists(path)]
    if not present:
        return None
    if artifact is None or raw_candidates is None or len(present) != 1:
        raise EvaluationError("feedback requires one bound V2 candidates artifact")
    try:
        return read_candidate_feedback_state(present[0], raw_candidates)
    except FeedbackArtifactInvalid as error:
        raise EvaluationError("feedback failed strict binding or schema validation") from error


def _sanitize_url(url: object) -> str:
    if (
        not isinstance(url, str)
        or not url.strip()
        or any(unicodedata.category(char) in {"Cc", "Cs"} for char in url)
    ):
        raise EvaluationError("source_url must be a non-empty URL")
    try:
        source = url.strip()
        if re.search(r"%(?![0-9A-Fa-f]{2})", source):
            raise ValueError("malformed percent escape")
        # Every percent-encoded URL component must decode as strict UTF-8.
        parts = urlsplit(source)
        for component in (parts.path, parts.query, parts.fragment, parts.username, parts.password):
            if component is not None:
                unquote_to_bytes(component).decode("utf-8", errors="strict")
        scheme = parts.scheme.casefold()
        if scheme not in {"http", "https"} or not parts.hostname:
            raise ValueError("scheme or host")
        hostname = parts.hostname
        try:
            address = ipaddress.ip_address(hostname)
        except ValueError:
            host = hostname.encode("idna").decode("ascii").casefold()
        else:
            host = f"[{address.compressed}]" if address.version == 6 else address.compressed
        port = parts.port
    except (UnicodeError, ValueError) as error:
        raise EvaluationError("source_url is malformed or has invalid encoding") from error
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    netloc = host if port is None or default_port else f"{host}:{port}"
    query_items: list[tuple[str, str, bool]] = []
    for field in parts.query.split("&") if parts.query else []:
        key_raw, separator, value_raw = field.partition("=")
        key = unquote_to_bytes(key_raw.replace("+", " ")).decode("utf-8")
        value = unquote_to_bytes(value_raw.replace("+", " ")).decode("utf-8")
        key_parts = [part for part in re.split(r"[^A-Za-z0-9_-]+", key.casefold()) if part]
        if key.casefold() in _SENSITIVE_QUERY or any(
            part in _SENSITIVE_QUERY for part in key_parts
        ):
            continue
        query_items.append((key, value, bool(separator)))
    encoded_fields = []
    for key, value, had_equals in sorted(query_items):
        encoded = quote(key, safe="-._~")
        if had_equals:
            encoded += "=" + quote(value, safe="-._~")
        encoded_fields.append(encoded)
    return urlunsplit((scheme, netloc, parts.path or "/", "&".join(encoded_fields), ""))


def _read_registry(path: Path) -> tuple[list[dict[str, object]], bytes]:
    payload, _raw = _json_file(path, MAX_INPUT_BYTES, "source registry")
    document = _exact(payload, {"registry_version", "sources"}, "source registry")
    if document["registry_version"] != REGISTRY_VERSION or type(document["sources"]) is not list:
        raise EvaluationError("source registry version or sources is invalid")
    if not 1 <= len(document["sources"]) <= MAX_JOBS:
        raise EvaluationError(f"source registry must contain 1..{MAX_JOBS} sources")
    result: list[dict[str, object]] = []
    ids: set[str] = set()
    jobs: set[str] = set()
    for index, raw_source in enumerate(document["sources"]):
        source = _exact(
            raw_source,
            {"source_id", "job_id", "source_url", "license", "training_allowed"},
            f"registry source {index}",
        )
        for field in ("source_id", "job_id", "license"):
            if not isinstance(source[field], str) or not source[field].strip():
                raise EvaluationError(f"registry source {index} {field} must be non-empty")
        if (
            _SAFE_ID.fullmatch(source["source_id"]) is None
            or _SAFE_ID.fullmatch(source["job_id"]) is None
        ):
            raise EvaluationError(
                "registry source_id and job_id must use safe identifier characters"
            )
        if any(ord(char) < 32 for char in source["license"]) or len(source["license"]) > 128:
            raise EvaluationError("registry license must be bounded text without controls")
        if "/" in source["job_id"] or source["job_id"] in {".", ".."}:
            raise EvaluationError("registry job_id must be one directory name")
        if not isinstance(source["training_allowed"], bool):
            raise EvaluationError("registry training_allowed must be boolean")
        if source["source_id"] in ids or source["job_id"] in jobs:
            raise EvaluationError("registry source_id and job_id values must be unique")
        ids.add(source["source_id"])
        jobs.add(source["job_id"])
        sanitized = _sanitize_url(source["source_url"])
        result.append({**source, "sanitized_url": sanitized})
    fingerprint_document = {
        "registry_version": REGISTRY_VERSION,
        "sources": [
            {
                "source_id": source["source_id"],
                "job_id": source["job_id"],
                "sanitized_url": source["sanitized_url"],
                "license": source["license"],
                "training_allowed": source["training_allowed"],
            }
            for source in sorted(result, key=lambda item: item["source_id"])
        ],
    }
    fingerprint = json.dumps(
        fingerprint_document,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return result, fingerprint


def _distribution(values: list[float]) -> dict[str, object] | None:
    if not values:
        return None
    return {
        "sample_size": len(values),
        "min": min(values),
        "mean": sum(values) / len(values),
        "median": float(median(values)),
        "max": max(values),
    }


def _iou(first: tuple[float, float], second: tuple[float, float]) -> float:
    intersection = max(0.0, min(first[1], second[1]) - max(first[0], second[0]))
    union = first[1] - first[0] + second[1] - second[0] - intersection
    return intersection / union


def _merged_length(windows: list[tuple[float, float]]) -> float:
    if not windows:
        return 0.0
    total = 0.0
    ordered = sorted(windows)
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
        else:
            total += current_end - current_start
            current_start, current_end = start, end
    return total + current_end - current_start


def _intersection_length(
    first: list[tuple[float, float]], second: list[tuple[float, float]]
) -> float:
    boundaries = sorted({value for window in first + second for value in window})
    total = 0.0
    for start, end in pairwise(boundaries):
        midpoint = (start + end) / 2
        if any(a <= midpoint < b for a, b in first) and any(a <= midpoint < b for a, b in second):
            total += end - start
    return total


def _comparison(
    v1: list[tuple[float, float]], v2: list[tuple[float, float]], top_k: int
) -> dict[str, object]:
    pairwise = [_iou(first, second) for first in v1 for second in v2]
    intersection = _intersection_length(v1, v2)
    v1_length = _merged_length(v1)
    v2_length = _merged_length(v2)
    first_top = v1[:top_k]
    second_top = v2[:top_k]
    top_intersection = _intersection_length(first_top, second_top)
    top_union = _merged_length(first_top + second_top)
    return {
        "pairwise_temporal_iou": {
            "sample_size": len(pairwise),
            "mean": sum(pairwise) / len(pairwise) if pairwise else None,
            "max": max(pairwise) if pairwise else None,
        },
        "coverage": {
            "intersection_seconds": intersection,
            "v1_total_seconds": v1_length,
            "v2_total_seconds": v2_length,
            "v1_covered_by_v2": intersection / v1_length if v1_length else None,
            "v2_covered_by_v1": intersection / v2_length if v2_length else None,
        },
        "top_k_temporal_overlap": {
            "k": top_k,
            "v1_sample_size": len(first_top),
            "v2_sample_size": len(second_top),
            "intersection_over_union": top_intersection / top_union if top_union else None,
            "intersection_seconds": top_intersection,
            "union_seconds": top_union,
        },
    }


def _feedback_metrics(
    artifact: CandidatesArtifact | None, state: dict[str, object] | None, top_k: int
) -> dict[str, object]:
    if artifact is None:
        return {
            "available": state is not None,
            "counts": None,
            "labeled_count": None,
            "label_coverage": None,
            "acceptance_at_k": None,
        }
    latest = {} if state is None else state["latestByCandidate"]
    decisions = {candidate_id: event["decision"] for candidate_id, event in latest.items()}
    counts = Counter(decisions.values())
    result_counts = {name: counts[name] for name in ("accepted", "rejected", "undecided")}
    labeled = result_counts["accepted"] + result_counts["rejected"]
    top = artifact.candidates[:top_k]
    top_decisions = [decisions.get(candidate.candidate_id) for candidate in top]
    top_labeled = sum(value in {"accepted", "rejected"} for value in top_decisions)
    top_accepted = top_decisions.count("accepted")
    return {
        "available": state is not None,
        "counts": result_counts,
        "labeled_count": labeled,
        "label_coverage": labeled / len(artifact.candidates) if artifact.candidates else None,
        "acceptance_at_k": (
            {
                "k": top_k,
                "labeled": top_labeled,
                "accepted": top_accepted,
                "rate": top_accepted / top_labeled,
            }
            if top_labeled
            else None
        ),
    }


def _source_report(
    registry_source: dict[str, object], job: Path, top_k: int
) -> tuple[dict[str, object], list[str]]:
    segments, _language, _transcript_raw = _read_transcript(job)
    duration = max(segment.end for segment in segments)
    v1_windows = _read_manifest(job, duration)
    artifact, candidates_raw = _read_candidates(job, duration)
    feedback_state = _read_feedback(job, artifact, candidates_raw)
    warnings: list[str] = []
    if v1_windows is None:
        warnings.append("v1_manifest_not_available")
    if artifact is None:
        warnings.append("v2_candidates_not_available")
    if feedback_state is None:
        warnings.append("feedback_not_available")

    license_name = registry_source["license"]
    is_cc = isinstance(license_name, str) and license_name.casefold().startswith("cc")
    use_classification = (
        "training" if registry_source["training_allowed"] is True and is_cc else "evaluation_only"
    )
    v1 = {
        "available": v1_windows is not None,
        "clip_count": len(v1_windows) if v1_windows is not None else None,
        "windows": (
            [{"start": start, "end": end, "duration": end - start} for start, end in v1_windows]
            if v1_windows is not None
            else None
        ),
        "duration_distribution": (
            _distribution([end - start for start, end in v1_windows])
            if v1_windows is not None
            else None
        ),
    }
    if artifact is None:
        v2: dict[str, object] = {
            "available": False,
            "candidate_count": None,
            "profile_counts": None,
            "duration_distribution": None,
            "selected_candidates": None,
            "topic_diversity_pairwise_jaccard": None,
            "score_components": None,
            "media_coverage": None,
            "standalone_readability_proxies": None,
        }
        v2_windows: list[tuple[float, float]] | None = None
    else:
        latest = {} if feedback_state is None else feedback_state["latestByCandidate"]
        topic_similarities: list[float] = []
        for index, first in enumerate(artifact.candidates):
            first_terms = set(first.topic_terms)
            for second in artifact.candidates[index + 1 :]:
                second_terms = set(second.topic_terms)
                union = first_terms | second_terms
                topic_similarities.append(
                    len(first_terms & second_terms) / len(union) if union else 0.0
                )
        component_values: dict[str, list[float]] = {}
        component_weights: dict[str, float] = {}
        for breakdown in artifact.breakdowns:
            for contribution in breakdown.contributions:
                component_values.setdefault(contribution.name, []).append(contribution.value)
                component_weights[contribution.name] = contribution.weight
        media_available = sum(snapshot is not None for snapshot in artifact.media_snapshots)
        v2_windows = [(candidate.start, candidate.end) for candidate in artifact.candidates]
        v2 = {
            "available": True,
            "candidate_count": len(artifact.candidates),
            "profile_counts": dict(
                sorted(Counter(item.profile.value for item in artifact.candidates).items())
            ),
            "duration_distribution": _distribution([item.duration for item in artifact.candidates]),
            "selected_candidates": [
                {
                    "candidate_id": candidate.candidate_id,
                    "start": candidate.start,
                    "end": candidate.end,
                    "duration": candidate.duration,
                    "rank": candidate.rank,
                    "display_order": candidate.display_order,
                    "profile": candidate.profile.value,
                    "score": candidate.score,
                    "score_breakdown": {
                        "dimensions": [item.to_dict() for item in breakdown.contributions],
                        "active_weight_total": breakdown.active_weight_total,
                        "weighted_pre_penalty_score": breakdown.weighted_pre_penalty_score,
                        "penalty_deduction": breakdown.penalty_deduction,
                        "diversity_deduction": breakdown.diversity_deduction,
                    },
                    "media_available": snapshot is not None,
                    "feedback_latest_decision": (
                        latest[candidate.candidate_id]["decision"]
                        if candidate.candidate_id in latest
                        else None
                    ),
                }
                for candidate, breakdown, snapshot in zip(
                    artifact.candidates, artifact.breakdowns, artifact.media_snapshots, strict=True
                )
            ],
            "topic_diversity_pairwise_jaccard": (
                {
                    "sample_size": len(topic_similarities),
                    "mean": sum(topic_similarities) / len(topic_similarities),
                    "max": max(topic_similarities),
                }
                if topic_similarities
                else {"sample_size": 0, "mean": None, "max": None}
            ),
            "score_components": {
                "candidate_sample_size": len(artifact.candidates),
                "component_means": {
                    name: sum(values) / len(values)
                    for name, values in sorted(component_values.items())
                },
                "component_sample_sizes": {
                    name: len(values) for name, values in sorted(component_values.items())
                },
                "active_weights": dict(sorted(component_weights.items())),
            },
            "media_coverage": {
                "available": media_available,
                "total": len(artifact.candidates),
                "rate": media_available / len(artifact.candidates) if artifact.candidates else None,
            },
            "standalone_readability_proxies": {
                "proxy_only": True,
                "sample_size": len(artifact.candidates),
                "standalone_context_mean": (
                    sum(item.features.standalone_context for item in artifact.candidates)
                    / len(artifact.candidates)
                    if artifact.candidates
                    else None
                ),
                "information_density_mean": (
                    sum(item.features.information_density for item in artifact.candidates)
                    / len(artifact.candidates)
                    if artifact.candidates
                    else None
                ),
            },
        }
    comparison = (
        _comparison(v1_windows, v2_windows, top_k)
        if v1_windows is not None and v2_windows is not None
        else None
    )
    report = {
        "source": {
            "id": registry_source["source_id"],
            "url_sha256": hashlib.sha256(registry_source["sanitized_url"].encode()).hexdigest(),
            "url_hash_basis": "credential-stripped-canonical-url-v1",
            "license": license_name,
            "use_classification": use_classification,
        },
        "duration_seconds": duration,
        "transcript_cue_count": len(segments),
        "v1": v1,
        "v2": v2,
        "comparison": comparison,
        "feedback": _feedback_metrics(artifact, feedback_state, top_k),
        "warnings": warnings,
    }
    return report, warnings


def _mean(values: list[float | None]) -> float | None:
    available = [value for value in values if value is not None]
    return sum(available) / len(available) if available else None


def _aggregate(
    sources: list[dict[str, object]], warnings: list[str], top_k: int
) -> dict[str, object]:
    v2_sources = [source for source in sources if source["v2"]["available"]]
    comparison_sources = [source for source in sources if source["comparison"] is not None]
    candidates = [item for source in v2_sources for item in source["v2"]["selected_candidates"]]
    candidate_total = len(candidates)
    media_available = sum(source["v2"]["media_coverage"]["available"] for source in v2_sources)
    feedback_counts = {
        name: sum(source["feedback"]["counts"][name] for source in v2_sources)
        for name in ("accepted", "rejected", "undecided")
    }
    labeled_total = feedback_counts["accepted"] + feedback_counts["rejected"]
    top_feedback = [
        source["feedback"]["acceptance_at_k"]
        for source in v2_sources
        if source["feedback"]["acceptance_at_k"] is not None
    ]
    top_labeled = sum(item["labeled"] for item in top_feedback)
    top_accepted = sum(item["accepted"] for item in top_feedback)
    top_candidate_samples = sum(
        min(top_k, source["v2"]["candidate_count"]) for source in v2_sources
    )
    rights = Counter(source["source"]["use_classification"] for source in sources)
    profile_counts = Counter(item["profile"] for item in candidates)
    component_sums: Counter[str] = Counter()
    component_samples: Counter[str] = Counter()
    weight_sums: Counter[str] = Counter()
    weight_sources: Counter[str] = Counter()
    for source in v2_sources:
        components = source["v2"]["score_components"]
        for name, value in components["component_means"].items():
            count = components["component_sample_sizes"][name]
            component_sums[name] += value * count
            component_samples[name] += count
        for name, value in components["active_weights"].items():
            weight_sums[name] += value
            weight_sources[name] += 1
    pair_count = sum(
        source["comparison"]["pairwise_temporal_iou"]["sample_size"]
        for source in comparison_sources
    )
    pair_sum = sum(
        source["comparison"]["pairwise_temporal_iou"]["mean"]
        * source["comparison"]["pairwise_temporal_iou"]["sample_size"]
        for source in comparison_sources
        if source["comparison"]["pairwise_temporal_iou"]["mean"] is not None
    )
    topic_pair_count = sum(
        source["v2"]["topic_diversity_pairwise_jaccard"]["sample_size"] for source in v2_sources
    )
    topic_pair_sum = sum(
        source["v2"]["topic_diversity_pairwise_jaccard"]["mean"]
        * source["v2"]["topic_diversity_pairwise_jaccard"]["sample_size"]
        for source in v2_sources
        if source["v2"]["topic_diversity_pairwise_jaccard"]["mean"] is not None
    )
    comparison_intersection = sum(
        source["comparison"]["coverage"]["intersection_seconds"] for source in comparison_sources
    )
    v1_seconds = sum(
        source["comparison"]["coverage"]["v1_total_seconds"] for source in comparison_sources
    )
    v2_seconds = sum(
        source["comparison"]["coverage"]["v2_total_seconds"] for source in comparison_sources
    )
    top_intersection = sum(
        source["comparison"]["top_k_temporal_overlap"]["intersection_seconds"]
        for source in comparison_sources
    )
    top_union = sum(
        source["comparison"]["top_k_temporal_overlap"]["union_seconds"]
        for source in comparison_sources
    )
    standalone_samples = sum(source["v2"]["candidate_count"] for source in v2_sources)

    return {
        "source_count": len(sources),
        "rights_counts": {
            "training": rights["training"],
            "evaluation_only": rights["evaluation_only"],
        },
        "macro": {
            "sample_sizes": {
                "v2_sources": len(v2_sources),
                "comparison_sources": len(comparison_sources),
                "label_coverage_sources": sum(
                    source["feedback"]["label_coverage"] is not None for source in sources
                ),
                "acceptance_at_k_sources": sum(
                    source["feedback"]["acceptance_at_k"] is not None for source in sources
                ),
            },
            "candidate_count": _mean([source["v2"]["candidate_count"] for source in v2_sources]),
            "candidate_duration_mean": _mean(
                [source["v2"]["duration_distribution"]["mean"] for source in v2_sources]
            ),
            "topic_pairwise_jaccard_mean": _mean(
                [source["v2"]["topic_diversity_pairwise_jaccard"]["mean"] for source in v2_sources]
            ),
            "score_component_means": {
                name: _mean(
                    [
                        source["v2"]["score_components"]["component_means"].get(name)
                        for source in v2_sources
                    ]
                )
                for name in sorted(component_sums)
            },
            "active_weight_means": {
                name: weight_sums[name] / weight_sources[name] for name in sorted(weight_sums)
            },
            "standalone_context_proxy_mean": _mean(
                [
                    source["v2"]["standalone_readability_proxies"]["standalone_context_mean"]
                    for source in v2_sources
                ]
            ),
            "information_density_proxy_mean": _mean(
                [
                    source["v2"]["standalone_readability_proxies"]["information_density_mean"]
                    for source in v2_sources
                ]
            ),
            "media_coverage": _mean(
                [source["v2"]["media_coverage"]["rate"] for source in v2_sources]
            ),
            "pairwise_temporal_iou_mean": _mean(
                [
                    source["comparison"]["pairwise_temporal_iou"]["mean"]
                    for source in comparison_sources
                ]
            ),
            "v1_covered_by_v2": _mean(
                [
                    source["comparison"]["coverage"]["v1_covered_by_v2"]
                    for source in comparison_sources
                ]
            ),
            "v2_covered_by_v1": _mean(
                [
                    source["comparison"]["coverage"]["v2_covered_by_v1"]
                    for source in comparison_sources
                ]
            ),
            "top_k_temporal_overlap": _mean(
                [
                    source["comparison"]["top_k_temporal_overlap"]["intersection_over_union"]
                    for source in comparison_sources
                ]
            ),
            "label_coverage": _mean([source["feedback"]["label_coverage"] for source in sources]),
            "acceptance_at_k": _mean(
                [
                    source["feedback"]["acceptance_at_k"]["rate"]
                    if source["feedback"]["acceptance_at_k"] is not None
                    else None
                    for source in sources
                ]
            ),
        },
        "micro": {
            "candidate_count": candidate_total,
            "profile_counts": dict(sorted(profile_counts.items())),
            "candidate_duration_distribution": _distribution(
                [item["duration"] for item in candidates]
            ),
            "topic_pairwise_jaccard": topic_pair_sum / topic_pair_count
            if topic_pair_count
            else None,
            "score_component_means": {
                name: component_sums[name] / component_samples[name]
                for name in sorted(component_sums)
            },
            "score_component_sample_sizes": dict(sorted(component_samples.items())),
            "standalone_context_proxy_mean": (
                sum(
                    source["v2"]["standalone_readability_proxies"]["standalone_context_mean"]
                    * source["v2"]["candidate_count"]
                    for source in v2_sources
                )
                / standalone_samples
                if standalone_samples
                else None
            ),
            "information_density_proxy_mean": (
                sum(
                    source["v2"]["standalone_readability_proxies"]["information_density_mean"]
                    * source["v2"]["candidate_count"]
                    for source in v2_sources
                )
                / standalone_samples
                if standalone_samples
                else None
            ),
            "media_coverage": media_available / candidate_total if candidate_total else None,
            "pairwise_temporal_iou_mean": pair_sum / pair_count if pair_count else None,
            "coverage": {
                "v1_covered_by_v2": comparison_intersection / v1_seconds if v1_seconds else None,
                "v2_covered_by_v1": comparison_intersection / v2_seconds if v2_seconds else None,
            },
            "top_k_temporal_overlap": top_intersection / top_union if top_union else None,
            "feedback_counts": feedback_counts,
            "label_coverage": labeled_total / candidate_total if candidate_total else None,
            "acceptance_rate": feedback_counts["accepted"] / labeled_total
            if labeled_total
            else None,
            "acceptance_at_k": {
                "k": top_k,
                "source_count": len(v2_sources),
                "candidate_sample_count": top_candidate_samples,
                "labeled": top_labeled,
                "accepted": top_accepted,
                "rate": top_accepted / top_labeled if top_labeled else None,
            },
        },
        "warnings": sorted(set(warnings)),
        "notes": [
            "All comparison metrics are descriptive; they do not identify a quality winner.",
            "Standalone/readability values are feature proxies, not human readability judgments.",
            "No confidence interval is reported for these small and partially labeled samples.",
        ],
    }


def _markdown(report: dict[str, object]) -> str:
    aggregate = report["aggregate"]
    lines = [
        "# V1 vs V2 Evaluation",
        "",
        f"Schema: `{report['schema_version']}`",
        f"Report generation: `{report['report_id']}`",
        f"Sources: {aggregate['source_count']}",
        "",
        "This report contains descriptive temporal, scoring, diversity, media, and feedback metrics. It does not infer comparative editorial quality.",
        "",
        "## Rights",
        "",
        f"- Training: {aggregate['rights_counts']['training']}",
        f"- Evaluation only: {aggregate['rights_counts']['evaluation_only']}",
        "",
        "## Sources",
        "",
        "| Source ID | Use | Cues | V1 clips | V2 candidates | Labeled |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for source in report["sources"]:
        v1_count = source["v1"]["clip_count"]
        v2_count = source["v2"]["candidate_count"]
        labeled = source["feedback"]["labeled_count"]
        lines.append(
            f"| {source['source']['id']} | {source['source']['use_classification']} | "
            f"{source['transcript_cue_count']} | {v1_count if v1_count is not None else 'N/A'} | "
            f"{v2_count if v2_count is not None else 'N/A'} | {labeled if labeled is not None else 'N/A'} |"
        )
    lines.extend(
        [
            "",
            "## Aggregate notes",
            "",
            *[f"- {note}" for note in aggregate["notes"]],
            "",
            "Missing inputs and undefined denominators are reported as `null`/N/A, never fabricated as zero.",
            "",
        ]
    )
    return "\n".join(lines)


def _encoded_json(report: dict[str, object]) -> bytes:
    return (
        json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    ).encode("utf-8")


def _report_id(report: dict[str, object]) -> str:
    hash_basis = dict(report)
    hash_basis.pop("report_id", None)
    return hashlib.sha256(_encoded_json(hash_basis)).hexdigest()


def _write_all(fd: int, raw: bytes) -> None:
    written = 0
    while written < len(raw):
        count = os.write(fd, raw[written:])
        if count <= 0:
            raise OSError("short evaluation write")
        written += count


def _write_generation_file(generation_fd: int, name: str, raw: bytes) -> None:
    fd = os.open(
        name,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
        0o600,
        dir_fd=generation_fd,
    )
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise EvaluationError("evaluation generation file must be regular")
        os.fchmod(fd, 0o600)
        _write_all(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)


def _read_relative_regular(directory_fd: int, name: str, limit: int) -> bytes:
    fd = os.open(
        name,
        os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=directory_fd,
    )
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise EvaluationError("evaluation generation file must be regular and bounded")
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > limit:
            raise EvaluationError("evaluation generation file must be bounded")
        return raw
    finally:
        os.close(fd)


def _verify_alias(output_fd: int, name: str, target: str) -> bool:
    try:
        info = os.stat(name, dir_fd=output_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    if not stat.S_ISLNK(info.st_mode) or os.readlink(name, dir_fd=output_fd) != target:
        raise EvaluationError(f"conflicting evaluation output path: {name}")
    return True


def _verify_generation(generations_fd: int, report_id: str, expected: dict[str, bytes]) -> None:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    generation_fd = os.open(report_id, flags, dir_fd=generations_fd)
    try:
        for name, raw in expected.items():
            if _read_relative_regular(generation_fd, name, len(raw)) != raw:
                raise EvaluationError("existing evaluation generation conflicts with report hash")
    finally:
        os.close(generation_fd)


def _create_generation(generations_fd: int, report_id: str, files: dict[str, bytes]) -> None:
    try:
        _verify_generation(generations_fd, report_id, files)
        return
    except FileNotFoundError:
        pass
    temporary = f".tmp-{report_id}-{uuid.uuid4().hex}"
    generation_fd = -1
    created = False
    try:
        os.mkdir(temporary, 0o700, dir_fd=generations_fd)
        created = True
        generation_fd = os.open(
            temporary,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=generations_fd,
        )
        for name, raw in files.items():
            _write_generation_file(generation_fd, name, raw)
        os.fsync(generation_fd)
        os.rename(temporary, report_id, src_dir_fd=generations_fd, dst_dir_fd=generations_fd)
        created = False
        os.fsync(generations_fd)
    finally:
        if created and generation_fd >= 0:
            for name in files:
                try:
                    os.unlink(name, dir_fd=generation_fd)
                except FileNotFoundError:
                    pass
            os.fsync(generation_fd)
        if generation_fd >= 0:
            os.close(generation_fd)
        if created:
            try:
                os.rmdir(temporary, dir_fd=generations_fd)
            except FileNotFoundError:
                pass


def _publish(output_fd: int, report: dict[str, object]) -> None:
    try:
        lock_fd = os.open(
            ".evaluation.lock",
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
            0o600,
            dir_fd=output_fd,
        )
    except OSError as error:
        raise EvaluationError("evaluation output lock must be a regular file") from error
    try:
        if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
            raise EvaluationError("evaluation output lock must be a regular file")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        aliases = {
            OUTPUT_JSON: ".evaluation-current/evaluation.json",
            OUTPUT_MARKDOWN: ".evaluation-current/evaluation.md",
        }
        existing_aliases = {
            name: _verify_alias(output_fd, name, target) for name, target in aliases.items()
        }
        try:
            current_info = os.stat(".evaluation-current", dir_fd=output_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISLNK(current_info.st_mode):
                raise EvaluationError("conflicting evaluation output path: .evaluation-current")
            current_target = os.readlink(".evaluation-current", dir_fd=output_fd)
            if re.fullmatch(r"\.evaluation-generations/[0-9a-f]{64}", current_target) is None:
                raise EvaluationError("conflicting evaluation output path: .evaluation-current")
        try:
            os.mkdir(".evaluation-generations", 0o700, dir_fd=output_fd)
            os.fsync(output_fd)
        except FileExistsError:
            pass
        generations_fd = os.open(
            ".evaluation-generations",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=output_fd,
        )
        try:
            files = {
                OUTPUT_JSON: _encoded_json(report),
                OUTPUT_MARKDOWN: _markdown(report).encode("utf-8"),
            }
            _create_generation(generations_fd, report["report_id"], files)
        finally:
            os.close(generations_fd)
        for name, target in aliases.items():
            if not existing_aliases[name]:
                os.symlink(target, name, dir_fd=output_fd)
        os.fsync(output_fd)
        temporary_pointer = f".evaluation-current.tmp-{uuid.uuid4().hex}"
        try:
            os.symlink(
                f".evaluation-generations/{report['report_id']}",
                temporary_pointer,
                dir_fd=output_fd,
            )
            os.replace(
                temporary_pointer,
                ".evaluation-current",
                src_dir_fd=output_fd,
                dst_dir_fd=output_fd,
            )
            os.fsync(output_fd)
        finally:
            try:
                os.unlink(temporary_pointer, dir_fd=output_fd)
            except FileNotFoundError:
                pass
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def read_evaluation_report_pair(output_dir: str | Path) -> tuple[dict[str, object], str]:
    """Read one report pair by pinning the current immutable generation once."""
    output_fd = _open_output_directory(Path(output_dir), create=False)
    generation_fd = -1
    try:
        target = os.readlink(".evaluation-current", dir_fd=output_fd)
        match = re.fullmatch(r"\.evaluation-generations/([0-9a-f]{64})", target)
        if match is None:
            raise EvaluationError("evaluation current pointer is invalid")
        generations_fd = os.open(
            ".evaluation-generations",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=output_fd,
        )
        try:
            generation_fd = os.open(
                match.group(1),
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=generations_fd,
            )
        finally:
            os.close(generations_fd)
        json_raw = _read_relative_regular(generation_fd, OUTPUT_JSON, MAX_INPUT_BYTES)
        markdown_raw = _read_relative_regular(generation_fd, OUTPUT_MARKDOWN, MAX_INPUT_BYTES)
        payload = _decode_json(json_raw, "evaluation report")
        if (
            not isinstance(payload, dict)
            or payload.get("report_id") != match.group(1)
            or _report_id(payload) != match.group(1)
        ):
            raise EvaluationError("evaluation report generation binding is invalid")
        markdown = markdown_raw.decode("utf-8", errors="strict")
        if match.group(1) not in markdown:
            raise EvaluationError("evaluation Markdown generation binding is invalid")
        return payload, markdown
    except (OSError, UnicodeError) as error:
        raise EvaluationError("cannot read evaluation report pair") from error
    finally:
        if generation_fd >= 0:
            os.close(generation_fd)
        os.close(output_fd)


def evaluate_jobs(
    registry_path: str | Path,
    job_dirs: list[str | Path],
    output_dir: str | Path,
    *,
    top_k: int = 5,
) -> dict[str, object]:
    """Validate metadata-only jobs and atomically publish deterministic JSON/Markdown."""
    if not isinstance(job_dirs, list) or not 1 <= len(job_dirs) <= MAX_JOBS:
        raise EvaluationError(f"job_dirs must contain 1..{MAX_JOBS} paths")
    if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k <= 0:
        raise EvaluationError("top_k must be a positive integer")
    jobs = [_safe_directory(Path(path), "job directory") for path in job_dirs]
    resolved = [job.resolve() for job in jobs]
    if len(set(resolved)) != len(resolved):
        raise EvaluationError("duplicate job directories are not allowed")
    registry, registry_fingerprint = _read_registry(Path(registry_path))
    by_job = {job.name: job for job in jobs}
    expected_jobs = {source["job_id"] for source in registry}
    if set(by_job) != expected_jobs or len(jobs) != len(registry):
        raise EvaluationError("registry job_id values must match --job directory names exactly")

    source_reports: list[dict[str, object]] = []
    warnings: list[str] = []
    for source in sorted(registry, key=lambda item: item["source_id"]):
        source_report, source_warnings = _source_report(source, by_job[source["job_id"]], top_k)
        source_reports.append(source_report)
        warnings.extend(f"{source['source_id']}:{warning}" for warning in source_warnings)
    report = {
        "schema_version": SCHEMA_VERSION,
        "registry_sha256": hashlib.sha256(registry_fingerprint).hexdigest(),
        "registry_hash_basis": "credential-stripped-canonical-registry-v1",
        "top_k": top_k,
        "sources": source_reports,
        "aggregate": _aggregate(source_reports, warnings, top_k),
    }
    report["report_id"] = _report_id(report)
    output_fd = _open_output_directory(Path(output_dir))
    try:
        _publish(output_fd, report)
    except EvaluationError:
        raise
    except OSError as error:
        raise EvaluationError("cannot atomically publish evaluation outputs") from error
    finally:
        os.close(output_fd)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--job", action="append", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args(argv)
    try:
        evaluate_jobs(
            Path(args.registry),
            [Path(path) for path in args.job],
            Path(args.output_dir),
            top_k=args.top_k,
        )
    except EvaluationError as error:
        print(f"evaluation_error: {error}", file=sys.stderr)
        return 2
    except UnicodeError:
        print("evaluation_error: invalid Unicode input", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
