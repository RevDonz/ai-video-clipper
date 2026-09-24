"""Punctuation-agnostic sentence units built from word timestamps or segments.

Units are the addressable atoms for clip selection (``S0001``, ``S0002``, ...). They are built
from words when a segment has word timings and from whole segments otherwise:

1. Split after terminal punctuation (``. ? !`` and fullwidth forms, ignoring closing
   quotes/brackets). An ellipsis (``...`` / ``…``) is terminal only before a gap of at
   least 0.3 s. Also split on any gap of at least ``pause_split`` seconds, and wherever the
   quality gate's suspect flag changes, so garbage stays confined to its own units.
2. Split units longer than ``max_words`` or ``max_seconds`` at their best internal
   boundary: the largest gap, plus small bonuses for soft punctuation (``, ; : …``), a
   Whisper segment boundary, a held word of at least 1 s on the left (ASR word timings often
   absorb the following pause), and an interrogative opener on the right. Ties go to the
   boundary closest to the middle. Very long runs (more than 4 x ``max_words``) only consider
   the middle half, which bounds the work at O(n log n).
3. Merge fragments shorter than ``min_words`` into the neighbour across the smaller gap
   (at most 1.5 s, same suspect flag, and within ``max_words + min_words`` words and
   ``max_seconds + 2`` s). Punctuation breaks near-ties: a fragment that ends a sentence
   leans backward, one that ends in a comma leans forward, and a question mark is never
   buried in the middle of a unit.

Question rule (:func:`looks_like_question`): the text ends with ``?`` (ignoring closing quotes
and brackets), or, after skipping up to two leading discourse words (oh, eh, nah, terus,
jadi, tapi, oke, ya, so, bang, ...), it opens with an interrogative. Strong openers always
count: apakah, kenapa, mengapa, gimana, bagaimana, siapa, kapan, dimana, di mana, berapa,
boleh tau/tahu, what, why, how, who. Weak openers (apa, emang, masa, pernah, when, where)
count only when the unit has at least two words and does not end in ``.`` or ``!``;
``masa`` followed by a time noun (masa kecil, masa lalu, ...) is never a question.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from numbers import Real

from .models import TranscriptSegment, TranscriptWord
from .transcript_quality import TranscriptQuality

ELLIPSIS_MIN_GAP = 0.3
MERGE_MAX_GAP = 1.5
MERGE_EXTRA_SECONDS = 2.0
LONG_RUN_FACTOR = 4
_MERGE_PREFERENCE_SECONDS = 0.25
_SOFT_BONUS = 0.25
_TERMINAL_BONUS = 0.5
_SEGMENT_BONUS = 0.1
_OPENER_BONUS = 0.1
_HELD_WORD_BONUS = 0.15
HELD_WORD_SECONDS = 1.0

_CLOSERS = "\"'”’»)]}」』"
_QUESTION_MARKS = frozenset("?？")
_STATEMENT_MARKS = frozenset(".!。！")
_SOFT_MARKS = frozenset(",;:，、；：-–—")
_EDGE_PUNCTUATION = re.compile(r"^[\W_]+|[\W_]+$")
_UNIT_ID = re.compile(r"S\d{4,}")

_LEADING_WORDS = frozenset(
    {
        "oh", "eh", "ah", "nah", "lho", "loh", "terus", "trus", "jadi", "tapi", "oke", "ok",
        "okay", "ya", "yaudah", "so", "and", "but", "well", "bang", "bro", "kak", "mas",
        "mbak", "pak", "bu",
    }
)  # fmt: skip
_STRONG_OPENERS = frozenset(
    {
        "apakah", "kenapa", "mengapa", "gimana", "bagaimana", "siapa", "kapan", "dimana",
        "berapa", "what", "why", "how", "who",
    }
)  # fmt: skip
_STRONG_PAIRS = frozenset({("di", "mana"), ("boleh", "tau"), ("boleh", "tahu")})
_WEAK_OPENERS = frozenset({"apa", "emang", "masa", "pernah", "when", "where"})
_MASA_NOUNS = frozenset(
    {
        "kecil", "lalu", "depan", "muda", "remaja", "sekolah", "kuliah", "sma", "smp", "sd",
        "pandemi", "tahanan", "hukuman", "jabatan", "transisi", "itu", "sekarang", "kini",
    }
)  # fmt: skip


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


@dataclass(frozen=True, slots=True)
class SentenceUnit:
    """One sentence-like span of speech, addressable by ``unit_id``."""

    unit_id: str
    index: int
    start: float
    end: float
    text: str
    segment_start: int
    segment_end: int
    word_count: int
    is_question: bool
    gap_before: float
    suspect: bool
    words: tuple[TranscriptWord, ...]

    def __post_init__(self) -> None:
        if not _is_int(self.index):
            raise TypeError("unit index must be an integer")
        if self.index < 0:
            raise ValueError("unit index must be non-negative")
        if not isinstance(self.unit_id, str):
            raise TypeError("unit_id must be a string")
        if not _UNIT_ID.fullmatch(self.unit_id) or int(self.unit_id[1:]) != self.index + 1:
            raise ValueError("unit_id must be 'S' plus the 1-based index, at least 4 digits")
        for name in ("start", "end", "gap_before"):
            value = getattr(self, name)
            if not _is_number(value):
                raise TypeError(f"unit {name} must be a number")
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"unit {name} must be finite and non-negative")
        if self.end < self.start:
            raise ValueError("unit end must not precede its start")
        if not isinstance(self.text, str):
            raise TypeError("unit text must be a string")
        if not self.text.strip():
            raise ValueError("unit text cannot be empty")
        if not _is_int(self.segment_start) or not _is_int(self.segment_end):
            raise TypeError("unit segment indices must be integers")
        if not 0 <= self.segment_start <= self.segment_end:
            raise ValueError("unit segment indices must satisfy 0 <= start <= end")
        if not _is_int(self.word_count):
            raise TypeError("unit word_count must be an integer")
        if self.word_count < 1:
            raise ValueError("unit word_count must be positive")
        if not isinstance(self.is_question, bool) or not isinstance(self.suspect, bool):
            raise TypeError("unit is_question and suspect must be booleans")
        if not isinstance(self.words, tuple) or any(
            not isinstance(word, TranscriptWord) for word in self.words
        ):
            raise TypeError("unit words must be a tuple of TranscriptWord values")

    @property
    def duration(self) -> float:
        return self.end - self.start


@dataclass(frozen=True, slots=True)
class _Atom:
    """A word (word mode) or a whole segment (segment mode) with its segment index."""

    start: float
    end: float
    text: str
    segment: int
    word: TranscriptWord | None
    word_count: int
    suspect: bool


def _ending(text: str) -> str:
    """Classify how ``text`` ends: question, terminal, ellipsis, soft, or ''."""
    stripped = text.rstrip().rstrip(_CLOSERS).rstrip()
    if not stripped:
        return ""
    if stripped[-1] in _QUESTION_MARKS:
        return "question"
    if stripped.endswith(("...", "…")):
        return "ellipsis"
    if stripped[-1] in _STATEMENT_MARKS:
        return "terminal"
    if stripped[-1] in _SOFT_MARKS:
        return "soft"
    return ""


def _tokens(text: str) -> list[str]:
    stripped = (_EDGE_PUNCTUATION.sub("", token) for token in text.casefold().split())
    return [token for token in stripped if token]


def looks_like_question(text: str) -> bool:
    """Apply the documented question rule to one unit of text."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    ending = _ending(text)
    if ending == "question":
        return True
    tokens = _tokens(text)
    position = 0
    while position < min(2, len(tokens)) and tokens[position] in _LEADING_WORDS:
        position += 1
    if position >= len(tokens):
        return False
    first = tokens[position]
    second = tokens[position + 1] if position + 1 < len(tokens) else ""
    if first in _STRONG_OPENERS or (first, second) in _STRONG_PAIRS:
        return True
    if first not in _WEAK_OPENERS or not second or ending == "terminal":
        return False
    return not (first == "masa" and second in _MASA_NOUNS)


def _opens_question(text: str) -> bool:
    tokens = _tokens(text)
    return bool(tokens) and tokens[0] in _STRONG_OPENERS


def _atoms(segments: Sequence[TranscriptSegment], suspect: frozenset[int]) -> list[_Atom]:
    atoms: list[_Atom] = []
    for index, segment in enumerate(segments):
        flagged = index in suspect
        if segment.words:
            atoms.extend(
                _Atom(word.start, word.end, word.text.strip(), index, word, 1, flagged)
                for word in segment.words
            )
        else:
            text = " ".join(segment.text.split())
            count = max(1, len(text.split()))
            atoms.append(_Atom(segment.start, segment.end, text, index, None, count, flagged))
    return atoms


def _gap(left: _Atom, right: _Atom) -> float:
    return max(0.0, right.start - left.end)


def _hard_boundary(left: _Atom, right: _Atom, pause_split: float) -> bool:
    gap = _gap(left, right)
    if gap >= pause_split or left.suspect != right.suspect:
        return True
    ending = _ending(left.text)
    return ending in ("question", "terminal") or (ending == "ellipsis" and gap >= ELLIPSIS_MIN_GAP)


def _initial_runs(atoms: Sequence[_Atom], pause_split: float) -> list[list[_Atom]]:
    runs: list[list[_Atom]] = []
    current: list[_Atom] = []
    for position, atom in enumerate(atoms):
        current.append(atom)
        following = atoms[position + 1] if position + 1 < len(atoms) else None
        if following is None or _hard_boundary(atom, following, pause_split):
            runs.append(current)
            current = []
    return runs


def _split_score(left: _Atom, right: _Atom) -> float:
    score = round(_gap(left, right), 3)
    ending = _ending(left.text)
    if ending in ("question", "terminal"):
        score += _TERMINAL_BONUS
    elif ending in ("ellipsis", "soft"):
        score += _SOFT_BONUS
    if left.segment != right.segment:
        score += _SEGMENT_BONUS
    if left.word is not None and left.end - left.start >= HELD_WORD_SECONDS:
        score += _HELD_WORD_BONUS
    if _opens_question(right.text):
        score += _OPENER_BONUS
    return round(score, 6)


def _best_split(part: Sequence[_Atom], min_words: int, max_words: int) -> int:
    """Index ``k`` so that ``part[:k]`` and ``part[k:]`` are the best two halves."""
    prefix = [0]
    for atom in part:
        prefix.append(prefix[-1] + atom.word_count)
    total = prefix[-1]
    candidates = range(1, len(part))
    if total > LONG_RUN_FACTOR * max_words:
        middle = [k for k in candidates if total / 4 <= prefix[k] <= 3 * total / 4]
        candidates = middle or candidates
    balanced = [k for k in candidates if prefix[k] >= min_words and total - prefix[k] >= min_words]
    return max(
        balanced or candidates,
        key=lambda k: (_split_score(part[k - 1], part[k]), -abs(2 * prefix[k] - total), -k),
    )


def _fits(part: Sequence[_Atom], max_words: int, max_seconds: float) -> bool:
    words = sum(atom.word_count for atom in part)
    return words <= max_words and part[-1].end - part[0].start <= max_seconds


def _split_long(
    run: list[_Atom], *, min_words: int, max_words: int, max_seconds: float
) -> list[list[_Atom]]:
    parts: list[list[_Atom]] = []
    stack = [run]
    while stack:
        part = stack.pop()
        if len(part) == 1 or _fits(part, max_words, max_seconds):
            parts.append(part)
            continue
        split = _best_split(part, min_words, max_words)
        stack.append(part[split:])
        stack.append(part[:split])
    return parts


def _word_count(part: Sequence[_Atom]) -> int:
    return sum(atom.word_count for atom in part)


def _can_merge(
    left: Sequence[_Atom], right: Sequence[_Atom], *, limit_words: int, limit_seconds: float
) -> bool:
    return (
        left[-1].suspect == right[0].suspect
        and _gap(left[-1], right[0]) <= MERGE_MAX_GAP
        and _word_count(left) + _word_count(right) <= limit_words
        and max(right[-1].end, left[-1].end) - left[0].start <= limit_seconds
    )


def _merge_cost(fragment: Sequence[_Atom], neighbour: Sequence[_Atom], *, backward: bool) -> float:
    """Gap plus a small punctuation preference, in seconds."""
    fragment_ending = _ending(fragment[-1].text)
    penalty = 0
    if backward:
        gap = _gap(neighbour[-1], fragment[0])
        if fragment_ending in ("soft", "ellipsis"):
            penalty += 1
        if _ending(neighbour[-1].text) == "question" and fragment_ending != "question":
            penalty += 2
    else:
        gap = _gap(fragment[-1], neighbour[0])
        if fragment_ending in ("terminal", "question"):
            penalty += 1
        if fragment_ending == "question":
            penalty += 2
    return round(gap, 3) + _MERGE_PREFERENCE_SECONDS * penalty


def _merge_fragments(
    parts: list[list[_Atom]], *, min_words: int, max_words: int, max_seconds: float
) -> list[list[_Atom]]:
    limits = {
        "limit_words": max_words + min_words,
        "limit_seconds": max_seconds + MERGE_EXTRA_SECONDS,
    }
    merged: list[list[_Atom]] = []
    carried: list[_Atom] | None = None
    for position, original in enumerate(parts):
        part = original if carried is None else carried + original
        carried = None
        if _word_count(part) >= min_words:
            merged.append(part)
            continue
        following = parts[position + 1] if position + 1 < len(parts) else None
        options: list[tuple[float, int]] = []
        if merged and _can_merge(merged[-1], part, **limits):
            options.append((_merge_cost(part, merged[-1], backward=True), 0))
        if following is not None and _can_merge(part, following, **limits):
            options.append((_merge_cost(part, following, backward=False), 1))
        if not options:
            merged.append(part)
        elif min(options)[1] == 0:
            merged[-1] = merged[-1] + part
        else:
            carried = part
    return merged


def _unit(index: int, part: Sequence[_Atom], previous_end: float | None) -> SentenceUnit:
    start = part[0].start
    end = max(atom.end for atom in part)
    text = " ".join(atom.text for atom in part)
    segments = [atom.segment for atom in part]
    gap = 0.0 if previous_end is None else round(max(0.0, start - previous_end), 3)
    return SentenceUnit(
        unit_id=f"S{index + 1:04d}",
        index=index,
        start=start,
        end=end,
        text=text,
        segment_start=min(segments),
        segment_end=max(segments),
        word_count=_word_count(part),
        is_question=looks_like_question(text),
        gap_before=gap,
        suspect=any(atom.suspect for atom in part),
        words=tuple(atom.word for atom in part if atom.word is not None),
    )


def _validate_options(
    pause_split: object, max_words: object, max_seconds: object, min_words: object
) -> None:
    for name, value in (("pause_split", pause_split), ("max_seconds", max_seconds)):
        if not _is_number(value):
            raise TypeError(f"{name} must be a number")
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be finite and positive")
    for name, value in (("max_words", max_words), ("min_words", min_words)):
        if not _is_int(value):
            raise TypeError(f"{name} must be an integer")
        if value < 1:
            raise ValueError(f"{name} must be positive")
    if min_words > max_words:  # type: ignore[operator]
        raise ValueError("min_words must not exceed max_words")


def build_sentence_units(
    segments: Sequence[TranscriptSegment],
    *,
    quality: TranscriptQuality | None = None,
    pause_split: float = 0.6,
    max_words: int = 32,
    max_seconds: float = 14.0,
    min_words: int = 3,
) -> list[SentenceUnit]:
    """Build chronological sentence units; see the module docstring for the rules."""
    _validate_options(pause_split, max_words, max_seconds, min_words)
    if quality is not None and not isinstance(quality, TranscriptQuality):
        raise TypeError("quality must be a TranscriptQuality or None")
    segments = list(segments)
    if any(not isinstance(segment, TranscriptSegment) for segment in segments):
        raise TypeError("segments must be TranscriptSegment values")
    suspect = frozenset(quality.suspect_segment_indices) if quality is not None else frozenset()
    atoms = _atoms(segments, suspect)
    if not atoms:
        return []

    parts: list[list[_Atom]] = []
    for run in _initial_runs(atoms, float(pause_split)):
        parts.extend(
            _split_long(run, min_words=min_words, max_words=max_words, max_seconds=max_seconds)
        )
    parts = _merge_fragments(
        parts, min_words=min_words, max_words=max_words, max_seconds=max_seconds
    )

    units: list[SentenceUnit] = []
    previous_end: float | None = None
    for index, part in enumerate(parts):
        unit = _unit(index, part, previous_end)
        units.append(unit)
        previous_end = unit.end
    return units
