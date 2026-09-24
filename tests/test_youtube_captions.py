import json
import random
from itertools import pairwise
from pathlib import Path

import pytest

from ai_clipper import youtube_captions
from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.sound_events import SoundEvent, read_sound_events
from ai_clipper.transcript_io import read_transcript_json, write_transcript_json
from ai_clipper.youtube_captions import (
    CaptionFormatError,
    CaptionQuality,
    assess_captions,
    choose_caption_file,
    load_youtube_captions,
    main,
    parse_json3,
    parse_json3_track,
    read_speaker_changes,
    write_speaker_changes,
)

WINDOW = {"tStartMs": 0, "dDurationMs": 9_000_000, "id": 1, "wpWinPosId": 1, "wsWinStyleId": 1}


def asr(start_ms, items, *, duration=None, speaker=False, **extra):
    """One auto-caption line: ``items`` are ``(offset_ms, text)``; text gets YouTube spacing."""
    segs = []
    for index, (offset, text) in enumerate(items):
        seg = {"utf8": text if index == 0 else f" {text}", "acAsrConf": 0}
        if offset:
            seg["tOffsetMs"] = offset
        segs.append(seg)
    if speaker:
        segs[0]["isSpeakerChange"] = 1
    event = {"tStartMs": start_ms, "wWinId": 1, "segs": segs, **extra}
    if duration is not None:
        event["dDurationMs"] = duration
    return event


def newline(start_ms):
    return {"tStartMs": start_ms, "dDurationMs": 10, "wWinId": 1, "aAppend": 1,
            "segs": [{"utf8": "\n"}]}  # fmt: skip


def cue(start_ms, duration, text):
    """One manual-subtitle cue: the whole (possibly multi-line) text in a single seg."""
    return {"tStartMs": start_ms, "dDurationMs": duration, "segs": [{"utf8": text}]}


def doc(*events):
    return json.dumps({"wireMagic": "pb3", "pens": [{}], "events": [WINDOW, *events]})


def words_of(transcription):
    return [word for segment in transcription.segments for word in segment.words]


def texts_of(transcription):
    return [word.text for word in words_of(transcription)]


def test_parses_words_timings_tags_and_skips_newline_events():
    raw = doc(
        asr(1000, [(0, "Halo"), (300, "semua,"), (600, "apa"), (900, "kabar?")], duration=4000),
        newline(1990),
        asr(4000, [(0, "Baik."), (500, "[tertawa]")], duration=3000),
    )

    transcription, events = parse_json3(raw)

    assert transcription.language == "id"
    assert texts_of(transcription) == ["Halo", "semua,", "apa", "kabar?", "Baik."]
    words = words_of(transcription)
    assert [word.start for word in words] == [1.0, 1.3, 1.6, 1.9, 4.0]
    # next word start; a 5-letter word before a pause gets 0.05 * 5 + 0.15 = 0.40 s
    assert [word.end for word in words[:4]] == pytest.approx([1.3, 1.6, 1.9, 2.3])
    # "Baik." ends at the laughter tag that follows it
    assert words[4].end == pytest.approx(4.35)
    assert events == (SoundEvent(4.5, "laughter", "tertawa"),)
    assert all(word.probability is None for word in words)


def test_word_end_caps_event_end_and_minimum_duration():
    raw = doc(
        asr(0, [(0, "menghadirkan"), (5000, "a")], duration=9000),
        asr(10_000, [(0, "ya"), (10, "ya")], duration=5000),
        asr(11_000, [(0, "kenapa")], duration=200),
        asr(20_000, [(0, "panjaaaaaaaaaaaaaaaaaaaang")], duration=5000),
    )

    words = words_of(parse_json3(raw)[0])

    assert words[0].end == pytest.approx(0.75)  # 12 letters: 0.05 * 12 + 0.15
    assert words[1].end == pytest.approx(5.25)  # length estimate floor 0.25 s
    assert words[2].end == pytest.approx(10.05)  # minimum 0.05 s even past the next start
    assert words[4].end == pytest.approx(11.2)  # capped at the event end
    assert words[5].end == pytest.approx(21.2)  # hard cap 1.2 s


def test_segments_split_on_terminal_punctuation_gap_speaker_change_and_word_limit():
    raw = doc(
        asr(0, [(0, "Kamu"), (200, "kenapa?"), (400, "Gue"), (600, "capek")]),
        asr(1500, [(0, "banget")]),  # "capek" ends at 1.0 s: a 0.5 s gap does not split
        asr(5000, [(0, "Oh"), (200, "gitu")], speaker=True),
        asr(5400, [(0, "terus")], speaker=True),
        asr(8000, [(index * 100, f"kata{index}") for index in range(30)]),
    )

    transcription, _ = parse_json3(raw)

    assert [segment.text for segment in transcription.segments[:4]] == [
        "Kamu kenapa?",
        "Gue capek banget",
        "Oh gitu",
        "terus",
    ]
    assert [len(segment.words) for segment in transcription.segments[4:]] == [25, 5]


def test_output_is_chronological_non_overlapping_and_round_trips(tmp_path: Path):
    raw = doc(
        asr(0, [(0, "a"), (10, "b"), (20, "c."), (30, "d")], duration=40),
        asr(40, [(0, "e"), (5, "f.")]),
        asr(46, [(0, "g")]),
    )

    transcription, _ = parse_json3(raw)
    segments = transcription.segments
    for previous, current in pairwise(segments):
        assert previous.end <= current.start
    for segment in segments:
        assert segment.start < segment.end
        for word in segment.words:
            assert segment.start <= word.start <= word.end <= segment.end
    starts = [word.start for word in words_of(transcription)]
    assert starts == sorted(starts)

    path = tmp_path / "transcript.json"
    write_transcript_json(path, transcription)
    loaded = read_transcript_json(path)
    assert [segment.text for segment in loaded.segments] == [s.text for s in segments]
    assert texts_of(loaded) == texts_of(transcription)


def test_cleans_entities_zero_width_music_notes_and_punctuation_tokens():
    raw = doc(
        asr(
            0,
            [
                (0, "Sesi\u200b"),
                (300, "Q&amp;A"),
                (600, "&#39;oke&#39;"),
                (900, "♪"),
                (1200, "♪lagu♫"),
                (1500, "copet"),
                (1800, "."),
                (2100, "\ufeffnih\u00a0"),
            ],
        ),
    )

    track = parse_json3_track(raw)

    assert texts_of(track.transcription) == ["Sesi", "Q&A", "'oke'", "lagu", "copet.", "nih"]
    assert [(event.time, event.kind) for event in track.events] == [(0.9, "music")]


def test_tags_are_events_never_words_even_when_combined_or_mixed_with_text():
    raw = doc(
        asr(0, [(0, "[tertawa][terkesiap]"), (400, "[bernyanyi][musik]")]),
        asr(1000, [(0, "[tepuk tangan]"), (500, "[tertawa] iya"), (900, "[2x]")]),
        asr(2000, [(0, "gila"), (400, "[ __ ]"), (800, "[Laughter]")]),
    )

    track = parse_json3_track(raw)

    assert texts_of(track.transcription) == ["iya", "gila", "***"]
    assert [(event.time, event.kind, event.label) for event in track.events] == [
        (0.0, "gasp", "terkesiap"),
        (0.0, "laughter", "tertawa"),
        (0.4, "music", "bernyanyi"),
        (0.4, "music", "musik"),
        (1.0, "applause", "tepuk tangan"),
        (1.5, "laughter", "tertawa"),
        (2.8, "laughter", "laughter"),
    ]
    assert track.dropped_tags == 1


def test_multi_word_manual_cue_is_spread_over_its_display_window():
    raw = doc(cue(1000, 4000, "Halo semua\napa kabar"), cue(6000, 1000, "Iya."))

    track = parse_json3_track(raw)
    words = words_of(track.transcription)

    assert [word.text for word in words] == ["Halo", "semua", "apa", "kabar", "Iya."]
    starts = [word.start for word in words]
    assert starts[0] == 1.0 and starts == sorted(starts) and starts[3] < 5.0
    assert starts[1] - starts[0] == pytest.approx(4.0 * 5 / 21, abs=1e-3)  # weights: letters + 1
    assert words[3].end <= 5.0
    assert track.timed_word_ratio == pytest.approx(1 / 5)


def test_roll_up_and_repeated_cues_are_deduplicated():
    raw = doc(
        cue(0, 2000, "satu dua tiga"),
        cue(1500, 2000, "satu dua tiga\nempat lima enam"),
        cue(3000, 2000, "empat lima enam\ntujuh delapan"),
        cue(4500, 2000, "tujuh delapan"),
        cue(6000, 1500, "tujuh delapan sembilan"),
        cue(7000, 1500, "tujuh delapan sembilan"),
        cue(9000, 500, "Iya."),
        cue(9500, 500, "Iya."),
    )

    track = parse_json3_track(raw)

    expected = "satu dua tiga empat lima enam tujuh delapan tujuh delapan sembilan Iya. Iya."
    assert texts_of(track.transcription) == expected.split(" ")
    assert track.duplicates_removed == 11  # words


def test_timed_words_repeated_back_in_time_are_dropped():
    raw = doc(
        asr(0, [(0, "aku"), (300, "mau"), (600, "pulang")], duration=3000),
        asr(300, [(0, "mau"), (300, "pulang"), (700, "sekarang")], duration=3000),
        asr(2000, [(0, "iya")]),
        asr(2500, [(0, "iya")]),
    )

    track = parse_json3_track(raw)

    assert texts_of(track.transcription) == ["aku", "mau", "pulang", "sekarang", "iya", "iya"]
    assert track.duplicates_removed == 2
    starts = [word.start for word in words_of(track.transcription)]
    assert starts == sorted(starts) and len(set(starts)) == len(starts)


def test_speaker_changes_are_reported_and_manual_dash_markers_count():
    raw = doc(
        asr(0, [(0, "Halo")]),
        asr(1000, [(0, "[tertawa]"), (300, "iya")], speaker=True),
        cue(3000, 2000, "- Beneran?\n- Iya dong."),
    )

    track = parse_json3_track(raw)

    assert track.speaker_changes == (1.3, 3.0, pytest.approx(4.0, abs=0.5))
    assert texts_of(track.transcription) == ["Halo", "iya", "Beneran?", "Iya", "dong."]


def test_random_documents_keep_output_invariants(tmp_path: Path):
    rng = random.Random(7)
    vocab = ["iya", "gue", "kenapa?", "bang.", "[tertawa]", "[musik]", "\u266a", "-", ">>",
             "[ __ ]", ".", "mana mana", "\n", "Q&amp;A", "\u200b", "x" * 30, "[2x]", "ok,"]  # fmt: skip
    for _ in range(150):
        events, clock = [], 0
        for _ in range(rng.randint(0, 30)):
            clock = max(0, clock + rng.randint(-500, 3000))
            segs = []
            for index in range(rng.randint(1, 5)):
                text = " ".join(rng.choice(vocab) for _ in range(rng.choice([1, 1, 2, 3])))
                seg = {"utf8": f" {text}" if index else text}
                if index or rng.random() < 0.2:
                    seg["tOffsetMs"] = rng.randint(0, 4000)
                if rng.random() < 0.1:
                    seg["isSpeakerChange"] = 1
                segs.append(seg)
            event = {"tStartMs": clock, "segs": segs}
            if rng.random() < 0.7:
                event["dDurationMs"] = rng.randint(0, 5000)
            if rng.random() < 0.1:
                event["aAppend"] = 1
            events.append(event)

        track = parse_json3_track(json.dumps({"events": events}))

        segments = track.transcription.segments
        assert all(left.end <= right.start for left, right in pairwise(segments))
        words = words_of(track.transcription)
        assert all(left.start < right.start for left, right in pairwise(words))
        for segment in segments:
            assert all(segment.start <= w.start <= w.end <= segment.end for w in segment.words)
        path = tmp_path / "transcript.json"
        write_transcript_json(path, track.transcription)
        assert texts_of(read_transcript_json(path)) == texts_of(track.transcription)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"events": [{"tStartMs": NaN, "segs": [{"utf8": "rahasia"}]}]}',
        b'{"events": [], "events": []}',
        b"\xff\xfe",
        b"[]",
        b'{"wireMagic": "pb3"}',
        b'{"events": [{"tStartMs": "0", "segs": [{"utf8": "rahasia"}]}]}',
        b'{"events": [{"tStartMs": true, "segs": [{"utf8": "rahasia"}]}]}',
        b'{"events": [{"tStartMs": -5, "segs": [{"utf8": "rahasia"}]}]}',
        b'{"events": [{"tStartMs": 0, "segs": [{"utf8": "rahasia", "tOffsetMs": -1}]}]}',
        b'{"events": [{"tStartMs": 0, "segs": [{"utf8": 5}]}]}',
        b'{"events": [{"tStartMs": 0, "segs": {"utf8": "rahasia"}}]}',
        b'{"events": ["rahasia"]}',
        b'{"events": [{"tStartMs": 99999999999, "segs": [{"utf8": "rahasia"}]}]}',
    ],
)
def test_rejects_malformed_json3_without_echoing_text(raw: bytes):
    with pytest.raises(CaptionFormatError) as caught:
        parse_json3(raw)
    assert "rahasia" not in str(caught.value)


def test_enforces_size_bounds(monkeypatch: pytest.MonkeyPatch):
    raw = doc(asr(0, [(0, "halo"), (300, "semua")]))
    monkeypatch.setattr(youtube_captions, "MAX_JSON3_BYTES", len(raw) - 1)
    with pytest.raises(CaptionFormatError):
        parse_json3(raw)
    monkeypatch.setattr(youtube_captions, "MAX_JSON3_BYTES", 10**6)
    monkeypatch.setattr(youtube_captions, "MAX_WORDS", 1)
    with pytest.raises(CaptionFormatError):
        parse_json3(raw)


def test_empty_document_and_language_validation():
    transcription, events = parse_json3('{"events": []}', language="en")
    assert transcription == Transcription("en", [])
    assert events == ()
    with pytest.raises(ValueError):
        parse_json3('{"events": []}', language="")
    with pytest.raises(TypeError):
        parse_json3({"events": []})  # type: ignore[arg-type]


def _speech(minutes: float, *, words_per_segment=10, seconds_per_segment=4.0, end="."):
    """Back-to-back segments with 1 s pauses, filling ``minutes`` of media."""
    segments = []
    start = 0.0
    while start + seconds_per_segment <= minutes * 60:
        step = seconds_per_segment / words_per_segment
        words = tuple(
            TranscriptWord(start + i * step, start + (i + 1) * step, f"kata{i}")
            for i in range(words_per_segment)
        )
        text = " ".join(word.text for word in words) + end
        segments.append(TranscriptSegment(start, start + seconds_per_segment, text, words))
        start += seconds_per_segment + 1.0
    return Transcription("id", segments)


def test_assess_accepts_a_normal_podcast_track():
    quality = assess_captions(_speech(10), media_duration=600.0)

    assert quality.ok
    assert quality.reasons == ()
    assert quality.coverage == pytest.approx(0.8, abs=0.01)
    assert quality.words_per_minute == pytest.approx(150.0)
    assert quality.punctuated_ratio == 1.0


def test_assess_reports_stable_reason_codes():
    speech = _speech(10)
    assert assess_captions(speech, media_duration=1200.0).reasons == ("low_coverage", "long_gap")
    unpunctuated = _speech(10, end="")
    assert assess_captions(unpunctuated, media_duration=600.0).reasons == ("low_punctuation",)
    dense = _speech(10, words_per_segment=20)
    assert assess_captions(dense, media_duration=600.0).reasons == ("high_word_rate",)
    sparse = _speech(10, words_per_segment=3)
    assert assess_captions(sparse, media_duration=600.0).reasons == ("low_word_rate",)
    assert assess_captions(speech, media_duration=500.0).reasons == ("duration_mismatch",)
    empty = assess_captions(Transcription("id", []), media_duration=600.0)
    assert empty.reasons == ("empty",) and not empty.ok and empty.coverage == 0.0


def test_assess_flags_music_and_tag_dominated_tracks():
    speech = _speech(10)
    count = len(speech.segments)
    music = tuple(SoundEvent.from_label(float(index), "musik") for index in range(count))
    laughs = tuple(SoundEvent.from_label(float(index), "tertawa") for index in range(count * 3))

    assert assess_captions(speech, media_duration=600.0, events=music).reasons == (
        "music_dominated",
    )
    assert assess_captions(speech, media_duration=600.0, events=laughs).reasons == (
        "tag_dominated",
    )


def test_assess_without_media_duration_uses_the_caption_span():
    quality = assess_captions(_speech(10), media_duration=None)

    assert quality.ok
    assert quality.coverage == pytest.approx(0.8, abs=0.01)
    with pytest.raises(ValueError):
        assess_captions(_speech(1), media_duration=float("nan"))
    with pytest.raises(ValueError):
        assess_captions(_speech(1), media_duration=0)


def test_caption_quality_validates_fields():
    CaptionQuality(True, 0.8, 150.0, 0.9, ())
    for args in [
        (True, 0.8, 150.0, 0.9, ("low_coverage",)),
        (False, 0.8, 150.0, 0.9, ()),
        (False, 0.8, 150.0, 0.9, ("made_up",)),
        (True, 1.5, 150.0, 0.9, ()),
        (True, 0.8, float("nan"), 0.9, ()),
        (True, 0.8, 150.0, -0.1, ()),
        (1, 0.8, 150.0, 0.9, ()),
        (False, 0.8, 150.0, 0.9, ["low_coverage"]),
    ]:
        with pytest.raises((TypeError, ValueError)):
            CaptionQuality(*args)
    payload = CaptionQuality(False, 0.5, 150.0, 0.9, ("low_coverage",)).to_dict()
    assert payload["reasons"] == ["low_coverage"] and payload["ok"] is False


def test_choose_prefers_manual_then_orig_then_exact_and_translations_last(tmp_path: Path):
    auto = tmp_path / "auto"
    manual = tmp_path / "manual"
    candidates = [
        auto / "source.id.json3",
        auto / "source.id-orig.json3",
        auto / "source.en.json3",
        auto / "source.id-en.json3",
        auto / "source.id.vtt",
        auto / "source.id.json3.part",
        manual / "source.id-ID.json3",
        manual / "source.id.json3",
    ]

    assert choose_caption_file(candidates) == manual / "source.id.json3"
    assert choose_caption_file(candidates[:-1]) == manual / "source.id-ID.json3"
    assert choose_caption_file(candidates[:-2]) == auto / "source.id-orig.json3"
    assert choose_caption_file([candidates[0], candidates[3]]) == auto / "source.id.json3"
    assert choose_caption_file(candidates[2:4]) == auto / "source.id-en.json3"
    assert choose_caption_file(candidates[2:3]) is None
    assert choose_caption_file([]) is None
    assert choose_caption_file([str(candidates[2])], language="en") == candidates[2]
    assert choose_caption_file([candidates[1], candidates[0]]) == candidates[1]


def test_load_derives_language_from_the_file_name(tmp_path: Path):
    path = tmp_path / "auto" / "source.id-orig.json3"
    path.parent.mkdir()
    path.write_text(doc(asr(0, [(0, "Halo"), (300, "semua.")])), encoding="utf-8")

    transcription, events, quality = load_youtube_captions(path, media_duration=None)

    assert transcription.language == "id"
    assert texts_of(transcription) == ["Halo", "semua."]
    assert events == ()
    assert isinstance(quality, CaptionQuality)
    with pytest.raises(FileNotFoundError):
        load_youtube_captions(tmp_path / "missing.id.json3")
    with pytest.raises(CaptionFormatError):
        load_youtube_captions(tmp_path)


def test_speaker_changes_artifact_round_trip(tmp_path: Path):
    path = tmp_path / "analysis" / "speaker-changes.json"

    write_speaker_changes(path, (1.25, 7.5))

    assert read_speaker_changes(path) == ((1.25, 7.5), "youtube-json3")
    path.write_text('{"version": "speaker-changes-v1", "source": "x", "times": [2, 1]}')
    with pytest.raises(ValueError):
        read_speaker_changes(path)


def _podcast_json3(minutes: int) -> str:
    events = []
    for index in range(minutes * 12):  # one 8-word line every 5 s
        start = index * 5000
        items = [(offset * 400, f"kata{offset}") for offset in range(7)] + [(2800, "selesai.")]
        events.append(asr(start, items, duration=4000, speaker=index % 3 == 0))
        if index % 10 == 0:
            events.append(asr(start + 3500, [(0, "[tertawa]")]))
    return doc(*events)


def test_cli_writes_transcript_events_and_speaker_changes(tmp_path: Path, capsys):
    source = tmp_path / "source.id.json3"
    source.write_text(_podcast_json3(5), encoding="utf-8")
    out_dir = tmp_path / "job"

    code = main([str(source), "--out-dir", str(out_dir), "--media-duration", "300"])

    assert code == 0
    printed = capsys.readouterr().out
    assert "kata" in printed and "tertawa" in printed
    transcription = read_transcript_json(out_dir / "transcript.json")
    assert len(words_of(transcription)) == 5 * 12 * 8
    events, source_name = read_sound_events(out_dir / "analysis" / "sound-events.json")
    assert source_name == "youtube-json3" and len(events) == 6
    times, _ = read_speaker_changes(out_dir / "analysis" / "speaker-changes.json")
    assert len(times) == 20


def test_cli_json_summary(tmp_path: Path, capsys):
    source = tmp_path / "source.id.json3"
    source.write_text(_podcast_json3(2), encoding="utf-8")

    code = main([str(source), "--out-dir", str(tmp_path / "out"), "--json"])

    assert code == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["quality"]["ok"] is True
    assert summary["words"] == 2 * 12 * 8
    assert summary["events_by_kind"] == {"laughter": 3}


def test_cli_refuses_low_quality_and_invalid_input(tmp_path: Path, capsys):
    source = tmp_path / "source.id.json3"
    source.write_text(_podcast_json3(2), encoding="utf-8")
    out_dir = tmp_path / "out"

    assert main([str(source), "--out-dir", str(out_dir), "--media-duration", "3600"]) == 1
    assert "tidak layak" in capsys.readouterr().err
    assert not (out_dir / "transcript.json").exists()

    broken = tmp_path / "broken.id.json3"
    broken.write_text('{"events": [{"tStartMs": "rahasia"}]}', encoding="utf-8")
    assert main([str(broken), "--out-dir", str(out_dir)]) == 2
    assert "rahasia" not in capsys.readouterr().err
    assert main([str(tmp_path / "missing.json3"), "--out-dir", str(out_dir)]) == 2
