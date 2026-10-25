#!/usr/bin/env python3
"""The graph spike of the automatic layout (rombak 04 §A7, CONTRACTS §5.63).

Two questions, answered on synthetic sources (1080p and 720p, 30 fps) with 1, 8 and 48 runs of
modes:

1. **Without split (A7.1).** One fallback chain with per-frame switches draws every range's
   mode. Every frame must be md5-identical (lossless yuv444p frames, ``framemd5``) to the pure
   chain of its mode over the same frames: face-track's camera chain, latar blur's chain and
   the centre crop's chain. The last one settles open item #18 of the plan: whether a
   ``fill_center`` frame drawn as a camera crop at ``centre_x`` is the centre crop's frame. The
   number of filter contexts must not grow from 1 to 48 runs.
2. **With split (A7.2, candidate K1 overlay).** ``split=2``: one branch is the fallback chain,
   the other a split chain whose crops follow the range per frame; ``overlay`` with an
   ``enable`` of the split frames puts the split on top. It passes when every frame matches its
   pure chain, the contexts stay constant, the render runs under the 3 GiB address-space limit
   of a render (``prlimit --as``) with a peak RSS below 3 GiB at 48 runs, and it takes at most
   1.15× the fallback chain's time. K2 (streamselect) and K3 (maskedmerge) are only needed if
   K1 fails; this script reports K1.

The result is JSON on stdout (``--out`` also writes it). ``AUTO_SPLIT`` in
``src/ai_clipper/edit_v2/__init__.py`` is set to ``True`` only after a passing run, recorded in
``docs/editor/SPIKES.md`` ("Graf Otomatis"). FFmpeg measurements run on GitHub Actions::

    gh workflow run editor-gates.yml -f ref=<branch> -f suite=command \\
        -f command='uv run python scripts/parity/auto_graph_spike.py --out /out/auto-spike.json'
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ai_clipper.edit_v2 import layouts
from ai_clipper.edit_v2.timemap import Fps

FPS = Fps(30, 1)
OUTPUT = (720, 1280)
RLIMIT_AS = 3 << 30  # execute.RLIMIT_AS_BYTES, R8
RUN_COUNTS = (1, 8, 48)
SIZES = {"1080p": (1920, 1080), "720p": (1280, 720)}
TIME_BUDGET = 1.15
MODES = ("camera", "fill_center", "fit_blur")


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise SystemExit(f"{name} is needed")
    return path


def make_source(path: Path, size: tuple[int, int], seconds: int) -> Path:
    """A moving test picture: every frame differs, so a wrong crop or blur shows in its md5."""
    width, height = size
    subprocess.run(
        [_tool("ffmpeg"), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i",
         f"testsrc2=size={width}x{height}:rate={FPS.num}/{FPS.den}:duration={seconds}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
         "-g", "30", str(path)], check=True, timeout=600)
    return path


def camera_plan(size: tuple[int, int], frames: int) -> dict[str, Any]:
    """A camera plan whose face sweeps left and right, one sample per 0.75 s."""
    duration_ms = frames * 1000 * FPS.den // FPS.num
    samples = []
    t = 0
    step = 0
    while t < duration_ms:
        centre = 200 + (step * 137) % 600
        samples.append([t, centre])
        t += 750
        step += 1
    return {"samples": samples, "cuts": [False] * len(samples), "no_face": [],
            "source": {"w": size[0], "h": size[1]}}


def run_modes(frames: int, runs: int, modes: Sequence[str]) -> list[str]:
    """The mode of each frame: ``runs`` runs of equal length, ``modes`` in turn."""
    edges = [frames * k // runs for k in range(runs + 1)]
    out: list[str] = []
    for k in range(runs):
        out += [modes[k % len(modes)]] * (edges[k + 1] - edges[k])
    return out


def split_crops(frames: int, runs: int) -> list[dict[str, Any]]:
    """Per frame, the split crops of its run (they move from run to run)."""
    edges = [frames * k // runs for k in range(runs + 1)]
    out = []
    for k in range(runs):
        place = {"top_pm": 500,
                 "top": {"x_e5": (k * 23_000) % 100_001, "y_e5": 40_000, "zoom_pm": 1000},
                 "bottom": {"x_e5": 100_000 - (k * 23_000) % 100_001, "y_e5": 60_000,
                            "zoom_pm": 1000}}
        out += [place] * (edges[k + 1] - edges[k])
    return out


CHAIN = {"suffix": "_0", "output": OUTPUT, "matrix": "bt709", "in_range": "tv"}


def fallback_chain(modes: Sequence[str], camera_x: Sequence[int], size: tuple[int, int],
                   label_in: str, label_out: str) -> str:
    centre = layouts.centre_x(size, OUTPUT)
    crop = [x if mode == "camera" else centre for mode, x in zip(modes, camera_x, strict=True)]
    fallback = [mode == "fit_blur" for mode in modes]
    return layouts.layout_chain("camera", label_in=label_in, label_out=label_out, source=size,
                                crop=crop, fallback=fallback, **CHAIN)


def pure_chain(mode: str, camera_x: Sequence[int], size: tuple[int, int]) -> str:
    return layouts.layout_chain(mode, label_in="[vcat]", label_out="[vout]", source=size,
                                crop=list(camera_x) if mode == "camera" else None, **CHAIN)


def _expr(values: Sequence[int]) -> str:
    return layouts.crop_expression(values)


def split_frame_chain(crops: Sequence[dict[str, Any]], size: tuple[int, int], label_in: str,
                      label_out: str) -> str:
    """The split chain with each band's crop x/y per frame (``if(lt(n,K))`` like the camera
    crop); the crop size is the same in every run (zoom 1000, one ``top_pm`` per clip)."""
    geometries = [layouts.split_geometry(c, source=size, output=OUTPUT) for c in crops]
    first = geometries[0]
    conversion = (f"in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv,"
                  f"format={layouts.WORKING_FORMAT}")
    parts = []
    for band in ("top", "bottom"):
        _x, _y, w, h = first[band]["crop"]
        xs = _expr([g[band]["crop"][0] for g in geometries])
        ys = _expr([g[band]["crop"][1] for g in geometries])
        band_w, band_h = first[band]["size"]
        parts.append(f"[st_{band}]crop={w}:{h}:x='{xs}':y='{ys}',"
                     f"scale={band_w}:{band_h}:{conversion}")
    width = OUTPUT[0]
    return (f"{label_in}split=2[st_top][st_bottom];"
            f"{parts[0]},pad={width}:{first['line'] + 1}:0:0:black[sp_a];"
            f"{parts[1]}[sp_b];[sp_a][sp_b]vstack=inputs=2,setsar=1{label_out}")


def k1_chain(modes: Sequence[str], camera_x: Sequence[int], crops: Sequence[dict[str, Any]],
             size: tuple[int, int]) -> str:
    """K1: the fallback chain under an overlay of the split chain, enabled on split frames."""
    base_modes = ["camera" if mode == "split" else mode for mode in modes]
    enabled = _expr([int(mode == "split") for mode in modes])
    return (f"[vcat]split=2[k1a][k1b];"
            f"{fallback_chain(base_modes, camera_x, size, '[k1a]', '[k1A]')};"
            f"{split_frame_chain(crops, size, '[k1b]', '[k1B]')};"
            f"[k1A][k1B]overlay=0:0:format=yuv444:enable='{enabled}'[vout]")


def contexts(graph: str) -> int:
    bare = re.sub(r"'[^']*'", "''", graph)
    return sum(len([f for f in chain.split(",") if f]) for chain in bare.split(";"))


def render(source: Path, layout: str, work: Path, name: str) -> dict[str, Any]:
    """Lossless yuv444p frames of ``layout`` (from ``[vcat]`` to ``[vout]``) as md5s, with the
    render's wall time and peak RSS under the render's address-space limit."""
    graph = f"[0:v]fps={FPS.num}/{FPS.den},setpts=PTS-STARTPTS[vcat];{layout}"
    script = work / f"{name}.graph"
    script.write_text(graph, encoding="utf-8")
    out = work / f"{name}.md5"
    argv = [_tool("prlimit"), f"--as={RLIMIT_AS}:{RLIMIT_AS}", "--", _tool("ffmpeg"),
            "-nostdin", "-v", "error", "-y", "-threads", "4", "-i", str(source),
            "-filter_complex_script", str(script), "-map", "[vout]", "-c:v", "rawvideo",
            "-pix_fmt", "yuv444p", "-f", "framemd5", str(out)]
    began = time.perf_counter()
    process = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    _pid, status, usage = os.wait4(process.pid, 0)
    seconds = time.perf_counter() - began
    stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
    process.returncode = os.waitstatus_to_exitcode(status)
    md5s = []
    if process.returncode == 0:
        for line in out.read_text(encoding="utf-8").splitlines():
            if line and not line.startswith("#"):
                md5s.append(line.rsplit(",", 1)[1].strip())
    return {"ok": process.returncode == 0, "error": stderr.strip()[-300:], "md5": md5s,
            "seconds": round(seconds, 3), "max_rss_bytes": usage.ru_maxrss * 1024,
            "contexts": contexts(layout)}


def compare(modes: Sequence[str], result: dict[str, Any], pure: dict[str, dict[str, Any]]
            ) -> int:
    """Frames whose md5 is not their mode's pure chain's."""
    if not result["ok"]:
        return len(modes)
    wrong = 0
    for n, mode in enumerate(modes):
        reference = pure[mode]["md5"]
        if n >= len(result["md5"]) or n >= len(reference) or result["md5"][n] != reference[n]:
            wrong += 1
    return wrong


def spike(size_name: str, size: tuple[int, int], seconds: int, run_counts: Sequence[int],
          work: Path) -> dict[str, Any]:
    source = make_source(work / f"{size_name}.mp4", size, seconds)
    frames = seconds * FPS.num // FPS.den
    plan = camera_plan(size, frames)
    camera_x = layouts.crop_positions(plan, FPS, source=size, output=OUTPUT, first_sf=0,
                                      count=frames)
    pure = {mode: render(source, pure_chain(mode, camera_x, size), work, f"{size_name}-{mode}")
            for mode in MODES}
    report: dict[str, Any] = {"frames": frames, "pure": {
        mode: {k: v for k, v in result.items() if k != "md5"} for mode, result in pure.items()},
        "without_split": {}, "k1_overlay": {}}
    for runs in run_counts:
        modes = run_modes(frames, runs, MODES)
        result = render(source, fallback_chain(modes, camera_x, size, "[vcat]", "[vout]"),
                        work, f"{size_name}-a71-{runs}")
        report["without_split"][str(runs)] = {
            **{k: v for k, v in result.items() if k != "md5"},
            "mismatched_frames": compare(modes, result, pure),
            "fill_center_frames": modes.count("fill_center")}
        split_modes = run_modes(frames, runs, ("camera", "split", "fill_center", "fit_blur"))
        crops = split_crops(frames, runs)
        k1 = render(source, k1_chain(split_modes, camera_x, crops, size), work,
                    f"{size_name}-k1-{runs}")
        mismatched = 0
        if k1["ok"]:
            references: dict[str, list[str]] = {}
            for index, mode in enumerate(split_modes):
                if mode != "split":
                    reference = pure[mode]["md5"]
                else:
                    key = json.dumps(crops[index], sort_keys=True)
                    if key not in references:
                        chain = layouts.split_chain(crops[index], label_in="[vcat]",
                                                    label_out="[vout]", source=size, **CHAIN)
                        references[key] = render(source, chain, work,
                                                 f"{size_name}-split-{len(references)}")["md5"]
                    reference = references[key]
                if index >= len(k1["md5"]) or index >= len(reference) or \
                        k1["md5"][index] != reference[index]:
                    mismatched += 1
        else:
            mismatched = frames
        base = render(source, fallback_chain(
            ["camera" if m == "split" else m for m in split_modes], camera_x, size, "[vcat]",
            "[vout]"), work, f"{size_name}-k1base-{runs}")
        report["k1_overlay"][str(runs)] = {
            **{k: v for k, v in k1.items() if k != "md5"}, "mismatched_frames": mismatched,
            "time_vs_fallback": round(k1["seconds"] / base["seconds"], 3)
            if base["seconds"] else None}
    return report


def verdict(reports: dict[str, Any], run_counts: Sequence[int]) -> dict[str, Any]:
    def constant(block: str) -> bool:
        return all(len({r[block][str(n)]["contexts"] for n in run_counts if n > 1}) == 1
                   for r in reports.values())

    without = all(r["without_split"][str(n)]["mismatched_frames"] == 0
                  for r in reports.values() for n in run_counts)
    biggest = str(max(run_counts))
    k1 = (all(r["k1_overlay"][str(n)]["mismatched_frames"] == 0
              for r in reports.values() for n in run_counts)
          and constant("k1_overlay")
          and all(r["k1_overlay"][biggest]["ok"]
                  and r["k1_overlay"][biggest]["max_rss_bytes"] < RLIMIT_AS
                  for r in reports.values())
          and all((r["k1_overlay"][str(n)]["time_vs_fallback"] or 99) <= TIME_BUDGET
                  for r in reports.values() for n in run_counts))
    return {"without_split_p_frame": without, "without_split_contexts_constant":
            constant("without_split"), "fill_center_equals_centre_crop": without,
            "k1_passes": k1, "auto_split": k1}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--seconds", type=int, default=20)
    parser.add_argument("--runs", type=int, action="append",
                        help="run counts (default 1, 8 and 48)")
    parser.add_argument("--size", choices=sorted(SIZES), action="append",
                        help="source sizes (default both)")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    run_counts = tuple(args.runs or RUN_COUNTS)
    sizes = args.size or list(SIZES)
    with tempfile.TemporaryDirectory(prefix="potongin-spike-") as tmp:
        work = Path(tmp)
        reports = {name: spike(name, SIZES[name], args.seconds, run_counts, work)
                   for name in sizes}
    result = {"schema": "potongin.auto-graph-spike/1", "fps": [FPS.num, FPS.den],
              "output": list(OUTPUT), "run_counts": list(run_counts), "sizes": sizes,
              "reports": reports, "verdict": verdict(reports, run_counts)}
    text = json.dumps(result, indent=1)
    print(text)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
