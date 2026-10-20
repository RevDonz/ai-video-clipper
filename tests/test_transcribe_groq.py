"""Groq transcription: the switch from the environment, the request, normalisation and limits.

Every HTTP test talks to a local fake server; nothing here reaches the network.
"""

import json
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from itertools import pairwise
from pathlib import Path

import pytest

from ai_clipper.transcribe_groq import (
    BASE_URL,
    ENV_API_KEY,
    ENV_SWITCH,
    FALLBACK_REASONS,
    GROQ_MODEL,
    MAX_AUDIO_SECONDS,
    GroqTranscription,
    GroqTranscriptionError,
    groq_from_env,
    language_code,
    normalize_groq_response,
    plan_chunks,
    request_transcription,
    transcribe_with_groq,
)

KEY = "groq-test-key-0000"
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs FFmpeg")


# --- the switch ---------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, "", "  ", "off", "0", "false"])
def test_groq_stays_off_unless_the_worker_switches_it_on(value):
    env = {ENV_API_KEY: KEY} if value is None else {ENV_SWITCH: value, ENV_API_KEY: KEY}
    assert groq_from_env(env) is None


def test_switched_on_it_carries_the_key_and_the_prompt():
    config = groq_from_env({ENV_SWITCH: "on", ENV_API_KEY: f"  {KEY}\n"}, prompt="Oke, jadi gini.")
    assert config == GroqTranscription(api_key=KEY, prompt="Oke, jadi gini.")
    assert (config.base_url, config.model) == (BASE_URL, GROQ_MODEL)
    assert config.base_url == "https://api.groq.com/openai/v1"


@pytest.mark.parametrize("key", [None, "", "two words", "line\nbreak", "x" * 5000, "ключ"])
def test_switched_on_without_a_usable_key_keeps_the_switch_but_no_key(key):
    env = {ENV_SWITCH: "on"} if key is None else {ENV_SWITCH: "on", ENV_API_KEY: key}
    config = groq_from_env(env)
    assert config is not None and config.api_key is None


def test_an_invalid_switch_is_refused_without_echoing_it():
    with pytest.raises(ValueError) as caught:
        groq_from_env({ENV_SWITCH: "kadang-kadang", ENV_API_KEY: KEY})
    assert ENV_SWITCH in str(caught.value)
    assert "kadang" not in str(caught.value)


def test_the_key_never_shows_in_the_config_repr():
    assert KEY not in repr(GroqTranscription(api_key=KEY))


def test_fallback_codes_are_short_stable_codes():
    assert FALLBACK_REASONS >= {"no_key", "too_long", "too_large", "rate_limited", "malformed"}
    with pytest.raises(ValueError):
        GroqTranscriptionError("anything goes")


# --- normalisation ------------------------------------------------------------------------------


def verbose(segments, words, language="Indonesian"):
    payload = {"task": "transcribe", "language": language, "duration": 9.0, "segments": segments}
    if words is not None:
        payload["words"] = words
    payload["text"] = " ".join(segment["text"] for segment in segments)
    return payload


SEGMENTS = [
    {
        "start": 0.0,
        "end": 2.0,
        "text": " Halo semua. ",
        "no_speech_prob": 0.01,
        "avg_logprob": -0.2,
    },
    {"start": 2.0, "end": 4.5, "text": " Apa kabar?", "no_speech_prob": 0.02, "avg_logprob": -0.3},
]
WORDS = [
    {"word": " Halo", "start": 0.1, "end": 0.6},
    {"word": "semua.", "start": 0.7, "end": 1.9},
    {"word": "Apa", "start": 2.1, "end": 2.5},
    {"word": "kabar?", "start": 2.6, "end": 4.4},
]


def test_a_verbose_answer_becomes_segments_with_their_words_at_the_chunk_offset():
    segments, language = normalize_groq_response(verbose(SEGMENTS, WORDS), offset=10.0, end=19.0)

    assert language == "id"
    assert [(s.start, s.end, s.text) for s in segments] == [
        (10.0, 12.0, "Halo semua."),
        (12.0, 14.5, "Apa kabar?"),
    ]
    assert [(w.start, w.end, w.text) for w in segments[0].words] == [
        (10.1, 10.6, "Halo"),
        (10.7, 11.9, "semua."),
    ]
    assert [w.text for w in segments[1].words] == ["Apa", "kabar?"]
    assert all(w.probability is None for s in segments for w in s.words)


def test_silence_hallucinations_and_their_words_are_dropped():
    hallucinated = {"start": 4.5, "end": 9.0, "text": " Terima kasih telah menonton.",
                    "no_speech_prob": 0.92, "avg_logprob": -1.4}  # fmt: skip
    words = [*WORDS, {"word": "Terima", "start": 5.0, "end": 5.4}]

    segments, _ = normalize_groq_response(verbose([*SEGMENTS, hallucinated], words))

    assert [s.text for s in segments] == ["Halo semua.", "Apa kabar?"]
    assert "Terima" not in [w.text for s in segments for w in s.words]


def test_times_stay_inside_the_chunk_and_never_overlap():
    raw = [
        {"start": 0.0, "end": 2.0, "text": "Satu."},
        {"start": 1.5, "end": 3.0, "text": "Dua."},  # overlaps the first
        {"start": 8.0, "end": 9.6, "text": "Tiga."},  # runs past the chunk end
        {"start": 9.5, "end": 9.9, "text": "Empat."},  # starts after it
        {"start": "x", "end": 1.0, "text": "Rusak."},
        {"start": 3.0, "end": 4.0, "text": "   "},
    ]
    segments, _ = normalize_groq_response(verbose(raw, []), offset=100.0, end=109.0)

    assert [(s.start, s.end, s.text) for s in segments] == [
        (100.0, 102.0, "Satu."),
        (102.0, 103.0, "Dua."),
        (108.0, 109.0, "Tiga."),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        [],
        "teks",
        {"segments": "bukan daftar"},
        {"segments": [{"start": 0.0, "end": 1.0, "text": "Halo"}]},  # no words although asked
        {"segments": [{"start": 0.0, "end": 1.0, "text": "Halo"}], "words": "rusak"},
    ],
)
def test_malformed_answers_are_refused(payload):
    with pytest.raises(GroqTranscriptionError) as caught:
        normalize_groq_response(payload)
    assert caught.value.code == "malformed"


def test_without_word_timestamps_no_words_are_needed():
    payload = {"language": "english", "segments": [{"start": 0.0, "end": 1.0, "text": "Hello"}]}
    segments, language = normalize_groq_response(payload, word_timestamps=False)
    assert [(s.text, s.words) for s in segments] == [("Hello", ())]
    assert language == "en"


def test_an_answer_without_speech_has_no_segments():
    assert normalize_groq_response({"text": "", "segments": []}) == ([], None)


@pytest.mark.parametrize(
    ("value", "expected"),
    [("Indonesian", "id"), ("english", "en"), ("id", "id"), ("EN", "en"), ("Malay", "ms"),
     ("Klingon", None), ("", None), (None, None), (7, None)],
)  # fmt: skip
def test_language_names_become_codes(value, expected):
    assert language_code(value) == expected


# --- chunks -------------------------------------------------------------------------------------


def test_short_audio_is_one_chunk():
    assert plan_chunks(500.0, [], max_seconds=600.0) == [(0.0, 500.0)]


def test_long_audio_is_cut_in_equal_parts_at_the_nearest_silence():
    silences = [(100.0, 101.0), (590.0, 600.0), (1205.0, 1210.0), (1300.0, 1302.0)]
    chunks = plan_chunks(1800.0, silences, max_seconds=600.0, snap_seconds=30.0)
    assert chunks == [(0.0, 595.0), (595.0, 1207.5), (1207.5, 1800.0)]


def test_without_a_silence_nearby_the_cut_stays_at_the_equal_split():
    chunks = plan_chunks(1201.0, [(50.0, 51.0)], max_seconds=600.0, snap_seconds=30.0)
    assert len(chunks) == 3
    assert chunks[0][0] == 0.0 and chunks[-1][1] == 1201.0
    assert all(end - start == pytest.approx(1201.0 / 3, abs=0.001) for start, end in chunks)
    assert chunks[0][1] == 400.333  # cuts on whole milliseconds, as FFmpeg gets them


def test_chunks_are_contiguous_and_bounded():
    silences = [(t, t + 0.5) for t in range(0, 7200, 37)]
    chunks = plan_chunks(7200.0, silences, max_seconds=600.0, snap_seconds=30.0)
    assert chunks[0][0] == 0.0 and chunks[-1][1] == 7200.0
    assert all(a[1] == b[0] for a, b in pairwise(chunks))
    assert all(0 < end - start <= 660.0 for start, end in chunks)


# --- the fake Groq server -----------------------------------------------------------------------


class FakeGroq:
    """Answers each POST with the next scripted reply and records what it received."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.requests: list[dict] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                fake.requests.append(
                    {"path": self.path, "headers": dict(self.headers), "body": body}
                )
                reply = fake.replies.pop(0) if len(fake.replies) > 1 else fake.replies[0]
                if callable(reply):
                    reply = reply(len(fake.requests))
                status, payload, headers = (*reply, {})[:3]
                if isinstance(payload, (dict, list)):
                    payload = json.dumps(payload).encode()
                elif isinstance(payload, str):
                    payload = payload.encode()
                if headers.get("sleep"):
                    time.sleep(headers.pop("sleep"))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/openai/v1"

    def config(self, **overrides) -> GroqTranscription:
        values = {
            "api_key": KEY,
            "base_url": self.base_url,
            "prompt": "Oke, jadi gini.",
            "timeout": 5.0,
        }
        values.update(overrides)
        return GroqTranscription(**values)

    def fields(self, index: int = 0) -> dict[str, list]:
        """The multipart fields of a request: name -> [values]; the file part as bytes."""
        request = self.requests[index]
        boundary = request["headers"]["Content-Type"].split("boundary=", 1)[1].encode()
        fields: dict[str, list] = {}
        for part in request["body"].split(b"--" + boundary)[1:-1]:
            head, _, value = part.strip(b"\r\n").partition(b"\r\n\r\n")
            name = head.split(b'name="', 1)[1].split(b'"', 1)[0].decode()
            fields.setdefault(name, []).append(value if b"filename=" in head else value.decode())
        return fields


@pytest.fixture
def groq():
    servers = []

    def start(*replies):
        fake = FakeGroq(replies)
        fake.thread.start()
        servers.append(fake)
        return fake

    yield start
    for fake in servers:
        fake.server.shutdown()
        fake.server.server_close()


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    path = tmp_path / "chunk.flac"
    path.write_bytes(b"fLaC fake audio")
    return path


OK = (200, verbose(SEGMENTS, WORDS))


def test_the_request_asks_for_word_timestamps_with_the_key_in_the_header(groq, audio):
    fake = groq(OK)

    payload = request_transcription(fake.config(), audio, language="id")

    assert payload["segments"][0]["text"] == " Halo semua. "
    request = fake.requests[0]
    assert request["path"] == "/openai/v1/audio/transcriptions"
    assert request["headers"]["Authorization"] == f"Bearer {KEY}"
    assert request["headers"]["Content-Type"].startswith("multipart/form-data; boundary=")
    fields = fake.fields()
    assert fields["model"] == [GROQ_MODEL]
    assert fields["response_format"] == ["verbose_json"]
    assert fields["timestamp_granularities[]"] == ["word", "segment"]
    assert fields["language"] == ["id"]
    assert fields["prompt"] == ["Oke, jadi gini."]
    assert fields["temperature"] == ["0"]
    assert fields["file"] == [b"fLaC fake audio"]


def test_a_detected_language_and_no_prompt_leave_those_fields_out(groq, audio):
    fake = groq(OK)
    request_transcription(fake.config(prompt=None), audio, language=None, word_timestamps=False)
    fields = fake.fields()
    assert "language" not in fields and "prompt" not in fields
    assert fields["timestamp_granularities[]"] == ["segment"]


def test_a_short_rate_limit_is_waited_out_once(groq, audio):
    fake = groq((429, {"error": {"message": "slow down"}}, {"Retry-After": "0"}), OK)
    waits = []

    payload = request_transcription(fake.config(), audio, language="id", sleep=waits.append)

    assert payload["language"] == "Indonesian"
    assert len(fake.requests) == 2 and waits == [0.0]


@pytest.mark.parametrize(
    "replies",
    [
        [(429, {"error": {}}, {"Retry-After": "0"})],  # still limited after the one retry
        [(429, {"error": {}}, {"Retry-After": "3600"})],  # the hourly audio limit: no wait
        [(429, {"error": {}})],
    ],
)
def test_a_rate_limit_falls_back(groq, audio, replies):
    fake = groq(*replies)
    waits = []
    with pytest.raises(GroqTranscriptionError) as caught:
        request_transcription(fake.config(), audio, language="id", sleep=waits.append)
    assert caught.value.code == "rate_limited"
    assert len(fake.requests) == len(waits) + 1 <= 2
    assert all(wait <= 10.0 for wait in waits)


@pytest.mark.parametrize(
    ("status", "code"),
    [(413, "too_large"), (401, "auth"), (403, "auth"), (404, "model_unavailable"),
     (500, "server_error"), (503, "server_error"), (400, "http_error"), (307, "http_error")],
)  # fmt: skip
def test_http_refusals_map_to_fallback_codes(groq, audio, status, code):
    fake = groq(
        (status, {"error": {"message": f"refused {KEY}"}}, {"Location": "http://127.0.0.1:9/x"})
    )
    with pytest.raises(GroqTranscriptionError) as caught:
        request_transcription(fake.config(), audio, language="id")
    assert caught.value.code == code
    assert len(fake.requests) == 1  # no retry, and a redirect is never followed
    assert KEY not in str(caught.value) and KEY not in repr(caught.value)


@pytest.mark.parametrize("body", ["{not json", "[]", '"teks"', "ÿþ"])
def test_an_unreadable_answer_is_malformed(groq, audio, body):
    fake = groq((200, body))
    with pytest.raises(GroqTranscriptionError) as caught:
        request_transcription(fake.config(), audio, language="id")
    assert caught.value.code == "malformed"


def test_a_slow_server_times_out(groq, audio):
    fake = groq((200, verbose(SEGMENTS, WORDS), {"sleep": 1.0}))
    with pytest.raises(GroqTranscriptionError) as caught:
        request_transcription(fake.config(timeout=0.2), audio, language="id")
    assert caught.value.code == "timeout"


def test_an_unreachable_server_is_a_network_failure(audio):
    with pytest.raises(GroqTranscriptionError) as caught:
        request_transcription(
            GroqTranscription(api_key=KEY, base_url="http://127.0.0.1:9/openai/v1", timeout=2.0),
            audio,
            language="id",
        )
    assert caught.value.code == "network"


# --- the whole Groq run -------------------------------------------------------------------------


def tone_with_pauses(path: Path, seconds: float) -> Path:
    """A tone of 7 s then 2 s of silence, repeated: silences at 7-9, 16-18, 25-27, ..."""
    expression = "if(lt(mod(t\\,9)\\,7)\\,0.5*sin(2*PI*440*t)\\,0)"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", f"aevalsrc=exprs='{expression}':s=44100:d={seconds}", "-c:a", "pcm_s16le", str(path)],
        check=True,
    )  # fmt: skip
    return path


def chunk_reply(_index):
    segments = [
        {
            "start": 0.5,
            "end": 2.5,
            "text": " Halo semua.",
            "no_speech_prob": 0.0,
            "avg_logprob": -0.1,
        }
    ]
    words = [
        {"word": "Halo", "start": 0.6, "end": 1.0},
        {"word": "semua.", "start": 1.1, "end": 2.4},
    ]
    return 200, verbose(segments, words)


@needs_ffmpeg
def test_a_short_video_is_one_request_of_16_khz_mono_flac(groq, tmp_path: Path):
    source = tone_with_pauses(tmp_path / "source.wav", 6)
    fake = groq(chunk_reply)
    progress = []

    result = transcribe_with_groq(
        source, config=fake.config(), language="id", progress_callback=progress.append
    )

    assert result.language == "id"
    assert [(s.start, s.end, s.text) for s in result.segments] == [(0.5, 2.5, "Halo semua.")]
    upload = fake.fields()["file"][0]
    assert upload.startswith(b"fLaC")
    assert (int.from_bytes(upload[18:21], "big") >> 4) == 16000  # STREAMINFO sample rate
    assert progress == [1.0]


@needs_ffmpeg
def test_a_long_video_is_cut_at_silences_and_put_back_in_place(groq, tmp_path: Path):
    source = tone_with_pauses(tmp_path / "source.wav", 27)
    work = tmp_path / "work"
    work.mkdir()
    files_while_sending = []

    def reply(index):
        files_while_sending.append(sorted(path.name for path in work.glob("*/*")))
        return chunk_reply(index)

    fake = groq(reply)
    progress = []

    result = transcribe_with_groq(
        source,
        config=fake.config(),
        language=None,
        max_chunk_seconds=10.0,
        snap_seconds=3.0,
        progress_callback=progress.append,
        temp_root=work,
    )

    assert len(fake.requests) == 3
    assert all(fake.fields(i)["file"][0].startswith(b"fLaC") for i in range(3))
    assert [round(s.start, 3) for s in result.segments] == [0.5, 8.5, 17.5]  # cuts at 8 and 17
    assert [round(w.start, 3) for w in result.segments[1].words] == [8.6, 9.1]
    assert result.language == "id"  # detected, from the answer
    assert progress == sorted(progress) and progress[-1] == 1.0 and len(progress) == 3
    # One part at a time beside the extracted audio, and nothing left afterwards.
    assert files_while_sending == [
        ["audio.flac", "part-000.flac"],
        ["audio.flac", "part-001.flac"],
        ["audio.flac", "part-002.flac"],
    ]
    assert list(work.iterdir()) == []


def test_without_a_key_nothing_is_sent(groq, tmp_path: Path):
    fake = groq(OK)
    with pytest.raises(GroqTranscriptionError) as caught:
        transcribe_with_groq(tmp_path / "missing.mp4", config=fake.config(api_key=None))
    assert caught.value.code == "no_key"
    assert fake.requests == []


def test_a_video_longer_than_the_free_hourly_audio_is_not_sent(groq, tmp_path: Path):
    fake = groq(OK)
    with pytest.raises(GroqTranscriptionError) as caught:
        transcribe_with_groq(
            tmp_path / "missing.mp4", config=fake.config(), media_duration=MAX_AUDIO_SECONDS + 1
        )
    assert caught.value.code == "too_long"
    assert fake.requests == []


@needs_ffmpeg
def test_a_file_over_the_upload_limit_is_not_sent(groq, tmp_path: Path):
    source = tone_with_pauses(tmp_path / "source.wav", 6)
    fake = groq(OK)
    with pytest.raises(GroqTranscriptionError) as caught:
        transcribe_with_groq(source, config=fake.config(), max_upload_bytes=100)
    assert caught.value.code == "too_large"
    assert fake.requests == []


@needs_ffmpeg
def test_a_source_without_audio_fails_before_any_request(groq, tmp_path: Path):
    source = tmp_path / "notes.mp4"
    source.write_text("not a video", encoding="utf-8")
    fake = groq(OK)
    with pytest.raises(GroqTranscriptionError) as caught:
        transcribe_with_groq(source, config=fake.config())
    assert caught.value.code == "audio_failed"
    assert fake.requests == []


@needs_ffmpeg
def test_an_answer_without_speech_falls_back(groq, tmp_path: Path):
    source = tone_with_pauses(tmp_path / "source.wav", 6)
    fake = groq((200, {"text": "", "segments": [], "words": []}))
    with pytest.raises(GroqTranscriptionError) as caught:
        transcribe_with_groq(source, config=fake.config())
    assert caught.value.code == "empty"
