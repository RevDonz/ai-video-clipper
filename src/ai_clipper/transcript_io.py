"""Strict, atomic ``transcript.json`` persistence with optional word timestamps.

Document shape (the top level keeps exactly ``language`` and ``segments``)::

    {"language": "id",
     "segments": [{"start": 1.0, "end": 2.5, "text": "...",
                   "words": [{"start": 1.02, "end": 1.3, "text": "Gue", "probability": 0.93}]}]}

``words`` is omitted when empty and ``probability`` when unknown. Readers accept segments
with and without ``words``. Segment starts must be chronological; an overlap of at most
``MAX_SEGMENT_OVERLAP`` seconds (caption converters produce a few milliseconds) is repaired
by moving the later start to the earlier end, so loaded segments never overlap. Error
messages never echo transcript text.
"""

from __future__ import annotations

import errno
import json
import math
import os
import secrets
import stat
import unicodedata
from numbers import Real
from pathlib import Path

from .models import Transcription, TranscriptSegment, TranscriptWord

MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024
MAX_SEGMENTS = 100_000
MAX_WORDS_PER_SEGMENT = 10_000
MAX_LANGUAGE_LENGTH = 64
MAX_SEGMENT_OVERLAP = 0.25
TIME_DECIMALS = 3
_TIME_QUANTUM = 10**-TIME_DECIMALS

_TOP_LEVEL = frozenset({"language", "segments"})
_SEGMENT_REQUIRED = frozenset({"start", "end", "text"})
_SEGMENT_OPTIONAL = frozenset({"words"})
_WORD_REQUIRED = frozenset({"start", "end", "text"})
_WORD_OPTIONAL = frozenset({"probability"})


class TranscriptFormatError(ValueError):
    """A transcript document is malformed or unreadable as strict JSON."""


def _fields(
    value: object, required: frozenset[str], optional: frozenset[str], label: str
) -> dict[str, object]:
    if type(value) is not dict:
        raise TranscriptFormatError(f"{label} must be an object")
    keys = set(value)
    if not required <= keys or not keys <= required | optional:
        raise TranscriptFormatError(f"{label} has missing or unknown fields")
    return value


def _number(value: object, label: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TranscriptFormatError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise TranscriptFormatError(f"{label} must be finite")
    return result


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TranscriptFormatError(f"{label} must be a non-empty string")
    if any(unicodedata.category(character) == "Cs" for character in value):
        raise TranscriptFormatError(f"{label} contains a non-Unicode scalar value")
    return value


def words_from_payload(value: object, *, label: str = "words") -> tuple[TranscriptWord, ...]:
    """Validate a JSON ``words`` array into chronological :class:`TranscriptWord` values."""
    if type(value) is not list:
        raise TranscriptFormatError(f"{label} must be an array")
    if len(value) > MAX_WORDS_PER_SEGMENT:
        raise TranscriptFormatError(f"{label} must contain at most {MAX_WORDS_PER_SEGMENT} items")
    words: list[TranscriptWord] = []
    for index, raw in enumerate(value):
        item_label = f"{label} {index}"
        item = _fields(raw, _WORD_REQUIRED, _WORD_OPTIONAL, item_label)
        start = _number(item["start"], f"{item_label} start")
        end = _number(item["end"], f"{item_label} end")
        text = _text(item["text"], f"{item_label} text")
        probability = item.get("probability")
        if probability is not None:
            probability = _number(probability, f"{item_label} probability")
        try:
            word = TranscriptWord(start, end, text, probability)
        except (TypeError, ValueError) as error:
            raise TranscriptFormatError(f"{item_label} is invalid") from error
        if words and word.start < words[-1].start:
            raise TranscriptFormatError(f"{label} must be chronological")
        words.append(word)
    return tuple(words)


def segment_from_payload(value: object, *, label: str = "segment") -> TranscriptSegment:
    """Validate one JSON segment (with or without ``words``) into a segment."""
    item = _fields(value, _SEGMENT_REQUIRED, _SEGMENT_OPTIONAL, label)
    start = _number(item["start"], f"{label} start")
    end = _number(item["end"], f"{label} end")
    text = _text(item["text"], f"{label} text")
    words = words_from_payload(item["words"], label=f"{label} words") if "words" in item else ()
    try:
        return TranscriptSegment(start, end, text, words)
    except (TypeError, ValueError) as error:
        raise TranscriptFormatError(f"{label} is invalid") from error


def _repair_small_overlap(
    segment: TranscriptSegment, previous_end: float, label: str
) -> TranscriptSegment:
    if segment.start >= previous_end:
        return segment
    if previous_end - segment.start > MAX_SEGMENT_OVERLAP or segment.end <= previous_end:
        raise TranscriptFormatError(f"{label} overlaps the previous segment")
    return TranscriptSegment(previous_end, segment.end, segment.text, segment.words)


def transcription_from_dict(payload: object) -> Transcription:
    """Strictly validate a decoded transcript document (see the module docstring)."""
    document = _fields(payload, _TOP_LEVEL, frozenset(), "transcript")
    language = document["language"]
    if not isinstance(language, str) or not language.strip():
        raise TranscriptFormatError("transcript language must be a non-empty string")
    if len(language) > MAX_LANGUAGE_LENGTH:
        raise TranscriptFormatError("transcript language is too long")
    raw_segments = document["segments"]
    if type(raw_segments) is not list:
        raise TranscriptFormatError("transcript segments must be an array")
    if len(raw_segments) > MAX_SEGMENTS:
        raise TranscriptFormatError(f"transcript must contain at most {MAX_SEGMENTS} segments")
    segments: list[TranscriptSegment] = []
    for index, raw in enumerate(raw_segments):
        label = f"transcript segment {index}"
        segment = segment_from_payload(raw, label=label)
        if segments:
            if segment.start < segments[-1].start:
                raise TranscriptFormatError("transcript segments must be chronological")
            segment = _repair_small_overlap(segment, segments[-1].end, label)
        segments.append(segment)
    return Transcription(language, segments)


def _rounded(value: float) -> float:
    return round(float(value), TIME_DECIMALS)


def _word_to_dict(word: TranscriptWord) -> dict[str, object]:
    start = _rounded(word.start)
    payload: dict[str, object] = {
        "start": start,
        "end": max(start, _rounded(word.end)),
        "text": word.text,
    }
    if word.probability is not None:
        payload["probability"] = round(float(word.probability), TIME_DECIMALS)
    return payload


def _segment_to_dict(segment: TranscriptSegment, previous_end: float) -> dict[str, object]:
    # Rounding is monotonic, so it never creates an overlap by itself; widening a segment that
    # rounds to zero length can, so a start is never allowed before the previous written end.
    start = max(_rounded(segment.start), previous_end)
    end = _rounded(segment.end)
    if end <= start:
        end = _rounded(start + _TIME_QUANTUM)
    payload: dict[str, object] = {"start": start, "end": end, "text": segment.text}
    if segment.words:
        payload["words"] = [_word_to_dict(word) for word in segment.words]
    return payload


def transcription_to_dict(transcription: Transcription) -> dict[str, object]:
    """Serialize with times rounded to milliseconds; empty ``words`` are omitted.

    Written segments never overlap (a start is clamped to the previous written end), so the
    output passes the strict readers in ``evaluation`` and ``candidate_cues``.
    """
    if not isinstance(transcription, Transcription):
        raise TypeError("transcription must be a Transcription")
    if any(not isinstance(segment, TranscriptSegment) for segment in transcription.segments):
        raise TypeError("transcription segments must be TranscriptSegment values")
    segments: list[dict[str, object]] = []
    previous_end = 0.0
    for segment in transcription.segments:
        payload = _segment_to_dict(segment, previous_end)
        previous_end = float(payload["end"])  # type: ignore[arg-type]
        segments.append(payload)
    return {"language": transcription.language, "segments": segments}


def _encode(transcription: Transcription) -> bytes:
    """Readable and compact: one segment per line instead of one line per word field."""
    document = transcription_to_dict(transcription)
    segments = document["segments"]
    assert isinstance(segments, list)
    lines = [
        "{",
        f'  "language": {json.dumps(document["language"], ensure_ascii=False)},',
        '  "segments": [',
    ]
    for index, segment in enumerate(segments):
        separator = "," if index + 1 < len(segments) else ""
        encoded = json.dumps(segment, ensure_ascii=False, allow_nan=False)
        lines.append(f"    {encoded}{separator}")
    lines.extend(["  ]", "}"])
    return ("\n".join(lines) + "\n").encode("utf-8")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_bytes(path: str | Path, data: bytes) -> None:
    """Write ``data`` to a sibling temporary file, fsync it, then ``os.replace`` it into place."""
    if not isinstance(data, bytes):
        raise TypeError("data must be bytes")
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    pending = destination.with_name(f".{destination.name}.{secrets.token_hex(8)}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(pending, flags, 0o666)
    try:
        try:
            view = memoryview(data)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(pending, destination)
    except BaseException:
        pending.unlink(missing_ok=True)
        raise
    _fsync_directory(destination.parent)


def write_transcript_json(path: str | Path, transcription: Transcription) -> None:
    """Atomically publish ``transcription`` as ``transcript.json``."""
    atomic_write_bytes(path, _encode(transcription))


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise TranscriptFormatError("transcript contains a duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise TranscriptFormatError("transcript contains a non-standard JSON number")


def _read_bounded(path: Path, limit: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except IsADirectoryError:
        raise TranscriptFormatError("transcript must be a regular file") from None
    except OSError as error:
        if error.errno == errno.EISDIR:
            raise TranscriptFormatError("transcript must be a regular file") from None
        raise
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise TranscriptFormatError("transcript must be a regular file")
        if info.st_size > limit:
            raise TranscriptFormatError(f"transcript must be at most {limit} bytes")
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(descriptor, min(1024 * 1024, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise TranscriptFormatError(f"transcript must be at most {limit} bytes")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def transcription_from_json_bytes(raw: bytes) -> Transcription:
    """Decode strict UTF-8 JSON (no duplicate keys, no NaN/Infinity) and validate it."""
    if not isinstance(raw, bytes):
        raise TypeError("transcript input must be bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise TranscriptFormatError("transcript must contain valid UTF-8") from error
    try:
        payload = json.loads(
            text, object_pairs_hook=_reject_duplicate_keys, parse_constant=_reject_constant
        )
    except TranscriptFormatError:
        raise
    except (ValueError, RecursionError) as error:
        raise TranscriptFormatError("transcript must contain valid strict JSON") from error
    return transcription_from_dict(payload)


def read_transcript_json(
    path: str | Path, *, max_bytes: int = MAX_TRANSCRIPT_BYTES
) -> Transcription:
    """Read and strictly validate a transcript file of at most ``max_bytes`` bytes.

    Missing files raise :class:`FileNotFoundError`; malformed content raises
    :class:`TranscriptFormatError`.
    """
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes <= 0:
        raise ValueError("max_bytes must be a positive integer")
    return transcription_from_json_bytes(_read_bounded(Path(path), max_bytes))
