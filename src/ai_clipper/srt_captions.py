"""An uploaded ``.srt`` subtitle as the job's transcript, in place of Whisper.

The dashboard lets a person attach one ``.srt`` next to an uploaded video; the job API stores it
as ``input/subtitle.srt`` after checking it the same way (``web/lib/srt.mjs``; both read the
cases in ``tests/fixtures/srt``). The worker passes ``--subtitle-file`` and the V3 pipeline reads
it here:

- At most :data:`MAX_SRT_BYTES`, strict UTF-8 (a BOM is fine), no NUL character.
- Blocks are separated by blank lines. A block is an optional numeric index, a timing line
  ``H:MM:SS,mmm --> H:MM:SS,mmm`` (``.`` also separates milliseconds, fewer than three digits
  are a fraction, position settings after the end time are ignored) and its text lines. A block
  without a timing line continues the text of the cue before it (a stray blank line inside a
  cue); before the first cue it makes the file invalid.
- The end comes after the start and within 24 hours. ``<i>``-style tags and ``{\\an8}``-style
  overrides are removed. A cue's text holds at most 10,000 characters.
- At least one cue keeps some text.

Each cue with text becomes one json3 event without word offsets, exactly what YouTube gives for
manual subtitles, and :func:`youtube_captions.parse_json3_track` turns that into the transcript:
words spread over the cue in proportion to their length, ``[tertawa]`` tags as sound events,
``-`` line starts as speaker changes. Errors raise :class:`SrtFormatError` with a ``code``
(``size``, ``encoding``, ``structure``, ``timing``, ``too_long``, ``empty``) and never echo the
subtitle's text.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .youtube_captions import (
    MAX_SEG_CHARS,
    MAX_TIME_MS,
    CaptionFormatError,
    CaptionTrack,
    _read_bounded,
    parse_json3_track,
)

MAX_SRT_BYTES = 2 * 1024 * 1024
SOURCE_NAME = "srt-upload"

_TIME = r"(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})"
_TIMING = re.compile(rf"^\s*{_TIME}\s*-->\s*{_TIME}(?:\s.*)?$")
_INDEX = re.compile(r"^\s*\d+\s*$")
_BLANK = re.compile(r"\n[ \t]*\n")
_MARKUP = re.compile(r"<[^<>\n]{0,100}>|\{\\[^{}\n]{0,200}\}")

# Words that are common in one language and rare in the other, to tell an English subtitle
# from an Indonesian one when the job asked the engine to detect the language.
# fmt: off
_INDONESIAN = frozenset({
    "yang", "dan", "di", "ini", "itu", "tidak", "ada", "aku", "saya", "kamu", "kita", "ke", "dari",
    "untuk", "dengan", "juga", "sudah", "gak", "nggak", "enggak", "banget", "apa", "kalau", "jadi",
    "karena", "tapi", "bisa", "lagi", "akan", "mau", "sama", "udah", "dia", "mereka",
})
_ENGLISH = frozenset({
    "the", "and", "is", "you", "that", "it", "to", "of", "in", "we", "this", "what", "for", "are",
    "was", "have", "not", "but", "with", "be", "do", "so", "my", "they", "just", "your", "there",
    "know", "like",
})
# fmt: on


class SrtFormatError(CaptionFormatError):
    """The uploaded subtitle is not a readable ``.srt`` file."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class SrtCue:
    start_ms: int
    end_ms: int
    text: str


def _milliseconds(hours: str, minutes: str, seconds: str, fraction: str) -> int:
    return (int(hours) * 3600 + int(minutes) * 60 + int(seconds)) * 1000 + int(
        fraction.ljust(3, "0")
    )


def _clean(lines: Sequence[str]) -> str:
    kept = (" ".join(_MARKUP.sub("", line).split()) for line in lines)
    return "\n".join(line for line in kept if line)


def parse_srt(raw: bytes) -> list[SrtCue]:
    """The cues of an ``.srt`` file in file order (see the module docstring)."""
    if not isinstance(raw, bytes):
        raise TypeError("raw must be bytes")
    if len(raw) > MAX_SRT_BYTES:
        raise SrtFormatError("size", f"subtitle file must be at most {MAX_SRT_BYTES} bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SrtFormatError("encoding", "subtitle file must be UTF-8") from None
    if "\0" in text:
        raise SrtFormatError("encoding", "subtitle file contains a NUL character")
    text = text.removeprefix("﻿").replace("\r\n", "\n").replace("\r", "\n")

    cues: list[SrtCue] = []
    lines_of: list[list[str]] = []
    for number, block in enumerate(_BLANK.split(text.strip()), start=1):
        lines = block.strip("\n").split("\n")
        if not any(line.strip() for line in lines):
            continue
        timing_at = 1 if len(lines) > 1 and _INDEX.match(lines[0]) else 0
        timing = _TIMING.match(lines[timing_at])
        if timing is None:
            if not cues:
                raise SrtFormatError("structure", f"subtitle block {number} has no timing line")
            lines_of[-1].extend(lines)
        else:
            start = _milliseconds(*timing.groups()[:4])
            end = _milliseconds(*timing.groups()[4:])
            if end <= start or end > MAX_TIME_MS:
                raise SrtFormatError("timing", f"subtitle block {number} has an invalid time range")
            cues.append(SrtCue(start, end, ""))
            lines_of.append(lines[timing_at + 1 :])
        cleaned = _clean(lines_of[-1])
        if len(cleaned) > MAX_SEG_CHARS:
            raise SrtFormatError("too_long", f"subtitle block {number} has too much text")
        cues[-1] = SrtCue(cues[-1].start_ms, cues[-1].end_ms, cleaned)
    if not any(cue.text for cue in cues):
        raise SrtFormatError("empty", "subtitle file has no cue with text")
    return cues


def srt_to_json3(cues: Sequence[SrtCue]) -> dict[str, object]:
    """The cues with text as a json3 document of manual-subtitle events."""
    return {
        "events": [
            {
                "tStartMs": cue.start_ms,
                "dDurationMs": cue.end_ms - cue.start_ms,
                "segs": [{"utf8": cue.text}],
            }
            for cue in cues
            if cue.text
        ]
    }


def guess_language(text: str) -> str:
    """``en`` when English function words clearly outnumber Indonesian ones, else ``id``."""
    words = re.findall(r"[a-z']+", text.casefold())
    english = sum(word in _ENGLISH for word in words)
    indonesian = sum(word in _INDONESIAN for word in words)
    return "en" if english >= 3 and english > 2 * indonesian else "id"


def load_srt_track(path: str | Path, *, language: str | None) -> CaptionTrack:
    """Read and parse an uploaded ``.srt``; ``language=None`` guesses ``id`` or ``en``."""
    try:
        raw = _read_bounded(Path(path), MAX_SRT_BYTES)
    except SrtFormatError:
        raise
    except CaptionFormatError as error:
        code = "size" if "bytes" in str(error) else "structure"
        raise SrtFormatError(code, str(error).replace("caption", "subtitle")) from None
    cues = parse_srt(raw)
    if language is None:
        language = guess_language(" ".join(cue.text for cue in cues))
    document = json.dumps(srt_to_json3(cues), ensure_ascii=False)
    return parse_json3_track(document, language=language)
