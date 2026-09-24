"""Transcript quality gate: punctuation collapse, repetition loops, script and timing checks.

Warning codes are stable and machine-readable:

``no_word_timestamps``
    No segment carries word timings.
``quantized_timestamps``
    More than 80% of segment durations are whole seconds (at least 5 segments).
``no_punctuation``
    The whole file has at least 20 segments and fewer than 20% of them end in ``.?!``. This
    covers a fully collapsed file (e.g. Whisper output without any punctuation), which
    ``punctuation_collapse`` cannot report because it needs one well-punctuated block to
    compare against. Both codes may appear together.
``punctuation_collapse:<start_s>-<end_s>``
    Adjacent 300 s blocks whose share of segments ending in ``.?!`` is below 0.2 while at
    least one block of the same file reaches 0.6 (Whisper stopped punctuating).
``repetition_loop:<first_idx>-<last_idx>``
    At least 4 consecutive segments with the same normalized text, or a 2–8 word phrase
    repeated at least 4 times back-to-back (a single word needs 6 repeats, because short
    stutters such as "iya iya iya iya" are natural speech). A phrase loop must make up most
    of at least one segment it touches; a short rhetorical repeat inside a longer sentence
    is natural speech. Hyphenated reduplication ("gara-gara") is one token. Laughter is
    exempt.
``script_mismatch:<idx>``
    A segment of a Latin-script language contains CJK, Hangul, Kana, Arabic, Cyrillic or
    Thai characters.
``low_confidence:<idx>``
    Mean word probability below 0.35 over at least 3 scored words.

File-level codes come first, in this order: ``no_word_timestamps``,
``quantized_timestamps``, ``no_punctuation``, ``punctuation_collapse:*``; per-segment codes
follow by segment index.

Segments with repetition loops, script mismatch, low confidence, or no letters/digits at
all (garbage) are listed in ``suspect_segment_indices``.
"""

from __future__ import annotations

import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from numbers import Real
from pathlib import Path

from .models import TranscriptSegment
from .transcript_io import atomic_write_bytes

QUALITY_VERSION = "transcript-quality-v1"
BLOCK_SECONDS = 300.0
COLLAPSE_RATIO = 0.2
GOOD_BLOCK_RATIO = 0.6
MIN_BLOCK_SEGMENTS = 5
NO_PUNCTUATION_RATIO = 0.2
NO_PUNCTUATION_MIN_SEGMENTS = 20
LOOP_MIN_SEGMENTS = 4
PHRASE_MAX_WORDS = 8
PHRASE_MIN_REPEATS = 4
SINGLE_WORD_MIN_REPEATS = 6
LOW_CONFIDENCE_PROBABILITY = 0.35
LOW_CONFIDENCE_MIN_WORDS = 3
QUANTIZED_RATIO = 0.8
QUANTIZED_MIN_SEGMENTS = 5
INTEGER_TOLERANCE = 1e-3
_RATIO_DECIMALS = 4
_TIME_DECIMALS = 3

LATIN_SCRIPT_LANGUAGES = frozenset(
    {
        "af", "az", "br", "bs", "ca", "cs", "cy", "da", "de", "en", "es", "et", "eu", "fi",
        "fo", "fr", "gl", "ha", "haw", "hr", "ht", "hu", "id", "is", "it", "jv", "jw", "la",
        "lb", "ln", "lt", "lv", "mg", "mi", "ms", "mt", "nl", "nn", "no", "oc", "pl", "pt",
        "ro", "sk", "sl", "sn", "so", "sq", "su", "sv", "sw", "tk", "tl", "tr", "uz", "vi",
        "yo",
    }
)  # fmt: skip

_TERMINAL = frozenset(".?!。？！")
_CLOSERS = "\"'”’»)]}」』"
_FOREIGN_SCRIPT = re.compile(
    "["
    "Ѐ-ԯ"  # Cyrillic and Cyrillic Supplement
    "؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ"  # Arabic
    "฀-๿"  # Thai
    "ᄀ-ᇿ㄰-㆏가-힯"  # Hangul
    "぀-ヿㇰ-ㇿｦ-ﾟ"  # Hiragana and Katakana
    "㐀-䶿一-鿿豈-﫿\U00020000-\U0002fa1f"  # CJK ideographs
    "]"
)
_TOKEN = re.compile(r"[^\W_]+(?:[-'’][^\W_]+)*")
_LAUGHTER = re.compile(r"(?:ha|he|hi|hu|ah|eh|wk|kw|xi)+h?")
_WARNING = re.compile(
    r"(no_word_timestamps|quantized_timestamps|no_punctuation|punctuation_collapse:\d+-\d+"
    r"|repetition_loop:\d+-\d+|script_mismatch:\d+|low_confidence:\d+)"
)


def _ratio(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be finite and between 0 and 1")
    return float(value)


def _time(value: object, name: str) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and non-negative")
    return float(value)


@dataclass(frozen=True, slots=True)
class TranscriptQuality:
    """Measured transcript health; see the module docstring for warning codes."""

    punctuated_ratio: float
    punctuation_blocks: tuple[tuple[float, float, float], ...]
    integer_duration_ratio: float
    has_word_timestamps: bool
    suspect_segment_indices: tuple[int, ...]
    warnings: tuple[str, ...]

    def __post_init__(self) -> None:
        _ratio(self.punctuated_ratio, "punctuated_ratio")
        _ratio(self.integer_duration_ratio, "integer_duration_ratio")
        if not isinstance(self.punctuation_blocks, tuple):
            raise TypeError("punctuation_blocks must be a tuple")
        for block in self.punctuation_blocks:
            if not isinstance(block, tuple) or len(block) != 3:
                raise TypeError("each punctuation block must be a (start, end, ratio) tuple")
            start = _time(block[0], "punctuation block start")
            end = _time(block[1], "punctuation block end")
            _ratio(block[2], "punctuation block ratio")
            if end < start:
                raise ValueError("punctuation block end must not precede its start")
        if not isinstance(self.has_word_timestamps, bool):
            raise TypeError("has_word_timestamps must be a bool")
        if not isinstance(self.suspect_segment_indices, tuple):
            raise TypeError("suspect_segment_indices must be a tuple")
        previous = -1
        for index in self.suspect_segment_indices:
            if not isinstance(index, int) or isinstance(index, bool):
                raise TypeError("suspect segment indices must be integers")
            if index <= previous:
                raise ValueError("suspect segment indices must be unique, sorted and >= 0")
            previous = index
        if not isinstance(self.warnings, tuple):
            raise TypeError("warnings must be a tuple")
        if any(not isinstance(code, str) or not code for code in self.warnings):
            raise ValueError("warnings must be non-empty strings")

    def to_dict(self) -> dict[str, object]:
        return {
            "version": QUALITY_VERSION,
            "punctuated_ratio": self.punctuated_ratio,
            "punctuation_blocks": [
                {"start": start, "end": end, "ratio": ratio}
                for start, end, ratio in self.punctuation_blocks
            ],
            "integer_duration_ratio": self.integer_duration_ratio,
            "has_word_timestamps": self.has_word_timestamps,
            "suspect_segment_indices": list(self.suspect_segment_indices),
            "warnings": list(self.warnings),
        }

    @classmethod
    def from_dict(cls, payload: object) -> TranscriptQuality:
        expected = {
            "version",
            "punctuated_ratio",
            "punctuation_blocks",
            "integer_duration_ratio",
            "has_word_timestamps",
            "suspect_segment_indices",
            "warnings",
        }
        if type(payload) is not dict or set(payload) != expected:
            raise ValueError("transcript quality payload has missing or unknown fields")
        if payload["version"] != QUALITY_VERSION:
            raise ValueError("unsupported transcript quality version")
        blocks = payload["punctuation_blocks"]
        if type(blocks) is not list:
            raise TypeError("punctuation_blocks must be an array")
        parsed_blocks = []
        for block in blocks:
            if type(block) is not dict or set(block) != {"start", "end", "ratio"}:
                raise ValueError("punctuation block has missing or unknown fields")
            parsed_blocks.append((block["start"], block["end"], block["ratio"]))
        for name in ("suspect_segment_indices", "warnings"):
            if type(payload[name]) is not list:
                raise TypeError(f"{name} must be an array")
        return cls(
            punctuated_ratio=payload["punctuated_ratio"],
            punctuation_blocks=tuple(parsed_blocks),
            integer_duration_ratio=payload["integer_duration_ratio"],
            has_word_timestamps=payload["has_word_timestamps"],
            suspect_segment_indices=tuple(payload["suspect_segment_indices"]),
            warnings=tuple(payload["warnings"]),
        )


def write_transcript_quality_json(path: str | Path, quality: TranscriptQuality) -> None:
    """Atomically publish ``analysis/transcript-quality.json``."""
    if not isinstance(quality, TranscriptQuality):
        raise TypeError("quality must be a TranscriptQuality")
    encoded = json.dumps(quality.to_dict(), ensure_ascii=False, indent=2, allow_nan=False)
    atomic_write_bytes(path, (encoded + "\n").encode("utf-8"))


def is_warning_code(code: object) -> bool:
    """True when ``code`` is one of the documented transcript-quality warning codes."""
    return isinstance(code, str) and _WARNING.fullmatch(code) is not None


def ends_with_terminal_punctuation(text: str) -> bool:
    """True when ``text`` ends in ``. ? !`` (or fullwidth forms) after closing quotes/brackets."""
    stripped = text.rstrip().rstrip(_CLOSERS).rstrip()
    return bool(stripped) and stripped[-1] in _TERMINAL


def _normalized_tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.casefold())


def _is_laughter(tokens: Sequence[str]) -> bool:
    return bool(tokens) and all(_LAUGHTER.fullmatch(token) for token in tokens)


def _language_uses_latin_script(language: str) -> bool:
    return re.split(r"[-_]", language.strip().casefold(), maxsplit=1)[0] in LATIN_SCRIPT_LANGUAGES


def _punctuation_blocks(
    segments: Sequence[TranscriptSegment], punctuated: Sequence[bool]
) -> list[tuple[int, float, float, float, int]]:
    """Return ``(block_number, start, end, ratio, count)`` per non-empty block."""
    counts: dict[int, list[int]] = {}
    for segment, is_punctuated in zip(segments, punctuated, strict=True):
        bucket = counts.setdefault(int(segment.start // BLOCK_SECONDS), [0, 0])
        bucket[0] += 1
        bucket[1] += int(is_punctuated)
    file_end = max(segment.end for segment in segments)
    blocks = []
    for number in sorted(counts):
        total, marked = counts[number]
        start = number * BLOCK_SECONDS
        end = min((number + 1) * BLOCK_SECONDS, file_end)
        blocks.append(
            (
                number,
                round(start, _TIME_DECIMALS),
                round(end, _TIME_DECIMALS),
                round(marked / total, _RATIO_DECIMALS),
                total,
            )
        )
    return blocks


def _collapse_warnings(blocks: Sequence[tuple[int, float, float, float, int]]) -> list[str]:
    evaluated = [block for block in blocks if block[4] >= MIN_BLOCK_SEGMENTS]
    if not any(block[3] >= GOOD_BLOCK_RATIO for block in evaluated):
        return []
    warnings: list[str] = []
    run: list[tuple[int, float, float, float, int]] = []
    for block in [*evaluated, None]:
        if block is not None and block[3] < COLLAPSE_RATIO:
            run.append(block)
            continue
        if run:
            warnings.append(f"punctuation_collapse:{round(run[0][1])}-{round(run[-1][2])}")
            run = []
    return warnings


def _identical_segment_loops(normalized: Sequence[str]) -> list[tuple[int, int]]:
    loops: list[tuple[int, int]] = []
    first = 0
    for index in range(1, len(normalized) + 1):
        if index < len(normalized) and normalized[index] == normalized[first]:
            continue
        if index - first >= LOOP_MIN_SEGMENTS and not _is_laughter(normalized[first].split()):
            loops.append((first, index - 1))
        first = index
    return loops


def _phrase_loop_owners(start: int, stop: int, owners: Sequence[int]) -> tuple[int, int] | None:
    """Segments owning more than half of their tokens inside ``[start, stop)``."""
    inside: dict[int, int] = {}
    for position in range(start, stop):
        inside[owners[position]] = inside.get(owners[position], 0) + 1
    outside: dict[int, int] = {}
    for positions in (range(start - 1, -1, -1), range(stop, len(owners))):
        for position in positions:
            if owners[position] not in inside:
                break
            outside[owners[position]] = outside.get(owners[position], 0) + 1
    majority = [segment for segment, count in inside.items() if count > outside.get(segment, 0)]
    return (min(majority), max(majority)) if majority else None


def _phrase_loops(tokens: Sequence[str], owners: Sequence[int]) -> list[tuple[int, int]]:
    """Find a phrase of 1..8 tokens repeated back-to-back; returns segment index ranges.

    For a period ``size``, a run of ``length`` positions where ``tokens[k] == tokens[k+size]``
    covers ``length + size`` tokens, i.e. ``(length + size) // size`` repeats.
    """
    loops: list[tuple[int, int]] = []
    total = len(tokens)
    for size in range(1, PHRASE_MAX_WORDS + 1):
        needed = SINGLE_WORD_MIN_REPEATS if size == 1 else PHRASE_MIN_REPEATS
        position = 0
        limit = total - size
        while position < limit:
            if tokens[position] != tokens[position + size]:
                position += 1
                continue
            run_end = position
            while run_end < limit and tokens[run_end] == tokens[run_end + size]:
                run_end += 1
            length = run_end - position
            if (length + size) // size >= needed and not _is_laughter(
                tokens[position : position + size]
            ):
                owned = _phrase_loop_owners(position, run_end + size, owners)
                if owned is not None:
                    loops.append(owned)
            position = run_end + 1
    return loops


def _merge_ranges(ranges: Sequence[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for first, last in sorted(ranges):
        if merged and first <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], last))
        else:
            merged.append((first, last))
    return merged


def assess_transcript(
    segments: Sequence[TranscriptSegment], *, language: str = "id"
) -> TranscriptQuality:
    """Measure transcript health; cheap enough to run on every transcript."""
    if not isinstance(language, str) or not language.strip():
        raise ValueError("language must be a non-empty string")
    segments = list(segments)
    if any(not isinstance(segment, TranscriptSegment) for segment in segments):
        raise TypeError("segments must be TranscriptSegment values")
    has_words = any(segment.words for segment in segments)
    if not segments:
        return TranscriptQuality(0.0, (), 0.0, False, (), ("no_word_timestamps",))

    punctuated = [ends_with_terminal_punctuation(segment.text) for segment in segments]
    blocks = _punctuation_blocks(segments, punctuated)
    integer_durations = sum(
        abs((duration := segment.end - segment.start) - round(duration)) <= INTEGER_TOLERANCE
        for segment in segments
    )
    integer_ratio = round(integer_durations / len(segments), _RATIO_DECIMALS)
    punctuated_ratio = round(sum(punctuated) / len(segments), _RATIO_DECIMALS)

    file_warnings: list[str] = []
    if not has_words:
        file_warnings.append("no_word_timestamps")
    if len(segments) >= QUANTIZED_MIN_SEGMENTS and integer_ratio > QUANTIZED_RATIO:
        file_warnings.append("quantized_timestamps")
    if len(segments) >= NO_PUNCTUATION_MIN_SEGMENTS and punctuated_ratio < NO_PUNCTUATION_RATIO:
        file_warnings.append("no_punctuation")
    file_warnings.extend(_collapse_warnings(blocks))

    token_lists = [_normalized_tokens(segment.text) for segment in segments]
    normalized = [
        " ".join(tokens) or segment.text.strip()
        for tokens, segment in zip(token_lists, segments, strict=True)
    ]
    tokens = [token for token_list in token_lists for token in token_list]
    owners = [index for index, token_list in enumerate(token_lists) for _ in token_list]
    loops = _merge_ranges(_identical_segment_loops(normalized) + _phrase_loops(tokens, owners))

    suspect: set[int] = set()
    indexed: list[tuple[int, int, str]] = []
    for first, last in loops:
        indexed.append((first, 0, f"repetition_loop:{first}-{last}"))
        suspect.update(range(first, last + 1))
    check_script = _language_uses_latin_script(language)
    for index, (segment, token_list) in enumerate(zip(segments, token_lists, strict=True)):
        if check_script and _FOREIGN_SCRIPT.search(segment.text):
            indexed.append((index, 1, f"script_mismatch:{index}"))
            suspect.add(index)
        scored = [word.probability for word in segment.words if word.probability is not None]
        if (
            len(scored) >= LOW_CONFIDENCE_MIN_WORDS
            and sum(scored) / len(scored) < LOW_CONFIDENCE_PROBABILITY
        ):
            indexed.append((index, 2, f"low_confidence:{index}"))
            suspect.add(index)
        if not token_list:
            suspect.add(index)
    indexed.sort()

    return TranscriptQuality(
        punctuated_ratio=punctuated_ratio,
        punctuation_blocks=tuple((start, end, ratio) for _n, start, end, ratio, _c in blocks),
        integer_duration_ratio=integer_ratio,
        has_word_timestamps=has_words,
        suspect_segment_indices=tuple(sorted(suspect)),
        warnings=tuple(file_warnings) + tuple(code for _i, _k, code in indexed),
    )
