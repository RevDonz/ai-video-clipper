"""Fokus klip: the owner's per-job focus terms, and where a transcript says them.

The owner may give a Selection V3 job **focus terms** ("jomok", "jomokers") and a short note
for the AI; clips that match come first and the other slots are filled with the best other
clips (mode ``prefer``, the owner's decision of 2026-09-25). Spec:
``docs/plans/2026-09-25-fokus-klip.md``, sections 1 and 2.

**The option** (:class:`FocusSpec`, built by :func:`parse_focus`): 1-8 terms of 2-40 characters,
unique by casefold, and an optional note of at most :data:`MAX_FOCUS_NOTE_CHARS` characters,
both cleaned like trend text (:func:`ai_clipper.trend_context.clean_trend_text`: NFC, control,
format and invisible characters removed, one line, spaces collapsed). No terms means no focus.
The text comes from the owner but is still untrusted for the LLM prompt: it only reaches the
model inside the escaped, bounded block of :func:`ai_clipper.llm_selection.render_focus_block`,
and never reaches FFmpeg.

**Literal matching** (:class:`FocusMatcher`) reuses the Konteks Tren tokens: casefolded,
accent-free Unicode letters and digits, so a term matches whole words only and a multi-word
term only as a phrase (its last word may carry a spoken clitic, as for trends). A term needs a
content word (at least three letters, not an everyday word of
:data:`ai_clipper.trend_context.TREND_STOPWORDS`); "AI" or "orang" never match on their own.
A **one-word** term also matches its Indonesian derived words, which trend matching does not:
one prefix of :data:`FOCUS_PREFIXES`, then the term, then at most one suffix of
:data:`FOCUS_SUFFIXES`, one possessive of :data:`FOCUS_POSSESSIVES` and one particle of
:data:`FOCUS_PARTICLES`, in that order (so the confixes ``per-…-an``, ``ke-…-an`` and
``pe-…-an`` too). What is left once they are removed must be exactly the term, and a term of
fewer than :data:`MIN_PREFIX_TERM_LETTERS` letters takes no prefix. "jomok" matches
"perjomokan", "jomoknya", "kejomok", "kejomokan" and both halves of "jomok-jomok", never
"dramok" or "jomokers".

:class:`HeuristicWindows` finds the heuristic's own windows around a mention, for the extra
candidates of the selector (:func:`ai_clipper.selection_v3.select_clips_v3`).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import product
from typing import Any

from .audio_timeline import AudioTimeline
from .hook_heuristics import (
    _EPSILON,
    HOOK_ZONE_MAX_SECONDS,
    HOOK_ZONE_MIN_SECONDS,
    HOOK_ZONE_SHARE,
    _analyse_unit,
    _assess,
    _context,
    _proposal,
    _starts,
)
from .selection_types import (
    MAX_FOCUS_TERM_CHARS,
    MAX_FOCUS_TERMS,
    ClipProposal,
    focus_terms,
)
from .sentences import SentenceUnit
from .sound_events import SoundEvent, sort_events
from .trend_context import _content, _stem, _tokens, clean_trend_text, fold_hashtag

FOCUS_MODES = ("prefer",)  # "only" is planned, not accepted yet
MAX_FOCUS_NOTE_CHARS = 200
FOCUS_PREFIXES = (
    "di", "ke", "se", "ber", "be", "per", "pe", "ter", "me", "mem", "men", "meng", "meny", "peng",
    "pen", "pem", "peny",
)  # fmt: skip
FOCUS_SUFFIXES = ("an", "kan", "i", "in")
FOCUS_POSSESSIVES = ("nya", "ku", "mu")
FOCUS_PARTICLES = ("lah", "kah", "pun", "tah")
MIN_PREFIX_TERM_LETTERS = 4
# Every ending a derived word may add after the term: suffix, then possessive, then particle.
_ENDINGS = frozenset(
    "".join(parts)
    for parts in product(("", *FOCUS_SUFFIXES), ("", *FOCUS_POSSESSIVES), ("", *FOCUS_PARTICLES))
)

__all__ = [
    "FOCUS_MODES",
    "FOCUS_PARTICLES",
    "FOCUS_POSSESSIVES",
    "FOCUS_PREFIXES",
    "FOCUS_SUFFIXES",
    "MAX_FOCUS_NOTE_CHARS",
    "MAX_FOCUS_TERMS",
    "MAX_FOCUS_TERM_CHARS",
    "MIN_PREFIX_TERM_LETTERS",
    "FocusHit",
    "FocusMatcher",
    "FocusSpec",
    "HeuristicWindows",
    "parse_focus",
]


# --- the option -------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FocusSpec:
    """A job's focus: clean terms, an optional note for the AI, and the mode."""

    terms: tuple[str, ...]
    note: str = ""
    mode: str = "prefer"

    def __post_init__(self) -> None:
        focus_terms(self.terms)
        if any(term != clean_trend_text(term) for term in self.terms):
            raise ValueError("focus terms must be clean single-line text")
        if not isinstance(self.note, str):
            raise TypeError("focus note must be a string")
        if self.note != clean_trend_text(self.note):
            raise ValueError("focus note must be clean single-line text")
        if len(self.note) > MAX_FOCUS_NOTE_CHARS:
            raise ValueError(f"focus note must have at most {MAX_FOCUS_NOTE_CHARS} characters")
        if self.mode not in FOCUS_MODES:
            raise ValueError(f"focus mode must be one of {', '.join(FOCUS_MODES)}")


def parse_focus(
    terms: Iterable[str] | None, note: str | None = None, mode: str = "prefer"
) -> FocusSpec | None:
    """The :class:`FocusSpec` for raw terms and note (CLI or job options), ``None`` without terms.

    Terms and note are cleaned first (see the module docstring); empty terms are dropped. A note
    without any term, and anything the spec forbids (more than :data:`MAX_FOCUS_TERMS` terms, a
    term outside 2-:data:`MAX_FOCUS_TERM_CHARS` characters, a repeated term, a note over
    :data:`MAX_FOCUS_NOTE_CHARS` characters, another mode), raise ``ValueError``.
    """
    if terms is None:
        terms = []
    if isinstance(terms, (str, bytes)) or not isinstance(terms, Iterable):
        raise TypeError("focus terms must be a list of strings")
    raw = list(terms)
    if any(not isinstance(term, str) for term in raw):
        raise TypeError("focus terms must be a list of strings")
    if note is not None and not isinstance(note, str):
        raise TypeError("focus note must be a string")
    if mode not in FOCUS_MODES:
        raise ValueError(f"focus mode must be one of {', '.join(FOCUS_MODES)}")
    cleaned = tuple(term for term in (clean_trend_text(item) for item in raw) if term)
    clean_note = clean_trend_text(note or "")
    if not cleaned:
        if clean_note:
            raise ValueError("a focus note needs at least one focus term")
        return None
    return FocusSpec(terms=cleaned, note=clean_note, mode=mode)


# --- literal matching -------------------------------------------------------------------------


def _letters(text: str) -> int:
    return sum(character.isalpha() for character in text)


def _derived(token: str, word: str, prefixes: bool) -> bool:
    """``token`` is ``word`` or a derived word of it (see the module docstring)."""
    if token == word:
        return True
    if len(token) <= len(word):
        return False
    return any(
        token.startswith(head)
        and token.startswith(word, len(head))
        and token[len(head) + len(word) :] in _ENDINGS
        for head in (("", *FOCUS_PREFIXES) if prefixes else ("",))
    )


@dataclass(frozen=True, slots=True)
class _Term:
    text: str  # the owner's spelling
    words: tuple[str, ...]
    usable: bool  # has a content word, so it may match on its own
    prefixes: bool  # a one-word term long enough to take a prefix

    @classmethod
    def of(cls, text: str) -> _Term:
        words = tuple(_tokens(text))
        usable = bool(words) and any(_content(word) for word in words)
        prefixes = len(words) == 1 and _letters(words[0]) >= MIN_PREFIX_TERM_LETTERS
        return cls(text, words, usable, prefixes)

    def starts(self, tokens: Sequence[str]) -> list[int]:
        """Where this term is said in ``tokens`` (see the module docstring)."""
        if not self.usable:
            return []
        if len(self.words) == 1:
            word = self.words[0]
            return [
                index for index, token in enumerate(tokens) if _derived(token, word, self.prefixes)
            ]
        size = len(self.words)
        head, last = self.words[:-1], self.words[-1]
        return [
            index
            for index in range(len(tokens) - size + 1)
            if tuple(tokens[index : index + size - 1]) == head
            and last in (tokens[index + size - 1], _stem(tokens[index + size - 1]))
        ]


@dataclass(frozen=True, slots=True)
class FocusHit:
    """A literal mention of ``term``: its first and last unit and the source time it starts.

    ``time`` is the start of the word that begins the mention when the unit's words line up
    with its text, else the start of the unit. Several mentions of a term in one unit are one
    hit (the earliest).
    """

    term: str
    first_unit: int
    last_unit: int
    time: float


def _unit_tokens(unit: SentenceUnit) -> tuple[list[str], list[float]]:
    tokens = _tokens(unit.text)
    start = float(unit.start)
    if unit.words:
        timed = [(token, float(word.start)) for word in unit.words for token in _tokens(word.text)]
        if [token for token, _time in timed] == tokens:
            return tokens, [time for _token, time in timed]
    return tokens, [start] * len(tokens)


class FocusMatcher:
    """The focus terms of one job, compiled for literal matching (see the module docstring)."""

    def __init__(self, focus: FocusSpec) -> None:
        if not isinstance(focus, FocusSpec):
            raise TypeError("focus must be a FocusSpec")
        self.focus = focus
        self._terms = tuple(_Term.of(term) for term in focus.terms)
        self._joined = {
            "".join(term.words): term for term in self._terms if term.usable and term.words
        }

    def mentions(self, text: str) -> tuple[str, ...]:
        """The focus terms ``text`` says, in the owner's order and spelling."""
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        tokens = _tokens(text)
        return tuple(term.text for term in self._terms if term.starts(tokens))

    def names_tag(self, tag: str) -> bool:
        """A hashtag that names a focus term: ``#Jomok``, ``#perjomokan``, ``#KaburAjaDulu``."""
        if not isinstance(tag, str):
            raise TypeError("tag must be a string")
        body = tag.lstrip("#")
        if self.mentions(body):
            return True
        folded = fold_hashtag(body)
        if not folded:
            return False
        if folded in self._joined:
            return True
        return any(
            len(term.words) == 1 and term.usable and _derived(folded, term.words[0], term.prefixes)
            for term in self._terms
        )

    def hits(self, units: Sequence[SentenceUnit]) -> tuple[FocusHit, ...]:
        """Every literal mention in ``units``, by position; a phrase may run across two units."""
        if isinstance(units, (str, bytes)) or not isinstance(units, Sequence):
            raise TypeError("units must be a sequence of SentenceUnit values")
        tokens: list[str] = []
        owners: list[int] = []
        times: list[float] = []
        for position, unit in enumerate(units):
            if not isinstance(unit, SentenceUnit):
                raise TypeError("units must be SentenceUnit values")
            unit_tokens, unit_times = _unit_tokens(unit)
            tokens.extend(unit_tokens)
            times.extend(unit_times)
            owners.extend([position] * len(unit_tokens))
        found: dict[tuple[int, int, int], float] = {}
        for order, term in enumerate(self._terms):
            size = len(term.words)
            for start in term.starts(tokens):
                key = (order, owners[start], owners[start + size - 1])
                found[key] = min(found.get(key, times[start]), times[start])
        ordered = sorted(
            found.items(), key=lambda entry: (entry[0][1], entry[0][2], entry[1], entry[0][0])
        )
        return tuple(
            FocusHit(self._terms[order].text, first, last, time)
            for (order, first, last), time in ordered
        )


# --- heuristic windows around a mention ------------------------------------------------------


class HeuristicWindows:
    """The heuristic's own windows (:mod:`ai_clipper.hook_heuristics`) around given units.

    The episode is analysed once, lazily, exactly as
    :func:`ai_clipper.hook_heuristics.propose_heuristic` does. :meth:`around` then searches
    like the heuristic's window search, restricted to the units asked for: every heuristic
    start inside the allowed range, its hook zone, and the end with the best cut (full
    laugh-end credit) among those that keep the mention and the duration bounds. So a window
    around a mention is scored and packaged exactly like any heuristic proposal, even when a
    chosen clip right next to it rules out the heuristic's usual ends. The selector still snaps
    it and applies the duration rules.
    """

    def __init__(
        self,
        units: Sequence[SentenceUnit],
        *,
        min_duration: float,
        max_duration: float,
        events: Sequence[SoundEvent] = (),
        audio: AudioTimeline | None = None,
    ) -> None:
        self._units = list(units)
        self._low = float(min_duration)
        self._high = float(max_duration)
        self._events = sort_events(events)
        self._audio = audio
        self._state: tuple[Any, list[tuple[int, str]]] | None = None

    def _prepared(self) -> tuple[Any, list[tuple[int, str]]]:
        if self._state is None:
            ctx = _context([_analyse_unit(unit) for unit in self._units], self._events, self._audio)
            self._state = (ctx, _starts(ctx))
        return self._state

    def around(
        self, first: int, last: int, limit: int, *, within: tuple[int, int] | None = None
    ) -> list[ClipProposal]:
        """Up to ``limit`` proposals whose units include ``first..last`` and stay inside
        ``within`` (a ``(first, last)`` unit range, default every unit), one per start, best
        score first."""
        if not self._units:
            return []
        low_unit, high_unit = (0, len(self._units) - 1) if within is None else within
        low_unit, high_unit = max(low_unit, 0), min(high_unit, len(self._units) - 1)
        if not low_unit <= first <= last <= high_unit:
            return []
        ctx, starts = self._prepared()
        units = ctx.units
        reach = min(HOOK_ZONE_MAX_SECONDS, max(HOOK_ZONE_MIN_SECONDS, HOOK_ZONE_SHARE * self._high))
        found = []
        for start, kind in starts:
            if start < low_unit or units[last].end - units[start].start > self._high + _EPSILON:
                continue
            if start > first:
                break
            origin = units[start].start
            zone, hook_unit, hook_value = start, start, -1.0
            best = None
            for end in range(start, high_unit + 1):
                duration = units[end].end - origin
                if duration > self._high + _EPSILON:
                    break
                while zone <= end and (zone == start or units[zone].start <= origin + reach):
                    if ctx.line_value[zone] > hook_value + _EPSILON:
                        hook_unit, hook_value = zone, ctx.line_value[zone]
                    zone += 1
                if end < last or duration < self._low - _EPSILON:
                    continue
                window = _assess(ctx, start, end, kind, hook_unit, hook_value)
                window.zone_end = zone - 1
                if best is None or window.choice > best.choice + _EPSILON:
                    best = window
            if best is not None:
                found.append(best)
        found.sort(key=lambda window: (-window.score, window.start, window.end))
        return [_proposal(ctx, window, window.score, 0.0) for window in found[:limit]]
