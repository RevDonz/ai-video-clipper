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
    HOOK_TEXT_MAX_CHARS,
    CaptionPack,
    HookSpec,
    ass_escape,
    build_ass,
    build_ass_v2,
    estimate_text_width,
    fit_cues,
    layout_hook,
    load_hook_design,
    load_pack,
    shorten_hook_text,
)
from ai_clipper.edit_v2 import DOC_FPS, PACK_DEFAULT_OVERRIDES, PACK_IDS
from ai_clipper.edit_v2.glyphs import advance_px, font_path
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


# --- legacy bytes stay identical (T1.2a adds build_ass_v2 next to build_ass) --------------------

# sha256 over build_caption_cues/cues_to_srt and 108 build_ass documents, recorded on the wave
# base (a2bd7b2) before any T1.2a change. The V1 and v2-shadow paths keep calling these.
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
                    digest.update(build_ass(cues, width=width, height=height,
                                            duration=sum(b - a for a, b in ranges),
                                            caption_style=style, hook_text=hook,
                                            hook_duration=3.5, uppercase=upper).encode())
    assert digest.hexdigest() == LEGACY_PIN


# --- Editor V3: packs and build_ass_v2 (plan §5.4; T1.2a) ---------------------------------------

ROOT = Path(__file__).resolve().parents[1]
PACKS_DIR = ROOT / "resources" / "caption-packs"
HOOK_DESIGN = ROOT / "resources" / "hook-designs" / "legacy-bar" / "v1.json"
OVERRIDES = {pack: dict(PACK_DEFAULT_OVERRIDES[pack]) for pack in PACK_IDS}
STYLE_NAMES = {"classic": "Caption", "karaoke": "Karaoke", "bold": "Bold", "box": "Box"}
_OWN_TAG = re.compile(r"(?<!\\)\{([^}]*)\}")
_CAPTION_TAG = re.compile(r"(\\(k\d+|1c&H[0-9A-F]{6}&|2c&H[0-9A-F]{6}&|q2|fs\d+))+")
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
    """The frame window of every caption event, in emission order (bold: one per word)."""
    windows = []
    for cue in cues:
        if pack != "bold":
            windows.append((cue.f0, cue.f1))
            continue
        starts = [cue.f0] + [word.f0 for word in cue.words[1:]]
        ends = starts[1:] + [cue.f1]
        windows.extend((a, b) for a, b in zip(starts, ends, strict=True) if a < b)
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


def test_the_four_packs_load_with_the_seed_defaults_and_their_fonts():
    fonts = {"classic": "DejaVuSans.ttf", "karaoke": "DejaVuSans-Bold.ttf",
             "bold": "Montserrat-ExtraBold.ttf", "box": "Montserrat-ExtraBold.ttf"}
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
    assert [load_pack(p, 1).words_per_cue for p in PACK_IDS] == [4, 4, 3, 3]


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


def test_karaoke_k_switches_each_word_at_its_frame_and_sums_to_the_cue():
    fps = Fps(25, 1)
    cues = (_fcue((0, 7, "Kode"), (7, 21, "rahasia"), (21, 40, "copet"), f1=45),
            _fcue((803, 810, "mutus"), (812, 830, "mutus!")))

    document = _v2(cues, "karaoke", fps=fps)

    style = _styles(document)["Karaoke"]
    assert (style["PrimaryColour"], style["SecondaryColour"]) == ("&H004DE1FF", "&H00FFFFFF")
    for event, cue in zip(_events(document), cues, strict=True):
        start, end = _centiseconds(event["Start"]), _centiseconds(event["End"])
        durations = [int(v) for v in re.findall(r"\\k(\d+)", event["Text"])]
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


def test_emphasis_colour_wraps_the_word_and_is_reset_after_it():
    cue = _fcue((0, 10, "gue"), (10, 20, "bukan", True), (20, 30, "jambret."))
    wrapped = "{\\1c" + PINK + "}bukan{\\1c" + WHITE + "}"

    [classic] = _events(_v2((cue,), "classic"))
    assert classic["Text"] == f"gue {wrapped} jambret."
    [box] = _events(_v2((cue,), "box"))
    assert box["Text"] == "{\\q2}gue " + wrapped + " jambret."
    for event in _events(_v2((cue,), "bold")):
        assert "{\\1c" + PINK + "}BUKAN{\\1c" + WHITE + "}" in event["Text"]
    [karaoke] = _events(_v2((cue,), "karaoke"))
    assert re.search(r"\{\\k\d+\\1c" + PINK + r"\\2c" + PINK + r"\}bukan\{\\1c" + YELLOW
                     + r"\\2c" + WHITE + r"\}", karaoke["Text"])


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
        if pack == "box":
            expected = fit_cues((cue,), pack=loaded, play_res=(720, 1280),
                                overrides=OVERRIDES[pack])
            assert len(dialogues) == len(expected)
        else:
            assert len(dialogues) == (len(words) if pack == "bold" else 1)
        for line in dialogues:
            text = line.split(",", 9)[9]
            assert not any(unicodedata.category(c) in ("Cc", "Cs", "Zl", "Zp") for c in text)
            assert all(_CAPTION_TAG.fullmatch(tag) for tag in _OWN_TAG.findall(text)), text
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
