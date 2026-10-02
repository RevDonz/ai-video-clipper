#!/usr/bin/env python3
"""The cold-open transition's server gates (spec docs/plans/2026-10-02-transisi-cold-open.md
§5.4), built on ``frame_identity``'s workspace and the synthetic V3 job.

* **P-JOIN**: the ``reference`` render of a transition document against the same document
  with a ``cut``, both decoded to RGB with the BT.709 matrix (``_PNG_DECODE``'s conversion):
  (a) every frame outside the effect is identical (frame md5); (b) inside it, every pixel the
  text cannot reach is within 3 levels of ``blend(cut, alpha)`` per channel, mean ≤ 1.0;
  (c) the alpha estimated by least squares (pixels with ``|C − cut| ≥ 32``) is the plan's
  within 10 per mille; (d) frames, samples and the ASS sha are the cut's and the graph holds
  exactly one ``lutrgb`` per affected frame. The text's pixels (the luma and chroma samples
  the text changes, with the 4:2:0 reach, in the cut render and in the transition render, each
  against the same render without text) are left out of (b) and (c), and decide the layer
  order: on them the effect frame is
  compared with what text *under* the effect would give, and the text's share over it must be
  ≥ 0.5 (under: 0; opaque over: 1; the hook's translucent box: its opacity) on frames with
  alpha ≥ 500. The 29.97 cases hold the hook over the join, so they always judge it. Cases:
  5 rates × 2 styles over the ``frame_identity`` barcode source (20 cuts, a 2 s cold open).
* **G-WHOOSH**: the s16 ``reference`` PCM of a whoosh document minus the same document's
  without it: 0 on every sample outside the whoosh, inside within 1 LSB of the whoosh with
  ≥ 99.9 % exact, and the loudest 10 ms of the difference starting within ±480 samples of
  ``hit_smp − 240``. Cases: 29.97 ``flash_white``, 25 ``dip_black``, 29.97 ``cut``, 29.97 with
  ducked music (both renders use the document without the whoosh's measurement, so the master
  gain is the same and the difference is the mix alone).
* **P-LOOK-JOIN**: the legacy and edit-v2 auto renders of the synthetic job's clip 1 (main
  29.97 fit-blur, fps25 center-crop, fps60 face-track: legacy 60 against edit-v2 30), each
  against its own render without the transition: the per-frame alpha each engine applied,
  around each one's own join, within 50 per mille at the best offset in ±1 frame; each
  whoosh's onset (cross-correlation of the PCM difference with the file) within 2 ms of where
  that engine places it; both auto renders' integrated loudness within 0.5 LU.
* **PF-RENDER-JOIN** (report only): each engine's delivered render of the 29.97 clip with and
  without the flash and the whoosh.

CLI (``PYTHONPATH=src:tests``, in the production image)::

    join_gates.py p-join|g-whoosh|look|pf|smoke|all --evidence DIR [--work DIR] [--task CI]

``smoke`` is P-JOIN and G-WHOOSH on the 29.97 ``flash_white`` + whoosh case (every pull
request); ``all`` every case of the three gates and the report (nightly). Evidence:
``<task>-<gate>.json``, numbers only, with a ``pass`` boolean (none for the report).
"""

from __future__ import annotations

import argparse
import array
import copy
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import frame_identity as fi

from ai_clipper.edit_v2 import execute, transitions
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.loudness import parse_ebur128

ROOT = HERE.parents[1]
RATES = ((30000, 1001), (25, 1), (30, 1), (24000, 1001), (24, 1))
STYLES = ("flash_white", "dip_black")
WHOOSH_CASES = {((30000, 1001), "flash_white"), ((25, 1), "dip_black")}
SOURCE_FRAMES = 600
PIXEL_TOLERANCE = 3
MEAN_TOLERANCE = 1.0
ALPHA_TOLERANCE_PM = 10
CONTRAST_MIN = 32
TEXT_LUMA = 32
CHROMA_REACH = 3  # chroma samples a text's 4:2:0 bleed reaches through lanczos + the decode
TEXT_MIN_PIXELS = 100
TEXT_SHARE_MIN = 0.5  # text over the effect: ≥ 0.5 (under it: ≈ 0)
TEXT_SHARE_ALPHA = 500  # judged on frames whose alpha is at least this
WHOOSH_LSB = 1
WHOOSH_EXACT_SHARE = 0.999
WHOOSH_PEAK_SAMPLES = 480
LOOK_ALPHA_TOLERANCE_PM = 50
LOOK_ONSET_SAMPLES = 96  # 2 ms
LOOK_LOUDNESS_LU = 0.5
LOOK_JOBS = ("main", "fps25", "fps60")
LOOK_OUTPUT = (720, 1280)  # pipeline.render_v3_job's default size
LOOK_SOURCE = (640, 360)  # the synthetic job's source size (the engines are compared, not it)
SAMPLE_RATE = 48_000
WINDOW = 480  # 10 ms
_RGB = "scale=in_color_matrix=bt709:in_range=tv,format=rgb24"  # compile_ffmpeg._PNG_DECODE


# --- cases ---------------------------------------------------------------------------------------


def _rate(fps: tuple[int, int]) -> str:
    return f"{fps[0]}-{fps[1]}"


def case(fps: tuple[int, int], style: str = "cut", *, whoosh: bool = False,
         text: bool = True) -> fi.Case:
    """A barcode clip of ``frame_identity`` (20 cuts, a 2 s cold open 300 frames into the
    body) with the join set; all cases of one rate share the source."""
    name = f"join_{_rate(fps)}_{style}{'_whoosh' if whoosh else ''}{'' if text else '_notext'}"
    return fi.Case(name, fps, SOURCE_FRAMES, "fit_blur", hook=text and fps == (30000, 1001),
                   captions=text, join_style=style, whoosh=whoosh)


def p_join_cases(smoke: bool) -> list[tuple[tuple[int, int], str, bool]]:
    if smoke:
        return [((30000, 1001), "flash_white", True)]
    return [(fps, style, (fps, style) in WHOOSH_CASES) for fps in RATES for style in STYLES]


# --- decoding ------------------------------------------------------------------------------------


def _ffmpeg(argv: Sequence[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *argv],
                          check=True, stdin=subprocess.DEVNULL, **kwargs)


def video_frames(path: Path, size: tuple[int, int], fmt: str,
                 frames: tuple[int, int] | None = None) -> Iterator[bytes]:
    """Every decoded frame (or output frames ``[lo, hi]``) as raw ``rgb24`` (BT.709 decode) or
    ``yuv420p``, without frame-rate conversion."""
    width, height = size
    length = width * height * 3 if fmt == "rgb24" else width * height * 3 // 2
    filters = []
    if frames is not None:
        filters.append(f"select='between(n,{frames[0]},{frames[1]})'")
    if fmt == "rgb24":
        filters.append(_RGB)
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "4", "-i",
            str(path), "-map", "0:v:0"]
    if filters:
        argv += ["-vf", ",".join(filters)]
    argv += ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", fmt, "-"]
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as process:
        assert process.stdout is not None
        while True:
            data = process.stdout.read(length)
            if not data:
                break
            if len(data) != length:
                raise RuntimeError(f"{path.name}: truncated frame")
            yield data
    if process.returncode:
        raise RuntimeError(f"{path.name}: ffmpeg decode failed")


def pcm(path: Path) -> array.array:
    """The first audio stream as s16 stereo 48 kHz samples (interleaved)."""
    data = _ffmpeg(["-i", str(path), "-map", "0:a:0", "-f", "s16le", "-ac", "2", "-ar",
                    str(SAMPLE_RATE), "-"], capture_output=True).stdout
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def whoosh_samples() -> array.array:
    samples = array.array("h")
    samples.frombytes(transitions.load_sfx_pcm(transitions.default_resources(),
                                               transitions.SFX[("whoosh", 1)]))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def loudest_window(samples: Sequence[int], window: int = WINDOW) -> int:
    """The first stereo frame of the loudest ``window`` frames (energy of both channels)."""
    frames = len(samples) // 2
    energy = [samples[2 * n] ** 2 + samples[2 * n + 1] ** 2 for n in range(frames)]
    if frames <= window:
        return 0
    total = sum(energy[:window])
    best, best_at = total, 0
    for start in range(1, frames - window + 1):
        total += energy[start + window - 1] - energy[start - 1]
        if total > best:
            best, best_at = total, start
    return best_at


# --- P-JOIN ----------------------------------------------------------------------------------------


def _blend_table(alpha: int, colour: int) -> bytes:
    return bytes((value * (1000 - alpha) + colour * alpha + 500) // 1000 for value in range(256))


def text_mask(cut: bytes, notext: bytes, size: tuple[int, int]) -> bytearray:
    """The pixels the text can reach, from two ``yuv420p`` frames (with and without text):
    the luma samples it changed, and every pixel whose decode reads a chroma sample it changed
    (±``CHROMA_REACH`` chroma samples: the 4:2:0 resampling). Measured on samples, not on RGB,
    because a dark background clips a text's chroma bleed out of the RGB of the frame without
    the effect, not out of the frame with it."""
    width, height = size
    luma = width * height
    cw, ch = width // 2, height // 2
    changed = bytearray(cw * ch)
    for plane in (0, 1):
        offset = luma + plane * cw * ch
        for index in range(cw * ch):
            if cut[offset + index] != notext[offset + index]:
                changed[index] = 1
    for _axis in range(2):  # dilate: rows, then columns
        wide = bytearray(cw * ch)
        for y in range(ch):
            row = y * cw
            for x in range(cw):
                if changed[row + x]:
                    if _axis == 0:
                        for dx in range(max(0, x - CHROMA_REACH), min(cw, x + CHROMA_REACH + 1)):
                            wide[row + dx] = 1
                    else:
                        for dy in range(max(0, y - CHROMA_REACH), min(ch, y + CHROMA_REACH + 1)):
                            wide[dy * cw + x] = 1
        changed = wide
    mask = bytearray(luma)
    for y in range(height):
        row, crow = y * width, (y // 2) * cw
        for x in range(width):
            index = row + x
            if cut[index] != notext[index] or changed[crow + x // 2]:
                mask[index] = 1
    return mask


def compare_frame(cut: bytes, joined: bytes, mask: bytes | bytearray, alpha: int,
                  colour: int) -> dict[str, Any]:
    """(b) and (c) of P-JOIN on one RGB frame, over the pixels the text cannot reach."""
    table = _blend_table(alpha, colour)
    worst = total = count = 0
    numerator = denominator = 0
    for pixel, touched in enumerate(mask):
        if touched:
            continue
        index = 3 * pixel
        for channel in range(index, index + 3):
            base = cut[channel]
            error = abs(joined[channel] - table[base])
            total += error
            worst = max(worst, error)
            contrast = colour - base
            if contrast >= CONTRAST_MIN or contrast <= -CONTRAST_MIN:
                numerator += (joined[channel] - base) * contrast
                denominator += contrast * contrast
        count += 3
    estimate = None if denominator == 0 else round(1000 * numerator / denominator)
    return {"alpha_pm": alpha, "alpha_estimate_pm": estimate, "max_abs": worst,
            "mean_abs": round(total / count, 4) if count else None,
            "pixels_compared": count // 3, "text_pixels": len(mask) - count // 3}


def text_share(cut_y: bytes, joined_y: bytes, notext_y: bytes, alpha: int,
               colour_y: int) -> dict[str, Any]:
    """Is the text over the effect? On the text's pixels (luma ≥ 32 from the frame without
    text), the frame with the effect is compared with what the text *under* the effect would
    give, ``blend(cut)``: ``share = Σ(u − j)(u − c) / Σ(u − c)²`` with ``u = blend(c)``. Text
    under the effect gives 0; opaque text over it 1, and text with a translucent box its
    opacity. Luma samples: no 4:2:0 resampling and no clipping."""
    numerator = denominator = pixels = 0
    for index, (c, j, n) in enumerate(zip(cut_y, joined_y, notext_y)):
        if abs(c - n) < TEXT_LUMA:
            continue
        under = c + alpha * (colour_y - c) / 1000
        lever = under - c
        if abs(lever) < CONTRAST_MIN:
            continue
        numerator += (under - j) * lever
        denominator += lever * lever
        pixels += 1
    share = None if pixels < TEXT_MIN_PIXELS else round(numerator / denominator, 4)
    return {"text_share_pixels": pixels, "text_share": share}


def hold_hook(ws: fi.Workspace, case_: fi.Case, frames: int) -> None:
    """Keep the hook on screen for ``frames`` (the 29.97 cases): the text then crosses the
    effect, so the text-on-top check has pixels to look at. Before any render of the case."""
    if case_.hook:
        doc = ws.clip(case_)["doc"]
        item = next(track for track in doc["tracks"] if track["kind"] == "hook")["items"][0]
        item["dur_f"] = max(item["dur_f"], frames)


def p_join_case(ws: fi.Workspace, fps: tuple[int, int], style: str,
                whoosh: bool) -> dict[str, Any]:
    joined_case, cut_case, notext_case = case(fps, style, whoosh=whoosh), case(fps), case(
        fps, text=False)
    joined_notext_case = case(fps, style, text=False)
    hook_frames = 2 * tm.sf_ceil(1000, tm.Fps(*fps)) + 2 * tm.sf_ceil(1000, tm.Fps(*fps))
    for text_case in (joined_case, cut_case):
        hold_hook(ws, text_case, hook_frames)  # past the join (a 2 s cold open) by 2 s
    plan, cut_plan = ws.plan(joined_case), ws.plan(cut_case)
    (join,) = plan.joins
    colour = transitions.RGB[style][0]
    graph = ws.compile(joined_case, "reference").filter_script
    window = dict(join.alpha)
    joined = ws.render(joined_case, "reference")["path"]
    cut = ws.render(cut_case, "reference")["path"]
    notext = ws.render(notext_case, "reference")["path"]
    joined_notext = ws.render(joined_notext_case, "reference")["path"]
    size = joined_case.output
    outside_mismatches = frames = 0
    inside: dict[int, tuple[bytes, bytes]] = {}
    for n, (a, b) in enumerate(zip(video_frames(cut, size, "rgb24"),
                                   video_frames(joined, size, "rgb24"), strict=True)):
        frames += 1
        if n in window:
            inside[n] = (a, b)
        elif hashlib.md5(a).digest() != hashlib.md5(b).digest():
            outside_mismatches += 1
    lo, hi = min(window), max(window)
    yuv = {name: dict(zip(range(lo, hi + 1), video_frames(path, size, "yuv420p", (lo, hi)),
                          strict=True))
           for name, path in (("cut", cut), ("joined", joined), ("notext", notext),
                              ("joined_notext", joined_notext))}
    luma = size[0] * size[1]
    colour_y = transitions.YUV_TV[style][0]  # the effect's colour in TV-range luma
    rows = []
    for n in sorted(window):
        a, b = inside[n]
        # The text's pixels over either background: a translucent box over black video is
        # invisible in the cut render and visible over the flash, and the other way round.
        mask = text_mask(yuv["cut"][n], yuv["notext"][n], size)
        for index, touched in enumerate(text_mask(yuv["joined"][n], yuv["joined_notext"][n],
                                                  size)):
            if touched:
                mask[index] = 1
        row = compare_frame(a, b, mask, window[n], colour)
        row.update(frame=n, **text_share(yuv["cut"][n][:luma], yuv["joined"][n][:luma],
                                         yuv["notext"][n][:luma], window[n], colour_y))
        rows.append(row)
    judged = [row for row in rows if row["alpha_pm"] >= TEXT_SHARE_ALPHA
              and row["text_share"] is not None]
    lutrgb = graph.count("lutrgb=")
    checks = {
        "outside_identical": outside_mismatches == 0,
        "frames_equal_plan": frames == plan.total_frames == cut_plan.total_frames,
        "samples_equal": plan.total_samples == cut_plan.total_samples,
        "ass_equal": plan.ass_sha256 == cut_plan.ass_sha256,
        "pieces_equal": plan.pieces == cut_plan.pieces,
        "lutrgb_per_frame": lutrgb == len(join.alpha),
        "pixels_within_tolerance": all(row["max_abs"] <= PIXEL_TOLERANCE for row in rows),
        "mean_within_tolerance": all(row["mean_abs"] is not None
                                     and row["mean_abs"] <= MEAN_TOLERANCE for row in rows),
        "alpha_estimates": all(row["alpha_estimate_pm"] is not None
                               and abs(row["alpha_estimate_pm"] - row["alpha_pm"])
                               <= ALPHA_TOLERANCE_PM for row in rows),
        # the hook is held over the join in the 29.97 cases, so they must judge the layers
        "text_on_top": all(row["text_share"] >= TEXT_SHARE_MIN for row in judged)
        and (bool(judged) or not joined_case.hook),
    }
    return {"case": joined_case.name, "fps": list(fps), "style": style, "whoosh": whoosh,
            "at_f": join.at_f, "frames": frames, "affected_frames": len(join.alpha),
            "lutrgb_filters": lutrgb, "outside_mismatches": outside_mismatches,
            "text_frames_judged": len(judged), "frames_detail": rows, "checks": checks,
            "pass": all(checks.values())}


def p_join(ws: fi.Workspace, *, smoke: bool) -> dict[str, Any]:
    results = [p_join_case(ws, fps, style, whoosh) for fps, style, whoosh in p_join_cases(smoke)]
    return {"gate": "P-JOIN", "scope": "smoke" if smoke else "full",
            "threshold": {"outside": "frame md5 identical", "pixel_max": PIXEL_TOLERANCE,
                          "pixel_mean": MEAN_TOLERANCE, "alpha_pm": ALPHA_TOLERANCE_PM,
                          "text_share_min": TEXT_SHARE_MIN,
                          "text_share_frames_alpha_pm": TEXT_SHARE_ALPHA,
                          "text_mask_chroma_reach": CHROMA_REACH},
            "cases": results, "pass": bool(results) and all(r["pass"] for r in results)}


# --- G-WHOOSH ----------------------------------------------------------------------------------


def _measure(ws: fi.Workspace, case_: fi.Case):
    from ai_clipper.edit_v2.compile_ffmpeg import compile_job

    job = compile_job(ws.plan(case_), mode="audio_measure", source=ws.clip(case_)["source"],
                      assets_root=ws.root / "assets")
    return parse_ebur128(execute.run(job, output_fd=None, timeout_s=1800).stderr)


def _render_measured(ws: fi.Workspace, case_: fi.Case, loudness) -> Path:
    from ai_clipper.edit_v2.compile_ffmpeg import compile_job

    key = (case_.name, "reference")
    if key not in ws.renders:
        path = ws.root / f"{case_.name}.reference.mkv"
        job = compile_job(ws.plan(case_), mode="reference", source=ws.clip(case_)["source"],
                          assets_root=ws.root / "assets", loudness=loudness)
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            execute.run(job, output_fd=fd, timeout_s=1800)
        finally:
            os.close(fd)
        ws.renders[key] = {"path": path}
    return ws.renders[key]["path"]


def _music_clip(ws: fi.Workspace, base: fi.Case, name: str, whoosh: bool) -> fi.Case:
    """``base`` with ducked music (and the whoosh), registered in the workspace."""
    from support import edit_v2_audio_harness as harness

    variant = fi.Case(name, base.fps, base.frames, base.layout, hook=base.hook,
                      join_style="flash_white" if whoosh else "cut", whoosh=whoosh)
    if name in ws.clips:
        return variant
    music = harness.make_music(ws.root / "music.m4a")
    digest = hashlib.sha256(music.read_bytes()).hexdigest()
    stored = ws.root / "assets" / f"{digest}.m4a"
    if not stored.exists():
        shutil.copyfile(music, stored)
    asset = f"sha256:{digest}"
    clip = copy.deepcopy(ws.clip(base))
    doc = clip["doc"]
    if whoosh:
        doc["main"]["joins"][0].update(style="flash_white", sfx={"id": "whoosh", "v": 1})
    doc["tracks"].append({"id": "tr_mus", "kind": "audio", "role": "music", "items": [{
        "id": "it_music", "type": "audio", "start": {"at": "clip_start"},
        "end": {"at": "clip_end"},
        "payload": {"asset": asset, "src_in_smp": 0, "loop": True, "gain_cdb": -1000,
                    "fade_in_f": 15, "fade_out_f": 30,
                    "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30,
                             "release_ms": 400, "hold_ms": 250, "detector": "words"}},
        "origin": "user"}]})
    meta = {"kind": "audio", "mime": "audio/mp4", "duration_ms": 30_000, "lufs_c": -1800}
    doc["assets"] = {asset: meta}
    clip["assets"] = {asset: meta}
    clip["case"] = variant
    ws.clips[name] = clip
    return variant


def g_whoosh_case(ws: fi.Workspace, label: str, with_case: fi.Case, without_case: fi.Case,
                  *, measured: bool = False) -> dict[str, Any]:
    plan = ws.plan(with_case)
    (join,) = plan.joins
    sfx = join.sfx
    if measured:  # one master gain for both: the difference is the mix alone
        loudness = _measure(ws, without_case)
        with_path = _render_measured(ws, with_case, loudness)
        without_path = _render_measured(ws, without_case, loudness)
    else:
        with_path = ws.render(with_case, "reference")["path"]
        without_path = ws.render(without_case, "reference")["path"]
    mixed, plain = pcm(with_path), pcm(without_path)
    wav = whoosh_samples()
    first, last = 2 * sfx.start_smp, 2 * (sfx.start_smp + sfx.samples)
    skip = 2 * sfx.skip_smp
    outside = sum(a != b for a, b in zip(plain[:first], mixed[:first], strict=True))
    outside += sum(a != b for a, b in zip(plain[last:], mixed[last:], strict=True))
    errors = [mixed[i] - plain[i] - wav[skip + i - first] for i in range(first, min(last,
                                                                                 len(mixed)))]
    diff = array.array("h", (max(-32768, min(32767, mixed[i] - plain[i]))
                             for i in range(len(mixed))))
    peak_at = loudest_window(diff)
    expected = sfx.hit_smp - 240
    checks = {
        "lengths_equal_plan": len(mixed) == len(plain) == 2 * plan.total_samples,
        "outside_zero": outside == 0,
        "inside_within_1_lsb": bool(errors) and max(abs(e) for e in errors) <= WHOOSH_LSB,
        "inside_exact_share": bool(errors)
        and sum(e == 0 for e in errors) >= WHOOSH_EXACT_SHARE * len(errors),
        "peak_at_the_hit": abs(peak_at - expected) <= WHOOSH_PEAK_SAMPLES,
    }
    return {"case": label, "fps": list(with_case.fps), "style": join.style,
            "start_smp": sfx.start_smp, "samples": sfx.samples, "hit_smp": sfx.hit_smp,
            "outside_nonzero": outside,
            "inside_max_abs_error": max((abs(e) for e in errors), default=None),
            "inside_exact_share": round(sum(e == 0 for e in errors) / len(errors), 6)
            if errors else None,
            "loudest_10ms_at": peak_at, "loudest_10ms_expected": expected,
            "measured": measured, "checks": checks, "pass": all(checks.values())}


def g_whoosh(ws: fi.Workspace, *, smoke: bool) -> dict[str, Any]:
    ntsc, pal = (30000, 1001), (25, 1)
    results = [g_whoosh_case(ws, "29.97 flash_white+whoosh", case(ntsc, "flash_white",
                                                                   whoosh=True), case(ntsc))]
    if not smoke:
        results.append(g_whoosh_case(ws, "25 dip_black+whoosh",
                                     case(pal, "dip_black", whoosh=True), case(pal)))
        results.append(g_whoosh_case(ws, "29.97 cut+whoosh", case(ntsc, "cut", whoosh=True),
                                     case(ntsc)))
        base = case(ntsc)
        results.append(g_whoosh_case(
            ws, "29.97 whoosh with ducked music",
            _music_clip(ws, base, "join_30000-1001_music_whoosh", True),
            _music_clip(ws, base, "join_30000-1001_music", False), measured=True))
    return {"gate": "G-WHOOSH", "scope": "smoke" if smoke else "full",
            "threshold": {"outside": 0, "inside_lsb": WHOOSH_LSB,
                          "inside_exact_share": WHOOSH_EXACT_SHARE,
                          "peak_samples": WHOOSH_PEAK_SAMPLES},
            "cases": results, "pass": bool(results) and all(r["pass"] for r in results)}


# --- P-LOOK-JOIN -----------------------------------------------------------------------------------


def _make_job():
    import importlib.util

    name = "editor_fixture_make_job"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            name, ROOT / "scripts" / "editor_fixture" / "make_job.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules[name]


def _frame_rate(path: Path) -> float:
    output = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                             "stream=r_frame_rate", "-of", "json", str(path)], check=True,
                            capture_output=True, text=True).stdout
    num, den = json.loads(output)["streams"][0]["r_frame_rate"].split("/")
    return int(num) / int(den)


def _window_frames(path: Path, start: float, seconds: float) -> list[bytes]:
    """RGB frames of ``[start, start + seconds)`` (the same seek on two renders of one
    timeline gives the same frames)."""
    width, height = LOOK_OUTPUT
    data = _ffmpeg(["-ss", f"{max(0.0, start):.3f}", "-t", f"{seconds:.3f}", "-i", str(path),
                    "-map", "0:v:0", "-vf", _RGB, "-fps_mode", "passthrough", "-f", "rawvideo",
                    "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    size = width * height * 3
    return [data[i:i + size] for i in range(0, len(data) - size + 1, size)]


def _alpha_estimate(cut: bytes, auto: bytes, colour: int) -> int:
    numerator = denominator = 0
    for index in range(0, len(cut), 7):  # a regular subsample is plenty for one number
        base = cut[index]
        contrast = colour - base
        if abs(contrast) >= CONTRAST_MIN:
            numerator += (auto[index] - base) * contrast
            denominator += contrast * contrast
    return 0 if denominator == 0 else round(1000 * numerator / denominator)


def _onset(diff: Sequence[int], wav: Sequence[int], expected: int, span: int = 4800) -> int:
    """The whoosh's first sample in ``diff`` (stereo interleaved): 1 ms envelopes give the
    coarse lag, the full cross-correlation the sample within ±48 around it."""
    def mono(samples: Sequence[int], start: int, count: int) -> list[int]:
        return [samples[2 * (start + i)] + samples[2 * (start + i) + 1] for i in range(count)
                if 0 <= start + i < len(samples) // 2]

    reference = mono(wav, 0, len(wav) // 2)
    bins = 48
    ref_env = [sum(abs(v) for v in reference[i:i + bins]) for i in range(0, len(reference), bins)]
    best_lag, best = expected, -1.0
    for lag in range(expected - span, expected + span + 1, bins):
        segment = mono(diff, lag, len(reference))
        if len(segment) < len(reference):
            continue
        env = [sum(abs(v) for v in segment[i:i + bins]) for i in range(0, len(segment), bins)]
        score = sum(a * b for a, b in zip(env, ref_env))
        if score > best:
            best, best_lag = score, lag
    fine, best = best_lag, -math.inf
    for lag in range(best_lag - bins, best_lag + bins + 1):
        segment = mono(diff, lag, len(reference))
        if len(segment) < len(reference):
            continue
        score = sum(a * b for a, b in zip(segment, reference))
        if score > best:
            best, fine = score, lag
    return fine


def _loudness(path: Path) -> float:
    stderr = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", str(path),
                             "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f",
                             "null", "-"], capture_output=True, text=True, check=True).stderr
    return parse_ebur128(stderr).i_clufs / 100


def _look_engine(auto_dir: Path, cut_dir: Path, engine: str) -> dict[str, Any]:
    """One engine's alpha series around its own join and its whoosh onset."""
    from ai_clipper.edit_v2 import render_edit, store

    manifest = json.loads((auto_dir / "output" / "manifest.json").read_text(encoding="utf-8"))
    entry = next(clip for clip in manifest["clips"] if clip["index"] == 1)
    teaser = entry["cold_open"]
    if teaser is None or entry.get("cold_open_join") is None:
        raise RuntimeError(f"{engine}: clip 1 was rendered without its cold open")
    length_ms = int(f"{teaser['end'] - teaser['start']:.3f}".replace(".", ""))
    auto = auto_dir / "output" / "clip-01.mp4"
    cut = cut_dir / "output" / "clip-01.mp4"
    spec = transitions.SFX[("whoosh", 1)]
    if engine == "edit-v2":
        seed_doc, _etag = store.seed(auto_dir / "analysis" / "clips" / entry["clip_id"])
        plan = render_edit.load_render_inputs(auto_dir, seed_doc).plan
        (join,) = plan.joins
        join_s = join.at_f * plan.fps.den / plan.fps.num
        expected_onset = join.sfx.start_smp
    else:
        join_s = length_ms / 1000
        expected_onset = length_ms * 48 - spec.hit_smp
    rate = _frame_rate(auto)
    start = join_s - 0.4
    auto_frames, cut_frames = _window_frames(auto, start, 0.8), _window_frames(cut, start, 0.8)
    alphas = [_alpha_estimate(c, a, 255) for c, a in zip(cut_frames, auto_frames, strict=False)]
    peak = max(range(len(alphas)), key=alphas.__getitem__) if alphas else 0
    mixed, plain = pcm(auto), pcm(cut)
    count = min(len(mixed), len(plain))
    diff = array.array("h", (max(-32768, min(32767, mixed[i] - plain[i])) for i in range(count)))
    onset = _onset(diff, whoosh_samples(), expected_onset)
    return {"engine": engine, "fps": round(rate, 3), "join_s": round(join_s, 6),
            "alpha_pm": alphas, "peak_index": peak, "onset_smp": onset,
            "expected_onset_smp": expected_onset, "onset_error_smp": onset - expected_onset,
            "loudness_lufs": _loudness(auto), "loudness_cut_lufs": _loudness(cut)}


def _compare_alphas(new: Mapping[str, Any], legacy: Mapping[str, Any]) -> dict[str, Any]:
    """edit-v2 frame ``k`` from its peak against the legacy frame at the same time from its
    peak, at the best offset in ±1 legacy frame."""
    ratio = legacy["fps"] / new["fps"]
    best = None
    for offset in (-1, 0, 1):
        worst = 0
        compared = 0
        for k in range(-5, 6):
            i = new["peak_index"] + k
            j = legacy["peak_index"] + round(k * ratio) + offset
            if 0 <= i < len(new["alpha_pm"]) and 0 <= j < len(legacy["alpha_pm"]):
                worst = max(worst, abs(new["alpha_pm"][i] - legacy["alpha_pm"][j]))
                compared += 1
        if compared and (best is None or worst < best[1]):
            best = (offset, worst, compared)
    offset, worst, compared = best if best is not None else (None, None, 0)
    return {"best_offset": offset, "max_abs_alpha_pm": worst, "frames_compared": compared}


def look(work: Path) -> dict[str, Any]:
    from ai_clipper import pipeline
    from ai_clipper import render as legacy_render
    from ai_clipper.edit_v2 import camera

    make_job = _make_job()
    camera.detect_face_track = make_job._stub_detector  # deterministic face track (fps60)
    legacy_render.detect_face_track = make_job._stub_detector
    index = make_job.build(work / "fixture", size=LOOK_SOURCE, only=LOOK_JOBS, force=True)
    rows = []
    for name in LOOK_JOBS:
        pristine = work / "fixture" / index["jobs"][name]["dir"]
        engines = {}
        try:
            for engine in ("legacy", "edit-v2"):
                dirs = {}
                for variant, join in (("auto", transitions.AUTO_COLD_OPEN_JOIN), ("cut", None)):
                    target = work / "runs" / f"{name}-{engine}-{variant}" / pristine.name
                    if target.exists():
                        shutil.rmtree(target)
                    shutil.copytree(pristine, target, symlinks=True)
                    run = pipeline.render_v3_job(target, render_engine=engine, ranks=[1],
                                                 cold_open_join=join)
                    if run.warnings:
                        raise RuntimeError(f"{engine} {variant}: {run.warnings}")
                    manifest_path = target / "output" / "manifest.json"
                    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                    manifest["clips"] = run.clips
                    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                    dirs[variant] = target
                engines[engine] = _look_engine(dirs["auto"], dirs["cut"], engine)
        except Exception as error:  # noqa: BLE001 - recorded as a failed job, the others run
            rows.append({"job": name, "error": f"{type(error).__name__}: {error}"[:300],
                         "pass": False})
            continue
        new, legacy = engines["edit-v2"], engines["legacy"]
        alphas = _compare_alphas(new, legacy)
        checks = {
            "alpha_shapes": alphas["max_abs_alpha_pm"] is not None
            and alphas["max_abs_alpha_pm"] <= LOOK_ALPHA_TOLERANCE_PM,
            "onsets": all(abs(row["onset_error_smp"]) <= LOOK_ONSET_SAMPLES
                          for row in engines.values()),
            "loudness": abs(new["loudness_lufs"] - legacy["loudness_lufs"]) <= LOOK_LOUDNESS_LU,
        }
        rows.append({"job": name, "engines": engines, "alpha": alphas,
                     "loudness_delta_lu": round(new["loudness_lufs"] - legacy["loudness_lufs"], 2),
                     "checks": checks, "pass": all(checks.values())})
    return {"gate": "P-LOOK-JOIN",
            "threshold": {"alpha_pm": LOOK_ALPHA_TOLERANCE_PM, "offset_frames": 1,
                          "onset_samples": LOOK_ONSET_SAMPLES, "loudness_lu": LOOK_LOUDNESS_LU},
            "jobs": rows, "pass": bool(rows) and all(row["pass"] for row in rows)}


# --- PF-RENDER of the transition (report only) -----------------------------------------------------


def _timed(function) -> float:
    started = time.monotonic()
    function()
    return round(time.monotonic() - started, 3)


def pf_render(ws: fi.Workspace) -> dict[str, Any]:
    """The cost of the effect and the whoosh in each engine's delivered render: the 29.97 clip
    with and without them (edit-v2 ``final``; legacy ``render_vertical`` over the same source
    ranges), each run twice, the faster kept."""
    from ai_clipper.render import render_vertical

    ntsc = (30000, 1001)
    rows = {}
    for label, case_ in (("cut", case(ntsc)), ("flash_white+whoosh",
                                                case(ntsc, "flash_white", whoosh=True))):
        times = []
        for attempt in range(2):
            key = (case_.name, "final" + ("#2" if attempt else ""))
            ws.renders.pop(key, None)
            times.append(_timed(lambda c=case_, a=attempt: ws.render(c, "final", again=bool(a))))
        rows[f"edit-v2 {label}"] = min(times)
    clip = ws.clip(case(ntsc))
    plan = ws.plan(case(ntsc))
    body = next(piece for piece in plan.pieces if piece.role == "body")
    co = plan.pieces[0]
    fps = plan.fps
    start, end = body.in_sf * fps.den / fps.num, plan.pieces[-1].out_sf * fps.den / fps.num
    teaser = (co.in_sf * fps.den / fps.num, co.out_sf * fps.den / fps.num)
    for label, options in (("cut", {}), ("flash_white+whoosh",
                                         {"join_style": "flash_white", "join_sfx": "whoosh"})):
        times = []
        for attempt in range(2):
            output = ws.root / f"pf-legacy-{label.replace('+', '-')}-{attempt}.mp4"
            for path in (output, output.with_suffix(".srt")):
                path.unlink(missing_ok=True)
            times.append(_timed(lambda o=output, opts=options: render_vertical(
                clip["source"], o, start=round(start, 3), end=round(end, 3), transcript=[],
                width=720, height=1280, render_mode="fit-blur",
                cold_open=(round(teaser[0], 3), round(teaser[1], 3)), **opts)))
        rows[f"legacy {label}"] = min(times)
    clip_s = plan.total_frames * fps.den / fps.num
    return {"gate": "PF-RENDER-JOIN", "report_only": True, "clip_s": round(clip_s, 3),
            "render_s": rows,
            "ratio": {name: round(seconds / clip_s, 4) for name, seconds in rows.items()},
            "delta_s": {"edit-v2": round(rows["edit-v2 flash_white+whoosh"]
                                         - rows["edit-v2 cut"], 3),
                        "legacy": round(rows["legacy flash_white+whoosh"] - rows["legacy cut"],
                                        3)},
            "note": ("synthetic barcode source, 720×1280; edit-v2 is the 20-cut document, "
                     "legacy the cold open and the body's span (no cuts)")}


# --- CLI -------------------------------------------------------------------------------------------


def write(directory: Path, task: str, gate: str, result: Mapping[str, Any]) -> Path:
    path = Path(directory) / f"{task}-{gate}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {**result, "toolchain": fi._toolchain()}
    path.write_text(json.dumps(body, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("gate", choices=("p-join", "g-whoosh", "look", "pf", "smoke", "all"))
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--work", type=Path, default=None)
    parser.add_argument("--task", default="CI")
    args = parser.parse_args(argv)
    smoke = args.gate == "smoke"
    names = {"p-join": ["p-join"], "g-whoosh": ["g-whoosh"], "look": ["look"], "pf": ["pf"],
             "smoke": ["p-join", "g-whoosh"],
             "all": ["p-join", "g-whoosh", "pf", "look"]}[args.gate]
    failed = []
    with tempfile.TemporaryDirectory(prefix="join-gates-") as scratch:
        work = Path(scratch) if args.work is None else args.work
        work.mkdir(parents=True, exist_ok=True)
        ws = fi.Workspace(work / "ws")
        for name in names:
            started = time.monotonic()
            if name == "p-join":
                result = p_join(ws, smoke=smoke)
            elif name == "g-whoosh":
                result = g_whoosh(ws, smoke=smoke)
            elif name == "pf":
                result = pf_render(ws)
            else:
                result = look(work / "look")
            result["gate_wall_s"] = round(time.monotonic() - started, 1)
            write(args.evidence, args.task, result["gate"], result)
            verdict = {True: "pass", False: "FAIL", None: "report"}[result.get("pass")]
            print(f"{result['gate']}: {verdict} ({result['gate_wall_s']} s)", flush=True)
            if result.get("pass") is False:
                failed.append(result["gate"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
