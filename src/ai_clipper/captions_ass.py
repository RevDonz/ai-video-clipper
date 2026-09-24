"""ASS documents for burned captions (classic or karaoke) and the on-screen hook text."""

from __future__ import annotations

import math
import string
import unicodedata
from collections.abc import Sequence
from numbers import Real

from .subtitles import CaptionCue, clean_caption_text

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


def _hook_layout(text: str, *, width: int, height: int) -> tuple[int, int, tuple[str, ...]]:
    """Pick the largest hook font whose wrapped text fits in HOOK_MAX_LINES lines."""
    side_margin = round(width * _HOOK_SIDE_MARGIN_RATIO)
    padding = max(1, round(height * _HOOK_BOX_PADDING_RATIO))
    usable = max(1, width - 2 * side_margin - 2 * padding)
    lines: list[str] = []
    font_size = 1
    for ratio in _HOOK_FONT_RATIOS:
        font_size = max(1, round(height * ratio))
        lines = _wrap_to_width(text, font_size, usable)
        if len(lines) <= HOOK_MAX_LINES:
            return font_size, padding, tuple(lines)
    kept = lines[: HOOK_MAX_LINES - 1]
    tail = " ".join(lines[HOOK_MAX_LINES - 1 :])
    while len(tail) > 2 and estimate_text_width(tail, font_size) > usable:
        tail = shorten_hook_text(tail, max_chars=len(tail) - 1)
    kept.append(tail)
    return font_size, padding, tuple(kept)


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
    outline: float,
    shadow: float,
    alignment: int,
    margin_side: int,
    margin_vertical: int,
) -> str:
    return (
        f"Style: {name},{FONT_NAME},{font_size},{primary},{secondary},{outline_color},"
        f"{back_color},{-1 if bold else 0},0,0,0,100,100,0,0,{border_style},"
        f"{_ass_number(outline)},{_ass_number(shadow)},{alignment},{margin_side},{margin_side},"
        f"{margin_vertical},1"
    )


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
        # One event per line: libass draws a BorderStyle 3 box per line, and boxes of a
        # multi-line event overlap (double-dark bands). Lines stacked one box-height apart
        # touch exactly instead; \q2 keeps libass from re-wrapping a pre-wrapped line.
        pitch = hook_font + 2 * hook_padding
        for index, line in enumerate(lines):
            y = hook_top + hook_padding + index * pitch
            events.append(
                f"Dialogue: 1,{_ass_time(0.0)},{_ass_time(hook_end)},Hook,,0,0,0,,"
                f"{{\\fad({HOOK_FADE_IN_MS},{HOOK_FADE_OUT_MS})\\an8\\q2\\pos({width // 2},{y})}}"
                f"{ass_escape(line)}"
            )
    styles.append(
        _style_line(
            "Hook",
            font_size=hook_font,
            primary=white,
            secondary=white,
            outline_color=_ass_color("#000000", alpha=_HOOK_BOX_ALPHA),
            back_color=_ass_color("#000000", alpha=_HOOK_BOX_ALPHA),
            bold=True,
            border_style=3,
            outline=hook_padding,
            shadow=0,
            alignment=8,
            margin_side=round(width * _HOOK_SIDE_MARGIN_RATIO),
            margin_vertical=hook_top,
        )
    )

    header = (
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
    return header + "\n".join(events) + ("\n" if events else "")
