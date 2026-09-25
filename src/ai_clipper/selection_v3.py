"""Selection V3 orchestration: sentence units -> (LLM or heuristic) proposals -> snapped clips.

:func:`select_clips_v3` is the single entry point used by the pipeline and the benchmark:

1. **Units.** ``quality`` defaults to :func:`assess_transcript`; units come from
   :func:`build_sentence_units` with that quality, so garbled units are marked ``suspect``.
2. **Proposals.** The deterministic heuristic (:func:`propose_heuristic`) always runs. With a
   usable LLM (``llm_mode`` ``auto`` or ``required``) the LLM proposals lead and the heuristic
   only fills the remaining slots. ``LLMError``/``LLMUnavailable`` (and an LLM answer without a
   single valid moment) re-raise in ``required`` mode; in ``auto`` mode the heuristic result is
   returned with ``status="fallback"``.
3. **Boundary snapping** (source seconds, see :class:`_Snapper`):

   - *Start*: the first word of the start unit minus a pre-roll of at most
     :data:`PRE_ROLL_SECONDS`, never into the previous word. With an audio timeline the nearest
     quiet point within :data:`QUIET_SEARCH_SECONDS` is used instead, but never after the first
     word.
   - *End*: the last word plus a tail. When laughter, applause or cheering is tagged within
     :data:`LAUGH_WINDOW_SECONDS` after the last word the end covers it (tag time +
     :data:`LAUGH_TAIL_SECONDS`), including a short backchannel spoken into the laugh, but never
     the next real sentence. Otherwise the tail is ``min(TAIL_SECONDS, half the following
     gap)``.
   - Times are clamped to ``[0, media end]`` (the audio duration when known, otherwise the end
     of the transcript). The duration must satisfy ``[min_duration, max_duration]`` after
     snapping: tails and pre-rolls shrink first, then trailing units (never the hook or payoff)
     are dropped, short spans grow into the surrounding silence or take a neighbouring unit.
     A proposal that still does not fit is dropped (``snap_dropped:<n>``).

4. **Cold open.** When the hook unit starts at least :data:`COLD_OPEN_MIN_OFFSET` seconds
   after the clip start, is not suspect, and lasts 1-8 s (extended to its sentence end when that
   stays within 8 s), the clip gets ``cold_open = (hook start - 0.08, hook end + 0.12)``,
   clamped to the neighbouring words, the media, and the renderer's 0.5-8 s rule.
5. **Ranking.** Clips never share a sentence unit. Candidates are taken in order (LLM first,
   in the model's rank order, then the heuristic in its own diversity-aware order). A candidate
   whose content words nearly repeat an accepted clip (Jaccard >=
   :data:`NEAR_DUPLICATE_SIMILARITY`) moves to the end of its own source's list. When the LLM
   gives fewer than ``k`` clips (after its single retry), heuristic clips fill the rest.
6. **Score.** Every clip's ``score`` is :func:`combined_score` of its five sub-scores
   (``SCORE_WEIGHTS``), for LLM and heuristic clips alike, so the number shown next to the
   sub-scores always matches them. Ranks come from the order above (the LLM rerank and the
   heuristic's diversity-adjusted score), never from this number.

7. **Konteks Tren** (``trends``, from :mod:`ai_clipper.trend_context`). Without a trend the
   transcript mentions (:func:`relevant_trends`, at most 20) nothing below happens and the
   result is identical to a run without trends. Otherwise:

   - the LLM sees them in the propose requests (``T1``, ...) and the prompt version becomes
     ``llm-select-v2+trends.v1+std.<sha>``;
   - **grounding**: a clip's trends are only trends its own snapped units mention. An LLM
     moment keeps the ``trend_refs`` whose trend :func:`match_trends` finds in its text; every
     other ref (not mentioned, or an ID that was not shown) is dropped and counted
     (``trend_ref_ungrounded:<n>`` over the snapped LLM moments). A heuristic clip is matched
     directly against the relevant trends. At most :data:`MAX_CLIP_TRENDS` per clip;
   - **no invented claims in the packaging**: an LLM clip's title, hook text (burned into the
     video) and description may only name relevant trends its own transcript mentions, with or
     without a ``trend_ref``; this is checked with :func:`match_trends`, never taken from the
     model. Description sentences naming another relevant trend are removed, and such a title
     or hook text is rebuilt by :func:`ai_clipper.llm_selection.repair_trend_packaging` from
     the model's clean fields, else from a clean line of the clip itself (the hook unit first).
     Clips rebuilt this way are counted (``trend_packaging_ungrounded:<n>``). A hashtag of any
     clip that names a relevant trend its transcript does not mention (one of the trend's
     hashtags, or its title or a keyword written as one word, see
     :func:`ai_clipper.trend_context.trend_tag_keys`) is removed, generic tags such as
     ``#fyp`` aside. Heuristic titles, hook texts and descriptions are never rewritten;
   - **reasons and hashtags**: ``reasons`` end with ``tren: <title>`` for the first
     :data:`MAX_TREND_REASONS` grounded trends (``(sensitif)`` appended for sensitive ones),
     replacing trailing reasons when all 8 are taken; the hashtags of grounded, non-sensitive
     trends come first (at most :data:`MAX_TREND_HASHTAGS`; a trend hashtag longer than the
     40 characters a clip hashtag may have is skipped);
   - **sensitive trends** (tragedy, disaster, SARA, violence, health) never get a hashtag: none
     is added, and a clip's own hashtags naming one (as above) are removed. The prompt asks the
     model not to joke about them or write sensational titles; that part cannot be checked in
     code, so every ``humor`` clip whose transcript mentions a sensitive trend is counted
     (``trend_sensitive_humor:<n>``) for the owner to review before posting;
   - **boost**: a clip grounded in at least one non-sensitive trend gets :data:`TREND_BOOST`
     points (0-100 scale, so 0.3 on the 0-10 ranking values; :data:`TREND_BOOST_CAP` per clip
     however many trends) on its ranking value only: the LLM's rerank blend (or propose score)
     and the heuristic's diversity-adjusted score. Within each source a boosted clip moves up
     past clips whose value is at least its own but below its boosted value, so only near ties
     change places; ``score`` and the five sub-scores never change.

8. **Fokus klip** (``focus``, :class:`ai_clipper.focus.FocusSpec`, mode ``prefer``). Without
   it nothing below happens and every output is identical to a run without the feature.
   Otherwise:

   - the LLM gets the FOKUS PENGGUNA block in its propose requests and every moment claims
     ``"focus"``; the prompt version becomes ``llm-select-v2[+trends.v1]+focus.v1+std.<sha>``;
   - **labels, checked in code** (:class:`ai_clipper.selection_types.ClipFocus`): a clip whose
     snapped units say a focus term (:class:`ai_clipper.focus.FocusMatcher`, with the
     Indonesian affix rules) is ``literal``, whatever its source or claim, with the terms it
     says and the source time of the first mention (``at``). Otherwise an LLM clip that claims
     ``literal`` or ``semantic`` is ``semantic`` (the LLM's word, labelled as such); a literal
     claim the units do not back is counted (``focus_literal_ungrounded:<n>`` over the snapped
     LLM moments). Everything else is ``none``;
   - **order**: a stable partition ``literal``, ``semantic``, ``none`` on top of the ranking
     above; each part keeps its own order (LLM first, then heuristic, the trend boost only
     inside the part), and near-duplicates are deferred inside their part and source.
     ``score`` and the sub-scores never change. A heuristic clip placed in an LLM-led selection
     because it is ``literal`` gets :data:`FOCUS_FILL_REASON` instead of the filler reason;
   - **extra candidates**: when fewer than ``k`` chosen clips are ``literal`` and some mention
     lies in no chosen clip, the heuristic's own best windows around each such mention
     (:class:`ai_clipper.focus.HeuristicWindows`, :data:`FOCUS_WINDOW_OPTIONS` per mention) are
     snapped like any proposal (duration rules included); those that keep the mention and
     touch no chosen literal clip join the ``literal`` part after its other candidates, best
     score first, no two sharing a unit, at most one per free slot, and the ranking runs
     again;
   - **packaging**: only ``literal`` and ``semantic`` clips may use the focus theme. The title,
     hook text and description of an LLM clip labelled ``none`` that name a focus term are
     rebuilt like trend packaging (:func:`ai_clipper.llm_selection.repair_trend_packaging`),
     counted as ``focus_packaging_ungrounded:<n>``, and its hashtags naming a term are removed;
   - **outputs**: every clip has ``focus`` and the result has
     :class:`ai_clipper.selection_types.FocusSummary` (``terms``, ``requested`` = ``k``, and
     ``matched`` counted from the clips); ``focus_few_matches:<n>`` when fewer than ``k``
     clips are ``literal`` or ``semantic``. An LLM whose moments were all outranked by focus
     matches is no fallback: the result is ``completed``, with ``source="heuristic"`` when
     no LLM clip is left.

Warning codes (in this order): the LLM's own ``llm_*`` codes, ``llm_unavailable`` or
``llm_failed:<code>`` (auto-mode fallback), ``llm_filled:<n>`` (heuristic clips added after
LLM clips), ``snap_dropped:<n>``, ``trend_ref_ungrounded:<n>``,
``trend_packaging_ungrounded:<n>``, ``trend_sensitive_humor:<n>``,
``focus_literal_ungrounded:<n>``, ``focus_packaging_ungrounded:<n>``, ``focus_few_matches:<n>``,
``few_clips:<n>`` (fewer than ``k`` clips), and ``no_transcript``.

The artifact (``analysis/selection.v3.json``) is :meth:`SelectionResult.to_dict`, written
atomically by :func:`write_selection_artifact` and read back strictly by
:func:`read_selection_artifact`.
"""

from __future__ import annotations

import json
import math
import re
from bisect import bisect_left
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from numbers import Real
from pathlib import Path

from .audio_timeline import AudioTimeline
from .focus import FocusHit, FocusMatcher, FocusSpec, HeuristicWindows
from .hook_heuristics import (
    HEURISTIC_VERSION,
    archetype_label,
    clean_hook_line,
    propose_heuristic,
)
from .llm import (
    LLMClient,
    LLMError,
    LLMUnavailable,
    create_llm_client_from_env,
    load_llm_configs,
)
from .llm_selection import (
    FOCUS_PROMPT_VERSION,
    PROMPT_VERSION,
    TREND_PROMPT_VERSION,
    combined_score,
    propose_with_llm,
    repair_trend_packaging,
    standard_sha256,
)
from .models import TranscriptSegment
from .selection_types import (
    FOCUS_MATCHES,
    MAX_CLIP_TRENDS,
    SELECTION_V3_VERSION,
    ClipFocus,
    ClipProposal,
    FocusSummary,
    SelectedClip,
    SelectionResult,
    TrendRef,
)
from .sentences import SentenceUnit, build_sentence_units
from .sound_events import SoundEvent, sort_events
from .transcript_io import atomic_write_bytes
from .transcript_quality import TranscriptQuality, assess_transcript, ends_with_terminal_punctuation
from .trend_context import (
    TrendItem,
    fold_hashtag,
    match_trends,
    relevant_trends,
    trend_tag_keys,
)

LLM_MODES = ("auto", "off", "required")
SELECTION_ARTIFACT_RELATIVE_PATH = Path("analysis") / "selection.v3.json"
MAX_SELECTION_ARTIFACT_BYTES = 8 * 1024 * 1024

PRE_ROLL_SECONDS = 0.15
QUIET_SEARCH_SECONDS = 0.25
TAIL_SECONDS = 0.4
NEXT_WORD_MARGIN_SECONDS = 0.05
LAUGH_KINDS = frozenset({"laughter", "applause", "cheer"})
LAUGH_LEAD_SECONDS = 0.5  # a tag this far before the last word end still belongs to it
LAUGH_WINDOW_SECONDS = 2.5
LAUGH_TAIL_SECONDS = 0.8
BACKCHANNEL_MAX_WORDS = 3
BACKCHANNEL_MAX_SECONDS = 1.5

COLD_OPEN_MIN_OFFSET = 5.0
COLD_OPEN_MIN_HOOK_SECONDS = 1.0
COLD_OPEN_MAX_HOOK_SECONDS = 8.0
COLD_OPEN_PRE_ROLL = 0.08
COLD_OPEN_TAIL = 0.12
# Mirrors render.COLD_OPEN_MIN_SECONDS / COLD_OPEN_MAX_SECONDS (the renderer rejects others).
COLD_OPEN_MIN_SECONDS = 0.5
COLD_OPEN_MAX_SECONDS = 8.0

NEAR_DUPLICATE_SIMILARITY = 0.25  # distinct clips score 0.05-0.09, teaser re-uses 0.2-0.5
MIN_SIMILARITY_WORDS = 5

# Konteks Tren: a mild boost in points of a 0-100 ranking scale (the owner's decision of
# 2026-09-25); ranking values here are 0-10, so the boost is TREND_BOOST / RANK_SCALE_POINTS.
TREND_BOOST = 3.0
TREND_BOOST_CAP = 3.0
RANK_SCALE_POINTS = 10.0
MAX_TREND_REASONS = 2
MAX_TREND_HASHTAGS = 3
MAX_TRENDED_HASHTAGS = 8  # a clip's hashtags once trend hashtags were added
# Generic tags an LLM moment keeps even when a relevant, ungrounded trend lists them too.
_GENERIC_HASHTAGS = frozenset(
    {"fyp", "foryou", "foryoupage", "viral", "trending", "podcast", "podcastindonesia", "shorts",
     "reels"}
)
_TREND_HASHTAG = re.compile(r"#\w{1,39}")
# Fokus klip: the reason of a heuristic clip that ranks above LLM clips because it says a focus
# term, and how many heuristic windows are tried around a mention nobody covered.
FOCUS_FILL_REASON = "Dari heuristik: menyebut fokus yang dicari."
FOCUS_WINDOW_OPTIONS = 6
_TOLERANCE = 1e-6
_TIME_DIGITS = 3
_WORD = re.compile(r"[^\W\d_]+", re.UNICODE)
# Frequent colloquial words of five letters or more that say nothing about the topic.
_COMMON_WORDS = frozenset(
    {
        "kayak", "banget", "emang", "memang", "sebenarnya", "sebenernya", "soalnya", "terus",
        "sampai", "sampe", "karena", "gitu", "begitu", "orang", "semua", "pokoknya", "kalian",
        "dengan", "untuk", "bilang", "ngomong", "kemarin", "sekarang", "pernah", "kalau",
        "misalnya", "gimana", "bagaimana", "kenapa", "mereka", "sendiri", "enggak", "nggak",
        "ngga", "tadi", "udah", "sudah", "belum", "harus", "bisa", "jadi", "tuh", "yang",
        "maksudnya", "berarti", "akhirnya", "makanya", "seperti", "kayaknya", "katanya",
    }
)  # fmt: skip


class SelectionArtifactError(ValueError):
    """A selection artifact is missing, malformed, or not a Selection V3 result."""


# --- validation -------------------------------------------------------------------------------


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def _positive(value: object, name: str) -> float:
    if not _is_number(value):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or result <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return result


def _integer(value: object, name: str, low: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value < low:
        raise ValueError(f"{name} must be at least {low}")
    return value


def _check_segments(segments: object) -> list[TranscriptSegment]:
    if isinstance(segments, (str, bytes)) or not isinstance(segments, Sequence):
        raise TypeError("segments must be a sequence of TranscriptSegment values")
    items = list(segments)
    if any(not isinstance(item, TranscriptSegment) for item in items):
        raise TypeError("segments must be TranscriptSegment values")
    return items


def _check_events(events: object) -> tuple[SoundEvent, ...]:
    if isinstance(events, (str, bytes)) or not isinstance(events, Sequence):
        raise TypeError("events must be a sequence of SoundEvent values")
    return sort_events(events)


# --- snapping ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Span:
    start_unit: int
    end_unit: int
    start: float
    end: float


class _Snapper:
    """Turns unit ranges into source-second spans that respect the duration bounds."""

    def __init__(
        self,
        units: Sequence[SentenceUnit],
        *,
        events: Sequence[SoundEvent],
        audio: AudioTimeline | None,
        media_end: float,
        min_duration: float,
        max_duration: float,
    ) -> None:
        self.units = units
        self.laughs = tuple(event for event in events if event.kind in LAUGH_KINDS)
        self.laugh_times = [event.time for event in self.laughs]
        self.audio = audio
        self.media_end = media_end
        self.min_duration = min_duration
        self.max_duration = max_duration

    # unit-level helpers

    def _span(self, first: int, last: int) -> float:
        return self.units[last].end - self.units[first].start

    def _next_start(self, index: int) -> float:
        if index + 1 < len(self.units):
            return max(self.units[index + 1].start, self.units[index].end)
        return max(self.media_end, self.units[index].end)

    def _extendable(self, index: int) -> bool:
        unit = self.units[index]
        return not unit.suspect and not unit.is_question

    def _backchannel(self, index: int) -> bool:
        unit = self.units[index]
        return (
            unit.word_count <= BACKCHANNEL_MAX_WORDS
            and unit.duration <= BACKCHANNEL_MAX_SECONDS
            and self._extendable(index)
        )

    # time-level helpers

    def snap_start(self, index: int) -> float:
        first = self.units[index].start
        floor = 0.0 if index == 0 else min(first, self.units[index - 1].end)
        candidate = first - PRE_ROLL_SECONDS
        if self.audio is not None:
            quiet = self.audio.nearest_quiet_point(first, QUIET_SEARCH_SECONDS)
            if quiet < first:
                candidate = quiet
        return max(0.0, floor, candidate)

    def _laugh_before(self, low: float, high: float) -> SoundEvent | None:
        """The latest laugh-type event with ``low <= time < high``."""
        position = bisect_left(self.laugh_times, high) - 1
        if position >= 0 and self.laugh_times[position] >= low:
            return self.laughs[position]
        return None

    def _tail(self, index: int) -> float:
        last = self.units[index].end
        return last + min(TAIL_SECONDS, max(0.0, self._next_start(index) - last) / 2.0)

    def snap_end(self, index: int, *, backchannel: bool = True) -> tuple[float, int]:
        """The snapped end time and the last unit (a backchannel may be appended)."""
        units = self.units
        last = units[index].end
        window_high = last + LAUGH_WINDOW_SECONDS
        end_unit = index
        next_start = self._next_start(index)
        laugh = self._laugh_before(
            last - LAUGH_LEAD_SECONDS, min(window_high, next_start) + _TOLERANCE
        )
        following = index + 1
        if (
            backchannel
            and following < len(units)
            and units[following].start <= window_high
            and self._backchannel(following)
        ):
            # A short "Anjir." / "Iya." spoken into the laugh belongs to the payoff.
            after = self._next_start(following)
            later = self._laugh_before(units[following].start, min(window_high, after))
            if later is not None or (
                laugh is not None and laugh.time + LAUGH_TAIL_SECONDS > units[following].start
            ):
                laugh = later or laugh
                end_unit, next_start = following, after
        end = self._tail(end_unit)
        if laugh is not None:
            limit = next_start
            if end_unit + 1 < len(units):
                limit -= NEXT_WORD_MARGIN_SECONDS
            end = max(end, min(laugh.time + LAUGH_TAIL_SECONDS, limit))
        return end, end_unit

    def snap(self, first: int, last: int, protect: tuple[int, int]) -> _Span | None:
        """Snap ``units[first..last]``; ``protect`` is the (first, last) unit range to keep."""
        protect_first, protect_last = protect
        low, high = self.min_duration, self.max_duration
        # 1. Unit-level repair, before any padding.
        while self._span(first, last) > high + _TOLERANCE and last > max(first, protect_last):
            last -= 1
        while self._span(first, last) > high + _TOLERANCE and first < min(last, protect_first):
            first += 1
        if self._span(first, last) > high + _TOLERANCE:
            return None
        while self._span(first, last) < low - _TOLERANCE:
            if (
                last + 1 < len(self.units)
                and self._extendable(last + 1)
                and self._span(first, last + 1) <= high + _TOLERANCE
            ):
                last += 1
            elif (
                first > 0
                and not self.units[first - 1].suspect
                and self._span(first - 1, last) <= high + _TOLERANCE
            ):
                first -= 1
            else:
                break
        # 2. Padding: pre-roll, tail, laughter.
        start = self.snap_start(first)
        end, extended = self.snap_end(last)
        if extended != last and self.units[extended].end - start > high + _TOLERANCE:
            end, extended = self.snap_end(last, backchannel=False)
        last = extended
        first_start = self.units[first].start
        # 3. Too long: shrink the tail, then the pre-roll.
        if end - start > high:
            end = max(self.units[last].end, start + high)
        if end - start > high:
            start = min(first_start, end - high)
        # 4. Too short: grow into the surrounding silence.
        if end - start < low:
            limit = self._next_start(last)
            if last + 1 < len(self.units):
                limit -= NEXT_WORD_MARGIN_SECONDS
            end = max(end, min(limit, start + low))
        if end - start < low:
            floor = 0.0 if first == 0 else min(first_start, self.units[first - 1].end)
            start = min(start, max(floor, end - low))
        start = round(max(0.0, start), _TIME_DIGITS)
        end = round(min(end, self.media_end), _TIME_DIGITS)
        if end <= start or not low - _TOLERANCE <= end - start <= high + _TOLERANCE:
            return None
        return _Span(first, last, start, end)

    # cold open

    def cold_open(self, span: _Span, hook: int) -> tuple[float, float] | None:
        units = self.units
        unit = units[hook]
        if unit.suspect or unit.start - span.start < COLD_OPEN_MIN_OFFSET - _TOLERANCE:
            return None
        budget = COLD_OPEN_MAX_HOOK_SECONDS - COLD_OPEN_TAIL
        last = hook
        if not ends_with_terminal_punctuation(unit.text):
            probe = hook
            while (
                probe + 1 <= span.end_unit
                and not units[probe + 1].suspect
                and units[probe + 1].end - unit.start <= budget + _TOLERANCE
            ):
                probe += 1
                if ends_with_terminal_punctuation(units[probe].text):
                    last = probe
                    break
        length = units[last].end - unit.start
        if (
            not COLD_OPEN_MIN_HOOK_SECONDS - _TOLERANCE
            <= length
            <= (COLD_OPEN_MAX_HOOK_SECONDS + _TOLERANCE)
        ):
            return None
        floor = 0.0 if hook == 0 else min(unit.start, units[hook - 1].end)
        start = max(0.0, floor, unit.start - COLD_OPEN_PRE_ROLL)
        ceiling = self._next_start(last)
        end = min(units[last].end + COLD_OPEN_TAIL, max(ceiling, units[last].end), self.media_end)
        end = min(end, start + COLD_OPEN_MAX_SECONDS)
        start, end = round(start, _TIME_DIGITS), round(end, _TIME_DIGITS)
        if not COLD_OPEN_MIN_SECONDS <= end - start <= COLD_OPEN_MAX_SECONDS + _TOLERANCE:
            return None
        if abs(start - span.start) < 0.01:
            return None
        return start, end


# --- ranking ----------------------------------------------------------------------------------


def _topic_words(text: str) -> frozenset[str]:
    words = (word for word in _WORD.findall(text.casefold()) if len(word) >= 5)
    return frozenset(word for word in words if word not in _COMMON_WORDS)


def _similarity(first: frozenset[str], second: frozenset[str]) -> float:
    if len(first) < MIN_SIMILARITY_WORDS or len(second) < MIN_SIMILARITY_WORDS:
        return 0.0
    return len(first & second) / len(first | second)


@dataclass(frozen=True, slots=True)
class _Candidate:
    proposal: ClipProposal
    span: _Span
    topic: frozenset[str]
    trends: tuple[TrendItem, ...] = ()  # grounded: linked, tagged and boosted
    rank_value: float = 0.0  # the value its source ordered it by (0-10)
    mentioned: tuple[TrendItem, ...] = ()  # every relevant trend this span's transcript names
    focus: str | None = None  # one of FOCUS_MATCHES for a job with focus terms

    @property
    def boost(self) -> float:
        if not any(not item.sensitive for item in self.trends):
            return 0.0
        return min(TREND_BOOST, TREND_BOOST_CAP) / RANK_SCALE_POINTS


def _boosted(candidates: list[_Candidate]) -> list[_Candidate]:
    """Candidates with boosted ones moved up past near ties, within each source.

    A boosted candidate passes the one above it while that one's value is at least its own
    value (it was ranked ahead fairly) but below its boosted value. On a list whose values do
    not increase this is a stable sort by boosted value; a candidate ranked ahead for another
    reason (the LLM's un-reranked tail) is never passed.
    """
    if not any(item.boost for item in candidates):
        return candidates
    groups: dict[str, list[_Candidate]] = {}
    for item in candidates:
        groups.setdefault(item.proposal.source, []).append(item)
    ordered: list[_Candidate] = []
    for group in groups.values():
        placed: list[_Candidate] = []
        for item in group:
            position = len(placed)
            if item.boost:
                boosted = item.rank_value + item.boost
                while position > 0:
                    above = placed[position - 1]
                    if above.rank_value < item.rank_value - _TOLERANCE:
                        break
                    if above.rank_value + above.boost >= boosted - _TOLERANCE:
                        break
                    position -= 1
            placed.insert(position, item)
        ordered.extend(placed)
    return ordered


def _by_source(item: _Candidate) -> object:
    return item.proposal.source


def _by_focus_and_source(item: _Candidate) -> object:
    return item.focus, item.proposal.source


def _ordered(candidates: list[_Candidate], focused: bool) -> list[_Candidate]:
    """Candidates in ranking order (see :func:`_boosted`); with a focus, the stable partition
    ``literal``, ``semantic``, ``none`` comes first and the boost stays inside each part."""
    if not focused:
        return _boosted(candidates)
    return [
        item
        for match in FOCUS_MATCHES
        for item in _boosted([candidate for candidate in candidates if candidate.focus == match])
    ]


def _rank(
    candidates: Sequence[_Candidate],
    k: int,
    key: Callable[[_Candidate], object] = _by_source,
) -> list[_Candidate]:
    """Up to ``k`` candidates that share no unit, near-duplicates deferred within their group.

    Candidates arrive LLM first, then heuristic, each in its own rank order (with a focus, per
    focus partition; ``key`` then groups by partition and source). A near-duplicate of an
    accepted clip moves to the end of its own group, so a distinct LLM moment goes first but a
    repeated LLM topic still beats a heuristic filler.
    """
    accepted: list[_Candidate] = []

    def overlaps(item: _Candidate) -> bool:
        return any(
            item.span.start_unit <= other.span.end_unit
            and other.span.start_unit <= item.span.end_unit
            for other in accepted
        )

    groups: dict[object, list[_Candidate]] = {}
    for item in candidates:
        groups.setdefault(key(item), []).append(item)
    for group in groups.values():
        deferred: list[_Candidate] = []
        for item in group:
            if len(accepted) >= k:
                return accepted
            if overlaps(item):
                continue
            if any(
                _similarity(item.topic, other.topic) >= NEAR_DUPLICATE_SIMILARITY
                for other in accepted
            ):
                deferred.append(item)
                continue
            accepted.append(item)
        for item in deferred:
            if len(accepted) >= k:
                return accepted
            if not overlaps(item):
                accepted.append(item)
    return accepted


def _clock(seconds: float) -> str:
    total = int(max(0.0, seconds))
    return f"{total // 60:02d}:{total % 60:02d}"


def _with_reason(reasons: tuple[str, ...], reason: str) -> tuple[str, ...]:
    return reasons if len(reasons) >= 8 else (*reasons, reason)


# --- trends -----------------------------------------------------------------------------------


def _check_trends(trends: object) -> tuple[TrendItem, ...]:
    if isinstance(trends, (str, bytes)) or not isinstance(trends, Sequence):
        raise TypeError("trends must be a sequence of TrendItem values")
    if any(not isinstance(item, TrendItem) for item in trends):
        raise TypeError("trends must be TrendItem values")
    return tuple(trends)


def _ground(
    proposal: ClipProposal, mentioned: Sequence[TrendItem], shown: Sequence[TrendItem]
) -> tuple[tuple[TrendItem, ...], int]:
    """The trends a snapped span is grounded in, and the LLM refs dropped.

    ``mentioned`` are the relevant trends the span's transcript names. An LLM moment keeps only
    the trends it named that are among them; a heuristic moment gets them all.
    """
    if not shown:
        return (), 0
    if proposal.source != "llm":
        return tuple(mentioned[:MAX_CLIP_TRENDS]), 0
    grounded: list[TrendItem] = []
    dropped = 0
    for ref in proposal.trend_refs:
        number = int(ref[1:])
        item = shown[number - 1] if number <= len(shown) else None
        if item is not None and item in mentioned:
            if item not in grounded:
                grounded.append(item)
        else:
            dropped += 1
    return tuple(grounded[:MAX_CLIP_TRENDS]), dropped


def _tag_key(tag: str) -> str:
    return tag.lstrip("#").casefold()


def _trend_hashtags(
    proposal: ClipProposal,
    grounded: Sequence[TrendItem],
    mentioned: Sequence[TrendItem],
    shown: Sequence[TrendItem],
) -> tuple[str, ...]:
    """Grounded trends' hashtags first, then the moment's own (see the module docstring)."""
    barred = [item for item in shown if item not in mentioned or item.sensitive]
    foreign = {key for item in barred for key in trend_tag_keys(item)} - _GENERIC_HASHTAGS
    own = [tag for tag in proposal.hashtags if fold_hashtag(tag) not in foreign]
    added = [
        tag
        for item in grounded
        if not item.sensitive
        for tag in item.hashtags
        if _TREND_HASHTAG.fullmatch(tag)
    ][:MAX_TREND_HASHTAGS]
    if not added and len(own) == len(proposal.hashtags):
        return proposal.hashtags
    tags: list[str] = []
    for tag in (*added, *own):
        if _tag_key(tag) not in {_tag_key(kept) for kept in tags}:
            tags.append(tag)
    return tuple(tags[:MAX_TRENDED_HASHTAGS])


def _trend_reasons(reasons: tuple[str, ...], grounded: Sequence[TrendItem]) -> tuple[str, ...]:
    notes = [
        f"tren: {item.title}" + (" (sensitif)" if item.sensitive else "")
        for item in grounded[:MAX_TREND_REASONS]
    ]
    if not notes:
        return reasons
    return (*reasons[: 8 - len(notes)], *notes)


def _clip_line(units: Sequence[SentenceUnit], span: _Span, hook: int, archetype: str) -> str:
    """A clean line of the span's own transcript: the hook unit first, then its neighbours."""
    order = sorted(range(span.start_unit, span.end_unit + 1), key=lambda i: (abs(i - hook), i))
    for index in order:
        if not units[index].suspect:
            line = clean_hook_line(units[index].text)
            if line:
                return line
    return archetype_label(archetype)


def _names_other_trend(item: _Candidate, shown: Sequence[TrendItem]) -> Callable[[str], bool]:
    """Whether a text names a relevant trend that ``item``'s own transcript does not mention."""
    mentioned = {trend.id for trend in item.mentioned}

    def invented(value: str) -> bool:
        return bool(shown) and any(
            match.item.id not in mentioned for match in match_trends(shown, value)
        )

    return invented


def _grounded_packaging(
    item: _Candidate,
    units: Sequence[SentenceUnit],
    hook: int,
    text: str,
    shown: Sequence[TrendItem],
    names_focus: Callable[[str], object] | None = None,
) -> tuple[str, str, str]:
    """An LLM clip's title, hook text and description, naming only trends ``text`` mentions,
    and, for a clip outside the focus (``names_focus`` given), no focus term either."""
    proposal = item.proposal
    names_trend = _names_other_trend(item, shown)

    def invented(value: str) -> bool:
        return names_trend(value) or (names_focus is not None and bool(names_focus(value)))

    packaging = (proposal.title, proposal.hook_text, proposal.description)
    if not any(invented(value) for value in packaging):
        return packaging
    fallback = _clip_line(units, item.span, hook, proposal.archetype)
    return repair_trend_packaging(
        *packaging, invented=invented, source=text, fallback=fallback
    )


# --- focus ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Focus:
    """A job's focus: the spec, its matcher and every literal mention in the units."""

    spec: FocusSpec
    matcher: FocusMatcher
    hits: tuple[FocusHit, ...]


def _check_focus(focus: object) -> FocusSpec | None:
    if focus is not None and not isinstance(focus, FocusSpec):
        raise TypeError("focus must be a FocusSpec or None")
    return focus


def _covers(span: _Span, hit: FocusHit) -> bool:
    return span.start_unit <= hit.first_unit and hit.last_unit <= span.end_unit


def _overlap(first: _Span, second: _Span) -> bool:
    return first.start_unit <= second.end_unit and second.start_unit <= first.end_unit


def _focus_match(proposal: ClipProposal, span: _Span, focus: _Focus) -> str:
    """``literal`` when the span says a term (checked here), else ``semantic`` when the LLM
    claims the moment is about the focus (literally or not), else ``none``."""
    if any(_covers(span, hit) for hit in focus.hits):
        return "literal"
    if proposal.source == "llm" and proposal.focus in ("literal", "semantic"):
        return "semantic"
    return "none"


def _clip_focus(item: _Candidate, focus: _Focus) -> ClipFocus:
    if item.focus == "literal":
        inside = [hit for hit in focus.hits if _covers(item.span, hit)]
        said = {hit.term for hit in inside}
        terms = tuple(term for term in focus.spec.terms if term in said)
        return ClipFocus("literal", terms, round(min(hit.time for hit in inside), _TIME_DIGITS))
    if item.focus == "semantic":
        return ClipFocus("semantic", focus.spec.terms)
    return ClipFocus("none")


def _focus_extras(
    chosen: Sequence[_Candidate],
    focus: _Focus,
    *,
    k: int,
    windows: HeuristicWindows,
    snapper: _Snapper,
    build: Callable[[ClipProposal, float, _Span], tuple[_Candidate, int]],
) -> list[_Candidate]:
    """Heuristic candidates around mentions no chosen clip covers, while slots remain.

    For every uncovered mention the best :data:`FOCUS_WINDOW_OPTIONS` heuristic windows around
    it are snapped like any proposal; a window whose snapped span loses the mention or touches
    a chosen literal clip is skipped. The survivors are taken best score first, never two that
    share a unit, at most one per free slot (``k`` minus the literal clips chosen).
    """
    literal = [item for item in chosen if item.focus == "literal"]
    room = k - len(literal)
    uncovered = [
        hit for hit in focus.hits if not any(_covers(item.span, hit) for item in chosen)
    ]
    if room <= 0 or not uncovered:
        return []
    options: list[tuple[ClipProposal, _Span]] = []
    seen: set[tuple[int, int]] = set()
    for hit in uncovered:
        for proposal in windows.around(hit.first_unit, hit.last_unit, FOCUS_WINDOW_OPTIONS):
            payoff = proposal.hook_unit if proposal.payoff_unit is None else proposal.payoff_unit
            protect = (min(proposal.hook_unit, payoff), max(proposal.hook_unit, payoff))
            span = snapper.snap(proposal.start_unit, proposal.end_unit, protect)
            if span is None or not _covers(span, hit):
                continue
            if (span.start_unit, span.end_unit) in seen:
                continue
            if any(_overlap(span, item.span) for item in literal):
                continue
            seen.add((span.start_unit, span.end_unit))
            options.append((proposal, span))
    options.sort(key=lambda option: -option[0].score)  # stable: earlier mentions first on ties
    extras: list[_Candidate] = []
    for proposal, span in options:
        if len(extras) >= room:
            break
        if any(_overlap(span, item.span) for item in extras):
            continue
        extras.append(build(proposal, proposal.score, span)[0])
    return extras


def _selected(
    rank: int,
    item: _Candidate,
    units: Sequence[SentenceUnit],
    cold_open: tuple[float, float] | None,
    *,
    filler: bool,
    shown: Sequence[TrendItem] = (),
    focus: _Focus | None = None,
) -> SelectedClip:
    proposal = item.proposal
    span = item.span
    hook = min(max(proposal.hook_unit, span.start_unit), span.end_unit)
    reasons = proposal.reasons
    if cold_open is not None:
        length = f"{cold_open[1] - cold_open[0]:.1f}".replace(".", ",")
        reasons = _with_reason(
            reasons, f"Cold open: kalimat hook ({length} detik) diputar lebih dulu."
        )
    if filler and focus is not None and item.focus == "literal":
        reasons = _with_reason(reasons, FOCUS_FILL_REASON)  # ranked up by the focus
    elif filler:
        reasons = _with_reason(reasons, "Pengisi dari heuristik karena momen LLM kurang.")
    text = " ".join(
        " ".join(unit.text.split()) for unit in units[span.start_unit : span.end_unit + 1]
    )
    title, hook_text, description = proposal.title, proposal.hook_text, proposal.description
    hashtags = proposal.hashtags
    trends: tuple[TrendRef, ...] = ()
    # Only a clip that matches may use the focus theme in its packaging.
    outside = focus is not None and item.focus == "none" and proposal.source == "llm"
    if shown:
        reasons = _trend_reasons(reasons, item.trends)
        hashtags = _trend_hashtags(proposal, item.trends, item.mentioned, shown)
        trends = tuple(trend.ref() for trend in item.trends)
    if proposal.source == "llm" and (shown or outside):
        names_focus = focus.matcher.mentions if outside and focus is not None else None
        title, hook_text, description = _grounded_packaging(
            item, units, hook, text, shown, names_focus
        )
    if outside and focus is not None:
        hashtags = tuple(tag for tag in hashtags if not focus.matcher.names_tag(tag))
    return SelectedClip(
        rank=rank,
        start=span.start,
        end=span.end,
        cold_open=cold_open,
        unit_ids=(units[span.start_unit].unit_id, units[span.end_unit].unit_id),
        hook_unit_id=units[hook].unit_id,
        title=title,
        hook_text=hook_text,
        description=description,
        hashtags=hashtags,
        archetype=proposal.archetype,
        score=combined_score(proposal.scores),  # always consistent with the sub-scores
        scores=proposal.scores,
        reasons=reasons,
        source=proposal.source,
        text=text,
        trends=trends,
        focus=None if focus is None else _clip_focus(item, focus),
    )


# --- entry point ------------------------------------------------------------------------------


def _media_end(segments: Sequence[TranscriptSegment], audio: AudioTimeline | None) -> float:
    if audio is not None:
        return float(audio.duration)
    ends = [segment.end for segment in segments]
    ends.extend(word.end for segment in segments for word in segment.words)
    return max(ends, default=0.0)


def _llm_prompt_version(trends_sent: bool = False, focus_sent: bool = False) -> str:
    trends = f"+{TREND_PROMPT_VERSION}" if trends_sent else ""
    focus = f"+{FOCUS_PROMPT_VERSION}" if focus_sent else ""
    return f"{PROMPT_VERSION}{trends}{focus}+std.{standard_sha256()[:12]}"


def select_clips_v3(
    segments: Sequence[TranscriptSegment],
    *,
    k: int,
    min_duration: float,
    max_duration: float,
    llm_client: LLMClient | None = None,
    llm_mode: str = "auto",
    events: Sequence[SoundEvent] = (),
    audio: AudioTimeline | None = None,
    quality: TranscriptQuality | None = None,
    cold_open: bool = True,
    context_tokens: int = 32768,
    max_output_tokens: int = 4096,
    max_requests: int = 3,
    deadline_s: float = 300.0,
    rerank: bool = True,
    retry: bool = True,
    clock: Callable[[], float] | None = None,
    trends: Sequence[TrendItem] = (),
    focus: FocusSpec | None = None,
) -> SelectionResult:
    """Select up to ``k`` snapped, packaged clips; see the module docstring for the rules.

    ``llm_mode``: ``off`` never calls the LLM; ``auto`` falls back to the heuristic on any
    ``LLMError`` (``status="fallback"``); ``required`` re-raises it (also when no client is
    given, or when the LLM returns no valid moment). ``context_tokens``/``max_output_tokens``
    size each request (pass the provider config values); ``max_requests`` and ``deadline_s``
    bound the LLM phase. ``rerank`` enables the listwise LLM rerank of
    :func:`propose_with_llm` and ``retry`` its single follow-up request when fewer than ``k / 2``
    moments are valid; ``clock`` exists for tests. ``trends`` are the job's active trend items
    (:func:`ai_clipper.trend_context.read_trend_context`); only those the transcript mentions
    are used. ``focus`` is the job's Fokus klip option (:func:`ai_clipper.focus.parse_focus`).
    """
    trend_items = _check_trends(trends)
    focus = _check_focus(focus)
    items = _check_segments(segments)
    k = _integer(k, "k", 1)
    low = _positive(min_duration, "min_duration")
    high = _positive(max_duration, "max_duration")
    if high < low:
        raise ValueError("max_duration must not be below min_duration")
    if llm_mode not in LLM_MODES:
        raise ValueError(f"llm_mode must be one of {', '.join(LLM_MODES)}")
    ordered_events = _check_events(events)
    if audio is not None and not isinstance(audio, AudioTimeline):
        raise TypeError("audio must be an AudioTimeline or None")
    if quality is not None and not isinstance(quality, TranscriptQuality):
        raise TypeError("quality must be a TranscriptQuality or None")
    if not all(isinstance(flag, bool) for flag in (cold_open, rerank, retry)):
        raise TypeError("cold_open, rerank and retry must be booleans")
    _integer(context_tokens, "context_tokens", 1)
    _integer(max_output_tokens, "max_output_tokens", 1)
    _integer(max_requests, "max_requests", 1)
    _positive(deadline_s, "deadline_s")

    if quality is None:
        quality = assess_transcript(items)
    units = build_sentence_units(items, quality=quality)
    summary = None if focus is None else FocusSummary(terms=focus.terms, requested=k)
    if not units:
        return SelectionResult(
            clips=(),
            source="heuristic",
            status="completed",
            provider=None,
            model=None,
            prompt_version=HEURISTIC_VERSION,
            warnings=("no_transcript",),
            focus=summary,
        )
    heuristic = propose_heuristic(
        units, min_duration=low, max_duration=high, k=k, events=ordered_events, audio=audio
    )
    # The trends this episode mentions, in prompt order (T1, T2, ...); empty means no trends.
    shown: tuple[TrendItem, ...] = ()
    if trend_items:
        shown = tuple(entry.item for entry in relevant_trends(trend_items, units))
    focused: _Focus | None = None
    if focus is not None:
        matcher = FocusMatcher(focus)
        focused = _Focus(focus, matcher, matcher.hits(units))

    warnings: list[str] = []
    llm_proposals: tuple[ClipProposal, ...] = ()
    llm_values: tuple[float, ...] = ()
    provider = model = None
    usage: Mapping[str, int] = {}
    status = "completed"
    if llm_mode != "off":
        try:
            if llm_client is None:
                raise LLMUnavailable(
                    "not_configured",
                    "LLM belum dikonfigurasi; atur POTONGIN_LLM_PROVIDER dan API key-nya.",
                )
            outcome = propose_with_llm(
                units,
                client=llm_client,
                min_duration=low,
                max_duration=high,
                k=k,
                events=ordered_events,
                context_tokens=context_tokens,
                max_output_tokens=max_output_tokens,
                max_requests=max_requests,
                deadline_s=deadline_s,
                rerank=rerank,
                retry=retry,
                clock=clock,
                **({"trends": shown} if shown else {}),
                **({"focus": focus} if focus is not None else {}),
            )
            warnings.extend(outcome.warnings)
            usage = outcome.usage  # spent even when no moment survives
            if not outcome.proposals:
                raise LLMError(
                    "no_moments",
                    "LLM tidak memberi satu pun momen yang valid.",
                    provider=outcome.provider,
                    model=outcome.model,
                )
            llm_proposals = outcome.proposals
            llm_values = outcome.rank_values
            provider, model = outcome.provider, outcome.model
        except LLMUnavailable:
            if llm_mode == "required":
                raise
            warnings.append("llm_unavailable")
            status = "fallback"
        except LLMError as error:
            if llm_mode == "required":
                raise
            warnings.append(f"llm_failed:{error.code}")
            status = "fallback"

    snapper = _Snapper(
        units,
        events=ordered_events,
        audio=audio,
        media_end=_media_end(items, audio),
        min_duration=low,
        max_duration=high,
    )
    if len(llm_values) != len(llm_proposals):
        llm_values = tuple(proposal.score for proposal in llm_proposals)
    values = (*llm_values, *(proposal.score for proposal in heuristic))

    def build(proposal: ClipProposal, value: float, span: _Span) -> tuple[_Candidate, int]:
        """A snapped candidate and the number of its LLM trend refs that were dropped."""
        text = " ".join(unit.text for unit in units[span.start_unit : span.end_unit + 1])
        mentioned = tuple(match.item for match in match_trends(shown, text)) if shown else ()
        grounded, refused = _ground(proposal, mentioned, shown)
        match = None if focused is None else _focus_match(proposal, span, focused)
        candidate = _Candidate(
            proposal, span, _topic_words(text), grounded, value, mentioned, match
        )
        return candidate, refused

    candidates: list[_Candidate] = []
    dropped = ungrounded = 0
    for proposal, value in zip((*llm_proposals, *heuristic), values, strict=True):
        payoff = proposal.hook_unit if proposal.payoff_unit is None else proposal.payoff_unit
        protect = (min(proposal.hook_unit, payoff), max(proposal.hook_unit, payoff))
        span = snapper.snap(proposal.start_unit, proposal.end_unit, protect)
        if span is None:
            dropped += 1
            continue
        candidate, refused = build(proposal, value, span)
        ungrounded += refused
        candidates.append(candidate)

    group = _by_source if focused is None else _by_focus_and_source
    chosen = _rank(_ordered(candidates, focused is not None), k, group)
    if focused is not None and focused.hits:
        extras = _focus_extras(
            chosen,
            focused,
            k=k,
            windows=HeuristicWindows(
                units, min_duration=low, max_duration=high, events=ordered_events, audio=audio
            ),
            snapper=snapper,
            build=build,
        )
        if extras:  # after every literal candidate, before semantic and none clips
            candidates.extend(extras)
            chosen = _rank(_ordered(candidates, True), k, group)
    llm_led = any(item.proposal.source == "llm" for item in chosen)
    llm_survived = any(item.proposal.source == "llm" for item in candidates)
    if not llm_survived and llm_proposals and status == "completed":
        # Every LLM moment was lost to snapping.
        if llm_mode == "required":
            raise LLMError(
                "no_moments",
                "Tidak ada momen LLM yang muat dalam batas durasi setelah dirapikan.",
                provider=provider,
                model=model,
            )
        status = "fallback"
        warnings.append("llm_failed:no_moments")
    fillers = sum(item.proposal.source == "heuristic" for item in chosen) if llm_led else 0
    clips = tuple(
        _selected(
            rank,
            item,
            units,
            snapper.cold_open(item.span, item.proposal.hook_unit) if cold_open else None,
            filler=llm_led and item.proposal.source == "heuristic",
            shown=shown,
            focus=focused,
        )
        for rank, item in enumerate(chosen, 1)
    )
    if fillers:
        warnings.append(f"llm_filled:{fillers}")
    if dropped:
        warnings.append(f"snap_dropped:{dropped}")
    if ungrounded:
        warnings.append(f"trend_ref_ungrounded:{ungrounded}")
    repackaged = focus_repackaged = 0
    for clip, item in zip(clips, chosen, strict=True):
        packaging = (item.proposal.title, item.proposal.hook_text, item.proposal.description)
        if (clip.title, clip.hook_text, clip.description) == packaging:
            continue
        if (
            focused is not None
            and item.focus == "none"
            and any(focused.matcher.mentions(value) for value in packaging)
        ):
            focus_repackaged += 1
            names_trend = _names_other_trend(item, shown)
            if not any(names_trend(value) for value in packaging):
                continue  # rebuilt for the focus alone
        repackaged += 1
    if repackaged:
        warnings.append(f"trend_packaging_ungrounded:{repackaged}")
    sensitive_humor = sum(
        item.proposal.archetype == "humor" and any(trend.sensitive for trend in item.mentioned)
        for item in chosen
    )
    if sensitive_humor:
        warnings.append(f"trend_sensitive_humor:{sensitive_humor}")
    if focused is not None:
        claimed = sum(
            item.proposal.source == "llm"
            and item.proposal.focus == "literal"
            and item.focus != "literal"
            for item in candidates
        )
        if claimed:
            warnings.append(f"focus_literal_ungrounded:{claimed}")
        if focus_repackaged:
            warnings.append(f"focus_packaging_ungrounded:{focus_repackaged}")
        matched = sum(item.focus != "none" for item in chosen)
        if matched < k:
            warnings.append(f"focus_few_matches:{matched}")
    if len(clips) < k:
        warnings.append(f"few_clips:{len(clips)}")
    source = "llm" if llm_led else "heuristic"
    prompt_version = HEURISTIC_VERSION
    if source == "llm":
        prompt_version = _llm_prompt_version(bool(shown), focused is not None)
    return SelectionResult(
        clips=clips,
        source=source,
        status=status,
        provider=provider if source == "llm" else None,
        model=model if source == "llm" else None,
        prompt_version=prompt_version,
        warnings=tuple(dict.fromkeys(warnings)),
        usage=dict(usage),
        focus=summary,
    )


# --- artifact ---------------------------------------------------------------------------------

_RESULT_FIELDS = frozenset(
    {
        "selection_version",
        "source",
        "status",
        "provider",
        "model",
        "prompt_version",
        "warnings",
        "usage",
        "clips",
    }
)
_CLIP_FIELDS = frozenset(
    {
        "rank",
        "start",
        "end",
        "cold_open",
        "unit_ids",
        "hook_unit_id",
        "title",
        "hook_text",
        "description",
        "hashtags",
        "archetype",
        "score",
        "scores",
        "reasons",
        "source",
        "text",
    }
)


# Written only when a clip has trends, and only for a job with focus terms.
_CLIP_OPTIONAL_FIELDS = frozenset({"trends", "focus"})
_RESULT_OPTIONAL_FIELDS = frozenset({"focus"})  # only for a job with focus terms
_TREND_FIELDS = frozenset({"id", "title", "kind"})
_CLIP_FOCUS_FIELDS = frozenset({"match", "terms", "at"})
_FOCUS_SUMMARY_FIELDS = frozenset({"terms", "matched", "requested"})


def _exact(
    value: object, fields: frozenset[str], name: str, optional: frozenset[str] = frozenset()
) -> dict[str, object]:
    if type(value) is not dict or not fields <= set(value) <= fields | optional:
        raise SelectionArtifactError(f"{name} must contain exactly {', '.join(sorted(fields))}")
    return value


def _trend_refs(value: object, index: int) -> tuple[TrendRef, ...]:
    if type(value) is not list:
        raise SelectionArtifactError(f"clip {index} trends must be a list")
    refs = []
    for item in value:
        entry = _exact(item, _TREND_FIELDS, f"clip {index} trend")
        refs.append(TrendRef(id=entry["id"], title=entry["title"], kind=entry["kind"]))
    return tuple(refs)


def _string_tuple(value: object, name: str) -> tuple[str, ...]:
    if type(value) is not list or any(not isinstance(item, str) for item in value):
        raise SelectionArtifactError(f"{name} must be a list of strings")
    return tuple(value)


def _clip_focus_from_dict(value: object, index: int) -> ClipFocus:
    entry = _exact(value, _CLIP_FOCUS_FIELDS, f"clip {index} focus")
    return ClipFocus(
        match=entry["match"],  # type: ignore[arg-type]
        terms=_string_tuple(entry["terms"], f"clip {index} focus terms"),
        at=entry["at"],  # type: ignore[arg-type]
    )


def _focus_summary_from_dict(value: object) -> tuple[FocusSummary, object]:
    """The job's focus summary and the ``matched`` count the artifact claims."""
    entry = _exact(value, _FOCUS_SUMMARY_FIELDS, "selection focus")
    summary = FocusSummary(
        terms=_string_tuple(entry["terms"], "focus terms"),
        requested=entry["requested"],  # type: ignore[arg-type]
    )
    return summary, entry["matched"]


def _clip_from_dict(payload: object, index: int) -> SelectedClip:
    value = _exact(payload, _CLIP_FIELDS, f"clip {index}", _CLIP_OPTIONAL_FIELDS)
    cold = value["cold_open"]
    cold_open = None
    if cold is not None:
        cold_value = _exact(cold, frozenset({"start", "end"}), f"clip {index} cold_open")
        cold_open = (cold_value["start"], cold_value["end"])
    unit_ids = _string_tuple(value["unit_ids"], f"clip {index} unit_ids")
    if type(value["scores"]) is not dict:
        raise SelectionArtifactError(f"clip {index} scores must be an object")
    return SelectedClip(
        rank=value["rank"],
        start=value["start"],
        end=value["end"],
        cold_open=cold_open,
        unit_ids=unit_ids,
        hook_unit_id=value["hook_unit_id"],
        title=value["title"],
        hook_text=value["hook_text"],
        description=value["description"],
        hashtags=_string_tuple(value["hashtags"], f"clip {index} hashtags"),
        archetype=value["archetype"],
        score=value["score"],
        scores=value["scores"],
        reasons=_string_tuple(value["reasons"], f"clip {index} reasons"),
        source=value["source"],
        text=value["text"],
        trends=_trend_refs(value["trends"], index) if "trends" in value else (),
        focus=_clip_focus_from_dict(value["focus"], index) if "focus" in value else None,
    )


def selection_from_dict(payload: object) -> SelectionResult:
    """Strictly rebuild a :class:`SelectionResult` from :meth:`SelectionResult.to_dict`."""
    value = _exact(payload, _RESULT_FIELDS, "selection artifact", _RESULT_OPTIONAL_FIELDS)
    if value["selection_version"] != SELECTION_V3_VERSION:
        raise SelectionArtifactError("unsupported selection_version")
    if type(value["clips"]) is not list:
        raise SelectionArtifactError("clips must be a list")
    if type(value["usage"]) is not dict:
        raise SelectionArtifactError("usage must be an object")
    try:
        clips = tuple(_clip_from_dict(item, index) for index, item in enumerate(value["clips"]))
        focus, matched = (
            _focus_summary_from_dict(value["focus"]) if "focus" in value else (None, None)
        )
        result = SelectionResult(
            clips=clips,
            source=value["source"],
            status=value["status"],
            provider=value["provider"],
            model=value["model"],
            prompt_version=value["prompt_version"],
            warnings=_string_tuple(value["warnings"], "warnings"),
            usage=value["usage"],
            selection_version=value["selection_version"],
            focus=focus,
        )
        if focus is not None and (
            type(matched) is not int or matched != result.focus_matched
        ):
            raise SelectionArtifactError("focus matched must count the matching clips")
        return result
    except SelectionArtifactError:
        raise
    except (TypeError, ValueError) as error:
        raise SelectionArtifactError(f"invalid selection artifact: {error}") from None


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise SelectionArtifactError("selection artifact has a duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise SelectionArtifactError("selection artifact contains a non-finite number")


def write_selection_artifact(path: str | Path, result: SelectionResult) -> Path:
    """Atomically write ``result`` (e.g. to ``analysis/selection.v3.json``)."""
    if not isinstance(result, SelectionResult):
        raise TypeError("result must be a SelectionResult")
    encoded = json.dumps(result.to_dict(), ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    destination = Path(path)
    atomic_write_bytes(destination, encoded.encode("utf-8"))
    return destination


def read_selection_artifact(path: str | Path) -> SelectionResult:
    """Read and strictly validate a selection artifact; errors never echo clip text."""
    source = Path(path)
    if not source.is_file():
        raise FileNotFoundError("selection artifact not found")
    with source.open("rb") as stream:
        raw = stream.read(MAX_SELECTION_ARTIFACT_BYTES + 1)
    if len(raw) > MAX_SELECTION_ARTIFACT_BYTES:
        raise SelectionArtifactError("selection artifact is too large")
    try:
        payload = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SelectionArtifactError("selection artifact is not valid UTF-8 JSON") from None
    return selection_from_dict(payload)


# --- benchmark plugin -------------------------------------------------------------------------


def llm_request_budget(env: Mapping[str, str] | None = None) -> tuple[int, int] | None:
    """``(context_tokens, max_output_tokens)`` for the configured providers, or ``None``.

    The context is the smallest over the failover chain, so every provider can take the
    prompt; the output budget is the primary provider's, capped at half the context.
    """
    configs = load_llm_configs(env)
    if not configs:
        return None
    context = min(config.context_tokens for config in configs)
    return context, min(configs[0].max_output_tokens, context // 2)


def _context_events(context: object) -> tuple[SoundEvent, ...]:
    return tuple(getattr(context, "sound_events", ()) or ())


def _v3_heuristic(
    segments: list[TranscriptSegment],
    *,
    k: int,
    min_duration: float,
    max_duration: float,
    audio_timeline: object | None = None,
    context: object | None = None,
) -> SelectionResult:
    return select_clips_v3(
        segments,
        k=k,
        min_duration=min_duration,
        max_duration=max_duration,
        llm_mode="off",
        events=_context_events(context),
        audio=audio_timeline if isinstance(audio_timeline, AudioTimeline) else None,
    )


def _v3_llm(
    segments: list[TranscriptSegment],
    *,
    k: int,
    min_duration: float,
    max_duration: float,
    audio_timeline: object | None = None,
    context: object | None = None,
) -> SelectionResult:
    budget = llm_request_budget()
    cache_dir = getattr(context, "llm_cache_dir", None)
    client = create_llm_client_from_env(cache_dir=cache_dir)
    if budget is None or client is None:
        raise LLMUnavailable(
            "not_configured", "LLM belum dikonfigurasi; atur POTONGIN_LLM_PROVIDER dan API key."
        )
    context_tokens, max_output_tokens = budget
    return select_clips_v3(
        segments,
        k=k,
        min_duration=min_duration,
        max_duration=max_duration,
        llm_client=client,
        llm_mode="required",
        events=_context_events(context),
        audio=audio_timeline if isinstance(audio_timeline, AudioTimeline) else None,
        context_tokens=context_tokens,
        max_output_tokens=max_output_tokens,
    )


def benchmark_selectors() -> Mapping[str, Callable[..., SelectionResult]]:
    """Selectors registered by ``ai_clipper.benchmark``: heuristic-only and LLM-required."""
    return {"v3-heuristic": _v3_heuristic, "v3-llm": _v3_llm}
