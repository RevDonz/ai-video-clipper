#!/usr/bin/env python3
"""P-ENC: the delivered MP4 against the lossless reference of the same frames (plan §10.1).

The exported MP4 is decoded as tagged BT.709 (limited range) and compared, frame by frame, with
the lossless ``reference`` (the composite before the final 4:2:0 conversion, stored as RGB) using
FFmpeg's ``ssim`` filter on BT.709 limited-range 4:4:4 planes (the delivered chroma upsampled, so
the 4:2:0 loss is measured; RGB channels are reported as a diagnostic):

* **whole frame**: the mean over frames of FFmpeg's ``All`` value;
* **text regions**: the plan's caption/hook boxes, each snapped outwards to a 4-pixel grid
  (even, inside the frame), measured on the cropped pair; boxes are combined weighted by their
  number of 8×8 SSIM windows (``box_weight``).

Thresholds: whole frame ≥ 0.990, text regions ≥ 0.980. The W1 baseline is recorded; afterwards
a drop of more than 0.002 from the baseline fails (``p_enc_pass(metrics, baseline)``).

CLI::

    enc_check.py measure DELIVERED.mp4 REFERENCE.mkv [--box x0,y0,x1,y1 ...] [--reference-rgb]
    enc_check.py fixtures --fixtures DIR --out OUT.json [--baseline BASELINE.json]

``fixtures`` measures every export of a ``reference_text.py`` fixture directory (each clip and
S-COLOR candidate) with the clip's text region as the box. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Sequence
from pathlib import Path

P_ENC_THRESHOLDS = {"ssim_all": 0.990, "ssim_text": 0.980}
BASELINE_TOLERANCE = 0.002
# The gate is scored on BT.709 limited-range 4:4:4 planes (FFmpeg's ssim filter on Y, Cb, Cr;
# the delivered chroma is upsampled, so the 4:2:0 loss is part of the measurement); RGB (the
# channels a viewer's screen gets) is reported as a diagnostic.
DOMAINS = ("yuv444p", "rgb")
_FLAGS = "flags=accurate_rnd+full_chroma_int+bitexact"


def to_domain(domain: str, *, rgb: bool) -> str:
    """Filter chain that brings one input (BT.709 YUV, or RGB when ``rgb``) into ``domain``."""
    if domain == "yuv444p":
        source = "" if rgb else "in_color_matrix=bt709:in_range=tv:"
        return f"scale={source}out_color_matrix=bt709:out_range=tv:{_FLAGS},format=yuv444p"
    if domain == "rgb":
        return "format=gbrp" if rgb else f"scale=in_color_matrix=bt709:in_range=tv:{_FLAGS},format=gbrp"
    raise ValueError(f"unknown domain {domain!r}")
_FRAME = re.compile(r"^n:(\d+)\s+(.*)$")
_VALUE = re.compile(r"([A-Za-z]+):([0-9.]+|inf)")


def parse_ssim_stats(text: str) -> list[dict]:
    """Per-frame values of an FFmpeg ``ssim`` stats file (keys lower-cased: y/u/v or r/g/b, all)."""
    frames = []
    for line in text.splitlines():
        match = _FRAME.match(line.strip())
        if not match:
            continue
        entry: dict = {"n": int(match.group(1))}
        for key, value in _VALUE.findall(match.group(2)):
            entry[key.lower()] = float(value)
        if "all" not in entry:
            raise ValueError(f"ssim stats line without All: {line!r}")
        frames.append(entry)
    if not frames:
        raise ValueError("no ssim stats found")
    return frames


def box_weight(box: Sequence[int]) -> int:
    """Number of FFmpeg SSIM windows (8×8 on a 4-pixel grid) in a box: (w/4 − 1)·(h/4 − 1)."""
    x0, y0, x1, y1 = box
    return max(0, (x1 - x0) // 4 - 1) * max(0, (y1 - y0) // 4 - 1)


def combine(values: Iterable[tuple[float, int]]) -> float | None:
    """Window-weighted mean of ``(ssim, weight)`` pairs; ``None`` without any weight."""
    pairs = [(value, weight) for value, weight in values if weight > 0]
    total = sum(weight for _, weight in pairs)
    if total == 0:
        return None
    return sum(value * weight for value, weight in pairs) / total


def snap_box(box: Sequence[int], width: int, height: int) -> tuple[int, int, int, int]:
    """``box`` grown to the 4-pixel grid and clipped to the frame (an even crop for 4:2:0)."""
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        raise ValueError(f"empty box {tuple(box)}")
    x0, y0 = max(0, x0 // 4 * 4), max(0, y0 // 4 * 4)
    x1, y1 = min(width, -(-x1 // 4) * 4), min(height, -(-y1 // 4) * 4)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError(f"box {tuple(box)} is smaller than one SSIM window")
    return x0, y0, x1, y1


def p_enc_pass(metrics: dict, baseline: dict | None = None) -> bool:
    """Thresholds, and no drop of more than 0.002 from the recorded baseline."""
    for key, threshold in P_ENC_THRESHOLDS.items():
        if metrics[key] < threshold:
            return False
        if baseline is not None and baseline[key] - metrics[key] > BASELINE_TOLERANCE + 1e-12:
            return False
    return True


def _probe_size(path: Path, ffprobe: str) -> tuple[int, int]:
    result = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                             "stream=width,height", "-of", "json", str(path)],
                            capture_output=True, text=True, check=True)
    stream = json.loads(result.stdout)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def measure(delivered: Path, reference: Path, *, boxes: Sequence[Sequence[int]] = (),
            ffmpeg: str = "ffmpeg", domain: str = "yuv444p", reference_rgb: bool = False,
            threads: int = 4) -> dict:
    """SSIM of ``delivered`` (BT.709 YUV) against ``reference`` (BT.709 YUV, or RGB when
    ``reference_rgb``) in ``domain``, whole frame and over ``boxes``.

    Both inputs are renumbered (``setpts=N`` in one time base), so frames pair by index.
    """
    delivered_graph = to_domain(domain, rgb=False)
    reference_graph = to_domain(domain, rgb=reference_rgb)
    ffprobe = str(Path(ffmpeg).with_name("ffprobe")) if "/" in ffmpeg else "ffprobe"
    width, height = _probe_size(Path(reference), ffprobe)
    snapped = [snap_box(box, width, height) for box in boxes]
    count = 1 + len(snapped)
    parts = [f"[0:v]{delivered_graph},settb=1/1000,setpts=N,split={count}"
             + "".join(f"[d{i}]" for i in range(count)),
             f"[1:v]{reference_graph},settb=1/1000,setpts=N,split={count}"
             + "".join(f"[r{i}]" for i in range(count)),
             "[d0][r0]ssim=stats_file=ssim0.txt[o0]"]
    for index, (x0, y0, x1, y1) in enumerate(snapped, start=1):
        crop = f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0}"
        parts.append(f"[d{index}]{crop}[dc{index}];[r{index}]{crop}[rc{index}];"
                     f"[dc{index}][rc{index}]ssim=stats_file=ssim{index}.txt[o{index}]")
    outputs: list[str] = []
    for index in range(count):
        outputs += ["-map", f"[o{index}]", "-f", "null", "-"]
    with tempfile.TemporaryDirectory() as scratch:
        subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-threads",
                        str(threads), "-i", str(Path(delivered).resolve()), "-i",
                        str(Path(reference).resolve()), "-filter_complex_threads", str(threads),
                        "-filter_complex", ";".join(parts), *outputs],
                       cwd=scratch, check=True, capture_output=True, text=True, timeout=1800)
        stats = [parse_ssim_stats((Path(scratch) / f"ssim{i}.txt").read_text())
                 for i in range(count)]
    whole = [frame["all"] for frame in stats[0]]
    box_results = []
    for box, frames in zip(snapped, stats[1:], strict=True):
        values = [frame["all"] for frame in frames]
        entry = {"box": list(box), "windows": box_weight(box),
                 "ssim": sum(values) / len(values), "min_frame_ssim": min(values)}
        if domain == "yuv444p":
            entry["ssim_y"] = sum(frame["y"] for frame in frames) / len(frames)
        box_results.append(entry)
    result = {
        "domain": domain,
        "frames": len(whole),
        "ssim_all": sum(whole) / len(whole),
        "min_frame_ssim_all": min(whole),
        "ssim_text": combine((b["ssim"], b["windows"]) for b in box_results),
        "min_frame_ssim_text": min((b["min_frame_ssim"] for b in box_results), default=None),
        "boxes": box_results,
    }
    if domain == "yuv444p":
        result["ssim_y"] = sum(frame["y"] for frame in stats[0]) / len(stats[0])
        result["ssim_text_y"] = combine((b["ssim_y"], b["windows"]) for b in box_results)
    return result


def measure_fixtures(fixtures: Path, *, formats: Sequence[str] | None = None,
                     ffmpeg: str = "ffmpeg", baseline: dict | None = None,
                     rgb_diagnostic: bool = True, common: str = "gbrp") -> dict:
    """P-ENC for every export in a ``reference_text.py`` fixture directory.

    Each export is scored against its own candidate's lossless composite (the gate) and, when
    the fixtures have it, against the ``common`` candidate's composite (``vs_common``): a
    candidate's own reference already carries its compositing loss, so delivered quality is
    compared across candidates against the one composite that matches the preview.
    """
    manifest = json.loads((fixtures / "manifest.json").read_text(encoding="utf-8"))
    wanted = list(formats or manifest["formats"])
    result: dict = {"schema": "potongin.p-enc/1", "domain": "yuv444p", "diagnostic": "rgb",
                    "common_reference": common, "thresholds": P_ENC_THRESHOLDS,
                    "baseline_tolerance": BASELINE_TOLERANCE, "formats": {}}
    for fmt in wanted:
        clips: dict = {}
        pooled_all: list[tuple[float, int]] = []
        pooled_text: list[tuple[float, int]] = []
        pooled_common: list[tuple[float, int]] = []
        failures = []
        for clip in manifest["clips"]:
            files = clip.get("files", {})
            if fmt not in files.get("export", {}):
                continue
            metrics = measure(fixtures / files["export"][fmt], fixtures / files["lossless"][fmt],
                              boxes=[clip["text_region"]], ffmpeg=ffmpeg, reference_rgb=True)
            if rgb_diagnostic:
                rgb = measure(fixtures / files["export"][fmt], fixtures / files["lossless"][fmt],
                              boxes=[clip["text_region"]], ffmpeg=ffmpeg, reference_rgb=True,
                              domain="rgb")
                metrics["rgb"] = {"ssim_all": rgb["ssim_all"], "ssim_text": rgb["ssim_text"]}
            if common in files["lossless"]:
                if common == fmt:
                    versus = metrics
                else:
                    versus = measure(fixtures / files["export"][fmt],
                                     fixtures / files["lossless"][common],
                                     boxes=[clip["text_region"]], ffmpeg=ffmpeg,
                                     reference_rgb=True)
                metrics["vs_common"] = {key: versus[key] for key in
                                        ("ssim_all", "ssim_text", "ssim_y", "ssim_text_y")}
            base = (baseline or {}).get("formats", {}).get(fmt, {}).get("clips", {}).get(clip["id"])
            metrics["pass"] = p_enc_pass(metrics, base)
            clips[clip["id"]] = {"pack": clip["pack"], "variant": clip.get("variant"),
                                 "gate": clip.get("gate", True), **metrics}
            if clip.get("gate", True):
                pooled_all.append((metrics["ssim_all"], metrics["frames"]))
                pooled_text.append((metrics["ssim_text"], metrics["frames"]))
                if "vs_common" in metrics:
                    pooled_common.append((metrics["vs_common"]["ssim_text"], metrics["frames"]))
                if not metrics["pass"]:
                    failures.append({"clip": clip["id"], "ssim_all": metrics["ssim_all"],
                                     "ssim_text": metrics["ssim_text"]})
        gated = [c for c in clips.values() if c["gate"]]
        result["formats"][fmt] = {
            "clips": clips,
            "mean_ssim_all": combine(pooled_all),
            "mean_ssim_text": combine(pooled_text),
            "mean_ssim_text_vs_common": combine(pooled_common),
            "min_ssim_all": min((c["ssim_all"] for c in gated), default=None),
            "min_ssim_text": min((c["ssim_text"] for c in gated), default=None),
            "gate": {"pass": not failures and bool(gated), "failures": failures},
        }
    return result


def _parse_box(text: str) -> tuple[int, int, int, int]:
    parts = [int(part) for part in text.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("box is x0,y0,x1,y1")
    return parts[0], parts[1], parts[2], parts[3]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="P-ENC: delivered MP4 vs lossless reference.")
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("measure")
    one.add_argument("delivered", type=Path)
    one.add_argument("reference", type=Path)
    one.add_argument("--box", type=_parse_box, action="append", default=[])
    one.add_argument("--reference-rgb", action="store_true",
                     help="the reference is stored as RGB (gbrp/rgb24), not BT.709 YUV")
    one.add_argument("--domain", default="yuv444p", choices=DOMAINS)
    one.add_argument("--ffmpeg", default="ffmpeg")
    many = commands.add_parser("fixtures")
    many.add_argument("--fixtures", type=Path, required=True)
    many.add_argument("--out", type=Path, required=True)
    many.add_argument("--formats")
    many.add_argument("--baseline", type=Path)
    many.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args(argv)
    if args.command == "measure":
        result = measure(args.delivered, args.reference, boxes=args.box, ffmpeg=args.ffmpeg,
                         domain=args.domain, reference_rgb=args.reference_rgb)
        result["pass"] = p_enc_pass(result) if result["ssim_text"] is not None else None
        print(json.dumps(result, indent=2))
        return 0
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None
    result = measure_fixtures(args.fixtures, formats=args.formats.split(",") if args.formats
                              else None, ffmpeg=args.ffmpeg, baseline=baseline)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for fmt, entry in result["formats"].items():
        print(f"P-ENC {fmt}: pass={entry['gate']['pass']} min_all={entry['min_ssim_all']:.5f} "
              f"min_text={entry['min_ssim_text']:.5f} mean_text={entry['mean_ssim_text']:.5f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
