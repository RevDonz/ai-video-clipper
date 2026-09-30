"""Cold-open candidates for the cold-open panel (plan §7.2): heuristic only, no LLM.

Owner: T3.7. :func:`build_candidates` returns at most :data:`MAX_CANDIDATES` ranges of whole
words of the clip's words artifact, in this order:

1. ``selection``: the clip's cold open from the selection, as the words whose midpoint lies in
   it. That is the seed's cold-open segment, or, for a job that ran without cold open, the
   selection clip's ``cold_open`` (the CLI reads ``analysis/selection.v3.json`` and uses it only
   when its sha256 is the seed's ``selection_artifact_sha256``).
2. ``hook``: the hook sentence (``base.origin.hook_unit_id``).
3. ``strong``: up to :data:`STRONG_LIMIT` other sentences of the seed body with the highest
   ``hook_heuristics._analyse_unit`` strength (> 0), skipping sponsor, greeting, outro,
   backchannel and pronoun-led sentences. Only body sentences are offered: a cold open teases a
   moment the clip then plays.

Every candidate then goes through the same rules:

* **Laughter tail.** When a laughter event starts between :data:`LAUGH_LEAD_MS` before and
  :data:`LAUGH_TAIL_MS` after the last word's end, the words that follow are added while they
  start before the event's end + :data:`LAUGH_TAIL_MS` and are laughter themselves (a
  transcript laughter token) or a short backchannel sentence spoken into the laugh (at most
  :data:`BACKCHANNEL_MAX_WORDS` words and :data:`BACKCHANNEL_MAX_MS`). A real sentence is never
  pulled in (``selection_v3`` does the same for clip ends).
* **Word-snapped and valid.** The edges are the ``bounds`` frames of the first and last word,
  exactly what the SetColdOpen command stores, and the seed with this cold open must pass
  ``doc.validate_doc`` (§3.4: 0.5–8 s, never only the opening again, inside the window). A
  laughter tail that breaks a rule is dropped and the plain sentence kept.
* **No duplicates.** A candidate whose frames equal, or overlap by more than half, an earlier
  candidate's is dropped. Ids are ``co_1``… in the final order.

Sentence units come from ``output/transcript.json`` exactly as the words artifact builds them,
when that transcript still hashes to the artifact's ``transcript_sha256``; otherwise they are
rebuilt from the artifact itself (:func:`units_from_words`: the words' display text, no suspect
flag), so a job whose transcript is gone still gets suggestions.

CLI (``python -m ai_clipper.edit_v2.coldopen``, protocol of CONTRACTS §5.9): stdin
``{"op": "list", "jobId", "clipId"}`` → ``{wordsSha256, candidates: [Candidate.to_json()]}``
for the seed's words artifact. Read-only; exit codes ``errors.EXIT_*`` (4 unknown job, clip or
seed; 8 no words artifact yet; 2 malformed envelope; 1 anything else).
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import stat
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..hook_heuristics import _analyse_unit
from ..models import TranscriptWord
from ..sentences import SentenceUnit
from . import store
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN, ms_from_seconds
from .errors import (
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_USAGE,
    EditV2Error,
    NotFound,
    exit_code_for,
    message_id,
)

OPS = ("list",)
MAX_CANDIDATES = 5
STRONG_LIMIT = 3
LAUGH_LEAD_MS = 500  # selection_v3.LAUGH_LEAD_SECONDS
LAUGH_TAIL_MS = 800  # selection_v3.LAUGH_TAIL_SECONDS
BACKCHANNEL_MAX_WORDS = 3  # selection_v3.BACKCHANNEL_MAX_WORDS
BACKCHANNEL_MAX_MS = 1500  # selection_v3.BACKCHANNEL_MAX_SECONDS
JOIN_FADE_MS = 30
SOURCES = ("selection", "hook", "strong")
MAX_ENVELOPE_BYTES = 4096
MAX_TRANSCRIPT_BYTES = 16 << 20
MAX_SELECTION_BYTES = 8 << 20
SELECTION_RELATIVE_PATH = Path("analysis") / "selection.v3.json"
TRANSCRIPT_RELATIVE_PATH = Path("output") / "transcript.json"

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                   re.IGNORECASE)
_WORD_ID = re.compile(r"w[0-9]{6,7}")
_UNIT_ID = re.compile(r"S[0-9]{4,}")
_SHA = re.compile(r"[0-9a-f]{64}")

# The strongest hook tag of a sentence, as the reason shown under the suggestion.
_TAG_REASONS = (
    ("confession", "Pengakuan jujur"),
    ("insider", "Cerita di balik layar"),
    ("stakes", "Momen genting"),
    ("reveal", "Ada kejutan"),
    ("contrast", "Kalimat kontras"),
    ("superlative", "Pengalaman pertama atau paling"),
    ("number", "Ada angka konkret"),
    ("reported", "Mengutip ucapan orang"),
    ("story", "Pembuka cerita"),
)


@dataclass(frozen=True)
class Candidate:
    """One suggested cold open: whole words ``first_word``…``last_word``, snapped frames."""

    id: str
    source: str
    first_word: str
    last_word: str
    in_sf: int
    out_sf: int
    frames: int
    dur_ms: int
    unit_ids: tuple[str, ...]
    text: str
    question: bool
    laugh_tail: bool
    reason: str

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "source": self.source, "firstWord": self.first_word,
                "lastWord": self.last_word, "inSf": self.in_sf, "outSf": self.out_sf,
                "frames": self.frames, "durMs": self.dur_ms, "unitIds": list(self.unit_ids),
                "text": self.text, "question": self.question, "laughTail": self.laugh_tail,
                "reason": self.reason}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Candidate:
        return cls(value["id"], value["source"], value["firstWord"], value["lastWord"],
                   value["inSf"], value["outSf"], value["frames"], value["durMs"],
                   tuple(value["unitIds"]), value["text"], value["question"],
                   value["laughTail"], value["reason"])


@dataclass(frozen=True)
class _Draft:
    source: str
    first: int
    last: int
    reason: str


# --- sentence units ------------------------------------------------------------------------------


def units_from_words(words: Mapping[str, Any]) -> list[SentenceUnit]:
    """The artifact's sentence units rebuilt from its own words (display text, no suspect flag).

    Used when the transcript is gone or no longer matches the artifact; ``_analyse_unit`` reads
    only the text, times, gap, question and suspect fields.
    """
    members: dict[str, list[Mapping[str, Any]]] = {}
    for word in words["words"]:
        if word.get("u") is not None:
            members.setdefault(word["u"], []).append(word)
    units: list[SentenceUnit] = []
    previous_end: float | None = None
    for entry in words["units"]:
        listed = members.get(entry["id"])
        if not listed or not _UNIT_ID.fullmatch(entry["id"]):
            continue
        start, end = entry["s"] / 1000, max(entry["e"], entry["s"]) / 1000
        spoken = tuple(TranscriptWord(w["s"] / 1000, w["e"] / 1000, w["t"],
                                      None if w["p_pm"] is None else w["p_pm"] / 1000)
                       for w in listed)
        units.append(SentenceUnit(
            unit_id=entry["id"], index=int(entry["id"][1:]) - 1, start=start, end=end,
            text=" ".join(w["t"] for w in listed), segment_start=0, segment_end=0,
            word_count=len(listed), is_question=bool(entry["q"]),
            gap_before=0.0 if previous_end is None else max(0.0, start - previous_end),
            suspect=False, words=spoken))
        previous_end = end
    return units


def units_from_transcript(raw: bytes, words: Mapping[str, Any]) -> list[SentenceUnit] | None:
    """Sentence units of the transcript bytes, exactly as the words artifact built them, or
    None when the transcript does not hash to the artifact's ``transcript_sha256``."""
    from ..sentences import build_sentence_units
    from ..transcript_io import transcription_from_json_bytes
    from ..transcript_quality import assess_transcript
    from .words import transcript_sha256

    transcription = transcription_from_json_bytes(raw)
    if transcript_sha256(transcription) != words.get("transcript_sha256"):
        return None
    quality = assess_transcript(transcription.segments, language=transcription.language or "id")
    listed = {entry["id"] for entry in words["units"]}
    return [unit for unit in build_sentence_units(transcription.segments, quality=quality)
            if unit.unit_id in listed]


# --- candidates ----------------------------------------------------------------------------------


class _Clip:
    """Lookups over one clip's seed and words artifact."""

    def __init__(self, seed: Mapping[str, Any], words: Mapping[str, Any],
                 units: Sequence[SentenceUnit] | None) -> None:
        self.seed = seed
        self.words = words
        self.fps = tm.Fps.from_json(seed["output"]["fps"])
        self.list = words["words"]
        self.before = {b["before"]: b["sf"] for b in words["bounds"] if b["before"] is not None}
        self.after = {b["after"]: b["sf"] for b in words["bounds"] if b["after"] is not None}
        self.mid = [(w["s"] + w["e"]) * self.fps.num // (2000 * self.fps.den) for w in self.list]
        self.members: dict[str, list[int]] = {}
        for index, word in enumerate(self.list):
            if word.get("u") is not None:
                self.members.setdefault(word["u"], []).append(index)
        self.question = {entry["id"]: bool(entry["q"]) for entry in words["units"]}
        self.units = {unit.unit_id: unit for unit in
                      (units if units is not None else units_from_words(words))}
        self._analysis: dict[str, Any] = {}
        self.laughs = sorted((event for event in words["events"] if event["kind"] == "laughter"),
                             key=lambda event: (event["s"], event["e"]))
        self.laugh_words = {(event["s"], event["e"]) for event in self.laughs
                            if event["src"] == "transcript"}
        self.body = next(s for s in seed["main"]["segments"] if s["role"] == "body")
        self._baseline = self._errors(self._with_cold_open(None))

    def analyse(self, unit_id: str) -> Any | None:
        if unit_id not in self._analysis:
            unit = self.units.get(unit_id)
            self._analysis[unit_id] = None if unit is None else _analyse_unit(unit)
        return self._analysis[unit_id]

    def in_body(self, unit_id: str) -> bool:
        indices = self.members.get(unit_id, [])
        return bool(indices) and all(self.body["in_sf"] <= self.mid[i] < self.body["out_sf"]
                                     for i in indices)

    # validity against the seed (plan §3.4, through the one validator)

    def _with_cold_open(self, span: tuple[int, int] | None) -> dict[str, Any]:
        doc = copy.deepcopy(dict(self.seed))
        main = doc["main"]
        fade = main["joins"][0]["audio_fade_ms"] if main["joins"] else JOIN_FADE_MS
        main["segments"] = [s for s in main["segments"] if s["role"] == "body"]
        main["removals"] = [r for r in main["removals"] if r["seg"] == self.body["id"]]
        main["joins"] = []
        if span is not None:
            main["segments"].insert(0, {"id": "seg_co", "role": "cold_open", "in_sf": span[0],
                                        "out_sf": span[1]})
            main["joins"] = [{"after": "seg_co", "style": "cut", "audio_fade_ms": fade}]
        return doc

    def _errors(self, doc: Mapping[str, Any]) -> set[tuple[str, str]]:
        from .doc import validate_doc

        validation = validate_doc(doc, words=self.words, assets=self.seed.get("assets", {}),
                                  seed=None)
        return {(issue.code, issue.path) for issue in validation.errors}

    def valid(self, in_sf: int, out_sf: int) -> bool:
        return in_sf < out_sf and self._errors(self._with_cold_open((in_sf, out_sf))) \
            <= self._baseline

    # the laughter tail

    def laugh_tail(self, last: int) -> int:
        """The new last word after the laughter that follows word ``last`` (or ``last``)."""
        end = self.list[last]["e"]
        event = next((ev for ev in self.laughs
                      if end - LAUGH_LEAD_MS <= ev["s"] <= end + LAUGH_TAIL_MS), None)
        if event is None:
            return last
        limit = event["e"] + LAUGH_TAIL_MS
        current = last
        index = last + 1
        while index < len(self.list) and self.list[index]["s"] < limit:
            word = self.list[index]
            if (word["s"], word["e"]) in self.laugh_words:
                current = index
                index += 1
                continue
            unit = word.get("u")
            indices = self.members.get(unit, []) if unit is not None else []
            if unit != self.list[last].get("u") and indices and indices[0] == index \
                    and self._backchannel(unit):
                current = indices[-1]
                index = current + 1
                continue
            break
        return current

    def _backchannel(self, unit_id: str) -> bool:
        indices = self.members[unit_id]
        span = self.list[indices[-1]]["e"] - self.list[indices[0]]["s"]
        analysis = self.analyse(unit_id)
        return len(indices) <= BACKCHANNEL_MAX_WORDS and span <= BACKCHANNEL_MAX_MS \
            and analysis is not None and (analysis.backchannel or analysis.reaction)

    # the candidate

    def candidate(self, draft: _Draft) -> tuple[int, int, int, bool] | None:
        """``(first, last, out_sf, laugh_tail)`` of a valid candidate, or None."""
        extended = self.laugh_tail(draft.last)
        in_sf = self.before.get(self.list[draft.first]["id"])
        for last in dict.fromkeys((extended, draft.last)):
            out_sf = self.after.get(self.list[last]["id"])
            if in_sf is not None and out_sf is not None and self.valid(in_sf, out_sf):
                return draft.first, last, out_sf, last != draft.last
        return None


def _strong_reason(analysis: Any, question: bool) -> str:
    parts = ["Pertanyaan"] if question else []
    parts += [text for tag, text in _TAG_REASONS if tag in analysis.tags][:2 - len(parts)]
    if not parts:
        return "Kalimat yang memancing penasaran"
    return ", ".join([parts[0], *(part[0].lower() + part[1:] for part in parts[1:])])


def _drafts(clip: _Clip, selection_cold_open_ms: tuple[int, int] | None) -> list[_Draft]:
    drafts: list[_Draft] = []
    taken: set[str] = set()
    cold = next((s for s in clip.seed["main"]["segments"] if s["role"] == "cold_open"), None)
    span, reason = None, ""
    if cold is not None:
        span, reason = (cold["in_sf"], cold["out_sf"]), "Cold open yang dipakai saat klip dibuat"
    elif selection_cold_open_ms is not None:
        a, b = selection_cold_open_ms
        span = (tm.sf_floor(a, clip.fps), tm.sf_ceil(b, clip.fps))
        reason = "Cold open yang disarankan saat klip dibuat"
    if span is not None:
        inside = [i for i, mid in enumerate(clip.mid) if span[0] <= mid < span[1]]
        if inside:
            drafts.append(_Draft("selection", inside[0], inside[-1], reason))
            taken |= {clip.list[i]["u"] for i in inside if clip.list[i].get("u")}
    hook = clip.seed["base"]["origin"].get("hook_unit_id")
    if hook in clip.members:
        indices = clip.members[hook]
        question = ", berupa pertanyaan" if clip.question.get(hook) else ""
        drafts.append(_Draft("hook", indices[0], indices[-1], f"Kalimat hook klip ini{question}"))
        taken.add(hook)
    ranked = []
    for unit_id, indices in clip.members.items():
        if unit_id in taken or not clip.in_body(unit_id):
            continue
        analysis = clip.analyse(unit_id)
        if analysis is None or analysis.strength <= 0 or analysis.sponsor or analysis.greeting \
                or analysis.outro or analysis.backchannel or analysis.pronoun_led:
            continue
        ranked.append((-analysis.strength, clip.list[indices[0]]["s"], unit_id))
    for _strength, _start, unit_id in sorted(ranked):
        indices = clip.members[unit_id]
        reason = _strong_reason(clip.analyse(unit_id), clip.question.get(unit_id, False))
        drafts.append(_Draft("strong", indices[0], indices[-1], reason))
    return drafts


def _overlaps(a: tuple[int, int], b: tuple[int, int]) -> bool:
    shared = min(a[1], b[1]) - max(a[0], b[0])
    return a == b or 2 * shared > min(a[1] - a[0], b[1] - b[0])


def build_candidates(
    seed: Mapping[str, Any],
    words: Mapping[str, Any],
    *,
    units: Sequence[SentenceUnit] | None = None,
    selection_cold_open_ms: tuple[int, int] | None = None,
) -> tuple[Candidate, ...]:
    """The cold-open candidates of a clip (see the module docstring for the rules).

    ``units`` are the transcript's sentence units (default: rebuilt from ``words``);
    ``selection_cold_open_ms`` is the selection's cold open when the seed has none.
    """
    clip = _Clip(seed, words, units)
    found: list[Candidate] = []
    strong = 0
    for draft in _drafts(clip, selection_cold_open_ms):
        if len(found) >= MAX_CANDIDATES or (draft.source == "strong" and strong >= STRONG_LIMIT):
            continue
        result = clip.candidate(draft)
        if result is None:
            continue
        first, last, out_sf, tail = result
        in_sf = clip.before[clip.list[first]["id"]]
        if any(_overlaps((in_sf, out_sf), (c.in_sf, c.out_sf)) for c in found):
            continue
        members = clip.list[first:last + 1]
        unit_ids = tuple(dict.fromkeys(w["u"] for w in members if w.get("u") is not None))
        frames = out_sf - in_sf
        reason = draft.reason + (", sampai tawanya selesai" if tail else "")
        found.append(Candidate(
            id=f"co_{len(found) + 1}", source=draft.source, first_word=members[0]["id"],
            last_word=members[-1]["id"], in_sf=in_sf, out_sf=out_sf, frames=frames,
            dur_ms=tm.div_round_half_up(frames * 1000 * clip.fps.den, clip.fps.num),
            unit_ids=unit_ids, text=" ".join(w["t"] for w in members),
            question=any(clip.question.get(unit, False) for unit in unit_ids),
            laugh_tail=tail, reason=reason))
        strong += draft.source == "strong"
    return tuple(found)


# --- CLI -----------------------------------------------------------------------------------------


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _Usage()
    return result


def _reject(_value: str) -> Any:
    raise _Usage()


def _envelope(raw: bytes) -> dict[str, str]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=_reject, parse_float=_reject)
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict or set(value) != {"op", "jobId", "clipId"} \
            or value["op"] not in OPS:
        raise _Usage()
    job, clip = value["jobId"], value["clipId"]
    if not isinstance(job, str) or not _UUID.fullmatch(job) or not isinstance(clip, str) \
            or not CLIP_ID_PATTERN.fullmatch(clip):
        raise _Usage()
    return value


def _real_dir(path: Path) -> Path:
    """An existing directory that is not a symlink, else NotFound."""
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        raise NotFound() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise NotFound()
    return path


def _dirs(jobs_root: str | os.PathLike | None, job_id: str, clip_id: str) -> tuple[Path, Path]:
    if jobs_root is None or str(jobs_root) == "":
        raise EditV2Error("internal_error")
    try:
        root = Path(jobs_root).resolve(strict=True)
    except OSError:
        raise EditV2Error("internal_error") from None
    job = _real_dir(root / job_id)
    for part in (job / "analysis", job / "analysis" / "clips"):
        _real_dir(part)
    return job, _real_dir(job / "analysis" / "clips" / clip_id)


def _read(path: Path, limit: int) -> bytes | None:
    from .source_info import read_regular

    try:
        return read_regular(path, limit)
    except (OSError, ValueError):
        return None


def _transcript_units(job: Path, words: Mapping[str, Any]) -> list[SentenceUnit] | None:
    raw = _read(job / TRANSCRIPT_RELATIVE_PATH, MAX_TRANSCRIPT_BYTES)
    if raw is None:
        return None
    try:
        return units_from_transcript(raw, words)
    except (ValueError, TypeError, RecursionError):
        return None


def _selection_cold_open(job: Path, seed: Mapping[str, Any]) -> tuple[int, int] | None:
    """The selection clip's cold open (ms) when the artifact is the one the seed came from."""
    origin = seed["base"]["origin"]
    raw = _read(job / SELECTION_RELATIVE_PATH, MAX_SELECTION_BYTES)
    if raw is None or hashlib.sha256(raw).hexdigest() != origin.get("selection_artifact_sha256"):
        return None
    try:
        clips = json.loads(raw).get("clips")
        clip = next(item for item in clips if item.get("rank") == origin["rank_at_seed"])
        cold = clip.get("cold_open")
        start, end = cold["start"], cold["end"]
    except (ValueError, AttributeError, TypeError, KeyError, StopIteration):
        return None
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)) \
            or not 0 <= start < end:
        return None
    return ms_from_seconds(start), ms_from_seconds(end)


def _list(job: Path, clip: Path) -> dict[str, Any]:
    seed, _etag = store.seed(clip)
    words_sha = seed["base"]["words"]["sha256"]
    if not isinstance(words_sha, str) or not _SHA.fullmatch(words_sha):
        raise EditV2Error("internal_error")
    words = store.load_words(clip, words_sha)
    has_cold_open = any(s["role"] == "cold_open" for s in seed["main"]["segments"])
    candidates = build_candidates(
        seed, words, units=_transcript_units(job, words),
        selection_cold_open_ms=None if has_cold_open else _selection_cold_open(job, seed))
    return {"wordsSha256": words_sha, "candidates": [c.to_json() for c in candidates]}


def _error(error: EditV2Error) -> dict:
    return {"error": {"code": error.code, "path": error.path, "ref": error.ref,
                      "messageId": message_id(error.code)}}


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never raises and never echoes paths, user
    text or exception messages (only fixed codes)."""
    usage = {"error": {"code": "internal_error", "path": None, "ref": None,
                       "messageId": message_id("internal_error")}}
    try:
        envelope = _envelope(raw)
        job, clip = _dirs(jobs_root, envelope["jobId"], envelope["clipId"])
        return EXIT_OK, _list(job, clip)
    except _Usage:
        return EXIT_USAGE, usage
    except EditV2Error as error:
        return exit_code_for(error), _error(error)
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
    "BACKCHANNEL_MAX_MS",
    "BACKCHANNEL_MAX_WORDS",
    "LAUGH_LEAD_MS",
    "LAUGH_TAIL_MS",
    "MAX_CANDIDATES",
    "OPS",
    "SOURCES",
    "STRONG_LIMIT",
    "Candidate",
    "build_candidates",
    "handle",
    "main",
    "units_from_transcript",
    "units_from_words",
]


if __name__ == "__main__":
    raise SystemExit(main())
