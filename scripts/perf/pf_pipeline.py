#!/usr/bin/env python3
"""PF-PIPELINE (plan §10.3; T4.3): the V3 rendering stage with the new engine vs legacy, per job.

Run it in the pinned image with the worktree's ``src`` on ``PYTHONPATH`` (FFmpeg 5.1.9), on a
work directory prepared by ``scripts/parity/look_report.py prepare`` (copies of the owner's
jobs; the originals are only read):

1. ``run --work WORK --round NAME [--job ID …]``: per job, the legacy engine and then the new
   one (interleaved, so both see the same machine), each through ``pipeline.render_v3_job`` in
   a fresh copy (``look_report.render``: labels ``NAME-legacy`` and ``NAME-new``). Per job the
   wall seconds, the CPU seconds of every child process and of this process, and the load.
2. ``check --work WORK --round NAME --same-as RUN [--prune]``: the byte check of a round:
   every MP4 and SRT of its new run equals the one in ``RUN`` (the speed-up must not change the
   delivered file; ``RUN`` is a render of the same clips by the code before it), kept in
   ``NAME-new/same.json``; ``--prune`` then removes the round's rendered jobs (disk).
3. ``evidence --work WORK --round NAME … --out FILE [--before NAME]``: per job the median ratio
   new/legacy over the rounds, per layout the worst job against its budget (fit-blur and
   center-crop ≤ 1.35×, face-track ≤ 1.6×), and each round's byte check; ``--before`` adds the
   ratios of a round rendered by the code before the change (no byte check).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import shutil
import statistics
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "scripts" / "parity"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

BUDGET = {"fit_blur": 1.35, "fill_center": 1.35, "camera": 1.6}
LAYOUT_OF = {"fit-blur": "fit_blur", "center-crop": "fill_center", "face-track": "camera"}


def _cpu() -> tuple[float, float]:
    children = resource.getrusage(resource.RUSAGE_CHILDREN)
    own = resource.getrusage(resource.RUSAGE_SELF)
    return (children.ru_utime + children.ru_stime, own.ru_utime + own.ru_stime)


def _render(work: Path, engine: str, label: str, job: str) -> dict[str, Any]:
    import look_report

    before = _cpu()
    started = time.monotonic()
    report = look_report.render(work, engine, label, [job])
    wall = time.monotonic() - started
    after = _cpu()
    entry = next(item for item in report["jobs"] if item["id"] == job)
    cpu = {"children_s": round(after[0] - before[0], 1), "self_s": round(after[1] - before[1], 1)}
    path = work / "runs" / label / "cpu.json"
    cpus = json.loads(path.read_text()) if path.exists() else {}
    cpus[job] = {**cpu, "wall_s": round(wall, 3)}
    path.write_text(json.dumps(cpus, indent=1, sort_keys=True) + "\n")
    return entry


def run(work: Path, round_name: str, jobs: list[str] | None) -> None:
    selection = json.loads((work / "selection.json").read_text())
    for job in selection["jobs"]:
        if jobs and job["id"] not in jobs:
            continue
        for engine, suffix in (("legacy", "legacy"), ("edit-v2", "new")):
            entry = _render(work, engine, f"{round_name}-{suffix}", job["id"])
            print(json.dumps({"round": round_name, "job": job["id"][:8], "engine": engine,
                              "seconds": entry["seconds"],
                              "load": entry["loadavg_before"]}), flush=True)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _same_files(work: Path, label: str, reference: str) -> dict[str, int]:
    checked = same = 0
    for job in sorted((work / "runs" / label / "jobs").iterdir()):
        for clip in sorted((job / "output").glob("clip-*.mp4")):
            twin = work / "runs" / reference / "jobs" / job.name / "output" / clip.name
            if not twin.exists():
                continue
            checked += 1
            same += all(_sha(clip.with_suffix(s)) == _sha(twin.with_suffix(s))
                        for s in (".mp4", ".srt"))
    return {"clips": checked, "identical": same}


def check(work: Path, round_name: str, same_as: str, prune: bool) -> dict[str, Any]:
    result = {**_same_files(work, f"{round_name}-new", same_as), "reference": same_as}
    (work / "runs" / f"{round_name}-new" / "same.json").write_text(json.dumps(result) + "\n")
    if prune:
        for side in ("legacy", "new"):
            shutil.rmtree(work / "runs" / f"{round_name}-{side}" / "jobs", ignore_errors=True)
    return result


def _ratios(work: Path, name: str) -> dict[str, Any]:
    legacy = json.loads((work / "runs" / f"{name}-legacy" / "render.json").read_text())
    new = json.loads((work / "runs" / f"{name}-new" / "render.json").read_text())
    rows = {}
    for entry in new["jobs"]:
        twin = next((item for item in legacy["jobs"] if item["id"] == entry["id"]), None)
        if twin is not None:
            rows[entry["id"][:8]] = {"legacy_s": twin["seconds"], "new_s": entry["seconds"],
                                     "ratio": round(entry["seconds"] / twin["seconds"], 3)}
    return rows


def evidence(work: Path, rounds: list[str], before: str | None = None) -> dict[str, Any]:
    selection = {job["id"]: job for job in json.loads((work / "selection.json").read_text())["jobs"]}
    per_job: dict[str, dict[str, Any]] = {}
    for name in rounds:
        legacy = json.loads((work / "runs" / f"{name}-legacy" / "render.json").read_text())
        new = json.loads((work / "runs" / f"{name}-new" / "render.json").read_text())
        cpu_paths = [work / "runs" / f"{name}-{side}" / "cpu.json" for side in ("legacy", "new")]
        cpus = [json.loads(path.read_text()) if path.exists() else {} for path in cpu_paths]
        environment = new.get("environment", {})
        for entry in new["jobs"]:
            twin = next((item for item in legacy["jobs"] if item["id"] == entry["id"]), None)
            if twin is None:
                continue
            row = per_job.setdefault(entry["id"], {"rounds": []})
            row["rounds"].append({
                "round": name, "legacy_s": twin["seconds"], "new_s": entry["seconds"],
                "ratio": round(entry["seconds"] / twin["seconds"], 3),
                "load_legacy": twin["loadavg_before"], "load_new": entry["loadavg_before"],
                "cpu_legacy_s": cpus[0].get(entry["id"]), "cpu_new_s": cpus[1].get(entry["id"]),
                "warnings": entry["warnings"],
                "engines": sorted(set(entry["engines"].values())),
            })
    jobs = []
    for job_id, row in per_job.items():
        info = selection[job_id]
        layout = LAYOUT_OF[info["render_mode"]]
        ratio = statistics.median(item["ratio"] for item in row["rounds"])
        jobs.append({"job": job_id[:8], "layout": layout, "clips": len(info["ranks"]),
                     "source_fps": info["source"].get("r_frame_rate"),
                     "budget": BUDGET[layout], "median_ratio": round(ratio, 3),
                     "pass": ratio <= BUDGET[layout], "rounds": row["rounds"]})
    layouts: dict[str, Any] = {}
    for item in jobs:
        layout = layouts.setdefault(item["layout"], {"budget": item["budget"], "jobs": 0,
                                                     "jobs_pass": 0, "worst_ratio": 0.0})
        layout["jobs"] += 1
        layout["jobs_pass"] += item["pass"]
        layout["worst_ratio"] = max(layout["worst_ratio"], item["median_ratio"])
    for layout in layouts.values():
        layout["pass"] = layout["jobs_pass"] == layout["jobs"]
    result: dict[str, Any] = {
        "gate": "PF-PIPELINE", "task": "T4.3", "budget": BUDGET, "rounds": rounds,
        "environment": environment, "jobs": jobs, "layouts": layouts,
        "pass": all(layout["pass"] for layout in layouts.values()),
    }
    same = {}
    for name in rounds:
        path = work / "runs" / f"{name}-new" / "same.json"
        same[name] = json.loads(path.read_text()) if path.exists() else None
    result["same_files"] = same
    if before is not None:
        result["before"] = {"round": before, "jobs": _ratios(work, before)}
    result["pass"] = result["pass"] and all(
        item is not None and item["clips"] > 0 and item["clips"] == item["identical"]
        for item in same.values())
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("run")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--round", required=True)
    cmd.add_argument("--job", action="append", default=None)
    cmd = commands.add_parser("check")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--round", required=True)
    cmd.add_argument("--same-as", required=True)
    cmd.add_argument("--prune", action="store_true")
    cmd = commands.add_parser("evidence")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--round", action="append", required=True)
    cmd.add_argument("--note", default=None)
    cmd.add_argument("--before", default=None)
    cmd.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "run":
        run(args.work, args.round, args.job)
        return 0
    if args.command == "check":
        checked = check(args.work, args.round, args.same_as, args.prune)
        print(json.dumps(checked))
        return 0 if checked["clips"] and checked["clips"] == checked["identical"] else 1
    result = evidence(args.work, args.round, args.before)
    if args.note:
        result["note"] = args.note
    result["host_loadavg_at_report"] = list(os.getloadavg())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"pass": result["pass"], "layouts": result["layouts"],
                      "same_files": result.get("same_files")}, indent=1))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
