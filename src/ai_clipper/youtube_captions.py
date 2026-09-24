"""YouTube json3 caption tracks as a fast transcript source that skips Whisper.

YouTube auto-captions (``kind=asr``) in json3 carry a start offset per word, punctuation,
speaker-change flags and sound tags such as ``[tertawa]``. This module turns one track into
the V3 transcript contract (``transcript_io``) plus sound events (``sound_events``).

Parsing rules (:func:`parse_json3`):

- A word starts at ``tStartMs + tOffsetMs``. It ends at the next word, tag or music-marker
  start, capped at 1.2 s, at the caption event end (``tStartMs + dDurationMs``) when present,
  and, for a word with its own ASR offset, at a length estimate of ``0.15 + 0.05 × letters``
  seconds (at least 0.25 s). The length cap is not in the original spec: without it a word
  before a pause absorbed the whole pause (median end error 0.79-0.91 s against Whisper word
  ends on four episodes, 0.16-0.22 s with it), which hid pauses from sentence splitting.
  Parameters were fitted on the two tuning episodes. Every word lasts at least 0.05 s.
- A seg holding several words (manual subtitles hold a whole cue in one seg) is spread over
  its display window in proportion to word length; those words are "untimed".
- ``aAppend`` newline events, zero-width and control characters and music notes are
  dropped; HTML entities are decoded; a punctuation-only token (``.``) joins the previous
  word; a dash-only token is dropped.
- ``[...]`` tags become :class:`SoundEvent` values via ``SoundEvent.from_label`` and never
  words. YouTube's censored-word marker ``[ __ ]`` becomes the word ``***``. Unreadable tags
  (digits, over 40 characters) are counted in ``dropped_tags``.
- ``isSpeakerChange`` flags, and ``-``/``>>`` markers at a manual line start, are reported
  as speaker changes and always start a new segment.
- Rolling repeats are removed: a cue whose first line repeats the previous cue's last line
  (roll-up captions), an identical cue of 3+ words shown while the previous one is still on
  screen, and timed words that repeat already-emitted words back in time. Auto-captions from
  the four evaluation episodes contain none of these, so nothing is removed there.
- Segments break after terminal punctuation, at a gap of 0.8 s or more, at a speaker change
  and after 25 words. Output is chronological: word starts strictly increase (a clash is
  nudged by 1 ms), segments never overlap, and words lie inside their segment.
- Input is strict JSON (no NaN/Infinity, no duplicate keys, valid UTF-8) of at most
  ``MAX_JSON3_BYTES``. Errors raise :class:`CaptionFormatError` and never echo caption text.

Quality (:func:`assess_captions`) reason codes, in this order:

``empty``             no words at all.
``low_coverage``      speech covers less than 60% of the media duration.
``long_gap``          5 minutes or more without captions (including the start and end).
``low_word_rate``     fewer than 60 words per minute of speech.
``high_word_rate``    more than 260 words per minute of speech (duplicated text).
``low_punctuation``   fewer than 30% of segments end in ``.?!``.
``music_dominated``   music markers make up more than 25% of segments plus markers.
``tag_dominated``     sound tags make up more than 20% of words plus tags.
``duration_mismatch`` a word starts more than 5 s after the media ends (another cut).

Choosing a file (:func:`choose_caption_file`). yt-dlp names manual and automatic tracks the
same way (``source.id.json3``) and, when both are requested in one run, silently keeps only
the manual one for a shared language code. The worker therefore downloads them in two
separate subtitle-only runs into ``captions/manual`` and ``captions/auto``; a file counts as
manual only when its parent directory is named ``manual``. Ranking: manual before auto;
manual ``<lang>`` then regional variants (``id-ID``); auto ``<lang>-orig`` (the original ASR,
never a translation) then ``<lang>`` then variants; translated tracks such as ``id-en``
(Indonesian machine-translated from English subtitles) only when nothing else exists. An auto
``id`` track without an ``id-orig`` sibling is YouTube's machine translation of another
language's ASR. The worker still requests auto ``id``; ranking prefers ``id-orig`` whenever
both exist, so such a translation is only used when it is all there is, and then only if it
passes the quality gate below. The pipeline also accepts the legacy code ``in`` when no
``id`` track exists (``choose_caption_file`` itself does not).

Worker recipe, exactly as ``web/scripts/run-job.mjs`` runs it (``buildCaptionDownloads``;
``CAPTION_LANGUAGES`` holds the language lists), with yt-dlp 2026.08.19 or newer (the ``web``
extra). Both runs happen after the video download, never in the same run: without
``--ignore-errors`` a subtitle HTTP error aborts the whole yt-dlp run. Each run is best effort
(a failure or its timeout, ``POTONGIN_CAPTIONS_TIMEOUT_MS``, default 120 s, is only logged)
and gets the downloader environment without LLM keys or dashboard secrets. "No subtitles"
also exits 0 without writing a file, so check for files, not exit codes::

    yt-dlp --no-playlist --js-runtimes node --skip-download --ignore-errors \\
      --write-subs --no-write-auto-subs --sub-langs "id,id-ID,in" --sub-format json3 \\
      --output "<input>/captions/manual/source.%(ext)s" <url>
    yt-dlp --no-playlist --js-runtimes node --skip-download --ignore-errors \\
      --write-auto-subs --no-write-subs --sub-langs "id,id-orig" --sub-format json3 \\
      --output "<input>/captions/auto/source.%(ext)s" <url>

``<input>`` is the attempt's (or legacy job's) ``input`` directory. When at least one non-empty
``.json3`` file landed, the worker passes ``--captions-dir <input>/captions`` to
``ai-clipper --selection-mode v3``; the pipeline only reads that directory, picks the track
with :func:`choose_caption_file`, and falls back to Whisper when the track fails the quality
gate. Standalone, ``python -m ai_clipper.youtube_captions <chosen> --out-dir <dir>
--media-duration <seconds>`` does the same check: exit 0 means ``transcript.json`` is usable
and Whisper can be skipped, exit 1 means the captions failed the quality gate (use Whisper),
exit 2 means invalid input.
"""

from __future__ import annotations

import argparse
import errno
import html
import json
import math
import os
import re
import stat
import sys
import unicodedata
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from numbers import Real
from pathlib import Path

from .models import Transcription, TranscriptSegment, TranscriptWord
from .sound_events import MAX_SOUND_EVENTS, SoundEvent, sort_events, write_sound_events
from .transcript_io import (
    MAX_LANGUAGE_LENGTH,
    MAX_SEGMENTS,
    atomic_write_bytes,
    write_transcript_json,
)
from .transcript_quality import ends_with_terminal_punctuation

SOURCE_NAME = "youtube-json3"
CAPTION_QUALITY_VERSION = "caption-quality-v1"
SPEAKER_CHANGES_VERSION = "speaker-changes-v1"
TRANSCRIPT_RELATIVE_PATH = Path("transcript.json")
SOUND_EVENTS_RELATIVE_PATH = Path("analysis/sound-events.json")
SPEAKER_CHANGES_RELATIVE_PATH = Path("analysis/speaker-changes.json")

MAX_JSON3_BYTES = 32 * 1024 * 1024
MAX_EVENTS = 500_000
MAX_SEGS_PER_EVENT = 1_000
MAX_SEG_CHARS = 10_000
MAX_WORDS = 500_000
MAX_TIME_MS = 86_400_000
MAX_SPEAKER_CHANGES_BYTES = 8 * 1024 * 1024

MAX_WORD_SECONDS = 1.2
MIN_WORD_SECONDS = 0.05
WORD_BASE_SECONDS = 0.15
WORD_SECONDS_PER_LETTER = 0.05
MIN_WORD_ESTIMATE_SECONDS = 0.25
SEGMENT_GAP_SECONDS = 0.8
SEGMENT_MAX_WORDS = 25
ROLL_UP_CONTINUITY_SECONDS = 1.0
REPEAT_MIN_WORDS = 3

MIN_COVERAGE = 0.6
MIN_WORDS_PER_MINUTE = 60.0
MAX_WORDS_PER_MINUTE = 260.0
MIN_PUNCTUATED_RATIO = 0.3
MAX_MUSIC_SHARE = 0.25
MAX_TAG_SHARE = 0.2
LONG_GAP_SECONDS = 300.0
DURATION_TOLERANCE_SECONDS = 5.0
QUALITY_REASONS = (
    "empty",
    "low_coverage",
    "long_gap",
    "low_word_rate",
    "high_word_rate",
    "low_punctuation",
    "music_dominated",
    "tag_dominated",
    "duration_mismatch",
)
_RATIO_DECIMALS = 4

_MAX_WORD_MS = round(MAX_WORD_SECONDS * 1000)
_MIN_WORD_MS = round(MIN_WORD_SECONDS * 1000)
_GAP_MS = round(SEGMENT_GAP_SECONDS * 1000)
_CONTINUITY_MS = round(ROLL_UP_CONTINUITY_SECONDS * 1000)

_REMOVED_CHARACTERS = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064"
    "\u2066-\u2069\ufeff]"
)
_TAG = re.compile(r"\[([^\[\]\n]{0,80})\]")
_MUSIC_NOTES = frozenset("♩♪♫♬\U0001f3b5\U0001f3b6\U0001f3bc")
_ATTACHABLE = frozenset(".,?!;:…\"'“”‘’«»)")
_DASHES = frozenset("-–—")
_LANGUAGE_TAG = re.compile(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*")
_TRANSLATION_SOURCE = re.compile(r"[a-z]{2,3}")


class CaptionFormatError(ValueError):
    """A caption file is not a readable json3 document; never echoes caption text."""


# --------------------------------------------------------------------------- parsing


@dataclass(slots=True)
class _Piece:
    """One token of a caption line: word, tag, music marker, speaker marker or attachment."""

    kind: str  # "word" | "tag" | "music" | "speaker" | "attach"
    text: str
    start: int = 0  # milliseconds
    timed: bool = False
    limit: int | None = None  # caption event end in milliseconds


@dataclass(slots=True)
class _Event:
    start: int
    end: int | None
    lines: list[list[_Piece]]
    rolling: bool  # no per-word offsets: a manual or roll-up cue
    display_end: int = 0


@dataclass(slots=True)
class _Word:
    start: int
    text: str
    timed: bool
    limit: int | None
    speaker: bool
    end: int = 0


@dataclass(slots=True)
class _Counters:
    duplicates: int = 0
    dropped_tags: int = 0


@dataclass(frozen=True, slots=True)
class CaptionTrack:
    """A parsed caption track plus details the plain :func:`parse_json3` tuple leaves out."""

    transcription: Transcription
    events: tuple[SoundEvent, ...]
    speaker_changes: tuple[float, ...] = ()
    timed_word_ratio: float = 0.0  # share of words with their own ASR offset
    duplicates_removed: int = 0  # words removed as rolling repeats
    dropped_tags: int = 0  # [..] tags that are not readable sound labels


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CaptionFormatError("caption file contains a duplicate JSON key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise CaptionFormatError("caption file contains a non-standard JSON number")


def _strict_json(raw: bytes | str, *, limit: int, label: str) -> object:
    if isinstance(raw, bytes):
        if len(raw) > limit:
            raise CaptionFormatError(f"{label} must be at most {limit} bytes")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise CaptionFormatError(f"{label} must contain valid UTF-8") from error
    elif isinstance(raw, str):
        if len(raw.encode("utf-8", "surrogatepass")) > limit:
            raise CaptionFormatError(f"{label} must be at most {limit} bytes")
        text = raw
    else:
        raise TypeError(f"{label} input must be bytes or str")
    text = text.removeprefix("\ufeff")
    try:
        return json.loads(
            text, object_pairs_hook=_reject_duplicate_keys, parse_constant=_reject_constant
        )
    except CaptionFormatError:
        raise
    except (ValueError, RecursionError) as error:
        raise CaptionFormatError(f"{label} must contain valid strict JSON") from error


def _milliseconds(value: object, label: str) -> int:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise CaptionFormatError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= MAX_TIME_MS:
        raise CaptionFormatError(f"{label} must be between 0 and {MAX_TIME_MS} ms")
    return round(number)


def _clean_text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise CaptionFormatError(f"{label} must be a string")
    if len(value) > MAX_SEG_CHARS:
        raise CaptionFormatError(f"{label} must be at most {MAX_SEG_CHARS} characters")
    if any(unicodedata.category(character) == "Cs" for character in value):
        raise CaptionFormatError(f"{label} contains a non-Unicode scalar value")
    text = html.unescape(value).replace("\r\n", "\n").replace("\r", "\n")
    return unicodedata.normalize("NFC", _REMOVED_CHARACTERS.sub("", text))


def _tag_piece(content: str, counters: _Counters) -> _Piece | None:
    compact = "".join(content.split())
    if compact and set(compact) == {"_"}:
        return _Piece("word", "***")
    try:
        SoundEvent.from_label(0.0, content)
    except ValueError:
        counters.dropped_tags += 1
        return None
    return _Piece("tag", content)


def _token_pieces(token: str, line: list[_Piece]) -> list[_Piece]:
    pieces: list[_Piece] = []
    if any(character in _MUSIC_NOTES for character in token):
        pieces.append(_Piece("music", ""))
        token = "".join(character for character in token if character not in _MUSIC_NOTES)
    if token.startswith(">>"):
        pieces.append(_Piece("speaker", ""))
        token = token[2:]
    token = token.replace("[", "").replace("]", "")
    if not token:
        return pieces
    if any(character.isalnum() for character in token):
        pieces.append(_Piece("word", token))
    elif set(token) <= _DASHES:
        if not any(piece.kind in ("word", "attach") for piece in line):
            pieces.append(_Piece("speaker", ""))  # a manual "- " line start
    elif set(token) <= _ATTACHABLE:
        pieces.append(_Piece("attach", token))
    else:
        pieces.append(_Piece("word", token))  # symbols such as "+" or "%"
    return pieces


def _line_pieces(text: str, line: list[_Piece], counters: _Counters) -> None:
    """Append the pieces of one line fragment (no newline inside) to ``line``."""
    position = 0
    for match in [*_TAG.finditer(text), None]:
        chunk = text[position : match.start() if match else len(text)]
        for token in chunk.split():
            line.extend(_token_pieces(token, line))
        if match is None:
            break
        piece = _tag_piece(match.group(1), counters)
        if piece is not None:
            line.append(piece)
        position = match.end()


def _assign_times(pieces: list[_Piece], start: int, window_end: int | None) -> None:
    words = [piece for piece in pieces if piece.kind == "word"]
    if len(words) <= 1:
        for piece in pieces:
            piece.start = start
            piece.timed = piece.kind == "word"
        return
    end = start + len(words) * _MAX_WORD_MS
    if window_end is not None:
        end = min(end, window_end)
    window = max(0, end - start)
    total = sum(len(piece.text) + 1 for piece in words)
    consumed = 0
    for piece in pieces:
        piece.start = start + round(window * consumed / total)
        if piece.kind == "word":
            consumed += len(piece.text) + 1


def _parse_event(raw: object, index: int, counters: _Counters) -> _Event | None:
    label = f"caption event {index}"
    if type(raw) is not dict:
        raise CaptionFormatError(f"{label} must be an object")
    start = _milliseconds(raw["tStartMs"], f"{label} tStartMs") if "tStartMs" in raw else None
    segs = raw.get("segs")
    if segs is None:
        return None  # window and pen definitions
    if raw.get("aAppend"):
        return None  # newline appended to a rolling line
    if type(segs) is not list:
        raise CaptionFormatError(f"{label} segs must be an array")
    if len(segs) > MAX_SEGS_PER_EVENT:
        raise CaptionFormatError(f"{label} has more than {MAX_SEGS_PER_EVENT} segs")
    if start is None:
        raise CaptionFormatError(f"{label} has no tStartMs")
    end = None
    if "dDurationMs" in raw:
        end = start + _milliseconds(raw["dDurationMs"], f"{label} dDurationMs")
        if end > MAX_TIME_MS:
            raise CaptionFormatError(f"{label} ends after {MAX_TIME_MS} ms")

    seg_starts: list[int] = []
    texts: list[str] = []
    speaker_flags: list[bool] = []
    for seg_index, seg in enumerate(segs):
        seg_label = f"{label} seg {seg_index}"
        if type(seg) is not dict:
            raise CaptionFormatError(f"{seg_label} must be an object")
        offset = _milliseconds(seg.get("tOffsetMs", 0), f"{seg_label} tOffsetMs")
        if start + offset > MAX_TIME_MS:
            raise CaptionFormatError(f"{seg_label} starts after {MAX_TIME_MS} ms")
        seg_starts.append(start + offset)
        texts.append(_clean_text(seg.get("utf8", ""), f"{seg_label} utf8"))
        speaker_flags.append(bool(seg.get("isSpeakerChange")))

    lines: list[list[_Piece]] = [[]]
    music_seen = False
    for seg_index, text in enumerate(texts):
        seg_pieces: list[_Piece] = []
        if speaker_flags[seg_index]:
            seg_pieces.append(_Piece("speaker", ""))
            lines[-1].append(seg_pieces[-1])
        for part_index, part in enumerate(text.split("\n")):
            if part_index:
                lines.append([])
            before = len(lines[-1])
            _line_pieces(part, lines[-1], counters)
            seg_pieces.extend(lines[-1][before:])
        for piece in seg_pieces:
            if piece.kind == "music":
                if music_seen:
                    piece.kind = "drop"
                music_seen = True
        following = seg_starts[seg_index + 1] if seg_index + 1 < len(segs) else end
        _assign_times(seg_pieces, seg_starts[seg_index], following)
        for piece in seg_pieces:
            piece.limit = end
    lines = [[piece for piece in line if piece.kind != "drop"] for line in lines]
    lines = [line for line in lines if line]
    if not lines:
        return None
    rolling = not any(type(seg) is dict and "tOffsetMs" in seg for seg in segs)
    last_start = max(piece.start for line in lines for piece in line)
    display_end = end if end is not None else last_start + _CONTINUITY_MS
    return _Event(start, end, lines, rolling, display_end)


def _normalized(text: str) -> str:
    folded = "".join(character for character in text.casefold() if character.isalnum())
    return folded or text


def _line_key(line: Sequence[_Piece]) -> tuple[str, ...]:
    return tuple(_normalized(piece.text) for piece in line if piece.kind == "word")


def _drop_roll_up_line(event: _Event, previous: _Event | None, counters: _Counters) -> None:
    """Drop a first line that repeats the previous cue's last line (roll-up captions)."""
    if previous is None or not event.rolling or not event.lines:
        return
    if event.start > previous.display_end + _CONTINUITY_MS:
        return
    key = _line_key(event.lines[0])
    if not key or key != _line_key(previous.lines[-1]):
        return
    scrolling = len(event.lines) > 1 or len(previous.lines) > 1
    overlapping_repeat = len(key) >= REPEAT_MIN_WORDS and event.start < previous.display_end
    if scrolling or overlapping_repeat:
        counters.duplicates += len(key)
        del event.lines[0]


def _drop_time_regression(
    pieces: list[_Piece], emitted: Sequence[_Word], counters: _Counters
) -> list[_Piece]:
    """Drop leading words that repeat already-emitted words at an earlier or equal time."""
    if not emitted:
        return pieces
    last_start = emitted[-1].start
    lead: list[int] = []  # piece positions of words starting at or before the last word
    for position, piece in enumerate(pieces):
        if piece.kind != "word":
            continue
        if piece.start > last_start:
            break
        lead.append(position)
    if not lead:
        return pieces
    keys = [_normalized(pieces[position].text) for position in lead]
    tail = [_normalized(word.text) for word in emitted[-len(lead) :]]
    for count in range(min(len(lead), len(tail)), 0, -1):
        if tail[-count:] == keys[:count]:
            counters.duplicates += count
            return pieces[lead[count - 1] + 1 :]
    return pieces


def _estimate_ms(text: str) -> int:
    letters = sum(character.isalnum() for character in text)
    seconds = max(MIN_WORD_ESTIMATE_SECONDS, WORD_BASE_SECONDS + WORD_SECONDS_PER_LETTER * letters)
    return round(seconds * 1000)


def _collect(
    events: Iterable[_Event], counters: _Counters
) -> tuple[list[_Word], list[SoundEvent], list[int]]:
    """Flatten events into words, sound events and the times of all timing marks."""
    words: list[_Word] = []
    sounds: list[SoundEvent] = []
    marks: list[tuple[int, int]] = []  # (start, index of the next word) for tags and music
    speaker_pending = False
    previous: _Event | None = None
    for event in events:
        original = _Event(
            event.start, event.end, list(event.lines), event.rolling, event.display_end
        )
        _drop_roll_up_line(event, previous, counters)
        previous = original
        pieces = [piece for line in event.lines for piece in line]
        pieces = _drop_time_regression(pieces, words, counters)
        for piece in pieces:
            if piece.kind == "speaker":
                speaker_pending = True
            elif piece.kind == "attach":
                if words:
                    words[-1].text += piece.text
            elif piece.kind == "word":
                start = piece.start if not words else max(piece.start, words[-1].start + 1)
                words.append(_Word(start, piece.text, piece.timed, piece.limit, speaker_pending))
                speaker_pending = False
                if len(words) > MAX_WORDS:
                    raise CaptionFormatError(f"caption track has more than {MAX_WORDS} words")
            else:
                label = piece.text if piece.kind == "tag" else "musik"
                sounds.append(SoundEvent.from_label(piece.start / 1000, label))
                marks.append((piece.start, len(words)))
                if len(sounds) > MAX_SOUND_EVENTS:
                    raise CaptionFormatError(
                        f"caption track has more than {MAX_SOUND_EVENTS} sound tags"
                    )
    _set_word_ends(words, marks)
    return words, sounds, [word.start for word in words if word.speaker]


def _set_word_ends(words: list[_Word], marks: Sequence[tuple[int, int]]) -> None:
    """``marks`` are ``(start, words emitted so far)`` for tags and music markers."""
    after: dict[int, list[int]] = {}
    for start, emitted in marks:
        if emitted:
            after.setdefault(emitted - 1, []).append(start)
    for index, word in enumerate(words):
        boundaries = [start for start in after.get(index, ()) if start > word.start]
        if index + 1 < len(words):
            boundaries.append(words[index + 1].start)
        end = word.start + _MAX_WORD_MS
        if boundaries:
            end = min(end, *boundaries)
        if word.limit is not None:
            end = min(end, word.limit)
        if word.timed:
            end = min(end, word.start + _estimate_ms(word.text))
        word.end = max(end, word.start + _MIN_WORD_MS)


def _build_segments(words: Sequence[_Word]) -> list[TranscriptSegment]:
    groups: list[list[_Word]] = []
    for word in words:
        if groups:
            current = groups[-1]
            previous = current[-1]
            if not (
                ends_with_terminal_punctuation(previous.text)
                or word.start - previous.end >= _GAP_MS
                or len(current) >= SEGMENT_MAX_WORDS
                or word.speaker
            ):
                current.append(word)
                continue
        groups.append([word])
    if len(groups) > MAX_SEGMENTS:
        raise CaptionFormatError(f"caption track has more than {MAX_SEGMENTS} segments")
    segments: list[TranscriptSegment] = []
    for index, group in enumerate(groups):
        start = group[0].start
        end = group[-1].end
        if index + 1 < len(groups):
            end = min(end, groups[index + 1][0].start)
        items = tuple(
            TranscriptWord(word.start / 1000, min(word.end, end) / 1000, word.text)
            for word in group
        )
        text = " ".join(word.text for word in group)
        segments.append(TranscriptSegment(start / 1000, end / 1000, text, items))
    return segments


def _validate_language(language: object) -> str:
    if not isinstance(language, str):
        raise TypeError("language must be a string")
    if not language.strip() or len(language) > MAX_LANGUAGE_LENGTH:
        raise ValueError("language must be a short non-empty string")
    return language


def parse_json3_track(raw: bytes | str, *, language: str = "id") -> CaptionTrack:
    """Parse a json3 caption document into a :class:`CaptionTrack` (see module docstring)."""
    language = _validate_language(language)
    document = _strict_json(raw, limit=MAX_JSON3_BYTES, label="caption file")
    if type(document) is not dict or type(document.get("events")) is not list:
        raise CaptionFormatError("caption file must be a json3 object with an events array")
    raw_events = document["events"]
    if len(raw_events) > MAX_EVENTS:
        raise CaptionFormatError(f"caption file has more than {MAX_EVENTS} events")
    counters = _Counters()
    parsed = [
        (event.start, index, event)
        for index, raw_event in enumerate(raw_events)
        if (event := _parse_event(raw_event, index, counters)) is not None
    ]
    parsed.sort(key=lambda item: (item[0], item[1]))
    words, sounds, speaker_starts = _collect((event for *_, event in parsed), counters)
    segments = _build_segments(words)
    timed = sum(word.timed for word in words)
    return CaptionTrack(
        transcription=Transcription(language, segments),
        events=sort_events(sounds),
        speaker_changes=tuple(start / 1000 for start in speaker_starts),
        timed_word_ratio=round(timed / len(words), _RATIO_DECIMALS) if words else 0.0,
        duplicates_removed=counters.duplicates,
        dropped_tags=counters.dropped_tags,
    )


def parse_json3(
    raw: bytes | str, *, language: str = "id"
) -> tuple[Transcription, tuple[SoundEvent, ...]]:
    """Parse a YouTube json3 caption document into a transcript and its sound events."""
    track = parse_json3_track(raw, language=language)
    return track.transcription, track.events


# --------------------------------------------------------------------------- quality


def _check_ratio(value: object, name: str) -> None:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be finite and between 0 and 1")


@dataclass(frozen=True, slots=True)
class CaptionQuality:
    """Whether a caption track can replace Whisper; ``reasons`` are stable codes."""

    ok: bool
    coverage: float
    words_per_minute: float
    punctuated_ratio: float
    reasons: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.ok, bool):
            raise TypeError("ok must be a bool")
        _check_ratio(self.coverage, "coverage")
        _check_ratio(self.punctuated_ratio, "punctuated_ratio")
        rate = self.words_per_minute
        if not isinstance(rate, Real) or isinstance(rate, bool):
            raise TypeError("words_per_minute must be a number")
        if not math.isfinite(rate) or rate < 0:
            raise ValueError("words_per_minute must be finite and non-negative")
        if not isinstance(self.reasons, tuple):
            raise TypeError("reasons must be a tuple")
        if any(reason not in QUALITY_REASONS for reason in self.reasons):
            raise ValueError("reasons must be documented caption quality codes")
        if len(set(self.reasons)) != len(self.reasons):
            raise ValueError("reasons must be unique")
        if self.ok != (not self.reasons):
            raise ValueError("ok must be true exactly when there are no reasons")

    def to_dict(self) -> dict[str, object]:
        return {
            "version": CAPTION_QUALITY_VERSION,
            "ok": self.ok,
            "coverage": self.coverage,
            "words_per_minute": self.words_per_minute,
            "punctuated_ratio": self.punctuated_ratio,
            "reasons": list(self.reasons),
        }


def _speech_spans(segments: Sequence[TranscriptSegment]) -> list[tuple[float, float]]:
    spans: list[tuple[float, float]] = []
    for segment in sorted(segments, key=lambda item: item.start):
        if spans and segment.start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], segment.end))
        else:
            spans.append((segment.start, segment.end))
    return spans


def _word_count(segment: TranscriptSegment) -> int:
    return len(segment.words) if segment.words else len(segment.text.split())


def assess_captions(
    transcription: Transcription,
    *,
    media_duration: float | None,
    events: Sequence[SoundEvent] = (),
) -> CaptionQuality:
    """Judge whether a caption track is complete and clean enough to skip Whisper.

    ``media_duration=None`` measures coverage against the caption span (0 to the last
    segment end), which cannot detect captions that stop early.
    """
    if not isinstance(transcription, Transcription):
        raise TypeError("transcription must be a Transcription")
    if media_duration is not None:
        if not isinstance(media_duration, Real) or isinstance(media_duration, bool):
            raise TypeError("media_duration must be a number")
        if not math.isfinite(media_duration) or media_duration <= 0:
            raise ValueError("media_duration must be finite and positive")
    segments = transcription.segments
    words = sum(_word_count(segment) for segment in segments)
    if not segments or not words:
        return CaptionQuality(False, 0.0, 0.0, 0.0, ("empty",))

    spans = _speech_spans(segments)
    span = float(media_duration) if media_duration is not None else spans[-1][1]
    covered = sum(max(0.0, min(end, span) - max(start, 0.0)) for start, end in spans)
    coverage = round(min(1.0, covered / span), _RATIO_DECIMALS) if span > 0 else 0.0
    speech = sum(end - start for start, end in spans)
    rate = round(words * 60.0 / speech, 2) if speech > 0 else 0.0
    punctuated = sum(ends_with_terminal_punctuation(segment.text) for segment in segments)
    punctuated_ratio = round(punctuated / len(segments), _RATIO_DECIMALS)
    edges = [0.0, *(value for spanned in spans for value in spanned), max(span, spans[-1][1])]
    longest_gap = max(edges[index + 1] - edges[index] for index in range(0, len(edges), 2))
    music = sum(event.kind == "music" for event in events)
    tags = len(events) - music
    last_word = max(
        (segment.words[-1].start if segment.words else segment.start) for segment in segments
    )

    found = {
        "low_coverage": coverage < MIN_COVERAGE,
        "long_gap": longest_gap >= LONG_GAP_SECONDS,
        "low_word_rate": rate < MIN_WORDS_PER_MINUTE,
        "high_word_rate": rate > MAX_WORDS_PER_MINUTE,
        "low_punctuation": punctuated_ratio < MIN_PUNCTUATED_RATIO,
        "music_dominated": music / (len(segments) + music) > MAX_MUSIC_SHARE,
        "tag_dominated": tags / (words + tags) > MAX_TAG_SHARE,
        "duration_mismatch": media_duration is not None
        and last_word > media_duration + DURATION_TOLERANCE_SECONDS,
    }
    reasons = tuple(code for code in QUALITY_REASONS if found.get(code))
    return CaptionQuality(not reasons, coverage, rate, punctuated_ratio, reasons)


# --------------------------------------------------------------------------- files

_EXACT, _ORIG, _VARIANT, _TRANSLATION = range(4)
_MANUAL_RANK = {_EXACT: 0, _VARIANT: 1, _ORIG: 2}
_AUTO_RANK = {_ORIG: 0, _EXACT: 1, _VARIANT: 2}


def caption_language_tag(path: str | Path) -> str | None:
    """The yt-dlp language code in ``<name>.<lang>.json3``, or ``None``."""
    name = Path(path).name
    if not name.casefold().endswith(".json3"):
        return None
    stem = name[: -len(".json3")]
    if "." not in stem:
        return None
    tag = stem.rsplit(".", 1)[1]
    return tag if _LANGUAGE_TAG.fullmatch(tag) else None


def _language_form(tag: str, language: str) -> int | None:
    wanted = language.casefold()
    if tag.casefold() == wanted:
        return _EXACT
    if not tag.casefold().startswith(wanted + "-"):
        return None
    rest = tag[len(language) + 1 :]
    if rest.casefold() == "orig":
        return _ORIG
    if _TRANSLATION_SOURCE.fullmatch(rest.split("-", 1)[0]):
        return _TRANSLATION  # yt-dlp names a translated track "<target>-<source>"
    return _VARIANT  # region or script, e.g. id-ID


def choose_caption_file(paths: Iterable[str | Path], *, language: str = "id") -> Path | None:
    """Pick the best ``.json3`` track for ``language`` (ranking in the module docstring)."""
    language = _validate_language(language)
    ranked: list[tuple[tuple[bool, int, int, str], Path]] = []
    for item in paths:
        path = Path(item)
        tag = caption_language_tag(path)
        form = None if tag is None else _language_form(tag, language)
        if form is None:
            continue
        manual = path.parent.name.casefold() == "manual"
        rank = (_MANUAL_RANK if manual else _AUTO_RANK).get(form, 3)
        ranked.append(((form == _TRANSLATION, 0 if manual else 1, rank, str(path)), path))
    return min(ranked)[1] if ranked else None


def _read_bounded(path: Path, limit: int) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except IsADirectoryError:
        raise CaptionFormatError("caption file must be a regular file") from None
    except OSError as error:
        if error.errno == errno.EISDIR:
            raise CaptionFormatError("caption file must be a regular file") from None
        raise
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise CaptionFormatError("caption file must be a regular file")
        if info.st_size > limit:
            raise CaptionFormatError(f"caption file must be at most {limit} bytes")
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(descriptor, min(1024 * 1024, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise CaptionFormatError(f"caption file must be at most {limit} bytes")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _default_language(path: Path) -> str:
    tag = caption_language_tag(path)
    return tag.split("-", 1)[0].casefold() if tag else "id"


def load_caption_track(path: str | Path, *, language: str | None = None) -> CaptionTrack:
    """Read and parse one json3 file; ``language=None`` takes it from the file name."""
    source = Path(path)
    chosen = _default_language(source) if language is None else language
    return parse_json3_track(_read_bounded(source, MAX_JSON3_BYTES), language=chosen)


def load_youtube_captions(
    path: str | Path, *, media_duration: float | None = None, language: str | None = None
) -> tuple[Transcription, tuple[SoundEvent, ...], CaptionQuality]:
    """Read a json3 file and judge it. Missing files raise :class:`FileNotFoundError`."""
    track = load_caption_track(path, language=language)
    quality = assess_captions(
        track.transcription, media_duration=media_duration, events=track.events
    )
    return track.transcription, track.events, quality


def write_speaker_changes(
    path: str | Path, times: Sequence[float], *, source: str = SOURCE_NAME
) -> None:
    """Atomically publish ``analysis/speaker-changes.json`` (strictly increasing seconds)."""
    values = _speaker_times(list(times))
    if not isinstance(source, str) or not source.strip() or len(source) > 64:
        raise ValueError("speaker changes source must be a short string")
    payload = {
        "version": SPEAKER_CHANGES_VERSION,
        "source": source,
        "times": [round(value, 3) for value in values],
    }
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n"
    atomic_write_bytes(path, encoded.encode("utf-8"))


def _speaker_times(values: list[object]) -> tuple[float, ...]:
    if len(values) > MAX_WORDS:
        raise ValueError("too many speaker changes")
    result: list[float] = []
    for value in values:
        if not isinstance(value, Real) or isinstance(value, bool):
            raise TypeError("speaker change times must be numbers")
        number = float(value)
        if not math.isfinite(number) or number < 0:
            raise ValueError("speaker change times must be finite and non-negative")
        if result and number <= result[-1]:
            raise ValueError("speaker change times must be strictly increasing")
        result.append(number)
    return tuple(result)


def read_speaker_changes(path: str | Path) -> tuple[tuple[float, ...], str]:
    """Read ``analysis/speaker-changes.json``; malformed content raises ``ValueError``."""
    try:
        document = _strict_json(
            _read_bounded(Path(path), MAX_SPEAKER_CHANGES_BYTES),
            limit=MAX_SPEAKER_CHANGES_BYTES,
            label="speaker changes",
        )
    except CaptionFormatError as error:
        raise ValueError(str(error)) from None
    if type(document) is not dict or set(document) != {"version", "source", "times"}:
        raise ValueError("speaker changes must contain exactly version, source, times")
    if document["version"] != SPEAKER_CHANGES_VERSION:
        raise ValueError("unsupported speaker changes version")
    source = document["source"]
    if not isinstance(source, str) or not source.strip() or len(source) > 64:
        raise ValueError("speaker changes source must be a short string")
    if type(document["times"]) is not list:
        raise ValueError("speaker change times must be an array")
    return _speaker_times(document["times"]), source


# --------------------------------------------------------------------------- CLI

_KIND_NAMES = {
    "laughter": "tertawa",
    "applause": "tepuk tangan",
    "cheer": "sorakan",
    "shout": "teriakan",
    "gasp": "terkesiap",
    "music": "musik",
    "cough": "batuk/deheman",
    "other": "lainnya",
}


def _number(value: float, decimals: int = 0) -> str:
    text = f"{value:,.{decimals}f}"
    return text.replace(",", "_").replace(".", ",").replace("_", ".")


def _percent(ratio: float) -> str:
    return f"{round(ratio * 100)}%"


def _reason_text(code: str, quality: CaptionQuality) -> str:
    texts = {
        "empty": "tidak ada kata yang terbaca",
        "low_coverage": (
            f"ucapan hanya mencakup {_percent(quality.coverage)} durasi video "
            f"(minimal {_percent(MIN_COVERAGE)})"
        ),
        "long_gap": f"ada bagian ≥ {round(LONG_GAP_SECONDS / 60)} menit tanpa subtitle",
        "low_word_rate": (
            f"terlalu sedikit kata ({_number(quality.words_per_minute)} kata/menit, "
            f"minimal {_number(MIN_WORDS_PER_MINUTE)})"
        ),
        "high_word_rate": (
            f"terlalu banyak kata ({_number(quality.words_per_minute)} kata/menit, "
            f"maksimal {_number(MAX_WORDS_PER_MINUTE)}); kemungkinan teks berulang"
        ),
        "low_punctuation": (
            f"hanya {_percent(quality.punctuated_ratio)} segmen berakhir dengan tanda baca "
            f"(minimal {_percent(MIN_PUNCTUATED_RATIO)})"
        ),
        "music_dominated": "subtitle didominasi penanda musik",
        "tag_dominated": "subtitle didominasi penanda suara, bukan ucapan",
        "duration_mismatch": "subtitle lebih panjang dari video; kemungkinan milik versi lain",
    }
    return texts[code]


def _summary(track: CaptionTrack, quality: CaptionQuality) -> dict[str, object]:
    kinds = Counter(event.kind for event in track.events)
    return {
        "source": SOURCE_NAME,
        "language": track.transcription.language,
        "words": sum(len(segment.words) for segment in track.transcription.segments),
        "segments": len(track.transcription.segments),
        "events": len(track.events),
        "events_by_kind": dict(sorted(kinds.items())),
        "speaker_changes": len(track.speaker_changes),
        "timed_word_ratio": track.timed_word_ratio,
        "duplicates_removed": track.duplicates_removed,
        "dropped_tags": track.dropped_tags,
        "quality": quality.to_dict(),
    }


def _print_summary(track: CaptionTrack, quality: CaptionQuality) -> None:
    kinds = Counter(event.kind for event in track.events)
    detail = ", ".join(f"{_KIND_NAMES[kind]} {count}" for kind, count in kinds.most_common())
    words = sum(len(segment.words) for segment in track.transcription.segments)
    print(
        f"Subtitle YouTube: {_number(words)} kata, "
        f"{_number(len(track.transcription.segments))} segmen, "
        f"{_number(len(track.events))} penanda suara"
        + (f" ({detail})" if detail else "")
        + f", {_number(len(track.speaker_changes))} pergantian pembicara."
    )
    print(
        f"Cakupan ucapan {_percent(quality.coverage)}, "
        f"{_number(quality.words_per_minute)} kata/menit, "
        f"{_percent(quality.punctuated_ratio)} segmen berakhir dengan tanda baca."
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ai_clipper.youtube_captions",
        description=(
            "Ubah subtitle YouTube (json3) menjadi transcript.json dan penanda suara, "
            "tanpa menjalankan Whisper."
        ),
    )
    parser.add_argument("source", type=Path, help="file subtitle .json3 dari yt-dlp")
    parser.add_argument(
        "--out-dir", type=Path, required=True, help="folder job: transcript.json dan analysis/"
    )
    parser.add_argument(
        "--media-duration", type=float, help="durasi video dalam detik, untuk menghitung cakupan"
    )
    parser.add_argument(
        "--language", help="kode bahasa; bawaannya dari nama file (mis. id-orig menjadi id)"
    )
    parser.add_argument("--json", action="store_true", help="cetak ringkasan sebagai JSON")
    args = parser.parse_args(argv)
    duration = args.media_duration
    if duration is not None and not (math.isfinite(duration) and duration > 0):
        print("Durasi video harus berupa angka positif.", file=sys.stderr)
        return 2

    try:
        track = load_caption_track(args.source, language=args.language)
        quality = assess_captions(
            track.transcription, media_duration=args.media_duration, events=track.events
        )
    except FileNotFoundError:
        print("Berkas subtitle tidak ditemukan.", file=sys.stderr)
        return 2
    except (CaptionFormatError, TypeError, ValueError) as error:
        print(f"Subtitle tidak valid: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("Berkas subtitle tidak bisa dibaca.", file=sys.stderr)
        return 2

    summary = _summary(track, quality)
    summary["written"] = quality.ok
    if not quality.ok:
        reasons = "; ".join(_reason_text(code, quality) for code in quality.reasons)
        print(
            f"Subtitle YouTube tidak layak dipakai: {reasons}. Gunakan transkripsi Whisper.",
            file=sys.stderr,
        )
        if args.json:
            print(json.dumps(summary, ensure_ascii=False))
        return 1

    out_dir: Path = args.out_dir
    write_transcript_json(out_dir / TRANSCRIPT_RELATIVE_PATH, track.transcription)
    write_sound_events(out_dir / SOUND_EVENTS_RELATIVE_PATH, track.events, source=SOURCE_NAME)
    write_speaker_changes(out_dir / SPEAKER_CHANGES_RELATIVE_PATH, track.speaker_changes)
    if args.json:
        print(json.dumps(summary, ensure_ascii=False))
    else:
        _print_summary(track, quality)
        print(f"Kualitas: layak dipakai. Ditulis ke {out_dir}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
