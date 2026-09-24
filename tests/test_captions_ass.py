import re
import unicodedata
from itertools import pairwise

import pytest

from ai_clipper.captions_ass import (
    HOOK_TEXT_MAX_CHARS,
    ass_escape,
    build_ass,
    estimate_text_width,
    shorten_hook_text,
)
from ai_clipper.subtitles import CaptionCue, CaptionWord

_TAG = re.compile(r"\{[^}]*\}")
_HOOK_PREFIX = re.compile(r"\{\\fad\(150,250\)\\an8\\q2\\pos\((?P<x>\d+),(?P<y>\d+)\)\}")


def _cue(*words: tuple[float, float, str], end: float | None = None) -> CaptionCue:
    caption_words = tuple(CaptionWord(start, stop, text) for start, stop, text in words)
    return CaptionCue(
        caption_words[0].start,
        caption_words[-1].end if end is None else end,
        caption_words,
    )


def _sections(document: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current = ""
    for line in document.splitlines():
        if line.startswith("[") and line.endswith("]"):
            current = line
            sections[current] = []
        elif line:
            sections[current].append(line)
    return sections


def _styles(document: str) -> dict[str, dict[str, str]]:
    lines = _sections(document)["[V4+ Styles]"]
    fields = [name.strip() for name in lines[0].removeprefix("Format:").split(",")]
    styles = {}
    for line in lines[1:]:
        values = [value.strip() for value in line.removeprefix("Style:").split(",")]
        style = dict(zip(fields, values, strict=True))
        styles[style["Name"]] = style
    return styles


def _events(document: str) -> list[dict[str, str]]:
    lines = _sections(document)["[Events]"]
    fields = [name.strip() for name in lines[0].removeprefix("Format:").split(",")]
    events = []
    for line in lines[1:]:
        kind, _, rest = line.partition(":")
        assert kind == "Dialogue"
        values = rest.strip().split(",", len(fields) - 1)
        events.append(dict(zip(fields, values, strict=True)))
    return events


def _centiseconds(timestamp: str) -> int:
    hours, minutes, seconds = timestamp.split(":")
    whole, fraction = seconds.split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(whole)) * 100 + int(fraction)


def _script_info(document: str) -> dict[str, str]:
    info = {}
    for line in _sections(document)["[Script Info]"]:
        key, _, value = line.partition(":")
        info[key.strip()] = value.strip()
    return info


def test_header_uses_output_size_as_play_resolution():
    document = build_ass((), width=720, height=1280, duration=10.0)

    info = _script_info(document)
    assert info["PlayResX"] == "720"
    assert info["PlayResY"] == "1280"
    assert info["ScriptType"] == "v4.00+"
    assert info["ScaledBorderAndShadow"] == "yes"


def test_classic_caption_style_keeps_the_historical_look_in_the_bottom_safe_area():
    style = _styles(build_ass((), width=1080, height=1920, duration=10.0))["Caption"]

    assert style["Fontname"] == "DejaVu Sans"
    assert style["PrimaryColour"] == "&H00FFFFFF"
    assert style["OutlineColour"] == "&H00000000"
    assert style["BorderStyle"] == "1"
    assert style["Alignment"] == "2"
    assert style["Bold"] == "0"
    # FontSize=12 on libass' default 288-line canvas, scaled to the real output height.
    assert int(style["Fontsize"]) == 80
    assert float(style["Outline"]) > 0
    assert 0.15 * 1920 <= int(style["MarginV"]) <= 0.19 * 1920


def test_classic_events_are_plain_text_with_cue_timing():
    cues = (_cue((0.1, 0.4, "Gue"), (0.4, 0.8, "bukan"), (0.8, 1.5, "jambret.")),)

    events = _events(build_ass(cues, width=720, height=1280, duration=10.0))

    assert events == [
        {
            "Layer": "0",
            "Start": "0:00:00.10",
            "End": "0:00:01.50",
            "Style": "Caption",
            "Name": "",
            "MarginL": "0",
            "MarginR": "0",
            "MarginV": "0",
            "Effect": "",
            "Text": "Gue bukan jambret.",
        }
    ]


def test_karaoke_words_turn_highlight_colour_as_they_are_spoken():
    cues = (
        _cue((1.0, 1.3, "Kode"), (1.35, 1.9, "rahasia"), (1.9, 2.4, "copet"), end=2.7),
        _cue((63.21, 63.5, "mutus-mutus!")),
    )

    document = build_ass(cues, width=720, height=1280, duration=70.0, caption_style="karaoke")

    style = _styles(document)["Karaoke"]
    assert style["PrimaryColour"] == "&H004DE1FF"
    assert style["SecondaryColour"] == "&H00FFFFFF"
    assert style["Fontname"] == "DejaVu Sans"
    assert style["Alignment"] == "2"
    assert style["MarginV"] == _styles(document)["Caption"]["MarginV"]
    events = _events(document)
    assert [event["Style"] for event in events] == ["Karaoke", "Karaoke"]
    first = events[0]
    durations = [int(value) for value in re.findall(r"\{\\k(\d+)\}", first["Text"])]
    assert durations == [35, 55, 80]
    assert sum(durations) == _centiseconds(first["End"]) - _centiseconds(first["Start"])
    assert _TAG.sub("", first["Text"]) == "Kode rahasia copet"
    second = events[1]
    assert second["Start"] == "0:01:03.21"
    second_durations = [int(value) for value in re.findall(r"\{\\k(\d+)\}", second["Text"])]
    assert sum(second_durations) == _centiseconds(second["End"]) - _centiseconds(second["Start"])


def test_karaoke_can_uppercase_words():
    cues = (_cue((0.0, 0.5, "gue"), (0.5, 1.0, "bukan")),)

    document = build_ass(
        cues, width=720, height=1280, duration=5.0, caption_style="karaoke", uppercase=True
    )

    assert _TAG.sub("", _events(document)[0]["Text"]) == "GUE BUKAN"


@pytest.mark.parametrize(
    "text",
    [
        "{\\b1}bold{\\r}",
        "a\\Nb\\nc\\hd",
        "line\nbreak\r\nand\ttab",
        "bell\x07escape\x1bnull\x00",
        "}{",
        "trailing\\",
    ],
)
def test_escape_neutralizes_override_syntax_and_control_characters(text: str):
    escaped = ass_escape(text)

    assert "\n" not in escaped and "\r" not in escaped
    assert not any(unicodedata.category(character) == "Cc" for character in escaped)
    # Every backslash is either an escaped brace or followed by an invisible word joiner.
    for index, character in enumerate(escaped):
        if character == "\\":
            assert escaped[index + 1] in "{}\u2060"
    # No unescaped brace can open or close an override block.
    unescaped = re.sub(r"\\[{}]", "", escaped)
    assert "{" not in unescaped and "}" not in unescaped


def test_escape_keeps_readable_text():
    assert ass_escape("Gue bukan jambret, bro!") == "Gue bukan jambret, bro!"
    assert ass_escape("a{b}c") == "a\\{b\\}c"
    assert ass_escape("a\\b") == "a\\\u2060b"


def test_caption_words_are_escaped_in_both_styles():
    cues = (_cue((0.0, 0.5, "{\\fs200}besar"), (0.5, 1.0, "\\N")),)

    for caption_style in ("classic", "karaoke"):
        text = _events(
            build_ass(cues, width=720, height=1280, duration=5.0, caption_style=caption_style)
        )[0]["Text"]
        assert "{\\fs200}" not in text
        assert "\\N" not in text.replace("\\\u2060N", "")


def _hook_lines(document: str) -> list[tuple[int, int, str]]:
    """(x, y, text) of each hook line event, checking the shared fade/position override."""
    lines = []
    for event in _events(document):
        if event["Style"] != "Hook":
            continue
        match = _HOOK_PREFIX.match(event["Text"])
        assert match, event["Text"]
        lines.append((int(match["x"]), int(match["y"]), event["Text"][match.end() :]))
    return lines


def test_hook_event_sits_in_top_safe_area_for_hook_duration_with_fade():
    document = build_ass(
        (),
        width=720,
        height=1280,
        duration=29.0,
        hook_text="Kode rahasia copet di keramaian: 'mutus-mutus'",
        hook_duration=4.0,
    )

    style = _styles(document)["Hook"]
    assert style["Fontname"] == "DejaVu Sans"
    assert style["Bold"] == "-1"
    assert style["BorderStyle"] == "3"
    assert style["Alignment"] == "8"
    assert 0.12 * 1280 <= int(style["MarginV"]) <= 0.14 * 1280
    box_alpha = int(style["OutlineColour"][2:4], 16)
    assert 0x20 <= box_alpha <= 0xA0
    font_size = int(style["Fontsize"])
    assert font_size >= int(_styles(document)["Caption"]["Fontsize"])
    events = _events(document)
    assert {event["Layer"] for event in events} == {"1"}
    assert {event["Style"] for event in events} == {"Hook"}
    assert {(event["Start"], event["End"]) for event in events} == {("0:00:00.00", "0:00:04.00")}
    lines = _hook_lines(document)
    assert 1 <= len(lines) <= 3
    assert (
        " ".join(text for _, _, text in lines) == "Kode rahasia copet di keramaian: 'mutus-mutus'"
    )
    assert {x for x, _, _ in lines} == {360}
    padding = float(style["Outline"])
    # The first box starts in the top safe area; each next line starts one box height lower,
    # so the semi-opaque boxes touch without overlapping.
    assert 0.12 * 1280 <= lines[0][1] - padding <= 0.14 * 1280
    pitches = {later[1] - earlier[1] for earlier, later in pairwise(lines)}
    assert pitches == {font_size + 2 * padding}


def test_hook_is_clamped_to_clip_duration():
    document = build_ass((), width=720, height=1280, duration=3.0, hook_text="Hook singkat")

    [event] = _events(document)
    assert event["End"] == "0:00:03.00"


def test_long_hook_is_shortened_and_wrapped_to_three_lines():
    hook = (
        "Mantan copet membongkar kode rahasia yang dipakai komplotan di pasar, terminal, "
        "dan konser besar supaya korban tidak sadar dompetnya hilang"
    )

    for width, height in ((720, 1280), (1080, 1920), (360, 640)):
        lines = _hook_lines(
            build_ass((), width=width, height=height, duration=10.0, hook_text=hook)
        )

        assert len(lines) <= 3
        text = " ".join(line for _, _, line in lines)
        assert len(text) <= HOOK_TEXT_MAX_CHARS
        assert text.endswith("…")
        assert hook.startswith(text.removesuffix("…"))


@pytest.mark.parametrize(
    "hook",
    [
        "MANTAN COPET BONGKAR KODE RAHASIA DI KERAMAIAN WWW",
        "mmmm wwww mmmm wwww mmmm wwww mmmm wwww mmmm wwww",
        "Supercalifragilisticexpialidociousmenyebalkansekaliyaampun",
    ],
)
def test_hook_lines_fit_the_safe_width_even_for_wide_or_unbroken_text(hook: str):
    width, height = 720, 1280
    document = build_ass((), width=width, height=height, duration=10.0, hook_text=hook)

    style = _styles(document)["Hook"]
    font_size = int(style["Fontsize"])
    padding = float(style["Outline"])
    usable = width - 2 * int(style["MarginL"]) - 2 * padding
    lines = _hook_lines(document)
    assert 1 <= len(lines) <= 3
    assert all(estimate_text_width(text, font_size) <= usable for _, _, text in lines)


def test_text_width_estimate_tracks_glyph_widths_and_font_size():
    assert estimate_text_width("mmmm", 40) > estimate_text_width("iiii", 40) * 2
    assert estimate_text_width("Kode", 80) == pytest.approx(estimate_text_width("Kode", 40) * 2)
    assert estimate_text_width("", 40) == 0


def test_hook_text_is_escaped():
    lines = _hook_lines(
        build_ass((), width=720, height=1280, duration=5.0, hook_text="Rahasia {\\b1}copet}")
    )

    body = " ".join(line for _, _, line in lines)
    assert "{\\b1}" not in body
    assert re.sub(r"\\[{}]", "", body).count("{") == 0


@pytest.mark.parametrize("hook_text", [None, "", "   \n "])
def test_missing_or_blank_hook_adds_no_hook_event(hook_text):
    cues = (_cue((0.0, 0.5, "halo")),)

    events = _events(build_ass(cues, width=720, height=1280, duration=5.0, hook_text=hook_text))

    assert [event["Style"] for event in events] == ["Caption"]


def test_shorten_hook_text_cuts_on_a_word_boundary_with_ellipsis():
    text = "kata " * 30

    shortened = shorten_hook_text(text)

    assert len(shortened) <= HOOK_TEXT_MAX_CHARS
    assert shortened.endswith("kata…")
    assert shortened.removesuffix("…").split() == ["kata"] * len(shortened.split())


def test_shorten_hook_text_keeps_short_text_and_normalizes_whitespace():
    assert shorten_hook_text("  Kode   rahasia\ncopet  ") == "Kode rahasia copet"
    assert shorten_hook_text("x" * 90) == "x" * 90


def test_shorten_hook_text_hard_cuts_a_single_huge_word():
    shortened = shorten_hook_text("y" * 200, max_chars=20)

    assert shortened == "y" * 19 + "…"


def test_shorten_hook_text_drops_trailing_punctuation_before_ellipsis():
    shortened = shorten_hook_text("satu dua, tiga empat lima", max_chars=12)

    assert shortened == "satu dua…"


@pytest.mark.parametrize(
    "options",
    [
        {"caption_style": "neon"},
        {"width": 0},
        {"height": -2},
        {"duration": 0.0},
        {"duration": float("nan")},
        {"hook_duration": 0.0},
        {"hook_duration": float("inf")},
    ],
)
def test_invalid_options_are_rejected(options):
    arguments = {"width": 720, "height": 1280, "duration": 5.0}
    arguments.update(options)

    with pytest.raises(ValueError):
        build_ass((), **arguments)


def test_cue_beyond_clip_duration_is_rejected():
    with pytest.raises(ValueError, match="duration"):
        build_ass((_cue((4.0, 6.0, "telat")),), width=720, height=1280, duration=5.0)
