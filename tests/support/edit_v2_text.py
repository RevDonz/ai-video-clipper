"""Text gates of Editor V3 (T1.2a): P-TIME (FFmpeg side), the missing-glyph probe, ASS goldens.

Stdlib only, so the gates run in the reference image (which has no pytest)::

    PYTHONPATH=src:tests python -m support.edit_v2_text ptime OUT.json [--quick] [--jobs N]
    PYTHONPATH=src:tests python -m support.edit_v2_text glyph-probe OUT.json
    PYTHONPATH=src:tests python -m support.edit_v2_text goldens --write | --check
    PYTHONPATH=src:tests python -m support.edit_v2_text golden-evidence OUT.json
    PYTHONPATH=src:tests python -m support.edit_v2_text box-vector OUT.json

**P-TIME, FFmpeg side (plan §10.1).** For each rate of the gate (24, 25, 30, 24000/1001,
30000/1001) and each pack, caption cues and a hook are placed with their boundaries on *hazard*
frames (FFmpeg's double time is one millisecond below the exact time), on frames whose exact
time is a multiple of 10 ms (where naive centiseconds fail) and on ordinary frames. The ASS is
the production output of ``captions_ass.build_ass_v2``. Every Dialogue line is rendered **on its
own** (the same header and styles plus that one line, byte for byte) by FFmpeg's ``ass`` filter
with ``settb=den/num`` and the frame index as pts (the graph rule of plan §3.4), at the frames
around its plan window ``[a, b)``. Expected: invisible at ``a − 1``, visible from ``a`` to
``b − 1``, invisible at ``b``; each karaoke onset ``k`` changes the picture between ``k − 1`` and
``k`` and not next to it. The one designed exception is a ``\\fad`` fade-in at ``now == Start``
(frame 0 of a hook that starts at frame 0), which is fully transparent in libass and JASSUB alike.
The ``box`` pack is measured twice: as shipped (BorderStyle 3) and as its ``\\p`` vector variant
(plan §5.4), whose box events are rendered on grey (a translucent black box on black is not
visible).

**Box variants.** ``box_vector_geometry`` renders the same ``box`` lines with both box styles over
grey and compares them: the pixels more than one pixel inside the BorderStyle 3 box must be
identical, and each box edge may move by at most one pixel (its padding is ``H/100`` rounded to
a whole pixel, and the rectangle has crisp edges).

**Missing-glyph probe (plan §5.2 R6).** Pack text with characters that only DejaVu has, that
only Montserrat has, and that no font has, rendered with ``FONTCONFIG_FILE`` =
``resources/fontconfig/fonts.conf`` and ``fontsdir`` = ``resources/fonts``. libass logs every
font selection; no face other than the three pinned ones may appear and every fallback must be
DejaVu Sans.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import functools
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from dataclasses import replace as dataclass_replace
from pathlib import Path
from typing import Any

from ai_clipper.captions_ass import (
    CaptionPack,
    HookSpec,
    build_ass_v2,
    fit_cues,
    layout_hook,
    load_pack,
)
from ai_clipper.edit_v2 import PACK_DEFAULT_OVERRIDES, PACK_IDS
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.captions import caption_track
from ai_clipper.edit_v2.glyphs import FONTS_DIR, RESOURCES_DIR
from ai_clipper.edit_v2.timemap import Fps, now_ms
from ai_clipper.subtitles import FrameCue, FrameWord
from support import edit_v2_fixtures as fixtures
from support import edit_v2_media as media

ROOT = Path(__file__).resolve().parents[2]
GOLDEN_DIR = ROOT / "tests" / "fixtures" / "edit_v2" / "ass"
FONTCONFIG_FILE = RESOURCES_DIR / "fontconfig" / "fonts.conf"
PLAY_RES = (720, 1280)
PTIME_RATES = ((24, 1), (25, 1), (30, 1), (24000, 1001), (30000, 1001))
QUICK_RATES = ((25, 1), (30000, 1001))
THREE_HOURS_MS = 3 * 3600 * 1000
HOOK_TEXT = "Kode rahasia copet di keramaian"
PINNED_FACES = ("DejaVuSans", "DejaVuSans-Bold", "Montserrat-ExtraBold")
DEJAVU_FACES = ("DejaVuSans", "DejaVuSans-Bold")
MONTSERRAT_FAMILY = "Montserrat ExtraBold"

# Cue shapes around a boundary frame h: (onsets relative to h, end relative to h, texts). The
# "onset" shape puts a word onset on h (karaoke switch, bold window, box split); its long words
# make the box pack split there.
_ROLES = (
    ("start", (0, 9, 20), 30, ("satu", "dua", "tiga")),
    ("onset", (-15, 0, 7), 15, ("SEPERTINYA", "BERKEPANJANGAN", "SEKALI")),
    ("end", (-30, -20, -8), 0, ("empat", "lima", "enam")),
)
_PLAIN_FRAMES = (1234, 4567, 77777)


class GateError(RuntimeError):
    """FFmpeg is missing or a probe run failed."""


# --- time --------------------------------------------------------------------------------------


def exact_floor_ms(n: int, fps: Fps) -> int:
    return n * 1000 * fps.den // fps.num


def is_hazard(n: int, fps: Fps) -> bool:
    """FFmpeg's double time for frame ``n`` is below the exact (floored) time."""
    return now_ms(n, fps) < exact_floor_ms(n, fps)


def is_aligned(n: int, fps: Fps) -> bool:
    """The exact time of frame ``n`` is a whole number of centiseconds."""
    return (n * 1000 * fps.den) % (fps.num * 10) == 0


@functools.cache
def _hazards(num: int, den: int) -> tuple[int, ...]:
    fps = Fps(num, den)
    limit = THREE_HOURS_MS * num // (1000 * den)
    return tuple(n for n in range(1, limit) if is_hazard(n, fps))


def _spread(values: Sequence[int], count: int) -> list[int]:
    if count <= 0 or not values:
        return []
    if len(values) <= count:
        return list(values)
    if count == 1:
        return [values[len(values) // 2]]
    return [values[i * (len(values) - 1) // (count - 1)] for i in range(count)]


def _boundaries(fps: Fps, quick: bool) -> list[int]:
    hazards = _hazards(fps.num, fps.den)
    hazard_set = set(hazards)
    aligned = []
    n = 60
    while len(aligned) < 40:
        if is_aligned(n, fps) and n not in hazard_set:
            aligned.append(n)
        n += 1
    picks = _spread(hazards, 2 if quick else 9)
    picks += _spread(aligned, 1 if quick else 3)
    picks += list(_PLAIN_FRAMES[: 1 if quick else 3])
    chosen: list[int] = []
    for frame in sorted(set(picks)):
        if frame >= 60 and (not chosen or frame - chosen[-1] >= 120):
            chosen.append(frame)
    return chosen


# --- cases -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class PtimeCase:
    name: str
    fps: Fps
    pack: str
    cues: tuple[FrameCue, ...]
    hook: HookSpec | None
    total_frames: int
    play_res: tuple[int, int] = PLAY_RES
    box_style: str = "border"

    @property
    def background(self) -> str:
        """FFmpeg colour behind the text: grey for the vector box (black on black is not seen)."""
        return "gray" if self.box_style == "vector" else "black"


@dataclass(frozen=True)
class ExpectedEvent:
    a: int  # first frame of the plan window
    b: int  # frame after the window
    onsets: tuple[int, ...]  # karaoke switches strictly inside (a, b)
    fade: bool  # \fad(…) event: fully transparent when now == Start
    kind: str  # "caption" | "hook"


def _cue(boundary: int, role: int, index: int) -> FrameCue:
    name, offsets, end, texts = _ROLES[role]
    starts = [boundary + offset for offset in offsets]
    stops = starts[1:] + [boundary + end]
    words = tuple(
        FrameWord(f"w{3 * index + k:06d}", start, stop, text, name == "start" and k == 1)
        for k, (start, stop, text) in enumerate(zip(starts, stops, texts, strict=True))
    )
    return FrameCue(starts[0], boundary + end, "seg_b1", words)


def ptime_cases(quick: bool = False) -> tuple[PtimeCase, ...]:
    cases = []
    for rate in QUICK_RATES if quick else PTIME_RATES:
        fps = Fps(*rate)
        chosen = _boundaries(fps, quick)
        cues = tuple(_cue(frame, index % len(_ROLES), index) for index, frame in enumerate(chosen))
        first, second = chosen[0], chosen[1]
        hook_end = second if second - first <= 30 * fps.num // fps.den else first + 90
        hook = HookSpec(HOOK_TEXT, first, hook_end, 13000)
        total = max(cue.f1 for cue in cues) + 60
        label = f"{fps.num}/{fps.den}"
        packs = PACK_IDS
        cases += [PtimeCase(f"{label}/{pack}", fps, pack, cues, hook, total) for pack in packs]
        cases.append(PtimeCase(f"{label}/box-vector", fps, "box", cues, hook, total,
                               box_style="vector"))
        cases.append(PtimeCase(f"{label}/hook0", fps, "classic", (),
                               HookSpec(HOOK_TEXT, 0, 120, 13000), 180))
    return tuple(cases)


def case_pack(case: PtimeCase) -> CaptionPack:
    pack = load_pack(case.pack, 1)
    return pack if pack.box_style == case.box_style else dataclass_replace(
        pack, box_style=case.box_style)


def case_ass(case: PtimeCase) -> str:
    return build_ass_v2(case.cues, play_res=case.play_res, fps=case.fps,
                        total_frames=case.total_frames, pack=case_pack(case),
                        overrides=PACK_DEFAULT_OVERRIDES[case.pack], hook=case.hook)


def expected_events(case: PtimeCase) -> list[ExpectedEvent]:
    """Plan windows of every Dialogue line of ``case_ass(case)``, in emission order."""
    pack = case_pack(case)
    overrides = PACK_DEFAULT_OVERRIDES[case.pack]
    events: list[ExpectedEvent] = []
    for cue in fit_cues(case.cues, pack=pack, play_res=case.play_res, overrides=overrides):
        if case.pack == "bold":
            starts = [cue.f0] + [word.f0 for word in cue.words[1:]]
            ends = starts[1:] + [cue.f1]
            events += [ExpectedEvent(a, b, (), False, "caption")
                       for a, b in zip(starts, ends, strict=True) if a < b]
        elif case.pack == "karaoke":
            # An emphasised word keeps the emphasis colour before and after its switch, so only
            # the other words change the picture at their onset.
            onsets = sorted({w.f0 for w in cue.words[1:]
                             if cue.f0 < w.f0 < cue.f1 and not w.emphasis})
            events.append(ExpectedEvent(cue.f0, cue.f1, tuple(onsets), False, "caption"))
        else:
            # The vector box is its own event (the rectangle) right before the line.
            copies = 2 if pack.box_style == "vector" else 1
            events += [ExpectedEvent(cue.f0, cue.f1, (), False, "caption")] * copies
    if case.hook is not None:
        end = min(case.hook.f1, case.total_frames)
        lines = layout_hook(case.hook.text, play_res=case.play_res, y_e5=case.hook.y_e5).lines
        events += [ExpectedEvent(case.hook.f0, end, (), True, "hook") for _ in lines]
    return events


def expected_visible(event: ExpectedEvent, n: int, fps: Fps, *, start_cs: int) -> bool:
    """Whether frame ``n`` shows the event (``start_cs``: the Start written in the ASS)."""
    if not event.a <= n < event.b:
        return False
    return not (event.fade and now_ms(n, fps) <= 10 * start_cs)


def _event_boundaries(event: ExpectedEvent) -> list[int]:
    return [event.a, event.b, *event.onsets]


def ptime_counts(cases: Iterable[PtimeCase]) -> dict[str, Any]:
    """Pure-Python counts of what a P-TIME run checks (no FFmpeg)."""
    counts: dict[str, Any] = {"events": 0, "boundaries": 0, "hazard_boundaries": 0,
                              "aligned_boundaries": 0, "onsets": 0, "rates": {}}
    for case in cases:
        events = expected_events(case)
        rate = counts["rates"].setdefault(f"{case.fps.num}/{case.fps.den}", 0)
        counts["rates"][f"{case.fps.num}/{case.fps.den}"] = rate + len(events)
        counts["events"] += len(events)
        for event in events:
            counts["onsets"] += len(event.onsets)
            for frame in _event_boundaries(event):
                counts["boundaries"] += 1
                counts["hazard_boundaries"] += is_hazard(frame, case.fps)
                counts["aligned_boundaries"] += is_aligned(frame, case.fps)
    return counts


# --- ASS text ----------------------------------------------------------------------------------


def split_events(ass: str) -> tuple[str, list[str]]:
    """``(header up to and including the [Events] Format line, Dialogue lines)``."""
    head, marker, body = ass.partition("[Events]\n")
    if not marker:
        raise GateError("no [Events] section")
    lines = body.split("\n")
    header = head + marker + lines[0] + "\n"
    return header, [line for line in lines[1:] if line.startswith("Dialogue: ")]


def event_start_cs(line: str) -> int:
    start = line.removeprefix("Dialogue: ").split(",", 3)[1]
    hours, minutes, rest = start.split(":")
    seconds, cents = rest.split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 100 + int(cents)


# --- FFmpeg --------------------------------------------------------------------------------------


def _ffmpeg() -> str:
    path = media.ffmpeg_path()
    if path is None:
        raise GateError("ffmpeg not found")
    return path


def _env() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if key in ("PATH", "HOME", "LANG", "TMPDIR")}
    env["FONTCONFIG_FILE"] = str(FONTCONFIG_FILE)
    return env


def _workdir(tmp: str) -> Path:
    work = Path(tmp)
    (work / "fonts").symlink_to(FONTS_DIR, target_is_directory=True)
    return work


def _pts_expression(frames: Sequence[int]) -> str:
    expression = str(frames[-1])
    for index in range(len(frames) - 2, -1, -1):
        expression = f"if(eq(N,{index}),{frames[index]},{expression})"
    return expression


def render_frames(ass: str, fps: Fps, size: tuple[int, int], frames: Sequence[int], *,
                  loglevel: str = "error", background: str = "black") -> tuple[list[str], str]:
    """MD5 of each output frame (RGB) of ``ass`` at output frames ``frames``, and the stderr."""
    frames = sorted(set(frames))
    with tempfile.TemporaryDirectory(prefix="edit-v2-text-") as tmp:
        work = _workdir(tmp)
        (work / "probe.ass").write_text(ass, encoding="utf-8")
        graph = (
            f"color=c={background}:s={size[0]}x{size[1]}:r={fps.num}/{fps.den},"
            f"trim=end_frame={len(frames)},settb={fps.den}/{fps.num},"
            f"setpts='{_pts_expression(frames)}',"
            "ass=filename=probe.ass:fontsdir=fonts:shaping=complex,format=rgb24[v]"
        )
        (work / "graph.txt").write_text(graph, encoding="utf-8")
        argv = [_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", loglevel, "-threads", "1",
                "-filter_complex_threads", "1", "-filter_complex_script", "graph.txt",
                "-map", "[v]", "-fps_mode", "passthrough", "-f", "framemd5", "-"]
        result = subprocess.run(argv, cwd=work, env=_env(), capture_output=True, check=False,
                                timeout=300)
    stderr = result.stderr.decode("utf-8", "replace")
    if result.returncode != 0:
        raise GateError("ffmpeg failed: " + " | ".join(stderr.strip().splitlines()[-4:]))
    digests = [line.rsplit(",", 1)[1].strip()
               for line in result.stdout.decode().splitlines()
               if line.strip() and not line.startswith("#")]
    if len(digests) != len(frames):
        raise GateError(f"expected {len(frames)} frames, got {len(digests)}")
    return digests, stderr


def _toolchain() -> dict[str, Any]:
    info: dict[str, Any] = {"python": sys.version.split()[0]}
    ffmpeg = media.ffmpeg_path()
    if ffmpeg:
        first = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=False)
        info["ffmpeg"] = first.stdout.splitlines()[0] if first.stdout else None
    dpkg = shutil.which("dpkg-query")
    if dpkg:
        for package in ("libass9", "libfreetype6", "libharfbuzz0b", "libfribidi0", "fontconfig"):
            result = subprocess.run([dpkg, "-W", "-f=${Version}\n", package],
                                    capture_output=True, text=True, check=False)
            versions = result.stdout.split()
            info[package] = versions[0] if versions else None
    info["reference_toolchain_problem"] = media.reference_toolchain_problem()
    return info


# --- P-TIME -------------------------------------------------------------------------------------


def _probe_frames(event: ExpectedEvent, fps: Fps, start_cs: int) -> list[int]:
    frames = {event.a, event.b - 1, event.b}
    if event.a > 0:
        frames.add(event.a - 1)
    if not expected_visible(event, event.a, fps, start_cs=start_cs):
        frames.add(event.a + 1)  # the first visible frame after a transparent fade start
    for onset in event.onsets:
        frames.update({onset - 2, onset - 1, onset, onset + 1})
    return sorted(frame for frame in frames if frame >= 0)


def _check_event(case: PtimeCase, header: str, line: str, event: ExpectedEvent,
                 blank: str) -> dict[str, Any]:
    start_cs = event_start_cs(line)
    frames = _probe_frames(event, case.fps, start_cs)
    digests, _stderr = render_frames(header + line + "\n", case.fps, case.play_res, frames,
                                     background=case.background)
    by_frame = dict(zip(frames, digests, strict=True))
    problems: list[dict[str, Any]] = []
    for frame in frames:
        seen = by_frame[frame] != blank
        wanted = expected_visible(event, frame, case.fps, start_cs=start_cs)
        if seen != wanted:
            problems.append({"frame": frame, "check": "visible", "expected": wanted,
                             "seen": seen, "hazard": is_hazard(frame, case.fps)})
    onset_set = set(event.onsets)
    for onset in event.onsets:
        if by_frame[onset - 1] == by_frame[onset]:
            problems.append({"frame": onset, "check": "onset_switch", "expected": True,
                             "seen": False, "hazard": is_hazard(onset, case.fps)})
        if onset - 2 >= event.a and onset - 1 not in onset_set and \
                by_frame[onset - 2] != by_frame[onset - 1]:
            problems.append({"frame": onset - 1, "check": "onset_early", "expected": False,
                             "seen": True, "hazard": is_hazard(onset, case.fps)})
        if onset + 1 < event.b and onset + 1 not in onset_set and \
                by_frame[onset] != by_frame[onset + 1]:
            problems.append({"frame": onset + 1, "check": "onset_late", "expected": False,
                             "seen": True, "hazard": is_hazard(onset, case.fps)})
    return {"frames": len(frames), "problems": problems}


def run_ptime(*, quick: bool = False, jobs: int = 2) -> dict[str, Any]:
    """Render every event of every P-TIME case in FFmpeg and compare with the plan frames."""
    cases = ptime_cases(quick)
    tasks = []
    blanks: dict[tuple[int, int, tuple[int, int], str], str] = {}
    for case in cases:
        ass = case_ass(case)
        header, lines = split_events(ass)
        events = expected_events(case)
        if len(lines) != len(events):
            raise GateError(f"{case.name}: {len(lines)} events, expected {len(events)}")
        key = (case.fps.num, case.fps.den, case.play_res, case.background)
        if key not in blanks:
            blanks[key] = render_frames(header, case.fps, case.play_res, [0],
                                        background=case.background)[0][0]
        tasks += [(case, header, line, event, blanks[key])
                  for line, event in zip(lines, events, strict=True)]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        results = list(pool.map(lambda task: _check_event(*task), tasks))

    report: dict[str, Any] = {"task": "T1.2a", "gate": "P-TIME (FFmpeg side)", "quick": quick,
                              "rates": {}, "events": 0, "boundaries": 0,
                              "hazard_boundaries": 0, "aligned_boundaries": 0, "onsets": 0,
                              "frames_rendered": 0, "mismatches": 0, "mismatch_details": []}
    for (case, _header, _line, event, _blank), result in zip(tasks, results, strict=True):
        rate, pack = case.name.split("/", 2)[:2], case.name.rsplit("/", 1)[1]
        section = report["rates"].setdefault("/".join(rate), {}).setdefault(pack, {
            "events": 0, "boundaries": 0, "hazard_boundaries": 0, "aligned_boundaries": 0,
            "onsets": 0, "frames_rendered": 0, "mismatches": 0})
        boundaries = _event_boundaries(event)
        values = {
            "events": 1,
            "boundaries": len(boundaries),
            "hazard_boundaries": sum(is_hazard(frame, case.fps) for frame in boundaries),
            "aligned_boundaries": sum(is_aligned(frame, case.fps) for frame in boundaries),
            "onsets": len(event.onsets),
            "frames_rendered": result["frames"],
            "mismatches": len(result["problems"]),
        }
        for key, value in values.items():
            section[key] += value
            report[key] += value
        for problem in result["problems"]:
            if len(report["mismatch_details"]) < 20:
                report["mismatch_details"].append({"case": case.name, **problem})
    return report


# --- missing-glyph probe --------------------------------------------------------------------------

GLYPH_PROBE_TEXTS = (
    ("bold", "HALO ‱ SEMUA 😂"),  # ‱ and 😂: Montserrat lacks them, DejaVu has them
    ("box", "BOX ‱"),
    ("classic", "halo ₿ 🔥 😂"),  # ₿ only in Montserrat; 🔥 in no font
    ("karaoke", "halo ‱ ₿"),
)
_SELECT = re.compile(r"fontselect: \((?P<family>[^,]*), (?P<weight>\d+), (?P<italic>\d+)\) -> "
                     r"(?P<result>.*), (?P<index>-?\d+), (?P<ps>[^,]*)$")
_MISSING = re.compile(r"Glyph 0x(?P<cp>[0-9A-Fa-f]+) not found, selecting one more font for "
                      r"\((?P<family>[^,]*), ")
_FAILED = re.compile(r"fontselect: failed to find any fallback with glyph 0x(?P<cp>[0-9A-Fa-f]+) "
                     r"for font: \((?P<family>[^,]*), ")


def _probe_ass(pack: str, text: str) -> str:
    words = text.split()
    items = tuple(FrameWord(f"w{i:06d}", 5 * i, 5 * i + 5 if i + 1 < len(words) else 30, word,
                            False) for i, word in enumerate(words))
    hook = HookSpec("Hook ₿ ‱ 😂", 0, 30, 13000) if pack == "classic" else None
    return build_ass_v2((FrameCue(0, 30, "seg_b1", items),), play_res=PLAY_RES, fps=Fps(25, 1),
                        total_frames=60, pack=load_pack(pack, 1),
                        overrides=PACK_DEFAULT_OVERRIDES[pack], hook=hook)


def parse_font_log(stderr: str) -> dict[str, Any]:
    faces: set[str] = set()
    fallbacks: set[str] = set()
    not_found: set[str] = set()
    outside = 0
    montserrat_elsewhere = 0
    pending = False
    fonts_dir = FONTS_DIR.resolve()
    for line in stderr.splitlines():
        if match := _MISSING.search(line):
            pending = True
            continue
        if match := _FAILED.search(line):
            not_found.add(f"U+{int(match['cp'], 16):04X} {match['family']}")
            pending = False
            continue
        if match := _SELECT.search(line):
            face = match["ps"].strip()
            faces.add(face)
            if pending:
                fallbacks.add(face)
            pending = False
            result = match["result"]
            if "/" in result and Path(result).resolve().parent != fonts_dir:
                outside += 1
            if face.startswith("Montserrat") and match["family"] != MONTSERRAT_FAMILY:
                montserrat_elsewhere += 1
    unexpected = sorted(faces - set(PINNED_FACES))
    foreign_fallbacks = sorted(fallbacks - set(DEJAVU_FACES))
    return {
        "faces": sorted(faces),
        "unexpected_faces": unexpected,
        "fallback_faces": sorted(fallbacks),
        "non_dejavu_fallbacks": foreign_fallbacks,
        "montserrat_used_for_other_families": montserrat_elsewhere,
        "paths_outside_fonts_dir": outside,
        "not_found": sorted(not_found),
        "failures": len(unexpected) + len(foreign_fallbacks) + montserrat_elsewhere + outside,
    }


def _fc_list() -> list[str] | None:
    tool = shutil.which("fc-list")
    if tool is None:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run([tool, "--format", "%{file}\n"], capture_output=True, text=True,
                                check=False, cwd=tmp, env=_env())
    return sorted(Path(line).name for line in result.stdout.split())


def glyph_probe() -> dict[str, Any]:
    stderr = []
    for pack, text in GLYPH_PROBE_TEXTS:
        _digests, log = render_frames(_probe_ass(pack, text), Fps(25, 1), PLAY_RES, [10],
                                      loglevel="info")
        stderr.append(log)
    report = parse_font_log("\n".join(stderr))
    report["fontconfig_files"] = _fc_list()
    if report["fontconfig_files"] not in (None, ["DejaVuSans-Bold.ttf", "DejaVuSans.ttf"]):
        report["failures"] += 1
    report["probe_texts"] = [f"{pack}: {text}" for pack, text in GLYPH_PROBE_TEXTS]
    return report


# --- box variants: BorderStyle 3 vs the \p rectangle ------------------------------------------

BOX_GEOMETRY_TEXTS = (
    "gue bukan jambret.",
    "AVATAR TAWA",  # kerning pairs (libass shapes without kerning, as the hmtx widths assume)
    "SEPERTINYA",
    "Supercalifragilisticexpialidocious",  # one word shrunk with \fs
    "Halo {semua}",  # escaped text
)
_GREY = 128


def render_rgb(ass: str, size: tuple[int, int], *, background: str = "gray") -> bytes:
    """Frame 0 of ``ass`` (25 fps) over ``background`` as packed RGB24 bytes."""
    with tempfile.TemporaryDirectory(prefix="edit-v2-text-") as tmp:
        work = _workdir(tmp)
        (work / "probe.ass").write_text(ass, encoding="utf-8")
        graph = (f"color=c={background}:s={size[0]}x{size[1]}:r=25,trim=end_frame=1,"
                 "ass=filename=probe.ass:fontsdir=fonts:shaping=complex,format=rgb24[v]")
        (work / "graph.txt").write_text(graph, encoding="utf-8")
        argv = [_ffmpeg(), "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                "-filter_complex_threads", "1", "-filter_complex_script", "graph.txt",
                "-map", "[v]", "-frames:v", "1", "-f", "rawvideo", "-"]
        result = subprocess.run(argv, cwd=work, env=_env(), capture_output=True, check=False,
                                timeout=120)
    if result.returncode != 0 or len(result.stdout) != 3 * size[0] * size[1]:
        stderr = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise GateError("ffmpeg failed: " + " | ".join(stderr[-4:]))
    return result.stdout


def _box_ass(text: str, box_style: str) -> str:
    pack = dataclass_replace(load_pack("box", 1), box_style=box_style)
    words = tuple(FrameWord(f"w{i:06d}", 0, 10, word, False)
                  for i, word in enumerate(text.split()))
    return build_ass_v2((FrameCue(0, 10, "seg_b1", words),), play_res=PLAY_RES,
                        fps=Fps(25, 1), total_frames=20, pack=pack,
                        overrides=PACK_DEFAULT_OVERRIDES["box"], hook=None)


def _bbox(image: bytes, width: int, *, level: int) -> tuple[int, int, int, int] | None:
    """Bounding box (x0, y0, x1, y1 inclusive) of pixels with a channel more than ``level``
    away from grey."""
    table = bytes(0 if abs(value - _GREY) <= level else 1 for value in range(256))
    marks = image.translate(table)
    stride = 3 * width
    rows = [y for y in range(len(marks) // stride) if 1 in marks[y * stride:(y + 1) * stride]]
    if not rows:
        return None
    lefts, rights = [], []
    for y in rows:
        row = marks[y * stride:(y + 1) * stride]
        lefts.append(row.find(1) // 3)
        rights.append(row.rfind(1) // 3)
    return min(lefts), rows[0], max(rights), rows[-1]


def box_vector_geometry() -> dict[str, Any]:
    """Compare the ``box`` pack's BorderStyle 3 box with its ``\\p`` rectangle variant."""
    width = PLAY_RES[0]
    stride = 3 * width
    samples = []
    failures = 0
    for text in BOX_GEOMETRY_TEXTS:
        border = render_rgb(_box_ass(text, "border"), PLAY_RES)
        vector = render_rgb(_box_ass(text, "vector"), PLAY_RES)
        # level 2 ignores libass' 1-level antialiasing fringe around a crisp rectangle
        box_b, box_v = _bbox(border, width, level=2), _bbox(vector, width, level=2)
        if box_b is None or box_v is None:
            samples.append({"text": text, "border_bbox": box_b, "vector_bbox": box_v})
            failures += 1
            continue
        x0, y0, x1, y1 = box_b
        interior_px = interior_max = differing_px = 0
        for y in range(len(border) // stride):
            row_b = border[y * stride:(y + 1) * stride]
            row_v = vector[y * stride:(y + 1) * stride]
            if row_b == row_v:
                continue
            for x in range(width):
                diff = max(abs(row_b[3 * x + k] - row_v[3 * x + k]) for k in range(3))
                if not diff:
                    continue
                differing_px += 1
                if x0 + 1 < x < x1 - 1 and y0 + 1 < y < y1 - 1:
                    interior_px += 1
                    interior_max = max(interior_max, diff)
        edge_px = max(abs(a - b) for a, b in zip(box_b, box_v, strict=True))
        failures += (interior_px > 0) + (edge_px > 1)
        samples.append({"text": text, "border_bbox": list(box_b), "vector_bbox": list(box_v),
                        "max_edge_shift_px": edge_px, "interior_differing_px": interior_px,
                        "interior_max_diff": interior_max, "differing_px": differing_px})
    return {"task": "T1.2a", "check": "box pack: BorderStyle 3 vs \\p rectangle",
            "play_res": list(PLAY_RES), "samples": samples, "failures": failures}


# --- ASS goldens -----------------------------------------------------------------------------------

GOLDEN_CASES = (
    ("classic__c30", "valid/pack_classic__c30.json", "c30"),
    ("karaoke__c30", "valid/seed__c30.json", "c30"),
    ("bold__c30", "valid/pack_bold__c30.json", "c30"),
    ("box__c30", "valid/pack_box__c30.json", "c30"),
    ("hook__c30", "valid/captions_disabled__c30.json", "c30"),
    ("full_example__c30", "valid/full_example__c30.json", "c30"),
    ("word_edits__c30", "valid/word_edits__c30.json", "c30"),
    ("karaoke__c24", "valid/seed__c24.json", "c24"),
    ("classic__c25", "valid/seed__c25.json", "c25"),
)


def _golden_track(file: str, context_id: str):
    doc = json.loads((fixtures.DOC_FIXTURES_DIR / file).read_bytes())
    return doc, caption_track(doc, fixtures.load_context(context_id).words, tm.pieces(doc))


def render_goldens() -> dict[str, bytes]:
    return {f"{name}.ass": _golden_track(file, context)[1].ass.encode("utf-8")
            for name, file, context in GOLDEN_CASES}


def write_goldens(root: Path = GOLDEN_DIR) -> None:
    files = render_goldens()
    root.mkdir(parents=True, exist_ok=True)
    for existing in root.glob("*.ass"):
        if existing.name not in files:
            existing.unlink()
    for name, data in files.items():
        (root / name).write_bytes(data)


def golden_evidence() -> dict[str, Any]:
    """Hashes of every golden plus an FFmpeg render of a few frames of each (fonts checked)."""
    report: dict[str, Any] = {"task": "T1.2a", "gate": "ASS goldens (4 packs + hook)",
                              "goldens": {}, "failures": 0}
    logs = []
    for name, file, context in GOLDEN_CASES:
        doc, result = _golden_track(file, context)
        data = result.ass.encode("utf-8")
        on_disk = (GOLDEN_DIR / f"{name}.ass").read_bytes()
        header, lines = split_events(result.ass)
        styles = sorted({line.split(",", 4)[3] for line in lines})
        fps = Fps.from_json(doc["output"]["fps"])
        size = (doc["output"]["w"], doc["output"]["h"])
        # Frames inside events: the first and a middle cue, and the hook past its fade-in
        # start (its first frame is transparent by design, \fad at now == Start).
        probe = {cue.f0 for cue in result.cues[:1] + result.cues[len(result.cues) // 2:][:1]}
        if result.hook_lines:
            probe.add(5)
        probe = sorted(probe)
        digests, log = render_frames(result.ass, fps, size, probe, loglevel="info")
        logs.append(log)
        blank = render_frames(header, fps, size, [0])[0][0]
        entry = {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "equals_committed": data == on_disk,
            "dialogues": len(lines),
            "styles": styles,
            "cues": len(result.cues),
            "hook_lines": len(result.hook_lines),
            "warnings": sorted({issue.code for issue in result.warnings}),
            "rendered": {str(frame): {"md5": digest, "visible": digest != blank}
                         for frame, digest in zip(probe, digests, strict=True)},
        }
        report["failures"] += (not entry["equals_committed"]) + sum(
            not value["visible"] for value in entry["rendered"].values())
        report["goldens"][name] = entry
    fonts = parse_font_log("\n".join(logs))
    report["fonts"] = {key: fonts[key] for key in ("faces", "unexpected_faces",
                                                   "fallback_faces", "failures")}
    report["failures"] += fonts["failures"]
    report["styles_covered"] = sorted({style for entry in report["goldens"].values()
                                       for style in entry["styles"]})
    return report


# --- CLI -----------------------------------------------------------------------------------------


def _write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                    encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Editor V3 text gates (T1.2a)")
    commands = parser.add_subparsers(dest="command", required=True)
    ptime = commands.add_parser("ptime")
    ptime.add_argument("output", type=Path)
    ptime.add_argument("--quick", action="store_true")
    ptime.add_argument("--jobs", type=int, default=2)
    probe = commands.add_parser("glyph-probe")
    probe.add_argument("output", type=Path)
    goldens = commands.add_parser("goldens")
    group = goldens.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    evidence = commands.add_parser("golden-evidence")
    evidence.add_argument("output", type=Path)
    box = commands.add_parser("box-vector")
    box.add_argument("output", type=Path)
    args = parser.parse_args(argv)

    if args.command == "goldens":
        if args.write:
            write_goldens()
            return 0
        on_disk = {p.name: p.read_bytes() for p in GOLDEN_DIR.glob("*.ass")}
        return 0 if on_disk == render_goldens() else 1
    if args.command == "ptime":
        report = run_ptime(quick=args.quick, jobs=args.jobs)
        report["toolchain"] = _toolchain()
        _write(args.output, report)
        return 1 if report["mismatches"] else 0
    if args.command in ("glyph-probe", "box-vector"):
        report = glyph_probe() if args.command == "glyph-probe" else box_vector_geometry()
        report["toolchain"] = _toolchain()
        _write(args.output, report)
        return 1 if report["failures"] else 0
    report = golden_evidence()
    report["toolchain"] = _toolchain()
    _write(args.output, report)
    return 1 if report["failures"] else 0


if __name__ == "__main__":
    sys.exit(main())
