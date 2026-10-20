"""ASS documents for burned captions (classic or karaoke) and the on-screen hook text.

``build_ass`` serves the V1 and v2-shadow render paths. Editor V3 adds the caption packs
(``load_pack``), ``fit_cues``, ``layout_hook`` and ``build_ass_v2``, the frame-safe generator of
plan §5.4; this module stays the only ASS generator.
"""

from __future__ import annotations

import functools
import hashlib
import json
import math
import re
import string
import unicodedata
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from dataclasses import replace as dataclass_replace
from itertools import pairwise
from numbers import Real
from pathlib import Path
from types import MappingProxyType
from typing import Any

from .edit_v2 import WORDS_MAX_RANGE
from .edit_v2.glyphs import RESOURCES_DIR, advance_units, font_path
from .edit_v2.timemap import Fps, div_round_half_up, safe_cs
from .subtitles import CaptionCue, FrameCue, FrameWord, clean_caption_text

CAPTION_STYLES = ("classic", "karaoke")
HOOK_TEXT_MAX_CHARS = 90
HOOK_MAX_LINES = 3
HOOK_FADE_IN_MS = 150
HOOK_FADE_OUT_MS = 250
FONT_NAME = "DejaVu Sans"
KARAOKE_HIGHLIGHT_COLOR = "#FFE14D"
CAPTION_TEXT_COLOR = "#FFFFFF"

# Sizes are fractions of the output height so every resolution keeps one look. The caption
# font matches the historical SRT force_style (FontSize=12 on libass' 288-line SRT canvas).
_CAPTION_FONT_RATIO = 12 / 288
_CAPTION_OUTLINE_RATIO = 1 / 150
_CAPTION_SHADOW_RATIO = 1 / 288
_CAPTION_MARGIN_BOTTOM_RATIO = 0.17
_CAPTION_SIDE_MARGIN_RATIO = 0.06
_HOOK_MARGIN_TOP_RATIO = 0.13
_HOOK_SIDE_MARGIN_RATIO = 0.06
_HOOK_BOX_PADDING_RATIO = 0.011
_HOOK_FONT_RATIOS = (0.046, 0.042, 0.039, 0.036, 0.033, 0.030, 0.027)
# DejaVu Sans Bold advance widths in em. libass sizes fonts by line height (ascent + descent,
# 1.164 em for DejaVu), so an advance in font-size units is em / 1.164.
_DEJAVU_BOLD_EM_PER_FONT_SIZE = 1 / 1.164
_LOWERCASE_ADVANCES_EM = (
    "0.675 0.716 0.593 0.716 0.678 0.435 0.716 0.712 0.343 0.343 0.665 0.343 1.042 "
    "0.712 0.687 0.716 0.716 0.493 0.595 0.478 0.712 0.652 0.924 0.645 0.652 0.582"
)
_UPPERCASE_ADVANCES_EM = (
    "0.774 0.762 0.734 0.830 0.683 0.683 0.821 0.837 0.372 0.372 0.775 0.637 0.995 "
    "0.837 0.850 0.733 0.850 0.770 0.720 0.682 0.812 0.774 1.103 0.771 0.724 0.725"
)
_DEJAVU_BOLD_ADVANCES_EM = {
    **dict(zip(string.ascii_lowercase, map(float, _LOWERCASE_ADVANCES_EM.split()), strict=True)),
    **dict(zip(string.ascii_uppercase, map(float, _UPPERCASE_ADVANCES_EM.split()), strict=True)),
    **dict.fromkeys(string.digits, 0.696),
    **dict.fromkeys(" ", 0.348),
    **dict.fromkeys(".,", 0.380),
    **dict.fromkeys(":;", 0.400),
    **dict.fromkeys("'", 0.332),
    **dict.fromkeys("-", 0.415),
    **dict.fromkeys("()", 0.457),
    **dict.fromkeys("/", 0.365),
    **dict.fromkeys("!", 0.438),
    **dict.fromkeys('"', 0.521),
    **dict.fromkeys("?", 0.580),
    **dict.fromkeys("…", 1.000),
}
_DEJAVU_BOLD_FALLBACK_EM = 0.85  # unknown glyphs: assume wide so lines never overflow
_HOOK_WIDTH_SAFETY = 1.04
_HOOK_BOX_ALPHA = 0x59  # ASS alpha: 0x00 opaque, 0xFF transparent (about 65% opaque here)
_HOOK_TRAILING_PUNCTUATION = " ,;:-–—."

# libass has no escape for a literal backslash; a word joiner after it stops "\N", "\h" and
# friends from forming while staying invisible.
_WORD_JOINER = "\u2060"
_LINE_BREAKING = frozenset("\r\n\t\v\f\x1c\x1d\x1e\x85\u2028\u2029")
_DROPPED_CATEGORIES = frozenset({"Cc", "Cs"})

_STYLE_FORMAT = (
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,"
    "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,"
    "Alignment,MarginL,MarginR,MarginV,Encoding"
)
_EVENT_FORMAT = "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text"


def _is_number(value: object) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool)


def ass_escape(text: str) -> str:
    """Escape text so libass renders it literally: no override blocks, no hard breaks."""
    pieces: list[str] = []
    for character in text:
        if character in _LINE_BREAKING:
            pieces.append(" ")
        elif unicodedata.category(character) in _DROPPED_CATEGORIES:
            continue
        elif character == "\\":
            pieces.append("\\" + _WORD_JOINER)
        elif character in "{}":
            pieces.append("\\" + character)
        else:
            pieces.append(character)
    return "".join(pieces)


def _drawn_text(text: str) -> str:
    """The characters libass draws for ``ass_escape(text)``, without its invisible markers."""
    return "".join(
        " " if character in _LINE_BREAKING else character
        for character in text
        if character in _LINE_BREAKING
        or unicodedata.category(character) not in _DROPPED_CATEGORIES
    )


def shorten_hook_text(text: str, max_chars: int = HOOK_TEXT_MAX_CHARS) -> str:
    """Normalize whitespace and cap the length, cutting on a word boundary with an ellipsis."""
    if not isinstance(max_chars, int) or isinstance(max_chars, bool) or max_chars < 2:
        raise ValueError("max_chars must be an integer of at least 2")
    normalized = clean_caption_text(text)
    if len(normalized) <= max_chars:
        return normalized
    limit = max_chars - 1
    if normalized[limit] == " ":
        cut = normalized[:limit]
    else:
        boundary = normalized.rfind(" ", 0, limit)
        cut = normalized[:boundary] if boundary >= max_chars // 2 else normalized[:limit]
    return cut.rstrip(_HOOK_TRAILING_PUNCTUATION) + "…"


def _ass_time(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def _ass_color(color: str, *, alpha: int = 0) -> str:
    red, green, blue = color[1:3], color[3:5], color[5:7]
    return f"&H{alpha:02X}{blue}{green}{red}".upper()


def _ass_number(value: float) -> str:
    return f"{round(value, 2):g}"


def estimate_text_width(text: str, font_size: float) -> float:
    """Approximate rendered width of bold hook text in pixels (DejaVu Sans Bold metrics)."""
    em = sum(
        _DEJAVU_BOLD_ADVANCES_EM.get(character, _DEJAVU_BOLD_FALLBACK_EM) for character in text
    )
    return em * font_size * _DEJAVU_BOLD_EM_PER_FONT_SIZE * _HOOK_WIDTH_SAFETY


def _split_to_width(word: str, font_size: int, max_width: float) -> list[str]:
    pieces: list[str] = []
    current = ""
    for character in word:
        if current and estimate_text_width(current + character, font_size) > max_width:
            pieces.append(current)
            current = ""
        current += character
    return [*pieces, current] if current else pieces


def _wrap_to_width(text: str, font_size: int, max_width: float) -> list[str]:
    """Greedy word wrap by estimated pixel width; over-long words are split."""
    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if estimate_text_width(candidate, font_size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
        pieces = _split_to_width(word, font_size, max_width)
        lines.extend(pieces[:-1])
        current = pieces[-1]
    if current:
        lines.append(current)
    return lines


def _hook_layout_checked(
    text: str, *, width: int, height: int
) -> tuple[int, int, tuple[str, ...], bool]:
    """``_hook_layout`` plus whether the tail had to be cut with "…" (``hook_overflow``)."""
    side_margin = round(width * _HOOK_SIDE_MARGIN_RATIO)
    padding = max(1, round(height * _HOOK_BOX_PADDING_RATIO))
    usable = max(1, width - 2 * side_margin - 2 * padding)
    lines: list[str] = []
    font_size = 1
    for ratio in _HOOK_FONT_RATIOS:
        font_size = max(1, round(height * ratio))
        lines = _wrap_to_width(text, font_size, usable)
        if len(lines) <= HOOK_MAX_LINES:
            return font_size, padding, tuple(lines), False
    kept = lines[: HOOK_MAX_LINES - 1]
    tail = " ".join(lines[HOOK_MAX_LINES - 1 :])
    while len(tail) > 2 and estimate_text_width(tail, font_size) > usable:
        tail = shorten_hook_text(tail, max_chars=len(tail) - 1)
    kept.append(tail)
    return font_size, padding, tuple(kept), True


def _hook_layout(text: str, *, width: int, height: int) -> tuple[int, int, tuple[str, ...]]:
    """Pick the largest hook font whose wrapped text fits in HOOK_MAX_LINES lines."""
    font_size, padding, lines, _overflow = _hook_layout_checked(text, width=width, height=height)
    return font_size, padding, lines


def _style_line(
    name: str,
    *,
    font_size: int,
    primary: str,
    secondary: str,
    outline_color: str,
    back_color: str,
    bold: bool,
    border_style: int,
    outline: float | str,
    shadow: float | str,
    alignment: int,
    margin_side: int,
    margin_vertical: int,
    font_name: str = FONT_NAME,
) -> str:
    # Editor V3 passes outline and shadow already formatted (exact integer arithmetic).
    outline_text = outline if isinstance(outline, str) else _ass_number(outline)
    shadow_text = shadow if isinstance(shadow, str) else _ass_number(shadow)
    return (
        f"Style: {name},{font_name},{font_size},{primary},{secondary},{outline_color},"
        f"{back_color},{-1 if bold else 0},0,0,0,100,100,0,0,{border_style},"
        f"{outline_text},{shadow_text},{alignment},{margin_side},{margin_side},"
        f"{margin_vertical},1"
    )


def _script_header(width: int, height: int, styles: Sequence[str]) -> str:
    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: None\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n\n"
        "[V4+ Styles]\n"
        f"{_STYLE_FORMAT}\n" + "\n".join(styles) + "\n\n"
        "[Events]\n"
        f"{_EVENT_FORMAT}\n"
    )


def _hook_style(*, font_size: int, padding: int, width: int, top: int) -> str:
    white = _ass_color(CAPTION_TEXT_COLOR)
    return _style_line(
        "Hook",
        font_size=font_size,
        primary=white,
        secondary=white,
        outline_color=_ass_color("#000000", alpha=_HOOK_BOX_ALPHA),
        back_color=_ass_color("#000000", alpha=_HOOK_BOX_ALPHA),
        bold=True,
        border_style=3,
        outline=padding,
        shadow=0,
        alignment=8,
        margin_side=round(width * _HOOK_SIDE_MARGIN_RATIO),
        margin_vertical=top,
    )


def _hook_events(
    lines: Sequence[str], *, start: str, end: str, width: int, top: int, font_size: int,
    padding: int,
) -> list[str]:
    # One event per line: libass draws a BorderStyle 3 box per line, and boxes of a
    # multi-line event overlap (double-dark bands). Lines stacked one box-height apart
    # touch exactly instead; \q2 keeps libass from re-wrapping a pre-wrapped line.
    pitch = font_size + 2 * padding
    return [
        f"Dialogue: 1,{start},{end},Hook,,0,0,0,,"
        f"{{\\fad({HOOK_FADE_IN_MS},{HOOK_FADE_OUT_MS})\\an8\\q2\\pos({width // 2},"
        f"{top + padding + index * pitch})}}{ass_escape(line)}"
        for index, line in enumerate(lines)
    ]


def _karaoke_text(cue: CaptionCue, *, uppercase: bool) -> str:
    """Words with {\\k} durations that start each highlight on the word and sum to the cue."""
    cue_start = round(cue.start * 100)
    cue_end = round(cue.end * 100)
    boundaries = [cue_start]
    for word in cue.words[1:]:
        boundaries.append(min(max(round(word.start * 100), boundaries[-1]), cue_end))
    boundaries.append(cue_end)
    parts = []
    for index, word in enumerate(cue.words):
        text = word.text.upper() if uppercase else word.text
        parts.append(f"{{\\k{boundaries[index + 1] - boundaries[index]}}}{ass_escape(text)}")
    return " ".join(parts)


def build_ass(
    cues: Sequence[CaptionCue],
    *,
    width: int,
    height: int,
    duration: float,
    caption_style: str = "classic",
    hook_text: str | None = None,
    hook_duration: float = 4.0,
    uppercase: bool = False,
) -> str:
    """Build the ASS document burned into a rendered clip.

    ``cues`` are clip-relative (see ``subtitles.build_caption_cues``). The hook, when given, is
    shown in the top safe area from 0 to ``min(hook_duration, duration)`` seconds.
    """
    if caption_style not in CAPTION_STYLES:
        raise ValueError(f"unknown caption style: {caption_style}")
    for name, value in (("width", width), ("height", height)):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    for name, value in (("duration", duration), ("hook_duration", hook_duration)):
        if not _is_number(value) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be a finite positive number")
    if hook_text is not None and not isinstance(hook_text, str):
        raise TypeError("hook_text must be a string or None")
    if any(round(cue.end * 100) > round(duration * 100) for cue in cues):
        raise ValueError("caption cue ends after the clip duration")

    caption_font = max(1, round(height * _CAPTION_FONT_RATIO))
    caption_outline = height * _CAPTION_OUTLINE_RATIO
    caption_shadow = height * _CAPTION_SHADOW_RATIO
    caption_side = round(width * _CAPTION_SIDE_MARGIN_RATIO)
    caption_bottom = round(height * _CAPTION_MARGIN_BOTTOM_RATIO)
    white = _ass_color(CAPTION_TEXT_COLOR)
    black = _ass_color("#000000")
    styles = [
        _style_line(
            "Caption",
            font_size=caption_font,
            primary=white,
            secondary=white,
            outline_color=black,
            back_color=black,
            bold=False,
            border_style=1,
            outline=caption_outline,
            shadow=caption_shadow,
            alignment=2,
            margin_side=caption_side,
            margin_vertical=caption_bottom,
        ),
        _style_line(
            "Karaoke",
            font_size=caption_font,
            primary=_ass_color(KARAOKE_HIGHLIGHT_COLOR),
            secondary=white,
            outline_color=black,
            back_color=black,
            bold=True,
            border_style=1,
            outline=caption_outline,
            shadow=caption_shadow,
            alignment=2,
            margin_side=caption_side,
            margin_vertical=caption_bottom,
        ),
    ]

    events: list[str] = []
    style_name = "Karaoke" if caption_style == "karaoke" else "Caption"
    for cue in cues:
        if caption_style == "karaoke":
            text = _karaoke_text(cue, uppercase=uppercase)
        else:
            text = ass_escape(cue.text.upper() if uppercase else cue.text)
        events.append(
            f"Dialogue: 0,{_ass_time(cue.start)},{_ass_time(cue.end)},{style_name},,0,0,0,,{text}"
        )

    hook = shorten_hook_text(hook_text) if hook_text is not None else ""
    hook_font = caption_font
    hook_padding = max(1, round(height * _HOOK_BOX_PADDING_RATIO))
    hook_top = round(height * _HOOK_MARGIN_TOP_RATIO)
    if hook:
        hook_font, hook_padding, lines = _hook_layout(hook, width=width, height=height)
        hook_end = min(hook_duration, duration)
        events += _hook_events(lines, start=_ass_time(0.0), end=_ass_time(hook_end),
                               width=width, top=hook_top, font_size=hook_font,
                               padding=hook_padding)
    styles.append(_hook_style(font_size=hook_font, padding=hook_padding, width=width,
                              top=hook_top))
    return _script_header(width, height, styles) + "\n".join(events) + ("\n" if events else "")


# --- Editor V3: caption packs and frame-safe ASS (plan §3.4, §5.4) ------------------------------
#
# ``build_ass_v2`` is the only ASS generator of Editor V3: FFmpeg burns its bytes and JASSUB
# draws the same bytes in the browser. Every number is exact integer arithmetic, and every
# event boundary is a frame-safe centisecond (``timemap.safe_cs``), so both renderers switch on
# the planned output frame.

PACKS_DIR = RESOURCES_DIR / "caption-packs"
HOOK_DESIGNS_DIR = RESOURCES_DIR / "hook-designs"
PACK_SCHEMA = "potongin.caption-pack/1"
HOOK_DESIGN_SCHEMA = "potongin.hook-design/1"
CASES = ("asis", "upper")
# "word_box": each word placed on its own and a box behind the spoken one (the Sorot pack).
REVEALS = ("static", "karaoke", "word", "word_box")
# How a boxed pack (border_style 3) draws its box: libass' BorderStyle 3 ("border"), or a \\p
# vector rectangle event behind each line ("vector", the P-TXT fallback of plan §5.4).
BOX_STYLES = ("border", "vector")
_COLOUR = re.compile(r"#[0-9A-F]{6}")
_RESOURCE_ID = re.compile(r"[a-z][a-z0-9-]{0,31}")
_OVERRIDE_KEYS = ("y_e5", "size_pm", "case", "highlight", "emphasis")
_WORD_BOX_KEYS = frozenset({"pad_x_pm", "top_pm", "radius_pm", "dark_text", "light_text",
                            "dark_from_lstar"})
_E5 = 100_000
# Hook designs (CONTRACTS §5.33): the seeds' bar, whose geometry is the code below, and the
# layouts of the designs whose geometry is their file.
LEGACY_HOOK_DESIGN = ("legacy-bar", 1)
HOOK_LAYOUTS = ("kicker", "block", "keyword")
_DESIGN_KEYS = frozenset({"schema", "id", "v", "name", "layout", "font", "font_ratios_e5",
                          "max_lines", "max_chars", "side_margin_pm", "line_pitch_pm", "outline",
                          "colours", "box", "kicker", "fade_in_ms", "fade_out_ms", "default_y_e5",
                          "layer"})
# A kicker ends at the first of its leading words that ends with one of these marks.
_KICKER_MARKS = (":", "?", "!", ".", ",", ";", "…")


@dataclass(frozen=True)
class WordBox:
    """The box a ``word_box`` pack draws behind the spoken word (pack field ``word_box``).

    ``pad_x_pm`` (each side), ``top_pm`` (from the line's top down to the box's top; the box
    ends at the line's bottom) and ``radius_pm`` are per mille of the font size. The box takes
    the highlight colour, or the emphasis colour on a keyword; the word on it is ``dark_text``
    when the box's CIE lightness L* is at least ``dark_from_lstar``, else ``light_text``.
    """

    pad_x_pm: int
    top_pm: int
    radius_pm: int
    dark_text: str
    light_text: str
    dark_from_lstar: int


@dataclass(frozen=True)
class CaptionPack:
    """An immutable caption preset (``resources/caption-packs/<id>/v<v>.json``, plan §5.4).

    Sizes are integer ratios of the output height ``H``: the font size is
    ``H · size_ratio · size_scale_pm/1000 · overrides.size_pm/1000`` (rounded half up), the
    outline and shadow ``H · ratio`` pixels (centipixel precision). ``max_width_pm`` set means
    one line per cue: cues wider than that per-mille of ``W`` are split (``fit_cues``).
    ``box_style`` is how a boxed pack draws its box (``BOX_STYLES``); only boxed pack files
    carry the field, and ``"vector"`` needs a one-line static boxed pack. ``word_box`` is the
    spoken word's box of a ``word_box`` reveal (one-line packs without a border box only).
    """

    id: str
    v: int
    name: str
    style_name: str
    font_family: str
    font_file: str
    bold: bool
    size_ratio: tuple[int, int]
    size_scale_pm: int
    outline_ratio: tuple[int, int]
    shadow_ratio: tuple[int, int]
    border_style: int
    text_colour: str
    outline_colour: str
    outline_alpha: int
    back_colour: str
    back_alpha: int
    margin_side_pm: int
    reveal: str
    words_per_cue: int
    max_width_pm: int | None
    defaults: Mapping[str, Any]
    sha256: str
    box_style: str = "border"
    word_box: WordBox | None = None


@dataclass(frozen=True)
class HookSpec:
    """The hook of a document: ``text`` shown on output frames ``[f0, f1)``, top at ``y_e5``,
    drawn by the hook design ``design`` (``(id, v)``; the bar by default)."""

    text: str
    f0: int
    f1: int
    y_e5: int
    design: tuple[str, int] = LEGACY_HOOK_DESIGN


@dataclass(frozen=True)
class HookLayout:
    """A hook's geometry: font size, padding and top (px), lines, and overflow.

    The bar (``legacy-bar@1``) is drawn from these by ``_hook_style``/``_hook_events``; every
    other design also carries its ``Hook`` style line and its event texts (CONTRACTS §5.33).
    """

    font_size: int
    padding: int
    top: int
    lines: tuple[str, ...]
    overflow: bool
    style: str = ""
    events: tuple[str, ...] = ()
    layer: int = 1


@dataclass(frozen=True)
class HookBox:
    """The accent box of a design, per mille of the font size: side padding, the inset from the
    line's top to the box's top (the box ends at the line's bottom) and the corner radius."""

    pad_x_pm: int
    top_pm: int
    radius_pm: int


@dataclass(frozen=True)
class HookKicker:
    """The kicker line: its size per mille of the punchline's, how many leading words a closing
    mark may span, and its gap to the punchline per mille of the punchline size."""

    scale_pm: int
    max_words: int
    gap_pm: int


@dataclass(frozen=True)
class HookDesign:
    """A hook design file other than the bar (``resources/hook-designs/<id>/v<v>.json``).

    ``layout`` is ``kicker`` (a small accent line over the punchline), ``block`` (each line on
    its own accent box) or ``keyword`` (one word on an accent box). Sizes are ratios of the
    output height (``font_ratios_e5``, largest first: the first size whose lines fit wins) and
    per mille of the width (side margin) or of the font size (pitch, box, kicker).
    """

    id: str
    v: int
    name: str
    layout: str
    font_family: str
    font_file: str
    bold: bool
    font_ratios_e5: tuple[int, ...]
    max_lines: int
    side_margin_pm: int
    line_pitch_pm: int
    outline_ratio: tuple[int, int]
    text_colour: str
    outline_colour: str
    accent: str
    on_accent: str
    box: HookBox | None
    kicker: HookKicker | None
    fade_in_ms: int
    fade_out_ms: int
    default_y_e5: int
    layer: int
    sha256: str


def _is_int(value: object) -> bool:
    return type(value) is int


def _no_float(value: str) -> Any:
    raise ValueError(f"resource files hold integers only, found {value}")


def _read_resource(path: Path, what: str) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        raise ValueError(f"unknown {what}") from None
    data = json.loads(raw.decode("utf-8"), parse_float=_no_float, parse_constant=_no_float)
    if isinstance(data, dict):
        return data, hashlib.sha256(raw).hexdigest()
    raise ValueError(f"{what} must be a JSON object")


def _ratio(value: object, name: str) -> tuple[int, int]:
    if not isinstance(value, dict) or set(value) - {"num", "den", "scale_pm"}:
        raise ValueError(f"pack {name} must be {{num, den}}")
    num, den = value.get("num"), value.get("den")
    if not _is_int(num) or not _is_int(den) or num < 0 or den <= 0:
        raise ValueError(f"pack {name} must be a non-negative integer ratio")
    return num, den


def load_pack(pack_id: str, version: int) -> CaptionPack:
    """Load and check ``resources/caption-packs/<pack_id>/v<version>.json`` (cached)."""
    if not isinstance(pack_id, str) or not _RESOURCE_ID.fullmatch(pack_id):
        raise ValueError("unknown caption pack")
    if not _is_int(version) or version < 1:  # checked outside the cache: True == 1
        raise ValueError("caption pack version must be a positive integer")
    return _load_pack(pack_id, version)


@functools.cache
def _load_pack(pack_id: str, version: int) -> CaptionPack:
    data, sha = _read_resource(PACKS_DIR / pack_id / f"v{version}.json", "caption pack")
    expected = {"schema", "id", "v", "name", "style_name", "font", "size", "outline", "shadow",
                "border_style", "colours", "margin_side_pm", "reveal", "words_per_cue",
                "max_width_pm", "defaults"}
    if set(data) - {"box_style", "word_box"} != expected or data["schema"] != PACK_SCHEMA:
        raise ValueError("caption pack file does not follow potongin.caption-pack/1")
    if "box_style" in data and data["border_style"] != 3:
        raise ValueError("pack box_style is only for boxed packs (border_style 3)")
    if (data["id"], data["v"]) != (pack_id, version):
        raise ValueError("caption pack id/version do not match its path")
    font, colours, size = data["font"], data["colours"], data["size"]
    if set(font) != {"family", "file", "bold"} or not isinstance(font["bold"], bool):
        raise ValueError("pack font must be {family, file, bold}")
    font_path(font["file"])  # a pinned font listed in fonts.json
    if set(colours) != {"text", "outline", "outline_alpha", "back", "back_alpha"}:
        raise ValueError("pack colours must be {text, outline, outline_alpha, back, back_alpha}")
    for key in ("text", "outline", "back"):
        if not isinstance(colours[key], str) or not _COLOUR.fullmatch(colours[key]):
            raise ValueError("pack colours must be #RRGGBB")
    for key in ("outline_alpha", "back_alpha"):
        if not _is_int(colours[key]) or not 0 <= colours[key] <= 255:
            raise ValueError("pack alphas must be integers 0-255")
    scale = size.get("scale_pm") if isinstance(size, dict) else None
    if not _is_int(scale) or scale <= 0:
        raise ValueError("pack size.scale_pm must be a positive integer")
    max_width = data["max_width_pm"]
    if max_width is not None and (not _is_int(max_width) or not 0 < max_width <= 1000):
        raise ValueError("pack max_width_pm must be null or 1-1000")
    if data["reveal"] not in REVEALS or data["border_style"] not in (1, 3):
        raise ValueError("pack reveal or border_style is not supported")
    if not _is_int(data["words_per_cue"]) or data["words_per_cue"] < 1:
        raise ValueError("pack words_per_cue must be a positive integer")
    if not _is_int(data["margin_side_pm"]) or not 0 <= data["margin_side_pm"] < 500:
        raise ValueError("pack margin_side_pm must be 0-499")
    box_style = data.get("box_style", "border")
    _check_box_style(box_style, border_style=data["border_style"], reveal=data["reveal"],
                     max_width_pm=max_width)
    word_box = _word_box(data.get("word_box"))
    _check_word_box(word_box, border_style=data["border_style"], reveal=data["reveal"],
                    max_width_pm=max_width)
    defaults = data["defaults"]
    _check_overrides(defaults)
    return CaptionPack(
        id=pack_id,
        v=version,
        name=data["name"],
        style_name=data["style_name"],
        font_family=font["family"],
        font_file=font["file"],
        bold=font["bold"],
        size_ratio=_ratio({"num": size.get("num"), "den": size.get("den")}, "size"),
        size_scale_pm=scale,
        outline_ratio=_ratio(data["outline"], "outline"),
        shadow_ratio=_ratio(data["shadow"], "shadow"),
        border_style=data["border_style"],
        text_colour=colours["text"],
        outline_colour=colours["outline"],
        outline_alpha=colours["outline_alpha"],
        back_colour=colours["back"],
        back_alpha=colours["back_alpha"],
        margin_side_pm=data["margin_side_pm"],
        reveal=data["reveal"],
        words_per_cue=data["words_per_cue"],
        max_width_pm=max_width,
        defaults=MappingProxyType({key: defaults[key] for key in _OVERRIDE_KEYS}),
        sha256=sha,
        box_style=box_style,
        word_box=word_box,
    )


def _check_box_style(box_style: object, *, border_style: int, reveal: str,
                     max_width_pm: int | None) -> None:
    if box_style not in BOX_STYLES:
        raise ValueError("pack box_style must be border or vector")
    if box_style == "vector" and (border_style != 3 or reveal != "static"
                                  or max_width_pm is None):
        raise ValueError("pack box_style vector needs a one-line static boxed pack "
                         "(border_style 3, max_width_pm)")


def _word_box(value: object) -> WordBox | None:
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != _WORD_BOX_KEYS:
        raise ValueError("pack word_box must be {pad_x_pm, top_pm, radius_pm, dark_text, "
                         "light_text, dark_from_lstar}")
    for key in ("pad_x_pm", "top_pm", "radius_pm"):
        if not _is_int(value[key]) or not 0 <= value[key] < 1000:
            raise ValueError(f"pack word_box.{key} must be an integer 0-999")
    for key in ("dark_text", "light_text"):
        if not isinstance(value[key], str) or not _COLOUR.fullmatch(value[key]):
            raise ValueError(f"pack word_box.{key} must be #RRGGBB")
    if not _is_int(value["dark_from_lstar"]) or not 0 <= value["dark_from_lstar"] <= 100:
        raise ValueError("pack word_box.dark_from_lstar must be an integer 0-100")
    return WordBox(**{key: value[key] for key in sorted(_WORD_BOX_KEYS)})


def _check_word_box(word_box: WordBox | None, *, border_style: int, reveal: str,
                    max_width_pm: int | None) -> None:
    if (reveal == "word_box") != (word_box is not None):
        raise ValueError("pack word_box comes with the word_box reveal and only with it")
    if word_box is not None and (border_style != 1 or max_width_pm is None):
        raise ValueError("pack word_box needs a one-line pack without a border box "
                         "(border_style 1, max_width_pm)")


def _check_design_ref(design_id: object, version: object) -> None:
    if not isinstance(design_id, str) or not _RESOURCE_ID.fullmatch(design_id):
        raise ValueError("unknown hook design")
    if not _is_int(version) or version < 1:  # checked outside the cache: True == 1
        raise ValueError("hook design version must be a positive integer")


def _hook_design_file(design_id: str, version: int) -> tuple[dict[str, Any], str]:
    _check_design_ref(design_id, version)
    data, sha = _read_resource(HOOK_DESIGNS_DIR / design_id / f"v{version}.json",
                               "hook design")
    if data.get("schema") != HOOK_DESIGN_SCHEMA or (data.get("id"), data.get("v")) != (
        design_id, version
    ):
        raise ValueError("hook design file does not follow potongin.hook-design/1")
    return data, sha


def load_hook_design(design_id: str, version: int) -> dict[str, Any]:
    """The hook design file ``resources/hook-designs/<id>/v<version>.json`` (checked).

    The bar, ``legacy-bar@1``, is today's hook, so revision 0 looks the same: its geometry is
    the code of ``layout_hook`` and its file records the same constants (a test keeps them
    equal). Every other design carries a ``layout`` and is checked field by field
    (``hook_design``).
    """
    data, _sha = _hook_design_file(design_id, version)
    if "layout" in data or (design_id, version) != LEGACY_HOOK_DESIGN:
        hook_design(design_id, version)
    return data


def hook_design(design_id: str, version: int) -> HookDesign | None:
    """The checked design file as a ``HookDesign`` (cached); None for the bar, whose geometry
    is code."""
    _check_design_ref(design_id, version)
    return _hook_design(design_id, version)


@functools.cache
def _hook_design(design_id: str, version: int) -> HookDesign | None:
    data, sha = _hook_design_file(design_id, version)
    if (design_id, version) == LEGACY_HOOK_DESIGN and "layout" not in data:
        return None
    if set(data) != _DESIGN_KEYS:
        raise ValueError("hook design file does not follow potongin.hook-design/1")
    layout = data["layout"]
    if layout not in HOOK_LAYOUTS:
        raise ValueError("hook design layout must be kicker, block or keyword")
    font = data["font"]
    if (not isinstance(font, dict) or set(font) != {"family", "file", "bold"}
            or not isinstance(font["bold"], bool) or not isinstance(font["family"], str)
            or not isinstance(font["file"], str)):
        raise ValueError("hook design font must be {family, file, bold}")
    try:
        font_path(font["file"])
    except (TypeError, ValueError):
        raise ValueError("hook design font must be a pinned font of fonts.json") from None
    if not isinstance(data["name"], str) or not data["name"].strip():
        raise ValueError("hook design name must be a non-empty string")
    ratios = data["font_ratios_e5"]
    if (not isinstance(ratios, list) or not ratios
            or not all(_is_int(value) and 0 < value <= 20_000 for value in ratios)
            or any(later >= earlier for earlier, later in pairwise(ratios))):
        raise ValueError("hook design font_ratios_e5 must be decreasing integers 1-20000")
    for key, low, high in (("max_lines", 1, 5), ("max_chars", HOOK_TEXT_MAX_CHARS,
                                                  HOOK_TEXT_MAX_CHARS),
                           ("side_margin_pm", 0, 499), ("line_pitch_pm", 500, 2000),
                           ("fade_in_ms", 0, 2000), ("fade_out_ms", 0, 2000),
                           ("default_y_e5", 6000, 40_000), ("layer", 1, 9)):
        if not _is_int(data[key]) or not low <= data[key] <= high:
            raise ValueError(f"hook design {key} must be an integer {low}-{high}")
    outline = data["outline"]
    if (not isinstance(outline, dict) or set(outline) != {"num", "den"}
            or not _is_int(outline["num"]) or not _is_int(outline["den"])
            or outline["num"] < 0 or outline["den"] <= 0):
        raise ValueError("hook design outline must be a non-negative integer ratio {num, den}")
    colours = data["colours"]
    if (not isinstance(colours, dict) or set(colours) != {"text", "outline", "accent", "on_accent"}
            or not all(isinstance(value, str) and _COLOUR.fullmatch(value)
                       for value in colours.values())):
        raise ValueError("hook design colours must be {text, outline, accent, on_accent} "
                         "as #RRGGBB")
    box = _design_part(data["box"], "box", HookBox, {"pad_x_pm": (0, 999), "top_pm": (0, 999),
                                                      "radius_pm": (0, 999)})
    kicker = _design_part(data["kicker"], "kicker", HookKicker,
                          {"scale_pm": (1, 1000), "max_words": (1, 10), "gap_pm": (-500, 500)})
    if (layout == "kicker") != (kicker is not None):
        raise ValueError("hook design kicker comes with the kicker layout and only with it")
    if (layout == "kicker") == (box is not None):
        raise ValueError("hook design box comes with the block and keyword layouts only")
    if layout == "block" and colours["text"] != colours["on_accent"]:
        raise ValueError("a block design draws its lines in colours.on_accent: text must equal it")
    return HookDesign(
        id=design_id, v=version, name=data["name"], layout=layout,
        font_family=font["family"], font_file=font["file"], bold=font["bold"],
        font_ratios_e5=tuple(ratios), max_lines=data["max_lines"],
        side_margin_pm=data["side_margin_pm"], line_pitch_pm=data["line_pitch_pm"],
        outline_ratio=(outline["num"], outline["den"]), text_colour=colours["text"],
        outline_colour=colours["outline"], accent=colours["accent"],
        on_accent=colours["on_accent"], box=box, kicker=kicker,
        fade_in_ms=data["fade_in_ms"], fade_out_ms=data["fade_out_ms"],
        default_y_e5=data["default_y_e5"], layer=data["layer"], sha256=sha,
    )


def _design_part(value: object, name: str, kind: type, ranges: Mapping[str, tuple[int, int]]):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != set(ranges):
        raise ValueError(f"hook design {name} must be null or {{{', '.join(ranges)}}}")
    for key, (low, high) in ranges.items():
        if not _is_int(value[key]) or not low <= value[key] <= high:
            raise ValueError(f"hook design {name}.{key} must be an integer {low}-{high}")
    return kind(**value)


def _design_of(design: object) -> HookDesign | None:
    if not isinstance(design, (tuple, list)) or len(design) != 2:
        raise ValueError("hook design must be (id, version)")
    return hook_design(design[0], design[1])


def hook_font_file(design: Sequence) -> str:
    """The font file a hook design draws with (the font ``glyph_unsupported`` checks)."""
    spec = _design_of(design)
    return load_hook_design(*LEGACY_HOOK_DESIGN)["font"]["file"] if spec is None else spec.font_file


def _margin_v(height: int, y_e5: int) -> int:
    """``MarginV = H − y`` of a bottom-anchored caption whose bottom is at ``y_e5``."""
    return div_round_half_up((_E5 - y_e5) * height, _E5)


def _check_overrides(overrides: Mapping[str, Any]) -> None:
    if not isinstance(overrides, Mapping):
        raise TypeError("overrides must be a mapping")
    missing = [key for key in _OVERRIDE_KEYS if key not in overrides]
    if missing:
        raise ValueError(f"overrides lack {', '.join(missing)}")
    if not _is_int(overrides["y_e5"]) or not 0 <= overrides["y_e5"] <= _E5:
        raise ValueError("overrides.y_e5 must be an integer 0-100000")
    if not _is_int(overrides["size_pm"]) or not 1 <= overrides["size_pm"] <= 10_000:
        raise ValueError("overrides.size_pm must be an integer 1-10000")
    if overrides["case"] not in CASES:
        raise ValueError("overrides.case must be asis or upper")
    for key in ("highlight", "emphasis"):
        if not isinstance(overrides[key], str) or not _COLOUR.fullmatch(overrides[key]):
            raise ValueError(f"overrides.{key} must be #RRGGBB (uppercase)")
    if "words_max" in overrides:
        low, high = WORDS_MAX_RANGE
        if not _is_int(overrides["words_max"]) or not low <= overrides["words_max"] <= high:
            raise ValueError(f"overrides.words_max must be an integer {low}-{high}")


def words_per_cue(pack: CaptionPack, overrides: Mapping[str, Any]) -> int:
    """At most this many words per caption line: ``words_max`` when set, else the pack's."""
    return overrides.get("words_max", pack.words_per_cue)


def _srgb_linear(channel: int) -> float:
    value = channel / 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def lightness(colour: str) -> float:
    """CIE L* (0-100) of an sRGB ``#RRGGBB`` colour, from its relative luminance (D65)."""
    red, green, blue = (int(colour[index:index + 2], 16) for index in (1, 3, 5))
    luminance = (0.2126 * _srgb_linear(red) + 0.7152 * _srgb_linear(green)
                 + 0.0722 * _srgb_linear(blue))
    if luminance <= (6 / 29) ** 3:
        return luminance * (29 / 3) ** 3
    return 116 * luminance ** (1 / 3) - 16


def word_box_text(colour: str, box: WordBox) -> str:
    """The colour of the spoken word on a box of ``colour``: dark on a light box."""
    return box.dark_text if lightness(colour) >= box.dark_from_lstar else box.light_text


def _display(text: str, case: str) -> str:
    return text.upper() if case == "upper" else text


def _inline_colour(colour: str) -> str:
    """``#RRGGBB`` as an override colour ``&HBBGGRR&``."""
    return f"&H{colour[5:7]}{colour[3:5]}{colour[1:3]}&"


def _centi_text(cents: int) -> str:
    whole, fraction = divmod(cents, 100)
    return str(whole) if fraction == 0 else f"{whole}.{fraction:02d}".rstrip("0")


def _pack_font_size(pack: CaptionPack, height: int, size_pm: int) -> int:
    num, den = pack.size_ratio
    return max(1, div_round_half_up(height * num * pack.size_scale_pm * size_pm,
                                    den * 1_000_000))


def _fits(text: str, font: Path, font_size: int, max_width_pm: int, width: int) -> bool:
    units, height_units = advance_units(text, font)
    return 1000 * font_size * units <= max_width_pm * width * height_units


def fit_cues(
    cues: Sequence[FrameCue], *, pack: CaptionPack, play_res: tuple[int, int],
    overrides: Mapping[str, Any],
) -> tuple[FrameCue, ...]:
    """Cues as the pack shows them: one-line packs (``box``) split wider cues (plan §5.4).

    A cue whose displayed text is wider than ``max_width_pm`` of the output width (measured from
    the pack font's ``hmtx``) is split greedily at word boundaries; each part runs from its first
    word's frame to the next part's. A single word that is still too wide stays one cue (its
    font is reduced when the ASS is written). Other packs return the cues unchanged; the
    function is idempotent.
    """
    if pack.max_width_pm is None:
        return tuple(cues)
    width, height = play_res
    size = _pack_font_size(pack, height, overrides["size_pm"])
    font = font_path(pack.font_file)
    case = overrides["case"]
    fitted: list[FrameCue] = []
    for cue in cues:
        chunks: list[list[FrameWord]] = []
        for word in cue.words:
            candidate = [*chunks[-1], word] if chunks else [word]
            text = " ".join(_display(item.text, case) for item in candidate)
            if chunks and _fits(text, font, size, pack.max_width_pm, width):
                chunks[-1].append(word)
            else:
                chunks.append([word])
        if len(chunks) == 1:
            fitted.append(cue)
            continue
        starts = [cue.f0] + [chunk[0].f0 for chunk in chunks[1:]]
        ends = starts[1:] + [cue.f1]
        for chunk, start, end in zip(chunks, starts, ends, strict=True):
            if start < end:  # a part with no frames is never visible
                words = tuple(dataclass_replace(w, f1=min(w.f1, end)) for w in chunk)
                fitted.append(FrameCue(start, end, cue.seg, words))
    return tuple(fitted)


def layout_hook(text: str, *, play_res: tuple[int, int], y_e5: int,
                design: Sequence = LEGACY_HOOK_DESIGN) -> HookLayout:
    """The layout of a hook text in ``design``, its top at y_e5.

    The bar (``legacy-bar@1``) is today's ``_hook_layout``. Every design takes the largest of
    its sizes whose lines fit (at most ``max_lines``); ``overflow`` is true when the text does
    not fit at the smallest size and its tail is cut with "…" (the ``hook_overflow`` warning).
    """
    width, height = play_res
    spec = _design_of(design)
    top = div_round_half_up(y_e5 * height, _E5)
    cleaned = clean_caption_text(text)
    hook = shorten_hook_text(text) if cleaned else ""
    if spec is not None:
        if not hook:
            return HookLayout(1, 0, top, (), False, layer=spec.layer)
        return _design_layout(spec, hook, play_res=(width, height), top=top,
                              cut=hook != cleaned)
    if not hook:
        return HookLayout(1, max(1, round(height * _HOOK_BOX_PADDING_RATIO)), top, (), False)
    font_size, padding, lines, overflow = _hook_layout_checked(hook, width=width,
                                                               height=height)
    return HookLayout(font_size, padding, top, lines, overflow or hook != cleaned)


def boxed_word_index(tokens: Sequence[str]) -> int:
    """The word Kotak kata boxes: the first written in capitals (two letters or more) unless
    every word is, else the longest by letters and digits (the last of equals)."""
    letters = [[character for character in token if character.isalpha()] for token in tokens]
    lettered = [index for index, chars in enumerate(letters) if chars]
    capitals = [index for index in lettered
                if len(letters[index]) >= 2 and all(char.isupper() for char in letters[index])]
    if capitals and len(capitals) < len(lettered):
        return capitals[0]
    sizes = [sum(character.isalnum() for character in token) for token in tokens]
    longest = max(sizes)
    return max(index for index, size in enumerate(sizes) if size == longest)


def _kicker_count(words: Sequence[str], kicker: HookKicker) -> int:
    """How many leading words form the kicker line: through the first word ending with a mark
    (``: ? ! . , ; …``) among the first ``max_words`` (never the last word), else a third of the
    words (one to three). Fewer than three words have no kicker."""
    if len(words) < 3:
        return 0
    for index in range(min(kicker.max_words, len(words) - 1)):
        if words[index].endswith(_KICKER_MARKS):
            return index + 1
    return max(1, min(len(words) // 3, 3))


def _fits_units(text: str, font: Path, font_size: int, usable: int) -> bool:
    units, height_units = advance_units(_drawn_text(text), font)
    return units * font_size <= usable * height_units


def _wrap_units(words: Sequence[str], font: Path, font_size: int, usable: int) -> list[str]:
    """Greedy word wrap by exact ``hmtx`` advances; a word wider than a line is split."""
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}" if current else word
        if _fits_units(candidate, font, font_size, usable):
            current = candidate
            continue
        if current:
            lines.append(current)
        pieces: list[str] = []
        piece = ""
        for character in word:
            if piece and not _fits_units(piece + character, font, font_size, usable):
                pieces.append(piece)
                piece = ""
            piece += character
        pieces.append(piece)
        lines.extend(pieces[:-1])
        current = pieces[-1]
    if current:
        lines.append(current)
    return lines


def _design_layout(spec: HookDesign, hook: str, *, play_res: tuple[int, int], top: int,
                   cut: bool) -> HookLayout:
    """Lines, style and events of ``hook`` in a design other than the bar (CONTRACTS §5.33)."""
    width, height = play_res
    font = font_path(spec.font_file)
    side = div_round_half_up(width * spec.side_margin_pm, 1000)
    num, den = spec.outline_ratio
    outline_cp = div_round_half_up(100 * height * num, den)
    words = hook.split(" ")
    lead = _kicker_count(words, spec.kicker) if spec.kicker is not None else 0
    body = words[lead:]
    overflow = cut
    size, usable, lines = 1, 1, []
    for ratio in spec.font_ratios_e5:
        size = max(1, div_round_half_up(height * ratio, _E5))
        edge = -(-outline_cp // 100)
        if spec.box is not None:
            edge = max(edge, div_round_half_up(size * spec.box.pad_x_pm, 1000))
        usable = max(1, width - 2 * side - 2 * edge)
        lines = _wrap_units(body, font, size, usable)
        if len(lines) <= spec.max_lines:
            break
    else:
        tail = " ".join(lines[spec.max_lines - 1:])
        while len(tail) > 2 and not _fits_units(tail, font, size, usable):
            tail = shorten_hook_text(tail, max_chars=len(tail) - 1)
        lines = [*lines[:spec.max_lines - 1], tail]
        overflow = True

    fade = f"\\fad({spec.fade_in_ms},{spec.fade_out_ms})"
    centre = _centi_text(50 * width)
    pitch = div_round_half_up(size * spec.line_pitch_pm, 1000)
    events: list[str] = []
    shown = tuple(lines)
    if spec.kicker is not None:
        first = top + size
        if lead:
            kicker = " ".join(words[:lead])
            kicker_size = max(1, div_round_half_up(size * spec.kicker.scale_pm, 1000))
            if not _fits_units(kicker, font, kicker_size, usable):
                units, height_units = advance_units(_drawn_text(kicker), font)
                kicker_size = max(1, usable * height_units // units)
            outline = _centi_text(div_round_half_up(outline_cp * kicker_size, size))
            events.append(f"{{{fade}\\an2\\pos({centre},{top + kicker_size})\\q2"
                          f"\\fs{kicker_size}\\bord{outline}\\1c{_inline_colour(spec.accent)}}}"
                          f"{ass_escape(kicker)}")
            first = (top + kicker_size + div_round_half_up(size * spec.kicker.gap_pm, 1000)
                     + size)
            shown = (kicker, *lines)
        events += [f"{{{fade}\\an2\\pos({centre},{first + index * pitch})\\q2}}{ass_escape(line)}"
                   for index, line in enumerate(lines)]
    else:
        box = spec.box
        box_h = size - div_round_half_up(size * box.top_pm, 1000)
        pad = div_round_half_up(size * box.pad_x_pm, 1000)
        radius = div_round_half_up(size * box.radius_pm, 1000)
        accent = _inline_colour(spec.accent)
        first = top + box_h  # the first line's bottom: its box's top is the hook's top

        def box_event(x: str, bottom: int, units: int, height_units: int) -> str:
            box_w = div_round_half_up(size * units, height_units) + 2 * pad
            return (f"{{{fade}\\an2\\pos({x},{bottom})\\bord0\\shad0\\1c{accent}\\p1}}"
                    f"{_box_path(box_w, box_h, radius)}{{\\p0}}")

        tokens = [token for line in lines for token in line.split(" ")]
        boxed = boxed_word_index(tokens) if spec.layout == "keyword" else None
        seen = 0
        for index, line in enumerate(lines):
            bottom = first + index * pitch
            parts = line.split(" ")
            if spec.layout == "block":
                units, height_units = advance_units(_drawn_text(line), font)
                events.append(box_event(centre, bottom, units, height_units))
            if boxed is None or not seen <= boxed < seen + len(parts):
                events.append(f"{{{fade}\\an2\\pos({centre},{bottom})\\q2}}{ass_escape(line)}")
            else:
                events += _keyword_line(parts, boxed - seen, font=font, size=size,
                                        width=width, bottom=bottom, fade=fade,
                                        on_accent=_inline_colour(spec.on_accent),
                                        box_event=box_event)
            seen += len(parts)
    style = _style_line(
        "Hook",
        font_name=spec.font_family,
        font_size=size,
        primary=_ass_color(spec.text_colour),
        secondary=_ass_color(spec.text_colour),
        outline_color=_ass_color(spec.outline_colour),
        back_color=_ass_color(spec.outline_colour),
        bold=spec.bold,
        border_style=1,
        outline=_centi_text(outline_cp),
        shadow="0",
        alignment=2,
        margin_side=side,
        margin_vertical=0,
    )
    padding = div_round_half_up(size * spec.box.pad_x_pm, 1000) if spec.box is not None else 0
    return HookLayout(size, padding, top, shown, overflow, style=style, events=tuple(events),
                      layer=spec.layer)


def _keyword_line(parts: Sequence[str], boxed: int, *, font: Path, size: int, width: int,
                  bottom: int, fade: str, on_accent: str,
                  box_event: Callable[[str, int, int, int], str]) -> list[str]:
    """The line holding the boxed word, one ``\\pos`` event per word at its place in the line
    centred on ``W/2`` (``hmtx`` advances, as Sorot), the box right before its word."""
    advances = [advance_units(_drawn_text(part), font)[0] for part in parts]
    space, height_units = advance_units(" ", font)
    total = sum(advances) + space * (len(parts) - 1)
    events, left = [], 0
    for index, (part, advance) in enumerate(zip(parts, advances, strict=True)):
        x = _centi_text(50 * width + div_round_half_up(100 * size * (2 * left + advance - total),
                                                       2 * height_units))
        if index == boxed:
            events.append(box_event(x, bottom, advance, height_units))
            events.append(f"{{{fade}\\an2\\pos({x},{bottom})\\q2\\bord0\\shad0\\1c{on_accent}}}"
                          f"{ass_escape(part)}")
        else:
            events.append(f"{{{fade}\\an2\\pos({x},{bottom})\\q2}}{ass_escape(part)}")
        left += advance + space
    return events


def _ass_time_cs(centiseconds: int) -> str:
    hours, remainder = divmod(max(0, centiseconds), 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{fraction:02d}"


def _wrap(text: str, colour: str | None, reset: str) -> str:
    return text if colour is None else f"{{\\1c{colour}}}{text}{{\\1c{reset}}}"


def _karaoke_line(cue: FrameCue, *, start_cs: int, end_cs: int, fps: Fps, case: str,
                  primary: str, secondary: str, emphasis: str) -> str:
    boundaries = [start_cs]
    for word in cue.words[1:]:
        boundaries.append(min(max(safe_cs(word.f0, fps), boundaries[-1]), end_cs))
    boundaries.append(end_cs)
    parts = []
    for index, word in enumerate(cue.words):
        tags = f"\\k{boundaries[index + 1] - boundaries[index]}"
        text = ass_escape(_display(word.text, case))
        if word.emphasis:  # defect #6: the emphasis colour before and after the highlight
            parts.append(f"{{{tags}\\1c{emphasis}\\2c{emphasis}}}{text}"
                         f"{{\\1c{primary}\\2c{secondary}}}")
        else:
            parts.append(f"{{{tags}}}{text}")
    return " ".join(parts)


def _caption_events(cues: Sequence[FrameCue], *, pack: CaptionPack, fps: Fps,
                    play_res: tuple[int, int], overrides: Mapping[str, Any]) -> list[str]:
    case = overrides["case"]
    text_colour = _inline_colour(pack.text_colour)
    emphasis = _inline_colour(overrides["emphasis"])
    highlight = _inline_colour(overrides["highlight"])

    def event(first: int, last: int, text: str) -> str:
        start, end = _ass_time_cs(max(0, safe_cs(first, fps))), _ass_time_cs(safe_cs(last, fps))
        return f"Dialogue: 0,{start},{end},{pack.style_name},,0,0,0,,{text}"

    def static(words: Sequence[FrameWord], active: int | None = None) -> str:
        return " ".join(
            _wrap(ass_escape(_display(word.text, case)),
                  emphasis if word.emphasis else highlight if index == active else None,
                  text_colour)
            for index, word in enumerate(words)
        )

    events = []
    width, height = play_res
    for cue in fit_cues(cues, pack=pack, play_res=play_res, overrides=overrides):
        if pack.reveal == "karaoke":
            start_cs = max(0, safe_cs(cue.f0, fps))
            events.append(event(cue.f0, cue.f1, _karaoke_line(
                cue, start_cs=start_cs, end_cs=safe_cs(cue.f1, fps), fps=fps, case=case,
                primary=_inline_colour(overrides["highlight"]), secondary=text_colour,
                emphasis=emphasis)))
        elif pack.reveal == "word_box":
            events += _word_box_events(cue, pack=pack, play_res=play_res, overrides=overrides,
                                       event=event)
        elif pack.reveal == "word":
            # One event per active word, the whole cue in each, only \1c differs: the glyphs
            # never reflow between events.
            starts = [cue.f0] + [word.f0 for word in cue.words[1:]]
            ends = starts[1:] + [cue.f1]
            events += [event(first, last, static(cue.words, active=index))
                       for index, (first, last) in enumerate(zip(starts, ends, strict=True))
                       if first < last]
        elif pack.max_width_pm is not None:
            tags = "\\q2"
            display = " ".join(_display(word.text, case) for word in cue.words)
            font = font_path(pack.font_file)
            size = _pack_font_size(pack, height, overrides["size_pm"])
            if len(cue.words) == 1 and not _fits(display, font, size, pack.max_width_pm, width):
                units, height_units = advance_units(display, font)
                size = max(1, pack.max_width_pm * width * height_units // (1000 * units))
                tags += f"\\fs{size}"
            if pack.box_style == "vector":
                events.append(event(cue.f0, cue.f1, _vector_box(
                    display, font, size, pack=pack, play_res=play_res, overrides=overrides)))
            events.append(event(cue.f0, cue.f1, f"{{{tags}}}{static(cue.words)}"))
        else:
            events.append(event(cue.f0, cue.f1, static(cue.words)))
    return events


def _vector_box(text: str, font: Path, font_size: int, *, pack: CaptionPack,
                play_res: tuple[int, int], overrides: Mapping[str, Any]) -> str:
    """The ``\\p`` rectangle a ``box_style: vector`` pack draws behind one caption line.

    It covers what libass' BorderStyle 3 box covers: the line's advance (from ``hmtx``) and its
    font size (ascent + descent), padded by the pack outline on every side, in the outline
    colour and alpha, bottom-centred on the line's bottom plus the padding.
    """
    width, height = play_res
    num, den = pack.outline_ratio
    pad = div_round_half_up(height * num, den)
    units, height_units = advance_units(_drawn_text(text), font)
    box_w = div_round_half_up(font_size * units, height_units) + 2 * pad
    box_h = font_size + 2 * pad
    bottom = height - _margin_v(height, overrides["y_e5"]) + pad
    return (f"{{\\an2\\pos({_centi_text(50 * width)},{bottom})\\bord0\\shad0"
            f"\\1c{_inline_colour(pack.outline_colour)}\\1a&H{pack.outline_alpha:02X}&\\p1}}"
            f"{_box_path(box_w, box_h, 0)}{{\\p0}}")


def _box_path(width: int, height: int, radius: int) -> str:
    """A ``\\p1`` rectangle from (0, 0) to (width, height); corners rounded by ``radius``
    (capped at half the shorter side) with one cubic Bézier each."""
    radius = min(radius, width // 2, height // 2)
    if radius <= 0:
        return f"m 0 0 l {width} 0 {width} {height} 0 {height}"
    w, h, r = width, height, radius
    k = div_round_half_up(r * 4477, 10_000)  # 1 − 0.5523: the circle's control-point offset
    return (f"m {r} 0 l {w - r} 0 b {w - k} 0 {w} {k} {w} {r} l {w} {h - r} "
            f"b {w} {h - k} {w - k} {h} {w - r} {h} l {r} {h} b {k} {h} 0 {h - k} 0 {h - r} "
            f"l 0 {r} b 0 {k} {k} 0 {r} 0")


def _word_box_events(cue: FrameCue, *, pack: CaptionPack, play_res: tuple[int, int],
                     overrides: Mapping[str, Any],
                     event: Callable[[int, int, str], str]) -> list[str]:
    """One window per spoken word: every other word of the line, the box, then the spoken word.

    Each word is its own ``\\pos`` event at its place in the centred line (``hmtx``
    advances), so no word moves between windows and the box shares the spoken word's centre:
    kerning inside a word only makes the box a little wider on both sides.
    """
    box = pack.word_box
    width, height = play_res
    case = overrides["case"]
    font = font_path(pack.font_file)
    size = _pack_font_size(pack, height, overrides["size_pm"])
    shown = [_display(word.text, case) for word in cue.words]
    size_tag = ""
    line = " ".join(shown)
    if len(cue.words) == 1 and not _fits(line, font, size, pack.max_width_pm, width):
        units, height_units = advance_units(line, font)
        size = max(1, pack.max_width_pm * width * height_units // (1000 * units))
        size_tag = f"\\fs{size}"
    advances = [advance_units(_drawn_text(text), font)[0] for text in shown]
    space, height_units = advance_units(" ", font)
    total = sum(advances) + space * (len(advances) - 1)
    centres, left = [], 0
    for advance in advances:  # 2 × the word's centre from the line's left edge, in font units
        twice = 2 * left + advance
        centres.append(_centi_text(50 * width + div_round_half_up(
            100 * size * (twice - total), 2 * height_units)))
        left += advance + space
    bottom = height - _margin_v(height, overrides["y_e5"])
    pad = div_round_half_up(size * box.pad_x_pm, 1000)
    box_h = size - div_round_half_up(size * box.top_pm, 1000)
    radius = div_round_half_up(size * box.radius_pm, 1000)

    def word_event(first: int, last: int, index: int, extra: str) -> str:
        return event(first, last, f"{{\\an2\\pos({centres[index]},{bottom})\\q2{size_tag}"
                                  f"{extra}}}{ass_escape(shown[index])}")

    starts = [cue.f0] + [word.f0 for word in cue.words[1:]]
    ends = starts[1:] + [cue.f1]
    events = []
    for active, (first, last) in enumerate(zip(starts, ends, strict=True)):
        if first >= last:
            continue
        for index, word in enumerate(cue.words):
            if index != active:
                colour = f"\\1c{_inline_colour(overrides['emphasis'])}" if word.emphasis else ""
                events.append(word_event(first, last, index, colour))
        colour = overrides["emphasis"] if cue.words[active].emphasis else overrides["highlight"]
        box_w = div_round_half_up(size * advances[active], height_units) + 2 * pad
        events.append(event(first, last, f"{{\\an2\\pos({centres[active]},{bottom})"
                                         f"\\bord0\\shad0\\1c{_inline_colour(colour)}\\p1}}"
                                         f"{_box_path(box_w, box_h, radius)}{{\\p0}}"))
        text = _inline_colour(word_box_text(colour, box))
        events.append(word_event(first, last, active, f"\\bord0\\shad0\\1c{text}"))
    return events


def _pack_style(pack: CaptionPack, *, play_res: tuple[int, int],
                overrides: Mapping[str, Any]) -> str:
    width, height = play_res
    primary = overrides["highlight"] if pack.reveal == "karaoke" else pack.text_colour
    outline_num, outline_den = pack.outline_ratio
    shadow_num, shadow_den = pack.shadow_ratio
    outline = _centi_text(div_round_half_up(100 * height * outline_num, outline_den))
    shadow = _centi_text(div_round_half_up(100 * height * shadow_num, shadow_den))
    border_style = pack.border_style
    if pack.box_style == "vector":  # the box is its own event; the text has no border
        border_style, outline, shadow = 1, "0", "0"
    return _style_line(
        pack.style_name,
        font_name=pack.font_family,
        font_size=_pack_font_size(pack, height, overrides["size_pm"]),
        primary=_ass_color(primary),
        secondary=_ass_color(pack.text_colour),
        outline_color=_ass_color(pack.outline_colour, alpha=pack.outline_alpha),
        back_color=_ass_color(pack.back_colour, alpha=pack.back_alpha),
        bold=pack.bold,
        border_style=border_style,
        outline=outline,
        shadow=shadow,
        alignment=2,
        margin_side=div_round_half_up(width * pack.margin_side_pm, 1000),
        margin_vertical=_margin_v(height, overrides["y_e5"]),
    )


def build_ass_v2(
    cues: Sequence[FrameCue],
    *,
    play_res: tuple[int, int],
    fps: Fps,
    total_frames: int,
    pack: CaptionPack,
    overrides: Mapping,
    hook: HookSpec | None,
) -> str:
    """The ASS document of a clip-edit-v2 document (plan §5.4): captions plus the hook.

    ``cues`` are output-frame cues (``subtitles.build_frame_cues``). Every event visible on
    output frames ``[a, b)`` is written ``Start = safe_cs(a)`` (clamped to 0) and
    ``End = safe_cs(b)``; karaoke ``\\k`` durations are differences of ``safe_cs``, so libass in
    FFmpeg and in JASSUB switch exactly on the planned frame (the graph sets
    ``settb=den/num``). The header, the ``classic``/``karaoke`` style lines and the
    ``legacy-bar`` hook equal ``build_ass`` for the same size, so revision 0 looks the same.
    Emphasised words get the ``emphasis`` colour (defect #6); all text goes through
    ``ass_escape``. A ``box_style: vector`` pack draws each box as a ``\\p`` rectangle event
    right before its line (plan §5.4, the fallback if BorderStyle 3 fails P-TXT); a
    ``word_box`` pack draws a rounded ``\\p`` box behind the spoken word (CONTRACTS §5.30). A
    hook in a design other than the bar writes that design's style and events (§5.33).
    """
    if (not isinstance(play_res, (tuple, list)) or len(play_res) != 2
            or not all(_is_int(value) and value > 0 for value in play_res)):
        raise ValueError("play_res must be two positive integers")
    width, height = play_res
    if not isinstance(fps, Fps):
        raise TypeError("fps must be a timemap.Fps")
    if not _is_int(total_frames) or total_frames < 1:
        raise ValueError("total_frames must be a positive integer")
    if not isinstance(pack, CaptionPack):
        raise TypeError("pack must be a CaptionPack (load_pack)")
    _check_box_style(pack.box_style, border_style=pack.border_style, reveal=pack.reveal,
                     max_width_pm=pack.max_width_pm)
    _check_word_box(pack.word_box, border_style=pack.border_style, reveal=pack.reveal,
                    max_width_pm=pack.max_width_pm)
    _check_overrides(overrides)
    for cue in cues:
        if not isinstance(cue, FrameCue):
            raise TypeError("cues must be FrameCue values")
        if cue.f1 > total_frames:
            raise ValueError("caption cue ends after the clip")

    styles = [_pack_style(pack, play_res=(width, height), overrides=overrides)]
    events = _caption_events(cues, pack=pack, fps=fps, play_res=(width, height),
                             overrides=overrides)
    if hook is not None:
        if not isinstance(hook, HookSpec) or not isinstance(hook.text, str):
            raise TypeError("hook must be a HookSpec")
        if not (_is_int(hook.f0) and _is_int(hook.f1) and 0 <= hook.f0 < hook.f1):
            raise ValueError("hook must satisfy 0 <= f0 < f1")
        if hook.f0 >= total_frames:
            raise ValueError("hook starts after the clip")
        if not _is_int(hook.y_e5) or not 0 <= hook.y_e5 <= _E5:
            raise ValueError("hook y_e5 must be an integer 0-100000")
        layout = layout_hook(hook.text, play_res=(width, height), y_e5=hook.y_e5,
                             design=hook.design)
        if layout.events:
            start = _ass_time_cs(max(0, safe_cs(hook.f0, fps)))
            end_cs = _ass_time_cs(safe_cs(min(hook.f1, total_frames), fps))
            events += [f"Dialogue: {layout.layer},{start},{end_cs},Hook,,0,0,0,,{text}"
                       for text in layout.events]
            styles.append(layout.style)
        elif layout.lines:
            end = min(hook.f1, total_frames)
            events += _hook_events(
                layout.lines, start=_ass_time_cs(max(0, safe_cs(hook.f0, fps))),
                end=_ass_time_cs(safe_cs(end, fps)), width=width, top=layout.top,
                font_size=layout.font_size, padding=layout.padding)
            styles.append(_hook_style(font_size=layout.font_size, padding=layout.padding,
                                      width=width, top=layout.top))
    return _script_header(width, height, styles) + "\n".join(events) + ("\n" if events else "")
