"""Hook designs next to the bar: Kicker, Blok and Kotak kata (plan 2026-10-20 P1 #10).

Each design is a file ``resources/hook-designs/<id>/v1.json`` drawn by ``captions_ass``
(``layout_hook`` + ``build_ass_v2``). Every design keeps the bar's auto-fit (the largest font
whose lines fit, else the tail cut with "…" and ``overflow``), so the "Muat / Akan terpotong"
badge reads the same plan field for all of them (CONTRACTS §5.33).
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from ai_clipper import captions_ass
from ai_clipper.captions_ass import (
    LEGACY_HOOK_DESIGN,
    HookSpec,
    boxed_word_index,
    build_ass_v2,
    hook_design,
    hook_font_file,
    layout_hook,
    load_hook_design,
    load_pack,
)
from ai_clipper.edit_v2 import HOOK_DESIGN_IDS, PACK_DEFAULT_OVERRIDES
from ai_clipper.edit_v2.glyphs import advance_units, font_path, fonts_manifest
from ai_clipper.edit_v2.timemap import Fps, safe_cs

ROOT = Path(__file__).resolve().parents[1]
DESIGNS_DIR = ROOT / "resources" / "hook-designs"
NEW = ("kicker", "blok", "kotak")
SIZE = (720, 1280)
MONTSERRAT = "Montserrat-ExtraBold.ttf"
ACCENT = "&H4DE1FF&"  # #FFE14D
DARK = "&H111111&"
NTSC = Fps(30000, 1001)
TEXTS = (
    "Halo semua",
    "Dia ditahan security di film-nya sendiri",
    "Ternyata: dia ditahan satpam di lokasi syuting filmnya sendiri, padahal sudah bawa tiket",
    "Supercalifragilisticexpialidociousmenyebalkansekali",
)
_TAGS = re.compile(r"\{([^}]*)\}")
_POS = re.compile(r"\\pos\((\d+(?:\.\d+)?),(\d+)\)")
_DRAWING = re.compile(r"\\p1\}(m [0-9 mlb]+)\{\\p0\}$")
# Tags a design may write: fade, position, no wrap, size, colour, no border, a box's soft edge,
# drawing mode.
_ALLOWED = re.compile(r"(\\(fad\(150,250\)|an2|pos\(\d+(\.\d{1,2})?,\d+\)|q2|fs\d+"
                      r"|bord\d+(\.\d{1,2})?|shad0|blur\d+(\.\d{1,2})?|p[01]|1c&H[0-9A-F]{6}&))+")


def _rhu(numerator: int, denominator: int) -> int:
    return (2 * numerator + denominator) // (2 * denominator)


def _layout(text: str, design: str, *, y_e5: int = 13000, size=SIZE):
    return layout_hook(text, play_res=size, y_e5=y_e5, design=(design, 1))


def _document(text: str, design: str, *, f0: int = 0, f1: int = 120, y_e5: int = 13000,
              fps: Fps = NTSC, size=SIZE) -> str:
    return build_ass_v2((), play_res=size, fps=fps, total_frames=f1 + 30,
                        pack=load_pack("classic", 1),
                        overrides=dict(PACK_DEFAULT_OVERRIDES["classic"]),
                        hook=HookSpec(text, f0, f1, y_e5, (design, 1)))


def _dialogues(document: str) -> list[list[str]]:
    return [line.removeprefix("Dialogue: ").split(",", 9) for line in document.splitlines()
            if line.startswith("Dialogue: ")]


def _hook_style(document: str) -> dict[str, str]:
    lines = document.split("[V4+ Styles]\n", 1)[1].split("\n\n", 1)[0].splitlines()
    names = [name.strip() for name in lines[0].removeprefix("Format:").split(",")]
    for line in lines[1:]:
        values = [value.strip() for value in line.removeprefix("Style:").split(",")]
        if values[0] == "Hook":
            return dict(zip(names, values, strict=True))
    raise AssertionError("no Hook style")


def _cs(stamp: str) -> int:
    hours, minutes, rest = stamp.split(":")
    seconds, cents = rest.split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 100 + int(cents)


def _parts(event_text: str) -> dict:
    """``{"kind": "box"|"text", "x", "y", "tags", "body"}`` of one hook event text."""
    tags = "".join(_TAGS.findall(event_text))
    x, y = _POS.search(event_text).groups()
    drawing = _DRAWING.search(event_text)
    if drawing:
        return {"kind": "box", "x": float(x), "y": int(y), "tags": tags, "body": drawing.group(1)}
    return {"kind": "text", "x": float(x), "y": int(y), "tags": tags,
            "body": _TAGS.sub("", event_text)}


def _extent(path: str) -> tuple[int, int]:
    numbers = [int(value) for value in re.findall(r"\d+", path)]
    return max(numbers[0::2]), max(numbers[1::2])


def _fits(text: str, size: int, usable: int) -> bool:
    units, height = advance_units(text, font_path(MONTSERRAT))
    return units * size <= usable * height


# --- the design files ---------------------------------------------------------------------------


def test_the_design_list_matches_the_files_and_the_bar_comes_first():
    assert HOOK_DESIGN_IDS == ("legacy-bar", "kicker", "blok", "kotak")
    assert sorted(path.parent.name for path in DESIGNS_DIR.glob("*/v1.json")) == sorted(
        HOOK_DESIGN_IDS)
    assert LEGACY_HOOK_DESIGN == ("legacy-bar", 1)


def _no_float(value):
    raise AssertionError(f"float in a design file: {value}")


@pytest.mark.parametrize("design_id", NEW)
def test_new_designs_load_with_an_ofl_font_already_registered(design_id):
    raw = (DESIGNS_DIR / design_id / "v1.json").read_bytes()
    json.loads(raw, parse_float=_no_float, parse_constant=_no_float)
    spec = hook_design(design_id, 1)
    assert (spec.id, spec.v) == (design_id, 1)
    assert spec.sha256 == hashlib.sha256(raw).hexdigest()
    assert spec.font_file == MONTSERRAT and hook_font_file((design_id, 1)) == MONTSERRAT
    entry = next(font for font in fonts_manifest()["fonts"] if font["file"] == spec.font_file)
    assert entry["license"] == "OFL-1.1"
    assert spec.max_lines == 3
    assert (spec.fade_in_ms, spec.fade_out_ms, spec.layer) == (150, 250, 1)
    assert load_hook_design(design_id, 1)["layout"] == spec.layout
    assert hook_design(design_id, 1) is spec


def test_each_design_has_its_layout_and_name():
    assert {d: (hook_design(d, 1).layout, hook_design(d, 1).name) for d in NEW} == {
        "kicker": ("kicker", "Kicker"), "blok": ("block", "Blok"),
        "kotak": ("keyword", "Kotak kata")}
    assert hook_design("legacy-bar", 1) is None  # the bar's geometry is code (layout_hook)
    assert hook_font_file(LEGACY_HOOK_DESIGN) == "DejaVuSans-Bold.ttf"


def _write_design(root: Path, design_id: str, version: int, data: dict) -> None:
    (root / design_id).mkdir(exist_ok=True)
    (root / design_id / f"v{version}.json").write_text(json.dumps(data), encoding="utf-8")


@pytest.mark.parametrize(("change", "message"), [
    (lambda d: d.update(layout="sticker"), "layout"),
    (lambda d: d.update(box=None), "box"),
    (lambda d: d.update(kicker={"scale_pm": 500, "max_words": 5, "gap_pm": 0}), "kicker"),
    (lambda d: d["font"].update(file="Comic.ttf"), "font"),
    (lambda d: d.update(font_ratios_e5=[4000, 4400]), "font_ratios_e5"),
    (lambda d: d.update(font_ratios_e5=[]), "font_ratios_e5"),
    (lambda d: d["colours"].update(accent="#ffe14d"), "colours"),
    (lambda d: d["box"].update(pad_x_pm=-1), "box"),
    (lambda d: d.update(max_lines=0), "max_lines"),
    (lambda d: d.update(max_chars=120), "max_chars"),
    (lambda d: d.update(extra=1), "potongin.hook-design/1"),
])
def test_a_design_file_with_a_wrong_field_is_refused(tmp_path, monkeypatch, change, message):
    data = json.loads((DESIGNS_DIR / "kotak" / "v1.json").read_bytes())
    data["v"] = 9
    change(data)
    _write_design(tmp_path, "kotak", 9, data)
    monkeypatch.setattr(captions_ass, "HOOK_DESIGNS_DIR", tmp_path)
    captions_ass._hook_design.cache_clear()
    try:
        with pytest.raises(ValueError, match=message):
            hook_design("kotak", 9)
    finally:
        monkeypatch.undo()
        captions_ass._hook_design.cache_clear()


def test_a_block_design_draws_its_lines_in_the_on_accent_colour(tmp_path, monkeypatch):
    data = json.loads((DESIGNS_DIR / "blok" / "v1.json").read_bytes())
    data["v"] = 9
    data["colours"]["text"] = "#FFFFFF"
    _write_design(tmp_path, "blok", 9, data)
    monkeypatch.setattr(captions_ass, "HOOK_DESIGNS_DIR", tmp_path)
    captions_ass._hook_design.cache_clear()
    try:
        with pytest.raises(ValueError, match="on_accent"):
            hook_design("blok", 9)
    finally:
        monkeypatch.undo()
        captions_ass._hook_design.cache_clear()


@pytest.mark.parametrize("design", [("banner", 1), ("kicker", 2), ("../kicker", 1), ("kicker", True)])
def test_unknown_designs_are_rejected(design):
    with pytest.raises(ValueError):
        layout_hook("Hook", play_res=SIZE, y_e5=13000, design=design)


# --- the bar is unchanged -----------------------------------------------------------------------


@pytest.mark.parametrize("text", TEXTS)
def test_the_bar_is_the_default_design_and_its_bytes_do_not_change(text):
    assert HookSpec(text, 0, 120, 13000).design == LEGACY_HOOK_DESIGN
    assert _layout(text, "legacy-bar") == layout_hook(text, play_res=SIZE, y_e5=13000)
    default = build_ass_v2((), play_res=SIZE, fps=Fps(30, 1), total_frames=150,
                           pack=load_pack("classic", 1),
                           overrides=dict(PACK_DEFAULT_OVERRIDES["classic"]),
                           hook=HookSpec(text, 0, 120, 13000))
    assert _document(text, "legacy-bar", fps=Fps(30, 1)) == default
    assert _layout(text, "legacy-bar").events == ()


# --- Kicker -------------------------------------------------------------------------------------


@pytest.mark.parametrize(("text", "kicker", "body"), [
    ("Ternyata: dia ditahan satpam", "Ternyata:", "dia ditahan satpam"),
    ("Dia ditahan security di film-nya sendiri", "Dia ditahan", "security di film-nya sendiri"),
    ("Kenapa semua orang ketawa?", "Kenapa", "semua orang ketawa?"),
    ("Satu, dua, tiga", "Satu,", "dua, tiga"),
    ("Ini kalimat panjang sekali tanpa tanda baca: lalu sisanya", "Ini kalimat panjang",
     "sekali tanpa tanda baca: lalu sisanya"),
])
def test_the_kicker_is_the_lead_in_up_to_the_first_mark_or_the_first_third(text, kicker, body):
    layout = _layout(text, "kicker")

    assert layout.lines[0] == kicker
    assert " ".join(layout.lines[1:]) == body
    assert not layout.overflow


@pytest.mark.parametrize("text", ["Halo", "Halo semua", "Kenapa?"])
def test_two_words_or_fewer_have_no_kicker(text):
    layout = _layout(text, "kicker")

    assert " ".join(layout.lines) == text
    assert all(ACCENT not in event for event in layout.events)


def test_the_kicker_is_a_small_accent_line_above_the_big_punchline():
    layout = _layout("Ternyata: dia ditahan satpam di lokasi", "kicker")
    document = _document("Ternyata: dia ditahan satpam di lokasi", "kicker")

    style = _hook_style(document)
    assert style["Fontname"] == "Montserrat ExtraBold" and int(style["Fontsize"]) == layout.font_size
    assert style["PrimaryColour"] == "&H00FFFFFF" and float(style["Outline"]) > 0
    parts = [_parts(fields[9]) for fields in _dialogues(document)]
    assert [part["kind"] for part in parts] == ["text"] * len(layout.lines)
    assert [part["body"] for part in parts] == list(layout.lines)
    kicker_size = int(re.search(r"\\fs(\d+)", parts[0]["tags"]).group(1))
    assert kicker_size < layout.font_size
    assert ACCENT in parts[0]["tags"]
    # The kicker's outline is the punchline's, scaled to its size.
    outline = float(re.search(r"\\bord(\d+(?:\.\d+)?)", parts[0]["tags"]).group(1))
    assert outline == pytest.approx(float(style["Outline"]) * kicker_size / layout.font_size,
                                    abs=0.01)
    assert all("\\fs" not in part["tags"] and ACCENT not in part["tags"] for part in parts[1:])
    assert {part["x"] for part in parts} == {360}
    ys = [part["y"] for part in parts]
    assert ys == sorted(ys) and len(set(ys)) == len(ys)
    # The kicker line's box starts at the hook's top (y_e5).
    assert ys[0] - kicker_size == layout.top == _rhu(13000 * 1280, 100_000)


def test_a_kicker_too_wide_for_its_size_shrinks_to_the_line():
    text = "Supercalifragilistic expialidocious menyebalkansekali: lalu ini"
    layout = _layout(text, "kicker")

    kicker = _parts(layout.events[0])
    size = int(re.search(r"\\fs(\d+)", kicker["tags"]).group(1))
    spec = hook_design("kicker", 1)
    side = _rhu(720 * spec.side_margin_pm, 1000)
    assert kicker["body"] == "Supercalifragilistic expialidocious menyebalkansekali:"
    assert size < _rhu(layout.font_size * spec.kicker.scale_pm, 1000)
    assert _fits(kicker["body"], size, 720 - 2 * side)


# --- Blok ---------------------------------------------------------------------------------------


def test_blok_puts_every_line_on_its_own_rounded_accent_box():
    text = "Dia ditahan security di film-nya sendiri"
    layout = _layout(text, "blok")
    document = _document(text, "blok")

    spec = hook_design("blok", 1)
    style = _hook_style(document)
    assert style["PrimaryColour"] == "&H00111111" and style["Outline"] == "0"
    parts = [_parts(fields[9]) for fields in _dialogues(document)]
    assert [part["kind"] for part in parts] == ["box", "text"] * len(layout.lines)
    size = layout.font_size
    pad = _rhu(size * spec.box.pad_x_pm, 1000)
    inset = _rhu(size * spec.box.top_pm, 1000)
    for index, line in enumerate(layout.lines):
        box, words = parts[2 * index], parts[2 * index + 1]
        assert words["body"] == line and "\\bord" not in words["tags"]
        assert ACCENT in box["tags"] and "\\bord0\\shad0\\blur1\\" in box["tags"]
        assert (box["x"], box["y"]) == (words["x"], words["y"]) == (360, words["y"])
        units, height = advance_units(line, font_path(MONTSERRAT))
        assert _extent(box["body"]) == (_rhu(size * units, height) + 2 * pad, size - inset)
    # The first box's top is the hook's top; boxes never touch.
    assert parts[0]["y"] - (size - inset) == layout.top
    tops = [part["y"] - (size - inset) for part in parts[0::2]]
    bottoms = [part["y"] for part in parts[0::2]]
    assert all(top > bottom for bottom, top in zip(bottoms, tops[1:], strict=False))


def test_blok_boxes_have_a_soft_edge_of_one_1280th_of_the_height():
    # Under 4:2:0 a hard yellow box edge over the video rings in chroma: P-ENC measured Blok at
    # SSIM 0.9888 whole frame and 0.9734 on the hook (thresholds 0.990 and 0.980). A blur of
    # H/1280 on the boxes (1 px at 1280, 1.5 at 1920) brings it to 0.9903 and 0.9864; Kotak's
    # single box and the text stay sharp (CONTRACTS §5.33).
    text = "Dia ditahan security di film-nya sendiri"
    for size, blur in (((720, 1280), "\\blur1\\"), ((1080, 1920), "\\blur1.5\\")):
        parts = [_parts(fields[9]) for fields in _dialogues(_document(text, "blok", size=size))]
        assert all(blur in part["tags"] for part in parts if part["kind"] == "box")
        assert all("\\blur" not in part["tags"] for part in parts if part["kind"] == "text")
    kotak = [_parts(fields[9]) for fields in _dialogues(_document(
        "Dia ditahan SECURITY di film-nya sendiri", "kotak"))]
    assert all("\\blur" not in part["tags"] for part in kotak)


# --- Kotak kata ---------------------------------------------------------------------------------


@pytest.mark.parametrize(("tokens", "index"), [
    (["Dia", "ditahan", "SECURITY", "di", "film-nya", "sendiri"], 2),
    (["Dia", "DITAHAN", "SECURITY"], 1),  # the first word in capitals
    (["Dia", "ditahan", "security", "di", "film-nya", "sendiri"], 2),  # the longest
    (["DIA", "DITAHAN", "SECURITY"], 2),  # all in capitals: the longest
    (["abcd", "efgh"], 1),  # equals: the last
    (["Harga", "BBM", "naik", "12%"], 1),
    (["AI", "jadi", "teman"], 0),
    (["A", "jadi", "teman"], 2),  # one letter is no word in capitals
])
def test_the_boxed_word_is_the_first_in_capitals_else_the_longest(tokens, index):
    assert boxed_word_index(tokens) == index


def test_kotak_boxes_one_word_and_leaves_the_other_lines_whole():
    text = "Dia ditahan SECURITY di film-nya sendiri"
    layout = _layout(text, "kotak")
    document = _document(text, "kotak")

    style = _hook_style(document)
    assert style["PrimaryColour"] == "&H00FFFFFF" and float(style["Outline"]) > 0
    parts = [_parts(fields[9]) for fields in _dialogues(document)]
    boxes = [index for index, part in enumerate(parts) if part["kind"] == "box"]
    assert len(boxes) == 1
    box, word = parts[boxes[0]], parts[boxes[0] + 1]
    assert word["body"] == "SECURITY"
    assert "\\bord0\\shad0" in word["tags"] and DARK in word["tags"]
    assert ACCENT in box["tags"] and (box["x"], box["y"]) == (word["x"], word["y"])
    spec = hook_design("kotak", 1)
    size = layout.font_size
    units, height = advance_units("SECURITY", font_path(MONTSERRAT))
    assert _extent(box["body"]) == (
        _rhu(size * units, height) + 2 * _rhu(size * spec.box.pad_x_pm, 1000),
        size - _rhu(size * spec.box.top_pm, 1000))
    boxed_line = next(line for line in layout.lines if "SECURITY" in line.split())
    same_line = [part for part in parts if part["kind"] == "text" and part["y"] == word["y"]]
    assert " ".join(part["body"] for part in same_line) == boxed_line
    whole = [part["body"] for part in parts if part["kind"] == "text" and part["y"] != word["y"]]
    assert whole == [line for line in layout.lines if line != boxed_line]
    # The words of the boxed line keep their order from left to right.
    assert [part["x"] for part in same_line] == sorted(part["x"] for part in same_line)


# --- shared by every new design -----------------------------------------------------------------


def _usable(design: str, size: int) -> int:
    spec = hook_design(design, 1)
    side = _rhu(720 * spec.side_margin_pm, 1000)
    num, den = spec.outline_ratio
    edge = -(-_rhu(100 * 1280 * num, den) // 100)
    if spec.box is not None:
        edge = max(edge, _rhu(size * spec.box.pad_x_pm, 1000))
    return 720 - 2 * side - 2 * edge


@pytest.mark.parametrize("design", NEW)
@pytest.mark.parametrize("text", TEXTS)
def test_lines_fit_the_frame_at_the_largest_size_that_fits(design, text):
    layout = _layout(text, design)

    spec = hook_design(design, 1)
    body = layout.lines[1:] if design == "kicker" and len(text.split()) >= 3 else layout.lines
    assert 1 <= len(body) <= spec.max_lines
    assert all(_fits(line, layout.font_size, _usable(design, layout.font_size)) for line in body)
    assert layout.font_size in [_rhu(1280 * ratio, 100_000) for ratio in spec.font_ratios_e5]
    assert not layout.overflow
    # Every character stays, in order (a word too wide for a line is split across lines).
    assert "".join(layout.lines).replace(" ", "") == text.replace(" ", "")


@pytest.mark.parametrize("design", NEW)
def test_a_short_text_takes_the_largest_size_and_a_longer_one_a_smaller(design):
    largest = _rhu(1280 * hook_design(design, 1).font_ratios_e5[0], 100_000)
    assert _layout(TEXTS[0], design).font_size == largest
    assert _layout(TEXTS[2], design).font_size < largest


@pytest.mark.parametrize("design", NEW)
def test_overflow_cuts_the_tail_with_an_ellipsis_and_is_reported(design):
    text = ("WWWWWWWWWWWWW " * 6).strip()  # one word per line even at the smallest size

    layout = _layout(text, design)

    body = layout.lines[1:] if design == "kicker" else layout.lines
    assert layout.overflow
    assert len(body) == 3 and body[-1].endswith("…")
    assert all(_fits(line, layout.font_size, _usable(design, layout.font_size)) for line in body)
    assert not _layout("Hook singkat", design).overflow


@pytest.mark.parametrize("design", NEW)
def test_events_are_frame_safe_on_layer_one_and_fade_like_the_bar(design):
    fps = Fps(25, 1)
    document = _document(TEXTS[1], design, f0=803, f1=903, fps=fps)

    events = _dialogues(document)
    layout = _layout(TEXTS[1], design)
    assert len(events) == len(layout.events) >= len(layout.lines)
    for fields in events:
        assert fields[0] == "1" and fields[3] == "Hook"
        assert (_cs(fields[1]), _cs(fields[2])) == (safe_cs(803, fps), safe_cs(903, fps))
        assert fields[9].startswith("{\\fad(150,250)\\an2\\pos(")
        assert all(_ALLOWED.fullmatch(tag) for tag in _TAGS.findall(fields[9])
                   if not tag.startswith("m ")), fields[9]


@pytest.mark.parametrize("design", NEW)
def test_y_e5_moves_the_whole_hook(design):
    low, high = _layout(TEXTS[1], design, y_e5=30000), _layout(TEXTS[1], design, y_e5=13000)

    shift = low.top - high.top
    assert shift == _rhu(30000 * 1280, 100_000) - _rhu(13000 * 1280, 100_000)
    assert [_parts(e)["y"] - shift for e in low.events] == [_parts(e)["y"] for e in high.events]


@pytest.mark.parametrize("design", NEW)
def test_hostile_text_is_escaped(design):
    layout = _layout("Rahasia {\\b1}copet} \\N SEKALI", design)

    for event in layout.events:
        own = re.findall(r"(?<!\\)\{([^}]*)\}", event)
        assert all(_ALLOWED.fullmatch(tag) or tag.startswith("m ") for tag in own), event
    assert "".join(layout.lines).count("{") == 1


@pytest.mark.parametrize("design", NEW)
def test_the_hook_scales_with_the_output_size(design):
    small, large = _layout(TEXTS[1], design), _layout(TEXTS[1], design, size=(1080, 1920))

    assert large.lines == small.lines
    assert large.font_size == pytest.approx(small.font_size * 1.5, abs=1)


@pytest.mark.parametrize("design", NEW)
def test_an_empty_text_draws_nothing(design):
    layout = _layout("   ", design)

    assert (layout.lines, layout.events, layout.overflow) == ((), (), False)
