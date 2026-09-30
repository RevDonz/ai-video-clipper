#!/usr/bin/env python3
"""T3.7 gates on the owner's real jobs (plan §11.3 T3.7, §7.2, §10): exact markers and the
cold-open suggestions. The originals are only read: ``copy`` makes a scratch copy first.

Subcommands::

    copy SRC_JOBS DEST [--jobs id,…]    copy real jobs to DEST/jobs (rendered clips left out)
    prepare DEST                        seed.prepare_legacy_job on every copied job
    markers DEST EVIDENCE               Python markers of every clip for several documents vs
                                        the browser lane's model (node) → EVIDENCE JSON
    coldopen DEST EVIDENCE [--repeat N] the CLI as the route spawns it: candidates checked with
                                        doc.validate_doc, wall time → EVIDENCE JSON
    browser-data DEST OUT               per-clip data for web/e2e/editor-markers.spec.mjs
                                        (T37_REAL_DATA)

Run inside the pinned image for the toolchain of record, for example::

    docker run --rm --user 1000:1000 -v "$PWD":/w -v "$SCRATCH":/scratch -w /w \\
      -e PYTHONPATH=/w/src:/w/tests ai-video-clipper:editor-w3base \\
      /app/.venv/bin/python scripts/editor/t37_gates.py markers /scratch out.json
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import coldopen
from ai_clipper.edit_v2.doc import validate_doc

REAL_JOBS = ("e7f0d37b-6999-40a2-80b8-a09c8ff187ca", "899226f8-7e57-49d9-8c29-b078b2b91580",
             "860fef1a-8140-4677-8d73-729d18f15431", "3c7d024c-f1f5-45a6-b767-9f2c190b0c42",
             "990f3f37-f0a6-490a-a9a2-a6d6cdab004e")
TASK = "T3.7"


def _generator():
    name = "editor_gen_t37_fixtures"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / "editor"
                                                  / "gen_t37_fixtures.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _environment() -> dict[str, Any]:
    ffmpeg = shutil.which("ffmpeg")
    version = None
    if ffmpeg:
        version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True,
                                 check=False).stdout.split("\n", 1)[0]
    commit = os.environ.get("T37_COMMIT")  # a container cannot reach a worktree's git metadata
    if not commit:
        try:
            commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                                    text=True, check=True).stdout.strip() or None
        except (OSError, subprocess.CalledProcessError):
            commit = None
    return {"python": platform.python_version(), "ffmpeg": version, "cpus": os.cpu_count(),
            "loadavg": [round(value, 2) for value in os.getloadavg()], "commit": commit,
            "measured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


# --- copy and prepare ----------------------------------------------------------------------------


def copy_jobs(source: Path, dest: Path, jobs: Sequence[str]) -> list[str]:
    def ignore(directory: str, names: list[str]) -> set[str]:
        if Path(directory).name == "output":
            return {name for name in names if name.endswith((".mp4", ".jpg"))}
        return {"llm-cache"} & set(names)

    for job in jobs:
        target = dest / "jobs" / job
        if target.exists():
            continue
        shutil.copytree(source / job, target, ignore=ignore, symlinks=True)
    return list(jobs)


def prepare(dest: Path) -> dict[str, Any]:
    from ai_clipper.edit_v2 import seed

    out = {}
    for job in sorted((dest / "jobs").iterdir()):
        started = time.perf_counter()
        results = seed.prepare_legacy_job(job)
        out[job.name] = {"clips": results, "seconds": round(time.perf_counter() - started, 2)}
    return out


def _clips(dest: Path) -> list[dict[str, Any]]:
    """Every prepared clip: job, clip id, clip dir, seed, words and the words file."""
    clips = []
    for job in sorted((dest / "jobs").iterdir()):
        clips_dir = job / "analysis" / "clips"
        if not clips_dir.is_dir():
            continue
        for clip_dir in sorted(clips_dir.iterdir()):
            seed_path = clip_dir / "seed.json"
            if not seed_path.is_file():
                continue
            seed = json.loads(seed_path.read_text(encoding="utf-8"))
            sha = seed["base"]["words"]["sha256"]
            words_path = clip_dir / f"words.{sha[:16]}.json"
            clips.append({"job": job, "clip_id": clip_dir.name, "dir": clip_dir, "seed": seed,
                          "words": json.loads(words_path.read_text(encoding="utf-8")),
                          "words_path": words_path})
    return clips


# --- documents -----------------------------------------------------------------------------------


def _with_cold_open(seed: dict, candidate: coldopen.Candidate) -> dict:
    doc = copy.deepcopy(seed)
    doc["revision"] = 1
    doc["parent_sha256"] = fixtures.etag(seed)
    main = doc["main"]
    fade = main["joins"][0]["audio_fade_ms"] if main["joins"] else 30
    main["segments"] = [{"id": "seg_co", "role": "cold_open", "in_sf": candidate.in_sf,
                         "out_sf": candidate.out_sf}] + [s for s in main["segments"]
                                                          if s["role"] == "body"]
    main["removals"] = [r for r in main["removals"] if r["seg"] != "seg_co"]
    main["joins"] = [{"after": "seg_co", "style": "cut", "audio_fade_ms": fade}]
    return doc


def documents(clip: dict[str, Any]) -> list[tuple[str, dict]]:
    """The seed, cuts over events, a trim, cold opens (an event sentence and every candidate)."""
    gen = _generator()
    context = fixtures.Context(clip["clip_id"], clip["words"], clip["seed"], {})
    docs: list[tuple[str, dict]] = [("seed", clip["seed"])]
    for name, build in (("cuts", gen._cuts), ("trim", gen._trim), ("event_cold_open",
                                                                    gen._cold_open)):
        try:
            docs.append((name, build(context)))
        except (AssertionError, ValueError, KeyError, IndexError, StopIteration):
            continue
    units = coldopen.units_for_job(clip["job"], clip["words"])
    for candidate in coldopen.build_candidates(clip["seed"], clip["words"], units=units):
        doc = _with_cold_open(clip["seed"], candidate)
        if not validate_doc(doc, words=clip["words"], assets={}, seed=None).errors:
            docs.append((f"candidate_{candidate.id}", doc))
    return docs


# --- gates ---------------------------------------------------------------------------------------


def markers_gate(dest: Path, evidence: Path) -> dict[str, Any]:
    gen = _generator()
    cases = []
    by_kind: Counter[str] = Counter()
    for clip in _clips(dest):
        for name, doc in documents(clip):
            expected = gen.markers(clip["words"], doc)
            by_kind.update(f"{m['kind']}:{m['src']}" for m in expected)
            cases.append({"clip": f"{clip['job'].name[:8]}/{clip['clip_id']}", "name": name,
                          "words": str(clip["words_path"]), "doc": doc, "markers": expected})
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump({"cases": cases}, tmp)
    try:
        result = subprocess.run(["node", str(ROOT / "scripts" / "editor" / "t37_markers_check.mjs"),
                                 tmp.name], capture_output=True, text=True, check=True)
    finally:
        os.unlink(tmp.name)
    checked = json.loads(result.stdout)
    report = {
        "gate": "marker positions exact: browser lane model vs Python time map, real clips",
        "task": TASK, "threshold_frames": 0, "jobs": sorted({c["clip"][:8] for c in cases}),
        "clips": len({c["clip"] for c in cases}), "documents": checked["cases"],
        "markers_compared": checked["markers"], "by_kind": dict(sorted(by_kind.items())),
        "documents_by_name": dict(Counter(c["name"].split("_co_")[0] for c in cases)),
        "missing_analysis": dict(Counter(",".join(clip["words"]["missing"]) or "none"
                                         for clip in _clips(dest))),
        "frame_mismatches": len(checked["mismatches"]), "mismatches": checked["mismatches"][:20],
        "pass": not checked["mismatches"], **_environment(),
    }
    _write(evidence, report)
    return report


def _cli(dest: Path, job: str, clip_id: str) -> tuple[float, int, dict]:
    env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(dest / "jobs"),
           "LANG": "C.UTF-8", "PYTHONPATH": str(ROOT / "src")}
    envelope = json.dumps({"op": "list", "jobId": job, "clipId": clip_id}).encode()
    started = time.perf_counter()
    result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.coldopen"], input=envelope,
                            capture_output=True, env=env, timeout=60, check=False)
    elapsed = (time.perf_counter() - started) * 1000
    return elapsed, result.returncode, json.loads(result.stdout or b"{}")


def coldopen_gate(dest: Path, evidence: Path, repeat: int) -> dict[str, Any]:
    per_clip = []
    times: list[float] = []
    sources: Counter[str] = Counter()
    invalid = 0
    for clip in _clips(dest):
        runs = [_cli(dest, clip["job"].name, clip["clip_id"]) for _ in range(repeat)]
        status = {code for _ms, code, _payload in runs}
        payload = runs[-1][2]
        candidates = [coldopen.Candidate.from_json(item) for item in payload.get("candidates", [])]
        bad = [c.id for c in candidates
               if validate_doc(_with_cold_open(clip["seed"], c), words=clip["words"], assets={},
                               seed=None).errors]
        invalid += len(bad)
        sources.update(c.source for c in candidates)
        clip_times = [ms for ms, _code, _payload in runs]
        times.extend(clip_times)
        per_clip.append({"clip": f"{clip['job'].name[:8]}/{clip['clip_id']}",
                         "exit": sorted(status), "candidates": len(candidates),
                         "sources": [c.source for c in candidates],
                         "laugh_tail": sum(c.laugh_tail for c in candidates),
                         "lengths_s": [round(c.dur_ms / 1000, 2) for c in candidates],
                         "invalid": bad, "wall_ms_p50": round(statistics.median(clip_times), 1),
                         "wall_ms_max": round(max(clip_times), 1)})
    ordered = sorted(times)
    report = {
        "gate": "cold-open suggestions on real clips: every candidate satisfies §3.4; CLI time",
        "task": TASK, "clips": len(per_clip),
        "candidates": sum(item["candidates"] for item in per_clip),
        "clips_without_candidates": sum(item["candidates"] == 0 for item in per_clip),
        "by_source": dict(sorted(sources.items())), "invalid_candidates": invalid,
        "cli_samples": len(ordered), "cli_wall_ms_p50": round(statistics.median(ordered), 1),
        "cli_wall_ms_p95": round(ordered[min(len(ordered) - 1, int(0.95 * len(ordered)))], 1),
        "cli_wall_ms_max": round(ordered[-1], 1), "pass": invalid == 0,
        "per_clip": per_clip, **_environment(),
    }
    _write(evidence, report)
    return report


def browser_data(dest: Path, out: Path) -> int:
    gen = _generator()
    count = 0
    for clip in _clips(dest):
        target = out / f"{clip['job'].name[:8]}-{clip['clip_id']}"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(clip["words_path"], target / "words.json")
        (target / "seed.json").write_text(json.dumps(clip["seed"]), encoding="utf-8")
        shutil.copyfile(clip["dir"] / clip["words"]["peaks"]["file"], target / "peaks.bin")
        _ms, _code, payload = _cli(dest, clip["job"].name, clip["clip_id"])
        (target / "candidates.json").write_text(json.dumps(payload), encoding="utf-8")
        docs = documents(clip)
        chosen = [d for d in docs if d[0] in ("seed", "cuts", "trim")][:3]
        chosen += [d for d in docs if d[0].startswith("candidate_")][1:2]
        cases = [{"name": name, "doc": doc, "markers": gen.markers(clip["words"], doc)}
                 for name, doc in chosen]
        (target / "markers.json").write_text(json.dumps({"cases": cases}), encoding="utf-8")
        count += 1
    return count


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    copy_cmd = commands.add_parser("copy")
    copy_cmd.add_argument("source", type=Path)
    copy_cmd.add_argument("dest", type=Path)
    copy_cmd.add_argument("--jobs", default=",".join(REAL_JOBS))
    prepare_cmd = commands.add_parser("prepare")
    prepare_cmd.add_argument("dest", type=Path)
    markers_cmd = commands.add_parser("markers")
    markers_cmd.add_argument("dest", type=Path)
    markers_cmd.add_argument("evidence", type=Path)
    coldopen_cmd = commands.add_parser("coldopen")
    coldopen_cmd.add_argument("dest", type=Path)
    coldopen_cmd.add_argument("evidence", type=Path)
    coldopen_cmd.add_argument("--repeat", type=int, default=5)
    data_cmd = commands.add_parser("browser-data")
    data_cmd.add_argument("dest", type=Path)
    data_cmd.add_argument("out", type=Path)
    args = parser.parse_args(argv)
    if args.command == "copy":
        print(json.dumps(copy_jobs(args.source, args.dest, args.jobs.split(","))))
    elif args.command == "prepare":
        print(json.dumps(prepare(args.dest), default=str)[:4000])
    elif args.command == "markers":
        report = markers_gate(args.dest, args.evidence)
        print(json.dumps({k: report[k] for k in ("clips", "documents", "markers_compared",
                                                 "frame_mismatches", "pass")}))
    elif args.command == "coldopen":
        report = coldopen_gate(args.dest, args.evidence, args.repeat)
        print(json.dumps({k: report[k] for k in ("clips", "candidates", "invalid_candidates",
                                                 "cli_wall_ms_p50", "cli_wall_ms_p95", "pass")}))
    else:
        print(browser_data(args.dest, args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
