"""Konteks Tren: the trend snapshot of one job, and matching trends against a transcript.

The owner's external agent (Hermes) sends trend items (topics, people, jokes, memes, sounds,
hashtags) to the web app; for a Selection V3 job the worker writes the active ones to
``analysis/trend-context.json`` and passes ``--trend-context <path>`` (spec:
``docs/plans/2026-09-25-konteks-tren.md``, sections 1, 4.1 and 4.2). Item text comes from the
internet and is **data, never instructions**: it only ever reaches the LLM inside the fenced,
escaped block built by :func:`ai_clipper.llm_selection.render_trend_block`.

Snapshot (``version`` 1)::

    {"version": 1, "generatedAt": "2026-09-25T06:00:00Z", "items": [
      {"id": "0b6f2c1e-...", "externalId": "tiktok:tag:kabur-aja-dulu", "kind": "topic",
       "title": "Kabur Aja Dulu", "summary": "...", "keywords": ["kabur aja dulu"],
       "hashtags": ["#KaburAjaDulu"], "platforms": ["tiktok", "x"], "region": "ID",
       "score": 72, "sensitivity": "normal", "firstSeenAt": "...", "expiresAt": "...",
       "enabled": true}]}

Reading (:func:`load_trend_context`, :func:`read_trend_context`) is strict about the file (a
JSON object of at most :data:`MAX_TREND_CONTEXT_BYTES`, version 1, an ISO 8601 ``generatedAt``
with a time zone, an ``items`` list, no duplicate keys or ``NaN``): anything else raises
:class:`TrendContextError`, whose message never contains a path or item text. Items are read
one by one with the server's text rules (:func:`clean_trend_text`: NFC; control, bidi and
zero-width characters removed; single-line fields on one line; a summary of at most five
lines) and length limits counted in code points after cleaning. A malformed item, a duplicate
``id`` and anything past the first :data:`MAX_TREND_ITEMS` kept items is skipped and counted
(``TrendContext.skipped``). Disabled items and items that expired by ``generatedAt`` are
inactive and skipped without counting. Unknown fields (``examples``, ``source``, ...) are
ignored and never carried.

Matching (:func:`match_trends`, :func:`relevant_trends`): a trend's terms are its title, its
keywords and its hashtags without ``#`` (a hashtag also matches split at case and digit
changes, so ``#KaburAjaDulu`` matches "kabur aja dulu"). Text and terms are casefolded,
accent-free and tokenized into Unicode letters and digits, so a term matches only whole words
and a multi-word term only as a phrase, whatever the punctuation or spacing between its words.
A term needs at least one content word: :data:`MIN_TERM_LETTERS` letters or more and not in
:data:`TREND_STOPWORDS`; "AI", "aja dulu" or "viral" never match on their own. Occurrences of
one trend that overlap count once.
"""

from __future__ import annotations

import json
import math
import re
import unicodedata
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from numbers import Real
from pathlib import Path

from .selection_types import TREND_ID_PATTERN, TREND_KINDS, TrendRef

TREND_CONTEXT_VERSION = 1
TREND_CONTEXT_RELATIVE_PATH = Path("analysis") / "trend-context.json"
TREND_PLATFORMS = ("tiktok", "instagram", "youtube", "x", "facebook", "news", "other")
TREND_SENSITIVITIES = ("normal", "sensitive")
MAX_TREND_ITEMS = 300
MAX_TREND_CONTEXT_BYTES = 4 * 1024 * 1024
MAX_RELEVANT_TRENDS = 20
MAX_TREND_TIMES = 10
MAX_TITLE_CHARS = 80
MAX_SUMMARY_CHARS = 500
MAX_SUMMARY_LINES = 5
MAX_KEYWORDS = 12
MIN_KEYWORD_CHARS = 2
MAX_KEYWORD_CHARS = 40
MAX_ITEM_HASHTAGS = 10
MIN_TERM_LETTERS = 3
DEFAULT_TREND_SCORE = 50.0
DEFAULT_TREND_LIFETIME = timedelta(days=10)
# Words too common to say that a transcript talks about a trend: Indonesian function words and
# chat fillers, plus generic platform words. A term needs one word outside this list.
TREND_STOPWORDS = frozenset(
    {
        "yang", "dan", "di", "ke", "dari", "ini", "itu", "aja", "saja", "dulu", "udah", "sudah",
        "lagi", "juga", "ada", "apa", "gak", "nggak", "enggak", "ngga", "tidak", "bukan",
        "kita", "kami", "kamu", "lu", "lo", "gue", "gua", "aku", "dia", "mereka", "orang",
        "banget", "sama", "buat", "untuk", "dengan", "pada", "jadi", "kalau", "kalo", "tapi",
        "atau", "karena", "soal", "masih", "bisa", "mau", "akan", "sih", "dong", "deh", "kok",
        "nih", "tuh", "yah", "gitu", "begitu", "kayak", "seperti", "emang", "memang", "terus",
        "sampai", "sampe", "semua", "lebih", "paling", "sangat", "hari", "baru", "satu", "dua",
        "tiga", "the", "and", "for", "you", "with", "this", "that", "viral", "trending",
        "trend", "tren", "fyp", "foryou", "foryoupage", "video", "konten", "content", "reels",
        "shorts", "tiktok", "instagram", "youtube", "podcast", "live",
    }
)  # fmt: skip

_EXTERNAL_ID = re.compile(r"[A-Za-z0-9._:/#@-]{1,120}")
_HASHTAG = re.compile(r"#\w{1,50}")
_REGION = re.compile(r"[A-Z]{2}")
_INVISIBLE = re.compile("[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]")
_LINE_BREAK = re.compile("\r\n|[\r\n\x0b\x0c\x1c-\x1e\x85\u2028\u2029]")
_TOKEN = re.compile(r"[^\W_]+")
_MAX_TIMESTAMP_CHARS = 40


class TrendContextError(ValueError):
    """The trend snapshot is missing, malformed, or not version 1. Never echoes its text."""


# --- text rules -------------------------------------------------------------------------------


def clean_trend_text(value: str, *, multiline: bool = False) -> str:
    """``value`` under the server's text rules (see the module docstring).

    Control, bidi and zero-width characters are removed and runs of spaces collapse. A
    single-line field loses its line breaks; a multi-line one keeps at most
    :data:`MAX_SUMMARY_LINES` non-empty lines joined by ``\\n``. The result is NFC.
    """
    if not isinstance(value, str):
        raise TypeError("trend text must be a string")
    text = _LINE_BREAK.sub("\n", _INVISIBLE.sub("", value))
    text = "".join(
        character
        for character in text
        if character in "\n\t" or unicodedata.category(character) != "Cc"
    )
    if multiline:
        lines = (" ".join(line.split()) for line in text.split("\n"))
        text = "\n".join([line for line in lines if line][:MAX_SUMMARY_LINES])
    else:
        text = " ".join(text.split())
    return unicodedata.normalize("NFC", text)


def _single_line(value: object, name: str, low: int, high: int) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if value != clean_trend_text(value):
        raise ValueError(f"{name} must be clean single-line text")
    if not low <= len(value) <= high:
        raise ValueError(f"{name} must have {low}-{high} characters")
    return value


def _timestamp(value: object, name: str) -> datetime:
    if not isinstance(value, str) or len(value) > _MAX_TIMESTAMP_CHARS:
        raise ValueError(f"{name} must be an ISO 8601 timestamp")
    try:
        moment = datetime.fromisoformat(value.strip())
    except ValueError:
        raise ValueError(f"{name} must be an ISO 8601 timestamp") from None
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError(f"{name} must name its time zone")
    try:
        return moment.astimezone(UTC)
    except OverflowError:
        raise ValueError(f"{name} is out of range") from None


def _iso(moment: datetime) -> str:
    text = moment.astimezone(UTC).replace(microsecond=0, tzinfo=None).isoformat()
    return f"{text}Z"


# --- items ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TrendItem:
    """One active trend of the snapshot. Text fields are already clean (see the module docs)."""

    id: str
    kind: str
    title: str
    keywords: tuple[str, ...]
    summary: str = ""
    hashtags: tuple[str, ...] = ()
    platforms: tuple[str, ...] = ()
    region: str = "ID"
    score: float = DEFAULT_TREND_SCORE
    sensitivity: str = "normal"
    first_seen_at: str | None = None
    expires_at: str | None = None
    external_id: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not TREND_ID_PATTERN.fullmatch(self.id):
            raise ValueError("trend id must be 1-64 letters, digits, '.', '_', ':' or '-'")
        if self.kind not in TREND_KINDS:
            raise ValueError(f"trend kind must be one of {', '.join(TREND_KINDS)}")
        _single_line(self.title, "title", 1, MAX_TITLE_CHARS)
        if not isinstance(self.summary, str):
            raise TypeError("summary must be a string")
        if self.summary != clean_trend_text(self.summary, multiline=True):
            raise ValueError("summary must be clean text")
        if len(self.summary) > MAX_SUMMARY_CHARS:
            raise ValueError(f"summary must have at most {MAX_SUMMARY_CHARS} characters")
        if not isinstance(self.keywords, tuple) or not 1 <= len(self.keywords) <= MAX_KEYWORDS:
            raise ValueError(f"keywords must be a tuple of 1-{MAX_KEYWORDS} items")
        for keyword in self.keywords:
            _single_line(keyword, "keyword", MIN_KEYWORD_CHARS, MAX_KEYWORD_CHARS)
        if not isinstance(self.hashtags, tuple) or len(self.hashtags) > MAX_ITEM_HASHTAGS:
            raise ValueError(f"hashtags must be a tuple of at most {MAX_ITEM_HASHTAGS} items")
        if any(not isinstance(tag, str) or not _HASHTAG.fullmatch(tag) for tag in self.hashtags):
            raise ValueError("hashtags must look like #word")
        if not isinstance(self.platforms, tuple) or any(
            platform not in TREND_PLATFORMS for platform in self.platforms
        ):
            raise ValueError(f"platforms must be among {', '.join(TREND_PLATFORMS)}")
        if len(set(self.platforms)) != len(self.platforms):
            raise ValueError("platforms must not repeat")
        if not isinstance(self.region, str) or not _REGION.fullmatch(self.region):
            raise ValueError("region must be an ISO 3166-1 alpha-2 code")
        if not isinstance(self.score, Real) or isinstance(self.score, bool):
            raise TypeError("score must be a number")
        score = float(self.score)
        if not math.isfinite(score) or not 0.0 <= score <= 100.0:
            raise ValueError("score must be between 0 and 100")
        object.__setattr__(self, "score", score)
        if self.sensitivity not in TREND_SENSITIVITIES:
            raise ValueError("sensitivity must be normal or sensitive")
        for name in ("first_seen_at", "expires_at"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, _iso(_timestamp(value, name)))
        if self.external_id is not None and (
            not isinstance(self.external_id, str) or not _EXTERNAL_ID.fullmatch(self.external_id)
        ):
            raise ValueError("externalId must be 1-120 safe characters")

    @property
    def sensitive(self) -> bool:
        """A tragedy, disaster, SARA, violence or health topic: never a joke, never a boost."""
        return self.sensitivity == "sensitive"

    def ref(self) -> TrendRef:
        return TrendRef(id=self.id, title=self.title, kind=self.kind)


def _optional_text(raw: dict[str, object], key: str, *, multiline: bool = False) -> str:
    value = raw.get(key)
    if value is None:
        return ""
    if not isinstance(value, str):
        raise TypeError(f"{key} must be a string")
    return clean_trend_text(value, multiline=multiline)


def _text_list(raw: dict[str, object], key: str, *, required: bool) -> tuple[str, ...]:
    value = raw.get(key)
    if value is None and not required:
        return ()
    if type(value) is not list or any(not isinstance(item, str) for item in value):
        raise TypeError(f"{key} must be a list of strings")
    cleaned = (clean_trend_text(item) for item in value)
    return tuple(dict.fromkeys(cleaned))


def _item_from_dict(raw: object, now: datetime) -> TrendItem | None:
    """A validated item, ``None`` when it is disabled or expired; raises when malformed."""
    if type(raw) is not dict:
        raise TypeError("item must be an object")
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise TypeError("enabled must be a boolean")
    first_seen = raw.get("firstSeenAt")
    seen = now if first_seen is None else _timestamp(first_seen, "firstSeenAt")
    expires = raw.get("expiresAt")
    if expires is not None:
        until = _timestamp(expires, "expiresAt")
    elif seen <= datetime.max.replace(tzinfo=UTC) - DEFAULT_TREND_LIFETIME:
        until = seen + DEFAULT_TREND_LIFETIME
    else:
        raise ValueError("firstSeenAt is out of range")
    title = raw.get("title")
    if not isinstance(title, str):
        raise TypeError("title must be a string")
    item = TrendItem(
        id=raw.get("id"),  # type: ignore[arg-type]
        kind=raw.get("kind"),  # type: ignore[arg-type]
        title=clean_trend_text(title),
        keywords=_text_list(raw, "keywords", required=True),
        summary=_optional_text(raw, "summary", multiline=True),
        hashtags=_text_list(raw, "hashtags", required=False),
        platforms=_text_list(raw, "platforms", required=False),
        region="ID" if raw.get("region") is None else raw.get("region"),  # type: ignore[arg-type]
        score=DEFAULT_TREND_SCORE if raw.get("score") is None else raw.get("score"),  # type: ignore[arg-type]
        sensitivity="normal" if raw.get("sensitivity") is None else raw.get("sensitivity"),  # type: ignore[arg-type]
        first_seen_at=_iso(seen),
        expires_at=_iso(until),
        external_id=raw.get("externalId"),  # type: ignore[arg-type]
    )
    if not enabled or until <= now:
        return None
    return item


# --- snapshot ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TrendContext:
    """The active items of one snapshot, in file order, and how many were skipped as broken."""

    items: tuple[TrendItem, ...]
    generated_at: str
    skipped: int = 0


def trend_context_from_dict(payload: object) -> TrendContext:
    """Validate a decoded snapshot; see the module docstring for the rules."""
    if type(payload) is not dict:
        raise TrendContextError("trend context must be a JSON object")
    version = payload.get("version")
    if type(version) is not int or version != TREND_CONTEXT_VERSION:
        raise TrendContextError("unsupported trend context version")
    try:
        generated = _timestamp(payload.get("generatedAt"), "generatedAt")
    except ValueError:
        raise TrendContextError("generatedAt must be an ISO 8601 timestamp with a zone") from None
    raw_items = payload.get("items")
    if type(raw_items) is not list:
        raise TrendContextError("items must be a list")
    kept: list[TrendItem] = []
    seen: set[str] = set()
    skipped = 0
    for position, raw in enumerate(raw_items):
        if len(kept) >= MAX_TREND_ITEMS:
            skipped += len(raw_items) - position
            break
        try:
            item = _item_from_dict(raw, generated)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if item is None:
            continue
        if item.id in seen:
            skipped += 1
            continue
        seen.add(item.id)
        kept.append(item)
    return TrendContext(items=tuple(kept), generated_at=_iso(generated), skipped=skipped)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise TrendContextError("trend context has a duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise TrendContextError("trend context contains a non-finite number")


def load_trend_context(path: str | Path) -> TrendContext:
    """Read a snapshot strictly. Raises ``FileNotFoundError`` or :class:`TrendContextError`."""
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError("trend context not found")
    with source.open("rb") as stream:
        raw = stream.read(MAX_TREND_CONTEXT_BYTES + 1)
    if len(raw) > MAX_TREND_CONTEXT_BYTES:
        raise TrendContextError("trend context is too large")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except TrendContextError:
        raise
    except (ValueError, RecursionError):  # also over-long integer literals
        raise TrendContextError("trend context is not valid UTF-8 JSON") from None
    return trend_context_from_dict(payload)


def read_trend_context(path: str | Path) -> tuple[TrendItem, ...]:
    """The active items of the snapshot at ``path`` (see :func:`load_trend_context`)."""
    return load_trend_context(path).items


# --- matching ---------------------------------------------------------------------------------


def _tokens(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text.casefold())
    return _TOKEN.findall("".join(ch for ch in folded if not unicodedata.combining(ch)))


def _content(token: str) -> bool:
    return sum(character.isalpha() for character in token) >= MIN_TERM_LETTERS and (
        token not in TREND_STOPWORDS
    )


def _split_case(text: str) -> str:
    """``KaburAjaDulu2026`` -> ``Kabur Aja Dulu 2026``."""
    parts: list[str] = []
    previous = ""
    for character in text:
        if previous and (
            (character.isupper() and previous.islower())
            or (character.isdigit() != previous.isdigit() and character.isalnum()
                and previous.isalnum())
        ):
            parts.append(" ")
        parts.append(character)
        previous = character
    return "".join(parts)


@lru_cache(maxsize=4096)
def _terms(item: TrendItem) -> tuple[tuple[str, ...], ...]:
    phrases = [item.title]
    for text in (*item.keywords, *item.hashtags):
        if text.startswith("#"):
            body = text.lstrip("#")
            phrases.extend((body, _split_case(body)))
        else:
            phrases.append(text)
    terms = dict.fromkeys(tuple(_tokens(phrase)) for phrase in phrases)
    return tuple(term for term in terms if term and any(_content(token) for token in term))


def fold_hashtag(tag: str) -> str:
    """A hashtag or phrase as one casefolded, accent-free word: ``#Kabur_Aja Dulu`` -> ``kaburajadulu``."""
    if not isinstance(tag, str):
        raise TypeError("tag must be a string")
    return "".join(_tokens(tag))


@lru_cache(maxsize=4096)
def trend_tag_keys(item: TrendItem) -> frozenset[str]:
    """What a hashtag naming ``item`` folds to (:func:`fold_hashtag`): its own hashtags, and its
    title and keywords written as one word, when they would match a transcript on their own."""
    if not isinstance(item, TrendItem):
        raise TypeError("item must be a TrendItem")
    keys = {fold_hashtag(tag) for tag in item.hashtags}
    keys.update("".join(term) for term in _terms(item))
    return frozenset(key for key in keys if key)


def _positions(tokens: Sequence[str]) -> dict[str, list[int]]:
    index: dict[str, list[int]] = {}
    for position, token in enumerate(tokens):
        index.setdefault(token, []).append(position)
    return index


def _find(
    item: TrendItem, tokens: Sequence[str], index: dict[str, list[int]]
) -> tuple[list[tuple[int, int]], list[str]]:
    """Merged ``(start, end)`` token spans where ``item`` is mentioned, and the terms found."""
    spans: list[tuple[int, int]] = []
    found: list[str] = []
    for term in _terms(item):
        size = len(term)
        hits = [
            start
            for start in index.get(term[0], ())
            if tuple(tokens[start : start + size]) == term
        ]
        if hits:
            found.append(" ".join(term))
            spans.extend((start, start + size) for start in hits)
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged, found


def _check_items(items: object) -> list[TrendItem]:
    if isinstance(items, (str, bytes)) or not isinstance(items, Iterable):
        raise TypeError("items must be a sequence of TrendItem values")
    checked = list(items)
    if any(not isinstance(item, TrendItem) for item in checked):
        raise TypeError("items must be TrendItem values")
    return checked


@dataclass(frozen=True, slots=True)
class TrendMatch:
    """``item`` is mentioned ``count`` times (overlaps merged); ``terms`` are the terms found."""

    item: TrendItem
    count: int
    terms: tuple[str, ...]


def match_trends(items: Iterable[TrendItem], text: str) -> tuple[TrendMatch, ...]:
    """The items ``text`` mentions, by count then trend score (then input order)."""
    checked = _check_items(items)
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    tokens = _tokens(text)
    if not tokens or not checked:
        return ()
    index = _positions(tokens)
    found: list[tuple[int, int, TrendMatch]] = []
    for order, item in enumerate(checked):
        spans, terms = _find(item, tokens, index)
        if spans:
            found.append((len(spans), order, TrendMatch(item, len(spans), tuple(terms))))
    found.sort(key=lambda entry: (-entry[0], -entry[2].item.score, entry[1]))
    return tuple(match for _count, _order, match in found)


@dataclass(frozen=True, slots=True)
class RelevantTrend:
    """A trend the episode mentions: how often, and the start of each mentioning unit."""

    item: TrendItem
    count: int
    times: tuple[float, ...]


def relevant_trends(
    items: Iterable[TrendItem],
    transcript_units: Sequence[object],
    limit: int = MAX_RELEVANT_TRENDS,
) -> tuple[RelevantTrend, ...]:
    """The trends the transcript mentions, by count then score, at most ``limit``.

    ``transcript_units`` are sentence units (anything with ``text`` and ``start``); a phrase may
    run across two units. ``times`` holds the start of up to :data:`MAX_TREND_TIMES` units in
    which a mention begins.
    """
    checked = _check_items(items)
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("limit must be a positive integer")
    if isinstance(transcript_units, (str, bytes)) or not isinstance(transcript_units, Sequence):
        raise TypeError("transcript_units must be a sequence of units")
    tokens: list[str] = []
    owners: list[int] = []
    for position, unit in enumerate(transcript_units):
        unit_tokens = _tokens(unit.text)  # type: ignore[attr-defined]
        tokens.extend(unit_tokens)
        owners.extend([position] * len(unit_tokens))
    if not tokens or not checked:
        return ()
    index = _positions(tokens)
    found: list[tuple[int, int, TrendItem, tuple[float, ...]]] = []
    for order, item in enumerate(checked):
        spans, _terms_found = _find(item, tokens, index)
        if not spans:
            continue
        starts = dict.fromkeys(
            float(transcript_units[owners[start]].start)  # type: ignore[attr-defined]
            for start, _end in spans
        )
        found.append((len(spans), order, item, tuple(sorted(starts))[:MAX_TREND_TIMES]))
    found.sort(key=lambda entry: (-entry[0], -entry[2].score, entry[1]))
    return tuple(
        RelevantTrend(item, count, times) for count, _order, item, times in found[:limit]
    )
