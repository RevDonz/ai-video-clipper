"""Rapikan: fillers, repeats and silent gaps (plan §7.3; ``python -m ai_clipper.edit_v2.cleanup``).

Owner: T3.5. Stdlib only, no LLM. The review list is a pure function of the words artifact
(``potongin.words/1``, plan §3.6) and the two lexicon files ``resources/lexicon/
id-fillers.v1.json`` and ``id-reduplication.v1.json``, so it is immutable per (words sha, lexicon
digest). Nothing here writes the document: the browser applies the checked items as one
``ApplyCleanup`` command (Appendix B), whose removals carry ``reason`` and
``origin: "suggestion:<item id>"``.

**Classes** (in transcript order, ids ``cl_1``, ``cl_2``, …):

* ``filler``: a run of adjacent hard fillers (``fillers`` and their elongated spellings in
  ``filler_patterns``; ``"ee ee"`` is one item) or a filler phrase (``"apa namanya"``). A filler
  written as a question (``"eh?"``, ``"Hmm?"``) is not listed: it is a tag or a reply; nor is an
  ``interjection_patterns`` token (``"eh"``) right after one of the ``quotatives`` (quoted speech:
  ``"kayak, eh tunggu dulu"``) or right before one of the ``address_terms`` (``"Eh, Bang"``), a
  token in capitals (``"HM"``, an acronym) or a letter next to a letter (``"A B C D E"``). Adjacent
  fillers more than 600 ms apart are separate items. ``defaultOn`` is the lexicon's ``precheck``
  (false until the owner confirms the labelled set, QG-CLEAN).
* ``repeat``: an immediate repeat of one token (``"gua gua"``, ``"gua gua gua"``: every
  occurrence but the last is removed, ``repeatOf`` names the kept one) or of a 2–3-token phrase
  whose second occurrence starts within 1.5 s of the first (``"kita harus kita harus"``).
  A repeated token is listed when it is a ``stutter_words`` entry (pronouns and function words),
  or, for any other word, when every pair is separated by at least 250 ms of audio-timeline
  silence (the gap ``[a.e, b.s]`` overlapped by ``silences``). Never listed: reduplication
  (``pairs``, ``contextual`` pairs before one of their ``followed_by`` words, and any token written
  with a hyphen at the join, as Whisper splits ``"bener-bener"``), ``emphatic`` repeats,
  ``vocal_sounds``, laughter tokens, a sentence end between the two occurrences (``"itu. Itu"``),
  and anything with a protected particle. ``defaultOn`` false.
* ``gap_silent``: a gap of class ``silent`` (> 600 ms, ≥ 80 % audio-timeline silence, §3.6):
  the proposal keeps 100 ms after the word before and 100 ms before the word after (200 ms,
  centred), snapped to frames inside the gap: ``inSf = sf_ceil(s + 100)``, ``outSf =
  sf_floor(e − 100)``, each moved inwards to a quiet frame when the peaks say it is not quiet
  (see "Quiet cuts"). ``defaultOn`` true.
* ``gap_voiced``: a gap of class ``voiced``: listed for audition only (``applicable`` false;
  shortening voiced gaps is Stage 2).

**Laughter lock.** A gap of class ``laughter`` and any word item whose removed words lie within
±500 ms of a laughter event (caption tag or transcript token) are never proposed; they are
reported in ``locked`` (reason ``laughter``) so the UI can say why. **Protected particles**
(``protected_particles``) are never part of any item; the user may still select and remove them
in the transcript.

**Quiet cuts** (QG-CLEAN: every cut edge lies in its word gap and is quiet over ±10 ms). With
the clip's peaks (``peaks=``; the CLI reads the file the words artifact names) a cut counts as
quiet when every 10 ms bin within ±10 ms of it has a level ≤ ``QUIET_LEVEL`` (a peak below
−36 dBFS). A word item cuts at its ``bounds`` frames; when one of them is ``tight`` (no frame
boundary between the words: the cut would split a word) or not quiet, the item is not proposed
(``locked``, reason ``no_quiet_cut``). A silent gap's edges start 100 ms inside the gap and move
towards its middle to the first frame boundary that is quiet (Whisper's word times often end
before the speech does); a gap with no quiet edge on either side is ``no_quiet_cut``. Without
peaks (tests, the labelled set) no level is checked, and tight cuts are still refused.

**Result** (:func:`build_cleanup`)::

    {schema: "potongin.cleanup/1", lexicon: {version, sha256}, fillerPrecheck, missing,
     items: [{id, kind: "filler"|"repeat", wordIds, repeatOf (repeat only), s, e, defaultOn}
             | {id, kind: "gap_silent", afterWord, beforeWord, s, e, inSf, outSf, defaultOn}
             | {id, kind: "gap_voiced", afterWord, beforeWord, s, e, defaultOn, applicable}],
     locked: [{kind: "filler"|"repeat"|"gap", reason: "laughter"|"no_quiet_cut", s, e,
               wordIds | afterWord}]}

``s``/``e`` are source ms (the removed words, or the gap). The item fields ``id``, ``kind``,
``wordIds``, ``afterWord``, ``inSf`` and ``outSf`` are exactly the ``ApplyCleanup`` item shape
(CONTRACTS §5.17).

**CLI** (the edit_v2 protocol, CONTRACTS §5.9): stdin ``{"op": "list", "jobId", "clipId"}`` →
stdout ``{clipId, wordsSha256, …result}`` for the current document's words artifact (the seed's
when a read-only document's own words are gone, like ``api get``). Exit codes: 0; 1 internal
(also ``JOBS_ROOT`` unset); 2 malformed envelope; 4 unknown job or clip; 8 words artifact missing.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import stat
import sys
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

from . import store
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN
from .errors import (
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_USAGE,
    AnalysisMissing,
    EditV2Error,
    NotFound,
    exit_code_for,
    message_id,
)
from .glyphs import RESOURCES_DIR
from .peaks import bin_level

SCHEMA = "potongin.cleanup/1"
LEXICON_SCHEMA = "potongin.lexicon/1"
LEXICON_DIR = RESOURCES_DIR / "lexicon"
FILLERS_FILE = "id-fillers.v1.json"
REDUPLICATION_FILE = "id-reduplication.v1.json"
OPS = ("list",)

GAP_KEEP_EACH_SIDE_MS = 100  # 200 ms of pause kept, centred
REPEAT_SILENCE_MS = 250  # a repeated content word needs this much silence between the tokens
PHRASE_WINDOW_MS = 1500  # second occurrence of a phrase starts within this of the first
PHRASE_LENGTHS = (3, 2)
FILLER_RUN_MAX_GAP_MS = 600  # adjacent fillers further apart than this are separate items
LAUGHTER_LOCK_MS = 500
LAUGHTER_TOKEN = re.compile(r"(ha){2,}h?|(he){2,}|(hi){2,}|wk(wk)+\w*")
QUIET_LEVEL = 1  # peaks bin level (s16 // 256): a peak below −36 dBFS
QUIET_HALF_MS = 10  # the ±10 ms around a cut of the QG-CLEAN check
ITEM_ID_PREFIX = "cl_"
MAX_ENVELOPE_BYTES = 4096
MAX_LEXICON_BYTES = 256 << 10
MAX_PEAKS_BYTES = 16 << 20
_BIN_MS = 10
_PEAKS_NAME = re.compile(r"peaks\.[0-9a-f]{16}\.bin")

_EDGE = re.compile(r"^[\W_]+|[\W_]+$")
_CLOSERS = "\"'”’»)]}"
_TERMINAL = ".?!…"
_HYPHENS = ("-", "‐", "‑", "–")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
_TOKEN = re.compile(r"[^\s]{1,40}")


# --- the lexicon ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class Lexicon:
    """The two Rapikan lexicon files, validated (see their ``description`` fields)."""

    version: str
    sha256: str
    fillers: frozenset[str]
    filler_patterns: tuple[re.Pattern[str], ...]
    filler_phrases: tuple[tuple[str, ...], ...]
    interjection_patterns: tuple[re.Pattern[str], ...]  # "eh": quoted or addressing, not a filler
    quotatives: frozenset[str]
    address_terms: frozenset[str]
    particles: frozenset[str]
    pronouns: frozenset[str]
    stutter_words: frozenset[str]  # pronouns and function words
    reduplication: frozenset[str]  # w such that "w w" is a reduplicated word
    emphatic: frozenset[str]
    vocal_sounds: frozenset[str]
    contextual: Mapping[str, frozenset[str]]
    filler_precheck: bool

    def is_filler(self, token: str) -> bool:
        if not token or token in self.particles:
            return False
        return token in self.fillers or any(p.fullmatch(token) for p in self.filler_patterns)

    def never_repeats(self, token: str, following: str | None) -> bool:
        """Whether an immediate repeat of ``token`` (before ``following``) is never a stutter."""
        return (token in self.particles or token in self.reduplication
                or token in self.emphatic or token in self.vocal_sounds
                or LAUGHTER_TOKEN.fullmatch(token) is not None
                or (following is not None and following in self.contextual.get(token, ())))


def _pairs_hook(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise ValueError("duplicate key in lexicon")
    return result


def _read_lexicon_file(path: Path) -> tuple[bytes, dict]:
    raw = path.read_bytes()
    if len(raw) > MAX_LEXICON_BYTES:
        raise ValueError(f"{path.name}: too large")
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs_hook)
    if type(value) is not dict or value.get("schema") != LEXICON_SCHEMA:
        raise ValueError(f"{path.name}: not a {LEXICON_SCHEMA} file")
    return raw, value


def _words(value: object, name: str) -> frozenset[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{name} must be a non-empty list")
    words = set()
    for word in value:
        if not isinstance(word, str) or normalize(word) != word or not _TOKEN.fullmatch(word):
            raise ValueError(f"{name}: {word!r} is not a normalised token")
        words.add(word)
    return frozenset(words)


def _load(directory: Path) -> Lexicon:
    fillers_raw, fillers = _read_lexicon_file(directory / FILLERS_FILE)
    redup_raw, redup = _read_lexicon_file(directory / REDUPLICATION_FILE)
    for data, expected in ((fillers, "id-fillers"), (redup, "id-reduplication")):
        if data.get("id") != expected or data.get("version") != 1:
            raise ValueError(f"lexicon {expected} v1 expected")
    patterns = []
    for spec in fillers.get("filler_patterns", []):
        if not isinstance(spec, str) or not spec:
            raise ValueError("filler_patterns must be regular expressions")
        patterns.append(re.compile(spec))
    phrases = []
    for phrase in fillers.get("filler_phrases", []):
        if not isinstance(phrase, list) or len(phrase) < 2:
            raise ValueError("filler_phrases must be lists of at least two tokens")
        _words(phrase, "filler_phrases")
        phrases.append(tuple(phrase))
    interjections = []
    for spec in fillers.get("interjection_patterns", []):
        if not isinstance(spec, str) or not spec:
            raise ValueError("interjection_patterns must be regular expressions")
        interjections.append(re.compile(spec))
    particles = _words(fillers.get("protected_particles"), "protected_particles")
    filler_words = _words(fillers.get("fillers"), "fillers")
    pronouns = _words(fillers.get("stutter_pronouns"), "stutter_pronouns")
    stutter = pronouns | _words(fillers.get("stutter_function_words"), "stutter_function_words")
    if filler_words & particles or stutter & particles or stutter & filler_words:
        raise ValueError("fillers, protected particles and stutter words must be disjoint")
    if any(p.fullmatch(particle) for p in patterns for particle in particles):
        raise ValueError("a filler pattern matches a protected particle")
    reduplication = set()
    for pair in redup.get("pairs", []):
        halves = pair.split(" ") if isinstance(pair, str) else []
        if len(halves) != 2 or halves[0] != halves[1]:
            raise ValueError(f"pairs: {pair!r} is not a reduplicated word 'w w'")
        reduplication |= _words(halves[:1], "pairs")
    contextual: dict[str, frozenset[str]] = {}
    for entry in redup.get("contextual", []):
        if not isinstance(entry, dict) or set(entry) != {"word", "followed_by"}:
            raise ValueError("contextual entries are {word, followed_by}")
        (word,) = _words([entry["word"]], "contextual")
        contextual[word] = _words(entry["followed_by"], "followed_by")
    if fillers.get("precheck") not in (True, False) or type(fillers["precheck"]) is not bool:
        raise ValueError("precheck must be true or false")
    digest = hashlib.sha256()
    for name, raw in ((FILLERS_FILE, fillers_raw), (REDUPLICATION_FILE, redup_raw)):
        digest.update(name.encode() + b"\0" + raw + b"\0")
    return Lexicon(
        version="id-fillers.v1+id-reduplication.v1",
        sha256=digest.hexdigest(),
        fillers=filler_words,
        filler_patterns=tuple(patterns),
        filler_phrases=tuple(phrases),
        interjection_patterns=tuple(interjections),
        quotatives=_words(fillers.get("quotatives"), "quotatives"),
        address_terms=_words(fillers.get("address_terms"), "address_terms"),
        particles=particles,
        pronouns=pronouns,
        stutter_words=stutter,
        reduplication=frozenset(reduplication),
        emphatic=_words(redup.get("emphatic"), "emphatic"),
        vocal_sounds=_words(redup.get("vocal_sounds"), "vocal_sounds"),
        contextual=contextual,
        filler_precheck=fillers["precheck"],
    )


_lexicons: dict[str, tuple[tuple[int, ...], Lexicon]] = {}


def load_lexicon(directory: Path | None = None) -> Lexicon:
    """The lexicon under ``directory`` (default ``resources/lexicon``), cached per file state.

    Raises ``ValueError`` (or ``OSError``) for a missing or malformed file.
    """
    directory = LEXICON_DIR if directory is None else Path(directory)
    stamp: tuple[int, ...] = ()
    for name in (FILLERS_FILE, REDUPLICATION_FILE):
        info = (directory / name).stat()
        stamp += (info.st_ino, info.st_size, info.st_mtime_ns)
    cached = _lexicons.get(str(directory))
    if cached is not None and cached[0] == stamp:
        return cached[1]
    lexicon = _load(directory)
    _lexicons[str(directory)] = (stamp, lexicon)
    return lexicon


# --- tokens ----------------------------------------------------------------------------------------


def normalize(text: str) -> str:
    """Case-folded NFC text without the punctuation at either end (``"Eh,"`` → ``"eh"``)."""
    return _EDGE.sub("", unicodedata.normalize("NFC", text).casefold())


def _ends_sentence(raw: str) -> bool:
    text = raw.rstrip().rstrip(_CLOSERS)
    return bool(text) and text[-1] in _TERMINAL


def _is_question(raw: str) -> bool:
    return raw.rstrip().rstrip(_CLOSERS).endswith("?")


def _hyphen_join(left: str, right: str) -> bool:
    return right.lstrip().startswith(_HYPHENS) or left.rstrip().endswith(_HYPHENS)


def _overlap(start: int, end: int, spans: Sequence[Sequence[int]]) -> int:
    return sum(max(0, min(end, b) - max(start, a)) for a, b in spans)


# --- the review list ---------------------------------------------------------------------------------

# (kind, first removed word, last removed word, (first kept, last kept) for repeats)
_Span = tuple[str, int, int, "tuple[int, int] | None"]


class _Scan:
    def __init__(self, words: Mapping[str, Any], lexicon: Lexicon) -> None:
        self.entries = list(words["words"])
        self.raw = [str(entry["t"]) for entry in self.entries]
        self.tokens = [normalize(text) for text in self.raw]
        self.silences = [tuple(span) for span in words.get("silences") or ()]
        self.lexicon = lexicon
        self.claimed = [False] * len(self.entries)

    def _free(self, first: int, last: int) -> bool:
        return not any(self.claimed[first:last + 1])

    def _claim(self, first: int, last: int) -> None:
        for index in range(first, last + 1):
            self.claimed[index] = True

    def _filler_length(self, index: int) -> int:
        tokens = self.tokens
        for phrase in self.lexicon.filler_phrases:
            end = index + len(phrase)
            if tuple(tokens[index:end]) == phrase and self._free(index, end - 1) and not any(
                    _ends_sentence(self.raw[k]) for k in range(index, end - 1)):
                return len(phrase)
        if self._free(index, index) and self.lexicon.is_filler(tokens[index]) \
                and not _is_question(self.raw[index]) and not self._not_a_hesitation(index):
            return 1
        return 0

    def _not_a_hesitation(self, index: int) -> bool:
        """A filler-lexicon token that means something here: an acronym in capitals ("HM"), a
        letter spelled among letters ("A B C D E"), or an interjection ("eh") that belongs to
        quoted speech ("kayak, eh tunggu dulu") or speaks to someone ("Eh, Bang")."""
        raw, tokens, lexicon = self.raw, self.tokens, self.lexicon
        bare = _EDGE.sub("", raw[index])
        if sum(char.isalpha() for char in bare) >= 2 and bare.isupper():
            return True
        neighbours = [tokens[k] for k in (index - 1, index + 1) if 0 <= k < len(tokens)]
        if len(tokens[index]) == 1 and any(len(word) == 1 and word.isalpha() for word in neighbours):
            return True
        if not any(pattern.fullmatch(tokens[index]) for pattern in lexicon.interjection_patterns):
            return False
        quoted = index > 0 and tokens[index - 1] in lexicon.quotatives \
            and not _ends_sentence(raw[index - 1])
        addressed = index + 1 < len(tokens) and tokens[index + 1] in lexicon.address_terms
        return quoted or addressed

    def fillers(self) -> list[_Span]:
        found = []
        index = 0
        count = len(self.entries)
        while index < count:
            length = self._filler_length(index)
            if not length:
                index += 1
                continue
            end = index + length  # exclusive
            while end < count:
                gap = self.entries[end]["s"] - self.entries[end - 1]["e"]
                more = self._filler_length(end) if gap <= FILLER_RUN_MAX_GAP_MS else 0
                if not more:
                    break
                end += more
            self._claim(index, end - 1)
            found.append(("filler", index, end - 1, None))
            index = end
        return found

    def _same(self, left: int, right: int) -> bool:
        return (self.tokens[left] != "" and self.tokens[left] == self.tokens[right]
                and not _ends_sentence(self.raw[left])
                and not _hyphen_join(self.raw[left], self.raw[right]))

    def _silent_between(self, left: int, right: int) -> bool:
        start, end = self.entries[left]["e"], self.entries[right]["s"]
        return end > start and _overlap(start, end, self.silences) >= REPEAT_SILENCE_MS

    def _possessive(self, index: int) -> bool:
        """``"bantuan gue, gue ngerasa"``: a pronoun with a comma after a content word is the
        possessive of that word, and the next one the subject of a new clause."""
        if self.tokens[index] not in self.lexicon.pronouns or index == 0:
            return False
        if not self.raw[index].rstrip().rstrip(_CLOSERS).endswith(","):
            return False
        previous = index - 1
        return (not _ends_sentence(self.raw[previous]) and self.tokens[previous] != ""
                and self.tokens[previous] not in self.lexicon.stutter_words
                and self.tokens[previous] not in self.lexicon.particles
                and not self.lexicon.is_filler(self.tokens[previous]))

    def token_repeats(self) -> list[_Span]:
        found = []
        count = len(self.entries)
        index = 0
        while index < count - 1:
            last = index
            while last + 1 < count and self._same(last, last + 1):
                last += 1
            if last == index:
                index += 1
                continue
            token = self.tokens[index]
            following = self.tokens[last + 1] if last + 1 < count else None
            listed = (self._free(index, last - 1) and not self.lexicon.never_repeats(token, following)
                      and not self.lexicon.is_filler(token) and not self._possessive(index)
                      and not _ends_sentence(self.raw[last])  # an echo ends the sentence
                      and (token in self.lexicon.stutter_words
                           or all(self._silent_between(k, k + 1) for k in range(index, last))))
            if listed:
                self._claim(index, last - 1)
                found.append(("repeat", index, last - 1, (last, last)))
            index = last + 1
        return found

    def phrase_repeats(self) -> list[_Span]:
        found = []
        count = len(self.entries)
        lexicon = self.lexicon
        for size in PHRASE_LENGTHS:
            index = 0
            while index + 2 * size <= count:
                first = range(index, index + size)
                second = range(index + size, index + 2 * size)
                words = self.tokens[index:index + size]
                ok = (words == self.tokens[index + size:index + 2 * size]
                      and all(words) and len(set(words)) > 1
                      and self._free(index, index + size - 1)
                      and not any(word in lexicon.particles for word in words)
                      and not all(lexicon.is_filler(word) for word in words)
                      and not any(_ends_sentence(self.raw[k])
                                  for k in range(first.start, second.stop))
                      and not any(_hyphen_join(self.raw[k], self.raw[k + 1])
                                  for k in range(first.start, second.stop - 1))
                      and self.entries[second.start]["s"] - self.entries[first.start]["s"]
                      <= PHRASE_WINDOW_MS)
                if ok:
                    self._claim(first.start, first.stop - 1)
                    found.append(("repeat", first.start, first.stop - 1,
                                  (second.start, second.stop - 1)))
                    index += 2 * size
                else:
                    index += 1
        return found


def _laughter(words: Mapping[str, Any]) -> list[tuple[int, int]]:
    return [(event["s"], event["e"]) for event in words.get("events") or ()
            if event.get("kind") == "laughter"]


def _near_laughter(start: int, end: int, laughs: Sequence[tuple[int, int]]) -> bool:
    return any(s <= end + LAUGHTER_LOCK_MS and e >= start - LAUGHTER_LOCK_MS for s, e in laughs)


class _Quiet:
    """Whether a cut at a source time is quiet: every 10 ms peaks bin within ±10 ms of it is at
    most ``QUIET_LEVEL`` (a peak below −36 dBFS). Without peaks every cut counts as quiet."""

    def __init__(self, words: Mapping[str, Any], peaks: bytes | None) -> None:
        info = words.get("peaks") or {}
        usable = (peaks is not None and info.get("per_sec") == 100
                  and type(info.get("start_ms")) is int)
        self.peaks = peaks if usable else None
        self.start = info.get("start_ms", 0)
        self.bins = len(peaks) // 2 if self.peaks is not None else 0

    def __call__(self, at: Fraction) -> bool:
        if self.peaks is None:
            return True
        first = math.floor((at - QUIET_HALF_MS - self.start) / _BIN_MS)
        last = math.ceil((at + QUIET_HALF_MS - self.start) / _BIN_MS)
        if first < 0 or last > self.bins:
            return False
        return all(bin_level(self.peaks, index) <= QUIET_LEVEL for index in range(first, last))


def _gap_frames(start: int, end: int, fps: tm.Fps, quiet: _Quiet) -> tuple[int, int] | None:
    """The cut of a silent gap: 100 ms kept after the word before and before the word after,
    each edge moved towards the middle to the first frame boundary with a quiet ±10 ms."""
    centre = Fraction(start + end, 2)
    first = tm.sf_ceil(start + GAP_KEEP_EACH_SIDE_MS, fps)
    while edge_ms(first, fps) <= centre and not quiet(edge_ms(first, fps)):
        first += 1
    last = tm.sf_floor(end - GAP_KEEP_EACH_SIDE_MS, fps)
    while edge_ms(last, fps) >= centre and not quiet(edge_ms(last, fps)):
        last -= 1
    return (first, last) if first < last and quiet(edge_ms(first, fps)) \
        and quiet(edge_ms(last, fps)) else None


def _clean_cut(item: Mapping[str, Any], words: Mapping[str, Any], fps: tm.Fps,
               quiet: _Quiet) -> bool:
    """A word item cuts at its ``bounds`` frames: neither may be tight (inside a word) or loud."""
    if not words.get("bounds"):
        return True
    return all(not edge["tight"] and quiet(edge_ms(edge["sf"], fps))
               for edge in removal_edges(item, words))


_KIND_ORDER = {"filler": 0, "repeat": 1, "gap_silent": 2, "gap_voiced": 3}


def build_cleanup(words: Mapping[str, Any], *, lexicon: Lexicon | None = None,
                  peaks: bytes | None = None) -> dict[str, Any]:
    """The Rapikan review list of a words artifact (see the module docstring). ``peaks`` are
    the clip's ``peaks.<sha16>.bin`` (the words artifact names them); with them every cut is
    placed at, or checked for, a quiet point."""
    lexicon = load_lexicon() if lexicon is None else lexicon
    fps = tm.Fps.from_json(words["fps"])
    quiet = _Quiet(words, peaks)
    scan = _Scan(words, lexicon)
    entries = scan.entries
    laughs = _laughter(words)
    precheck = lexicon.filler_precheck
    candidates: list[tuple[int, int, dict[str, Any]]] = []
    locked: list[tuple[int, dict[str, Any]]] = []

    spans = scan.fillers() + scan.token_repeats() + scan.phrase_repeats()
    for kind, first, last, kept in spans:
        word_ids = [entry["id"] for entry in entries[first:last + 1]]
        s, e = entries[first]["s"], entries[last]["e"]
        reason = ("laughter" if _near_laughter(s, e, laughs)
                  else None if _clean_cut({"kind": kind, "wordIds": word_ids}, words, fps, quiet)
                  else "no_quiet_cut")
        if reason is not None:
            locked.append((s, {"kind": kind, "reason": reason, "s": s, "e": e,
                               "wordIds": word_ids}))
            continue
        item: dict[str, Any] = {"kind": kind, "wordIds": word_ids, "s": s, "e": e,
                                "defaultOn": precheck if kind == "filler" else False}
        if kept is not None:
            item["repeatOf"] = [entry["id"] for entry in entries[kept[0]:kept[1] + 1]]
        candidates.append((s, _KIND_ORDER[kind], item))

    following = {entry["id"]: entries[k + 1]["id"] for k, entry in enumerate(entries[:-1])}
    for gap in words.get("gaps") or ():
        after, s, e = gap["after"], gap["s"], gap["e"]
        before = following.get(after)
        if before is None:
            continue
        if gap["class"] == "laughter":
            locked.append((s, {"kind": "gap", "reason": "laughter", "s": s, "e": e,
                               "afterWord": after}))
        elif gap["class"] == "silent":
            cut = _gap_frames(s, e, fps, quiet)
            if cut is None:
                locked.append((s, {"kind": "gap", "reason": "no_quiet_cut", "s": s, "e": e,
                                   "afterWord": after}))
            else:
                candidates.append((s, _KIND_ORDER["gap_silent"], {
                    "kind": "gap_silent", "afterWord": after, "beforeWord": before, "s": s, "e": e,
                    "inSf": cut[0], "outSf": cut[1], "defaultOn": True}))
        elif gap["class"] == "voiced":
            candidates.append((s, _KIND_ORDER["gap_voiced"], {
                "kind": "gap_voiced", "afterWord": after, "beforeWord": before, "s": s, "e": e,
                "defaultOn": False, "applicable": False}))

    candidates.sort(key=lambda entry: (entry[0], entry[1]))
    items = []
    for number, (_s, _order, item) in enumerate(candidates, start=1):
        items.append({"id": f"{ITEM_ID_PREFIX}{number}", **item})
    locked.sort(key=lambda entry: entry[0])
    return {
        "schema": SCHEMA,
        "lexicon": {"version": lexicon.version, "sha256": lexicon.sha256},
        "fillerPrecheck": precheck,
        "missing": list(words.get("missing") or ()),
        "items": items,
        "locked": [entry for _s, entry in locked],
    }


def removal_edges(item: Mapping[str, Any], words: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The two cut edges an item makes: ``[{sf, tight, gap: [l, r]}, …]`` (in, out).

    Word items cut at the ``bounds`` frames of the gap before the first and after the last
    removed word (as ``RemoveWords`` does); ``gap`` is that word gap in source ms (the window
    edge when there is no neighbouring word). Gap items cut at ``inSf``/``outSf`` inside the
    gap. ``gap_voiced`` items make no cut.
    """
    if item["kind"] == "gap_silent":
        span = [item["s"], item["e"]]
        return [{"sf": item["inSf"], "tight": False, "gap": span},
                {"sf": item["outSf"], "tight": False, "gap": span}]
    if item["kind"] == "gap_voiced":
        return []
    entries = words["words"]
    position = {entry["id"]: index for index, entry in enumerate(entries)}
    first, last = position[item["wordIds"][0]], position[item["wordIds"][-1]]
    before = {entry["before"]: entry for entry in words["bounds"] if entry["before"] is not None}
    after = {entry["after"]: entry for entry in words["bounds"] if entry["after"] is not None}
    window = words["window_ms"]
    left = entries[first - 1]["e"] if first > 0 else window[0]
    right = entries[last + 1]["s"] if last + 1 < len(entries) else window[1]
    enter = before.get(entries[first]["id"]) or after[entries[first - 1]["id"]]
    leave = after.get(entries[last]["id"]) or before[entries[last + 1]["id"]]
    return [{"sf": enter["sf"], "tight": bool(enter["tight"]), "gap": [left, entries[first]["s"]]},
            {"sf": leave["sf"], "tight": bool(leave["tight"]), "gap": [entries[last]["e"], right]}]


def edge_ms(sf: int, fps: tm.Fps) -> Fraction:
    """The start time (ms, exact) of source-grid frame ``sf``."""
    return Fraction(sf * 1000 * fps.den, fps.num)


# --- CLI -----------------------------------------------------------------------------------------------


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _envelope(raw: bytes) -> dict[str, str]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs_hook,
                           parse_constant=lambda _value: _Usage())
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict or set(value) != {"op", "jobId", "clipId"} \
            or value["op"] not in OPS:
        raise _Usage()
    job_id, clip_id = value["jobId"], value["clipId"]
    if not isinstance(job_id, str) or not _UUID.fullmatch(job_id) \
            or not isinstance(clip_id, str) or not CLIP_ID_PATTERN.fullmatch(clip_id):
        raise _Usage()
    return value


def _real_dir(path: Path) -> Path:
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        raise NotFound() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise NotFound()
    return path


def _clip_dir(jobs_root: str | os.PathLike | None, job_id: str, clip_id: str) -> Path:
    if jobs_root is None or str(jobs_root) == "":
        raise EditV2Error("internal_error")
    try:
        root = Path(jobs_root).resolve(strict=True)
    except OSError:
        raise EditV2Error("internal_error") from None
    path = root
    for part in (job_id, "analysis", "clips", clip_id):
        path = _real_dir(path / part)
    return path


def _words_sha(clip: Path) -> str:
    """The words artifact the editor shows: the document's, else (read-only) the seed's."""
    doc, _etag, _is_seed = store.get(clip)
    seed_doc, _seed_etag = store.seed(clip)
    sha = doc["base"]["words"]["sha256"]
    if store.words_exist(clip, sha):
        return sha
    seed_sha = seed_doc["base"]["words"]["sha256"]
    if seed_sha != sha and store.words_exist(clip, seed_sha):
        return seed_sha
    raise AnalysisMissing()


def _peaks(clip: Path, words: Mapping[str, Any]) -> bytes | None:
    """The clip's peaks file named by the words artifact, when present and intact."""
    name = (words.get("peaks") or {}).get("file")
    if not isinstance(name, str) or _PEAKS_NAME.fullmatch(name) is None:
        return None
    path = clip / name
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PEAKS_BYTES:
        return None
    raw = path.read_bytes()
    return raw if hashlib.sha256(raw).hexdigest()[:16] == name[6:22] else None


def clip_listing(clip: Path) -> dict[str, Any]:
    """The review list of a clip directory, exactly as the CLI answers it (peaks included)."""
    clip = Path(clip)
    sha = _words_sha(clip)
    words = store.load_words(clip, sha)
    return {"clipId": clip.name, "wordsSha256": sha,
            **build_cleanup(words, peaks=_peaks(clip, words))}


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never raises; only fixed codes leave."""
    usage = {"error": {"code": "internal_error", "path": None, "ref": None,
                       "messageId": message_id("internal_error")}}
    try:
        envelope = _envelope(raw)
        clip = _clip_dir(jobs_root, envelope["jobId"], envelope["clipId"])
        return EXIT_OK, clip_listing(clip)
    except _Usage:
        return EXIT_USAGE, usage
    except EditV2Error as error:
        return exit_code_for(error), {"error": {"code": error.code, "path": None, "ref": None,
                                                "messageId": message_id(error.code)}}
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        return EXIT_INTERNAL, usage


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; returns the process exit code."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments:
        code, payload = EXIT_USAGE, handle(b"", jobs_root=None)[1]
    else:
        raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        code, payload = handle(raw, jobs_root=os.environ.get("JOBS_ROOT"))
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                            .encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return code


__all__ = [
    "LEXICON_DIR",
    "OPS",
    "SCHEMA",
    "Lexicon",
    "build_cleanup",
    "clip_listing",
    "edge_ms",
    "handle",
    "load_lexicon",
    "main",
    "normalize",
    "removal_edges",
]


if __name__ == "__main__":
    raise SystemExit(main())
