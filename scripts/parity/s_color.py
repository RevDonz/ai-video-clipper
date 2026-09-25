#!/usr/bin/env python3
"""Spike S-COLOR: the text compositing format (plan §5.2 R5, E6, K2) and the pack variants.

Candidates ``yuv420p``, ``yuv444p`` and ``gbrp`` are scored on

* **P-TXT** (raster parity of JASSUB against the FFmpeg composite before 4:2:0, ``compare.py``),
* **P-ENC** (the delivered MP4 against the lossless composite, ``enc_check.py``),
* **P-COLOR** (interior fill of every swatch colour and of the box: the delivered MP4 decoded as
  BT.709 against the JASSUB composite, |ΔR|,|ΔG|,|ΔB| ≤ 4),
* **render cost** at 720×1280 (``fit_blur`` + karaoke captions + hook + R7 encode, best of N).

``decide`` picks the cheapest candidate that passes every gate; ``yuv420p`` (the cheapest) wins
only when its delivered text-region SSIM is within 0.002 of the best passing candidate.
``choose_variant`` makes the pack decisions (Montserrat ExtraBold or DejaVu Sans Bold;
``BorderStyle 3`` or a ``\\p`` box) from P-TXT.

CLI::

    s_color.py cost --out cost.json [--seconds 30] [--runs 3] --fonts DIR   (reference image)
    s_color.py matrix-probe --out matrix.json --fonts DIR                  (reference image)
    s_color.py decide --fixtures DIR --browser DIR --cost cost.json --out decision.json
    s_color.py evidence --decision decision.json --browser DIR --matrix matrix.json \
        --out-dir docs/editor/evidence/W1

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compare
import enc_check
import reference_text as rt
from compare import Box

from ai_clipper import captions_ass
from ai_clipper.edit_v2 import compile_ffmpeg
from ai_clipper.edit_v2.timemap import Fps

R7_DESCRIPTION = (
    f"R7 Standar (x264 {compile_ffmpeg.STANDAR[0]} crf {compile_ffmpeg.STANDAR[1]}, "
    f"chroma-qp-offset {compile_ffmpeg.STANDAR_CHROMA_QP_OFFSET}, yuv420p via "
    f"{compile_ffmpeg.FINAL_SCALE_FLAGS}, BT.709 tags)")

WITHIN = 0.002
LAYOUTS = ("fit_blur", "fill_center")
_GATES = (("p_txt", "p_txt_pass"), ("p_color", "p_color_pass"), ("p_enc", "p_enc_pass"))


# --- decisions ----------------------------------------------------------------------------------


def decide(candidates: Mapping[str, Mapping]) -> dict:
    """The S-COLOR rule. ``candidates[fmt]`` has ``cost_s``, ``p_txt_pass``, ``p_color_pass``,
    ``p_enc_pass`` and ``delivered_ssim_text``."""
    rejected: dict[str, list[str]] = {}
    passing = []
    for fmt, entry in candidates.items():
        failures = [gate for gate, key in _GATES if not entry[key]]
        if failures:
            rejected[fmt] = failures
        else:
            passing.append(fmt)
    if not passing:
        return {"format": None, "rule": "none_passed", "rejected": rejected}
    best = max(candidates[fmt]["delivered_ssim_text"] for fmt in passing)
    if "yuv420p" in passing:
        gap = best - candidates["yuv420p"]["delivered_ssim_text"]
        if gap <= WITHIN + 1e-12:
            return {"format": "yuv420p", "rule": "yuv420p_within_0.002", "rejected": rejected,
                    "best_delivered_ssim_text": best, "yuv420p_gap": gap}
        rejected["yuv420p"] = ["delivered_ssim_text"]
        passing.remove("yuv420p")
    if not passing:
        return {"format": None, "rule": "none_passed", "rejected": rejected}
    winner = min(passing, key=lambda fmt: (candidates[fmt]["cost_s"], fmt))
    return {"format": winner, "rule": "cheapest_passing", "rejected": rejected,
            "best_delivered_ssim_text": best}


def recommend(candidates: Mapping[str, Mapping], decision: Mapping) -> dict:
    """The format to use, given ``decide``'s outcome.

    When the rule chose a candidate, that one. When P-ENC fails for every candidate, it cannot
    rank them (the final 4:2:0 + H.264 step is the same in all of them), so the cheapest
    candidate passing P-TXT and P-COLOR is recommended with P-ENC left open. Otherwise none.
    """
    if decision["format"] is not None:
        return {"format": decision["format"], "basis": decision["rule"], "open_gates": []}
    rejected = decision["rejected"]
    if all("p_enc" in rejected.get(fmt, ()) for fmt in candidates):
        eligible = [fmt for fmt, entry in candidates.items()
                    if entry["p_txt_pass"] and entry["p_color_pass"]]
        if eligible:
            winner = min(eligible, key=lambda fmt: (candidates[fmt]["cost_s"], fmt))
            return {"format": winner, "basis": "p_enc_fails_for_every_candidate",
                    "open_gates": ["p_enc"]}
    failing = {gate for reasons in rejected.values() for gate in reasons}
    return {"format": None, "basis": "none_passed",
            "open_gates": [gate for gate, _ in _GATES if gate in failing]}


def choose_variant(results: Mapping[str, bool], *, preferred: str,
                   fallback: str) -> tuple[str, str]:
    """The planned variant when it passes P-TXT, else the fallback when that passes."""
    if results.get(preferred):
        return preferred, "passes P-TXT"
    if results.get(fallback):
        return fallback, f"{preferred} fails P-TXT"
    raise ValueError(f"neither {preferred} nor {fallback} passes P-TXT")


# --- render cost --------------------------------------------------------------------------------


def cost_graph(fmt: str, *, layout: str, ass: str, fps: Fps = rt.PTXT_FPS) -> str:
    """The production-shaped graph of one candidate at 720×1280: layout (R4) → frame-index time
    base (§3.4) → text composite in ``fmt`` (R5) → BT.709 4:2:0."""
    w, h = rt.WIDTH, rt.HEIGHT
    scale = "in_color_matrix=bt709:out_color_matrix=bt709"
    if layout == "fit_blur":
        sigma = 35 * h // 1280
        head = (f"[0:v]split=2[s0][s1];"
                f"[s0]scale={w}:{h}:force_original_aspect_ratio=increase:{scale},crop={w}:{h},"
                f"gblur=sigma={sigma},format=yuv444p[bg];"
                f"[s1]scale={w}:{h}:force_original_aspect_ratio=decrease:{scale},format=yuv444p[fg];"
                f"[bg][fg]overlay=(W-w)/2:(H-h)/2:format=yuv444")
    elif layout == "fill_center":
        head = f"[0:v]scale={w}:{h}:force_original_aspect_ratio=increase:{scale},crop={w}:{h}"
    else:
        raise ValueError(f"layout {layout!r} is not part of the cost measurement")
    return (f"{head},{rt.timebase_graph(fps)},{rt.composite_graph(fmt, ass)},"
            f"{rt.final_graph(fmt)}[v]")


def _cost_ass(seconds: int, fps: Fps) -> str:
    tokens = rt.SAMPLE_TEXTS[90].split()
    words: list[rt.Word] = []
    frame = 6
    total = seconds * fps.num // fps.den
    while True:
        text = tokens[len(words) % len(tokens)]
        if frame + 9 + len(text) > total - 6:
            break
        words.append(rt.Word(text, frame, frame + 9 + len(text)))
        frame += 9 + len(text)
    cues = rt.group_cues(words, pack="karaoke")
    duration = rt._cs(total, fps) / 100
    return captions_ass.build_ass(rt._legacy_cues(cues, fps), width=rt.WIDTH, height=rt.HEIGHT,
                                  duration=duration, caption_style="karaoke",
                                  hook_text=rt.HOOK_TEXT, hook_duration=4.0)


def measure_cost(out: Path, *, fonts_dir: Path, seconds: int = 30, runs: int = 3,
                 formats: Sequence[str] = rt.CANDIDATES, layout: str = "fit_blur",
                 ffmpeg: str = "ffmpeg", threads: int = 4,
                 log=lambda line: None) -> dict:
    """Wall time per candidate (best of ``runs``, interleaved) for ``seconds`` of 720×1280."""
    fps = rt.PTXT_FPS
    work = Path(tempfile.mkdtemp(prefix="s-color-cost-"))
    try:
        fonts = work / "fonts"
        fonts.mkdir()
        for path in Path(fonts_dir).iterdir():
            if path.suffix.lower() in (".ttf", ".otf"):
                shutil.copyfile(path, fonts / path.name)
        (work / "fonts.conf").write_text(rt._fonts_conf(fonts, work / "fc-cache"))
        (work / "c.ass").write_text(_cost_ass(seconds, fps), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TMPDIR")}
        env["FONTCONFIG_FILE"] = str(work / "fonts.conf")
        base = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y"]
        log("source")
        subprocess.run([*base, "-f", "lavfi", "-i",
                        (f"testsrc2=size=1280x720:rate={fps.num}/{fps.den}:duration={seconds},"
                         "noise=alls=8:allf=t+u:all_seed=5,format=yuv420p"), "-threads", "4",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace",
                        "bt709", str(work / "source.mp4")], check=True, cwd=work, env=env)
        times: dict[str, list[float]] = {fmt: [] for fmt in formats}
        ass = rt.ass_filter("c.ass")
        for run in range(runs):
            for fmt in formats:
                argv = [*base, "-threads", str(threads), "-i", "source.mp4",
                        "-filter_complex_threads", str(threads), "-filter_complex",
                        cost_graph(fmt, layout=layout, ass=ass, fps=fps), "-map", "[v]",
                        *rt.x264_args(fps), f"out-{fmt}.mp4"]
                started = time.monotonic()
                subprocess.run(argv, check=True, cwd=work, env=env)
                elapsed = time.monotonic() - started
                times[fmt].append(round(elapsed, 3))
                log(f"run {run + 1} {fmt}: {elapsed:.2f} s")
        best = {fmt: min(values) for fmt, values in times.items()}
        base_cost = best.get("yuv420p", min(best.values()))
        result = {
            "schema": "potongin.s-color-cost/1",
            "size": [rt.WIDTH, rt.HEIGHT], "seconds": seconds, "fps": [fps.num, fps.den],
            "layout": layout, "runs": runs, "threads": threads,
            "cpus": os.cpu_count(), "affinity": len(os.sched_getaffinity(0)),
            "times_s": times, "best_s": best,
            "relative_to_yuv420p": {fmt: round(value / base_cost, 3) for fmt, value in best.items()},
            "speed_x_realtime": {fmt: round(value / seconds, 3) for fmt, value in best.items()},
            "toolchain": rt._toolchain(ffmpeg),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


# --- P-COLOR ------------------------------------------------------------------------------------


def decode_frames(path: Path, frames: Sequence[int], *, width: int, height: int,
                  ffmpeg: str = "ffmpeg") -> dict[int, compare.Image]:
    """Frames of an MP4 decoded as tagged BT.709 (limited range) to RGB."""
    wanted = sorted(set(frames))
    select = "select='" + "+".join(f"eq(n\\,{n})" for n in wanted) + "'"
    raw = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-i",
                          str(path), "-vf", f"{select},{rt.DECODE_709},format=rgb24",
                          "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         check=True, capture_output=True, timeout=600).stdout
    size = width * height * 3
    if len(raw) != size * len(wanted):
        raise RuntimeError(f"{path}: expected {len(wanted)} frames, got {len(raw) / size:g}")
    return {frame: compare.Image(width, height, 3, raw[i * size:(i + 1) * size])
            for i, frame in enumerate(wanted)}


def _hex_rgb(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


# E6/R5: "drawutils converts ASS colours with BT.601 coefficients in YUV formats" (to confirm or
# refute). Each variant composites the swatch sheet over black and is read back as BT.709.
# The last variant reads the yuv444p composite back as BT.601: if the ASS colours were converted
# with BT.601, its fills match the ASS colours.
_DECODE_601 = rt.DECODE_709.replace("bt709", "bt601")
MATRIX_VARIANTS = {
    "yuv420p": ("format=yuv420p", f"{rt.DECODE_709},format=rgb24"),
    "yuv444p": ("format=yuv444p", f"{rt.DECODE_709},format=rgb24"),
    "yuv444p+setparams_bt709": (("format=yuv444p,setparams=colorspace=bt709:range=tv:"
                                 "color_primaries=bt709:color_trc=bt709"),
                                f"{rt.DECODE_709},format=rgb24"),
    "gbrp": ("format=gbrp", "format=rgb24"),
    "yuv444p_read_as_bt601": ("format=yuv444p", f"{_DECODE_601},format=rgb24"),
}


def _fill_colors(image: compare.Image, rows: Sequence[tuple[int, int]]) -> list[tuple[int, ...]]:
    """The most common non-black colour in each band of rows (a swatch word's fill)."""
    result = []
    for top, bottom in rows:
        counts: Counter = Counter()
        for y in range(top, bottom):
            row = image.row(y)
            for x in range(image.width):
                pixel = row[3 * x:3 * x + 3]
                if max(pixel) > 24:
                    counts[pixel] += 1
        result.append(tuple(counts.most_common(1)[0][0]))
    return result


def matrix_probe(*, fonts_dir: Path, ffmpeg: str = "ffmpeg") -> dict:
    """Swatch fill colours of the ``ass`` filter per compositing format, decoded as BT.709."""
    fps = rt.PTXT_FPS
    work = Path(tempfile.mkdtemp(prefix="s-color-matrix-"))
    try:
        fonts = work / "fonts"
        fonts.mkdir()
        for path in Path(fonts_dir).iterdir():
            if path.suffix.lower() in (".ttf", ".otf"):
                shutil.copyfile(path, fonts / path.name)
        (work / "fonts.conf").write_text(rt._fonts_conf(fonts, work / "fc-cache"))
        (work / "p.ass").write_text(rt.pcolor_ass(fps=fps, total_frames=3), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TMPDIR")}
        env["FONTCONFIG_FILE"] = str(work / "fonts.conf")
        rows = [(150 + 125 * i - 20, 150 + 125 * i + 20) for i in range(len(rt.SWATCHES))]
        variants = {}
        for name, (head, view) in MATRIX_VARIANTS.items():
            graph = (f"color=c=black:size={rt.WIDTH}x{rt.HEIGHT}:rate={fps.num}/{fps.den},"
                     f"trim=end_frame=1,{rt.timebase_graph(fps)},{head},"
                     f"{rt.ass_filter('p.ass')},{view}")
            raw = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
                                  "-f", "lavfi", "-i", graph, "-frames:v", "1", "-f", "rawvideo",
                                  "-pix_fmt", "rgb24", "-"], check=True, capture_output=True,
                                 cwd=work, env=env, timeout=300).stdout
            image = compare.Image(rt.WIDTH, rt.HEIGHT, 3, raw)
            swatches = {}
            for color, fill in zip(rt.SWATCHES, _fill_colors(image, rows), strict=True):
                expected = _hex_rgb(color)
                delta = [b - a for a, b in zip(expected, fill, strict=True)]
                swatches[color] = {"fill": list(fill), "delta": delta,
                                   "max_abs": max(abs(d) for d in delta)}
            variants[name] = {"graph": head, "view": view, "swatches": swatches,
                              "worst_max_abs": max(s["max_abs"] for s in swatches.values())}
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {"schema": "potongin.s-color-matrix/1", "variants": variants,
            "toolchain": rt._toolchain(ffmpeg)}


def _box_fill(preview: compare.Image, bg: compare.Image, top: int) -> tuple[int, int, int]:
    """The most common composite colour that differs from the plate below row ``top``."""
    counts: Counter = Counter()
    for y in range(top, preview.height):
        row, plate = preview.row(y), bg.row(y)
        for x in range(preview.width):
            pixel = row[3 * x:3 * x + 3]
            if pixel != plate[3 * x:3 * x + 3]:
                counts[pixel] += 1
    if not counts:
        raise ValueError("no box pixels found")
    return tuple(counts.most_common(1)[0][0])


def score_p_color(fixtures: Path, browser: Path, *, formats: Sequence[str] | None = None,
                  ffmpeg: str = "ffmpeg", radius: int = 2) -> dict:
    """P-COLOR per candidate: interior fills of the swatch sheet (delivered MP4 vs JASSUB), plus
    the same comparison against the lossless FFmpeg composite (before 4:2:0) for diagnosis."""
    manifest = compare.load_manifest(fixtures)
    size = tuple(manifest["size"])
    clip = next(c for c in manifest["clips"] if c["kind"] == "pcolor")
    region = Box(*clip["text_region"])
    swatch_bottom = 150 + 125 * (len(rt.SWATCHES) - 1) + 60 - region.y0
    result: dict = {"schema": "potongin.p-color/1", "max_abs_delta": compare.P_COLOR_MAX_DELTA,
                    "radius": radius, "formats": {}}
    for fmt in formats or manifest["formats"]:
        delivered_frames = decode_frames(fixtures / clip["files"]["export"][fmt],
                                         clip["probe_frames"], width=size[0], height=size[1],
                                         ffmpeg=ffmpeg)
        colors: dict[str, dict] = {}
        for frame in clip["probe_frames"]:
            bg = compare.read_png(fixtures / clip["files"]["bg"][fmt][str(frame)]).rgb()
            preview = compare.browser_composite(browser, clip, fmt, frame, size, bg).crop(region)
            reference = compare.read_png(fixtures / clip["files"]["ref"][fmt][str(frame)]).rgb()
            delivered = delivered_frames[frame].crop(region)
            targets = {color: _hex_rgb(color) for color in rt.SWATCHES}
            targets["box"] = _box_fill(preview, bg.crop(region), swatch_bottom)
            for name, rgb in targets.items():
                mask = compare.interior_mask(preview, rgb, radius=radius)
                if not mask:
                    raise ValueError(f"{fmt} frame {frame}: no interior pixels of {name}")
                entry = colors.setdefault(name, {"rgb": list(rgb), "frames": {}})
                entry["frames"][str(frame)] = {
                    "delivered": compare.color_delta(preview, delivered, mask),
                    "reference": compare.color_delta(preview, reference.crop(region), mask),
                }
        worst = 0.0
        failures = []
        for name, entry in colors.items():
            delivered = [f["delivered"] for f in entry["frames"].values()]
            reference = [f["reference"] for f in entry["frames"].values()]
            entry["delivered_mean_delta"] = [round(sum(d["mean_delta"][k] for d in delivered)
                                                   / len(delivered), 3) for k in range(3)]
            entry["reference_mean_delta"] = [round(sum(d["mean_delta"][k] for d in reference)
                                                   / len(reference), 3) for k in range(3)]
            entry["max_abs_mean_delta"] = max(d["max_abs_mean_delta"] for d in delivered)
            entry["reference_max_abs_mean_delta"] = max(d["max_abs_mean_delta"] for d in reference)
            entry["pixels"] = min(d["pixels"] for d in delivered)
            entry["pass"] = all(compare.p_color_pass(d) for d in delivered)
            worst = max(worst, entry["max_abs_mean_delta"])
            if not entry["pass"]:
                failures.append({"color": name, "max_abs_mean_delta": entry["max_abs_mean_delta"],
                                 "mean_delta": entry["delivered_mean_delta"]})
        result["formats"][fmt] = {"colors": colors, "worst_max_abs_mean_delta": worst,
                                  "gate": {"pass": not failures, "failures": failures}}
    return result


# --- the decision -------------------------------------------------------------------------------


def _all_pass(clips: Mapping[str, Mapping], prefix: str) -> bool | None:
    ids = [f"{prefix}-{length}" for length in rt.LENGTHS]
    present = [clips[i]["pass"] for i in ids if i in clips]
    if not present:
        return None
    return all(present) and len(present) == len(ids)


def pack_variants(clips: Mapping[str, Mapping]) -> dict:
    """Pack variant decisions from one candidate's P-TXT per-clip results."""
    decisions: dict = {}
    for name, results, preferred, fallback in (
        ("bold_font", {"montserrat": _all_pass(clips, "bold"),
                       "dejavu": _all_pass(clips, "bold-dejavu")}, "montserrat", "dejavu"),
        ("box_background", {"border3": _all_pass(clips, "box"),
                            "pbox": _all_pass(clips, "box-pbox")}, "border3", "pbox"),
        ("box_font", {"montserrat": bool(_all_pass(clips, "box") or _all_pass(clips, "box-pbox")),
                      "dejavu": _all_pass(clips, "box-dejavu")}, "montserrat", "dejavu"),
    ):
        try:
            choice, reason = choose_variant(results, preferred=preferred, fallback=fallback)
        except ValueError as error:
            choice, reason = None, str(error)
        decisions[name] = {"choice": choice, "reason": reason, "results": results}
    return decisions


def _p_txt_pass(clips: Mapping[str, Mapping], variants: Mapping) -> tuple[bool, list[str]]:
    """Every gated clip passes, with Bold/Box judged on their chosen variants."""
    failing = []
    for clip_id, entry in clips.items():
        if entry["pack"] in ("bold", "box") or not entry["gate"]:
            continue
        if not entry["pass"]:
            failing.append(clip_id)
    for name in ("bold_font", "box_background", "box_font"):
        if variants[name]["choice"] is None:
            failing.append(name)
    return not failing, failing


def decide_from_files(fixtures: Path, browser: Path, *, cost: Mapping, p_txt: Mapping | None,
                      p_enc: Mapping | None = None, ffmpeg: str = "ffmpeg",
                      log=lambda line: None) -> dict:
    manifest = compare.load_manifest(fixtures)
    formats = manifest["formats"]
    if p_txt is None:
        log("P-TXT")
        p_txt = compare.score_p_txt(fixtures, browser, formats)
    if p_enc is None:
        log("P-ENC")
        p_enc = enc_check.measure_fixtures(fixtures, formats=formats, ffmpeg=ffmpeg)
    log("P-COLOR")
    p_color = score_p_color(fixtures, browser, formats=formats, ffmpeg=ffmpeg)
    candidates = {}
    for fmt in formats:
        clips = p_txt["formats"][fmt]["clips"]
        variants = pack_variants(clips)
        txt_pass, txt_failing = _p_txt_pass(clips, variants)
        enc = p_enc["formats"][fmt]
        candidates[fmt] = {
            "cost_s": cost["best_s"][fmt],
            "p_txt_pass": txt_pass,
            "p_txt_failing": txt_failing,
            "p_txt_worst_gated": p_txt["formats"][fmt]["worst_gated"],
            "p_color_pass": p_color["formats"][fmt]["gate"]["pass"],
            "p_color_worst": p_color["formats"][fmt]["worst_max_abs_mean_delta"],
            "p_enc_pass": enc["gate"]["pass"],
            "p_enc_min_ssim_all": enc["min_ssim_all"],
            "p_enc_min_ssim_text": enc["min_ssim_text"],
            # Delivered text quality against the one composite that matches the preview.
            "delivered_ssim_text": (enc["mean_ssim_text_vs_common"]
                                    if enc.get("mean_ssim_text_vs_common") is not None
                                    else enc["mean_ssim_text"]),
            "p_enc_mean_ssim_text_own": enc["mean_ssim_text"],
            "pack_variants": variants,
        }
    decision = decide(candidates)
    recommendation = recommend(candidates, decision)
    chosen = recommendation["format"]
    return {
        "schema": "potongin.s-color/1",
        "decision": decision,
        "recommendation": recommendation,
        "pack_variants": candidates[chosen]["pack_variants"] if chosen else None,
        "candidates": candidates,
        "cost": cost,
        "p_color": p_color,
        "p_enc": p_enc,
        "toolchain": manifest.get("toolchain"),
    }


def _rounded(value: object, digits: int = 6) -> object:
    if isinstance(value, float):
        return round(value, digits) if math.isfinite(value) else ("inf" if value > 0 else "-inf")
    if isinstance(value, dict):
        return {key: _rounded(item, digits) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_rounded(item, digits) for item in value]
    return value


def _number(value: object) -> float:
    return math.inf if value == "inf" else float(value)


def _p_txt_clip(entry: Mapping) -> dict:
    frames = list(entry["frames"].values())
    return {"pass": entry["pass"], "gate": entry["gate"], "frames": len(frames),
            "min_ssim": min(f["ssim"] for f in frames),
            "min_ssim_text": min(f["ssim_text"] for f in frames),
            "min_psnr": min(_number(f["psnr"]) for f in frames),
            "max": max(f["max"] for f in frames),
            "max_px_over_16": max(f["px_over_16"] for f in frames)}


def _percentile(values: Sequence[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(q * len(ordered)) - 1)]


def _p_enc_formats(p_enc: Mapping, detail: str | None) -> dict:
    """Summaries per candidate; per-clip detail (the baseline) for ``detail`` only."""
    formats = {}
    for fmt, entry in p_enc["formats"].items():
        clips = {}
        for cid, c in entry["clips"].items():
            row = {"ssim_all": c["ssim_all"], "ssim_text": c["ssim_text"], "pass": c["pass"]}
            if fmt == detail:
                row.update({"ssim_y": c.get("ssim_y"), "ssim_text_y": c.get("ssim_text_y"),
                            "min_frame_ssim_all": c["min_frame_ssim_all"],
                            "min_frame_ssim_text": c["min_frame_ssim_text"],
                            "rgb_diagnostic": c.get("rgb"), "gate": c["gate"]})
            elif c.get("vs_common"):
                row["vs_common_ssim_text"] = c["vs_common"]["ssim_text"]
            clips[cid] = row
        formats[fmt] = {"pass": entry["gate"]["pass"], "min_ssim_all": entry["min_ssim_all"],
                        "min_ssim_text": entry["min_ssim_text"],
                        "mean_ssim_all": entry["mean_ssim_all"],
                        "mean_ssim_text": entry["mean_ssim_text"],
                        "mean_ssim_text_vs_common": entry.get("mean_ssim_text_vs_common"),
                        "clips": clips}
    return formats


def write_evidence(*, decision: Mapping, browser: Path, matrix: Mapping | None, out_dir: Path,
                   natural_p_enc: Mapping | None = None, task: str = "T1.2b") -> list[Path]:
    """The gate evidence of T1.2b (numbers only) from one harness run and one decision.

    ``natural_p_enc`` is an ``enc_check.py fixtures`` result on a natural-video plate, recorded
    next to the synthetic baseline."""
    p_time = json.loads((browser / "p_time_jassub.json").read_text())
    p_txt = json.loads((browser / "p_txt.json").read_text())
    timing = json.loads((browser / "render_timing.json").read_text())
    chosen = decision["recommendation"]["format"]
    toolchain = decision.get("toolchain")
    browser_info = {"browser": p_time.get("browserVersion"), "jassub": p_time.get("jassub"),
                    "wasm": timing.get("wasm")}
    files: dict[str, dict] = {}
    clips = p_time["clips"]
    files["P-TIME"] = {
        "task": task, "gate": "P-TIME (JASSUB side)", "threshold": {"mismatches": 0},
        **browser_info,
        "clips": [{key: clip[key] for key in ("clip", "fps", "transitions", "hazard_transitions",
                                              "frames_rendered", "mismatches",
                                              "control_one_frame_late_mismatches")}
                  for clip in clips],
        "transitions": sum(c["transitions"] for c in clips),
        "hazard_transitions": sum(c["hazard_transitions"] for c in clips),
        "mismatches": sum(c["mismatches"] for c in clips),
        "pass": len(clips) == 5 and all(c["mismatches"] == 0 for c in clips),
    }
    files["P-TXT"] = {
        "task": task, "gate": "P-TXT", "thresholds": p_txt["thresholds"],
        "reference": "FFmpeg composite before 4:2:0, BT.709 to RGB", **browser_info,
        "toolchain": toolchain, "gate_format": chosen,
        "formats": {fmt: {"pass": entry["gate"]["pass"], "frames": entry["frames_scored"],
                          "failing_frames": len(entry["gate"]["failures"]),
                          "worst_gated": entry["worst_gated"],
                          "clips": {cid: _p_txt_clip(c) for cid, c in entry["clips"].items()}}
                    for fmt, entry in p_txt["formats"].items()},
        "pass": bool(chosen) and decision["candidates"][chosen]["p_txt_pass"],
    }
    p_enc = decision["p_enc"]
    files["P-ENC"] = {
        "task": task, "gate": "P-ENC (baseline)", "thresholds": p_enc["thresholds"],
        "domain": p_enc.get("domain"), "diagnostic": p_enc.get("diagnostic"),
        "baseline_tolerance": p_enc["baseline_tolerance"], "encode": R7_DESCRIPTION,
        "toolchain": toolchain, "baseline_format": chosen,
        "plate": "fit_blur of testsrc2 (synthetic, saturated)",
        "common_reference": p_enc.get("common_reference"),
        "formats": _p_enc_formats(p_enc, chosen),
        "natural_plate": ({"plate": "fit_blur of a real 640x360 BT.709 source (read only)",
                           "formats": _p_enc_formats(natural_p_enc, chosen)}
                          if natural_p_enc else None),
        "pass": bool(chosen) and decision["candidates"][chosen]["p_enc_pass"],
    }
    p_color = decision["p_color"]
    files["P-COLOR"] = {
        "task": task, "gate": "P-COLOR", "threshold": {"max_abs_mean_delta": p_color["max_abs_delta"]},
        "compared": "delivered MP4 (decoded as BT.709) minus JASSUB composite, interior fills",
        **browser_info, "toolchain": toolchain,
        "formats": {fmt: {"pass": entry["gate"]["pass"],
                          "worst_max_abs_mean_delta": entry["worst_max_abs_mean_delta"],
                          "colors": {name: {"rgb": c["rgb"], "pixels": c["pixels"],
                                            "delivered_mean_delta": c["delivered_mean_delta"],
                                            "max_abs_mean_delta": c["max_abs_mean_delta"],
                                            "reference_mean_delta": c["reference_mean_delta"],
                                            "pass": c["pass"]}
                                     for name, c in entry["colors"].items()}}
                    for fmt, entry in p_color["formats"].items()},
        "pass": bool(chosen) and decision["candidates"][chosen]["p_color_pass"],
    }
    changed = [f["libassMs"] for f in timing["frames"]]
    files["S-COLOR"] = {
        "task": task, "spike": "S-COLOR", "decision": decision["decision"],
        "recommendation": decision["recommendation"],
        "pack_variants": decision["pack_variants"],
        "candidates": {fmt: {key: value for key, value in c.items() if key != "pack_variants"}
                       for fmt, c in decision["candidates"].items()},
        "cost": {key: decision["cost"][key] for key in ("size", "seconds", "fps", "layout", "runs",
                                                         "threads", "times_s", "best_s",
                                                         "relative_to_yuv420p",
                                                         "speed_x_realtime")},
        "ass_color_matrix_probe": ({name: {"worst_max_abs": v["worst_max_abs"],
                                           "deltas": {k: s["delta"] for k, s in
                                                      v["swatches"].items()}}
                                    for name, v in matrix["variants"].items()}
                                   if matrix else None),
        "jassub_libass_ms_probe_frames": {"frames": len(changed), "p50": _percentile(changed, 0.5),
                                          "p95": _percentile(changed, 0.95),
                                          "max": max(changed)},
        **browser_info, "toolchain": toolchain,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for gate, content in files.items():
        path = out_dir / f"{task}-{gate}.json"
        path.write_text(json.dumps(_rounded(content), indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
        written.append(path)
    return written


def _finite(value: object) -> object:
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf"
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Spike S-COLOR.")
    commands = parser.add_subparsers(dest="command", required=True)
    cost = commands.add_parser("cost")
    cost.add_argument("--out", type=Path, required=True)
    cost.add_argument("--fonts", type=Path, required=True)
    cost.add_argument("--seconds", type=int, default=30)
    cost.add_argument("--runs", type=int, default=3)
    cost.add_argument("--layout", default="fit_blur", choices=LAYOUTS)
    cost.add_argument("--ffmpeg", default="ffmpeg")
    probe = commands.add_parser("matrix-probe")
    probe.add_argument("--out", type=Path, required=True)
    probe.add_argument("--fonts", type=Path, required=True)
    probe.add_argument("--ffmpeg", default="ffmpeg")
    evidence = commands.add_parser("evidence")
    evidence.add_argument("--decision", type=Path, required=True)
    evidence.add_argument("--browser", type=Path, required=True)
    evidence.add_argument("--matrix", type=Path)
    evidence.add_argument("--p-enc-natural", type=Path)
    evidence.add_argument("--out-dir", type=Path, required=True)
    evidence.add_argument("--task", default="T1.2b", help="evidence file prefix")
    both = commands.add_parser("decide")
    both.add_argument("--fixtures", type=Path, required=True)
    both.add_argument("--browser", type=Path, required=True)
    both.add_argument("--cost", type=Path, required=True)
    both.add_argument("--p-txt", type=Path)
    both.add_argument("--p-enc", type=Path)
    both.add_argument("--out", type=Path, required=True)
    both.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args(argv)

    def log(line: str) -> None:
        print(line, file=sys.stderr, flush=True)

    if args.command == "cost":
        result = measure_cost(args.out, fonts_dir=args.fonts, seconds=args.seconds,
                              runs=args.runs, layout=args.layout, ffmpeg=args.ffmpeg, log=log)
        print(json.dumps({"best_s": result["best_s"],
                          "relative_to_yuv420p": result["relative_to_yuv420p"]}, indent=2))
        return 0
    if args.command == "evidence":
        written = write_evidence(decision=json.loads(args.decision.read_text()),
                                 browser=args.browser,
                                 matrix=json.loads(args.matrix.read_text()) if args.matrix else None,
                                 natural_p_enc=(json.loads(args.p_enc_natural.read_text())
                                                if args.p_enc_natural else None),
                                 out_dir=args.out_dir, task=args.task)
        print("\n".join(str(path) for path in written))
        return 0
    if args.command == "matrix-probe":
        result = matrix_probe(fonts_dir=args.fonts, ffmpeg=args.ffmpeg)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps({name: v["worst_max_abs"] for name, v in result["variants"].items()}))
        return 0
    p_txt = json.loads(args.p_txt.read_text()) if args.p_txt else None
    p_enc = json.loads(args.p_enc.read_text()) if args.p_enc else None
    result = decide_from_files(args.fixtures, args.browser,
                               cost=json.loads(args.cost.read_text()), p_txt=p_txt, p_enc=p_enc,
                               ffmpeg=args.ffmpeg, log=log)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(_finite(result), indent=2, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(json.dumps(_finite({"decision": result["decision"],
                              "recommendation": result["recommendation"],
                              "pack_variants": result["pack_variants"]}), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
