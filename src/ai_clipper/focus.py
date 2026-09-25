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
content word: at least three letters and not one of :data:`FOCUS_STOPWORDS`, the function words
and fillers of the trend stopword list (everyday topics the owner may well choose, such as
"tiktok", "uang" or "keluarga", are content words here). "AI", "5G" or "apa aja" never match
on their own: :attr:`FocusMatcher.unmatchable` and :func:`focus_term_matchable` name them, so
the owner can be told that only the AI's reading applies to them.

A **one-word** term also matches its Indonesian derived words, which trend matching does not:
one prefix of :data:`FOCUS_PREFIXES`, then the term, then at most one suffix of
:data:`FOCUS_SUFFIXES`, one possessive of :data:`FOCUS_POSSESSIVES` and one particle of
:data:`FOCUS_PARTICLES`, in that order (so the confixes ``per-…-an``, ``ke-…-an`` and
``pe-…-an`` too). What is left once they are removed must be exactly the term. Short terms
reach other words easily ("rap" in "rapi", "rang" in "perang"), so a term of fewer than
:data:`MIN_PREFIX_TERM_LETTERS` letters takes no prefix, and a suffix (``-an``, ``-kan``, ``-i``,
``-in``) needs :data:`MIN_SUFFIX_TERM_LETTERS` letters unless it comes with a prefix; the
possessives and particles fit any term ("bannya"). Common words that still look derived are
listed in :data:`FOCUS_WORD_ROOTS` with the only terms they belong to ("berubah" is a word of
"ubah", never of "rubah"; "sekarang" of no term). "jomok" matches "perjomokan", "jomoknya",
"kejomok", "kejomokan" and both halves of "jomok-jomok", never "dramok" or "jomokers".

:func:`mention_clusters` groups mentions at most :data:`MENTION_CLUSTER_SECONDS` apart into one
conversation about the focus: the focus top-up asks about clusters, and the selector gives an
extra candidate to at most one per cluster. :class:`HeuristicWindows` finds the heuristic's own
windows around a mention, for those extra candidates
(:func:`ai_clipper.selection_v3.select_clips_v3`).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import product
from types import MappingProxyType
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
from .trend_context import (
    MIN_TERM_LETTERS,
    _stem,
    _tokens,
    clean_trend_text,
    fold_hashtag,
)

FOCUS_MODES = ("prefer",)  # "only" is planned, not accepted yet
MAX_FOCUS_NOTE_CHARS = 200
# Mentions at most this far apart belong to one conversation about the focus (one cluster).
MENTION_CLUSTER_SECONDS = 45.0
FOCUS_PREFIXES = (
    "di", "ke", "se", "ber", "be", "per", "pe", "ter", "me", "mem", "men", "meng", "meny", "peng",
    "pen", "pem", "peny",
)  # fmt: skip
FOCUS_SUFFIXES = ("an", "kan", "i", "in")
FOCUS_POSSESSIVES = ("nya", "ku", "mu")
FOCUS_PARTICLES = ("lah", "kah", "pun", "tah")
MIN_PREFIX_TERM_LETTERS = 4
MIN_SUFFIX_TERM_LETTERS = 5  # without a prefix; "-nya", "-ku", "-lah", ... fit any term
# Every ending a derived word may add after the term: suffix, then possessive, then particle;
# and those without a suffix, for terms too short to take one on its own.
_ENDINGS = frozenset(
    "".join(parts)
    for parts in product(("", *FOCUS_SUFFIXES), ("", *FOCUS_POSSESSIVES), ("", *FOCUS_PARTICLES))
)
_CLITIC_ENDINGS = frozenset(
    "".join(parts) for parts in product(("", *FOCUS_POSSESSIVES), ("", *FOCUS_PARTICLES))
)
# The trend stopwords a focus term may not rely on: function words, question words, fillers
# and laughter. The trend list's everyday topics (people, places, money, platforms) were chosen
# for noisy harvested trends; an owner who types "tiktok" or "keluarga" means it.
FOCUS_STOPWORDS = frozenset(
    {
        "yang", "dan", "di", "ke", "dari", "ini", "itu", "aja", "saja", "dulu", "udah", "sudah",
        "lagi", "juga", "ada", "apa", "gak", "nggak", "enggak", "ngga", "tidak", "bukan",
        "kita", "kami", "kamu", "lu", "lo", "gue", "gua", "aku", "dia", "mereka", "banget",
        "sama", "buat", "untuk", "dengan", "pada", "jadi", "kalau", "kalo", "tapi", "atau",
        "karena", "soal", "masih", "bisa", "mau", "akan", "sih", "dong", "deh", "kok", "nih",
        "tuh", "yah", "gitu", "begitu", "kayak", "seperti", "emang", "memang", "terus", "sampai",
        "sampe", "semua", "lebih", "paling", "sangat", "satu", "dua", "tiga", "gimana", "kenapa",
        "mana", "siapa", "kapan", "cuma", "cuman", "doang", "sekarang", "nanti", "tadi", "the",
        "and", "for", "you", "with", "this", "that",
        # fillers and laughter
        "ayo", "yuk", "nah", "kan", "loh", "lho", "wah", "wow", "oke", "okay", "yes", "halo",
        "guys", "gaes", "wkwk", "wkwkwk", "haha", "hahaha",
    }
)  # fmt: skip
# Common words that look like a prefix + a term + an ending but are not derived from it, each
# with the only terms it is a derived word of (none: a root word of its own). Checked on the
# word as said and without its particle and possessive ("tangannya" -> "tangan").
FOCUS_WORD_ROOTS = MappingProxyType(
    {
        # root words
        "badan": (), "bani": (), "begini": (), "berang": (), "berangkat": (), "berdiri": (),
        "bulan": (), "busi": (), "depan": (), "dialami": (), "dini": (), "gulai": (), "jalan": (),
        "kasihan": (), "kebetulan": (), "kepala": (), "ketara": (), "ketika": (), "kiri": (),
        "makan": (), "makin": (), "masalah": (), "melalui": (), "memang": (), "menanti": (),
        "mengalami": (), "menurut": (), "merubah": (), "pandai": (), "pasi": (), "peluang": (),
        "penanti": (), "pendiri": (), "pengalaman": (), "peran": (), "perang": (), "perangkat": (),
        "perhatian": (), "perhatiin": (), "perhatikan": (), "perlahan": (), "pertama": (),
        "petang": (), "ramai": (), "rapi": (), "santai": (), "sebuah": (), "sedang": (),
        "sedangkan": (), "segala": (), "sekarang": (), "sekutu": (), "selalu": (), "selama": (),
        "selamanya": (), "semata": (), "seni": (), "senin": (), "seolah": (), "serang": (),
        "sering": (), "setara": (), "setelah": (), "setelan": (), "setuju": (), "sini": (),
        "tangan": (), "tani": (), "teman": (), "terlalu": (), "termasuk": (), "ternyata": (),
        "tersebut": (),
        # derived words of one term only
        "berubah": ("ubah",), "perubahan": ("ubah",), "selain": ("lain",),
        "bermasalah": ("masalah",),
    }
)  # fmt: skip

__all__ = [
    "FOCUS_MODES",
    "FOCUS_PARTICLES",
    "FOCUS_POSSESSIVES",
    "FOCUS_PREFIXES",
    "FOCUS_STOPWORDS",
    "FOCUS_SUFFIXES",
    "FOCUS_WORD_ROOTS",
    "MAX_FOCUS_NOTE_CHARS",
    "MAX_FOCUS_TERMS",
    "MAX_FOCUS_TERM_CHARS",
    "MENTION_CLUSTER_SECONDS",
    "MIN_PREFIX_TERM_LETTERS",
    "MIN_SUFFIX_TERM_LETTERS",
    "FocusHit",
    "FocusMatcher",
    "FocusSpec",
    "HeuristicWindows",
    "focus_term_matchable",
    "mention_clusters",
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
        keys = [key for key in map(_term_key, self.terms) if key]
        if len(set(keys)) != len(keys):
            raise ValueError("focus terms must be unique once tokenised")
        if not isinstance(self.note, str):
            raise TypeError("focus note must be a string")
        if self.note != clean_trend_text(self.note):
            raise ValueError("focus note must be clean single-line text")
        if len(self.note) > MAX_FOCUS_NOTE_CHARS:
            raise ValueError(f"focus note must have at most {MAX_FOCUS_NOTE_CHARS} characters")
        if self.mode not in FOCUS_MODES:
            raise ValueError(f"focus mode must be one of {', '.join(FOCUS_MODES)}")


def _term_key(term: str) -> tuple[str, ...]:
    """What a term matches as: its tokens (``"Jomok!"`` and ``"jomok"`` are one term)."""
    return tuple(_tokens(term))


def parse_focus(
    terms: Iterable[str] | None, note: str | None = None, mode: str = "prefer"
) -> FocusSpec | None:
    """The :class:`FocusSpec` for raw terms and note (CLI or job options), ``None`` without terms.

    Terms and note are cleaned first (see the module docstring); empty terms are dropped, and so
    is a term that tokenises like an earlier one (``"Jomok!"`` after ``"jomok"``, ``"K pop"``
    after ``"k-pop"``). A note without any term, and anything the spec forbids (more than
    :data:`MAX_FOCUS_TERMS` terms, a term outside 2-:data:`MAX_FOCUS_TERM_CHARS` characters, a
    term repeated by casefold, a note over :data:`MAX_FOCUS_NOTE_CHARS` characters, another
    mode), raise ``ValueError``.
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
    if len({term.casefold() for term in cleaned}) != len(cleaned):
        raise ValueError("focus terms must be unique")
    kept: list[str] = []
    seen: set[tuple[str, ...]] = set()
    for term in cleaned:
        key = _term_key(term)
        if key and key in seen:
            continue  # the same words: the matcher would record every mention twice
        seen.add(key)
        kept.append(term)
    return FocusSpec(terms=tuple(kept), note=clean_note, mode=mode)


# --- literal matching -------------------------------------------------------------------------


def _letters(text: str) -> int:
    return sum(character.isalpha() for character in text)


def _content(token: str) -> bool:
    """A word a focus term may match by: three letters or more, not a focus stopword."""
    return _letters(token) >= MIN_TERM_LETTERS and token not in FOCUS_STOPWORDS


def focus_term_matchable(term: str) -> bool:
    """Whether ``term`` can ever match a transcript literally (see the module docstring)."""
    if not isinstance(term, str):
        raise TypeError("term must be a string")
    return any(_content(word) for word in _term_key(term))


def _without_clitics(token: str) -> str:
    """``token`` without a final particle and then a possessive: ``tangannyalah`` -> ``tangan``."""
    for endings in (FOCUS_PARTICLES, FOCUS_POSSESSIVES):
        for ending in endings:
            if token.endswith(ending) and len(token) > len(ending):
                token = token[: -len(ending)]
                break
    return token


def _derived(token: str, word: str, *, prefixes: bool, suffixes: bool) -> bool:
    """``token`` is ``word`` or a derived word of it (see the module docstring)."""
    if token == word:
        return True
    if len(token) <= len(word):
        return False
    for form in (token, _without_clitics(token)):
        roots = FOCUS_WORD_ROOTS.get(form)
        if roots is not None and form != word and word not in roots:
            return False  # a common word of its own, or another term's derived word
    for head in ("", *FOCUS_PREFIXES) if prefixes else ("",):
        if token.startswith(head) and token.startswith(word, len(head)):
            endings = _ENDINGS if suffixes or head else _CLITIC_ENDINGS
            if token[len(head) + len(word) :] in endings:
                return True
    return False


@dataclass(frozen=True, slots=True)
class _Term:
    text: str  # the owner's spelling
    words: tuple[str, ...]
    usable: bool  # has a content word, so it may match on its own
    prefixes: bool  # a one-word term long enough to take a prefix
    suffixes: bool  # ... and a suffix without a prefix

    @classmethod
    def of(cls, text: str) -> _Term:
        words = _term_key(text)
        usable = any(_content(word) for word in words)
        letters = _letters(words[0]) if len(words) == 1 else 0
        prefixes = letters >= MIN_PREFIX_TERM_LETTERS
        return cls(text, words, usable, prefixes, letters >= MIN_SUFFIX_TERM_LETTERS)

    def derives(self, token: str) -> bool:
        """``token`` is this one-word term or one of its derived words."""
        return _derived(token, self.words[0], prefixes=self.prefixes, suffixes=self.suffixes)

    def starts(self, tokens: Sequence[str]) -> list[int]:
        """Where this term is said in ``tokens`` (see the module docstring)."""
        if not self.usable:
            return []
        if len(self.words) == 1:
            return [index for index, token in enumerate(tokens) if self.derives(token)]
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
        self._joined = {"".join(term.words): term for term in self._terms if term.usable}

    @property
    def unmatchable(self) -> tuple[str, ...]:
        """The terms that can never match literally (too short, or function words only)."""
        return tuple(term.text for term in self._terms if not term.usable)

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
            len(term.words) == 1 and term.usable and term.derives(folded) for term in self._terms
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


def mention_clusters(hits: Iterable[FocusHit]) -> list[tuple[FocusHit, ...]]:
    """``hits`` in time order, split where two follow each other more than
    :data:`MENTION_CLUSTER_SECONDS` apart: one cluster per conversation about the focus."""
    clusters: list[list[FocusHit]] = []
    for hit in sorted(hits, key=lambda item: (item.time, item.first_unit)):
        if clusters and hit.time - clusters[-1][-1].time <= MENTION_CLUSTER_SECONDS + 1e-6:
            clusters[-1].append(hit)
        else:
            clusters.append([hit])
    return [tuple(cluster) for cluster in clusters]


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
