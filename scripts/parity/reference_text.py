#!/usr/bin/env python3
"""Text-parity fixtures and FFmpeg references (plan §10.1 P-TIME/P-TXT/P-ENC/P-COLOR, §11.1 T1.2b).

Writes everything the browser harness (``web/app/parity-harness``) and the scoring scripts
(``compare.py``, ``enc_check.py``, ``s_color.py``) need, into one directory:

* ``ass/<clip>.ass``: the ASS samples. Classic, karaoke and the hook come from today's
  ``captions_ass.build_ass`` with frame-safe times; Bold and Box are hand-written from plan §5.4
  until T1.2a's ``build_ass_v2`` lands (same style numbers as its pack files), including the
  pack variants of the spike (DejaVu Sans Bold instead of Montserrat ExtraBold; a ``\\p``
  vector box instead of ``BorderStyle 3``), a fallback-glyph sample and a P-COLOR swatch sheet.
* the P-TIME timing fixtures (one per document frame rate): five lanes of events whose edges
  sit on chosen frames, hazard frames included (JASSUB side of P-TIME).
* ``plate/<name>.mkv``: the lossless plate (a ``fit_blur`` layout of ``testsrc2``, or a flat
  colour for P-COLOR), ``bg/<plate>/<fmt>/<n>.png`` the plate frame n in each S-COLOR candidate
  format converted to RGB, ``ref/<clip>/<fmt>/<n>.png`` the FFmpeg composite of the same frame
  (the P-TXT reference: text composited in the candidate format, before the final 4:2:0 step,
  converted to RGB with the BT.709 matrix).
* ``export/<clip>/<fmt>.mp4``: the delivered file of each candidate (R5 final step + R7 encode)
  and ``lossless/<clip>/<fmt>.mkv`` the RGB composite of every frame (the P-ENC reference).
* ``fonts/`` (the font files, byte for byte), ``fonts.conf`` (fontconfig lockdown: only these
  files, DejaVu Sans the only fallback, as T1.2a's ``resources/fontconfig/fonts.conf``) and
  ``manifest.json``.

FFmpeg references are made inside the reference image (FFmpeg 5.1.9, libass 0.17.1)::

    docker run --rm --user 1000:1000 -v "$PWD":/w -v "$OUT":/out -w /w -e PYTHONPATH=/w/src \\
      ai-video-clipper:editor-ref /app/.venv/bin/python scripts/parity/reference_text.py \\
      --out /out/fixtures --fonts /out/fonts-in

Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compare
from compare import Box

from ai_clipper import captions_ass
from ai_clipper.edit_v2.timemap import Fps, now_ms, safe_cs
from ai_clipper.subtitles import CaptionCue, CaptionWord

SCHEMA = "potongin.parity-text/1"
WIDTH, HEIGHT = 720, 1280
PTXT_FPS = Fps(30000, 1001)
TIMING_FPS = (Fps(24, 1), Fps(25, 1), Fps(30, 1), Fps(24000, 1001), Fps(30000, 1001))
PACKS = ("classic", "karaoke", "bold", "box")
LENGTHS = (10, 40, 90)
CANDIDATES = ("yuv420p", "yuv444p", "gbrp")
PROBES_PER_CLIP = 5
PROBE_MARGIN = 3  # probe frames stay this many frames away from every edge
REGION_PAD = 16

SAMPLE_TEXTS = {
    10: "Halo semua",
    40: "Kopi pagi ini WAJIB diminum, kata Ayahku",
    90: "Ternyata AVATAR dibuat 12 tahun, dan sutradaranya bilang: jangan pernah menyerah ya kawan.",
}
HOOK_TEXT = "Dia ditahan security di film-nya sendiri"
FALLBACK_TEXT = "Suka {} banget"
# Characters DejaVu Sans has and a pack font may lack, in order of preference.
FALLBACK_CANDIDATES = "♥★♪→Ω"

MONTSERRAT = "Montserrat ExtraBold"
MONTSERRAT_FILE = "Montserrat-ExtraBold.ttf"
DEJAVU = "DejaVu Sans"
DEJAVU_FILE = "DejaVuSans.ttf"
DEJAVU_BOLD_FILE = "DejaVuSans-Bold.ttf"
HIGHLIGHT = "#FFE14D"
SWATCHES = ("#FFE14D", "#FFFFFF", "#3DF5A6", "#52C7FF", "#FF5C8A", "#FF9F1C")
FLAT_PLATE_RGB = (60, 110, 140)

# Plan §5.4 numbers at 720×1280 (T1.2a pack files resources/caption-packs/*/v1.json).
_BASE_SIZE = Fraction(12, 288) * HEIGHT  # today's caption size, 53.33
BOLD_SIZE = round(_BASE_SIZE * Fraction(135, 100))  # 72
BOX_SIZE = round(_BASE_SIZE * Fraction(120, 100))  # 64
BOLD_OUTLINE = round(HEIGHT / 90, 2)  # 14.22
BOX_PADDING = round(HEIGHT / 100, 2)  # 12.8
MARGIN_SIDE = round(WIDTH * 0.06)  # 43
MARGIN_V = HEIGHT - round(HEIGHT * 83000 / 100000)  # 218: bottom of the block at y_e5 = 83%
BOX_ALPHA = 0x40  # black at 75% opacity (defect #1 fix: alpha on OutlineColour)
BOX_MAX_WIDTH = WIDTH * 88 // 100
WORDS_PER_CUE = {"classic": 4, "karaoke": 4, "bold": 3, "box": 3}

_STYLE_FORMAT = ("Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,"
                 "BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,"
                 "BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding")
_EVENT_FORMAT = "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"

# S-COLOR (plan §5.2 R5): YUV ↔ RGB conversions pinned to BT.709, limited range.
DECODE_709 = ("scale=in_color_matrix=bt709:in_range=tv:"
              "flags=accurate_rnd+full_chroma_int+bitexact")
FINAL_GRAPH = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"


# --- small helpers ------------------------------------------------------------------------------


def ass_time(cs: int) -> str:
    """ASS ``H:MM:SS.cc`` for a centisecond count (negative values clamp to 0)."""
    cs = max(0, int(cs))
    hours, rest = divmod(cs, 360_000)
    minutes, rest = divmod(rest, 6_000)
    seconds, fraction = divmod(rest, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"


def ass_color(rgb: str, alpha: int = 0) -> str:
    """``#RRGGBB`` (or ``RRGGBB``) → style colour ``&HAABBGGRR``."""
    value = rgb.lstrip("#").upper()
    return f"&H{alpha:02X}{value[4:6]}{value[2:4]}{value[0:2]}"


def tag_color(rgb: str) -> str:
    """``#RRGGBB`` → override-tag colour ``&HBBGGRR&``."""
    value = rgb.lstrip("#").upper()
    return f"&H{value[4:6]}{value[2:4]}{value[0:2]}&"


def _number(value: float) -> str:
    return f"{round(value, 2):g}"


def _style(name: str, *, font: str, size: int, primary: str = "&H00FFFFFF",
           secondary: str = "&H00FFFFFF", outline_color: str = "&H00000000",
           back_color: str = "&H00000000", bold: bool = False, border_style: int = 1,
           outline: float = 0, shadow: float = 0, alignment: int = 2,
           margin_side: int = MARGIN_SIDE, margin_v: int = MARGIN_V) -> str:
    return (f"Style: {name},{font},{size},{primary},{secondary},{outline_color},{back_color},"
            f"{-1 if bold else 0},0,0,0,100,100,0,0,{border_style},{_number(outline)},"
            f"{_number(shadow)},{alignment},{margin_side},{margin_side},{margin_v},1")


def _document(styles: Iterable[str], events: Iterable[str]) -> str:
    events = list(events)
    return ("[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n"
            f"YCbCr Matrix: None\nPlayResX: {WIDTH}\nPlayResY: {HEIGHT}\n\n[V4+ Styles]\n"
            f"{_STYLE_FORMAT}\n" + "\n".join(styles) + "\n\n[Events]\n"
            f"{_EVENT_FORMAT}\n" + "\n".join(events) + ("\n" if events else ""))


def _dialogue(layer: int, start_cs: int, end_cs: int, style: str, text: str) -> str:
    return f"Dialogue: {layer},{ass_time(start_cs)},{ass_time(end_cs)},{style},,0,0,0,,{text}"


def _cs(frame: int, fps: Fps) -> int:
    """Frame-safe centisecond of "visible from ``frame``" (``safe_cs``, clamped at 0)."""
    return max(0, safe_cs(frame, fps))


def frame_of_ms(ms: int, fps: Fps) -> int:
    """First frame whose ``now_ms`` is at least ``ms``."""
    frame = max(0, ms * fps.num // (1000 * fps.den) - 1)
    while now_ms(frame, fps) < ms:
        frame += 1
    return frame


# --- words and cues -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Word:
    text: str
    f0: int
    f1: int


@dataclass(frozen=True)
class Cue:
    words: tuple[Word, ...]
    f0: int
    f1: int

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)


def sample_words(text: str, *, fps: Fps, start_f: int) -> list[Word]:
    """Words of ``text`` back to back from ``start_f``; a word lasts ``9 + len`` frames."""
    del fps  # frame-based timing: the same frames at every rate
    words, frame = [], start_f
    for token in text.split():
        length = 9 + len(token)
        words.append(Word(token, frame, frame + length))
        frame += length
    return words


def group_cues(words: Sequence[Word], *, pack: str,
               measure: Callable[[str], float] | None = None) -> list[Cue]:
    """Cues of at most the pack's words; ``box`` cues are also split to one line ≤ 88% of W."""
    limit = WORDS_PER_CUE[pack]
    groups: list[list[Word]] = []
    for word in words:
        current = groups[-1] if groups else None
        fits = current is not None and len(current) < limit
        if fits and pack == "box" and measure is not None:
            fits = measure(" ".join(w.text for w in [*current, word])) <= BOX_MAX_WIDTH
        if fits:
            current.append(word)
        else:
            groups.append([word])
    cues = []
    for index, group in enumerate(groups):
        end = group[-1].f1
        if index + 1 < len(groups):
            end = min(max(end, group[0].f0 + 10), groups[index + 1][0].f0)
        cues.append(Cue(tuple(group), group[0].f0, end))
    return cues


# --- fonts --------------------------------------------------------------------------------------


def _sfnt_tables(data: bytes) -> dict[str, tuple[int, int]]:
    if len(data) < 12 or data[:4] not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
        raise ValueError("not a TrueType/OpenType font")
    (count,) = struct.unpack_from(">H", data, 4)
    tables = {}
    for index in range(count):
        tag, _checksum, offset, length = struct.unpack_from(">4sIII", data, 12 + 16 * index)
        tables[tag.decode("latin-1")] = (offset, length)
    return tables


def _cmap(data: bytes) -> dict[int, int]:
    tables = _sfnt_tables(data)
    if "cmap" not in tables:
        raise ValueError("font has no cmap")
    base = tables["cmap"][0]
    (count,) = struct.unpack_from(">H", data, base + 2)
    subtables: dict[int, int] = {}
    for index in range(count):
        platform, encoding, offset = struct.unpack_from(">HHI", data, base + 4 + 8 * index)
        if platform == 0 or (platform == 3 and encoding in (1, 10)):
            (form,) = struct.unpack_from(">H", data, base + offset)
            subtables.setdefault(form, base + offset)
    mapping: dict[int, int] = {}
    if 12 in subtables:
        offset = subtables[12]
        (groups,) = struct.unpack_from(">I", data, offset + 12)
        for index in range(groups):
            first, last, glyph = struct.unpack_from(">III", data, offset + 16 + 12 * index)
            for code in range(first, min(last, 0x10FFFF) + 1):
                if glyph + code - first:
                    mapping[code] = glyph + code - first
        return mapping
    if 4 not in subtables:
        raise ValueError("font has no Unicode cmap (format 4 or 12)")
    offset = subtables[4]
    segments = struct.unpack_from(">H", data, offset + 6)[0] // 2
    ends = struct.unpack_from(f">{segments}H", data, offset + 14)
    starts = struct.unpack_from(f">{segments}H", data, offset + 16 + 2 * segments)
    deltas = struct.unpack_from(f">{segments}h", data, offset + 16 + 4 * segments)
    range_base = offset + 16 + 6 * segments
    range_offsets = struct.unpack_from(f">{segments}H", data, range_base)
    for index in range(segments):
        for code in range(starts[index], ends[index] + 1):
            if code == 0xFFFF:
                continue
            if range_offsets[index] == 0:
                glyph = (code + deltas[index]) & 0xFFFF
            else:
                address = range_base + 2 * index + range_offsets[index] + 2 * (code - starts[index])
                (glyph,) = struct.unpack_from(">H", data, address)
                glyph = (glyph + deltas[index]) & 0xFFFF if glyph else 0
            if glyph:
                mapping[code] = glyph
    return mapping


def cmap_codepoints(data: bytes) -> frozenset[int]:
    """Code points the font maps to a glyph (Unicode ``cmap`` format 4 or 12)."""
    return frozenset(_cmap(data))


def choose_fallback_char(primary: frozenset[int], fallback: frozenset[int]) -> str:
    """The first candidate the fallback font has and the primary font lacks."""
    for char in FALLBACK_CANDIDATES:
        if ord(char) in fallback and ord(char) not in primary:
            return char
    raise ValueError("no fallback-glyph candidate: the primary font covers them all")


def text_measure(data: bytes, size: float) -> Callable[[str], float]:
    """Advance width in pixels at ``size`` as libass lays it out (no kerning): a font of size S
    maps ``usWinAscent + usWinDescent`` to S pixels."""
    tables = _sfnt_tables(data)
    cmap = _cmap(data)
    hhea = tables["hhea"][0]
    ascender, descender = struct.unpack_from(">hh", data, hhea + 4)
    (metrics,) = struct.unpack_from(">H", data, hhea + 34)
    hmtx = tables["hmtx"][0]
    advances = [struct.unpack_from(">H", data, hmtx + 4 * i)[0] for i in range(metrics)]
    height = ascender - descender
    if "OS/2" in tables and tables["OS/2"][1] >= 78:
        win_ascent, win_descent = struct.unpack_from(">HH", data, tables["OS/2"][0] + 74)
        if win_ascent + win_descent:
            height = win_ascent + win_descent

    def measure(text: str) -> float:
        units = 0
        for char in text:
            glyph = cmap.get(ord(char), 0)
            units += advances[min(glyph, len(advances) - 1)]
        return units * size / height

    return measure


def _estimate_measure(size: float) -> Callable[[str], float]:
    """Font-free fallback: today's hook width estimate (DejaVu Sans Bold metrics, +4%)."""
    return lambda text: captions_ass.estimate_text_width(text, size)


# --- ASS samples --------------------------------------------------------------------------------


def _legacy_cues(cues: Sequence[Cue], fps: Fps) -> list[CaptionCue]:
    result = []
    for cue in cues:
        start = _cs(cue.f0, fps) / 100
        end = _cs(cue.f1, fps) / 100
        words = tuple(CaptionWord(max(start, _cs(w.f0, fps) / 100),
                                  min(end, _cs(w.f1, fps) / 100), w.text) for w in cue.words)
        result.append(CaptionCue(start, end, words))
    return result


def legacy_ass(cues: Sequence[Cue], *, fps: Fps, style: str, total_frames: int) -> str:
    """Classic or karaoke captions from today's ``captions_ass.build_ass`` (frame-safe times)."""
    return captions_ass.build_ass(_legacy_cues(cues, fps), width=WIDTH, height=HEIGHT,
                                  duration=_cs(total_frames, fps) / 100, caption_style=style)


def hook_ass(text: str, *, fps: Fps, total_frames: int) -> str:
    """Today's hook (``legacy-bar@1``): boxed lines, ``\\fad(150,250)``, from 0 to the end."""
    duration = _cs(total_frames, fps) / 100
    return captions_ass.build_ass([], width=WIDTH, height=HEIGHT, duration=duration,
                                  hook_text=text, hook_duration=duration)


def bold_ass(cues: Sequence[Cue], *, fps: Fps, family: str) -> str:
    """Bold pack sample: one event per word window with the whole cue in each, UPPERCASE; only
    the ``\\1c`` of the active word differs, so the glyphs never reflow (plan §5.4)."""
    style = _style("Bold", font=family, size=BOLD_SIZE, outline=BOLD_OUTLINE, shadow=0)
    events = []
    for cue in cues:
        for index, word in enumerate(cue.words):
            end = cue.words[index + 1].f0 if index + 1 < len(cue.words) else cue.f1
            parts = [f"{{\\1c{tag_color(HIGHLIGHT if k == index else '#FFFFFF')}}}"
                     f"{captions_ass.ass_escape(w.text.upper())}" for k, w in enumerate(cue.words)]
            events.append(_dialogue(0, _cs(word.f0, fps), _cs(end, fps), "Bold", " ".join(parts)))
    return _document([style], events)


def box_ass(cues: Sequence[Cue], *, fps: Fps, family: str, variant: str = "border3",
            measure: Callable[[str], float] | None = None) -> str:
    """Box pack sample: white text on a black box at 75% opacity, one line per cue.

    ``border3`` draws the box with libass ``BorderStyle 3`` (padding = outline = H/100).
    ``pbox`` draws the same box as a ``\\p1`` vector rectangle on layer 0 under the text
    (layer 1), sized from the font's advances, for the case where ``BorderStyle 3`` fails P-TXT.
    """
    if variant not in ("border3", "pbox"):
        raise ValueError(f"unknown box variant {variant!r}")
    if variant == "border3":
        style = _style("Box", font=family, size=BOX_SIZE, outline_color=ass_color("#000000",
                       BOX_ALPHA), back_color=ass_color("#000000", BOX_ALPHA), border_style=3,
                       outline=BOX_PADDING, shadow=0)
        events = [_dialogue(0, _cs(c.f0, fps), _cs(c.f1, fps), "Box",
                            "{\\q2}" + captions_ass.ass_escape(c.text)) for c in cues]
        return _document([style], events)
    measure = measure or _estimate_measure(BOX_SIZE)
    style = _style("Box", font=family, size=BOX_SIZE, border_style=1, outline=0, shadow=0)
    bottom = HEIGHT - MARGIN_V
    events = []
    for cue in cues:
        width = measure(cue.text)
        x0 = round(WIDTH / 2 - width / 2 - BOX_PADDING)
        x1 = round(WIDTH / 2 + width / 2 + BOX_PADDING)
        y0 = round(bottom - BOX_SIZE - BOX_PADDING)
        y1 = round(bottom + BOX_PADDING)
        drawing = (f"{{\\an7\\pos({x0},{y0})\\bord0\\shad0\\1c&H000000&\\1a&H{BOX_ALPHA:02X}&"
                   f"\\p1}}m 0 0 l {x1 - x0} 0 {x1 - x0} {y1 - y0} 0 {y1 - y0}{{\\p0}}")
        start, end = _cs(cue.f0, fps), _cs(cue.f1, fps)
        events.append(_dialogue(0, start, end, "Box", drawing))
        events.append(_dialogue(1, start, end, "Box", "{\\q2}" + captions_ass.ass_escape(cue.text)))
    return _document([style], events)


def fallback_ass(char: str, *, fps: Fps, start_f: int, end_f: int) -> str:
    """A Bold-pack line whose middle character only the fallback font (DejaVu Sans) has."""
    style = _style("Bold", font=MONTSERRAT, size=BOLD_SIZE, outline=BOLD_OUTLINE, shadow=0)
    text = captions_ass.ass_escape(FALLBACK_TEXT.format(char).upper())
    return _document([style], [_dialogue(0, _cs(start_f, fps), _cs(end_f, fps), "Bold", text)])


def pcolor_ass(*, fps: Fps, total_frames: int) -> str:
    """P-COLOR sheet: one Bold-pack word per swatch colour plus a Box-pack line (box fill)."""
    styles = [
        _style("Bold", font=MONTSERRAT, size=BOLD_SIZE, outline=BOLD_OUTLINE, shadow=0),
        _style("Box", font=MONTSERRAT, size=BOX_SIZE, outline_color=ass_color("#000000", BOX_ALPHA),
               back_color=ass_color("#000000", BOX_ALPHA), border_style=3, outline=BOX_PADDING),
    ]
    end = _cs(total_frames, fps)
    events = [_dialogue(0, 0, end, "Bold",
                        f"{{\\an5\\pos({WIDTH // 2},{150 + 125 * i})\\1c{tag_color(color)}}}HEBAT")
              for i, color in enumerate(SWATCHES)]
    events.append(_dialogue(0, 0, end, "Box", f"{{\\an5\\pos({WIDTH // 2},1000)}}KOTAK"))
    return _document(styles, events)


# --- P-TIME timing fixture ----------------------------------------------------------------------


def hazard_frames(fps: Fps, *, stop: int) -> list[int]:
    """Frames in ``[1, stop)`` where FFmpeg's double ``now_ms`` falls below the exact floor."""
    result = []
    for n in range(1, stop):
        exact_floor = n * 1000 * fps.den // fps.num
        value = now_ms(n, fps)
        if value != exact_floor and value < Fraction(n * 1000 * fps.den, fps.num):
            result.append(n)
    return result


TIMING_LANES = {
    # colours are RRGGBB of the libass images (fill only: no outline, no shadow)
    "start": {"colors": ["FF3030"], "fade": False, "y": 120},
    "end": {"colors": ["30FF30"], "fade": False, "y": 330},
    "karaoke": {"colors": ["3060FF", "FFD020"], "fade": False, "y": 540},  # sung, unsung
    "active_word": {"colors": ["E040E0", "20E0E0"], "fade": False, "y": 750},  # base, active
    "hook": {"colors": ["F0F0F0", "707070"], "fade": True, "y": 960},  # text, box
}
_HAZARD_SEARCH = 20_000
_HAZARDS_PER_KIND = 3
_REGULAR = (10, 23, 37, 52, 68)
_MAIN_KIND = {"start": "start", "end": "end", "karaoke": "karaoke",
              "active_word": "active_word", "hook": "hook_start"}


def _spaced(preferred: Iterable[int], extra: Iterable[int], gap: int) -> list[int]:
    chosen: list[int] = []
    for frame in [*preferred, *extra]:
        if frame >= gap and all(abs(frame - other) >= gap for other in chosen):
            chosen.append(frame)
    return sorted(chosen)


def timing_ass(fps: Fps) -> tuple[str, dict, list[dict]]:
    """The P-TIME fixture for ``fps``: ``(ass, lanes, transitions)``.

    Every lane changes its libass output only on its transition frames, which are ≥ 3 frames
    apart, so the harness can check that frame ``t`` differs from ``t − 1`` while ``t − 2 =
    t − 1`` and ``t = t + 1``. Hazard frames (``hazard_frames``) are spread over the kinds.
    """
    hazards = hazard_frames(fps, stop=_HAZARD_SEARCH)[: _HAZARDS_PER_KIND * len(_MAIN_KIND)]
    by_lane: dict[str, list[int]] = {lane: [] for lane in TIMING_LANES}
    for index, frame in enumerate(hazards):
        by_lane[list(TIMING_LANES)[index % len(TIMING_LANES)]].append(frame)
    styles = [
        _style("T", font=DEJAVU, size=36, alignment=5, margin_side=0, margin_v=0),
        _style("TH", font=DEJAVU, size=36, bold=True, primary=ass_color("#F0F0F0"),
               outline_color=ass_color("#707070", 0x59), back_color=ass_color("#707070", 0x59),
               border_style=3, outline=8, alignment=5, margin_side=0, margin_v=0),
    ]
    events: list[str] = []
    transitions: list[tuple[str, int, str]] = []

    def pos(lane: str, index: int) -> str:
        return f"\\an5\\pos({60 + 55 * (index % 12)},{TIMING_LANES[lane]['y'] + 50 * (index // 12)})"

    # start: events appear one by one, all disappear together.
    starts = _spaced(by_lane["start"], _REGULAR, 3)
    end = starts[-1] + 9
    color = tag_color(TIMING_LANES["start"]["colors"][0])
    for i, frame in enumerate(starts):
        events.append(_dialogue(0, _cs(frame, fps), _cs(end, fps), "T",
                                f"{{{pos('start', i)}\\1c{color}}}S{i}"))
        transitions.append(("start", frame, "start"))
    transitions.append(("start", end, "end"))
    # end: events appear together, disappear one by one.
    ends = _spaced(by_lane["end"], _REGULAR, 3)
    first = min(3, ends[0] - 3)
    color = tag_color(TIMING_LANES["end"]["colors"][0])
    transitions.append(("end", first, "start"))
    for i, frame in enumerate(ends):
        events.append(_dialogue(0, _cs(first, fps), _cs(frame, fps), "T",
                                f"{{{pos('end', i)}\\1c{color}}}E{i}"))
        transitions.append(("end", frame, "end"))
    # karaoke: one event, a \k step per syllable onset.
    onsets = _spaced(by_lane["karaoke"], _REGULAR, 3)
    first, last = min(3, onsets[0] - 3), onsets[-1] + 9
    sung, unsung = TIMING_LANES["karaoke"]["colors"]
    boundaries = [_cs(first, fps), *(_cs(f, fps) for f in onsets), _cs(last, fps)]
    syllables = "".join(f"{{\\k{b - a}}}K{i} "
                        for i, (a, b) in enumerate(pairwise(boundaries)))
    events.append(_dialogue(0, boundaries[0], boundaries[-1], "T",
                            f"{{\\an5\\pos({WIDTH // 2},{TIMING_LANES['karaoke']['y']})"
                            f"\\1c{tag_color(sung)}\\2c{tag_color(unsung)}}}{syllables.strip()}"))
    transitions += [("karaoke", first, "start"), *(("karaoke", f, "karaoke") for f in onsets),
                    ("karaoke", last, "end")]
    # active word: one event per word window, only the active word's colour differs.
    switches = _spaced(by_lane["active_word"], _REGULAR, 3)
    first, last = min(3, switches[0] - 3), switches[-1] + 9
    base, active = TIMING_LANES["active_word"]["colors"]
    windows = [first, *switches, last]
    for index, (a, b) in enumerate(pairwise(windows)):
        words = " ".join(f"{{\\1c{tag_color(active if k == index else base)}}}W{k}"
                         for k in range(len(windows) - 1))
        events.append(_dialogue(0, _cs(a, fps), _cs(b, fps), "T",
                                f"{{\\an5\\pos({WIDTH // 2},{TIMING_LANES['active_word']['y']})}}"
                                f"{words}"))
    transitions += [("active_word", first, "start"),
                    *(("active_word", f, "active_word") for f in switches),
                    ("active_word", last, "end")]
    # hook: separate boxed events with \fad(150,250); fading lanes are checked for presence.
    hook_starts = _spaced(by_lane["hook"], _REGULAR, 3)
    kept: list[int] = []
    for frame in hook_starts:
        if not kept or frame >= kept[-1] + 6 + 3:
            kept.append(frame)
    for i, frame in enumerate(kept):
        events.append(_dialogue(1, _cs(frame, fps), _cs(frame + 6, fps), "TH",
                                f"{{\\fad(150,250)\\an5\\pos({WIDTH // 2},"
                                f"{TIMING_LANES['hook']['y']})}}HOOK {i}"))
        transitions += [("hook", frame, "hook_start"), ("hook", frame + 6, "hook_end")]
    hazard_set = set(hazard_frames(fps, stop=max(f for _, f, _ in transitions) + 1))
    result = [{"lane": lane, "frame": frame, "kind": kind, "hazard": frame in hazard_set}
              for lane, frame, kind in sorted(transitions, key=lambda t: (t[1], t[0]))]
    lanes = {name: {"colors": list(spec["colors"]), "fade": spec["fade"]}
             for name, spec in TIMING_LANES.items()}
    return _document(styles, events), lanes, result


# --- the clip matrix ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Clip:
    id: str
    kind: str  # "ptxt" | "pcolor" | "ptime"
    pack: str
    chars: int
    variant: str | None
    fps: tuple[int, int]
    total_frames: int
    probe_frames: tuple[int, ...]
    edges: tuple[int, ...]
    ass: str
    plate: str | None  # "fitblur" | "flat" | None (no pixels needed)
    gate: bool = True
    family: str | None = None
    lanes: dict | None = None
    transitions: list[dict] | None = field(default=None)

    def to_json(self) -> dict:
        entry = {"id": self.id, "kind": self.kind, "pack": self.pack, "chars": self.chars,
                 "variant": self.variant, "fps": list(self.fps), "total_frames": self.total_frames,
                 "probe_frames": list(self.probe_frames), "plate": self.plate, "gate": self.gate,
                 "family": self.family}
        if self.kind == "ptime":
            entry["lanes"] = self.lanes
            entry["transitions"] = self.transitions
        return entry


def choose_probes(edges: Iterable[int], visible: tuple[int, int], count: int = PROBES_PER_CLIP,
                  margin: int = PROBE_MARGIN) -> tuple[int, ...]:
    """``count`` frames spread over ``visible`` that stay ``margin`` frames from every edge."""
    edge_list = sorted(set(edges))
    eligible = [f for f in range(visible[0], visible[1])
                if all(abs(f - e) >= margin for e in edge_list)]
    if len(eligible) < count:
        raise ValueError(f"only {len(eligible)} probe frames available")
    picks = [eligible[round(i * (len(eligible) - 1) / (count - 1))] for i in range(count)]
    if len(set(picks)) != count:
        raise ValueError("probe frames collide")
    return tuple(picks)


def _cue_edges(cues: Sequence[Cue], *, words: bool) -> set[int]:
    edges: set[int] = set()
    for cue in cues:
        edges |= {cue.f0, cue.f1}
        if words:
            edges |= {w.f0 for w in cue.words}
    return edges


def _caption_clip(pack: str, length: int, *, variant: str | None, family: str,
                  measure: Callable[[str], float] | None) -> Clip:
    fps = PTXT_FPS
    words = sample_words(SAMPLE_TEXTS[length], fps=fps, start_f=6)
    cues = group_cues(words, pack=pack, measure=measure if pack == "box" else None)
    total = cues[-1].f1 + 12
    if pack in ("classic", "karaoke"):
        ass = legacy_ass(cues, fps=fps, style=pack, total_frames=total)
    elif pack == "bold":
        ass = bold_ass(cues, fps=fps, family=family)
    else:
        ass = box_ass(cues, fps=fps, family=family,
                      variant="pbox" if variant == "pbox" else "border3", measure=measure)
    edges = _cue_edges(cues, words=pack in ("karaoke", "bold")) | {0, total}
    probes = choose_probes(edges, (cues[0].f0, cues[-1].f1))
    suffix = f"-{variant}" if variant else ""
    return Clip(id=f"{pack}{suffix}-{length}", kind="ptxt", pack=pack, chars=length,
                variant=variant, fps=(fps.num, fps.den), total_frames=total, probe_frames=probes,
                edges=tuple(sorted(edges)), ass=ass, plate="fitblur", gate=variant is None,
                family=family)


def build_clips(*, fallback_char: str,
                measures: dict[str, Callable[[str], float]] | None = None) -> list[Clip]:
    """The P-TXT matrix (4 packs × 3 lengths × 5 probes, hook, fallback glyph), the pack
    variants of the spike, the P-COLOR sheet and one P-TIME fixture per frame rate.

    ``measures`` maps a family to its advance-width function at the Box size (from the font's
    ``hmtx``); without it, a DejaVu-based estimate is used.
    """
    measures = measures or {}
    fps = PTXT_FPS
    clips: list[Clip] = []
    for pack in PACKS:
        family = MONTSERRAT if pack in ("bold", "box") else DEJAVU
        for length in LENGTHS:
            clips.append(_caption_clip(pack, length, variant=None, family=family,
                                       measure=measures.get(family)))
    for pack, variant, family in (("bold", "dejavu", DEJAVU), ("box", "dejavu", DEJAVU),
                                  ("box", "pbox", MONTSERRAT)):
        for length in LENGTHS:
            clips.append(_caption_clip(pack, length, variant=variant, family=family,
                                       measure=measures.get(family)))
    # Hook (legacy-bar@1): visible from 0 with \fad(150,250).
    total = 150
    fade_in, fade_out = frame_of_ms(150, fps), frame_of_ms(_cs(total, fps) * 10 - 250, fps)
    edges = {0, fade_in, fade_out, total}
    clips.append(Clip(id="hook", kind="ptxt", pack="hook", chars=len(HOOK_TEXT), variant=None,
                      fps=(fps.num, fps.den), total_frames=total,
                      probe_frames=choose_probes(edges, (fade_in, fade_out)),
                      edges=tuple(sorted(edges)), ass=hook_ass(HOOK_TEXT, fps=fps,
                                                                total_frames=total),
                      plate="fitblur", family=DEJAVU))
    # Fallback glyph: a character Montserrat lacks, drawn from DejaVu Sans on both sides.
    total = 60
    edges = {0, 6, total - 6, total}
    text = FALLBACK_TEXT.format(fallback_char)
    clips.append(Clip(id="fallback", kind="ptxt", pack="fallback", chars=len(text), variant=None,
                      fps=(fps.num, fps.den), total_frames=total,
                      probe_frames=choose_probes(edges, (6, total - 6)), edges=tuple(sorted(edges)),
                      ass=fallback_ass(fallback_char, fps=fps, start_f=6, end_f=total - 6),
                      plate="fitblur", family=MONTSERRAT))
    # P-COLOR sheet over a flat plate: static for the whole clip.
    total = 45
    edges = {0, total}
    clips.append(Clip(id="pcolor", kind="pcolor", pack="pcolor", chars=0, variant=None,
                      fps=(fps.num, fps.den), total_frames=total,
                      probe_frames=choose_probes(edges, (0, total)), edges=tuple(sorted(edges)),
                      ass=pcolor_ass(fps=fps, total_frames=total), plate="flat", gate=False,
                      family=MONTSERRAT))
    for rate in TIMING_FPS:
        ass, lanes, transitions = timing_ass(rate)
        frames = [t["frame"] for t in transitions]
        clips.append(Clip(id=f"timing-{rate.num}-{rate.den}", kind="ptime", pack="timing",
                          chars=0, variant=None, fps=(rate.num, rate.den),
                          total_frames=max(frames) + 5, probe_frames=(),
                          edges=tuple(sorted(set(frames))), ass=ass, plate=None, gate=True,
                          family=DEJAVU, lanes=lanes, transitions=transitions))
    return clips


# --- S-COLOR candidates and the R7 encode -------------------------------------------------------


def ass_filter(filename: str) -> str:
    """R5's ``ass`` filter: fonts from ``fontsdir``, shaping pinned to ``complex``."""
    return f"ass=filename={filename}:fontsdir=fonts:shaping=complex"


def composite_graph(fmt: str, ass: str | None) -> str:
    """The plate converted to the candidate compositing format, then the ``ass`` filter."""
    if fmt == "gbrp":
        head = "scale=in_color_matrix=bt709:in_range=tv,format=gbrp"
    elif fmt in ("yuv420p", "yuv444p"):
        head = f"format={fmt}"
    else:
        raise ValueError(f"unknown candidate {fmt!r}")
    return f"{head},{ass}" if ass else head


def final_graph(fmt: str) -> str:
    """R5's last step: BT.709/tv 4:2:0.

    From RGB (``gbrp``) this is R5's string. A YUV composite must also name its own matrix:
    swscale treats untagged YUV as BT.601 and, when the two matrices differ, converts YUV→YUV
    through RGB, which would shift every plate colour (measured in the S-COLOR run: luma SSIM
    0.977 against the composite). With both matrices BT.709 only the chroma is resampled.
    """
    if fmt == "gbrp":
        return FINAL_GRAPH
    if fmt in ("yuv420p", "yuv444p"):
        return f"scale=in_color_matrix=bt709:in_range=tv:{FINAL_GRAPH.removeprefix('scale=')}"
    raise ValueError(f"unknown candidate {fmt!r}")


def view_graph(fmt: str) -> str:
    """The composite in the candidate format → RGB with the BT.709 matrix (P-TXT reference)."""
    if fmt == "gbrp":
        return "format=rgb24"
    if fmt in ("yuv420p", "yuv444p"):
        return f"{DECODE_709},format=rgb24"
    raise ValueError(f"unknown candidate {fmt!r}")


def x264_args(fps: Fps) -> list[str]:
    """R7 "Standar" encode (video only)."""
    gop = 2 * -(-fps.num // fps.den)
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-g", str(gop), "-x264-params", "threads=4",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-color_range", "tv", "-map_metadata", "-1", "-fflags", "+bitexact",
            "-flags:v", "+bitexact", "-movflags", "+faststart"]


def timebase_graph(fps: Fps) -> str:
    """Frame index as pts in time base den/num, so libass sees ``now_ms(n)`` (plan §3.4)."""
    return f"settb={fps.den}/{fps.num},setpts=N"


def plate_source(name: str, fps: Fps, frames: int) -> str:
    """Lavfi graph of a plate: ``fitblur`` (R4 ``fit_blur`` of ``testsrc2``) or ``flat``."""
    rate = f"{fps.num}/{fps.den}"
    if name == "fitblur":
        sigma = 35 * HEIGHT // 1280
        return (f"testsrc2=size=1280x720:rate={rate},trim=end_frame={frames},format=yuv420p,"
                f"split=2[s0][s1];"
                f"[s0]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase:"
                f"in_color_matrix=bt709:out_color_matrix=bt709,crop={WIDTH}:{HEIGHT},"
                f"gblur=sigma={sigma},format=yuv444p[bg];"
                f"[s1]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:"
                f"in_color_matrix=bt709:out_color_matrix=bt709,format=yuv444p[fg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2:format=yuv444,format=yuv444p")
    if name == "flat":
        r, g, b = FLAT_PLATE_RGB
        return (f"color=c=0x{r:02X}{g:02X}{b:02X}:size={WIDTH}x{HEIGHT}:rate={rate},"
                f"trim=end_frame={frames},format=rgb24,"
                "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p")
    raise ValueError(f"unknown plate {name!r}")


# --- generation ---------------------------------------------------------------------------------


def _fonts_conf(fonts_dir: Path, cache_dir: Path) -> str:
    return f"""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Parity fixtures: only the files in {fonts_dir.name}/; DejaVu Sans is the only fallback
     (the lockdown of resources/fontconfig/fonts.conf, plan §5.2 R6). -->
<fontconfig>
  <dir>{fonts_dir}</dir>
  <cachedir>{cache_dir}</cachedir>
  <selectfont>
    <acceptfont><pattern><patelt name="family"><string>DejaVu Sans</string></patelt></pattern></acceptfont>
    <rejectfont><pattern></pattern></rejectfont>
  </selectfont>
  <alias binding="same"><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias binding="same"><family>serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias binding="same"><family>monospace</family><prefer><family>DejaVu Sans</family></prefer></alias>
</fontconfig>
"""


class Runner:
    """Runs FFmpeg inside the fixture directory with the locked-down fontconfig."""

    def __init__(self, out: Path, ffmpeg: str, threads: int) -> None:
        self.out = out
        self.ffmpeg = ffmpeg
        self.threads = threads
        self.env = {key: value for key, value in os.environ.items()
                    if key in ("PATH", "HOME", "LANG", "TZ", "TMPDIR")}
        self.env["FONTCONFIG_FILE"] = str(out / "fonts.conf")

    def run(self, args: Sequence[str]) -> str:
        argv = [self.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-threads", str(self.threads), *args]
        result = subprocess.run(argv, cwd=self.out, env=self.env, capture_output=True, text=True,
                                timeout=1800, check=False)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg failed ({result.returncode}): {result.stderr[-2000:]}")
        return result.stderr

    def frames_png(self, source: str, head: str, graph: str, frames: Sequence[int],
                   target: Path) -> None:
        """Write ``target/<n>.png`` for each frame ``n`` (numbered by ``head``) of ``graph``."""
        target.mkdir(parents=True, exist_ok=True)
        wanted = sorted(set(frames))
        select = "select='" + "+".join(f"eq(n\\,{n})" for n in wanted) + "'"
        with tempfile.TemporaryDirectory(dir=self.out) as scratch:
            self.run(["-i", source, "-filter_complex_threads", str(self.threads),
                      "-filter_complex", f"[0:v]{head},{select},{graph}[v]", "-map", "[v]",
                      "-fps_mode", "passthrough", "-pred", "none",
                      str(Path(scratch) / "%06d.png")])
            written = sorted(Path(scratch).glob("*.png"))
            if len(written) != len(wanted):
                raise RuntimeError(f"expected {len(wanted)} frames, got {len(written)}")
            for path, frame in zip(written, wanted, strict=True):
                shutil.move(str(path), target / f"{frame}.png")


def _toolchain(ffmpeg: str) -> dict:
    info: dict = {"ffmpeg_version": None, "packages": {}}
    try:
        info["ffmpeg_version"] = subprocess.run([ffmpeg, "-version"], capture_output=True,
                                                text=True, check=True).stdout.splitlines()[0]
    except (OSError, subprocess.CalledProcessError, IndexError):
        pass
    if shutil.which("dpkg-query"):
        for package in ("ffmpeg", "libass9", "libfreetype6", "libharfbuzz0b", "libfribidi0",
                        "fontconfig"):
            result = subprocess.run(["dpkg-query", "-W", "-f=${Version}\\n", package],
                                    capture_output=True, text=True, check=False)
            lines = result.stdout.split()
            info["packages"][package] = lines[0] if lines else None
    return info


def _font_entries(fonts_dir: Path, target: Path) -> list[dict]:
    target.mkdir(parents=True, exist_ok=True)
    entries = []
    for path in sorted(fonts_dir.iterdir()):
        if path.suffix.lower() not in (".ttf", ".otf") or not path.is_file():
            continue
        data = path.read_bytes()
        (target / path.name).write_bytes(data)
        entries.append({"file": path.name, "sha256": hashlib.sha256(data).hexdigest(),
                        "bytes": len(data)})
    if not entries:
        raise ValueError(f"no .ttf/.otf fonts in {fonts_dir}")
    return entries


def _measures(fonts: Path) -> dict[str, Callable[[str], float]]:
    measures = {}
    for family, name in ((MONTSERRAT, MONTSERRAT_FILE), (DEJAVU, DEJAVU_BOLD_FILE)):
        if (fonts / name).is_file():
            measures[family] = text_measure((fonts / name).read_bytes(), BOX_SIZE)
    return measures


def _fallback_char(fonts: Path) -> str:
    if (fonts / MONTSERRAT_FILE).is_file() and (fonts / DEJAVU_FILE).is_file():
        return choose_fallback_char(cmap_codepoints((fonts / MONTSERRAT_FILE).read_bytes()),
                                    cmap_codepoints((fonts / DEJAVU_FILE).read_bytes()))
    return FALLBACK_CANDIDATES[0]


def generate(out: Path, *, fonts_dir: Path, formats: Sequence[str] = CANDIDATES,
             only: Sequence[str] | None = None, export: bool = True, timing: bool = True,
             ffmpeg: str = "ffmpeg", threads: int = 4,
             log: Callable[[str], None] = lambda line: None) -> dict:
    """Write the fixtures to ``out`` and return the manifest (also written as manifest.json)."""
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for fmt in formats:
        if fmt not in CANDIDATES:
            raise ValueError(f"unknown candidate {fmt!r}")
    fonts = _font_entries(Path(fonts_dir), out / "fonts")
    (out / "fonts.conf").write_text(_fonts_conf(out / "fonts", out / "fc-cache"), encoding="utf-8")
    fallback_char = _fallback_char(out / "fonts")
    clips = build_clips(fallback_char=fallback_char, measures=_measures(out / "fonts"))
    if only is not None:
        unknown = set(only) - {clip.id for clip in clips}
        if unknown:
            raise ValueError(f"unknown clip ids: {sorted(unknown)}")
        clips = [clip for clip in clips if clip.id in only]
    if not timing:
        clips = [clip for clip in clips if clip.kind != "ptime"]
    (out / "ass").mkdir(exist_ok=True)
    for clip in clips:
        (out / "ass" / f"{clip.id}.ass").write_text(clip.ass, encoding="utf-8")
    runner = Runner(out, ffmpeg, threads)
    fps = PTXT_FPS
    pixel_clips = [clip for clip in clips if clip.plate is not None]
    # Lossless plates, long enough for every clip that uses them.
    plates: dict[str, str] = {}
    for name in sorted({clip.plate for clip in pixel_clips}):
        frames = max(clip.total_frames for clip in pixel_clips if clip.plate == name)
        path = out / "plate" / f"{name}.mkv"
        path.parent.mkdir(exist_ok=True)
        log(f"plate {name}: {frames} frames")
        runner.run(["-f", "lavfi", "-i", plate_source(name, fps, frames), "-c:v", "ffv1",
                    "-level", "3", "-g", "1", str(path)])
        plates[name] = str(path.relative_to(out))
    head = timebase_graph(fps)
    # Plate frames (shared by every clip on the same plate) and the references.
    for name, plate in plates.items():
        wanted = sorted({f for clip in pixel_clips if clip.plate == name
                         for f in clip.probe_frames})
        for fmt in formats:
            log(f"bg {name} {fmt}: {len(wanted)} frames")
            runner.frames_png(plate, head, f"{composite_graph(fmt, None)},{view_graph(fmt)}",
                              wanted, out / "bg" / name / fmt)
    entries = []
    for clip in clips:
        entry = clip.to_json()
        entry["files"] = {"ass": f"ass/{clip.id}.ass"}
        if clip.plate is None:
            entries.append(entry)
            continue
        ass = ass_filter(f"ass/{clip.id}.ass")
        region: Box | None = None
        entry["files"].update({"bg": {}, "ref": {}})
        for fmt in formats:
            log(f"ref {clip.id} {fmt}")
            target = out / "ref" / clip.id / fmt
            runner.frames_png(plates[clip.plate], head,
                              f"{composite_graph(fmt, ass)},{view_graph(fmt)}",
                              clip.probe_frames, target)
            entry["files"]["bg"][fmt] = {str(f): f"bg/{clip.plate}/{fmt}/{f}.png"
                                         for f in clip.probe_frames}
            entry["files"]["ref"][fmt] = {str(f): f"ref/{clip.id}/{fmt}/{f}.png"
                                          for f in clip.probe_frames}
            for frame in clip.probe_frames:
                bg = compare.read_png(out / entry["files"]["bg"][fmt][str(frame)])
                ref = compare.read_png(target / f"{frame}.png")
                box = compare.diff_bbox(bg, ref)
                if box is None:
                    raise RuntimeError(f"{clip.id} {fmt} frame {frame}: no text drawn")
                region = box.union(region)
        entry["text_region"] = region.pad(REGION_PAD, WIDTH, HEIGHT).to_list()
        if export:
            entry["files"]["export"], entry["files"]["lossless"] = {}, {}
            for fmt in formats:
                log(f"export {clip.id} {fmt}")
                mp4 = Path("export") / clip.id / f"{fmt}.mp4"
                mkv = Path("lossless") / clip.id / f"{fmt}.mkv"
                (out / mp4).parent.mkdir(parents=True, exist_ok=True)
                (out / mkv).parent.mkdir(parents=True, exist_ok=True)
                graph = (f"[0:v]{head},trim=end_frame={clip.total_frames},"
                         f"{composite_graph(fmt, ass)},split=2[a][b];"
                         f"[a]{final_graph(fmt)}[v];[b]{view_graph(fmt)},format=gbrp[r]")
                runner.run(["-i", plates[clip.plate], "-filter_complex_threads", str(threads),
                            "-filter_complex", graph, "-map", "[v]", *x264_args(fps), str(mp4),
                            "-map", "[r]", "-c:v", "ffv1", "-level", "3", "-g", "1", str(mkv)])
                entry["files"]["export"][fmt] = str(mp4)
                entry["files"]["lossless"][fmt] = str(mkv)
        entries.append(entry)
    manifest = {
        "schema": SCHEMA,
        "size": [WIDTH, HEIGHT],
        "formats": list(formats),
        "fonts": fonts,
        "fallback_char": fallback_char,
        "fallback_family": DEJAVU,
        "graphs": {fmt: {"composite": composite_graph(fmt, "ass=…"), "view": view_graph(fmt),
                         "final": final_graph(fmt)} for fmt in formats},
        "x264": x264_args(fps),
        "plates": plates,
        "toolchain": _toolchain(ffmpeg),
        "clips": entries,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
                                       encoding="utf-8")
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write the text-parity fixtures and references.")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--fonts", type=Path, required=True,
                        help="directory with DejaVuSans.ttf, DejaVuSans-Bold.ttf and "
                             "Montserrat-ExtraBold.ttf (the pinned bytes of resources/fonts)")
    parser.add_argument("--formats", default=",".join(CANDIDATES))
    parser.add_argument("--only", help="comma-separated clip ids")
    parser.add_argument("--no-export", action="store_true")
    parser.add_argument("--no-timing", action="store_true")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args(argv)
    manifest = generate(args.out, fonts_dir=args.fonts, formats=tuple(args.formats.split(",")),
                        only=tuple(args.only.split(",")) if args.only else None,
                        export=not args.no_export, timing=not args.no_timing,
                        ffmpeg=args.ffmpeg, threads=args.threads,
                        log=lambda line: print(line, file=sys.stderr, flush=True))
    counts: dict[str, int] = {}
    for clip in manifest["clips"]:
        counts[clip["kind"]] = counts.get(clip["kind"], 0) + 1
    print(json.dumps({"out": str(args.out), "clips": counts,
                      "toolchain": manifest["toolchain"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = [
    "CANDIDATES",
    "HOOK_TEXT",
    "PACKS",
    "SAMPLE_TEXTS",
    "Clip",
    "Cue",
    "Word",
    "ass_filter",
    "ass_time",
    "bold_ass",
    "box_ass",
    "build_clips",
    "choose_fallback_char",
    "cmap_codepoints",
    "composite_graph",
    "final_graph",
    "generate",
    "group_cues",
    "hazard_frames",
    "hook_ass",
    "legacy_ass",
    "sample_words",
    "timing_ass",
    "view_graph",
    "x264_args",
]

