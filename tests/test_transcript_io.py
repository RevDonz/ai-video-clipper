import json
import os
from itertools import pairwise
from pathlib import Path

import pytest

from ai_clipper.candidate_cues import _parse_transcript as _parse_candidate_transcript
from ai_clipper.models import Transcription, TranscriptSegment, TranscriptWord
from ai_clipper.transcript_io import (
    MAX_TRANSCRIPT_BYTES,
    TranscriptFormatError,
    read_transcript_json,
    segment_from_payload,
    transcription_from_dict,
    transcription_to_dict,
    words_from_payload,
    write_transcript_json,
)


def _transcription() -> Transcription:
    return Transcription(
        "id",
        [
            TranscriptSegment(
                1.0,
                2.5,
                "Gue bukan jambret.",
                (
                    TranscriptWord(1.0213, 1.30049, "Gue", 0.93456),
                    TranscriptWord(1.31, 1.7, "bukan", None),
                    TranscriptWord(1.7, 2.5, "jambret.", 0.5),
                ),
            ),
            TranscriptSegment(2.5, 4.123456, "Terus kenapa?"),
        ],
    )


def test_to_dict_rounds_and_omits_empty_words_and_missing_probability():
    assert transcription_to_dict(_transcription()) == {
        "language": "id",
        "segments": [
            {
                "start": 1.0,
                "end": 2.5,
                "text": "Gue bukan jambret.",
                "words": [
                    {"start": 1.021, "end": 1.3, "text": "Gue", "probability": 0.935},
                    {"start": 1.31, "end": 1.7, "text": "bukan"},
                    {"start": 1.7, "end": 2.5, "text": "jambret.", "probability": 0.5},
                ],
            },
            {"start": 2.5, "end": 4.123, "text": "Terus kenapa?"},
        ],
    }


def test_to_dict_keeps_rounded_segments_valid():
    tiny = Transcription("id", [TranscriptSegment(1.0001, 1.0003, "Eh")])

    payload = transcription_to_dict(tiny)

    assert payload["segments"][0]["start"] == 1.0
    assert payload["segments"][0]["end"] == 1.001
    assert transcription_from_dict(payload).segments[0].end == 1.001


def test_to_dict_never_creates_overlaps_that_strict_readers_reject():
    # A sub-millisecond segment rounds to a zero-length one and is widened by 1 ms; the next
    # segment must then start at (not before) that widened end, or evaluation.py and
    # candidate_cues.py (which reject any overlap) refuse the whole transcript.
    touching = Transcription(
        "id",
        [
            TranscriptSegment(10.9996, 10.9999, "Eh"),
            TranscriptSegment(10.9999, 12.0, "Terus kenapa?"),
            TranscriptSegment(12.0, 12.0002, "Oh"),
            TranscriptSegment(12.0002, 12.0004, "Ya"),
        ],
    )

    segments = transcription_to_dict(touching)["segments"]

    assert [(item["start"], item["end"]) for item in segments] == [
        (11.0, 11.001),
        (11.001, 12.0),
        (12.0, 12.001),
        (12.001, 12.002),
    ]
    for earlier, later in pairwise(segments):
        assert later["start"] >= earlier["end"]
    assert _parse_candidate_transcript(json.dumps(transcription_to_dict(touching)).encode("utf-8"))


def test_round_trip_preserves_words_and_legacy_segments():
    restored = transcription_from_dict(transcription_to_dict(_transcription()))

    assert restored.language == "id"
    assert restored.segments[0].words[0] == TranscriptWord(1.021, 1.3, "Gue", 0.935)
    assert restored.segments[0].words[1].probability is None
    assert restored.segments[1].words == ()


def test_from_dict_accepts_null_probability_and_empty_words():
    payload = {
        "language": "id",
        "segments": [
            {
                "start": 0,
                "end": 1,
                "text": "Halo",
                "words": [{"start": 0, "end": 1, "text": "Halo", "probability": None}],
            },
            {"start": 1, "end": 2, "text": "lagi", "words": []},
        ],
    }

    result = transcription_from_dict(payload)

    assert result.segments[0].words == (TranscriptWord(0.0, 1.0, "Halo", None),)
    assert result.segments[1].words == ()
    assert isinstance(result.segments[0].start, float)


def _segment(**changes):
    segment = {
        "start": 0.0,
        "end": 1.0,
        "text": "Halo",
        "words": [{"start": 0.0, "end": 0.5, "text": "Halo", "probability": 0.9}],
    }
    segment.update(changes)
    return segment


def _word(**changes):
    word = {"start": 0.0, "end": 0.5, "text": "Halo", "probability": 0.9}
    word.update(changes)
    return word


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"language": "id"},
        {"language": "id", "segments": [], "source": "/private"},
        {"language": "", "segments": []},
        {"language": 3, "segments": []},
        {"language": "x" * 65, "segments": []},
        {"language": "id", "segments": {}},
        {"language": "id", "segments": ["x"]},
        {"language": "id", "segments": [_segment(start=True)]},
        {"language": "id", "segments": [_segment(start="0")]},
        {"language": "id", "segments": [_segment(end=float("nan"))]},
        {"language": "id", "segments": [_segment(end=float("inf"))]},
        {"language": "id", "segments": [_segment(start=-1.0)]},
        {"language": "id", "segments": [_segment(end=0.0)]},
        {"language": "id", "segments": [_segment(text="   ")]},
        {"language": "id", "segments": [_segment(text=None)]},
        {"language": "id", "segments": [_segment(text="bad\ud800")]},
        {"language": "id", "segments": [_segment(speaker="A")]},
        {"language": "id", "segments": [{"start": 0.0, "text": "x"}]},
        {"language": "id", "segments": [_segment(words={})]},
        {"language": "id", "segments": [_segment(words=["Halo"])]},
        {"language": "id", "segments": [_segment(words=[_word(start=True)])]},
        {"language": "id", "segments": [_segment(words=[_word(end=-0.1)])]},
        {"language": "id", "segments": [_segment(words=[_word(end=0.0, start=0.2)])]},
        {"language": "id", "segments": [_segment(words=[_word(text="")])]},
        {"language": "id", "segments": [_segment(words=[_word(text=1)])]},
        {"language": "id", "segments": [_segment(words=[_word(probability=1.01)])]},
        {"language": "id", "segments": [_segment(words=[_word(probability="0.5")])]},
        {"language": "id", "segments": [_segment(words=[_word(probability=False)])]},
        {"language": "id", "segments": [_segment(words=[_word(extra=1)])]},
        {"language": "id", "segments": [_segment(words=[{"start": 0.0, "end": 0.5}])]},
        {
            "language": "id",
            "segments": [_segment(words=[_word(start=0.3, end=0.4), _word(start=0.1)])],
        },
        {
            "language": "id",
            "segments": [_segment(start=1.0, end=2.0), _segment(start=0.0, end=1.0)],
        },
        {
            "language": "id",
            "segments": [_segment(start=0.0, end=2.0), _segment(start=1.5, end=3.0)],
        },
    ],
)
def test_from_dict_rejects_malformed_documents(payload):
    with pytest.raises(TranscriptFormatError):
        transcription_from_dict(payload)


def test_tiny_overlaps_are_repaired_and_large_ones_rejected():
    words = [{"start": 1.6, "end": 1.7, "text": "iya"}]
    payload = {
        "language": "id",
        "segments": [
            {"start": 0.0, "end": 1.619, "text": "satu"},
            {"start": 1.6, "end": 1.72, "text": "iya", "words": words},
        ],
    }

    repaired = transcription_from_dict(payload).segments[1]

    assert (repaired.start, repaired.end) == (1.619, 1.72)
    assert repaired.words[0].start == 1.6
    payload["segments"][1]["start"] = 1.3
    with pytest.raises(TranscriptFormatError, match="overlaps"):
        transcription_from_dict(payload)
    payload["segments"][1].update(start=1.5, end=1.6)
    with pytest.raises(TranscriptFormatError, match="overlaps"):
        transcription_from_dict(payload)


def test_error_messages_never_echo_transcript_text():
    secret = "rahasia-pribadi"
    with pytest.raises(TranscriptFormatError) as error:
        transcription_from_dict({"language": "id", "segments": [_segment(text=secret, x=1)]})
    assert secret not in str(error.value)


def test_payload_helpers_are_reusable_by_other_readers():
    assert words_from_payload([_word()]) == (TranscriptWord(0.0, 0.5, "Halo", 0.9),)
    assert segment_from_payload(_segment()).words[0].text == "Halo"
    with pytest.raises(TranscriptFormatError):
        words_from_payload("nope")
    assert issubclass(TranscriptFormatError, ValueError)


def test_write_is_atomic_readable_and_replaces_existing(tmp_path: Path):
    path = tmp_path / "job" / "transcript.json"
    path.parent.mkdir()
    path.write_text("old", encoding="utf-8")

    write_transcript_json(path, _transcription())

    assert json.loads(path.read_text(encoding="utf-8")) == transcription_to_dict(_transcription())
    assert read_transcript_json(path).segments[0].words[2].text == "jambret."
    assert [item.name for item in path.parent.iterdir()] == ["transcript.json"]
    assert path.read_bytes().endswith(b"\n")


def test_write_creates_parent_and_keeps_non_ascii_text(tmp_path: Path):
    path = tmp_path / "nested" / "transcript.json"
    transcription = Transcription("id", [TranscriptSegment(0.0, 1.0, "Mantap, 大丈夫")])

    write_transcript_json(path, transcription)

    assert "大丈夫" in path.read_text(encoding="utf-8")


def test_failed_write_leaves_previous_file_and_no_temporary(tmp_path: Path, monkeypatch):
    path = tmp_path / "transcript.json"
    write_transcript_json(path, _transcription())
    original = path.read_bytes()

    def fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr("ai_clipper.transcript_io.os.replace", fail)
    with pytest.raises(OSError, match="disk full"):
        write_transcript_json(path, Transcription("en", [TranscriptSegment(0, 1, "x")]))

    assert path.read_bytes() == original
    assert [item.name for item in tmp_path.iterdir()] == ["transcript.json"]


def test_write_rejects_non_transcription(tmp_path: Path):
    with pytest.raises(TypeError):
        write_transcript_json(tmp_path / "t.json", {"language": "id", "segments": []})


def test_read_accepts_legacy_indented_files(tmp_path: Path):
    path = tmp_path / "transcript.json"
    path.write_text(
        json.dumps(
            {"language": "id", "segments": [{"start": 0.0, "end": 6.76, "text": "Ini."}]},
            indent=2,
        ),
        encoding="utf-8",
    )

    result = read_transcript_json(path)

    assert result.segments == [TranscriptSegment(0.0, 6.76, "Ini.")]


@pytest.mark.parametrize(
    "raw",
    [
        b'{"language":"id","language":"en","segments":[]}',
        b'{"language":"id","segments":[{"start":NaN,"end":1,"text":"x"}]}',
        b'{"language":"id","segments":[{"start":1e400,"end":1,"text":"x"}]}',
        b"\xff",
        b"{not json",
    ],
)
def test_read_rejects_non_strict_json(tmp_path: Path, raw: bytes):
    path = tmp_path / "transcript.json"
    path.write_bytes(raw)
    with pytest.raises(TranscriptFormatError):
        read_transcript_json(path)


def test_read_is_size_bounded_and_requires_regular_file(tmp_path: Path):
    path = tmp_path / "transcript.json"
    write_transcript_json(path, _transcription())
    with pytest.raises(TranscriptFormatError, match="at most"):
        read_transcript_json(path, max_bytes=10)
    assert MAX_TRANSCRIPT_BYTES >= 16 * 1024 * 1024
    with pytest.raises(TranscriptFormatError, match="regular"):
        read_transcript_json(tmp_path)
    fifo = tmp_path / "fifo"
    os.mkfifo(fifo)
    with pytest.raises(TranscriptFormatError, match="regular"):
        read_transcript_json(fifo)
    with pytest.raises(FileNotFoundError):
        read_transcript_json(tmp_path / "missing.json")
