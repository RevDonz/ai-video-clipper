"""Tests for the text-parity fixture generator (plan §11.1 T1.2b, ``scripts/parity/reference_text.py``).

The generator writes the ASS samples (today's ``build_ass`` for classic/karaoke/hook and
hand-written Bold/Box samples until T1.2a lands), the P-TIME timing fixture, the S-COLOR
candidate graphs and the FFmpeg references. Everything except the last part is pure and tested
here; one small end-to-end run uses the local FFmpeg when it has libass.
"""

from __future__ import annotations

import json
import re
import struct
import sys
from fractions import Fraction
from itertools import pairwise
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import compare
import reference_text as rt

from ai_clipper.edit_v2.timemap import Fps, now_ms, safe_cs

_DIALOGUE = re.compile(r"^Dialogue: (\d+),(\d+):(\d\d):(\d\d)\.(\d\d),(\d+):(\d\d):(\d\d)\.(\d\d),"
                       r"([^,]*),[^,]*,\d+,\d+,\d+,[^,]*,(.*)$")


def _events(ass: str) -> list[dict]:
    events = []
    for line in ass.splitlines():
        match = _DIALOGUE.match(line)
        if match:
            g = match.groups()
            start = ((int(g[1]) * 60 + int(g[2])) * 60 + int(g[3])) * 100 + int(g[4])
            end = ((int(g[5]) * 60 + int(g[6])) * 60 + int(g[7])) * 100 + int(g[8])
            events.append({"layer": int(g[0]), "start": start, "end": end, "style": g[9],
                           "text": g[10]})
    return events


def _style(ass: str, name: str) -> list[str]:
    for line in ass.splitlines():
        if line.startswith(f"Style: {name},"):
            return line[len("Style: "):].split(",")
    raise AssertionError(f"style {name} missing")


def _plain(text: str) -> str:
    return re.sub(r"\{[^}]*\}", "", text)


# --- samples ------------------------------------------------------------------------------------


def test_sample_texts_have_the_matrix_lengths() -> None:
    assert sorted(rt.SAMPLE_TEXTS) == [10, 40, 90]
    for length, text in rt.SAMPLE_TEXTS.items():
        assert len(text) == length
        assert text == text.strip() and "  " not in text


def test_ass_time_formats_centiseconds() -> None:
    assert rt.ass_time(0) == "0:00:00.00"
    assert rt.ass_time(6_012) == "0:01:00.12"
    assert rt.ass_time(360_000 * 3 + 5) == "3:00:00.05"
    assert rt.ass_time(-1) == "0:00:00.00"  # safe_cs(0) is −1 and is clamped


def test_word_timing_is_frame_based_and_cues_respect_the_pack_limits() -> None:
    fps = Fps(30000, 1001)
    words = rt.sample_words(rt.SAMPLE_TEXTS[90], fps=fps, start_f=6)
    assert [w.text for w in words] == rt.SAMPLE_TEXTS[90].split()
    assert words[0].f0 == 6
    assert all(a.f1 <= b.f0 for a, b in pairwise(words))
    for pack, limit in (("classic", 4), ("karaoke", 4), ("bold", 4), ("box", 3)):
        cues = rt.group_cues(words, pack=pack)
        assert all(1 <= len(cue.words) <= limit for cue in cues)
        assert [w for cue in cues for w in cue.words] == words
        assert all(cue.f0 == cue.words[0].f0 and cue.f1 >= cue.words[-1].f1 for cue in cues)
        assert all(a.f1 <= b.f0 for a, b in pairwise(cues))


def test_bold_sample_is_one_event_per_word_with_identical_glyphs() -> None:
    fps = Fps(30000, 1001)
    cues = rt.group_cues(rt.sample_words(rt.SAMPLE_TEXTS[40], fps=fps, start_f=6), pack="bold")
    ass = rt.bold_ass(cues, fps=fps, family="Montserrat ExtraBold")
    style = _style(ass, "Bold")
    assert style[1] == "Montserrat ExtraBold"
    assert style[2] == "72"  # 1.35 × 12/288 × 1280
    assert style[3] == "&H00FFFFFF" and style[15] == "1"  # white, BorderStyle 1
    assert style[16] == "14.22" and style[17] == "0"  # outline H/90, no shadow
    assert style[18] == "2" and style[21] == "218"  # bottom-centre, MarginV = H − 83% of H
    events = _events(ass)
    assert len(events) == sum(len(cue.words) for cue in cues)
    for cue in cues:
        cue_events = [e for e in events if safe_cs(cue.f0, fps) <= e["start"] < safe_cs(cue.f1, fps)
                      or (cue.f0 == 0 and e["start"] == 0)]
        texts = {_plain(e["text"]) for e in cue_events}
        assert texts == {" ".join(w.text for w in cue.words).upper()}
        assert all(e["text"].count("\\1c&H4DE1FF&") == 1 for e in cue_events)
        assert {re.sub(r"\\1c&H[0-9A-F]{6}&", "", e["text"]) for e in cue_events} == {
            re.sub(r"\\1c&H[0-9A-F]{6}&", "", cue_events[0]["text"])}
    for event, word in zip(events, [w for cue in cues for w in cue.words], strict=True):
        assert event["start"] == max(0, safe_cs(word.f0, fps))


def test_box_samples_use_one_line_translucent_boxes() -> None:
    fps = Fps(30000, 1001)
    cues = rt.group_cues(rt.sample_words(rt.SAMPLE_TEXTS[90], fps=fps, start_f=6), pack="box")
    border = rt.box_ass(cues, fps=fps, family="Montserrat ExtraBold", variant="border3")
    style = _style(border, "Box")
    assert style[2] == "64"  # 1.2 × 12/288 × 1280
    assert style[15] == "3" and style[16] == "13"  # BorderStyle 3, padding H/100
    assert style[5] == "&H40000000"  # black at 75% opacity on OutlineColour (defect #1 fix)
    assert len(_events(border)) == len(cues)
    pbox = rt.box_ass(cues, fps=fps, family="Montserrat ExtraBold", variant="pbox")
    events = _events(pbox)
    assert len(events) == 2 * len(cues)
    drawings = [e for e in events if "\\p1" in e["text"]]
    assert len(drawings) == len(cues) and all(e["layer"] == 0 for e in drawings)
    assert all("\\1a&H40&" in e["text"] for e in drawings)
    assert _style(pbox, "Box")[15] == "1" and _style(pbox, "Box")[16] == "0"
    with pytest.raises(ValueError):
        rt.box_ass(cues, fps=fps, family="x", variant="other")


def test_hook_and_classic_samples_come_from_todays_build_ass() -> None:
    fps = Fps(30000, 1001)
    cues = rt.group_cues(rt.sample_words(rt.SAMPLE_TEXTS[40], fps=fps, start_f=6), pack="classic")
    for style in ("classic", "karaoke"):
        ass = rt.legacy_ass(cues, fps=fps, style=style, total_frames=240)
        assert "PlayResX: 720" in ass and "PlayResY: 1280" in ass
        assert ("{\\k" in ass) == (style == "karaoke")
    hook = rt.hook_ass(rt.HOOK_TEXT, fps=fps, total_frames=240)
    assert sum(1 for e in _events(hook) if e["style"] == "Hook") >= 2
    assert "\\fad(150,250)" in hook


# --- timing fixture -----------------------------------------------------------------------------


@pytest.mark.parametrize("fps", [Fps(24, 1), Fps(25, 1), Fps(30, 1), Fps(24000, 1001),
                                 Fps(30000, 1001)])
def test_hazard_frames_are_exactly_the_double_rounding_frames(fps: Fps) -> None:
    hazards = rt.hazard_frames(fps, stop=5_000)
    exact = [n for n in range(1, 5_000)
             if now_ms(n, fps) < Fraction(n * 1000 * fps.den, fps.num)
             and now_ms(n, fps) != n * 1000 * fps.den // fps.num]
    assert hazards == exact


@pytest.mark.parametrize("fps", [Fps(24, 1), Fps(25, 1), Fps(30, 1), Fps(24000, 1001),
                                 Fps(30000, 1001)])
def test_timing_fixture_is_frame_safe_and_covers_hazards(fps: Fps) -> None:
    ass, lanes, transitions = rt.timing_ass(fps)
    events = _events(ass)
    assert events
    assert set(lanes) == {"start", "end", "karaoke", "active_word", "hook"}
    # Each lane has its own fill colours and no outline, so the lanes never share a colour.
    colours = [c for lane in lanes.values() for c in lane["colors"]]
    assert len(colours) == len(set(colours))
    assert [lane["fade"] for lane in lanes.values()].count(True) == 1
    for lane in lanes:
        frames = sorted(t["frame"] for t in transitions if t["lane"] == lane)
        assert frames and all(b - a >= 3 for a, b in pairwise(frames))
    frames = [t["frame"] for t in transitions]
    hazards = set(rt.hazard_frames(fps, stop=max(frames) + 1))
    assert any(t["hazard"] for t in transitions) == bool(hazards)
    assert all(t["hazard"] == (t["frame"] in hazards) for t in transitions)
    kinds = {t["kind"] for t in transitions}
    assert {"start", "end", "karaoke", "active_word", "hook_start", "hook_end"} <= kinds
    if hazards:
        hazard_kinds = {t["kind"] for t in transitions if t["hazard"]}
        assert {"start", "end", "karaoke", "active_word", "hook_start"} <= hazard_kinds
    # Every event edge is written at the frame-safe centisecond of a transition frame.
    starts = {max(0, safe_cs(t["frame"], fps)) for t in transitions}
    assert {e["start"] for e in events} <= starts | {0}
    assert {e["end"] for e in events} <= {safe_cs(t["frame"], fps) for t in transitions}
    # Karaoke durations sum to the event length.
    for event in events:
        ks = [int(k) for k in re.findall(r"\\k(\d+)", event["text"])]
        if ks:
            assert sum(ks) == event["end"] - event["start"]
    for transition in transitions:
        frame = transition["frame"]
        cs = safe_cs(frame, fps) * 10
        assert now_ms(frame - 1, fps) < cs <= now_ms(frame, fps) - 2


# --- fonts and fallback -------------------------------------------------------------------------


def _font_with_cmap(codepoints: list[int]) -> bytes:
    """A minimal sfnt with only a format-4 ``cmap`` covering ``codepoints`` (one segment each)."""
    segments = sorted(codepoints) + [0xFFFF]
    count = len(segments)
    ends = b"".join(struct.pack(">H", c) for c in segments)
    starts = b"".join(struct.pack(">H", c) for c in segments)
    deltas = b"".join(struct.pack(">h", 1 - c if c != 0xFFFF else 1) for c in segments)
    offsets = b"\0\0" * count
    sub = (struct.pack(">HHHHHHH", 4, 0, 0, count * 2, 0, 0, 0) + ends + b"\0\0" + starts
           + deltas + offsets)
    sub = sub[:2] + struct.pack(">H", len(sub)) + sub[4:]
    cmap = struct.pack(">HH", 0, 1) + struct.pack(">HHI", 3, 1, 12) + sub
    directory = struct.pack(">IHHHH", 0x00010000, 1, 16, 0, 0)
    record = b"cmap" + struct.pack(">III", 0, 12 + 16, len(cmap))
    return directory + record + cmap


def test_cmap_reader_and_fallback_choice() -> None:
    primary = _font_with_cmap([0x41, 0x42, 0x3A9])
    fallback = _font_with_cmap([0x41, 0x42, 0x3A9, 0x2665])
    assert rt.cmap_codepoints(primary) == frozenset({0x41, 0x42, 0x3A9})
    assert rt.choose_fallback_char(rt.cmap_codepoints(primary), rt.cmap_codepoints(fallback)) \
        == "\u2665"
    with pytest.raises(ValueError):
        rt.choose_fallback_char(frozenset({0x2665, 0x3A9, 0x2192, 0x2605, 0x266A}),
                                rt.cmap_codepoints(fallback))


# --- S-COLOR candidates -------------------------------------------------------------------------


def test_candidate_graphs_are_pinned() -> None:
    ass = "ass=filename=a.ass:fontsdir=fonts:shaping=complex"
    assert set(rt.CANDIDATES) >= {"yuv420p", "yuv444p", "gbrp"}
    assert rt.composite_graph("yuv420p", ass) == f"format=yuv420p,{ass}"
    assert rt.composite_graph("yuv444p", ass) == f"format=yuv444p,{ass}"
    assert rt.composite_graph("gbrp", ass) == (
        f"scale=in_color_matrix=bt709:in_range=tv,format=gbrp,{ass}")
    for name in rt.CANDIDATES:
        assert rt.final_graph(name).endswith("format=yuv420p")
        assert "out_color_matrix=bt709" in rt.final_graph(name)
        assert rt.view_graph(name).endswith("format=rgb24")
    assert rt.view_graph("gbrp") == "format=rgb24"
    assert "in_color_matrix=bt709" in rt.view_graph("yuv444p")
    assert rt.ass_filter("clip.ass") == "ass=filename=clip.ass:fontsdir=fonts:shaping=complex"


def test_encode_arguments_follow_r7() -> None:
    args = rt.x264_args(Fps(30000, 1001))
    joined = " ".join(args)
    for part in ("-c:v libx264", "-preset veryfast", "-crf 21", "-profile:v high",
                 "-pix_fmt yuv420p", "-g 60", "-x264-params threads=4",
                 "-color_primaries bt709", "-color_trc bt709", "-colorspace bt709",
                 "-color_range tv", "-map_metadata -1", "-fflags +bitexact",
                 "-flags:v +bitexact", "-movflags +faststart"):
        assert part in joined
    assert rt.x264_args(Fps(24, 1))[rt.x264_args(Fps(24, 1)).index("-g") + 1] == "48"


# --- the clip matrix ----------------------------------------------------------------------------


def test_clip_matrix_covers_every_pack_length_hook_fallback_and_variant() -> None:
    clips = rt.build_clips(fallback_char="\u2665")
    ids = [clip.id for clip in clips]
    assert len(ids) == len(set(ids))
    ptxt = [clip for clip in clips if clip.kind == "ptxt"]
    for pack in rt.PACKS:
        for length in (10, 40, 90):
            matching = [c for c in ptxt if c.pack == pack and c.chars == length and c.variant is None]
            assert len(matching) == 1, (pack, length)
            assert len(matching[0].probe_frames) == 5
    assert any(c.pack == "hook" for c in ptxt)
    assert any(c.pack == "fallback" and "\u2665" in c.ass for c in ptxt)
    variants = {(c.pack, c.variant) for c in ptxt if c.variant}
    assert {("bold", "dejavu"), ("box", "pbox")} <= variants
    assert any(c.kind == "pcolor" for c in clips)
    assert {c.fps for c in clips if c.kind == "ptime"} == {
        (24, 1), (25, 1), (30, 1), (24000, 1001), (30000, 1001)}
    for clip in clips:
        assert all(0 <= f < clip.total_frames for f in clip.probe_frames)
        # Probe frames stay ≥ 3 frames from every event and karaoke boundary.
        for frame in clip.probe_frames:
            assert all(abs(frame - edge) >= 3 for edge in clip.edges), (clip.id, frame)


# --- end to end with the local FFmpeg -----------------------------------------------------------


def _local_fonts(tmp_path: Path) -> Path:
    fonts = tmp_path / "fonts-in"
    fonts.mkdir()
    system = Path("/usr/share/fonts/truetype/dejavu")
    for name in ("DejaVuSans.ttf", "DejaVuSans-Bold.ttf"):
        if not (system / name).is_file():
            pytest.skip("DejaVu fonts not installed")
        (fonts / name).write_bytes((system / name).read_bytes())
    return fonts


def test_small_fixture_run_writes_references_that_differ_only_under_the_text(
    tmp_path: Path, edit_v2_libass: str
) -> None:
    fonts = _local_fonts(tmp_path)
    out = tmp_path / "fixtures"
    manifest = rt.generate(out, fonts_dir=fonts, formats=("gbrp", "yuv420p"),
                           only=("classic-10",), export=False, timing=False)
    assert manifest["schema"] == "potongin.parity-text/1"
    assert json.loads((out / "manifest.json").read_text()) == manifest
    (clip,) = manifest["clips"]
    assert clip["id"] == "classic-10"
    region = compare.Box(*clip["text_region"])
    for fmt in ("gbrp", "yuv420p"):
        for frame in clip["probe_frames"]:
            bg = compare.read_png(out / clip["files"]["bg"][fmt][str(frame)])
            ref = compare.read_png(out / clip["files"]["ref"][fmt][str(frame)])
            assert (bg.width, bg.height) == (720, 1280)
            box = compare.diff_bbox(bg, ref)
            assert box is not None
            assert region.contains(box)
    assert {f["file"] for f in manifest["fonts"]} == {"DejaVuSans.ttf", "DejaVuSans-Bold.ttf"}
    assert (out / "fonts.conf").read_text().count("<dir>") == 1
