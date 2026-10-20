#!/usr/bin/env python3
"""T1.5 camera-plan budget on real sources: a 3 min window in ≤ 15 s (read-only inputs).

For each source, the camera plan of the 180 s window around the middle is built with today's
detector (``face_window.detect_window``: the window decoded once, YuNet faces and the speaking
face; the legacy render goes through the same scan). Until 2026-10 this script also timed the
Haar detector's per-sample seeks; ``scripts/eval/speaker_framing.py time`` compares the two
detectors now. The source files are only read; the evidence holds numbers and the first 8
characters of each job directory name.

    docker run --rm --cpus 4 --user 1000:1000 -v "$PWD":/w -v "$JOBS":/jobs:ro -w /w \\
        -e PYTHONPATH=/w/tests -e HOME=/tmp ai-video-clipper:editor-w1z \\
        /app/.venv/bin/python scripts/parity/camera_real.py --jobs /jobs --out OUT.json JOB …

Stdlib only (plus the image's OpenCV through ``ai_clipper.face_window``).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path

from ai_clipper.edit_v2.camera import build_camera_plan
from ai_clipper.edit_v2.timemap import Fps

BUDGET_S = 15.0
WINDOW_MS = 180_000


def measure(source: Path) -> dict:
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of",
         "json", str(source)], capture_output=True, text=True, check=True).stdout)
    duration_ms = int(float(probe["format"]["duration"]) * 1000)
    start = max(0, duration_ms // 2 - WINDOW_MS // 2)
    window = (start, min(duration_ms, start + WINDOW_MS))
    stream = probe["streams"][0]
    result = {"codec": stream["codec_name"], "size": [stream["width"], stream["height"]],
              "rate": stream["r_frame_rate"], "window_ms": list(window)}
    load = os.getloadavg()
    began = time.monotonic()
    plan = build_camera_plan(source, window, Fps(30, 1), out_w=720, out_h=1280)
    result["window_detector"] = {"seconds": round(time.monotonic() - began, 2),
                                 "samples": len(plan["samples"]),
                                 "no_face_spans": len(plan["no_face"]),
                                 "load_before": [round(value, 2) for value in load]}
    result["pass"] = result["window_detector"]["seconds"] <= BUDGET_S
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--jobs", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("job", nargs="+")
    args = parser.parse_args(argv)
    sources = {}
    for name in args.job:
        entry = measure(args.jobs / name / "input" / "source.mp4")
        sources[name[:8]] = entry
        print(json.dumps({name[:8]: entry}), flush=True)
    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    evidence = {"gate": "T1.5 camera plan, 3 min window, real sources (read only)",
                "task": "T1.Z", "budget_s": BUDGET_S, "window_ms": WINDOW_MS,
                "detector": "face_window.detect_window (YuNet, speaking face), 0.75 s samples",
                "sources": sources, "pass": all(entry["pass"] for entry in sources.values()),
                "toolchain": {"ffmpeg": first[0] if first else None,
                              "python": platform.python_version(),
                              "cpus": len(os.sched_getaffinity(0))}}
    args.out.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0 if evidence["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
