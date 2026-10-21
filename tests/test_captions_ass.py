import dataclasses
import hashlib
import json
import random
import re
import unicodedata
from itertools import pairwise
from pathlib import Path

import pytest

from ai_clipper import captions_ass
from ai_clipper.captions_ass import (
    CAPTION_STYLES,
    HOOK_TEXT_MAX_CHARS,
    CaptionPack,
    HookSpec,
    WatermarkSpec,
    ass_escape,
    build_ass,
    build_ass_v2,
    estimate_text_width,
    fit_cues,
    layout_hook,
    layout_watermark,
    load_hook_design,
    load_pack,
    shorten_hook_text,
)
from ai_clipper.edit_v2 import DOC_FPS, PACK_DEFAULT_OVERRIDES, PACK_IDS, WATERMARK_POSITIONS
from ai_clipper.edit_v2 import doc as docmod
from ai_clipper.edit_v2.glyphs import advance_px, advance_units, font_path
from ai_clipper.edit_v2.timemap import Fps, safe_cs
from ai_clipper.models import TranscriptSegment, TranscriptWord
from ai_clipper.subtitles import (
    CaptionCue,
    CaptionWord,
    FrameCue,
    FrameWord,
    build_caption_cues,
    cues_to_srt,
)

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
    # \kf sweeps each word from left to right over the durations \k switched it on.
    assert first["Text"] == "{\\kf35}Kode {\\kf55}rahasia {\\kf80}copet"
    durations = [int(value) for value in re.findall(r"\{\\kf(\d+)\}", first["Text"])]
    assert durations == [35, 55, 80]
    assert sum(durations) == _centiseconds(first["End"]) - _centiseconds(first["Start"])
    assert _TAG.sub("", first["Text"]) == "Kode rahasia copet"
    second = events[1]
    assert second["Start"] == "0:01:03.21"
    second_durations = [int(value) for value in re.findall(r"\{\\kf(\d+)\}", second["Text"])]
    assert sum(second_durations) == _centiseconds(second["End"]) - _centiseconds(second["Start"])
    assert not re.search(r"\\k\d", document)  # no switch-on \k left


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


# --- legacy bytes stay identical (T1.2a adds build_ass_v2 next to build_ass) --------------------

# sha256 over build_caption_cues/cues_to_srt and 108 build_ass documents, recorded on the wave
# base (a2bd7b2) before any T1.2a change. The V1 and v2-shadow paths keep calling these. The
# karaoke sweep (\kf, CONTRACTS §5.49) is the one change since: with its tags read back as \k
# the bytes are the pinned ones, so every duration is the old one.
LEGACY_PIN = "d2b08717ca80884e4976bf23aa5284530f95249e9e7d1a054bbe7abe1148e835"


def _legacy_segment(*items):
    words = tuple(TranscriptWord(s, e, t) for s, e, t in items)
    return TranscriptSegment(words[0].start, max(w.end for w in words),
                             " ".join(w.text for w in words), words=words)


def test_legacy_build_ass_and_caption_cue_bytes_are_unchanged():
    segments = [
        _legacy_segment((10.1, 10.4, " Gue"), (10.4, 10.8, " bukan"), (10.8, 11.5, " jambret."),
                        (12.3, 12.6, "Kode"), (12.6, 13.2, "{\\b1}rahasia"),
                        (13.25, 13.9, "copet\\N"), (14.8, 15.0, "di"), (15.0, 15.4, "keramaian?")),
        _legacy_segment((20.5, 20.9, "Kode"), (20.9, 21.4, "rahasia!")),
        TranscriptSegment(30.0, 32.0, "satu dua tiga empat lima"),
    ]
    ranges = [(20.0, 22.0), (10.0, 16.0), (29.5, 31.5)]
    cues = build_caption_cues(segments, ranges)
    digest = hashlib.sha256()
    digest.update(cues_to_srt(cues).encode())
    digest.update(repr(cues).encode())
    hooks = (None, "Kode rahasia copet di keramaian: 'mutus-mutus' {\\b1}",
             ("Mantan copet membongkar kode rahasia yang dipakai komplotan di pasar, terminal, "
              "dan konser besar supaya korban tidak sadar dompetnya hilang"))
    for width, height in ((720, 1280), (1080, 1920), (360, 640)):
        for style in ("classic", "karaoke"):
            for upper in (False, True):
                for hook in hooks:
                    document = build_ass(cues, width=width, height=height,
                                         duration=sum(b - a for a, b in ranges),
                                         caption_style=style, hook_text=hook,
                                         hook_duration=3.5, uppercase=upper)
                    assert ("{\\kf" in document) == (style == "karaoke")
                    assert not re.search(r"\\k\d", document)
                    digest.update(document.replace("{\\kf", "{\\k").encode())
    assert digest.hexdigest() == LEGACY_PIN


# --- Editor V3: packs and build_ass_v2 (plan §5.4; T1.2a) ---------------------------------------

ROOT = Path(__file__).resolve().parents[1]
PACKS_DIR = ROOT / "resources" / "caption-packs"
HOOK_DESIGN = ROOT / "resources" / "hook-designs" / "legacy-bar" / "v1.json"
OVERRIDES = {pack: dict(PACK_DEFAULT_OVERRIDES[pack]) for pack in PACK_IDS}
STYLE_NAMES = {"classic": "Caption", "karaoke": "Karaoke", "bold": "Bold", "box": "Box",
               "sorot": "Sorot", "sinar": "Sinar"}
_OWN_TAG = re.compile(r"(?<!\\)\{([^}]*)\}")
_CAPTION_TAG = re.compile(r"(\\(kf\d+|1c&H[0-9A-F]{6}&|2c&H[0-9A-F]{6}&|q2|fs\d+|b[01]"
                          r"|fn(Anton|Montserrat ExtraBold|DM Serif Display Italic)))+")
# The Sorot pack places each word and its box itself: position, no border on the spoken word,
# and the box drawing (plus the tags of the other packs).
_SOROT_TAG = re.compile(r"(\\(an2|pos\(\d+(\.\d{1,2})?,\d+\)|q2|fs\d+|bord0|shad0|p[01]"
                        r"|1c&H[0-9A-F]{6}&))+")
# Sinar places its line and its glow copy itself; the glow is a blurred border in the highlight
# colour around transparent glyphs (plus the karaoke tags).
_SINAR_TAG = re.compile(r"(\\(an2|pos\(\d+(\.\d{1,2})?,\d+\)|q2|fs\d+|kf\d+|bord\d+(\.\d{1,2})?"
                        r"|blur\d+(\.\d{1,2})?|shad0(\.02)?|[1234]c&H[0-9A-F]{6}&"
                        r"|[1234]a&H[0-9A-F]{2}&"
                        r"|fn(Montserrat ExtraBold|DM Serif Display Italic)))+")
WHITE = "&HFFFFFF&"
YELLOW = "&H4DE1FF&"  # #FFE14D, the default highlight
PINK = "&H8A5CFF&"  # #FF5C8A, the default emphasis


def _rhu(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def _fcue(*words, f1=None, seg="seg_b1"):
    items = []
    for index, word in enumerate(words):
        f0, w1, text, *rest = word
        items.append(FrameWord(f"w{index:06d}", f0, w1, text, bool(rest and rest[0])))
    return FrameCue(items[0].f0, items[-1].f1 if f1 is None else f1, seg, tuple(items))


NTSC = Fps(30000, 1001)


def _v2(cues, pack="classic", *, size=(720, 1280), fps=NTSC, total=None, hook=None,
        **overrides):
    values = dict(OVERRIDES[pack])
    values.update(overrides)
    if total is None:
        total = max([cue.f1 for cue in cues] + [hook.f1 if hook else 1]) + 30
    return build_ass_v2(cues, play_res=size, fps=fps, total_frames=total,
                        pack=load_pack(pack, 1), overrides=values, hook=hook)


def _style_line(document: str, name: str) -> str:
    return next(line for line in _sections(document)["[V4+ Styles]"]
                if line.startswith(f"Style: {name},"))


def _strip(text: str) -> str:
    return _OWN_TAG.sub("", text)


def _windows(cues, pack):
    """The frame window of every caption event, in emission order (bold: one per word; sorot:
    per word, one event per word of the cue plus the box; sinar: the glow, then the line)."""
    windows = []
    for cue in cues:
        if pack not in ("bold", "sorot"):
            windows.extend([(cue.f0, cue.f1)] * (2 if pack == "sinar" else 1))
            continue
        starts = [cue.f0] + [word.f0 for word in cue.words[1:]]
        ends = starts[1:] + [cue.f1]
        copies = len(cue.words) + 1 if pack == "sorot" else 1
        windows.extend((a, b) for a, b in zip(starts, ends, strict=True) if a < b
                       for _copy in range(copies))
    return windows


@pytest.mark.parametrize("size", [(720, 1280), (1080, 1920), (360, 640), (540, 960)])
@pytest.mark.parametrize("pack", ["classic", "karaoke"])
def test_classic_and_karaoke_style_lines_equal_build_ass(size, pack):
    legacy = build_ass((), width=size[0], height=size[1], duration=10.0)

    document = _v2((), pack, size=size)

    style = STYLE_NAMES[pack]
    assert _style_line(document, style) == _style_line(legacy, style)
    assert _script_info(document) == _script_info(legacy)


LONG_HOOK = ("Mantan copet membongkar kode rahasia yang dipakai komplotan di pasar, terminal, "
             "dan konser besar")


@pytest.mark.parametrize("size", [(720, 1280), (1080, 1920)])
@pytest.mark.parametrize("text", ["Dia ditahan security di film-nya sendiri", LONG_HOOK,
                                  "Rahasia {\\b1}copet}"])
def test_legacy_bar_hook_equals_the_legacy_hook(size, text):
    legacy = build_ass((), width=size[0], height=size[1], duration=30.0, hook_text=text)

    document = _v2((), "classic", size=size, fps=Fps(30, 1), hook=HookSpec(text, 0, 120, 13000))

    assert _style_line(document, "Hook") == _style_line(legacy, "Hook")
    hook_events = [event for event in _events(document) if event["Style"] == "Hook"]
    assert [event["Text"] for event in hook_events] == [
        event["Text"] for event in _events(legacy) if event["Style"] == "Hook"]
    assert {event["Layer"] for event in hook_events} == {"1"}


def test_every_pack_loads_with_the_seed_defaults_and_its_font():
    fonts = {"classic": "DejaVuSans.ttf", "karaoke": "DejaVuSans-Bold.ttf",
             "bold": "Montserrat-ExtraBold.ttf", "box": "Montserrat-ExtraBold.ttf",
             "sorot": "Montserrat-ExtraBold.ttf", "sinar": "Montserrat-ExtraBold.ttf"}
    assert PACK_IDS == ("classic", "karaoke", "bold", "box", "sorot", "sinar")
    for pack_id in PACK_IDS:
        pack = load_pack(pack_id, 1)
        assert isinstance(pack, CaptionPack)
        assert (pack.id, pack.v, pack.style_name) == (pack_id, 1, STYLE_NAMES[pack_id])
        assert dict(pack.defaults) == dict(PACK_DEFAULT_OVERRIDES[pack_id])
        assert pack.font_file == fonts[pack_id]
        assert font_path(pack.font_file).is_file()
        raw = (PACKS_DIR / pack_id / "v1.json").read_bytes()
        assert pack.sha256 == hashlib.sha256(raw).hexdigest()
        assert load_pack(pack_id, 1) is pack
    assert [load_pack(p, 1).words_per_cue for p in PACK_IDS] == [4, 4, 3, 3, 3, 3]


@pytest.mark.parametrize("pack_id", PACK_IDS)
def test_the_legacy_renderer_draws_every_pack_as_classic_or_karaoke(pack_id):
    """A clip the legacy engine renders (rollback or engine fallback) keeps the pack's reveal: a
    pack that lights no spoken word is Klasik, any other Karaoke (CONTRACTS §5.48)."""
    style = captions_ass.legacy_caption_style(pack_id)
    assert style in CAPTION_STYLES
    assert style == ("classic" if load_pack(pack_id, 1).reveal == "static" else "karaoke")
    if pack_id in CAPTION_STYLES:
        assert style == pack_id
    assert docmod.LEGACY_CAPTION_PACKS == CAPTION_STYLES


@pytest.mark.parametrize("pack_id", ["neon", "", None, "../classic"])
def test_the_legacy_style_of_an_unknown_pack_is_refused(pack_id):
    with pytest.raises(ValueError):
        captions_ass.legacy_caption_style(pack_id)


@pytest.mark.parametrize(("pack_id", "version"),
                         [("neon", 1), ("classic", 2), ("../classic", 1), ("classic", True)])
def test_unknown_packs_are_rejected(pack_id, version):
    with pytest.raises(ValueError):
        load_pack(pack_id, version)


def _no_float(value):
    raise AssertionError(f"float in a resource file: {value}")


def test_pack_and_hook_design_files_are_integer_json():
    assert sorted(path.parent.name for path in PACKS_DIR.glob("*/v1.json")) == sorted(PACK_IDS)
    for path in [*sorted(PACKS_DIR.glob("*/v1.json")), HOOK_DESIGN]:
        json.loads(path.read_text(encoding="utf-8"), parse_float=_no_float,
                   parse_constant=_no_float)


def test_legacy_bar_design_file_matches_the_hook_constants():
    design = load_hook_design("legacy-bar", 1)

    assert (design["id"], design["v"]) == ("legacy-bar", 1)
    assert design["font"] == {"family": captions_ass.FONT_NAME, "file": "DejaVuSans-Bold.ttf",
                              "bold": True}
    assert design["font_ratios_e5"] == [round(r * 100_000) for r in captions_ass._HOOK_FONT_RATIOS]
    assert design["max_lines"] == captions_ass.HOOK_MAX_LINES
    assert design["max_chars"] == HOOK_TEXT_MAX_CHARS
    assert (design["fade_in_ms"], design["fade_out_ms"]) == (captions_ass.HOOK_FADE_IN_MS,
                                                             captions_ass.HOOK_FADE_OUT_MS)
    assert design["box_alpha"] == captions_ass._HOOK_BOX_ALPHA
    assert design["box_padding_e5"] == round(captions_ass._HOOK_BOX_PADDING_RATIO * 100_000)
    assert design["side_margin_pm"] == round(captions_ass._HOOK_SIDE_MARGIN_RATIO * 1000)
    assert design["width_safety_pm"] == round(captions_ass._HOOK_WIDTH_SAFETY * 1000)
    assert design["default_y_e5"] == 13000
    with pytest.raises(ValueError):
        load_hook_design("banner", 1)


FRAME_SAFE_CUES = (
    _fcue((0, 9, "satu"), (9, 20, "dua"), (20, 31, "tiga")),
    _fcue((803, 811, "empat"), (811, 830, "lima")),  # 32.12 s at 25 fps: the classic hazard
    _fcue((9001, 9010, "enam"), f1=9013),
)


@pytest.mark.parametrize("rate", DOC_FPS)
@pytest.mark.parametrize("pack", PACK_IDS)
def test_event_times_are_frame_safe(rate, pack):
    fps = Fps(*rate)

    events = _events(_v2(FRAME_SAFE_CUES, pack, fps=fps))

    expected = [(max(0, safe_cs(a, fps)), safe_cs(b, fps))
                for a, b in _windows(FRAME_SAFE_CUES, pack)]
    assert [(_centiseconds(e["Start"]), _centiseconds(e["End"])) for e in events] == expected
    assert {e["Style"] for e in events} == {STYLE_NAMES[pack]}
    assert {e["Layer"] for e in events} == {"0"}


def test_karaoke_kf_sweeps_each_word_from_its_frame_and_sums_to_the_cue():
    fps = Fps(25, 1)
    cues = (_fcue((0, 7, "Kode"), (7, 21, "rahasia"), (21, 40, "copet"), f1=45),
            _fcue((803, 810, "mutus"), (812, 830, "mutus!")))

    document = _v2(cues, "karaoke", fps=fps)

    style = _styles(document)["Karaoke"]
    assert (style["PrimaryColour"], style["SecondaryColour"]) == ("&H004DE1FF", "&H00FFFFFF")
    # The durations \k had (differences of frame-safe centiseconds), now as sweeps.
    assert [event["Text"] for event in _events(document)] == [
        "{\\kf27}Kode {\\kf56}rahasia {\\kf96}copet", "{\\kf36}mutus {\\kf72}mutus!"]
    assert not re.search(r"\\k\d", document)
    for event, cue in zip(_events(document), cues, strict=True):
        start, end = _centiseconds(event["Start"]), _centiseconds(event["End"])
        durations = [int(v) for v in re.findall(r"\\kf(\d+)", event["Text"])]
        assert sum(durations) == end - start
        onsets = [start + sum(durations[:i]) for i in range(1, len(durations))]
        assert onsets == [safe_cs(word.f0, fps) for word in cue.words[1:]]
        assert _strip(event["Text"]) == " ".join(word.text for word in cue.words)


def test_bold_emits_one_event_per_word_with_identical_glyphs_and_only_colour_changes():
    fps = Fps(30000, 1001)
    cue = _fcue((100, 110, "gue"), (110, 118, "bukan"), (118, 140, "jambret."), f1=150)

    document = _v2((cue,), "bold", fps=fps)

    events = _events(document)
    assert [(_centiseconds(e["Start"]), _centiseconds(e["End"])) for e in events] == [
        (safe_cs(100, fps), safe_cs(110, fps)), (safe_cs(110, fps), safe_cs(118, fps)),
        (safe_cs(118, fps), safe_cs(150, fps))]
    assert {_strip(event["Text"]) for event in events} == {"GUE BUKAN JAMBRET."}
    for event, active in zip(events, ["GUE", "BUKAN", "JAMBRET."], strict=True):
        tags = _OWN_TAG.findall(event["Text"])
        assert tags and all(re.fullmatch(r"\\1c&H[0-9A-F]{6}&", tag) for tag in tags)
        highlighted = re.findall(r"\{\\1c" + YELLOW + r"\}([^{]*)\{\\1c" + WHITE + r"\}",
                                 event["Text"])
        assert highlighted == [active]
    style = _styles(document)["Bold"]
    assert style["Fontname"] == "Montserrat ExtraBold"
    assert (style["Fontsize"], style["Outline"], style["Shadow"]) == ("72", "14.22", "0")
    assert (style["BorderStyle"], style["Bold"], style["Alignment"]) == ("1", "0", "2")
    assert style["PrimaryColour"] == "&H00FFFFFF"


def test_bold_skips_empty_word_windows_but_still_tiles_the_cue():
    cue = _fcue((10, 10, "a"), (10, 14, "b"), (14, 20, "c"))

    events = _events(_v2((cue,), "bold", fps=Fps(25, 1)))

    fps = Fps(25, 1)
    assert [(_centiseconds(e["Start"]), _centiseconds(e["End"])) for e in events] == [
        (safe_cs(10, fps), safe_cs(14, fps)), (safe_cs(14, fps), safe_cs(20, fps))]


def test_box_is_one_translucent_line_of_at_most_three_words():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan"), (20, 30, "jambret."))

    document = _v2((cue,), "box")

    style = _styles(document)["Box"]
    assert style["Fontname"] == "Montserrat ExtraBold"
    assert (style["BorderStyle"], style["Outline"], style["Shadow"]) == ("3", "12.8", "0")
    assert style["OutlineColour"] == "&H40000000"  # black at 75% opacity (alpha 0x40)
    assert style["Fontsize"] == "64"
    [event] = _events(document)
    assert event["Text"].startswith("{\\q2}")
    assert _strip(event["Text"]) == "gue bukan jambret."


def test_box_splits_a_cue_wider_than_88_percent_of_the_width():
    pack = load_pack("box", 1)
    font = font_path(pack.font_file)
    cue = _fcue((0, 12, "SEPERTINYA"), (12, 30, "BERKEPANJANGAN"), (30, 44, "SEKALI"), f1=50)
    assert advance_px(cue.text, font, 64) > 0.88 * 720

    fitted = fit_cues((cue,), pack=pack, play_res=(720, 1280), overrides=OVERRIDES["box"])

    assert len(fitted) >= 2
    assert [w.id for c in fitted for w in c.words] == [w.id for w in cue.words]
    assert fitted[0].f0 == cue.f0 and fitted[-1].f1 == cue.f1
    for earlier, later in pairwise(fitted):
        assert earlier.f1 == later.f0 == later.words[0].f0
    for piece in fitted:
        assert len(piece.words) == 1 or advance_px(piece.text, font, 64) <= 0.88 * 720
    events = _events(_v2((cue,), "box"))
    assert len(events) == len(fitted)
    assert all(e["Text"].startswith("{\\q2") and "\\N" not in e["Text"] for e in events)
    assert fit_cues(fitted, pack=pack, play_res=(720, 1280), overrides=OVERRIDES["box"]) == fitted


def test_box_shrinks_a_single_word_that_is_too_wide_for_one_line():
    word = "Supercalifragilisticexpialidocious"
    font = font_path(load_pack("box", 1).font_file)

    [event] = _events(_v2((_fcue((0, 20, word)),), "box"))

    size = int(re.match(r"\{\\q2\\fs(\d+)\}", event["Text"]).group(1))
    assert size < 64
    assert advance_px(word, font, size) <= 0.88 * 720 < advance_px(word, font, size + 1)


def test_box_vector_variant_draws_a_p_rectangle_behind_each_line():
    # The fallback if P-TXT fails for BorderStyle 3 (plan §5.4): same text, the box drawn as a
    # \p vector rectangle event right before it, on the same layer and frames.
    pack = dataclasses.replace(load_pack("box", 1), box_style="vector")
    assert load_pack("box", 1).box_style == "border"
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan", True), (20, 30, "jambret."))
    word = "Supercalifragilisticexpialidocious"

    document = build_ass_v2((cue, _fcue((40, 60, word))), play_res=(720, 1280), fps=NTSC,
                            total_frames=90, pack=pack, overrides=OVERRIDES["box"], hook=None)

    style = _styles(document)["Box"]
    assert (style["BorderStyle"], style["Outline"], style["Shadow"]) == ("1", "0", "0")
    box, text, wide_box, wide_text = _events(document)
    for drawing, line in ((box, text), (wide_box, wide_text)):
        assert (drawing["Start"], drawing["End"], drawing["Layer"]) == (
            line["Start"], line["End"], line["Layer"])
    wrapped = "{\\1c" + PINK + "}bukan{\\1c" + WHITE + "}"
    assert text["Text"] == "{\\q2}gue " + wrapped + " jambret."
    font = font_path(pack.font_file)
    pad = _rhu(1280, 100)
    for drawing, shown, size in ((box, "gue bukan jambret.", 64), (wide_box, word, None)):
        match = re.fullmatch(r"\{\\an2\\pos\(360,(\d+)\)\\bord0\\shad0\\1c&H000000&\\1a&H40&"
                             r"\\p1\}m 0 0 l (\d+) 0 \2 (\d+) 0 \3\{\\p0\}", drawing["Text"])
        assert match, drawing["Text"]
        y, w, h = map(int, match.groups())
        if size is None:
            size = int(re.match(r"\{\\q2\\fs(\d+)\}", wide_text["Text"]).group(1))
        assert y == 1280 - 218 + pad
        assert h == size + 2 * pad
        assert abs(w - (advance_px(shown, font, size) + 2 * pad)) <= 0.5


def test_box_vector_rectangle_measures_the_characters_libass_draws():
    # ass_escape turns line breaks into spaces and drops control characters; "{" stays visible.
    pack = dataclasses.replace(load_pack("box", 1), box_style="vector")
    font = font_path(pack.font_file)

    def rectangle_width(text):
        document = build_ass_v2((_fcue((0, 30, text)),), play_res=(720, 1280), fps=NTSC,
                                total_frames=60, pack=pack, overrides=OVERRIDES["box"],
                                hook=None)
        drawing = _events(document)[0]["Text"]
        return int(re.search(r"\\p1\}m 0 0 l (\d+) 0 ", drawing).group(1))

    pad = _rhu(1280, 100)
    for text, shown in (("a\tb", "a b"), ("ok\x07!", "ok!"), ("{hai}", "{hai}")):
        assert abs(rectangle_width(text) - (advance_px(shown, font, 64) + 2 * pad)) <= 0.5


def test_box_style_is_a_pack_file_field_that_only_boxed_packs_carry(tmp_path, monkeypatch):
    # Switching box to the \p variant is a data change (the pack file), recorded in SPIKES.md.
    box = json.loads((PACKS_DIR / "box" / "v1.json").read_bytes())
    assert box["box_style"] == "border"
    assert all("box_style" not in json.loads((PACKS_DIR / p / "v1.json").read_bytes())
               for p in ("classic", "karaoke", "bold"))
    classic = json.loads((PACKS_DIR / "classic" / "v1.json").read_bytes())
    files = {("box", 7): {**box, "v": 7, "box_style": "vector"},
             ("box", 8): {**box, "v": 8, "box_style": "circle"},
             ("classic", 9): {**classic, "v": 9, "box_style": "vector"},
             ("box", 10): {key: value for key, value in {**box, "v": 10}.items()
                           if key != "box_style"}}
    for (pack_id, version), data in files.items():
        (tmp_path / pack_id).mkdir(exist_ok=True)
        (tmp_path / pack_id / f"v{version}.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(captions_ass, "PACKS_DIR", tmp_path)
    captions_ass._load_pack.cache_clear()
    try:
        assert load_pack("box", 7).box_style == "vector"
        assert load_pack("box", 10).box_style == "border"
        for pack_id, version in (("box", 8), ("classic", 9)):
            with pytest.raises(ValueError, match="box_style"):
                load_pack(pack_id, version)
    finally:
        monkeypatch.undo()
        captions_ass._load_pack.cache_clear()
    assert load_pack("classic", 1).box_style == "border"


@pytest.mark.parametrize("pack_id", ["classic", "karaoke", "bold"])
def test_the_vector_box_needs_a_one_line_boxed_pack(pack_id):
    pack = dataclasses.replace(load_pack(pack_id, 1), box_style="vector")
    with pytest.raises(ValueError, match="box_style"):
        build_ass_v2((), play_res=(720, 1280), fps=NTSC, total_frames=30, pack=pack,
                     overrides=OVERRIDES[pack_id], hook=None)
    with pytest.raises(ValueError, match="box_style"):
        build_ass_v2((), play_res=(720, 1280), fps=NTSC, total_frames=30,
                     pack=dataclasses.replace(load_pack("box", 1), box_style="round"),
                     overrides=OVERRIDES["box"], hook=None)


def test_emphasis_colour_wraps_the_word_and_is_reset_after_it():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan", True), (20, 30, "jambret."))
    wrapped = "{\\1c" + PINK + "}bukan{\\1c" + WHITE + "}"

    [classic] = _events(_v2((cue,), "classic"))
    assert classic["Text"] == f"gue {wrapped} jambret."
    [box] = _events(_v2((cue,), "box"))
    assert box["Text"] == "{\\q2}gue " + wrapped + " jambret."
    # Bold and Karaoke also enlarge the keyword (their emphasis block, CONTRACTS §5.51).
    for event in _events(_v2((cue,), "bold")):
        assert ("{\\1c" + PINK + "\\fs101\\fnAnton}BUKAN"
                "{\\1c" + WHITE + "\\fs72\\fnMontserrat ExtraBold}") in event["Text"]
    [karaoke] = _events(_v2((cue,), "karaoke"))
    assert re.search(r"\{\\kf\d+\\1c" + PINK + r"\\2c" + PINK + r"\\fs74\}bukan\{\\1c"
                     + YELLOW + r"\\2c" + WHITE + r"\\fs53\}", karaoke["Text"])


def test_highlight_override_recolours_karaoke_and_the_bold_active_word():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan"))

    karaoke = _v2((cue,), "karaoke", highlight="#3DF5A6")
    bold = _v2((cue,), "bold", highlight="#52C7FF")

    assert _styles(karaoke)["Karaoke"]["PrimaryColour"] == "&H00A6F53D"
    assert "{\\1c&HFFC752&}GUE" in _events(bold)[0]["Text"]


def test_overrides_move_scale_and_uppercase_the_captions():
    cue = _fcue((0, 10, "gue"), (10, 20, "Bukan"))

    raised = _v2((cue,), "classic", y_e5=70000, size_pm=1400, case="upper")
    style = _styles(raised)["Caption"]
    assert style["MarginV"] == str(_rhu(30000 * 1280, 100000))  # 384: bottom anchor at 70%
    assert style["Fontsize"] == str(_rhu(1280 * 12 * 1400, 288 * 1000))  # 75
    assert _strip(_events(raised)[0]["Text"]) == "GUE BUKAN"

    lowered = _v2((cue,), "classic", y_e5=92000, size_pm=700)
    style = _styles(lowered)["Caption"]
    assert (style["MarginV"], style["Fontsize"]) == ("102", "37")
    assert _strip(_events(lowered)[0]["Text"]) == "gue Bukan"
    bold_asis = _v2((cue,), "bold", case="asis")
    assert _strip(_events(bold_asis)[0]["Text"]) == "gue Bukan"


def test_hook_top_follows_y_e5_and_its_events_are_frame_safe():
    fps = Fps(25, 1)
    text = "Kode rahasia copet di keramaian"

    document = _v2((), "classic", fps=fps, hook=HookSpec(text, 803, 903, 30000))

    layout = layout_hook(text, play_res=(720, 1280), y_e5=30000)
    assert layout.top == 384 and not layout.overflow
    events = [event for event in _events(document) if event["Style"] == "Hook"]
    assert len(events) == len(layout.lines)
    for index, event in enumerate(events):
        assert (_centiseconds(event["Start"]), _centiseconds(event["End"])) == (
            safe_cs(803, fps), safe_cs(903, fps))
        y = int(re.search(r"\\pos\(360,(\d+)\)", event["Text"]).group(1))
        assert y == layout.top + layout.padding + index * (layout.font_size + 2 * layout.padding)


def test_hook_overflow_is_reported_when_the_tail_is_cut():
    text = ("WWWWWWWWW " * 9).strip()

    layout = layout_hook(text, play_res=(720, 1280), y_e5=13000)

    assert layout.overflow
    assert len(layout.lines) == 3 and layout.lines[-1].endswith("…")
    assert not layout_hook("Hook singkat", play_res=(720, 1280), y_e5=13000).overflow


def test_hook_is_clamped_to_the_clip_and_follows_the_captions():
    fps = Fps(30, 1)
    cue = _fcue((0, 10, "halo"))

    document = _v2((cue,), "classic", fps=fps, total=60, hook=HookSpec("Hook", 0, 120, 13000))

    events = _events(document)
    assert [event["Style"] for event in events] == ["Caption", "Hook"]
    assert (_centiseconds(events[1]["Start"]), _centiseconds(events[1]["End"])) == (
        0, safe_cs(60, fps))


_FUZZ = ["\\", "{", "}", "N", "n", "h", "\\N", "{\\b1}", "\\h", "\n", "\r\n", "\t", "\x00",
         "\x07", "\x1b", "\u2028", "\u0085", "\ud800", "مرحبا", "שלום", "😂", "🔥", "a", "Z",
         "é", " ", "\\{", "}{"]


@pytest.mark.parametrize("pack", PACK_IDS)
def test_escape_fuzz_keeps_every_event_on_one_line_without_foreign_tags(pack):
    rng = random.Random(f"ass-fuzz-{pack}")
    loaded = load_pack(pack, 1)
    for _trial in range(60):
        words = []
        for index in range(rng.randint(1, 3)):
            text = "".join(rng.choice(_FUZZ) for _ in range(rng.randint(1, 6))) + "x"
            words.append(FrameWord(f"w{index:06d}", 5 * index, 5 * index + 5, text,
                                   rng.random() < 0.3))
        cue = FrameCue(0, 5 * len(words), "seg_b1", tuple(words))

        document = _v2((cue,), pack, fps=Fps(25, 1))

        body = document.split("[Events]\n", 1)[1]
        dialogues = [line for line in body.split("\n")[1:] if line]
        assert all(line.startswith("Dialogue: ") for line in dialogues)
        if pack in ("box", "sorot", "sinar"):
            expected = fit_cues((cue,), pack=loaded, play_res=(720, 1280),
                                overrides=OVERRIDES[pack])
            # Sorot: per spoken word, one event per word of the line plus its box. Sinar: the
            # glow, then the line.
            per_cue = [len(part.words) * (len(part.words) + 1) if pack == "sorot"
                       else 2 if pack == "sinar" else 1 for part in expected]
            assert len(dialogues) == sum(per_cue)
        else:
            assert len(dialogues) == (len(words) if pack == "bold" else 1)
        allowed = {"sorot": _SOROT_TAG, "sinar": _SINAR_TAG}.get(pack, _CAPTION_TAG)
        for line in dialogues:
            text = line.split(",", 9)[9]
            assert not any(unicodedata.category(c) in ("Cc", "Cs", "Zl", "Zp") for c in text)
            assert all(allowed.fullmatch(tag) for tag in _OWN_TAG.findall(text)), text
            stripped = _strip(text)
            for position, character in enumerate(stripped):
                if character == "\\":
                    assert stripped[position + 1] in "{}\u2060"
        if pack in ("classic", "karaoke"):
            displayed = " ".join(ass_escape(word.text) for word in words)
            assert _strip(dialogues[0].split(",", 9)[9]) == displayed


def _v2_kwargs():
    return {"play_res": (720, 1280), "fps": Fps(25, 1), "total_frames": 100,
            "pack": load_pack("classic", 1), "overrides": dict(OVERRIDES["classic"]),
            "hook": None}


@pytest.mark.parametrize(
    "change",
    [
        {"play_res": (0, 1280)},
        {"play_res": (720, 1280.0)},
        {"total_frames": 0},
        {"total_frames": 20},  # the cue ends at frame 30
        {"fps": (25, 1)},
        {"pack": "classic"},
        {"overrides": {**OVERRIDES["classic"], "case": "lower"}},
        {"overrides": {**OVERRIDES["classic"], "highlight": "#ffe14d"}},
        {"overrides": {**OVERRIDES["classic"], "size_pm": 0}},
        {"overrides": {k: v for k, v in OVERRIDES["classic"].items() if k != "y_e5"}},
        {"hook": HookSpec("Hook", 10, 10, 13000)},
        {"hook": HookSpec("Hook", -1, 10, 13000)},
        {"hook": HookSpec("Hook", 0, 10, 100_001)},
    ],
)
def test_build_ass_v2_rejects_invalid_input(change):
    arguments = _v2_kwargs()
    arguments.update(change)
    with pytest.raises((TypeError, ValueError)):
        build_ass_v2((_fcue((0, 30, "halo")),), **arguments)


# --- Sorot: a box behind the spoken word (P1 #9) -----------------------------------------------

_POS = re.compile(r"\\pos\((\d+(?:\.\d+)?),(\d+)\)")
_DRAWING = re.compile(r"\\p1\}(m [0-9 mlb]+)\{\\p0\}$")
DARK = "&H111111&"


def _word_boxes(document):
    """Per event: ("box", x, y, path, colour) or ("word", x, y, text, tags)."""
    found = []
    for event in _events(document):
        text = event["Text"]
        x, y = _POS.search(text).groups()
        drawing = _DRAWING.search(text)
        if drawing:
            colour = re.search(r"\\1c(&H[0-9A-F]{6}&)", text).group(1)
            found.append(("box", float(x), int(y), drawing.group(1), colour))
        else:
            tags = "".join(_OWN_TAG.findall(text))
            found.append(("word", float(x), int(y), _strip(text), tags))
    return found


def _extent(path):
    numbers = [int(value) for value in re.findall(r"\d+", path)]
    return max(numbers[0::2]), max(numbers[1::2])


def _centres(words, size, font):
    """Each word's centre x when the line of ``words`` is centred on the frame (hmtx)."""
    space = advance_px(" ", font, size)
    widths = [advance_px(word, font, size) for word in words]
    left = 360 - (sum(widths) + space * (len(words) - 1)) / 2
    centres = []
    for width in widths:
        centres.append(left + width / 2)
        left += width + space
    return centres, widths


def test_sorot_pack_file_loads_a_one_line_pack_with_its_word_box():
    pack = load_pack("sorot", 1)

    assert (pack.name, pack.style_name, pack.reveal) == ("Sorot", "Sorot", "word_box")
    assert (pack.border_style, pack.box_style, pack.max_width_pm) == (1, "border", 880)
    assert pack.word_box == captions_ass.WordBox(pad_x_pm=160, top_pm=110, radius_pm=140,
                                                 dark_text="#111111", light_text="#FFFFFF",
                                                 dark_from_lstar=60)
    assert dict(pack.defaults) == dict(PACK_DEFAULT_OVERRIDES["sorot"])
    assert PACK_DEFAULT_OVERRIDES["sorot"]["case"] == "upper"
    for other in ("classic", "karaoke", "bold", "box"):
        assert load_pack(other, 1).word_box is None


def test_sorot_draws_each_word_in_place_and_a_box_behind_the_spoken_one():
    fps = Fps(30000, 1001)
    cue = _fcue((100, 110, "ini"), (110, 118, "caranya"), (118, 140, "biar."), f1=150)

    document = _v2((cue,), "sorot", fps=fps)

    style = _styles(document)["Sorot"]
    assert style["Fontname"] == "Montserrat ExtraBold"
    assert (style["Fontsize"], style["Outline"], style["Shadow"]) == ("64", "8.53", "0")
    assert (style["BorderStyle"], style["Alignment"], style["PrimaryColour"]) == (
        "1", "2", "&H00FFFFFF")
    events = _events(document)
    assert {event["Style"] for event in events} == {"Sorot"}
    assert {event["Layer"] for event in events} == {"0"}
    windows = [(safe_cs(100, fps), safe_cs(110, fps)), (safe_cs(110, fps), safe_cs(118, fps)),
               (safe_cs(118, fps), safe_cs(150, fps))]
    assert [(_centiseconds(e["Start"]), _centiseconds(e["End"])) for e in events] == [
        window for window in windows for _copy in range(4)]
    font = font_path(load_pack("sorot", 1).font_file)
    shown = ["INI", "CARANYA", "BIAR."]
    centres, widths = _centres(shown, 64, font)
    parsed = _word_boxes(document)
    for active in range(3):
        window = parsed[4 * active:4 * active + 4]
        # The other words first, then the box, then the spoken word on top of it.
        kinds = [entry[0] for entry in window]
        assert kinds == ["word", "word", "box", "word"]
        words = [entry for entry in window if entry[0] == "word"]
        assert [entry[3] for entry in words] == [w for i, w in enumerate(shown) if i != active] + [
            shown[active]]
        for entry in words:
            index = shown.index(entry[3])
            assert abs(entry[1] - centres[index]) <= 0.005  # the line's natural place
            assert entry[2] == 1280 - 218
            assert entry[4].startswith("\\an2\\pos(") and "\\q2" in entry[4]
        spoken = words[-1]
        assert "\\bord0\\shad0\\1c" + DARK in spoken[4]
        assert all("\\bord0" not in entry[4] for entry in words[:-1])
        _kind, x, y, path, colour = window[2]
        assert (x, y, colour) == (spoken[1], 1062, YELLOW)
        width, height = _extent(path)
        assert abs(width - (widths[active] + 2 * 10)) <= 0.5  # the word plus 16% of 64 a side
        assert height == 64 - 7  # top 11% of the line inset; the box ends at the line bottom
        assert path.startswith("m 9 0 l ") and " b " in path  # rounded corners, radius 9


def test_sorot_box_path_is_a_rounded_rectangle_that_fits_its_extent():
    path = captions_ass._box_path(120, 57, 9)
    assert path == ("m 9 0 l 111 0 b 116 0 120 4 120 9 l 120 48 b 120 53 116 57 111 57 "
                    "l 9 57 b 4 57 0 53 0 48 l 0 9 b 0 4 4 0 9 0")
    assert captions_ass._box_path(30, 20, 0) == "m 0 0 l 30 0 30 20 0 20"
    assert _extent(captions_ass._box_path(18, 10, 9)) == (18, 10)  # radius capped at half


@pytest.mark.parametrize("swatch", ["#FFE14D", "#FFFFFF", "#3DF5A6", "#52C7FF", "#FF5C8A",
                                    "#FF9F1C"])
def test_every_highlight_swatch_is_light_so_the_spoken_word_turns_dark(swatch):
    box = load_pack("sorot", 1).word_box
    assert captions_ass.lightness(swatch) >= 60
    assert captions_ass.word_box_text(swatch, box) == "#111111"
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan"))
    document = _v2((cue,), "sorot", highlight=swatch)
    spoken = [entry for entry in _word_boxes(document) if entry[0] == "word"][1]
    box_entry = next(entry for entry in _word_boxes(document) if entry[0] == "box")
    assert box_entry[4] == captions_ass._inline_colour(swatch)
    assert spoken[4].endswith("\\1c" + DARK)


def test_a_dark_box_gets_light_text_by_cie_lightness():
    box = load_pack("sorot", 1).word_box
    assert round(captions_ass.lightness("#FFFFFF"), 6) == 100
    assert round(captions_ass.lightness("#000000"), 6) == 0
    assert abs(captions_ass.lightness("#777777") - 50.03) < 0.01
    for colour in ("#3F5EFB", "#E44E3F", "#000000", "#777777"):
        assert captions_ass.lightness(colour) < 60
        assert captions_ass.word_box_text(colour, box) == "#FFFFFF"
    # The threshold is the pack's: the same colour flips when the pack asks for less.
    softer = dataclasses.replace(box, dark_from_lstar=50)
    assert captions_ass.word_box_text("#777777", softer) == "#111111"


def test_sorot_keyword_keeps_its_colour_and_gets_its_own_box_when_spoken():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan", True), (20, 30, "jambret."))

    parsed = _word_boxes(_v2((cue,), "sorot"))

    first, second = parsed[:4], parsed[4:8]
    keyword = next(entry for entry in first if entry[0] == "word" and entry[3] == "BUKAN")
    assert keyword[4].endswith("\\1c" + PINK)  # not spoken yet: the keyword colour
    box = next(entry for entry in second if entry[0] == "box")
    assert box[4] == PINK  # spoken: the box takes the keyword colour
    assert second[-1][3] == "BUKAN" and second[-1][4].endswith("\\1c" + DARK)


def test_sorot_splits_wide_lines_and_shrinks_a_single_wide_word():
    pack = load_pack("sorot", 1)
    font = font_path(pack.font_file)
    cue = _fcue((0, 12, "SEPERTINYA"), (12, 30, "BERKEPANJANGAN"), (30, 44, "SEKALI"), f1=50)
    fitted = fit_cues((cue,), pack=pack, play_res=(720, 1280), overrides=OVERRIDES["sorot"])
    assert len(fitted) >= 2
    for piece in fitted:
        assert len(piece.words) == 1 or advance_px(piece.text, font, 64) <= 0.88 * 720

    word = "Supercalifragilisticexpialidocious"
    events = _events(_v2((_fcue((0, 20, word)),), "sorot"))
    size = int(re.search(r"\\fs(\d+)", events[-1]["Text"]).group(1))
    assert size < 64
    assert advance_px(word.upper(), font, size) <= 0.88 * 720
    _kind, x, _y, path, _colour = _word_boxes(_v2((_fcue((0, 20, word)),), "sorot"))[0]
    assert x == 360
    assert _extent(path)[1] == size - _rhu(size * 110, 1000)


def test_sorot_follows_position_size_and_case_overrides():
    cue = _fcue((0, 10, "gue"), (10, 20, "Bukan"))

    raised = _v2((cue,), "sorot", y_e5=70000, size_pm=1400, case="asis")

    assert _styles(raised)["Sorot"]["Fontsize"] == str(_rhu(1280 * 12 * 1200 * 1400,
                                                             288 * 1_000_000))
    parsed = _word_boxes(raised)
    assert {entry[2] for entry in parsed} == {1280 - _rhu(30000 * 1280, 100000)}
    assert [entry[3] for entry in parsed if entry[0] == "word"][:2] == ["Bukan", "gue"]


# --- Sinar: the karaoke sweep with a soft glow (CONTRACTS §5.49) ---------------------------------

SINAR_CUE = _fcue((0, 10, "gue"), (10, 25, "bukan"), (25, 40, "jambret."))
# The glow is the border's shape drawn as a 1/64 px shadow under an all but transparent fill: a
# shadow is never cut by the glyphs (CONTRACTS §5.49).
GLOW_720 = "\\bord14\\blur7\\3a&HFF&\\4c&H4DE1FF&\\4a&H30&\\shad0.02\\1a&HFE&\\2a&HFE&"


def test_sinar_pack_file_loads_a_one_line_karaoke_pack_with_its_glow():
    pack = load_pack("sinar", 1)

    assert (pack.name, pack.style_name, pack.reveal) == ("Sinar", "Sinar", "karaoke")
    assert (pack.border_style, pack.box_style, pack.max_width_pm) == (1, "border", 880)
    assert pack.glow == captions_ass.Glow(outline=(7, 640), blur=(7, 1280), alpha=48)
    assert pack.word_box is None
    assert dict(pack.defaults) == dict(PACK_DEFAULT_OVERRIDES["sinar"])
    assert PACK_DEFAULT_OVERRIDES["sinar"]["case"] == "asis"
    for other in ("classic", "karaoke", "bold", "box", "sorot"):
        assert load_pack(other, 1).glow is None


def test_sinar_draws_a_blurred_glow_under_the_karaoke_line():
    document = _v2((SINAR_CUE,), "sinar")

    style = _styles(document)["Sinar"]
    assert (style["Fontname"], style["Fontsize"]) == ("Montserrat ExtraBold", "59")
    assert (style["PrimaryColour"], style["SecondaryColour"]) == ("&H004DE1FF", "&H00FFFFFF")
    assert (style["Outline"], style["Shadow"], style["BorderStyle"]) == ("4", "0", "1")
    glow, line = _events(document)
    assert {k: v for k, v in glow.items() if k != "Text"} == {
        k: v for k, v in line.items() if k != "Text"}
    assert glow["Layer"] == "0"
    place = "\\an2\\pos(360,1062)\\q2"
    assert glow["Text"] == "{" + place + GLOW_720 + "}gue bukan jambret."
    # The line sweeps exactly like the Karaoke pack's: the same \kf durations and colours.
    [karaoke] = _events(_v2((SINAR_CUE,), "karaoke"))
    assert line["Text"] == "{" + place + "}" + karaoke["Text"]
    assert (_centiseconds(line["Start"]), _centiseconds(line["End"])) == (
        _centiseconds(karaoke["Start"]), _centiseconds(karaoke["End"]))


def test_sinar_glow_follows_the_highlight_colour_and_the_output_size():
    green = "#3DF5A6"

    document = _v2((SINAR_CUE,), "sinar", size=(1080, 1920), highlight=green, y_e5=70000)

    assert _styles(document)["Sinar"]["PrimaryColour"] == "&H00A6F53D"
    glow, line = _events(document)
    bottom = 1920 - _rhu(30000 * 1920, 100000)
    assert glow["Text"].startswith(
        "{\\an2\\pos(540," + str(bottom) + ")\\q2\\bord21\\blur10.5\\3a&HFF&\\4c&HA6F53D&"
        "\\4a&H30&")
    assert line["Text"].startswith("{\\an2\\pos(540," + str(bottom) + ")\\q2}{\\kf")


def test_sinar_keeps_one_line_and_shrinks_a_single_wide_word_in_both_events():
    pack = load_pack("sinar", 1)
    wide = _fcue((0, 10, "Kode"), (10, 20, "rahasia"), (20, 30, "komplotan"), (30, 40, "copet"))
    fitted = fit_cues((wide,), pack=pack, play_res=(720, 1280), overrides=OVERRIDES["sinar"])
    assert len(fitted) > 1 and all(len(cue.words) <= 3 for cue in fitted)

    word = "Supercalifragilisticexpialidocious"
    glow, line = _events(_v2((_fcue((0, 20, word)),), "sinar"))

    size = re.search(r"\\fs(\d+)", glow["Text"]).group(1)
    assert int(size) < 59 and f"\\q2\\fs{size}" in line["Text"]
    assert _strip(glow["Text"]) == _strip(line["Text"]) == word


def test_sinar_keyword_keeps_its_colour_in_the_line_and_the_glow_stays_one_colour():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan", True), (20, 30, "jambret."))

    glow, line = _events(_v2((cue,), "sinar"))

    assert "\\1c" not in glow["Text"] and "\\4c&H4DE1FF&" in glow["Text"]
    assert _strip(glow["Text"]) == "gue bukan jambret."
    assert re.search(r"\{\\kf\d+\\1c" + PINK + r"\\2c" + PINK + r"\\fs83", line["Text"])


def test_glow_is_a_pack_file_field_of_one_line_karaoke_packs_only(tmp_path, monkeypatch):
    sinar = json.loads((PACKS_DIR / "sinar" / "v1.json").read_bytes())
    karaoke = json.loads((PACKS_DIR / "karaoke" / "v1.json").read_bytes())
    sorot = json.loads((PACKS_DIR / "sorot" / "v1.json").read_bytes())
    files = {("sinar", 2): {**sinar, "v": 2},
             ("sinar", 3): {**sinar, "v": 3, "glow": {**sinar["glow"], "alpha": 256}},
             ("sinar", 4): {**sinar, "v": 4, "glow": {**sinar["glow"], "colour": "#FFFFFF"}},
             ("sinar", 5): {**sinar, "v": 5, "glow": {**sinar["glow"],
                                                      "blur": {"num": 1, "den": 0}}},
             ("karaoke", 6): {**karaoke, "v": 6, "glow": sinar["glow"]},  # wraps: no max width
             ("sorot", 7): {**sorot, "v": 7, "glow": sinar["glow"]}}  # not a karaoke pack
    for (pack_id, version), data in files.items():
        (tmp_path / pack_id).mkdir(exist_ok=True)
        (tmp_path / pack_id / f"v{version}.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(captions_ass, "PACKS_DIR", tmp_path)
    captions_ass._load_pack.cache_clear()
    try:
        assert load_pack("sinar", 2).glow == captions_ass.Glow((7, 640), (7, 1280), 48)
        for pack_id, version in (("sinar", 3), ("sinar", 4), ("sinar", 5), ("karaoke", 6),
                                 ("sorot", 7)):
            with pytest.raises(ValueError, match="glow"):
                load_pack(pack_id, version)
    finally:
        monkeypatch.undo()
        captions_ass._load_pack.cache_clear()
    pack = dataclasses.replace(load_pack("karaoke", 1), glow=load_pack("sinar", 1).glow)
    with pytest.raises(ValueError, match="glow"):
        build_ass_v2((), play_res=(720, 1280), fps=NTSC, total_frames=30, pack=pack,
                     overrides=OVERRIDES["karaoke"], hook=None)


# --- The emphasis block: the keyword's size and accent font (CONTRACTS §5.51) --------------------

KEYWORD_CUE = _fcue((0, 10, "gue"), (10, 25, "bukan", True), (25, 40, "jambret."))


def _pack_files(tmp_path, monkeypatch, files):
    for (pack_id, version), data in files.items():
        (tmp_path / pack_id).mkdir(exist_ok=True)
        (tmp_path / pack_id / f"v{version}.json").write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(captions_ass, "PACKS_DIR", tmp_path)
    captions_ass._load_pack.cache_clear()


def test_the_emphasis_block_of_each_pack():
    Emphasis = captions_ass.Emphasis
    assert load_pack("karaoke", 1).emphasis == Emphasis(scale_pm=1400)
    assert load_pack("bold", 1).emphasis == Emphasis(
        scale_pm=1400, font_family="Anton", font_file="Anton-Regular.ttf", bold=False)
    assert load_pack("sinar", 1).emphasis == Emphasis(
        scale_pm=1400, font_family="DM Serif Display Italic",
        font_file="DMSerifDisplay-Italic.ttf", bold=False)
    for other in ("classic", "box", "sorot"):
        assert load_pack(other, 1).emphasis is None, other


def test_the_emphasis_block_is_checked_when_the_pack_loads(tmp_path, monkeypatch):
    bold = json.loads((PACKS_DIR / "bold" / "v1.json").read_bytes())
    sorot = json.loads((PACKS_DIR / "sorot" / "v1.json").read_bytes())
    box = json.loads((PACKS_DIR / "box" / "v1.json").read_bytes())
    block = bold["emphasis"]
    font = block["font"]
    bad = [
        {**block, "scale_pm": 999}, {**block, "scale_pm": 2001}, {**block, "scale_pm": "1400"},
        {**block, "scale_pm": True}, {"font": font}, {**block, "colour": "#FFFFFF"},
        {**block, "font": {**font, "file": "Arial.ttf"}},
        {**block, "font": {**font, "family": "Anton Bold"}},  # not a name of the file
        {**block, "font": {**font, "family": "Anton}{\\b1"}},
        {**block, "font": {**font, "bold": 0}},
        {**block, "font": {key: value for key, value in font.items() if key != "bold"}},
        [1400],
    ]
    files = {("bold", 10 + index): {**bold, "v": 10 + index, "emphasis": value}
             for index, value in enumerate(bad)}
    files[("bold", 2)] = {**bold, "v": 2, "emphasis": {"scale_pm": 1000}}
    files[("bold", 3)] = {**bold, "v": 3, "emphasis": {**block, "scale_pm": 2000}}
    files[("sorot", 4)] = {**sorot, "v": 4, "emphasis": block}  # draws each word itself
    files[("box", 5)] = {**box, "v": 5, "emphasis": block}  # BorderStyle 3 boxes each run
    _pack_files(tmp_path, monkeypatch, files)
    try:
        assert load_pack("bold", 2).emphasis == captions_ass.Emphasis(scale_pm=1000)
        assert load_pack("bold", 3).emphasis.scale_pm == 2000
        refused = [("bold", 10 + index) for index in range(len(bad))]
        for pack_id, version in [*refused, ("sorot", 4), ("box", 5)]:
            with pytest.raises(ValueError, match="emphasis"):
                load_pack(pack_id, version)
    finally:
        monkeypatch.undo()
        captions_ass._load_pack.cache_clear()
    for pack_id in ("sorot", "box"):
        pack = dataclasses.replace(load_pack(pack_id, 1), emphasis=load_pack("bold", 1).emphasis)
        with pytest.raises(ValueError, match="emphasis"):
            build_ass_v2((), play_res=(720, 1280), fps=NTSC, total_frames=30, pack=pack,
                         overrides=OVERRIDES[pack_id], hook=None)


def test_a_keyword_takes_the_pack_size_and_accent_font_and_both_are_reset_after_it():
    # Bold: Montserrat at 72 px, the keyword in Anton at 140 % (round half up of 100.8).
    events = _events(_v2((KEYWORD_CUE,), "bold"))
    assert [_strip(event["Text"]) for event in events] == ["GUE BUKAN JAMBRET."] * 3
    assert events[1]["Text"] == (
        "GUE {\\1c" + PINK + "\\fs101\\fnAnton}BUKAN{\\1c" + WHITE
        + "\\fs72\\fnMontserrat ExtraBold} JAMBRET.")
    assert events[0]["Text"].startswith("{\\1c" + YELLOW + "}GUE{\\1c" + WHITE + "} {\\1c")
    # Karaoke: a size only, no accent font; the bold DejaVu face stays.
    [karaoke] = _events(_v2((KEYWORD_CUE,), "karaoke"))
    assert "\\fn" not in karaoke["Text"] and "\\b" not in karaoke["Text"]
    # A pack without the block keeps the colour alone.
    [classic] = _events(_v2((KEYWORD_CUE,), "classic"))
    assert "\\fs" not in classic["Text"]


def test_the_keyword_size_follows_the_caption_size_and_the_output():
    events = _events(_v2((KEYWORD_CUE,), "bold", size=(1080, 1920), size_pm=1200))
    base = _rhu(1920 * 12 * 1350 * 1200, 288 * 1_000_000)  # 130
    assert f"\\fs{_rhu(base * 1400, 1000)}\\fnAnton}}BUKAN" in events[1]["Text"]
    assert f"\\fs{base}\\fnMontserrat ExtraBold}}" in events[1]["Text"]


def test_an_accent_font_of_another_weight_switches_bold_and_back():
    pack = dataclasses.replace(load_pack("karaoke", 1), emphasis=load_pack("bold", 1).emphasis)
    [karaoke] = _events(build_ass_v2((KEYWORD_CUE,), play_res=(720, 1280), fps=NTSC,
                                     total_frames=60, pack=pack,
                                     overrides=OVERRIDES["karaoke"], hook=None))
    assert "\\fs74\\fnAnton\\b0}bukan{" in karaoke["Text"]
    assert "\\fs53\\fnDejaVu Sans\\b1}" in karaoke["Text"]


def test_sinar_keyword_is_drawn_the_same_in_the_glow_and_the_line():
    glow, line = _events(_v2((KEYWORD_CUE,), "sinar"))
    accent = "\\fs83\\fnDM Serif Display Italic"
    reset = "\\fs59\\fnMontserrat ExtraBold"
    assert glow["Text"] == ("{\\an2\\pos(360,1062)\\q2" + GLOW_720 + "}gue {" + accent
                            + "}bukan{" + reset + "} jambret.")
    assert re.search(r"\{\\kf\d+\\1c" + PINK + r"\\2c" + PINK + re.escape(accent)
                     + r"\}bukan\{\\1c" + YELLOW + r"\\2c" + WHITE + re.escape(reset) + r"\}",
                     line["Text"])


def _line_px(words, pack_id, size):
    """The drawn width of a line in pixels: each word in its font and size, spaces at ``size``."""
    pack = load_pack(pack_id, 1)
    accent = pack.emphasis
    total = 0.0
    for text, keyword in words:
        if keyword:
            font = font_path(accent.font_file or pack.font_file)
            total += advance_px(text, font, _rhu(size * accent.scale_pm, 1000))
        else:
            total += advance_px(text, font_path(pack.font_file), size)
    return total + (len(words) - 1) * advance_px(" ", font_path(pack.font_file), size)


def test_one_line_packs_measure_the_keyword_in_its_own_size_and_font():
    pack = load_pack("sinar", 1)
    words = ("copet", "ketidakadilan", "semua")
    plain = _fcue(*((10 * i, 10 * i + 10, word) for i, word in enumerate(words)))
    keyword = _fcue(*((10 * i, 10 * i + 10, word, i == 1) for i, word in enumerate(words)))
    limit = 880 * 720 / 1000
    assert _line_px([(w, False) for w in words], "sinar", 59) <= limit
    assert _line_px([(w, i == 1) for i, w in enumerate(words)], "sinar", 59) > limit

    assert len(fit_cues((plain,), pack=pack, play_res=(720, 1280),
                        overrides=OVERRIDES["sinar"])) == 1
    fitted = fit_cues((keyword,), pack=pack, play_res=(720, 1280), overrides=OVERRIDES["sinar"])
    assert len(fitted) == 2
    for cue in fitted:
        shown = [(word.text, word.emphasis) for word in cue.words]
        assert len(shown) == 1 or _line_px(shown, "sinar", 59) <= limit


def test_a_single_wide_keyword_shrinks_until_its_accent_size_fits():
    word = "Supercalifragilisticexpialidocious"
    glow, line = _events(_v2((_fcue((0, 20, word, True)),), "sinar"))
    base = int(re.search(r"\\q2\\fs(\d+)", glow["Text"]).group(1))
    accent = int(re.search(r"\{\\fs(\d+)\\fnDM", glow["Text"]).group(1))
    assert base < 59 and accent == _rhu(base * 1400, 1000)
    font = font_path("DMSerifDisplay-Italic.ttf")
    limit = 880 * 720 / 1000
    assert advance_px(word, font, accent) <= limit
    assert advance_px(word, font, _rhu((base + 1) * 1400, 1000)) > limit
    assert f"\\q2\\fs{base}}}" in line["Text"] and f"\\fs{accent}\\fnDM" in line["Text"]


@pytest.mark.parametrize("entrance", ["fade", "pop", "blur"])
@pytest.mark.parametrize("pack", ["karaoke", "bold", "sinar"])
def test_the_entrance_opens_a_line_with_a_keyword_as_any_other(pack, entrance):
    plain = _fcue((0, 10, "gue"), (10, 25, "bukan"), (25, 40, "jambret."))
    with_keyword = _events(_v2((KEYWORD_CUE,), pack, entrance=entrance))
    without = _events(_v2((plain,), pack, entrance=entrance))
    opening = _entrance(entrance, 10 * (safe_cs(10 if pack == "bold" else 40, NTSC)
                                        - safe_cs(0, NTSC)), pack=pack)
    assert any(e["Text"].startswith(opening) for e in with_keyword)
    assert [e["Text"].startswith(opening) for e in with_keyword] == [
        e["Text"].startswith(opening) for e in without]


def test_overrides_accept_words_max_from_one_to_four_only():
    for value in (1, 2, 3, 4):
        _v2((_fcue((0, 30, "halo")),), "classic", words_max=value)
    for value in (0, 5, "3", True, None):
        with pytest.raises(ValueError, match="words_max"):
            _v2((_fcue((0, 30, "halo")),), "classic", words_max=value)


# --- "Animasi masuk": a short entrance per caption line (CONTRACTS §5.39) -------------------------

ENTRANCE_CUES = (
    _fcue((0, 2, "gue"), (2, 20, "bukan"), (20, 31, "jambret.")),  # a 2-frame first window
    _fcue((40, 52, "Dia"), (52, 60, "ditahan"), (60, 70, "security"), (70, 90, "SENDIRI")),
    _fcue((120, 150, "Supercalifragilisticexpialidocious"), (150, 170, "kawan")),
)


# A fading line of an outlined pack draws its outline as a 1/64 px shadow (the border's shape,
# which libass never cuts), with the border itself transparent; a pack with a drop shadow draws
# it from a copy of the line whose fill and outline are transparent (CONTRACTS §5.39).
FADING_OUTLINE = "\\3a&HFF&\\4c&H000000&\\4a&H00&\\shad0.02"
DROP_SHADOW_COPY = "\\3a&HFF&\\1a&HFE&\\2a&HFE&"
OUTLINED_PACKS = ("classic", "karaoke", "bold", "sorot", "sinar")
DROP_SHADOW_PACKS = ("classic", "karaoke")


def _entrance(entrance, window_ms, height=1280, pack=None, extra=None):
    """The opening block of a line, from the contract's numbers (not from the module): with
    ``pack``, a fading entrance of an outlined pack also carries ``FADING_OUTLINE`` (or
    ``extra``)."""
    duration = min(120, window_ms)
    if entrance == "pop":
        return _pop(duration)
    tags = f"\\fad({duration},0)"
    if entrance == "blur":
        radius = _rhu(100 * height, 128)
        radius = str(radius // 100) if radius % 100 == 0 else f"{radius / 100:g}"
        tags += f"\\blur{radius}\\t(0,{duration},\\blur0)"
    if pack in OUTLINED_PACKS:
        tags += FADING_OUTLINE if extra is None else extra
    return f"{{{tags}}}"


def _pop_32nds(t, duration):
    """Pop's scale at ``t`` ms in 32nds, half up: 70 % to 108 % over the first two thirds of
    ``duration``, then back to 100 % (CONTRACTS §5.39)."""
    turn = _rhu(2 * duration, 3)
    if t < turn:
        return _rhu(32 * (70 * turn + 38 * t), 100 * turn)
    return _rhu(32 * (108 * (duration - turn) - 8 * (t - turn)), 100 * (duration - turn))


def _percent_of_32nds(n):
    """``100·n/32`` written out exactly (it has at most three decimals)."""
    whole, rest = divmod(25 * n, 8)
    return str(whole) if rest == 0 else f"{whole}.{rest * 125:03d}".rstrip("0")


def _pop(duration):
    """Pop from the contract's numbers: the starting scale, then one instant step per change,
    every 10 ms and at the end, each scale a whole number of 32nds."""
    scale = _pop_32nds(0, duration)
    tags = f"\\fscx{_percent_of_32nds(scale)}\\fscy{_percent_of_32nds(scale)}"
    for t in [*range(10, duration, 10), duration]:
        step = _pop_32nds(t, duration)
        if step != scale:
            scale = step
            value = _percent_of_32nds(scale)
            tags += f"\\t({t},{t},\\fscx{value}\\fscy{value})"
    return f"{{{tags}}}"


def test_pop_scales_are_whole_32nds_in_10_ms_steps():
    # Under a continuous \t scale JASSUB and FFmpeg placed glyphs apart now and then: 82 % or
    # 89.5 % moved an outline edge by up to 0.15 px between the two (P-TXT 18-39 levels), while
    # every 32nd from 68.75 % to 109.375 % agreed on every Pop clip. So Pop steps through 32nds
    # (68.75 % first, 109.375 % at the peak, 100 % at the end).
    [line] = _events(_v2(ENTRANCE_CUES[1:2], "classic", entrance="pop"))
    block = line["Text"][:line["Text"].index("}") + 1]
    assert block == _pop(120)
    assert block.startswith("{\\fscx68.75\\fscy68.75\\t(10,10,\\fscx")
    assert "\\t(80,80,\\fscx109.375\\fscy109.375)" in block
    assert block.endswith("\\t(120,120,\\fscx100\\fscy100)}")
    for value in re.findall(r"\\fscx([\d.]+)", block):
        assert (float(value) * 32 / 100).is_integer(), value
    assert _pop(10) == "{\\fscx68.75\\fscy68.75\\t(10,10,\\fscx100\\fscy100)}"


def test_overrides_accept_the_four_entrances_only():
    for value in ("none", "fade", "pop", "blur"):
        _v2((_fcue((0, 30, "halo")),), "classic", entrance=value)
    for value in ("bounce", "Fade", "", 1, True, None):
        with pytest.raises(ValueError, match="entrance"):
            _v2((_fcue((0, 30, "halo")),), "classic", entrance=value)


@pytest.mark.parametrize("pack", PACK_IDS)
def test_no_entrance_and_none_write_the_same_bytes(pack):
    hook = HookSpec("Dia ditahan security", 0, 60, 13000)
    assert (_v2(ENTRANCE_CUES, pack, hook=hook, entrance="none")
            == _v2(ENTRANCE_CUES, pack, hook=hook))


@pytest.mark.parametrize("entrance", ["fade", "pop", "blur"])
@pytest.mark.parametrize("pack", PACK_IDS)
def test_the_entrance_opens_only_the_first_window_of_each_line(pack, entrance):
    hook = HookSpec("Dia ditahan security", 0, 60, 13000)
    plain = _v2(ENTRANCE_CUES, pack, hook=hook)

    animated = _v2(ENTRANCE_CUES, pack, hook=hook, entrance=entrance)

    # Every event keeps its frames, layer and style: only the text of a line's first window
    # gains the opening block (with a drop shadow's copy, see FADING_OUTLINE), and the hook and
    # the header do not change at all.
    assert animated.split("[Events]")[0] == plain.split("[Events]")[0]
    lines = fit_cues(ENTRANCE_CUES, pack=load_pack(pack, 1), play_res=(720, 1280),
                     overrides=OVERRIDES[pack])
    openings = {max(0, safe_cs(cue.f0, NTSC)) for cue in lines}
    before, after = _events(plain), iter(_events(animated))
    copies = entrance != "pop" and pack in DROP_SHADOW_PACKS
    opened = 0
    for old in before:
        new = next(after)
        start = _centiseconds(old["Start"])
        if old["Style"] != "Hook" and start in openings:
            window = 10 * (_centiseconds(old["End"]) - start)
            layer = old["Layer"]
            if copies:
                # The drop shadow's copy comes first with the line's frames, layer and style;
                # the line itself moves to layer 1 so that libass never stacks the two apart.
                assert {k: v for k, v in new.items() if k != "Text"} == {
                    k: v for k, v in old.items() if k != "Text"}
                assert new["Text"] == _entrance(entrance, window, pack=pack,
                                                extra=DROP_SHADOW_COPY) + old["Text"]
                new, layer = next(after), "1"
            assert new["Text"] == _entrance(entrance, window, pack=pack) + old["Text"]
            assert new["Layer"] == layer
            opened += 1
        else:
            assert new["Text"] == old["Text"] and new["Layer"] == old["Layer"]
        assert {k: v for k, v in new.items() if k not in ("Text", "Layer")} == {
            k: v for k, v in old.items() if k not in ("Text", "Layer")}
    assert next(after, None) is None
    # Sorot's first window is every word of the line plus the box, Sinar's the glow and the line;
    # the other packs draw a line as one event.
    if pack == "sorot":
        assert opened == sum(len(cue.words) + 1 for cue in lines)
    elif pack == "sinar":  # the glow opens with its line
        assert opened == 2 * len(lines)
    else:
        assert opened == len(lines)


def test_an_entrance_never_outlasts_the_first_window_of_its_line():
    # "gue" is on screen for two frames (70 ms at 29.97): the entrance is that long, then the
    # next word's window shows the line settled.
    events = _events(_v2(ENTRANCE_CUES[:1], "bold", entrance="fade"))
    first = 10 * (_centiseconds(events[0]["End"]) - _centiseconds(events[0]["Start"]))
    assert first < 120
    assert events[0]["Text"].startswith(f"{{\\fad({first},0){FADING_OUTLINE}}}")
    assert "\\fad" not in events[1]["Text"]
    [line] = _events(_v2(ENTRANCE_CUES[1:2], "classic", entrance="pop"))
    assert line["Text"].startswith(_pop(120))


def test_blur_starts_at_one_128th_of_the_output_height():
    small = _events(_v2(ENTRANCE_CUES[1:2], "classic", entrance="blur"))[0]["Text"]
    large = _events(_v2(ENTRANCE_CUES[1:2], "classic", size=(1080, 1920),
                        entrance="blur"))[0]["Text"]
    assert small.startswith("{\\fad(120,0)\\blur10\\t(0,120,\\blur0)")
    assert large.startswith("{\\fad(120,0)\\blur15\\t(0,120,\\blur0)")


# --- The text watermark: one line over the whole clip (CONTRACTS §5.43) ------------------------

WATERMARK_FONT = font_path("DejaVuSans-Bold.ttf")
WATERMARK_CUES = ENTRANCE_CUES[:2]


def _mark(text="@potongin.klip", pos="top_center", size_pm=1000, opacity_pm=850):
    return WatermarkSpec(text, pos, size_pm, opacity_pm)


def _with_mark(watermark, pack="classic", *, size=(720, 1280), hook=None, total=200):
    return build_ass_v2(WATERMARK_CUES, play_res=size, fps=NTSC, total_frames=total,
                        pack=load_pack(pack, 1), overrides=dict(OVERRIDES[pack]), hook=hook,
                        watermark=watermark)


def _expected_mark(spec, size=(720, 1280)):
    """Font size, outline (centipixels), anchor x and bottom y, \\an and alpha from the
    contract's numbers (not from the module)."""
    width, height = size
    top, bottom = _rhu(93 * height, 1280), _rhu(280 * height, 1280)
    right, left = _rhu(93 * width, 720), _rhu(4 * width, 100)
    row, column = spec.pos.split("_")
    font_size = max(1, _rhu(height * spec.size_pm, 40_000))
    edge = -(-_rhu(100 * font_size, 16) // 100)
    usable = (width - 2 * right if column == "center" else width - right - left) - 2 * edge
    units, height_units = advance_units(spec.text, WATERMARK_FONT)
    if units * font_size > usable * height_units:
        font_size = max(1, usable * height_units // units)
    outline = _rhu(100 * font_size, 16)
    edge = -(-outline // 100)
    x = {"left": left + edge, "center": width // 2, "right": width - right - edge}[column]
    y = {"top": top + edge + font_size, "middle": _rhu(height + font_size, 2),
         "bottom": height - bottom - edge}[row]
    alignment = {"left": 1, "center": 2, "right": 3}[column]
    return font_size, outline, x, y, alignment, 255 - _rhu(255 * spec.opacity_pm, 1000)


def test_without_a_watermark_the_bytes_do_not_change():
    hook = HookSpec("Dia ditahan security", 0, 60, 13000)
    assert _with_mark(None, "karaoke", hook=hook) == _v2(WATERMARK_CUES, "karaoke", hook=hook,
                                                         total=200)


@pytest.mark.parametrize("pack", PACK_IDS)
def test_the_watermark_is_one_event_over_the_whole_clip_drawn_under_the_rest(pack):
    hook = HookSpec("Dia ditahan security", 0, 60, 13000)
    plain = _with_mark(None, pack, hook=hook)

    marked = _with_mark(_mark(), pack, hook=hook)

    # One more style line and one more event, first in the file at layer 0, so the captions
    # (layer 0, read later) and the hook (layer 1) are drawn over it. Nothing else moves.
    assert _sections(marked)["[V4+ Styles]"] == [*_sections(plain)["[V4+ Styles]"],
                                                 _style_line(marked, "Watermark")]
    first, *rest = _events(marked)
    assert rest == _events(plain)
    font_size, _outline, x, y, alignment, _alpha = _expected_mark(_mark())
    assert first == {"Layer": "0", "Start": "0:00:00.00",
                     "End": captions_ass._ass_time_cs(safe_cs(200, NTSC)), "Style": "Watermark",
                     "Name": "", "MarginL": "0", "MarginR": "0", "MarginV": "0", "Effect": "",
                     "Text": f"{{\\an{alignment}\\pos({x},{y})\\q2\\blur1}}@potongin.klip"}
    assert (font_size, x, y) == (32, 360, 127)


def test_the_watermark_style_is_white_dejavu_bold_with_an_outline_at_its_opacity():
    for spec, size in ((_mark(), (720, 1280)), (_mark(size_pm=2000, opacity_pm=200), (720, 1280)),
                       (_mark(size_pm=500, opacity_pm=1000), (1080, 1920))):
        font_size, outline, _x, _y, _alignment, alpha = _expected_mark(spec, size)
        style = _styles(_with_mark(spec, size=size))["Watermark"]
        assert style["Fontname"] == "DejaVu Sans" and style["Bold"] == "-1"
        assert style["Fontsize"] == str(font_size)
        assert style["PrimaryColour"] == style["SecondaryColour"] == f"&H{alpha:02X}FFFFFF"
        # The outline is drawn as a 1/64 px shadow of the border's shape, which libass never
        # cuts under a translucent fill; the border itself is transparent (CONTRACTS §5.43).
        assert style["OutlineColour"] == "&HFF000000"
        assert style["BackColour"] == f"&H{alpha:02X}000000"
        assert (style["BorderStyle"], style["Shadow"]) == ("1", "0.02")
        assert style["Outline"] == (str(outline // 100) if outline % 100 == 0
                                    else f"{outline / 100:g}")
    assert _styles(_with_mark(_mark()))["Watermark"]["PrimaryColour"] == "&H26FFFFFF"  # 85%


@pytest.mark.parametrize("size", [(720, 1280), (1080, 1920)])
@pytest.mark.parametrize("size_pm", [500, 1000, 2000])
@pytest.mark.parametrize("pos", WATERMARK_POSITIONS)
def test_every_position_keeps_the_line_out_of_the_tiktok_zone(pos, size_pm, size):
    width, height = size
    spec = _mark("Ikuti @potongin.klip", pos, size_pm)
    font_size, outline, x, y, alignment, _alpha = _expected_mark(spec, size)

    layout = layout_watermark(spec, play_res=size)

    assert (layout.font_size, layout.outline_cp, layout.y, layout.alignment) == (
        font_size, outline, y, alignment)
    [event] = [e for e in _events(_with_mark(spec, size=size)) if e["Style"] == "Watermark"]
    blur = "1" if height == 1280 else "1.5"  # H/1280 (CONTRACTS §5.43)
    assert event["Text"] == (f"{{\\an{alignment}\\pos({x},{y})\\q2\\blur{blur}}}"
                             "Ikuti @potongin.klip")
    # The drawn line (its advance plus the outline) stays inside the frame and outside the
    # top, bottom and right zones (93, 280 and 93 px at 720×1280).
    edge = -(-outline // 100)
    line = font_size * advance_px("Ikuti @potongin.klip", WATERMARK_FONT, 1)
    x0 = {1: x, 2: x - line / 2, 3: x - line}[alignment]
    assert x0 - edge >= 0 and x0 + line + edge <= width - _rhu(93 * width, 720) + 1e-6
    assert y - font_size - edge >= _rhu(93 * height, 1280)
    assert y + edge <= height - _rhu(280 * height, 1280)


def test_a_wide_watermark_shrinks_to_fit_its_column():
    wide = _mark("W" * 40, "top_left", 2000)
    font_size, _outline, _x, _y, _alignment, _alpha = _expected_mark(wide)

    layout = layout_watermark(wide, play_res=(720, 1280))

    assert layout.font_size == font_size < _rhu(1280 * 2000, 40_000)
    assert font_size * advance_px("W" * 40, WATERMARK_FONT, 1) <= 720 - 93 - 29


def test_the_watermark_outline_has_a_soft_edge_of_one_1280th_of_the_height():
    # Under 4:2:0 a hard outline around small white text over the video rings in chroma: P-ENC
    # measured the smallest watermark (16 px, Tengah kiri) at SSIM 0.9678 on its text, and a
    # larger size did not help (0.9564 at 32 px). A blur of H/1280 on the outline (the border's
    # shadow; the fill stays sharp) brings it to 0.9866 (CONTRACTS §5.43).
    for size, blur in (((720, 1280), "\\blur1}"), ((1080, 1920), "\\blur1.5}"),
                       ((1080, 1080), "\\blur1.5}")):
        [event] = [e for e in _events(_with_mark(_mark(size_pm=500, pos="middle_left"),
                                                 size=size)) if e["Style"] == "Watermark"]
        assert blur in event["Text"]


def test_the_watermark_text_is_escaped():
    [event] = [e for e in _events(_with_mark(_mark("{\\b1}@akun\\N"))) if e["Style"] == "Watermark"]
    assert event["Text"].endswith("}\\{\\⁠b1\\}@akun\\⁠N")


@pytest.mark.parametrize("change", [
    {"text": ""}, {"text": " "}, {"text": 7}, {"pos": "center"}, {"pos": "top"},
    {"size_pm": 499}, {"size_pm": 2001}, {"size_pm": 1000.0}, {"size_pm": True},
    {"opacity_pm": 199}, {"opacity_pm": 1001},
])
def test_build_ass_v2_rejects_an_invalid_watermark(change):
    spec = dataclasses.replace(_mark(), **change)
    with pytest.raises(ValueError, match="watermark"):
        _with_mark(spec)
    with pytest.raises(TypeError, match="watermark"):
        _with_mark({"text": "@akun"})
