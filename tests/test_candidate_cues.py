import hashlib
import io
import json
import struct

import pytest
from test_candidate_api import encoded, task5_artifact

from ai_clipper.candidate_cues import (
    MAX_TRANSCRIPT_BYTES,
    CandidateNotFoundError,
    cues_from_bytes,
    encode_envelope,
    run,
)


def transcript(segments=None):
    return json.dumps(
        {
            "language": "id",
            "segments": segments
            or [
                {"start": 0.0, "end": 4.0, "text": "Pembuka penting."},
                {"start": 4.0, "end": 12.0, "text": "Jawaban lengkap."},
                {"start": 29.0, "end": 31.0, "text": "Melewati batas."},
            ],
        },
        ensure_ascii=False,
        allow_nan=False,
    ).encode()


def test_authoritative_cues_include_only_whole_segments_and_are_clip_relative():
    artifact = task5_artifact()
    candidate = artifact.candidates[0]
    artifact_bytes = encoded(artifact)
    result = cues_from_bytes(artifact_bytes, transcript(), candidate.candidate_id)

    assert result == {
        "candidateId": candidate.candidate_id,
        "candidateArtifactSha256": hashlib.sha256(artifact_bytes).hexdigest(),
        "selectionVersion": "selection-v2.0",
        "timingProvenance": "segment-v1",
        "wordTiming": False,
        "cues": [
            {
                "id": "cue_000000_" + hashlib.sha256(b"Pembuka penting.").hexdigest()[:16],
                "start": 0.0,
                "end": 4.0,
                "text": "Pembuka penting.",
                "originalTextSha256": hashlib.sha256(b"Pembuka penting.").hexdigest(),
            },
            {
                "id": "cue_000001_" + hashlib.sha256(b"Jawaban lengkap.").hexdigest()[:16],
                "start": 4.0,
                "end": 12.0,
                "text": "Jawaban lengkap.",
                "originalTextSha256": hashlib.sha256(b"Jawaban lengkap.").hexdigest(),
            },
        ],
    }
    assert "source" not in json.dumps(result)


def test_tolerance_accepts_generator_roundoff_but_does_not_clip_partial_segments():
    candidate = task5_artifact().candidates[0]
    raw = transcript(
        [
            {"start": 0.0, "end": 30.0000004, "text": "Within tolerance."},
            {"start": 0.0, "end": 30.000002, "text": "Actually partial."},
        ]
    )
    # Transcript ordering is strict, so exercise these independently.
    accepted = cues_from_bytes(
        encoded(), transcript([json.loads(raw)["segments"][0]]), candidate.candidate_id
    )
    rejected = cues_from_bytes(
        encoded(), transcript([json.loads(raw)["segments"][1]]), candidate.candidate_id
    )
    assert len(accepted["cues"]) == 1
    assert accepted["cues"][0]["end"] == 30.0
    assert rejected["cues"] == []


def test_candidate_membership_is_authoritative():
    with pytest.raises(CandidateNotFoundError):
        cues_from_bytes(encoded(), transcript(), "cand_" + "0" * 64)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"language":"id","language":"en","segments":[]}',
        b'{"language":"id","segments":[{"start":NaN,"end":1,"text":"x"}]}',
        b"\xff",
        b'{"language":"id","segments":[{"start":0,"end":1,"text":"bad\\u0000text"}]}',
        b'{"language":"id","segments":[{"start":1,"end":2,"text":"later"},{"start":0,"end":1,"text":"earlier"}]}',
        b'{"language":"id","segments":[{"start":0,"end":2,"text":"one"},{"start":1,"end":3,"text":"overlap"}]}',
        b'{"language":"id","segments":[],"source":"private"}',
    ],
)
def test_transcript_is_exact_strict_utf8_ordered_nonoverlapping_and_control_free(raw):
    with pytest.raises((TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError)):
        cues_from_bytes(encoded(), raw, task5_artifact().candidates[0].candidate_id)


def test_transcript_size_and_segment_count_are_bounded():
    candidate_id = task5_artifact().candidates[0].candidate_id
    with pytest.raises(ValueError, match="size"):
        cues_from_bytes(encoded(), b" " * (MAX_TRANSCRIPT_BYTES + 1), candidate_id)
    too_many = {
        "language": "id",
        "segments": [{"start": i * 2, "end": i * 2 + 1, "text": "x"} for i in range(100_001)],
    }
    with pytest.raises(ValueError, match="segments"):
        cues_from_bytes(encoded(), json.dumps(too_many).encode(), candidate_id)


def test_binary_stdin_envelope_has_no_paths_and_cli_errors_are_sanitized():
    candidate_id = task5_artifact().candidates[0].candidate_id
    envelope = encode_envelope(encoded(), transcript(), candidate_id)
    artifact_length, transcript_length, id_length = struct.unpack(">QQH", envelope[:18])
    assert artifact_length == len(encoded())
    assert transcript_length == len(transcript())
    assert id_length == len(candidate_id)

    stdout = io.BytesIO()
    stderr = io.StringIO()
    assert run(io.BytesIO(envelope), stdout, stderr) == 0
    assert json.loads(stdout.getvalue())["candidateId"] == candidate_id

    stdout = io.BytesIO()
    stderr = io.StringIO()
    assert run(io.BytesIO(b"bad private /path"), stdout, stderr) != 0
    assert stdout.getvalue() == b""
    assert stderr.getvalue() == "candidate_cues_invalid\n"
