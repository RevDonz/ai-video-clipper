#!/usr/bin/env python3
"""PF-SIZE: the render cost of each output size of an automatic clip (CONTRACTS §5.54).

One clip of the synthetic V3 job (``scripts/editor_fixture/make_job.py``, clip 2: 36 s with the
hook and karaoke captions, no cold open) goes through the pipeline's rendering stage
(``pipeline.render_v3_job`` with the edit-v2 compiler) once per output size and layout, each in
a fresh copy of the job. Per render: the wall seconds of the stage (seed, plan, FFmpeg, poster),
the clip's duration and its file size, and the ratio of both to 720×1280 of the same layout.

Usage (from the repository root; the measurement runs at ``nice`` 10 by default)::

    PYTHONPATH=src:tests python scripts/perf/output_sizes.py --work DIR [--out FILE]
        [--source-size 1280x720] [--source FILE] [--layouts fit-blur,center-crop,face-track]
        [--sizes 720x1280,1080x1920,720x720,1080x1080] [--repeat 1] [--nice 10]

``--source FILE`` swaps the synthetic picture for a real video (at least as long as the
fixture's 180 s; its sound is kept, the captions stay the fixture's). Re-encode such a file with
``-af aresample=48000:async=1``: a stream-copied concat drifts its audio and the render fails
G2's sample count. A render that falls back to the legacy engine measures the wrong engine, so
the run then exits 1. Every rendered copy is removed after it is measured; only ``DIR/fixture``
stays.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests", ROOT / "scripts" / "editor_fixture"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

DEFAULT_SIZES = ((720, 1280), (1080, 1920), (720, 720), (1080, 1080))
DEFAULT_LAYOUTS = ("fit-blur", "center-crop", "face-track")
BASELINE = (720, 1280)


def _size(value: str) -> tuple[int, int]:
    width, _x, height = value.partition("x")
    return int(width), int(height)


def _ffmpeg_version() -> str:
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-version"], capture_output=True,
                             text=True, check=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return out.splitlines()[0] if out else "unknown"


def _duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True, check=True, timeout=60).stdout
    return round(float(out.strip()), 3)


def _copy_job(job_dir: Path, target: Path) -> None:
    """A fresh copy of the job; the source is hard-linked (disk), everything else copied."""
    def link_or_copy(src: str, dst: str) -> None:
        if Path(src).parent.name == "input":
            os.link(src, dst)
        else:
            shutil.copy2(src, dst)

    shutil.copytree(job_dir, target, copy_function=link_or_copy, symlinks=True)


def _swap_source(job_dir: Path, source: Path) -> None:
    job = json.loads((job_dir / "job.json").read_text(encoding="utf-8"))
    recorded = job_dir / "input" / Path(job["sourcePath"]).name
    recorded.unlink()
    shutil.copyfile(source, recorded)


def _set_layout(job_dir: Path, layout: str) -> None:
    path = job_dir / "job.json"
    job = json.loads(path.read_text(encoding="utf-8"))
    job["options"]["renderMode"] = layout
    path.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def measure(work: Path, *, source_size: tuple[int, int], source: Path | None,
            layouts: list[str], sizes: list[tuple[int, int]], repeat: int) -> dict[str, Any]:
    import make_job

    from ai_clipper import pipeline

    fixture = work / "fixture"
    index = make_job.build(fixture, size=source_size, only=["main"], force=True)
    job_dir = fixture / index["jobs"]["main"]["dir"]
    if source is not None:
        _swap_source(job_dir, source)
    runs: list[dict[str, Any]] = []
    rank = 2  # clip 2: no cold open, 25 s at the fixture's word timings
    for round_index in range(repeat):
        for layout in layouts:
            for width, height in sizes:  # interleaved, so every size sees the same machine
                # the job id is the directory's name (render_edit.job_id_for)
                run_dir = work / f"run-{round_index}-{layout}-{width}x{height}"
                if run_dir.exists():
                    shutil.rmtree(run_dir)
                target = run_dir / job_dir.name
                run_dir.mkdir()
                _copy_job(job_dir, target)
                _set_layout(target, layout)
                try:
                    started = time.monotonic()
                    run = pipeline.render_v3_job(target, render_engine="edit-v2", ranks=[rank],
                                                 width=width, height=height)
                    wall = time.monotonic() - started
                    clip = target / "output" / f"clip-{rank:02d}.mp4"
                    entry = run.clips[0]
                    runs.append({
                        "round": round_index, "layout": layout, "size": f"{width}x{height}",
                        "engine": entry.get("render_engine"), "stage_s": round(wall, 2),
                        "clip_s": round(run.timings.get(rank, wall), 2),
                        "duration_s": _duration(clip), "bytes": clip.stat().st_size,
                        "warnings": run.warnings,
                    })
                finally:
                    shutil.rmtree(run_dir, ignore_errors=True)
    summary: dict[str, Any] = {}
    for layout in layouts:
        rows = {}
        for width, height in sizes:
            label = f"{width}x{height}"
            mine = [run for run in runs if run["layout"] == layout and run["size"] == label]
            rows[label] = {"clip_s": round(statistics.median(r["clip_s"] for r in mine), 2),
                           "bytes": round(statistics.median(r["bytes"] for r in mine)),
                           "duration_s": mine[0]["duration_s"]}
        base = rows.get(f"{BASELINE[0]}x{BASELINE[1]}")
        for row in rows.values():
            row["realtime_x"] = round(row["clip_s"] / row["duration_s"], 3)
            if base:
                row["time_vs_720x1280"] = round(row["clip_s"] / base["clip_s"], 2)
                row["bytes_vs_720x1280"] = round(row["bytes"] / base["bytes"], 2)
        summary[layout] = rows
    return {
        "gate": "PF-SIZE", "schema": "potongin.pf-size/1",
        "machine": {"cpus": os.cpu_count(), "platform": platform.platform(),
                    "python": platform.python_version(), "ffmpeg": _ffmpeg_version(),
                    "nice": os.nice(0)},
        "source": {"kind": "file" if source else "synthetic", "size": list(source_size)},
        "runs": runs, "summary": summary,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--source-size", type=_size, default=(1280, 720))
    parser.add_argument("--source", type=Path, default=None)
    parser.add_argument("--layouts", default=",".join(DEFAULT_LAYOUTS))
    parser.add_argument("--sizes", default=",".join(f"{w}x{h}" for w, h in DEFAULT_SIZES))
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--nice", type=int, default=10)
    args = parser.parse_args(argv)
    if args.nice:
        os.nice(args.nice)
    args.work.mkdir(parents=True, exist_ok=True)
    result = measure(args.work.resolve(), source_size=args.source_size,
                     source=None if args.source is None else args.source.resolve(),
                     layouts=[name for name in args.layouts.split(",") if name],
                     sizes=[_size(item) for item in args.sizes.split(",") if item],
                     repeat=max(1, args.repeat))
    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    print(json.dumps(result["summary"], indent=2, sort_keys=True))
    fallback = [run for run in result["runs"] if run["engine"] != "edit-v2/1"]
    if fallback:  # a legacy fallback measures the wrong engine
        print(f"not rendered by edit-v2: {len(fallback)} of {len(result['runs'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
