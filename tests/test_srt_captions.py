from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_clipper.srt_captions import (
    MAX_SRT_BYTES,
    SrtFormatError,
    guess_language,
    load_srt_track,
    parse_srt,
    srt_to_json3,
)
from ai_clipper.youtube_captions import CaptionFormatError

FIXTURES = Path(__file__).parent / "fixtures" / "srt"
CASES = json.loads((FIXTURES / "cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", sorted(CASES))
def test_shared_fixture_cases(name: str) -> None:
    # web/tests/subtitle-upload.test.mjs checks the same files against the same expectations.
    expected = CASES[name]
    raw = (FIXTURES / name).read_bytes()
    if expected["ok"]:
        cues = parse_srt(raw)
        assert sum(1 for cue in cues if cue.text) == expected["cues"]
    else:
        with pytest.raises(SrtFormatError) as caught:
            parse_srt(raw)
        assert caught.value.code == expected["code"]


def test_cues_keep_times_lines_and_drop_formatting() -> None:
    cues = parse_srt((FIXTURES / "valid.srt").read_bytes())
    assert [(cue.start_ms, cue.end_ms) for cue in cues] == [
        (1000, 3500),
        (4000, 6000),
        (7250, 9000),
    ]
    assert cues[0].text == "Halo semua, selamat datang."
    assert cues[1].text == "- Gaji lo habis duluan?\n- Iya, karena ini."
    assert cues[2].text == "Kita bahas [tertawa] sekarang."


def test_a_line_after_a_blank_line_continues_the_cue_before_it() -> None:
    cues = parse_srt((FIXTURES / "loose.srt").read_bytes())
    assert [cue.text for cue in cues] == ["Pertama.", "", "Kedua baris satu\nkedua baris dua."]


def test_short_fractions_are_milliseconds_and_hours_may_be_long() -> None:
    raw = b"1\n0:00:01,5 --> 100:00:00,25\nPanjang.\n"
    with pytest.raises(SrtFormatError) as caught:
        parse_srt(raw)
    assert caught.value.code == "timing"  # past 24 hours
    (cue,) = parse_srt(b"1\n0:00:01,5 --> 1:00:00,25\nPanjang.\n")
    assert (cue.start_ms, cue.end_ms) == (1500, 3_600_250)


def test_size_cap_nul_and_long_text_are_refused() -> None:
    with pytest.raises(SrtFormatError) as caught:
        parse_srt(b"x" * (MAX_SRT_BYTES + 1))
    assert caught.value.code == "size"
    with pytest.raises(SrtFormatError) as caught:
        parse_srt(b"1\n00:00:01,000 --> 00:00:02,000\nA\x00B\n")
    assert caught.value.code == "encoding"
    long_text = "kata " * 2001
    with pytest.raises(SrtFormatError) as caught:
        parse_srt(f"1\n00:00:01,000 --> 00:00:02,000\n{long_text}\n".encode())
    assert caught.value.code == "too_long"


def test_errors_never_echo_subtitle_text() -> None:
    with pytest.raises(SrtFormatError) as caught:
        parse_srt(b"rahasia-teks-pengguna\n")
    assert "rahasia" not in str(caught.value)
    assert issubclass(SrtFormatError, CaptionFormatError)


def test_json3_document_holds_one_event_per_cue_with_text() -> None:
    document = srt_to_json3(parse_srt((FIXTURES / "loose.srt").read_bytes()))
    assert document == {
        "events": [
            {"tStartMs": 500, "dDurationMs": 1500, "segs": [{"utf8": "Pertama."}]},
            {
                "tStartMs": 3000,
                "dDurationMs": 2000,
                "segs": [{"utf8": "Kedua baris satu\nkedua baris dua."}],
            },
        ]
    }


def test_track_is_the_youtube_caption_transcript_structure(tmp_path: Path) -> None:
    track = load_srt_track(FIXTURES / "valid.srt", language="id")
    transcription = track.transcription
    assert transcription.language == "id"
    words = [word.text for segment in transcription.segments for word in segment.words]
    assert words[:4] == ["Halo", "semua,", "selamat", "datang."]
    assert "[tertawa]" not in " ".join(words)
    assert [event.label for event in track.events] == ["tertawa"]
    # Dash line starts are speaker changes, as in manual YouTube subtitles.
    assert track.speaker_changes
    starts = [word.start for segment in transcription.segments for word in segment.words]
    assert starts == sorted(starts)
    assert 1.0 <= starts[0] < 3.5
    assert transcription.segments[-1].end <= 9.0 + 1e-6


def test_detected_language_is_guessed_from_the_words(tmp_path: Path) -> None:
    english = load_srt_track(
        _write_srt(tmp_path / "en.srt", "So what you need to do is this, and that is the thing."),
        language=None,
    )
    assert english.transcription.language == "en"
    indonesian = load_srt_track(
        _write_srt(tmp_path / "id.srt", "Jadi yang harus kamu lakukan itu ini, dan itu maunya."),
        language=None,
    )
    assert indonesian.transcription.language == "id"
    assert guess_language("") == "id"
    assert guess_language("こんにちは 世界") == "id"


def test_load_refuses_files_over_the_cap(tmp_path: Path) -> None:
    path = tmp_path / "big.srt"
    path.write_bytes(b"1\n00:00:01,000 --> 00:00:02,000\n" + b"a" * MAX_SRT_BYTES)
    with pytest.raises(SrtFormatError) as caught:
        load_srt_track(path, language="id")
    assert caught.value.code == "size"


def _write_srt(path: Path, text: str) -> Path:
    path.write_text(f"1\n00:00:01,000 --> 00:00:05,000\n{text}\n", encoding="utf-8")
    return path
