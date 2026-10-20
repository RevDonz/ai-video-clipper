"""Opt-in transcription through Groq's hosted Whisper; the pipeline falls back to local Whisper.

Pengaturan "Transkripsi" switches it on (off by default, because the audio goes to a third party).
The web worker then starts the engine with ``POTONGIN_TRANSCRIBE_GROQ=on`` and the key in
``POTONGIN_TRANSCRIBE_GROQ_API_KEY`` (never in argv); :func:`groq_from_env` reads both. The
pipeline only calls :func:`transcribe_with_groq` for a video without usable YouTube captions.

One run (free tier only, stdlib HTTP):

- FFmpeg extracts the first audio stream as 16 kHz mono FLAC into a private temporary folder,
  removed afterwards. Audio longer than ``MAX_AUDIO_SECONDS`` (the free tier's audio seconds per
  hour) is never sent.
- Audio up to ``MAX_CHUNK_SECONDS`` is one request; longer audio is cut into equal parts, each
  cut moved to the middle of the nearest silence (FFmpeg ``silencedetect``) within
  ``SNAP_SECONDS``. At 16 kHz 16-bit mono a part of 660 s holds at most 21 MB of samples, under
  the free tier's 25 MB per file; every file is still checked against ``MAX_UPLOAD_BYTES``.
- Each part goes to ``POST {base}/audio/transcriptions`` (``verbose_json``, word and segment
  timestamps, the job's language and the Whisper style prompt). A 429 whose ``Retry-After`` is at
  most ``MAX_RETRY_WAIT_SECONDS`` is retried once. Redirects are never followed.
- Answers become the same :class:`Transcription` the local path writes: chronological,
  non-overlapping segments inside their part, words assigned to the segment around their
  midpoint, Whisper's silence rule (``no_speech_prob > 0.6`` with ``avg_logprob < -1``) dropping
  hallucinated segments.

Any failure raises :class:`GroqTranscriptionError` with a code from ``FALLBACK_REASONS``; the
code is all that reaches a log or the job summary, never the key, a path or the server's text.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from bisect import bisect_right
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from http.client import HTTPException
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .models import Transcription, TranscriptSegment
from .transcribe import _clean_text, _finite, _normalize_words

ENV_SWITCH = "POTONGIN_TRANSCRIBE_GROQ"
ENV_API_KEY = "POTONGIN_TRANSCRIBE_GROQ_API_KEY"
BASE_URL = "https://api.groq.com/openai/v1"
# Free on Groq's free tier, like turbo, and the more accurate of the two for Indonesian.
GROQ_MODEL = "whisper-large-v3"
MAX_UPLOAD_BYTES = 24_000_000
MAX_CHUNK_SECONDS = 600.0
SNAP_SECONDS = 30.0
MAX_AUDIO_SECONDS = 7200.0
REQUEST_TIMEOUT_SECONDS = 300.0
MAX_RETRY_WAIT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
FFMPEG_TIMEOUT_SECONDS = 900.0
SAMPLE_RATE = 16_000

FALLBACK_REASONS = frozenset(
    {
        "no_key",
        "too_long",
        "too_large",
        "audio_failed",
        "auth",
        "rate_limited",
        "model_unavailable",
        "server_error",
        "http_error",
        "timeout",
        "network",
        "malformed",
        "empty",
    }
)

_KEY_SHAPE = re.compile(r"[\x21-\x7e]{1,4096}")
_ON = frozenset({"1", "true", "yes", "on"})
_OFF = frozenset({"0", "false", "no", "off"})
_SILENCE_START = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")
# Whisper's own rule for a window that is silence rather than speech.
_NO_SPEECH_PROB = 0.6
_NO_SPEECH_LOGPROB = -1.0

# Whisper's language names (openai/whisper tokenizer.py), as the answer's "language" spells them.
_LANGUAGE_NAMES = dict(
    pair.split(":")
    for pair in (  # noqa: SIM905 - one line of data reads better than a hundred
        "english:en chinese:zh german:de spanish:es russian:ru korean:ko french:fr japanese:ja "
        "portuguese:pt turkish:tr polish:pl catalan:ca dutch:nl arabic:ar swedish:sv italian:it "
        "indonesian:id hindi:hi finnish:fi vietnamese:vi hebrew:he ukrainian:uk greek:el malay:ms "
        "czech:cs romanian:ro danish:da hungarian:hu tamil:ta norwegian:no thai:th urdu:ur "
        "croatian:hr bulgarian:bg lithuanian:lt latin:la maori:mi malayalam:ml welsh:cy slovak:sk "
        "telugu:te persian:fa latvian:lv bengali:bn serbian:sr azerbaijani:az slovenian:sl "
        "kannada:kn estonian:et macedonian:mk breton:br basque:eu icelandic:is armenian:hy "
        "nepali:ne mongolian:mn bosnian:bs kazakh:kk albanian:sq swahili:sw galician:gl "
        "marathi:mr punjabi:pa sinhala:si khmer:km shona:sn yoruba:yo somali:so afrikaans:af "
        "occitan:oc georgian:ka belarusian:be tajik:tg sindhi:sd gujarati:gu amharic:am "
        "yiddish:yi lao:lo uzbek:uz faroese:fo haitian_creole:ht pashto:ps turkmen:tk nynorsk:nn "
        "maltese:mt sanskrit:sa luxembourgish:lb myanmar:my tibetan:bo tagalog:tl malagasy:mg "
        "assamese:as tatar:tt hawaiian:haw lingala:ln hausa:ha bashkir:ba javanese:jw "
        "sundanese:su cantonese:yue"
    ).split()
)
_LANGUAGE_CODES = frozenset(_LANGUAGE_NAMES.values())


class GroqTranscriptionError(Exception):
    """Groq could not transcribe this video; ``code`` (one of ``FALLBACK_REASONS``) says why."""

    def __init__(self, code: str) -> None:
        if code not in FALLBACK_REASONS:
            raise ValueError("unknown Groq fallback code")
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class GroqTranscription:
    """What one job needs to call Groq. ``api_key`` is None when the switch is on without a key."""

    api_key: str | None = field(repr=False)
    prompt: str | None = None
    model: str = GROQ_MODEL
    base_url: str = BASE_URL
    timeout: float = REQUEST_TIMEOUT_SECONDS


def groq_from_env(
    env: Mapping[str, str] | None = None, *, prompt: str | None = None
) -> GroqTranscription | None:
    """The Groq settings the worker handed this process, or None when Groq is off.

    A switch that is neither on nor off raises ``ValueError`` (without echoing it); a missing or
    malformed key leaves ``api_key`` None, which the run reports as ``no_key``.
    """
    env = os.environ if env is None else env
    switch = env.get(ENV_SWITCH, "").strip().casefold()
    if not switch or switch in _OFF:
        return None
    if switch not in _ON:
        raise ValueError(f"{ENV_SWITCH} harus on atau off.")
    key = env.get(ENV_API_KEY, "").strip()
    return GroqTranscription(api_key=key if _KEY_SHAPE.fullmatch(key) else None, prompt=prompt)


def language_code(value: object) -> str | None:
    """The ISO code of a Whisper language name or code, or None."""
    if not isinstance(value, str):
        return None
    name = value.strip().casefold().replace(" ", "_")
    if name in _LANGUAGE_CODES:
        return name
    return _LANGUAGE_NAMES.get(name)


# --- answers ------------------------------------------------------------------------------------


def _hallucinated(item: Mapping[str, Any]) -> bool:
    no_speech = _finite(item.get("no_speech_prob"))
    logprob = _finite(item.get("avg_logprob"))
    return (
        no_speech is not None
        and logprob is not None
        and no_speech > _NO_SPEECH_PROB
        and logprob < _NO_SPEECH_LOGPROB
    )


def normalize_groq_response(
    payload: object,
    *,
    offset: float = 0.0,
    end: float | None = None,
    word_timestamps: bool = True,
) -> tuple[list[TranscriptSegment], str | None]:
    """Segments (moved by ``offset`` and kept inside ``[offset, end]``) and the language code."""
    if not isinstance(payload, dict):
        raise GroqTranscriptionError("malformed")
    raw_segments = payload.get("segments")
    if raw_segments is None:
        raw_segments = []
    if not isinstance(raw_segments, list):
        raise GroqTranscriptionError("malformed")
    parsed = []
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        start, stop = _finite(item.get("start")), _finite(item.get("end"))
        text = _clean_text(item.get("text"))
        if start is None or stop is None:
            continue
        parsed.append((offset + start, offset + stop, text, bool(text) and not _hallucinated(item)))
    parsed.sort(key=lambda segment: segment[0])

    raw_words = payload.get("words")
    if word_timestamps and any(keep for *_, keep in parsed) and not isinstance(raw_words, list):
        raise GroqTranscriptionError("malformed")
    buckets: list[list[SimpleNamespace]] = [[] for _ in parsed]
    if word_timestamps and parsed:
        starts = [segment[0] for segment in parsed]
        for item in raw_words or ():
            if not isinstance(item, dict):
                continue
            start, stop = _finite(item.get("start")), _finite(item.get("end"))
            if start is None or stop is None:
                continue
            start, stop = offset + start, offset + stop
            index = max(0, bisect_right(starts, (start + stop) / 2) - 1)
            buckets[index].append(
                SimpleNamespace(word=item.get("word"), start=start, end=stop, probability=None)
            )

    segments: list[TranscriptSegment] = []
    previous_end = offset
    for (raw_start, raw_end, text, keep), words in zip(parsed, buckets):
        if not keep:
            continue
        start = max(raw_start, previous_end, 0.0)
        stop = raw_end if end is None else min(raw_end, end)
        if stop <= start:
            continue
        segments.append(TranscriptSegment(start, stop, text, _normalize_words(words, start, stop)))
        previous_end = stop
    return segments, language_code(payload.get("language"))


# --- chunks -------------------------------------------------------------------------------------


def plan_chunks(
    duration: float,
    silences: Sequence[tuple[float, float]],
    *,
    max_seconds: float = MAX_CHUNK_SECONDS,
    snap_seconds: float = SNAP_SECONDS,
) -> list[tuple[float, float]]:
    """Contiguous ``(start, end)`` parts of at most ``max_seconds + 2 * snap_seconds``; the cuts
    are on whole milliseconds, as FFmpeg is given them."""
    count = max(1, math.ceil(duration / max_seconds))
    if count == 1:
        return [(0.0, duration)]
    step = duration / count
    middles = sorted((start + stop) / 2 for start, stop in silences)
    bounds = [0.0]
    for index in range(1, count):
        nominal = index * step
        near = [m for m in middles if abs(m - nominal) <= snap_seconds and m > bounds[-1]]
        bounds.append(round(min(near, key=lambda m: abs(m - nominal)) if near else nominal, 3))
    bounds.append(duration)
    return list(pairwise(bounds))


# --- FFmpeg ---------------------------------------------------------------------------------------


def _ffmpeg(argv: list[str]) -> str:
    """stderr of a finished FFmpeg run; any failure is ``audio_failed`` (its text stays here)."""
    try:
        done = subprocess.run(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=False,
            text=True,
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        raise GroqTranscriptionError("audio_failed") from None
    if done.returncode != 0:
        raise GroqTranscriptionError("audio_failed")
    return done.stderr


def _flac(ffmpeg: str, source: Path, target: Path, *, start: float = 0.0, length: float = 0.0):
    window = ["-ss", f"{start:.3f}", "-t", f"{length:.3f}"] if length else []
    _ffmpeg(
        [ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-y",
         *window, "-i", str(source), "-map", "0:a:0", "-vn", "-sn", "-dn",
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-sample_fmt", "s16", "-c:a", "flac", str(target)]
    )  # fmt: skip


def _flac_duration(path: Path) -> float:
    """Seconds of audio from the FLAC STREAMINFO block FFmpeg writes."""
    try:
        with path.open("rb") as handle:
            head = handle.read(42)
    except OSError:
        raise GroqTranscriptionError("audio_failed") from None
    if len(head) < 42 or head[:4] != b"fLaC" or head[4] & 0x7F != 0:
        raise GroqTranscriptionError("audio_failed")
    info = head[8:42]
    rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4)
    samples = ((info[13] & 0x0F) << 32) | int.from_bytes(info[14:18], "big")
    if not rate or not samples:
        raise GroqTranscriptionError("audio_failed")
    return samples / rate


def _silences(ffmpeg: str, audio: Path, duration: float) -> list[tuple[float, float]]:
    log = _ffmpeg(
        [ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-i", str(audio),
         "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"]
    )  # fmt: skip
    silences: list[tuple[float, float]] = []
    start: float | None = None
    for line in log.splitlines():
        if (match := _SILENCE_START.search(line)) is not None:
            start = max(0.0, float(match.group(1)))
        elif (match := _SILENCE_END.search(line)) is not None and start is not None:
            silences.append((start, float(match.group(1))))
            start = None
    if start is not None:
        silences.append((start, duration))
    return silences


# --- HTTP -----------------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would send the audio, and the key, to another address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _multipart(fields: list[tuple[str, str]], audio: bytes, filename: str) -> tuple[bytes, str]:
    boundary = f"potongin-{secrets.token_hex(16)}"
    parts = []
    for name, value in fields:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: audio/flac\r\n\r\n".encode()
    )
    parts.extend((audio, f"\r\n--{boundary}--\r\n".encode()))
    return b"".join(parts), boundary


def _retry_after(headers: Any) -> float | None:
    value = _finite(headers.get("retry-after")) if headers is not None else None
    return value if value is not None and value >= 0 else None


def _status_code(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 404:
        return "model_unavailable"
    if status == 413:
        return "too_large"
    if status == 429:
        return "rate_limited"
    return "server_error" if status >= 500 else "http_error"


def _post(config: GroqTranscription, body: bytes, boundary: str) -> tuple[int, Any, bytes]:
    request = urllib.request.Request(
        f"{config.base_url.rstrip('/')}/audio/transcriptions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Accept": "application/json",
            "User-Agent": "potongin",
        },
    )
    try:
        with _OPENER.open(request, timeout=config.timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            return response.status, response.headers, raw
    except urllib.error.HTTPError as error:
        try:
            return error.code, error.headers, b""
        finally:
            error.close()
    except (TimeoutError, urllib.error.URLError, OSError, HTTPException) as error:
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        timed_out = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        raise GroqTranscriptionError("timeout" if timed_out else "network") from None


def request_transcription(
    config: GroqTranscription,
    audio: Path,
    *,
    language: str | None,
    word_timestamps: bool = True,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Groq's ``verbose_json`` answer for one audio file (a dict), or GroqTranscriptionError."""
    if not config.api_key:
        raise GroqTranscriptionError("no_key")
    fields = [("model", config.model), ("response_format", "verbose_json"), ("temperature", "0")]
    if language:
        fields.append(("language", language))
    if config.prompt:
        fields.append(("prompt", config.prompt))
    granularities = ("word", "segment") if word_timestamps else ("segment",)
    fields.extend(("timestamp_granularities[]", value) for value in granularities)
    try:
        data = audio.read_bytes()
    except OSError:
        raise GroqTranscriptionError("audio_failed") from None
    body, boundary = _multipart(fields, data, audio.name)
    for attempt in range(2):
        status, headers, raw = _post(config, body, boundary)
        if status == 429 and attempt == 0:
            wait = _retry_after(headers)
            if wait is not None and wait <= MAX_RETRY_WAIT_SECONDS:
                sleep(wait)
                continue
        break
    if status != 200:
        raise GroqTranscriptionError(_status_code(status))
    if len(raw) > MAX_RESPONSE_BYTES:
        raise GroqTranscriptionError("malformed")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise GroqTranscriptionError("malformed") from None
    if not isinstance(payload, dict):
        raise GroqTranscriptionError("malformed")
    return payload


# --- one run --------------------------------------------------------------------------------------


def transcribe_with_groq(
    source: Path,
    *,
    config: GroqTranscription,
    language: str | None = "id",
    word_timestamps: bool = True,
    media_duration: float | None = None,
    progress_callback: Callable[[float], None] | None = None,
    ffmpeg: str = "ffmpeg",
    max_upload_bytes: int = MAX_UPLOAD_BYTES,
    max_chunk_seconds: float = MAX_CHUNK_SECONDS,
    snap_seconds: float = SNAP_SECONDS,
    temp_root: Path | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> Transcription:
    """``source`` transcribed by Groq (see the module docstring), or GroqTranscriptionError."""
    if not config.api_key:
        raise GroqTranscriptionError("no_key")
    if media_duration is not None and media_duration > MAX_AUDIO_SECONDS:
        raise GroqTranscriptionError("too_long")
    with tempfile.TemporaryDirectory(prefix="potongin-groq-", dir=temp_root) as folder:
        work = Path(folder)
        audio = work / "audio.flac"
        _flac(ffmpeg, Path(source), audio)
        duration = _flac_duration(audio)
        if duration > MAX_AUDIO_SECONDS:
            raise GroqTranscriptionError("too_long")
        if duration <= max_chunk_seconds:
            windows = [(0.0, duration)]
        else:
            silences = _silences(ffmpeg, audio, duration)
            windows = plan_chunks(
                duration, silences, max_seconds=max_chunk_seconds, snap_seconds=snap_seconds
            )

        segments: list[TranscriptSegment] = []
        detected: str | None = None
        for index, (start, stop) in enumerate(windows):
            # Parts are cut one at a time and removed once sent: the folder holds at most two files.
            path = audio if len(windows) == 1 else work / f"part-{index:03d}.flac"
            if path != audio:
                _flac(ffmpeg, audio, path, start=start, length=stop - start)
            try:
                if path.stat().st_size > max_upload_bytes:
                    raise GroqTranscriptionError("too_large")
            except OSError:
                raise GroqTranscriptionError("audio_failed") from None
            payload = request_transcription(
                config, path, language=language, word_timestamps=word_timestamps, sleep=sleep
            )
            if path != audio:
                path.unlink(missing_ok=True)
            found, code = normalize_groq_response(
                payload, offset=start, end=stop, word_timestamps=word_timestamps
            )
            segments.extend(found)
            detected = detected or code
            if progress_callback is not None:
                progress_callback(min(1.0, stop / duration))
    if not segments:
        raise GroqTranscriptionError("empty")
    return Transcription(language or detected or "unknown", segments)
