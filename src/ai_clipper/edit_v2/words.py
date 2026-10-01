"""The words artifact ``potongin.words/1`` with the ``bounds`` snap table (plan §3.6).

Owner: T1.5. Built from ``transcript.json`` as written (read back through
``transcript_io.read_transcript_json``). The file is the canonical JSON bytes (plan §3.1
encoding, :func:`encode_words`), stored as ``words.<sha16>.json`` (:func:`words_file_name`);
``base.words`` of the seed holds the full sha256 of those bytes and the word count. Fields are
frozen in docs/editor/CONTRACTS.md §5.7; the rules, in the order they are applied:

1. **Words.** The transcript is flattened in order; a segment without word timestamps is split
   exactly like ``subtitles._segment_words``. ``id`` is ``w`` + the zero-padded global index
   (``w000123``). Times are ``ms_from_seconds``; a start earlier than the previous word's start
   is raised to it (ids stay in start order). A zero-length word gets
   ``e = min(s + 80, next.s)`` and ``z: true``. ``t`` is ``subtitles.clean_caption_text`` of the
   word (what the captions show; a word that cleans to nothing is left out), ``p_pm`` the ASR
   probability in per-mille (``null`` when unknown), ``u`` the sentence unit. The window keeps the
   words whose midpoint ``(s + e) / 2`` lies in ``[a, b)``.
2. **Units** are ``sentences.build_sentence_units`` with ``assess_transcript`` quality, exactly
   as Selection V3 builds them, so ``u`` and the selection's ``hook_unit_id`` agree. Only units
   with a word in the window are listed.
3. **Bounds** (``len(words) + 1`` entries): the gap before the first word starts at
   ``max(a, previous word end)``, the gap after the last word ends at ``min(b, next word
   start)``. For a gap ``[l, r]``:

   * ``r − l ≥ 40 ms``: the quietest 10 ms peaks bin whose centre lies in ``[l + 20, r − 20]``
     (equal bins: the one nearest the gap centre, then the earlier); its level is ``rms_cdb``.
     Otherwise, or when no bin centre fits, the point is the gap centre and ``rms_cdb`` is null;
   * the frame boundary inside ``[l, r]`` nearest that point (ties: the earlier boundary);
   * no boundary inside the gap (shorter than a frame): the boundary nearest the centre,
     ``tight: true``;
   * overlapping words (``r < l``): the boundary nearest ``(l + r) / 2``, clamped to
     ``[a.s, b.e]``, ``tight: true``.

   Every ``sf`` is finally clamped to ``[sf_floor(a), sf_ceil(b)]``.
4. **Gaps** over 600 ms between window words, only when the audio timeline exists:
   ``laughter`` when a laughter event touches ``[s − 500, e + 500]``, ``silent`` when audio
   timeline silences cover at least 80 %, else ``voiced``.
5. **Events**: the caption tags of ``sound-events.json`` in ``[a, b]`` (points, ``src``
   ``yt-caption``, every kind) plus window words matching
   ``^(ha){2,}h?$|^(he){2,}$|^wk(wk)+$`` after case folding and trimming edge punctuation
   (``laughter``, the word's span, ``src`` ``transcript``); sorted by ``(s, e, kind, src)``.
6. **Silences** and **scene cuts** of the audio timeline, in ms, clipped to the window.
7. **Missing** analysis: ``audio=None`` (no ``audio-timeline.json``) records ``audio_timeline``
   and leaves ``silences``, ``scene_cuts_ms`` and ``gaps`` empty; ``events=None`` (no
   ``sound-events.json``; an empty sequence means "present, without tags") records
   ``sound_events``. Transcript laughter tokens are listed either way.

``transcript_sha256`` is the sha256 of the canonical JSON of
``transcript_io.transcription_to_dict`` (the transcript's content, independent of file
formatting).
"""

from __future__ import annotations

import hashlib
import re
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import TYPE_CHECKING, Any

from .. import subtitles
from ..sentences import build_sentence_units
from ..transcript_io import transcription_to_dict
from ..transcript_quality import assess_transcript
from . import WORDS_SCHEMA
from . import timemap as tm
from .clip_id import is_clip_id, ms_from_seconds
from .peaks import DEFAULT_PER_SEC, bin_count, bin_level, level_cdb, peaks_file_name
from .source_info import canonical_json
from .timemap import Fps

if TYPE_CHECKING:
    from ..audio_timeline import AudioTimeline
    from ..models import Transcription
    from ..sound_events import SoundEvent

GAP_CLASS_MIN_MS = 600  # gaps strictly longer than this are classified
QUIET_SEARCH_MIN_GAP_MS = 40
QUIET_MARGIN_MS = 20
LAUGHTER_REACH_MS = 500
SILENT_COVERAGE = (4, 5)  # at least 80 %
ZERO_LENGTH_WIDEN_MS = 80
MAX_WORD_INDEX = 9_999_999  # word ids are w + 6 or 7 digits
LAUGHTER_TOKEN = re.compile(r"^(ha){2,}h?$|^(he){2,}$|^wk(wk)+$")
_EDGE_PUNCTUATION = re.compile(r"^[\W_]+|[\W_]+$")
_BIN_MS = 1000 // DEFAULT_PER_SEC


@dataclass(frozen=True, slots=True)
class _Word:
    index: int
    s: int
    e: int
    text: str
    p_pm: int | None
    zero: bool
    unit: str | None


@dataclass(frozen=True, slots=True)
class _Unit:
    id: str
    s: int
    e: int
    q: bool


def _per_mille(probability: float | None) -> int | None:
    if probability is None:
        return None
    value = int((Decimal(repr(float(probability))) * 1000).quantize(Decimal(1), ROUND_HALF_UP))
    return min(max(value, 0), 1000)


def _flatten(transcription: Transcription) -> tuple[list[_Word], list[_Unit]]:
    raw: list[tuple[int, int, str, int | None]] = []
    for segment in transcription.segments:
        if segment.words:
            for word in segment.words:
                raw.append((ms_from_seconds(word.start), ms_from_seconds(word.end), word.text,
                            _per_mille(word.probability)))
        else:
            for start, end, text in subtitles._segment_words(segment):
                raw.append((ms_from_seconds(start), ms_from_seconds(end), text, None))
    if len(raw) > MAX_WORD_INDEX + 1:
        raise ValueError("transcript has too many words for word ids")
    starts: list[int] = []
    for s, _e, _t, _p in raw:
        starts.append(max(s, starts[-1]) if starts else s)

    quality = assess_transcript(transcription.segments, language=transcription.language or "id")
    sentence_units = build_sentence_units(transcription.segments, quality=quality)
    units = [_Unit(unit.unit_id, ms_from_seconds(unit.start), ms_from_seconds(unit.end),
                   unit.is_question) for unit in sentence_units]
    owners: list[str | None] = []
    if sum(unit.word_count for unit in sentence_units) == len(raw):
        for unit in sentence_units:
            owners.extend([unit.unit_id] * unit.word_count)
    else:  # defensive: every atom is in exactly one unit, so this should not happen
        ends = [unit.e for unit in units]
        for s in starts:
            position = bisect_right(ends, s - 1)
            owners.append(units[position].id if position < len(units) else None)

    words: list[_Word] = []
    for index, (_s_raw, e_raw, text, p_pm) in enumerate(raw):
        s = starts[index]
        e = max(e_raw, s)
        zero = e == s
        if zero:
            following = starts[index + 1] if index + 1 < len(raw) else s + ZERO_LENGTH_WIDEN_MS
            e = max(s, min(s + ZERO_LENGTH_WIDEN_MS, following))
        words.append(_Word(index, s, e, text, p_pm, zero, owners[index]))
    return words, units


_cache: tuple[object, str, tuple[list[_Word], list[_Unit]]] | None = None


def _analysis(transcription: Transcription) -> tuple[list[_Word], list[_Unit]]:
    """Flattened words and units, memoised for the last transcription (prepare builds every
    clip of a job from the same object)."""
    global _cache
    cached = _cache
    if cached is not None and cached[0] is transcription.segments and cached[1] == (
        transcription.language
    ):
        return cached[2]
    result = _flatten(transcription)
    _cache = (transcription.segments, transcription.language, result)
    return result


def transcript_sha256(transcription: Transcription) -> str:
    """sha256 of the canonical JSON of ``transcription_to_dict(transcription)``."""
    return hashlib.sha256(canonical_json(transcription_to_dict(transcription))).hexdigest()


def encode_words(artifact: dict[str, Any]) -> bytes:
    """The artifact's file bytes (plan §3.1 canonical JSON)."""
    return canonical_json(artifact)


def words_file_name(raw: bytes) -> str:
    """``words.<sha16>.json``: the first 16 hex digits of the sha256 of the bytes."""
    return f"words.{hashlib.sha256(raw).hexdigest()[:16]}.json"


class _Snapper:
    """The ``bounds`` rules for one window (see the module docstring, rule 3)."""

    def __init__(self, fps: Fps, window: tuple[int, int], peaks: bytes) -> None:
        self.fps = fps
        self.a, self.b = window
        self.peaks = peaks
        self.bins = len(peaks) // 2
        self.low = tm.sf_floor(self.a, fps)
        self.high = tm.sf_ceil(self.b, fps)

    def _nearest(self, twice_ms: int) -> int:
        """Frame boundary nearest ``twice_ms / 2`` ms; ties go to the earlier boundary."""
        return -tm.div_round_half_up(-twice_ms * self.fps.num, 2000 * self.fps.den)

    def _quietest(self, lo: int, hi: int, centre_twice: int) -> tuple[int, int] | None:
        """``(doubled centre ms, level)`` of the quietest bin centred in ``[lo, hi]``."""
        first = max(0, -(-(lo - self.a - _BIN_MS // 2) // _BIN_MS))
        last = min(self.bins - 1, (hi - self.a - _BIN_MS // 2) // _BIN_MS)
        best: tuple[int, int, int] | None = None
        for index in range(first, last + 1):
            level = bin_level(self.peaks, index)
            centre_twice_bin = 2 * self.a + (2 * index + 1) * _BIN_MS
            key = (level, abs(centre_twice_bin - centre_twice), index)
            if best is None or key < best:
                best = key
        if best is None:
            return None
        level, _distance, index = best
        return 2 * self.a + (2 * index + 1) * _BIN_MS, level

    def bound(self, left: int, right: int, clamp: tuple[int, int]) -> tuple[int, bool, int | None]:
        rms: int | None = None
        if right < left:  # overlapping words
            k = self._nearest(left + right)
            low, high = tm.sf_ceil(clamp[0], self.fps), tm.sf_floor(clamp[1], self.fps)
            if low <= high:
                k = min(max(k, low), high)
            tight = True
        else:
            point = left + right
            if right - left >= QUIET_SEARCH_MIN_GAP_MS:
                found = self._quietest(left + QUIET_MARGIN_MS, right - QUIET_MARGIN_MS,
                                       left + right)
                if found is not None:
                    point, level = found
                    rms = level_cdb(level)
            first, last = tm.sf_ceil(left, self.fps), tm.sf_floor(right, self.fps)
            if first <= last:
                k = min(max(self._nearest(point), first), last)
                tight = False
            else:
                k = self._nearest(left + right)
                tight = True
        return min(max(k, self.low), self.high), tight, rms


def _covered(start: int, end: int, spans: Sequence[Sequence[int]]) -> int:
    return sum(max(0, min(end, b) - max(start, a)) for a, b in spans)


def build_words_artifact(
    transcription: Transcription,
    *,
    clip_id: str,
    window_ms: tuple[int, int],
    fps: Fps,
    audio: AudioTimeline | None,
    events: Sequence[SoundEvent],
    peaks: bytes,
) -> dict:
    """Words, units, bounds, gaps, events, silences, scene cuts and the ``missing`` list.

    ``events=None`` means ``sound-events.json`` does not exist (see the module docstring).
    """
    if not is_clip_id(clip_id):
        raise ValueError("clip_id is invalid")
    fps = Fps.from_json(fps)
    a, b = window_ms
    if type(a) is not int or type(b) is not int or not 0 <= a < b:
        raise ValueError("window_ms must satisfy 0 <= a < b")
    if not isinstance(peaks, bytes) or len(peaks) != 2 * bin_count((a, b)):
        raise ValueError("peaks do not cover the window at 100 bins per second")

    flat, units = _analysis(transcription)
    chosen: list[tuple[_Word, str]] = []
    for word in flat:
        if 2 * a <= word.s + word.e < 2 * b:
            text = subtitles.clean_caption_text(word.text)
            if text:
                chosen.append((word, text))

    words = [
        {"id": f"w{word.index:06d}", "s": word.s, "e": word.e, "t": text, "p_pm": word.p_pm,
         "u": word.unit, "z": word.zero}
        for word, text in chosen
    ]
    used_units = {word.unit for word, _text in chosen}
    unit_entries = [{"id": unit.id, "s": unit.s, "e": unit.e, "q": unit.q}
                    for unit in units if unit.id in used_units]

    snapper = _Snapper(fps, (a, b), peaks)
    bounds: list[dict[str, Any]] = []
    if chosen:
        first = chosen[0][0]
        previous = flat[first.index - 1] if first.index > 0 else None
        left = a if previous is None else max(a, previous.e)
        clamp_low = a if previous is None else max(a, previous.s)
        sf, tight, rms = snapper.bound(left, first.s, (clamp_low, first.e))
        bounds.append({"after": None, "before": words[0]["id"], "sf": sf, "tight": tight,
                       "rms_cdb": rms})
        for position in range(len(chosen) - 1):
            one, two = chosen[position][0], chosen[position + 1][0]
            sf, tight, rms = snapper.bound(one.e, two.s, (one.s, two.e))
            bounds.append({"after": words[position]["id"], "before": words[position + 1]["id"],
                           "sf": sf, "tight": tight, "rms_cdb": rms})
        last = chosen[-1][0]
        following = flat[last.index + 1] if last.index + 1 < len(flat) else None
        right = b if following is None else min(b, following.s)
        clamp_high = b if following is None else min(b, following.e)
        sf, tight, rms = snapper.bound(last.e, right, (last.s, clamp_high))
        bounds.append({"after": words[-1]["id"], "before": None, "sf": sf, "tight": tight,
                       "rms_cdb": rms})

    event_entries: list[dict[str, Any]] = []
    if events is not None:
        for event in events:
            at = ms_from_seconds(event.time)
            if a <= at <= b:
                event_entries.append({"kind": event.kind, "s": at, "e": at, "src": "yt-caption"})
    for word, text in chosen:
        token = _EDGE_PUNCTUATION.sub("", text.casefold())
        if LAUGHTER_TOKEN.fullmatch(token):
            event_entries.append({"kind": "laughter", "s": word.s, "e": word.e,
                                  "src": "transcript"})
    event_entries.sort(key=lambda item: (item["s"], item["e"], item["kind"], item["src"]))

    silences: list[list[int]] = []
    scene_cuts: list[int] = []
    gaps: list[dict[str, Any]] = []
    if audio is not None:
        for start_s, end_s in audio.silences:
            start, end = max(a, ms_from_seconds(start_s)), min(b, ms_from_seconds(end_s))
            if end > start:
                silences.append([start, end])
        scene_cuts = [at for at in (ms_from_seconds(cut) for cut in audio.scene_cuts)
                      if a <= at <= b]
        laughs = [(item["s"], item["e"]) for item in event_entries if item["kind"] == "laughter"]
        for position in range(len(chosen) - 1):
            one, two = chosen[position][0], chosen[position + 1][0]
            start, end = one.e, two.s
            if end - start <= GAP_CLASS_MIN_MS:
                continue
            if any(s <= end + LAUGHTER_REACH_MS and e >= start - LAUGHTER_REACH_MS
                   for s, e in laughs):
                kind = "laughter"
            elif SILENT_COVERAGE[1] * _covered(start, end, silences) >= SILENT_COVERAGE[0] * (
                end - start
            ):
                kind = "silent"
            else:
                kind = "voiced"
            gaps.append({"after": words[position]["id"], "s": start, "e": end, "class": kind})

    missing = []
    if audio is None:
        missing.append("audio_timeline")
    if events is None:
        missing.append("sound_events")
    return {
        "schema": WORDS_SCHEMA,
        "clip_id": clip_id,
        "transcript_sha256": transcript_sha256(transcription),
        "fps": fps.to_json(),
        "window_ms": [a, b],
        "words": words,
        "units": unit_entries,
        "bounds": bounds,
        "gaps": gaps,
        "events": event_entries,
        "silences": silences,
        "scene_cuts_ms": scene_cuts,
        "peaks": {"file": peaks_file_name(peaks), "per_sec": DEFAULT_PER_SEC, "start_ms": a},
        "missing": missing,
    }


__all__ = [
    "GAP_CLASS_MIN_MS",
    "LAUGHTER_TOKEN",
    "build_words_artifact",
    "encode_words",
    "transcript_sha256",
    "words_file_name",
]
