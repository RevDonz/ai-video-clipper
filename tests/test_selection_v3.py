from __future__ import annotations

import dataclasses
import hashlib
import json
import math

import pytest

from ai_clipper import benchmark, selection_v3
from ai_clipper.audio_timeline import build_audio_timeline
from ai_clipper.focus import FocusMatcher, HeuristicWindows, parse_focus
from ai_clipper.hook_heuristics import HEURISTIC_VERSION
from ai_clipper.llm import LLMError, LLMUnavailable, ScriptedLLMClient
from ai_clipper.llm_selection import (
    FOCUS_PROMPT_VERSION,
    PROMPT_VERSION,
    TREND_PROMPT_VERSION,
    combined_score,
    render_trend_block,
    standard_sha256,
)
from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.selection_types import (
    ClipFocus,
    FocusSummary,
    SelectedClip,
    SelectionResult,
    TrendRef,
)
from ai_clipper.selection_v3 import (
    COLD_OPEN_MAX_SECONDS,
    COLD_OPEN_MIN_SECONDS,
    FOCUS_FILL_REASON,
    LAUGH_TAIL_SECONDS,
    PRE_ROLL_SECONDS,
    SELECTION_ARTIFACT_RELATIVE_PATH,
    TAIL_SECONDS,
    TREND_BOOST,
    TREND_BOOST_CAP,
    SelectionArtifactError,
    _Snapper,
    _Span,
    benchmark_selectors,
    read_selection_artifact,
    select_clips_v3,
    selection_from_dict,
    write_selection_artifact,
)
from ai_clipper.sentences import SentenceUnit, build_sentence_units, looks_like_question
from ai_clipper.sound_events import SoundEvent
from ai_clipper.trend_context import TrendItem, match_trends

SCORES = {"hook": 8, "standalone": 7, "payoff": 6, "emotion": 5, "shareability": 4}
TOLERANCE = 1e-6


# --- fixtures ---------------------------------------------------------------------------------


def statement(index: int) -> str:
    return f"Gue cerita soal kisah{index} bareng teman{index} di kota{index} waktu itu."


def question(index: int) -> str:
    return f"Kenapa kamu pilih jalan{index} itu dulu?"


def segment(start: float, text: str, seconds: float) -> TranscriptSegment:
    tokens = text.split()
    step = seconds / len(tokens)
    words = tuple(
        TranscriptWord(round(start + i * step, 3), round(start + (i + 1) * step, 3), token)
        for i, token in enumerate(tokens)
    )
    return TranscriptSegment(words[0].start, words[-1].end, text, words)


def episode(count: int = 40, *, seconds: float = 7.0, gap: float = 0.0, questions=()):
    """One sentence per segment; every segment becomes one unit and one prompt line."""
    segments = []
    for index in range(count):
        start = index * (seconds + gap)
        text = question(index) if index in questions else statement(index)
        segments.append(segment(start, text, seconds))
    return segments


def lid(index: int) -> str:
    return f"L{index + 1:04d}"


def moment(start: int, end: int, hook: int | None = None, **overrides) -> dict:
    hook = start + 1 if hook is None else hook
    data = {
        "start_id": lid(start),
        "end_id": lid(end),
        "hook_id": lid(hook),
        "payoff_id": None,
        "archetype": "humor",
        "hook_quote": f"kisah{hook} bareng teman{hook} di kota{hook}",
        "title": "Judul klip LLM",
        "hook_text": "Hook dari LLM",
        "description": "Deskripsi singkat.",
        "hashtags": ["#podcastindonesia", "#fyp"],
        "scores": dict(SCORES),
        "reason": "Alasan kuat.",
    }
    data.update(overrides)
    return data


def make_units(rows: list[tuple]) -> list[SentenceUnit]:
    units: list[SentenceUnit] = []
    previous_end: float | None = None
    for index, row in enumerate(rows):
        start, end, text, *rest = row
        options = rest[0] if rest else {}
        gap = 0.0 if previous_end is None else round(max(0.0, start - previous_end), 3)
        units.append(
            SentenceUnit(
                unit_id=f"S{index + 1:04d}",
                index=index,
                start=float(start),
                end=float(end),
                text=text,
                segment_start=index,
                segment_end=index,
                word_count=len(text.split()),
                is_question=options.get("question", looks_like_question(text)),
                gap_before=gap,
                suspect=options.get("suspect", False),
                words=(),
            )
        )
        previous_end = end
    return units


def snapper(units, *, events=(), audio=None, media_end=None, low=20.0, high=60.0) -> _Snapper:
    return _Snapper(
        units,
        events=tuple(sorted(events, key=lambda event: event.time)),
        audio=audio,
        media_end=units[-1].end if media_end is None else media_end,
        min_duration=low,
        max_duration=high,
    )


def laugh(time: float) -> SoundEvent:
    return SoundEvent.from_label(time, "tertawa")


def check_result(result: SelectionResult, *, k: int, low: float, high: float) -> None:
    assert isinstance(result, SelectionResult)
    assert len(result.clips) <= k
    assert [clip.rank for clip in result.clips] == list(range(1, len(result.clips) + 1))
    spans = []
    for clip in result.clips:
        assert low - TOLERANCE <= clip.end - clip.start <= high + TOLERANCE
        first, last = (int(unit_id[1:]) for unit_id in clip.unit_ids)
        assert first <= int(clip.hook_unit_id[1:]) <= last
        spans.append((first, last))
        if clip.cold_open is not None:
            length = clip.cold_open[1] - clip.cold_open[0]
            assert COLD_OPEN_MIN_SECONDS <= length <= COLD_OPEN_MAX_SECONDS + TOLERANCE
            assert abs(clip.cold_open[0] - clip.start) >= 0.01
    for index, (first, last) in enumerate(spans):
        for other_first, other_last in spans[index + 1 :]:
            assert last < other_first or other_last < first


# --- heuristic path ---------------------------------------------------------------------------


def test_llm_off_returns_snapped_heuristic_clips():
    segments = episode(40, gap=0.5)

    result = select_clips_v3(segments, k=4, min_duration=20.0, max_duration=40.0, llm_mode="off")

    check_result(result, k=4, low=20.0, high=40.0)
    assert result.clips
    assert result.source == "heuristic" and result.status == "completed"
    assert result.provider is None and result.model is None
    assert result.prompt_version == HEURISTIC_VERSION
    assert all(clip.source == "heuristic" for clip in result.clips)
    assert "few_clips" not in " ".join(result.warnings)


def test_clip_text_and_unit_ids_describe_the_snapped_span():
    segments = episode(30, gap=0.5)

    result = select_clips_v3(segments, k=3, min_duration=20.0, max_duration=40.0, llm_mode="off")

    for clip in result.clips:
        first, last = (int(unit_id[1:]) - 1 for unit_id in clip.unit_ids)
        assert clip.text == " ".join(statement(index) for index in range(first, last + 1))
        assert segments[first].start - PRE_ROLL_SECONDS - TOLERANCE <= clip.start
        assert clip.start <= segments[first].start
        assert segments[last].end <= clip.end <= segments[last].end + TAIL_SECONDS + TOLERANCE


def test_selection_is_deterministic():
    segments = episode(40, gap=0.5)
    events = (laugh(70.5), laugh(150.2))

    first = select_clips_v3(
        segments, k=5, min_duration=20.0, max_duration=60.0, llm_mode="off", events=events
    )
    second = select_clips_v3(
        segments, k=5, min_duration=20.0, max_duration=60.0, llm_mode="off", events=events[::-1]
    )

    assert first == second


def test_empty_transcript_returns_no_clips():
    result = select_clips_v3([], k=5, min_duration=20.0, max_duration=60.0, llm_mode="required")

    assert result.clips == ()
    assert result.warnings == ("no_transcript",)
    assert result.status == "completed"


# --- LLM path and fallbacks -------------------------------------------------------------------


def test_llm_proposals_lead_and_record_provenance():
    segments = episode(40)
    client = ScriptedLLMClient(
        [{"moments": [moment(10, 13, hook=12), moment(20, 23, hook=21)]}],
        provider="ollama-cloud",
        model="gpt-oss:120b",
    )

    result = select_clips_v3(
        segments, k=2, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )

    check_result(result, k=2, low=20.0, high=40.0)
    assert result.source == "llm" and result.status == "completed"
    assert result.provider == "ollama-cloud" and result.model == "gpt-oss:120b"
    assert result.prompt_version == f"{PROMPT_VERSION}+std.{standard_sha256()[:12]}"
    assert result.usage["requests"] == 1
    assert [clip.unit_ids for clip in result.clips] == [("S0011", "S0014"), ("S0021", "S0024")]
    assert [clip.hook_unit_id for clip in result.clips] == ["S0013", "S0022"]
    assert all(clip.source == "llm" and clip.title == "Judul klip LLM" for clip in result.clips)
    assert len(client.calls) == 1


def test_llm_short_list_is_filled_from_non_overlapping_heuristic_clips():
    segments = episode(60, gap=0.5)
    client = ScriptedLLMClient([{"moments": [moment(10, 13, hook=12)]}])

    result = select_clips_v3(
        segments,
        k=4,
        min_duration=20.0,
        max_duration=40.0,
        llm_client=client,
        rerank=False,
        retry=False,
    )

    check_result(result, k=4, low=20.0, high=40.0)
    assert result.source == "llm"
    assert result.clips[0].source == "llm"
    assert [clip.source for clip in result.clips[1:]] == ["heuristic"] * 3
    assert "llm_filled:3" in result.warnings
    assert any("heuristik" in reason for reason in result.clips[1].reasons)
    assert len(client.calls) == 1


def test_too_few_llm_moments_are_retried_once_then_filled_from_the_heuristic():
    segments = episode(60, gap=0.5)
    client = ScriptedLLMClient(
        [{"moments": [moment(10, 13, hook=12)]}, {"moments": [moment(30, 33, hook=31)]}]
    )

    result = select_clips_v3(
        segments, k=4, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )

    check_result(result, k=4, low=20.0, high=40.0)
    assert len(client.calls) == 2 and result.usage["requests"] == 2
    assert [clip.source for clip in result.clips] == ["llm", "llm", "heuristic", "heuristic"]
    assert result.warnings[:1] == ("llm_retry:follow_up:1",)
    assert "llm_filled:2" in result.warnings


def test_clip_scores_are_the_rubric_combination_of_their_sub_scores():
    segments = episode(60, gap=0.5)
    strong = dict.fromkeys(SCORES, 9)
    client = ScriptedLLMClient(
        [
            {"moments": [moment(10, 13, hook=12), moment(30, 33, hook=31, scores=strong)]},
            {"ranking": [{"id": "K01", "score": 1}, {"id": "K02", "score": 1}]},
        ]
    )

    result = select_clips_v3(
        segments, k=1, min_duration=20.0, max_duration=40.0, llm_client=client, retry=False
    )
    heuristic = select_clips_v3(
        segments, k=4, min_duration=20.0, max_duration=40.0, llm_mode="off"
    )

    assert len(client.calls) == 2  # the rerank ran and only decided the order
    assert result.clips[0].score == pytest.approx(combined_score(result.clips[0].scores))
    assert result.clips[0].score in (pytest.approx(9.0), pytest.approx(6.4))
    for clip in heuristic.clips:
        assert clip.score == pytest.approx(combined_score(clip.scores), abs=1e-3)


@pytest.mark.parametrize(
    ("client", "warning"),
    [
        (None, "llm_unavailable"),
        (ScriptedLLMClient([LLMError("rate_limited", "Kuota habis.")]), "llm_failed:rate_limited"),
        (ScriptedLLMClient([LLMUnavailable("missing_api_key", "Tanpa key.")]), "llm_unavailable"),
        (ScriptedLLMClient([{"moments": []}]), "llm_failed:no_moments"),
    ],
)
def test_auto_mode_falls_back_to_the_heuristic(client, warning):
    segments = episode(40, gap=0.5)

    result = select_clips_v3(
        segments, k=3, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )

    check_result(result, k=3, low=20.0, high=40.0)
    assert result.status == "fallback" and result.source == "heuristic"
    assert warning in result.warnings
    assert result.prompt_version == HEURISTIC_VERSION
    assert result.provider is None and result.model is None
    assert result.clips
    # A request that was answered is still accounted for, even when nothing was usable; an
    # empty answer is retried once (the scripted client then has nothing left).
    assert result.usage.get("requests", 0) == (2 if warning.endswith("no_moments") else 0)
    if warning.endswith("no_moments"):
        assert result.warnings[:2] == ("llm_retry_failed:script_exhausted", warning)


@pytest.mark.parametrize(
    ("client", "error", "code"),
    [
        (None, LLMUnavailable, "not_configured"),
        (ScriptedLLMClient([LLMError("timeout", "Lambat.")]), LLMError, "timeout"),
        (ScriptedLLMClient([{"moments": []}]), LLMError, "no_moments"),
    ],
)
def test_required_mode_reraises(client, error, code):
    with pytest.raises(error) as raised:
        select_clips_v3(
            episode(40),
            k=3,
            min_duration=20.0,
            max_duration=40.0,
            llm_client=client,
            llm_mode="required",
            rerank=False,
        )
    assert raised.value.code == code


def test_llm_moments_lost_to_snapping_fall_back_or_raise(monkeypatch):
    segments = episode(40, gap=0.5)
    original = _Snapper.snap

    def drop_llm_span(self, first, last, protect):
        return None if first == 10 else original(self, first, last, protect)

    def fresh():
        return ScriptedLLMClient([{"moments": [moment(10, 13, hook=12)]}])

    monkeypatch.setattr(_Snapper, "snap", drop_llm_span)

    fallback = select_clips_v3(
        segments, k=2, min_duration=20.0, max_duration=40.0, llm_client=fresh(), rerank=False
    )

    assert fallback.status == "fallback" and fallback.source == "heuristic"
    assert fallback.warnings[0] == "llm_failed:no_moments"
    assert any(warning.startswith("snap_dropped:") for warning in fallback.warnings)
    assert fallback.clips and all(clip.source == "heuristic" for clip in fallback.clips)
    with pytest.raises(LLMError) as raised:
        select_clips_v3(
            segments,
            k=2,
            min_duration=20.0,
            max_duration=40.0,
            llm_client=fresh(),
            llm_mode="required",
            rerank=False,
        )
    assert raised.value.code == "no_moments"


def test_llm_off_never_calls_the_client():
    client = ScriptedLLMClient([])

    select_clips_v3(
        episode(30), k=2, min_duration=20.0, max_duration=40.0, llm_client=client, llm_mode="off"
    )

    assert client.calls == []


def test_overlapping_llm_moment_is_skipped_for_the_next_one():
    segments = episode(60)
    client = ScriptedLLMClient(
        [{"moments": [moment(10, 13, hook=12), moment(13, 16, hook=15), moment(30, 33)]}]
    )

    result = select_clips_v3(
        segments, k=2, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )

    assert [clip.unit_ids for clip in result.clips] == [("S0011", "S0014"), ("S0031", "S0034")]


def letters(index: int) -> str:
    return "".join("abcdefghij"[int(digit)] for digit in f"{index:03d}")


def test_near_duplicate_topic_is_deferred():
    topic = "copet dompet pasar tangan korban polisi kereta stasiun gerbong penumpang"
    rows = []
    for index in range(40):
        extra = f" {topic}" if index in (10, 11, 12, 20, 21, 22) else ""
        text = (
            f"Gue cerita soal kisah{letters(index)} bareng teman{letters(index)}{extra} waktu itu."
        )
        rows.append(segment(index * 7.0, text, 7.0))

    def quoted(start: int, end: int, hook: int) -> dict:
        return moment(
            start, end, hook, hook_quote=f"kisah{letters(hook)} bareng teman{letters(hook)}"
        )

    client = ScriptedLLMClient(
        [{"moments": [quoted(10, 12, 11), quoted(20, 22, 21), quoted(30, 32, 31)]}]
    )

    result = select_clips_v3(
        rows, k=3, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )

    # The near-duplicate LLM pick moves behind the distinct one, still ahead of any filler.
    assert [clip.unit_ids[0] for clip in result.clips] == ["S0011", "S0031", "S0021"]


# --- snapping ---------------------------------------------------------------------------------


def spaced_units(count: int = 12, *, seconds: float = 4.0, gap: float = 1.0):
    return make_units(
        [
            (index * (seconds + gap), index * (seconds + gap) + seconds, statement(index))
            for index in range(count)
        ]
    )


def test_start_has_a_small_pre_roll_that_never_enters_the_previous_word():
    units = make_units(
        [
            (0.0, 4.0, statement(0)),
            (5.0, 9.0, statement(1)),
            (9.05, 13.0, statement(2)),
        ]
    )
    snap = snapper(units, low=1.0, high=30.0)

    assert snap.snap_start(0) == 0.0
    assert snap.snap_start(1) == pytest.approx(5.0 - PRE_ROLL_SECONDS)
    assert snap.snap_start(2) == pytest.approx(9.0)


def quiet_frames(frames: range) -> list[float]:
    rms = [-20.0] * 120 + [-60.0] * 80  # a long quiet tail sets the noise floor
    for frame in range(30, 47):
        rms[frame] = -60.0  # a silence from 3.0 to 4.7 s
    for frame in frames:
        rms[frame] = -35.0
    return rms


def test_start_uses_the_audio_quiet_point_before_the_first_word():
    units = make_units([(0.0, 3.0, statement(0)), (5.0, 9.0, statement(1))])
    audio = build_audio_timeline(quiet_frames(range(47, 50)), duration=20.0)
    snap = snapper(units, audio=audio, low=1.0, high=30.0)

    assert snap.snap_start(1) == pytest.approx(4.95)


def test_start_never_moves_after_the_first_word():
    units = make_units([(0.0, 3.0, statement(0)), (5.0, 9.0, statement(1))])
    audio = build_audio_timeline(quiet_frames(range(50, 53)), duration=20.0)
    snap = snapper(units, audio=audio, low=1.0, high=30.0)

    assert snap.snap_start(1) == pytest.approx(5.0 - PRE_ROLL_SECONDS)


def test_start_inside_a_silence_keeps_the_default_pre_roll():
    units = make_units([(0.0, 3.0, statement(0)), (4.5, 9.0, statement(1))])
    audio = build_audio_timeline(quiet_frames(range(0)), duration=20.0)
    snap = snapper(units, audio=audio, low=1.0, high=30.0)

    assert snap.snap_start(1) == pytest.approx(4.5 - PRE_ROLL_SECONDS)


def test_end_tail_is_capped_by_half_the_following_gap():
    units = make_units([(0.0, 10.0, statement(0)), (10.3, 20.0, statement(1))])
    snap = snapper(units, low=1.0, high=30.0)

    end, last = snap.snap_end(0)

    assert last == 0
    assert end == pytest.approx(10.15)
    wide = snapper(spaced_units(3), low=1.0, high=30.0)
    assert wide.snap_end(0)[0] == pytest.approx(4.0 + TAIL_SECONDS)


def test_end_extends_over_laughter_after_the_last_word():
    units = spaced_units(4, seconds=4.0, gap=3.0)
    snap = snapper(units, events=[laugh(5.0)], low=1.0, high=30.0)

    end, last = snap.snap_end(0)

    assert last == 0
    assert end == pytest.approx(5.0 + LAUGH_TAIL_SECONDS)


def test_laughter_extension_stops_before_the_next_sentence():
    units = make_units([(0.0, 4.0, statement(0)), (5.5, 9.0, statement(1))])
    snap = snapper(units, events=[laugh(5.2)], low=1.0, high=30.0)

    end, last = snap.snap_end(0)

    assert last == 0
    assert end == pytest.approx(5.5 - 0.05)


def test_laughter_far_after_the_last_word_is_ignored():
    units = spaced_units(3, seconds=4.0, gap=5.0)
    snap = snapper(units, events=[laugh(7.0)], low=1.0, high=30.0)

    assert snap.snap_end(0)[0] == pytest.approx(4.0 + TAIL_SECONDS)


def test_short_backchannel_spoken_into_the_laugh_is_kept():
    units = make_units(
        [
            (0.0, 4.0, statement(0)),
            (4.3, 4.9, "Anjir parah."),
            (8.0, 12.0, statement(2)),
        ]
    )
    snap = snapper(units, events=[laugh(5.0)], low=1.0, high=30.0)

    end, last = snap.snap_end(0)

    assert last == 1
    assert end == pytest.approx(5.0 + LAUGH_TAIL_SECONDS)


def test_a_real_sentence_is_never_swallowed_by_the_laugh_tail():
    units = make_units(
        [
            (0.0, 4.0, statement(0)),
            (4.3, 7.9, statement(1)),
            (9.0, 12.0, statement(2)),
        ]
    )
    snap = snapper(units, events=[laugh(5.0)], low=1.0, high=30.0)

    end, last = snap.snap_end(0)

    assert last == 0
    assert end == pytest.approx(4.0 + 0.15)  # the laugh is under the next sentence


def test_laugh_extension_respects_max_duration():
    units = spaced_units(8, seconds=4.0, gap=3.0)
    # Units 0..2 span 18 s; the laugh would push the end to 19.8 s.
    snap = snapper(units, events=[laugh(19.0)], low=10.0, high=19.0)

    span = snap.snap(0, 2, (1, 1))

    assert span is not None
    assert span.end - span.start == pytest.approx(19.0)
    assert span.end >= units[2].end


def test_too_long_span_drops_trailing_units_but_keeps_hook_and_payoff():
    units = spaced_units(10, seconds=4.0, gap=1.0)
    snap = snapper(units, low=10.0, high=20.0)

    span = snap.snap(0, 6, (0, 2))

    assert span is not None
    assert (span.start_unit, span.end_unit) == (0, 3)
    assert span.end - span.start <= 20.0 + TOLERANCE
    assert snap.snap(0, 6, (0, 6)) is None


def test_short_span_takes_a_neighbouring_unit():
    units = spaced_units(10, seconds=4.0, gap=1.0)
    snap = snapper(units, low=12.0, high=30.0)

    span = snap.snap(2, 2, (2, 2))

    assert span is not None
    assert span.end - span.start >= 12.0 - TOLERANCE
    assert span.start_unit <= 2 <= span.end_unit


def test_span_is_clamped_to_the_media_end():
    units = spaced_units(4, seconds=4.0, gap=1.0)
    snap = snapper(units, media_end=units[-1].end, low=5.0, high=30.0)

    span = snap.snap(2, 3, (2, 2))

    assert span is not None and span.end == pytest.approx(units[-1].end)


# --- cold open --------------------------------------------------------------------------------


def test_cold_open_replays_the_hook_line_when_it_starts_late_enough():
    units = spaced_units(10, seconds=4.0, gap=1.0)
    snap = snapper(units, low=10.0, high=40.0)
    span = _Span(0, 5, 0.0, 29.4)

    cold = snap.cold_open(span, 2)

    assert cold == pytest.approx((10.0 - 0.08, 14.0 + 0.12))


@pytest.mark.parametrize(
    ("rows", "hook"),
    [
        ([(0.0, 4.0, statement(0)), (4.5, 8.0, statement(1))], 1),  # starts < 5 s in
        ([(0.0, 4.0, statement(0)), (6.0, 6.5, "Iya."), (7.0, 20.0, statement(2))], 1),  # <1 s
        ([(0.0, 4.0, statement(0)), (6.0, 15.0, statement(1))], 1),  # > 8 s
        ([(0.0, 4.0, statement(0)), (6.0, 9.0, statement(1), {"suspect": True})], 1),
    ],
)
def test_cold_open_is_skipped_when_the_hook_is_unsuitable(rows, hook):
    units = make_units(rows)
    snap = snapper(units, low=1.0, high=40.0)

    assert snap.cold_open(_Span(0, len(units) - 1, 0.0, units[-1].end), hook) is None


def test_cold_open_extends_a_fragment_to_its_sentence_end():
    units = make_units(
        [
            (0.0, 6.0, statement(0)),
            (7.0, 9.0, "Dan ternyata yang nyopet itu"),
            (9.7, 11.5, "polisinya sendiri."),
            (12.5, 20.0, statement(3)),
        ]
    )
    snap = snapper(units, low=1.0, high=40.0)

    cold = snap.cold_open(_Span(0, 3, 0.0, 20.0), 1)

    assert cold == pytest.approx((7.0 - 0.08, 11.5 + 0.12))


def test_cold_open_never_enters_neighbouring_words():
    units = make_units(
        [
            (0.0, 6.0, statement(0)),
            (6.02, 9.0, statement(1)),
            (9.05, 14.0, statement(2)),
        ]
    )
    snap = snapper(units, low=1.0, high=40.0)

    assert snap.cold_open(_Span(0, 2, 0.0, 14.0), 1) == pytest.approx((6.0, 9.05))
    assert snap.cold_open(_Span(0, 2, 1.5, 14.0), 1) is None  # only 4.52 s after the start


def test_cold_open_can_be_disabled_and_is_render_safe():
    segments = episode(40, gap=0.5)
    client = ScriptedLLMClient([{"moments": [moment(10, 14, hook=12)]}] * 2)

    enabled = select_clips_v3(
        segments, k=1, min_duration=20.0, max_duration=40.0, llm_client=client, rerank=False
    )
    disabled = select_clips_v3(
        segments,
        k=1,
        min_duration=20.0,
        max_duration=40.0,
        llm_client=client,
        rerank=False,
        cold_open=False,
    )

    clip = enabled.clips[0]
    assert clip.cold_open is not None
    assert clip.cold_open[0] == pytest.approx(segments[12].start - 0.08)
    assert any(reason.startswith("Cold open") for reason in clip.reasons)
    assert disabled.clips[0].cold_open is None
    check_result(enabled, k=1, low=20.0, high=40.0)


# --- validation -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("options", "error"),
    [
        ({"k": 0}, ValueError),
        ({"k": True}, TypeError),
        ({"min_duration": 0.0}, ValueError),
        ({"min_duration": 50.0}, ValueError),
        ({"max_duration": math.nan}, ValueError),
        ({"llm_mode": "maybe"}, ValueError),
        ({"events": "tertawa"}, TypeError),
        ({"audio": "timeline"}, TypeError),
        ({"quality": {}}, TypeError),
        ({"cold_open": 1}, TypeError),
        ({"max_requests": 0}, ValueError),
        ({"deadline_s": -1.0}, ValueError),
    ],
)
def test_invalid_arguments_are_rejected(options, error):
    arguments = {"k": 3, "min_duration": 20.0, "max_duration": 40.0, "llm_mode": "off"}
    arguments.update(options)
    with pytest.raises(error):
        select_clips_v3(episode(10), **arguments)


def test_segments_must_be_transcript_segments():
    with pytest.raises(TypeError):
        select_clips_v3(["halo"], k=1, min_duration=1.0, max_duration=2.0, llm_mode="off")


# --- artifact ---------------------------------------------------------------------------------


def selection_result() -> SelectionResult:
    client = ScriptedLLMClient([{"moments": [moment(10, 14, hook=12)]}])
    return select_clips_v3(
        episode(40, gap=0.5),
        k=3,
        min_duration=20.0,
        max_duration=40.0,
        llm_client=client,
        rerank=False,
    )


def test_artifact_round_trips_atomically(tmp_path):
    result = selection_result()
    path = tmp_path / SELECTION_ARTIFACT_RELATIVE_PATH

    written = write_selection_artifact(path, result)

    assert written == path
    assert read_selection_artifact(path) == result
    assert sorted(item.name for item in path.parent.iterdir()) == ["selection.v3.json"]
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["selection_version"] == "selection-v3.0"
    assert payload["clips"][0]["cold_open"] is None or set(payload["clips"][0]["cold_open"]) == {
        "start",
        "end",
    }


def mutated(change) -> dict:
    payload = selection_result().to_dict()
    change(payload)
    return payload


@pytest.mark.parametrize(
    "payload",
    [
        mutated(lambda p: p.update(extra=1)),
        mutated(lambda p: p.pop("usage")),
        mutated(lambda p: p.update(selection_version="selection-v2")),
        mutated(lambda p: p.update(clips={})),
        mutated(lambda p: p["clips"][0].update(extra=1)),
        mutated(lambda p: p["clips"][0].update(start=-1.0)),
        mutated(lambda p: p["clips"][0].update(rank=2)),
        mutated(lambda p: p["clips"][0].update(hashtags="#fyp")),
        mutated(lambda p: p["clips"][0].update(cold_open={"start": 1.0})),
        mutated(lambda p: p["clips"][0].update(archetype="viral")),
        mutated(lambda p: p.update(status="failed")),
        [],
    ],
)
def test_artifact_reader_is_strict(payload):
    with pytest.raises(SelectionArtifactError):
        selection_from_dict(payload)


def test_artifact_reader_rejects_bad_json(tmp_path):
    path = tmp_path / "selection.v3.json"
    path.write_text('{"a": 1, "a": 2}', encoding="utf-8")
    with pytest.raises(SelectionArtifactError):
        read_selection_artifact(path)
    path.write_text('{"a": NaN}', encoding="utf-8")
    with pytest.raises(SelectionArtifactError):
        read_selection_artifact(path)
    path.write_bytes(b"\xff\xfe")
    with pytest.raises(SelectionArtifactError):
        read_selection_artifact(path)
    with pytest.raises(FileNotFoundError):
        read_selection_artifact(tmp_path / "missing.json")


def test_artifact_errors_never_echo_clip_text():
    payload = selection_result().to_dict()
    payload["clips"][0]["title"] = "RAHASIA " * 30
    with pytest.raises(SelectionArtifactError) as raised:
        selection_from_dict(payload)
    assert "RAHASIA" not in str(raised.value)


def test_write_rejects_other_values(tmp_path):
    with pytest.raises(TypeError):
        write_selection_artifact(tmp_path / "x.json", {"clips": []})


# --- benchmark plugin -------------------------------------------------------------------------


@pytest.fixture
def isolated_registry(monkeypatch):
    monkeypatch.setattr(benchmark, "_SELECTORS", dict(benchmark._SELECTORS))


def test_benchmark_selectors_are_registered(isolated_registry):
    selectors = benchmark_selectors()

    assert set(selectors) == {"v3-heuristic", "v3-llm"}
    benchmark.load_optional_selectors()
    assert benchmark.get_selector("v3-heuristic").fn is selectors["v3-heuristic"]


def test_v3_heuristic_selector_uses_context_events(isolated_registry):
    benchmark.load_optional_selectors()
    gold = benchmark.parse_gold(
        {
            "schema_version": 1,
            "source_id": "synthetic01",
            "title": "Synthetic",
            "duration_seconds": 400.0,
            "labeler": "test",
            "caveats": [],
            "moments": [
                {"id": "G1", "start": 70.0, "end": 100.0, "archetype": "humor", "label": "x"}
            ],
            "traps": [],
        }
    )
    context = benchmark.SelectorContext(source_id="synthetic01", sound_events=(laugh(98.4),))

    run = benchmark.run_benchmark(
        gold, episode(40, gap=0.5), "v3-heuristic", ks=(5,), context=context
    )

    assert run.status == "completed"
    assert run.selections
    assert run.selector_info is not None
    assert run.selector_info["source"] == "heuristic"
    assert run.metrics[0].cold_open_share is not None


def test_v3_llm_selector_requires_a_configured_llm(monkeypatch, isolated_registry):
    for name in list(__import__("os").environ):
        if name.startswith("POTONGIN_LLM"):
            monkeypatch.delenv(name)
    selector = benchmark_selectors()["v3-llm"]

    with pytest.raises(LLMUnavailable):
        selector(episode(10), k=3, min_duration=20.0, max_duration=40.0)


def test_v3_llm_selector_passes_budget_cache_and_events(monkeypatch, tmp_path):
    seen: dict[str, object] = {}
    client = ScriptedLLMClient([{"moments": [moment(10, 14, hook=12)]}])

    def fake_client(env=None, *, cache_dir=None):
        seen["cache_dir"] = cache_dir
        return client

    def fake_select(segments, **options):
        seen.update(options)
        return "result"

    monkeypatch.setattr(selection_v3, "llm_request_budget", lambda env=None: (131072, 16384))
    monkeypatch.setattr(selection_v3, "create_llm_client_from_env", fake_client)
    monkeypatch.setattr(selection_v3, "select_clips_v3", fake_select)
    context = benchmark.SelectorContext(
        source_id="x", sound_events=(laugh(3.0),), llm_cache_dir=tmp_path
    )

    result = benchmark_selectors()["v3-llm"](
        episode(10), k=3, min_duration=20.0, max_duration=40.0, context=context
    )

    assert result == "result"
    assert seen["cache_dir"] == tmp_path
    assert seen["llm_mode"] == "required" and seen["llm_client"] is client
    assert seen["context_tokens"] == 131072 and seen["max_output_tokens"] == 16384
    assert seen["events"] == (laugh(3.0),)


def test_llm_request_budget_uses_smallest_context(monkeypatch):
    env = {
        "POTONGIN_LLM_PROVIDERS": "groq,ollama-cloud",
        "GROQ_API_KEY": "gsk-test-value-000000",
        "OLLAMA_API_KEY": "ollama-test-value-000000",
    }

    context, output = selection_v3.llm_request_budget(env)

    assert context == 8000
    assert output <= context // 2
    assert selection_v3.llm_request_budget({}) is None


def test_selected_clips_are_benchmark_spans():
    result = selection_result()
    spans = benchmark._validate_spans(result.clips)
    assert spans == tuple((clip.start, clip.end) for clip in result.clips)
    assert all(isinstance(clip, SelectedClip) for clip in result.clips)


# --- Konteks Tren -----------------------------------------------------------------------------


def trend(unit: int, name: str, *, score: float = 50.0, **overrides) -> TrendItem:
    """A trend mentioned only by unit ``unit`` of :func:`episode` ("kisah<unit> bareng")."""
    values = {
        "id": f"trend-{name.lower()}",
        "kind": "topic",
        "title": f"Tren {name}",
        "keywords": (f"kisah{unit} bareng",),
        "hashtags": (f"#Tren{name}",),
        "score": score,
    }
    values.update(overrides)
    return TrendItem(**values)


def llm_run(moments, *, trends=(), k=2, segments=None, **options):
    client = ScriptedLLMClient([{"moments": moments}])
    options.setdefault("rerank", False)
    result = select_clips_v3(
        episode(40) if segments is None else segments,
        k=k,
        min_duration=20.0,
        max_duration=40.0,
        llm_client=client,
        trends=trends,
        **options,
    )
    return result, client


def flat(value: float) -> dict[str, float]:
    return dict.fromkeys(SCORES, value)


def test_without_relevant_trends_every_output_is_unchanged():
    segments = episode(40, gap=0.5)
    absent = TrendItem(id="trend-absent", kind="event", title="Gunung Meletus",
                       keywords=("gunung meletus",), hashtags=("#GunungMeletus",))
    # Packaging that names a trend the episode never mentions is left alone: it was never shown.
    moments = [
        moment(10, 13, hook=12, trend_refs=["T1"], title="Gunung Meletus lagi",
               hashtags=["#GunungMeletus"]),
        moment(20, 23, hook=21),
    ]
    baseline, base_client = llm_run(moments, segments=segments)
    assert baseline.clips[0].title == "Gunung Meletus lagi"
    for trends in ((), [absent]):
        result, client = llm_run(moments, segments=segments, trends=trends)
        assert result == baseline
        assert client.calls == base_client.calls
        assert json.dumps(result.to_dict()) == json.dumps(baseline.to_dict())
    heuristic = select_clips_v3(segments, k=4, min_duration=20.0, max_duration=40.0,
                                llm_mode="off")
    assert select_clips_v3(segments, k=4, min_duration=20.0, max_duration=40.0,
                           llm_mode="off", trends=[absent]) == heuristic
    assert all("trends" not in clip for clip in baseline.to_dict()["clips"])


def test_llm_trend_refs_are_kept_only_when_the_clip_transcript_mentions_them():
    first, second = trend(12, "A", score=90), trend(30, "B", score=10)
    moments = [
        moment(10, 13, hook=12, trend_refs=["T1", "T2", "T9"],
               hashtags=["#fyp", "#TrenB", "#kisah"]),
        moment(20, 23, hook=21, trend_refs=["T2"], hashtags=["#trenb", "#podcast"]),
    ]

    result, client = llm_run(moments, trends=[second, first])

    assert client.calls[0]["user"].endswith("\n\n" + render_trend_block([first, second]))
    assert result.source == "llm"
    assert result.prompt_version == (
        f"{PROMPT_VERSION}+{TREND_PROMPT_VERSION}+std.{standard_sha256()[:12]}"
    )
    grounded, invented = result.clips
    assert grounded.trends == (TrendRef(id="trend-a", title="Tren A", kind="topic"),)
    assert grounded.reasons[-1] == "tren: Tren A"
    assert grounded.hashtags == ("#TrenA", "#fyp", "#kisah")  # B's tag was not grounded
    assert grounded.title == "Judul klip LLM"  # packaging text is the model's own
    assert invented.trends == () and invented.hashtags == ("#podcast",)
    assert not any(reason.startswith("tren:") for reason in invented.reasons)
    assert "trend_ref_ungrounded:3" in result.warnings
    assert grounded.to_dict()["trends"] == [
        {"id": "trend-a", "title": "Tren A", "kind": "topic"}
    ]


def kabur_episode(unit: int = 12) -> list[TranscriptSegment]:
    """:func:`episode` where only unit ``unit`` talks about "kabur aja dulu"."""
    segments = episode(40)
    segments[unit] = segment(
        segments[unit].start, "Terus soal kabur aja dulu itu gimana menurut lu.", 7.0
    )
    return segments


KABUR = TrendItem(id="trend-kabur", kind="topic", title="Kabur Aja Dulu",
                  keywords=("kabur aja dulu",), score=90)


def names_kabur(text: str) -> bool:
    return bool(match_trends([KABUR], text))


def test_llm_packaging_naming_a_trend_the_clip_never_mentions_is_rebuilt_from_the_clip():
    moments = [
        # Units 20-23 never mention the trend; unit 12 does, so the trend is shown as T1.
        moment(20, 23, hook=21, trend_refs=["T1"], title="Kabur Aja Dulu versi podcast",
               hook_text="Kabur aja dulu katanya",
               description="Soal tren Kabur Aja Dulu yang lagi ramai.",
               hashtags=["#KaburAjaDulu", "#fyp"]),
        moment(2, 5, hook=3),
    ]
    plain, _ = llm_run(moments, segments=kabur_episode())

    result, client = llm_run(moments, trends=[KABUR], segments=kabur_episode())

    assert "KONTEKS TREN" in client.calls[0]["user"]
    invented = next(clip for clip in result.clips if clip.unit_ids[0] == "S0021")
    assert not names_kabur(invented.text)
    assert not names_kabur(invented.title) and not names_kabur(invented.hook_text)
    assert invented.description == ""  # its only sentence named the trend
    # Title and hook text fall back to a clean line of the clip's own hook unit.
    assert invented.hook_text and "kisah21" in invented.hook_text
    assert invented.title == invented.hook_text
    # The trend lists no hashtag of its own; the model's tag for its title goes all the same.
    assert invented.hashtags == ("#fyp",)
    assert invented.trends == ()
    assert "trend_ref_ungrounded:1" in result.warnings
    assert "trend_packaging_ungrounded:1" in result.warnings
    other = next(clip for clip in result.clips if clip.unit_ids[0] == "S0003")
    assert other == next(clip for clip in plain.clips if clip.unit_ids[0] == "S0003")


def test_llm_packaging_keeps_its_clean_parts_and_needs_no_trend_ref_to_be_checked():
    moments = [
        moment(20, 23, hook=21, trend_refs=[], title="Kabur Aja Dulu versi podcast",
               hook_text="Kisah21 yang bikin kaget",
               description="Kabur aja dulu katanya. Obrolan santai soal teman lama di kota.",
               hashtags=["#kabur_aja_dulu", "#podcast"]),
        moment(2, 5, hook=3),
    ]

    result, _ = llm_run(moments, trends=[KABUR], segments=kabur_episode())

    clip = next(clip for clip in result.clips if clip.unit_ids[0] == "S0021")
    assert clip.description == "Obrolan santai soal teman lama di kota."
    assert clip.title == "Obrolan santai soal teman lama di kota"
    assert clip.hook_text == "Kisah21 yang bikin kaget"
    assert clip.hashtags == ("#podcast",)
    assert "trend_packaging_ungrounded:1" in result.warnings
    assert not any(code.startswith("trend_ref_ungrounded") for code in result.warnings)


def test_llm_packaging_may_name_a_trend_its_own_clip_mentions():
    moments = [
        moment(10, 13, hook=12, trend_refs=[], title="Kabur Aja Dulu versi podcast",
               hook_text="Kabur aja dulu katanya",
               description="Soal tren Kabur Aja Dulu yang lagi ramai.",
               hashtags=["#KaburAjaDulu", "#fyp"]),
        moment(20, 23, hook=21),
    ]

    result, _ = llm_run(moments, trends=[KABUR], segments=kabur_episode())

    clip = next(clip for clip in result.clips if clip.unit_ids[0] == "S0011")
    assert names_kabur(clip.text)
    assert clip.title == "Kabur Aja Dulu versi podcast"
    assert clip.hook_text == "Kabur aja dulu katanya"
    assert clip.description == "Soal tren Kabur Aja Dulu yang lagi ramai."
    assert clip.hashtags == ("#kaburajadulu", "#fyp")  # true of this clip, so kept
    assert clip.trends == ()  # the model named no ref, so no link, chip or boost
    assert not any(code.startswith("trend_packaging") for code in result.warnings)


def test_heuristic_clips_get_trends_by_direct_matching_without_new_titles():
    segments = episode(40, gap=0.5)
    options = {"k": 4, "min_duration": 20.0, "max_duration": 40.0, "llm_mode": "off"}
    baseline = select_clips_v3(segments, **options)
    target = baseline.clips[1]
    unit = int(target.unit_ids[0][1:])  # S0011 is unit index 10: mention the one after it
    item = trend(unit, "H")

    result = select_clips_v3(segments, trends=[item], **options)

    assert result.prompt_version == HEURISTIC_VERSION
    by_units = {clip.unit_ids: clip for clip in baseline.clips}
    assert set(by_units) == {clip.unit_ids for clip in result.clips}
    for clip in result.clips:
        before = by_units[clip.unit_ids]
        if clip.unit_ids != target.unit_ids:
            assert dataclasses.replace(clip, rank=before.rank) == before
            continue
        assert clip.trends == (item.ref(),)
        assert clip.title == before.title and clip.hook_text == before.hook_text
        assert clip.description == before.description
        assert clip.hashtags == ("#TrenH", *before.hashtags)
        assert clip.reasons[-1] == "tren: Tren H"
        assert clip.score == before.score and clip.scores == before.scores
    assert not any(code.startswith("trend_ref_ungrounded") for code in result.warnings)


def boost_moments(middle: float, refs=("T1",)) -> list[dict]:
    return [
        moment(2, 5, hook=3, scores=flat(7.0)),
        moment(12, 15, hook=13, scores=flat(middle), trend_refs=list(refs)),
        moment(22, 25, hook=23, scores=flat(5.0), trend_refs=["T2"]),
    ]


def starts(result: SelectionResult) -> list[str]:
    return [clip.unit_ids[0] for clip in result.clips]


def test_the_trend_boost_only_reorders_near_tied_clips_and_never_changes_scores():
    assert TREND_BOOST == 3.0 and TREND_BOOST_CAP == 3.0  # points on a 0-100 scale
    trends = [trend(13, "X", score=80), trend(23, "Y", score=70)]

    plain, _ = llm_run(boost_moments(6.8), k=3)
    boosted, _ = llm_run(boost_moments(6.8), k=3, trends=trends)
    too_far, _ = llm_run(boost_moments(6.6), k=3, trends=trends)

    assert starts(plain) == ["S0003", "S0013", "S0023"]
    # 6.8 + 0.3 passes 7.0; 5.0 + 0.3 does not; 6.6 + 0.3 does not either.
    assert starts(boosted) == ["S0013", "S0003", "S0023"]
    assert starts(too_far) == ["S0003", "S0013", "S0023"]
    for clip in boosted.clips:
        before = next(item for item in plain.clips if item.unit_ids == clip.unit_ids)
        assert clip.score == before.score == pytest.approx(combined_score(clip.scores))
        assert clip.scores == before.scores
    assert boosted.clips[0].score == pytest.approx(6.8)


def test_the_boost_is_capped_per_clip():
    trends = [trend(13, "X", score=80), trend(23, "Y", score=70), trend(14, "Z", score=60)]
    result, _ = llm_run(boost_moments(6.65, refs=("T1", "T3")), k=3, trends=trends)
    assert [len(clip.trends) for clip in result.clips] == [0, 2, 1]
    assert starts(result) == ["S0003", "S0013", "S0023"]  # 6.65 + 0.3 (not 0.6) < 7.0


def test_sensitive_trends_give_no_boost_and_no_hashtags():
    trends = [trend(13, "X", score=80, sensitivity="sensitive"), trend(23, "Y", score=70)]
    moments = boost_moments(6.8)
    moments[1]["hashtags"] = ["#TrenX", "#kisah13bareng", "#podcast"]  # the model's own tags
    result, _ = llm_run(moments, k=3, trends=trends)

    assert starts(result) == ["S0003", "S0013", "S0023"]
    sensitive = result.clips[1]
    assert sensitive.trends == (trends[0].ref(),)
    assert sensitive.reasons[-1] == "tren: Tren X (sensitif)"
    assert sensitive.hashtags == ("#podcast",)  # neither added nor kept from the model


def test_a_humor_clip_on_a_sensitive_trend_is_flagged_for_review():
    segments = episode(40)
    segments[21] = segment(segments[21].start, "Terus soal gempa cianjur itu kita ketawa aja deh.", 7.0)
    quake = TrendItem(id="trend-quake", kind="event", title="Gempa Cianjur",
                      keywords=("gempa cianjur",), sensitivity="sensitive", score=95)
    moments = [
        moment(20, 23, hook=21, archetype="humor", trend_refs=["T1"],
               title="Gempa Cianjur malah jadi bahan ketawa", hook_text="Gempa? Ketawa aja!",
               hashtags=["#GempaCianjur", "#lucu"]),
        moment(2, 5, hook=3, archetype="confession"),
    ]

    result, _ = llm_run(moments, trends=[quake], segments=segments)

    clip = next(clip for clip in result.clips if clip.unit_ids[0] == "S0021")
    assert clip.trends == (quake.ref(),)
    assert clip.hashtags == ("#lucu",)
    assert "trend_sensitive_humor:1" in result.warnings

    serious = [dict(moments[0], archetype="emotional"), moments[1]]
    calm, _ = llm_run(serious, trends=[quake], segments=segments)
    assert not any(code.startswith("trend_sensitive_humor") for code in calm.warnings)


def test_trends_must_be_trend_items():
    with pytest.raises(TypeError):
        select_clips_v3(episode(10), k=1, min_duration=20.0, max_duration=40.0,
                        llm_mode="off", trends=["Kabur Aja Dulu"])


def trend_result() -> SelectionResult:
    return llm_run([moment(10, 13, hook=12, trend_refs=["T1"])], k=1,
                   trends=[trend(12, "A")])[0]


def test_artifact_round_trips_clip_trends(tmp_path):
    result = trend_result()
    assert result.clips[0].trends
    path = tmp_path / SELECTION_ARTIFACT_RELATIVE_PATH

    write_selection_artifact(path, result)

    assert read_selection_artifact(path) == result
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["clips"][0]["trends"] == [{"id": "trend-a", "title": "Tren A", "kind": "topic"}]


def trend_mutated(change) -> dict:
    payload = trend_result().to_dict()
    change(payload["clips"][0])
    return payload


@pytest.mark.parametrize(
    "payload",
    [
        trend_mutated(lambda clip: clip.update(trends="Tren A")),
        trend_mutated(lambda clip: clip["trends"][0].update(extra=1)),
        trend_mutated(lambda clip: clip["trends"][0].pop("kind")),
        trend_mutated(lambda clip: clip["trends"][0].update(id="../x")),
        trend_mutated(lambda clip: clip["trends"][0].update(kind="rumor")),
        trend_mutated(lambda clip: clip.update(trends=[clip["trends"][0]] * 2)),
    ],
)
def test_artifact_reader_is_strict_about_trends(payload):
    with pytest.raises(SelectionArtifactError):
        selection_from_dict(payload)


# --- Fokus klip -------------------------------------------------------------------------------

JOMOK = parse_focus(["jomok"], "momen jomok yang lucu")

# sha256 of three fixture selections (heuristic; LLM; LLM with a relevant trend) computed before
# Fokus klip changed the selector (base commit 54a360a). Without focus they must not move.
PRE_FOCUS_SELECTIONS = {
    "heuristic": "43596d32fe4d9e188bac7af908b10c82ec7c595f53df80b20eca75d8a574e6a3",
    "llm": "2ce19c170437028c102fe48d3643af42e7912f3d8ca832051d7968e76c473f6e",
    "llm_trends": "c4c73ed1788a2a9a88d681a7ebb9cee78517ef7633def2bc6a05342ccd3ac4de",
}


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False).encode("utf-8")).hexdigest()


def selection_scenarios(**options) -> dict[str, str]:
    found = {}
    result = select_clips_v3(
        episode(40, gap=0.5), k=4, min_duration=20.0, max_duration=40.0, llm_mode="off",
        events=(laugh(70.5), laugh(150.2)), **options,
    )
    found["heuristic"] = digest(result.to_dict())
    moments = [
        moment(10, 13, hook=12, trend_refs=["T1"], title="Kabur Aja Dulu versi podcast"),
        moment(20, 23, hook=21, scores=flat(6.0)),
        moment(2, 5, hook=3, scores=flat(5.0)),
    ]
    result, client = llm_run(moments, k=4, segments=kabur_episode(), **options)
    found["llm"] = digest([result.to_dict(), client.calls])
    result, client = llm_run(moments, k=4, segments=kabur_episode(), trends=[KABUR], **options)
    found["llm_trends"] = digest([result.to_dict(), client.calls])
    return found


def jomok_episode(*units: int, word: str = "perjomokan", count: int = 40):
    """:func:`episode` where units ``units`` say ``word`` (its second word, at +0.7 s)."""
    segments = episode(count)
    for unit in units:
        text = f"Soal {word} itu kisah{unit} bareng teman{unit} di kota{unit} waktu itu."
        segments[unit] = segment(segments[unit].start, text, 7.0)
    return segments


def unit_range(clip: SelectedClip) -> range:
    first, last = (int(unit_id[1:]) - 1 for unit_id in clip.unit_ids)
    return range(first, last + 1)


def test_without_focus_selections_are_identical_to_before_fokus_klip():
    assert selection_scenarios() == PRE_FOCUS_SELECTIONS
    assert selection_scenarios(focus=None) == PRE_FOCUS_SELECTIONS


def test_matching_clips_come_first_literal_then_semantic_then_none():
    moments = [
        moment(2, 5, hook=3, scores=flat(9.0), focus="none"),
        moment(10, 13, hook=12, scores=flat(7.0), focus="semantic"),
        moment(20, 23, hook=21, scores=flat(5.0), focus="none"),  # unit 22 says "perjomokan"
    ]
    plain, _ = llm_run(moments, k=3, segments=jomok_episode(22))

    result, client = llm_run(moments, k=3, segments=jomok_episode(22), focus=JOMOK)

    assert "<<<FOKUS" in client.calls[0]["user"]
    assert starts(plain) == ["S0003", "S0011", "S0021"]
    assert starts(result) == ["S0021", "S0011", "S0003"]
    literal, semantic, outside = result.clips
    assert literal.focus == ClipFocus("literal", ("jomok",), 154.7)
    assert semantic.focus == ClipFocus("semantic", ("jomok",))
    assert outside.focus == ClipFocus("none")
    for clip in result.clips:  # only the order and the label change
        before = next(item for item in plain.clips if item.unit_ids == clip.unit_ids)
        assert dataclasses.replace(clip, rank=before.rank, focus=None) == before
    assert result.prompt_version == (
        f"{PROMPT_VERSION}+{FOCUS_PROMPT_VERSION}+std.{standard_sha256()[:12]}"
    )
    assert result.focus == FocusSummary(terms=("jomok",), requested=3)
    assert result.to_dict()["focus"] == {"terms": ["jomok"], "matched": 2, "requested": 3}
    assert "focus_few_matches:2" in result.warnings
    assert not any(code.startswith("focus_literal") for code in result.warnings)


def test_a_clip_that_says_a_term_is_literal_and_an_unfounded_literal_claim_is_semantic():
    moments = [moment(2, 5, hook=3, focus="literal"), moment(20, 23, hook=21, focus="none")]

    result, _ = llm_run(moments, k=2, segments=jomok_episode(22), focus=JOMOK)

    assert starts(result) == ["S0021", "S0003"]
    said, claimed = result.clips
    assert said.focus == ClipFocus("literal", ("jomok",), 154.7)  # whatever the model said
    assert claimed.focus == ClipFocus("semantic", ("jomok",))
    assert "focus_literal_ungrounded:1" in result.warnings
    assert not any(code.startswith("focus_few_matches") for code in result.warnings)


def test_literal_terms_and_time_are_the_first_mention_inside_the_clip():
    focus = parse_focus(["jomok", "rusdi", "kisah99"])
    segments = jomok_episode(21, 22)
    segments[23] = segment(segments[23].start, "Terus rusdinya kisah23 bareng teman23 di kota23.",
                           7.0)
    result, _ = llm_run([moment(20, 23, hook=21)], k=1, segments=segments, focus=focus)
    assert result.clips[0].focus == ClipFocus("literal", ("jomok", "rusdi"), 147.7)


def test_the_trend_boost_stays_inside_each_focus_partition():
    outside = [
        moment(2, 5, hook=3, scores=flat(5.1), trend_refs=["T1"]),  # 5.1 + 0.3 > 5.0
        moment(12, 15, hook=13, scores=flat(5.0)),  # literal
    ]
    result, _ = llm_run(outside, k=2, segments=jomok_episode(13),
                        trends=[trend(3, "X", score=80)], focus=JOMOK)
    assert starts(result) == ["S0013", "S0003"]

    inside = [
        moment(12, 15, hook=13, scores=flat(7.0)),
        moment(22, 25, hook=23, scores=flat(6.8), trend_refs=["T1"]),
    ]
    result, _ = llm_run(inside, k=2, segments=jomok_episode(13, 23),
                        trends=[trend(24, "Y", score=70)], focus=JOMOK)
    assert starts(result) == ["S0023", "S0013"]  # 6.8 + 0.3 passes 7.0 among literal clips
    assert [clip.focus.match for clip in result.clips] == ["literal", "literal"]


def test_heuristic_clips_that_say_a_term_come_first():
    segments = jomok_episode(30, word="jomoknya")
    options = {"k": 3, "min_duration": 20.0, "max_duration": 40.0, "llm_mode": "off"}

    result = select_clips_v3(segments, focus=JOMOK, **options)

    check_result(result, k=3, low=20.0, high=40.0)
    assert result.prompt_version == HEURISTIC_VERSION
    first = result.clips[0]
    assert first.focus == ClipFocus("literal", ("jomok",), 210.7)
    assert 30 in unit_range(first)
    assert [clip.focus.match for clip in result.clips[1:]] == ["none", "none"]
    assert "focus_few_matches:1" in result.warnings


def test_a_focus_nobody_mentions_keeps_the_order_and_labels_every_clip_outside():
    segments = episode(40, gap=0.5)
    options = {"k": 4, "min_duration": 20.0, "max_duration": 40.0, "llm_mode": "off"}
    plain = select_clips_v3(segments, **options)

    result = select_clips_v3(segments, focus=JOMOK, **options)

    assert [dataclasses.replace(clip, focus=None) for clip in result.clips] == list(plain.clips)
    assert all(clip.focus == ClipFocus("none") for clip in result.clips)
    assert [code for code in result.warnings if code != "focus_few_matches:0"] == list(
        plain.warnings
    )
    assert "focus_few_matches:0" in result.warnings


def test_an_extra_heuristic_candidate_covers_a_mention_nobody_proposed(monkeypatch):
    monkeypatch.setattr(selection_v3, "propose_heuristic", lambda *args, **kwargs: ())
    moments = [moment(2, 5, hook=3), moment(10, 13, hook=12)]

    result, _ = llm_run(moments, k=3, segments=jomok_episode(30), focus=JOMOK)

    check_result(result, k=3, low=20.0, high=40.0)
    extra = result.clips[0]
    assert extra.source == "heuristic"
    assert extra.focus == ClipFocus("literal", ("jomok",), 210.7)
    assert 30 in unit_range(extra)
    assert extra.reasons[-1] == FOCUS_FILL_REASON
    assert [clip.source for clip in result.clips[1:]] == ["llm", "llm"]
    assert result.source == "llm" and "llm_filled:1" in result.warnings


def test_no_extra_candidate_when_every_slot_already_matches(monkeypatch):
    monkeypatch.setattr(selection_v3, "propose_heuristic", lambda *args, **kwargs: ())
    result, _ = llm_run([moment(20, 23, hook=21)], k=1, segments=jomok_episode(22, 35),
                        focus=JOMOK)
    assert [clip.source for clip in result.clips] == ["llm"]
    assert result.clips[0].focus.match == "literal"


def test_extra_candidates_never_overlap_the_literal_clips(monkeypatch):
    monkeypatch.setattr(selection_v3, "propose_heuristic", lambda *args, **kwargs: ())
    moments = [moment(20, 23, hook=21), moment(2, 5, hook=3)]

    result, _ = llm_run(moments, k=3, segments=jomok_episode(22, 25), focus=JOMOK)

    check_result(result, k=3, low=20.0, high=40.0)  # no two clips share a unit
    assert [clip.focus.match for clip in result.clips] == ["literal", "literal", "none"]
    assert starts(result)[0] == "S0021" and 25 in unit_range(result.clips[1])
    assert result.clips[1].source == "heuristic" and result.clips[2].source == "llm"


def test_a_mention_right_before_a_literal_clip_still_gets_its_own_window(monkeypatch):
    monkeypatch.setattr(selection_v3, "propose_heuristic", lambda *args, **kwargs: ())
    moments = [moment(20, 23, hook=21), moment(2, 5, hook=3)]

    result, _ = llm_run(moments, k=3, segments=jomok_episode(19, 21), focus=JOMOK)

    check_result(result, k=3, low=20.0, high=40.0)
    assert [clip.focus.match for clip in result.clips] == ["literal", "literal", "none"]
    before = result.clips[1]
    assert before.source == "heuristic" and max(unit_range(before)) == 19


def test_an_extra_window_that_covers_more_mentions_is_preferred(monkeypatch):
    monkeypatch.setattr(selection_v3, "propose_heuristic", lambda *args, **kwargs: ())
    moments = [moment(2, 5, hook=3), moment(10, 13, hook=12)]

    result, _ = llm_run(moments, k=3, segments=jomok_episode(30, 33), focus=JOMOK)

    check_result(result, k=3, low=20.0, high=40.0)
    literal = [clip for clip in result.clips if clip.focus.match == "literal"]
    assert len(literal) == 1  # one window says both, the other slots keep the LLM clips
    assert {30, 33} <= set(unit_range(literal[0]))
    assert [clip.source for clip in result.clips] == ["heuristic", "llm", "llm"]


def test_heuristic_windows_stay_inside_the_free_units():
    units = build_sentence_units(jomok_episode(19))
    windows = HeuristicWindows(units, min_duration=20.0, max_duration=40.0)

    free = windows.around(19, 19, 6, within=(0, 19))
    anywhere = windows.around(19, 19, 6)

    assert free and all(item.start_unit <= 19 == item.end_unit for item in free)
    assert all(item.start_unit <= 19 <= item.end_unit for item in anywhere)
    assert [item.score for item in anywhere] == sorted(
        (item.score for item in anywhere), reverse=True
    )
    assert windows.around(19, 19, 6, within=(19, 19)) == []  # 7 s: too short
    assert windows.around(19, 19, 6, within=(20, 39)) == []


def test_llm_clips_outranked_by_focus_matches_are_not_a_fallback():
    for mode in ("auto", "required"):
        result, _ = llm_run([moment(2, 5, hook=3)], k=1, segments=jomok_episode(30),
                            focus=JOMOK, llm_mode=mode)
        assert result.status == "completed"
        assert result.source == "heuristic" and result.prompt_version == HEURISTIC_VERSION
        assert result.clips[0].source == "heuristic"
        assert result.clips[0].focus.match == "literal"
        assert not any(code.startswith("llm_failed") for code in result.warnings)
        # The LLM did answer: say so, so the owner does not read "LLM not used".
        assert "focus_llm_outranked:1" in result.warnings


def test_the_outranked_code_is_only_written_when_no_llm_clip_is_left():
    led, _ = llm_run([moment(2, 5, hook=3)], k=2, segments=jomok_episode(30), focus=JOMOK)
    assert led.source == "llm"
    assert not any(code.startswith("focus_llm_outranked") for code in led.warnings)

    off = select_clips_v3(jomok_episode(30), k=1, min_duration=20.0, max_duration=40.0,
                          llm_mode="off", focus=JOMOK)
    assert not any(code.startswith("focus_llm_outranked") for code in off.warnings)


def test_packaging_outside_the_focus_may_not_use_the_focus_theme():
    moments = [
        moment(2, 5, hook=3, focus="none", title="Momen jomok paling lucu",
               hook_text="Jomok banget sih",
               description="Soal jomok yang lagi ramai. Obrolan santai soal teman lama.",
               hashtags=["#jomok", "#perjomokan", "#fyp"]),
        moment(10, 13, hook=12, focus="semantic", title="Sisi jomok obrolan ini",
               hashtags=["#jomok"]),
        moment(20, 23, hook=21, title="Perjomokan dimulai", hashtags=["#jomok"]),
    ]

    result, _ = llm_run(moments, k=3, segments=jomok_episode(22), focus=JOMOK)

    by_start = {clip.unit_ids[0]: clip for clip in result.clips}
    outside = by_start["S0003"]
    matcher = FocusMatcher(JOMOK)
    assert outside.focus.match == "none"
    assert not matcher.mentions(outside.title) and not matcher.mentions(outside.hook_text)
    assert outside.description == "Obrolan santai soal teman lama."
    assert outside.title == "Obrolan santai soal teman lama"
    assert outside.hashtags == ("#fyp",)
    assert by_start["S0011"].title == "Sisi jomok obrolan ini"
    assert by_start["S0011"].hashtags == ("#jomok",)
    assert by_start["S0021"].title == "Perjomokan dimulai"
    assert "focus_packaging_ungrounded:1" in result.warnings
    assert not any(code.startswith("trend_packaging") for code in result.warnings)


def test_the_heuristic_fallback_keeps_the_focus():
    client = ScriptedLLMClient([LLMError("rate_limited", "Kuota habis.")])

    result = select_clips_v3(jomok_episode(30), k=2, min_duration=20.0, max_duration=40.0,
                             llm_client=client, focus=JOMOK)

    assert result.status == "fallback" and result.prompt_version == HEURISTIC_VERSION
    assert result.clips[0].focus.match == "literal"
    assert result.focus == FocusSummary(terms=("jomok",), requested=2)


def test_focus_must_be_a_focus_spec():
    with pytest.raises(TypeError):
        select_clips_v3(episode(10), k=1, min_duration=20.0, max_duration=40.0,
                        llm_mode="off", focus="jomok")


def focus_selection() -> SelectionResult:
    moments = [moment(10, 13, hook=12, focus="semantic"), moment(20, 23, hook=21)]
    return llm_run(moments, k=3, segments=jomok_episode(22), focus=JOMOK)[0]


def test_artifact_round_trips_the_focus(tmp_path):
    result = focus_selection()
    path = tmp_path / SELECTION_ARTIFACT_RELATIVE_PATH

    write_selection_artifact(path, result)

    assert read_selection_artifact(path) == result
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["focus"] == {"terms": ["jomok"], "matched": 2, "requested": 3}
    assert payload["clips"][0]["focus"] == {"match": "literal", "terms": ["jomok"], "at": 154.7}
    assert [clip["focus"]["match"] for clip in payload["clips"]] == [
        "literal", "semantic", "none",
    ]


def focus_mutated(change) -> dict:
    payload = focus_selection().to_dict()
    change(payload)
    return payload


@pytest.mark.parametrize(
    "payload",
    [
        focus_mutated(lambda p: p["focus"].update(matched=3)),  # must agree with the clips
        focus_mutated(lambda p: p["focus"].update(extra=1)),
        focus_mutated(lambda p: p.update(focus="jomok")),
        focus_mutated(lambda p: p["focus"].update(terms=[])),
        focus_mutated(lambda p: p["focus"].update(requested="3")),
        focus_mutated(lambda p: p.pop("focus")),
        focus_mutated(lambda p: p["clips"][0].pop("focus")),
        focus_mutated(lambda p: p["clips"][0].update(focus=None)),
        focus_mutated(lambda p: p["clips"][0]["focus"].update(match="maybe")),
        focus_mutated(lambda p: p["clips"][0]["focus"].update(at="02:34")),
        focus_mutated(lambda p: p["clips"][0]["focus"].pop("at")),
        focus_mutated(lambda p: p["clips"][0]["focus"].update(terms="jomok")),
    ],
)
def test_artifact_reader_is_strict_about_the_focus(payload):
    with pytest.raises(SelectionArtifactError):
        selection_from_dict(payload)
