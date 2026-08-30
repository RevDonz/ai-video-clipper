"""Authoritative candidate caption-cue sanitizer over a bounded stdin envelope."""

from __future__ import annotations

import hashlib
import json
import math
import re
import struct
import sys
import unicodedata
from numbers import Real
from typing import BinaryIO, TextIO

from .candidate_api import _strict_payload
from .ranking import MAX_ARTIFACT_BYTES, CandidatesArtifact

MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
MAX_SEGMENTS = 100_000
MAX_TEXT_LENGTH = 100_000
MAX_LANGUAGE_LENGTH = 64
BOUNDARY_TOLERANCE_SECONDS = 1e-6
_CANDIDATE_ID = re.compile(r"^cand_[0-9a-f]{64}$")
_HEADER = struct.Struct(">QQH")
_INVALID = "candidate_cues_invalid\n"
_NOT_FOUND = "candidate_cues_not_found\n"


class CandidateNotFoundError(ValueError):
    """The requested ID is well formed but absent from the validated artifact."""


def _number(value: object) -> float:
    if not isinstance(value, Real) or isinstance(value, bool) or not math.isfinite(value):
        raise ValueError("timestamp must be a finite number")
    return float(value)


def _clean_text(value: object, *, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError("text is invalid")
    if any(unicodedata.category(character).startswith("C") for character in value):
        raise ValueError("text contains a control character")
    return value


def _parse_transcript(encoded: bytes) -> list[tuple[int, float, float, str]]:
    if not isinstance(encoded, bytes):
        raise TypeError("transcript input must be bytes")
    if len(encoded) > MAX_TRANSCRIPT_BYTES:
        raise ValueError("transcript input exceeds size limit")
    payload = _strict_payload(encoded)
    if type(payload) is not dict or set(payload) != {"language", "segments"}:
        raise ValueError("transcript must contain exact fields")
    _clean_text(payload["language"], maximum=MAX_LANGUAGE_LENGTH)
    segments = payload["segments"]
    if not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise ValueError("transcript segments exceed limit or are invalid")

    parsed: list[tuple[int, float, float, str]] = []
    previous_end = 0.0
    for index, segment in enumerate(segments):
        if type(segment) is not dict or set(segment) != {"start", "end", "text"}:
            raise ValueError("transcript segment must contain exact fields")
        start = _number(segment["start"])
        end = _number(segment["end"])
        text = _clean_text(segment["text"], maximum=MAX_TEXT_LENGTH)
        if start < 0 or end <= start or (index and start < previous_end):
            raise ValueError("transcript segments must be ordered and non-overlapping")
        parsed.append((index, start, end, text))
        previous_end = end
    return parsed


def cues_from_bytes(
    artifact_bytes: bytes, transcript_bytes: bytes, candidate_id: str
) -> dict[str, object]:
    """Validate both artifacts and return a source-free, segment-timed cue DTO."""
    if not isinstance(candidate_id, str) or not _CANDIDATE_ID.fullmatch(candidate_id):
        raise ValueError("candidate ID is invalid")
    if not isinstance(artifact_bytes, bytes) or len(artifact_bytes) > MAX_ARTIFACT_BYTES:
        raise ValueError("candidate artifact exceeds size limit")
    artifact = CandidatesArtifact.from_dict(_strict_payload(artifact_bytes))
    candidate = next(
        (item for item in artifact.candidates if item.candidate_id == candidate_id), None
    )
    if candidate is None:
        raise CandidateNotFoundError()
    segments = _parse_transcript(transcript_bytes)

    cues: list[dict[str, object]] = []
    duration = candidate.end - candidate.start
    for index, start, end, text in segments:
        if start < candidate.start - BOUNDARY_TOLERANCE_SECONDS:
            continue
        if end > candidate.end + BOUNDARY_TOLERANCE_SECONDS:
            continue
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        relative_start = min(duration, max(0.0, start - candidate.start))
        relative_end = min(duration, max(0.0, end - candidate.start))
        if relative_end <= relative_start:
            continue
        cues.append(
            {
                "id": f"cue_{index:06d}_{text_hash[:16]}",
                "start": relative_start,
                "end": relative_end,
                "text": text,
                "originalTextSha256": text_hash,
            }
        )

    return {
        "candidateId": candidate.candidate_id,
        "candidateArtifactSha256": hashlib.sha256(artifact_bytes).hexdigest(),
        "selectionVersion": artifact.selection_version,
        "timingProvenance": "segment-v1",
        "wordTiming": False,
        "cues": cues,
    }


def encode_envelope(artifact: bytes, transcript: bytes, candidate_id: str) -> bytes:
    """Create the path-free binary protocol consumed by :func:`run`."""
    encoded_id = candidate_id.encode("ascii")
    if len(encoded_id) > 256:
        raise ValueError("candidate ID is too long")
    return (
        _HEADER.pack(len(artifact), len(transcript), len(encoded_id))
        + artifact
        + transcript
        + encoded_id
    )


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise ValueError("truncated envelope")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def run(stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO) -> int:
    """Consume one bounded envelope, emitting only fixed sanitized failures."""
    try:
        header = _read_exact(stdin, _HEADER.size)
        artifact_length, transcript_length, id_length = _HEADER.unpack(header)
        if (
            artifact_length > MAX_ARTIFACT_BYTES
            or transcript_length > MAX_TRANSCRIPT_BYTES
            or id_length > 256
        ):
            raise ValueError("envelope length exceeds limit")
        artifact = _read_exact(stdin, artifact_length)
        transcript = _read_exact(stdin, transcript_length)
        candidate_id = _read_exact(stdin, id_length).decode("ascii")
        if stdin.read(1):
            raise ValueError("trailing envelope bytes")
        output = cues_from_bytes(artifact, transcript, candidate_id)
        stdout.write(
            json.dumps(output, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
                "utf-8"
            )
        )
        stdout.write(b"\n")
        return 0
    except CandidateNotFoundError:
        stderr.write(_NOT_FOUND)
        return 3
    except Exception:  # noqa: BLE001 - protocol boundary intentionally sanitizes every failure
        stderr.write(_INVALID)
        return 2


def main() -> int:
    return run(sys.stdin.buffer, sys.stdout.buffer, sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
