"""The words artifact ``potongin.words/1`` (plan §3.6, docs/editor/CONTRACTS.md §5.7).

Every expectation here is computed by hand from the plan's rules: word ids are the global
flattened indices (segments without word timestamps split exactly like
``subtitles._segment_words``), zero-length words get ``e = min(s + 80, next.s)``, the ``bounds``
snap table picks the quietest 10 ms bin of each gap and the frame boundary inside the gap nearest
to it, gaps over 600 ms are classified, and laughter events come from caption tags and
transcript tokens.
"""

from __future__ import annotations

import array
import hashlib
import json
import random
from fractions import Fraction

import pytest

from ai_clipper import subtitles
from ai_clipper.audio_timeline import ANALYZER_VERSION, AudioTimeline
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.clip_id import ms_from_seconds
from ai_clipper.edit_v2.peaks import bin_count, peaks_file_name
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.edit_v2.words import (
    build_words_artifact,
    encode_words,
    transcript_sha256,
    words_file_name,
)
from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.sentences import build_sentence_units
from ai_clipper.sound_events import SoundEvent
from ai_clipper.transcript_io import transcription_to_dict
from ai_clipper.transcript_quality import assess_transcript

CLIP = "clip_0123456789abcdef01234567"
FPS25 = Fps(25, 1)
FPS2997 = Fps(30000, 1001)
TOP_KEYS = {
    "schema", "clip_id", "transcript_sha256", "fps", "window_ms", "words", "units", "bounds",
    "gaps", "events", "silences", "scene_cuts_ms", "peaks", "missing",
}


def W(start, end, text, probability=None):
    return TranscriptWord(start, end, text, probability)


def S(start, end, text, *words):
    return TranscriptSegment(start, end, text, tuple(words))


def flat_peaks(window_ms, level=10, quiet=()):
    """Every bin at ``level`` (min = -level, max = level) except ``quiet`` {index: level}."""
    count = bin_count(window_ms)
    values = array.array("b")
    for index in range(count):
        amplitude = dict(quiet).get(index, level)
        values.extend((-amplitude, amplitude))
    return values.tobytes()


def build(transcription, window_ms, *, fps=FPS25, audio=None, events=(), peaks=None,
          clip_id=CLIP):
    return build_words_artifact(
        transcription, clip_id=clip_id, window_ms=window_ms, fps=fps, audio=audio,
        events=events, peaks=flat_peaks(window_ms) if peaks is None else peaks,
    )


def boundary_ms(k, fps):
    return Fraction(k * 1000 * fps.den, fps.num)


def timeline(duration_s, silences=(), cuts=()):
    """An AudioTimeline whose silences and scene cuts are exactly the given ones (seconds)."""
    frames = round(duration_s * 10)
    return AudioTimeline(ANALYZER_VERSION, duration_s, 0.1, (-20.0,) * frames, (0.0,) * frames,
                         tuple(silences), tuple(cuts), ())


# --- ids, split, zero-length -------------------------------------------------------------------


def mixed_transcript():
    return Transcription("id", [
        S(1.0, 2.5, "Halo semua orang.", W(1.0, 1.3, "Halo", 0.9), W(1.4, 1.8, "semua", 0.8123),
          W(1.9, 2.5, "orang.")),
        S(3.0, 5.0, "ini kalimat  tanpa kata"),
        S(5.6, 7.0, "eh wkwk Hahaha!", W(5.6, 5.6, "eh"), W(5.65, 6.0, "wkwk", 0.5),
          W(6.0, 6.4, "Hahaha!", 0.4)),
        S(8.0, 9.0, "ya udah.", W(8.0, 8.0, "ya"), W(8.5, 9.0, "udah.")),
    ])


def test_word_ids_are_global_flattened_indices_with_the_proportional_split():
    transcription = mixed_transcript()
    artifact = build(transcription, (0, 10_000))
    words = artifact["words"]
    assert [word["id"] for word in words] == [f"w{index:06d}" for index in range(12)]
    assert [word["t"] for word in words] == [
        "Halo", "semua", "orang.", "ini", "kalimat", "tanpa", "kata", "eh", "wkwk", "Hahaha!",
        "ya", "udah.",
    ]
    split = subtitles._segment_words(transcription.segments[1])
    assert [(word["s"], word["e"]) for word in words[3:7]] == [
        (ms_from_seconds(start), ms_from_seconds(end)) for start, end, _text in split
    ]
    assert [word["p_pm"] for word in words[:4]] == [900, 812, None, None]
    assert all(word["z"] is False for word in words[:7])


def test_zero_length_words_are_widened_to_the_next_word():
    words = build(mixed_transcript(), (0, 10_000))["words"]
    eh, ya = words[7], words[10]
    assert (eh["s"], eh["e"], eh["z"]) == (5600, 5650, True)  # next word starts 50 ms later
    assert (ya["s"], ya["e"], ya["z"]) == (8000, 8080, True)  # s + 80 ms
    assert words[8]["z"] is False


def test_words_are_selected_by_midpoint_and_keep_global_ids():
    artifact = build(mixed_transcript(), (1500, 5000))
    ids = [word["id"] for word in artifact["words"]]
    # "Halo" (mid 1150) is out, "semua" (mid 1600) is in, the split word "kata" (4.5–5.0,
    # mid 4750) is in, "eh" (5600) is out.
    assert ids == ["w000001", "w000002", "w000003", "w000004", "w000005", "w000006"]
    assert artifact["window_ms"] == [1500, 5000]
    assert {unit["id"] for unit in artifact["units"]} == {
        word["u"] for word in artifact["words"]
    }


def test_units_follow_build_sentence_units():
    transcription = mixed_transcript()
    artifact = build(transcription, (0, 10_000))
    quality = assess_transcript(transcription.segments, language="id")
    units = build_sentence_units(transcription.segments, quality=quality)
    assert [unit["id"] for unit in artifact["units"]] == [unit.unit_id for unit in units]
    for unit, entry in zip(units, artifact["units"]):
        assert entry == {"id": unit.unit_id, "s": ms_from_seconds(unit.start),
                         "e": ms_from_seconds(unit.end), "q": unit.is_question}
    position = 0
    for unit in units:
        for word in artifact["words"][position : position + unit.word_count]:
            assert word["u"] == unit.unit_id
        position += unit.word_count
    assert position == len(artifact["words"])


def test_word_text_is_cleaned_like_the_captions():
    bell, zwsp = chr(7), chr(0x200B)
    transcription = Transcription("id", [
        S(1.0, 2.0, "a b c", W(1.0, 1.2, f"a{bell}b"), W(1.3, 1.5, f"{zwsp}ok"),
          W(1.6, 2.0, "c")),
    ])
    words = build(transcription, (0, 3000))["words"]
    assert [word["t"] for word in words] == [
        subtitles.clean_caption_text(f"a{bell}b"), subtitles.clean_caption_text(f"{zwsp}ok"), "c",
    ]
    assert words[0]["t"] == "ab"


# --- bounds ------------------------------------------------------------------------------------


def two_words(a, b):
    return Transcription("id", [S(a[0], b[1], "aa bb", W(a[0], a[1], "aa"), W(b[0], b[1], "bb"))])


def test_bounds_take_the_quietest_bin_and_the_boundary_inside_the_gap():
    window = (0, 10_000)
    peaks = flat_peaks(window, quiet={170: 1})  # bin 170 = 1700–1710 ms, centre 1705
    artifact = build(two_words((1.0, 1.4), (2.0, 2.4)), window, peaks=peaks)
    bounds = artifact["bounds"]
    assert len(bounds) == 3
    middle = bounds[1]
    assert (middle["after"], middle["before"]) == ("w000000", "w000001")
    assert middle["sf"] == 43  # 1720 ms is the boundary nearest 1705 ms inside [1400, 2000]
    assert middle["tight"] is False
    assert middle["rms_cdb"] == -4214  # 20·log10(1/128) dB


def test_equally_quiet_bins_go_to_the_gap_centre():
    artifact = build(two_words((1.0, 1.4), (2.0, 2.4)), (0, 10_000))
    middle = artifact["bounds"][1]
    # Gap centre 1700 ms: bins centred 1695 and 1705 tie, the earlier wins; 1695 → k = 42.
    assert middle["sf"] == 42 and middle["tight"] is False
    assert middle["rms_cdb"] == -2214  # level 10: 20·log10(10/128) dB


def test_first_and_last_bounds_use_the_window_edges():
    artifact = build(two_words((1.0, 1.4), (2.0, 2.4)), (0, 10_000))
    first, last = artifact["bounds"][0], artifact["bounds"][-1]
    assert (first["after"], first["before"]) == (None, "w000000")
    assert (last["after"], last["before"]) == ("w000001", None)
    assert 0 <= boundary_ms(first["sf"], FPS25) <= 1000
    assert 2400 <= boundary_ms(last["sf"], FPS25) <= 10_000
    assert not first["tight"] and not last["tight"]


def test_a_gap_shorter_than_a_frame_is_tight():
    artifact = build(two_words((1.0, 1.41), (1.43, 1.8)), (0, 10_000))
    middle = artifact["bounds"][1]
    # No boundary (multiples of 40 ms) inside [1410, 1430]; nearest the midpoint 1420 is a tie
    # between 1400 and 1440 and the earlier wins.
    assert (middle["sf"], middle["tight"], middle["rms_cdb"]) == (35, True, None)


def test_a_short_gap_with_a_boundary_inside_is_not_tight():
    artifact = build(two_words((1.0, 1.4), (1.43, 1.8)), (0, 10_000))
    middle = artifact["bounds"][1]
    assert (middle["sf"], middle["tight"], middle["rms_cdb"]) == (35, False, None)


def test_overlapping_words_take_the_midpoint_boundary_tight():
    artifact = build(two_words((1.0, 1.4), (1.35, 1.8)), (0, 10_000))
    middle = artifact["bounds"][1]
    # (1400 + 1350) / 2 = 1375 ms → 34.375 frames → boundary 34 (1360 ms), within [1000, 1800].
    assert (middle["sf"], middle["tight"], middle["rms_cdb"]) == (34, True, None)


def test_every_loose_bound_lies_inside_its_gap():
    rng = random.Random(7)
    words = []
    t = 0.5
    for _ in range(300):
        duration = rng.randint(60, 500) / 1000
        words.append(W(round(t, 3), round(t + duration, 3), "kata"))
        t += duration + rng.choice((-0.03, 0.0, 0.01, 0.02, 0.05, 0.2, 0.7))
    words.sort(key=lambda word: word.start)
    transcription = Transcription("id", [S(words[0].start, max(w.end for w in words), "x",
                                           *words)])
    window = (0, ms_from_seconds(t) + 1000)
    rng_peaks = array.array("b")
    for _ in range(bin_count(window)):
        amplitude = rng.randint(0, 60)
        rng_peaks.extend((-amplitude, amplitude))
    artifact = build(transcription, window, fps=FPS2997, peaks=rng_peaks.tobytes())
    by_id = {word["id"]: word for word in artifact["words"]}
    assert len(artifact["bounds"]) == len(artifact["words"]) + 1
    for bound in artifact["bounds"][1:-1]:
        a, b = by_id[bound["after"]], by_id[bound["before"]]
        at = boundary_ms(bound["sf"], FPS2997)
        if not bound["tight"]:
            assert a["e"] <= at <= b["s"]
        else:
            assert b["s"] - a["e"] < 34 or b["s"] < a["e"]


# --- gaps, events, silences, missing -----------------------------------------------------------


def gap_transcript():
    return Transcription("id", [
        S(1.0, 2.4, "aa bb", W(1.0, 1.4, "aa"), W(2.0, 2.4, "bb")),  # gap 600 ms: not listed
        S(3.4, 4.0, "cc", W(3.4, 4.0, "cc")),  # gap 2400–3400 (1000 ms)
        S(5.0, 5.5, "dd", W(5.0, 5.5, "dd")),  # gap 4000–5000
        S(6.5, 7.0, "ee", W(6.5, 7.0, "ee")),  # gap 5500–6500
        S(8.0, 8.5, "wkwk", W(8.0, 8.5, "wkwk")),  # gap 7000–8000
        S(9.5, 10.0, "ff", W(9.5, 10.0, "ff")),  # gap 8500–9500: after a laughter token
    ])


def test_gap_classes():
    audio = timeline(12.0, silences=[(4.0, 4.8), (5.6, 6.3)])
    events = [SoundEvent(3.7, "laughter", "tertawa")]
    artifact = build(gap_transcript(), (0, 12_000), audio=audio, events=events)
    classes = [(gap["after"], gap["s"], gap["e"], gap["class"]) for gap in artifact["gaps"]]
    assert classes == [
        ("w000001", 2400, 3400, "laughter"),  # a tag at 3700 ms is within +500 ms
        ("w000002", 4000, 5000, "silent"),  # 800 of 1000 ms silent: exactly 80 %
        ("w000003", 5500, 6500, "voiced"),  # 700 of 1000 ms silent
        ("w000004", 7000, 8000, "laughter"),  # the "wkwk" token starts at 8000
        ("w000005", 8500, 9500, "laughter"),  # the token ends at 8500
    ]
    assert artifact["silences"] == [[4000, 4800], [5600, 6300]]


def test_events_from_caption_tags_and_laughter_tokens():
    transcription = Transcription("id", [
        S(1.0, 4.0, "x", W(1.0, 1.3, "WKWKWK"), W(1.4, 1.7, "Hahah!"), W(1.8, 2.0, "hehe"),
          W(2.1, 2.3, "ha"), W(2.4, 2.6, "hah"), W(2.7, 2.9, "wkwkw"), W(3.0, 3.2, "(haha)")),
    ])
    tags = [SoundEvent(0.5, "applause", "tepuk tangan"), SoundEvent(2.05, "laughter", "tertawa"),
            SoundEvent(9.0, "laughter", "tertawa")]
    artifact = build(transcription, (0, 5000), events=tags)
    assert artifact["events"] == [
        {"kind": "applause", "s": 500, "e": 500, "src": "yt-caption"},
        {"kind": "laughter", "s": 1000, "e": 1300, "src": "transcript"},
        {"kind": "laughter", "s": 1400, "e": 1700, "src": "transcript"},
        {"kind": "laughter", "s": 1800, "e": 2000, "src": "transcript"},
        {"kind": "laughter", "s": 2050, "e": 2050, "src": "yt-caption"},
        {"kind": "laughter", "s": 3000, "e": 3200, "src": "transcript"},
    ]
    assert artifact["missing"] == ["audio_timeline"]


def test_missing_optional_analysis():
    transcription = gap_transcript()
    artifact = build(transcription, (0, 12_000), audio=None, events=None)
    assert artifact["missing"] == ["audio_timeline", "sound_events"]
    assert artifact["silences"] == [] and artifact["scene_cuts_ms"] == []
    assert artifact["gaps"] == []
    # Transcript tokens are still laughter events without sound-events.json.
    assert artifact["events"] == [{"kind": "laughter", "s": 8000, "e": 8500, "src": "transcript"}]
    audio = timeline(12.0, silences=[(4.0, 4.8)], cuts=(2.5, 11.0))
    complete = build(transcription, (0, 12_000), audio=audio, events=[])
    assert complete["missing"] == []
    assert complete["scene_cuts_ms"] == [2500, 11000]
    clipped = build(transcription, (4200, 12_000), audio=audio, events=[])
    assert clipped["silences"] == [[4200, 4800]]
    assert clipped["scene_cuts_ms"] == [11000]


# --- shape, encoding ---------------------------------------------------------------------------


def _no_floats(value):
    if isinstance(value, float):
        return False
    if isinstance(value, dict):
        return all(_no_floats(item) for item in value.values())
    if isinstance(value, list):
        return all(_no_floats(item) for item in value)
    return True


def test_artifact_shape_and_encoding():
    transcription = mixed_transcript()
    window = (0, 10_000)
    peaks = flat_peaks(window)
    artifact = build(transcription, window, fps=FPS2997, peaks=peaks,
                     audio=timeline(10.0), events=[])
    assert set(artifact) == TOP_KEYS
    assert artifact["schema"] == "potongin.words/1"
    assert artifact["clip_id"] == CLIP
    assert artifact["fps"] == [30000, 1001]
    assert artifact["peaks"] == {"file": peaks_file_name(peaks), "per_sec": 100, "start_ms": 0}
    assert artifact["transcript_sha256"] == transcript_sha256(transcription)
    canonical = json.dumps(transcription_to_dict(transcription), sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False).encode()
    assert transcript_sha256(transcription) == hashlib.sha256(canonical).hexdigest()
    for word in artifact["words"]:
        assert set(word) == {"id", "s", "e", "t", "p_pm", "u", "z"}
    for bound in artifact["bounds"]:
        assert set(bound) == {"after", "before", "sf", "tight", "rms_cdb"}
    assert _no_floats(artifact)
    raw = encode_words(artifact)
    assert raw == json.dumps(artifact, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode()
    assert words_file_name(raw) == f"words.{hashlib.sha256(raw).hexdigest()[:16]}.json"
    again = build(transcription, window, fps=FPS2997, peaks=peaks, audio=timeline(10.0),
                  events=[])
    assert encode_words(again) == raw


def test_bounds_stay_inside_the_window_frames():
    artifact = build(mixed_transcript(), (1500, 5000), fps=FPS2997)
    low, high = tm.sf_floor(1500, FPS2997), tm.sf_ceil(5000, FPS2997)
    assert all(low <= bound["sf"] <= high for bound in artifact["bounds"])


def test_rejects_inconsistent_inputs():
    with pytest.raises(ValueError):
        build(mixed_transcript(), (0, 10_000), peaks=b"\x00\x00")
    with pytest.raises(ValueError):
        build(mixed_transcript(), (5000, 5000))
    with pytest.raises(ValueError):
        build(mixed_transcript(), (0, 10_000), clip_id="not-a-clip")
