#!/usr/bin/env python3
"""Retention soak (plan §11.4 T4.3): 1,000 saves + 50 exports + cache churn stay inside the caps.

On the synthetic ``main`` job of ``scripts/editor_fixture/make_job.py`` (rendered with the new
engine, so every clip has its seed), in a scratch directory:

* **saves**: ``--saves`` revisions through ``store.put`` (the editor's PUT), round-robin over the
  clips, each a real content change (the hook text), each with its own idempotency key;
* **exports**: after every ``saves / exports``-th save, the current revision is exported through
  the render queue (``create_request_v3``) and the render worker (``run_one``): an archive, a
  request and a rendered MP4 + SRT;
* **cache churn**: every 10 saves ``--churn-mb / 100`` of preview files (plates, audio, frames)
  land in the clips' ``preview/`` directories, plus an AI suggestion file; three uploaded
  assets nobody uses sit in the job's asset store;
* **janitor ticks** every 100 saves (``edit_v2.janitor.run`` with ``--cap-mb``), then one tick
  31 days later.

After every tick the caps are checked: committed receipts ≤ 200 per clip and no pending one,
archives per clip ≤ revision 1 + the newest 50 + the revisions exports name, v3 requests
≤ 200, the job's preview cache ≤ the cap; after the late tick no suggestion and no orphan asset
is left. Numbers only go to ``--out`` (no media). Exit 1 when a cap is exceeded.

Usage::

    python scripts/perf/retention_soak.py --work /tmp/soak --out docs/editor/evidence/W4/T4.3-retention-soak.json
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
import time
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from ai_clipper.edit_v2 import janitor, store, toolchain
from ai_clipper.edit_v2.doc import canonical_bytes
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources
from ai_clipper.render_queue import create_request_v3, list_requests_v3
from ai_clipper.render_worker import run_one

DAY_MS = 86_400_000
DPKG = ("ffmpeg\t7:5.1.9-0+deb12u1\nfontconfig\t2.14.1-4\nlibass9:amd64\t1:0.17.1-1+deb12u1\n"
        "libfreetype6:amd64\t2.12.1+dfsg-5+deb12u4\nlibfribidi0:amd64\t1.0.8-2.1\n"
        "libharfbuzz0b:amd64\t6.0.0+dfsg-3\n")
REQUESTS_CAP = 200


def _make_job_module():
    path = ROOT / "scripts" / "editor_fixture" / "make_job.py"
    spec = importlib.util.spec_from_file_location("editor_fixture_make_job", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _resources(work: Path) -> Resources:
    """The pinned resources with a toolchain file (exports need a render key)."""
    root = work / "resources"
    if not root.exists():
        shutil.copytree(RESOURCES_DIR, root, ignore=shutil.ignore_patterns("toolchain.json"))
        toolchain.write(root / "toolchain.json", apt_snapshot="20260924T000000Z",
                        base_image="node:20-bookworm-slim@sha256:" + "2c" * 32, dpkg_output=DPKG)
    return Resources(root)


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))]


def _next(document: dict, etag: str, hook: str) -> dict:
    nxt = copy.deepcopy(document)
    nxt["revision"] = document["revision"] + 1
    nxt["parent_sha256"] = etag
    nxt["audit"]["editor"] = "editor-v3/1.0.0"
    nxt["audit"]["last_command"] = "SetHookText"
    (track,) = [track for track in nxt["tracks"] if track["kind"] == "hook"]
    track["items"][0]["payload"]["text"] = hook
    return nxt


def _churn(clips: list[Path], round_index: int, megabytes: float, now_s: float) -> int:
    """Preview files as the lane writes them (plates, audio, frames) and one suggestion."""
    written = 0
    size = max(1, int(megabytes * (1 << 20) / 4))
    for slot in range(4):
        clip = clips[(round_index + slot) % len(clips)]
        kind, name = [("plates", f"{round_index:016x}-c{slot:07d}.mp4"),
                      ("audio", f"{round_index:015x}{slot}.flac"),
                      ("frames", f"{round_index:015x}{slot}-1-720.png"),
                      ("plates", f"{round_index:016x}-c{slot + 4:07d}.mp4")][slot]
        path = clip / "preview" / kind / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "wb") as handle:
            handle.truncate(size)
        os.utime(path, (now_s, now_s))
        written += size
    folder = clips[round_index % len(clips)] / "suggestions"
    folder.mkdir(exist_ok=True)
    (folder / f"{uuid.uuid4()}.json").write_text("{}", encoding="utf-8")
    return written


def _orphan_assets(job_dir: Path) -> None:
    directory = job_dir / "analysis" / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    for index in range(3):
        sha = f"{index:064x}"
        (directory / f"{sha}.png").write_bytes(b"\x89PNG soak")
        (directory / f"{sha}.json").write_text(json.dumps({"kind": "image", "mime": "image/png",
                                                           "w": 1, "h": 1}))


def _cache_bytes(clips: list[Path]) -> int:
    total = 0
    for clip in clips:
        for kind in janitor.CACHE_DIRS:
            folder = clip / "preview" / kind
            if folder.is_dir():
                total += sum(path.stat().st_size for path in folder.iterdir()
                             if path.is_file() and not path.name.startswith("."))
    return total


def _caps(job_dir: Path, clips: list[Path], cap_bytes: int) -> dict[str, Any]:
    requests = list_requests_v3(job_dir)
    referenced = {request["doc_relative"] for request in requests}
    rows = []
    ok = True
    for clip in clips:
        receipts = [json.loads(path.read_text()) for path in (clip / "edit" / "receipts").glob(
            "*.json")]
        committed = sum(receipt["state"] == "committed" for receipt in receipts)
        pending = sum(receipt["state"] == "pending" for receipt in receipts)
        archives = sorted((clip / "edit" / "archive").glob("r*.json.gz"))
        named = sum(f"analysis/clips/{clip.name}/edit/archive/{path.name}" in referenced
                    for path in archives)
        allowed = 1 + janitor.ARCHIVE_KEEP + named
        row = {"clip": clip.name, "receipts_committed": committed, "receipts_pending": pending,
               "archives": len(archives), "archives_allowed": allowed,
               "archives_named_by_exports": named}
        ok = ok and committed <= janitor.RECEIPTS_KEEP and pending == 0 and len(archives) <= allowed
        rows.append(row)
    cache = _cache_bytes(clips)
    ok = ok and cache <= cap_bytes and len(requests) <= REQUESTS_CAP
    return {"ok": ok, "clips": rows, "cache_bytes": cache, "cap_bytes": cap_bytes,
            "requests": len(requests)}


def soak(work: Path, *, saves: int, exports: int, churn_mb: float, cap_mb: float) -> dict:
    make_job = _make_job_module()
    out = work / "fixture"
    if out.exists():
        shutil.rmtree(out)
    index = make_job.build(out, size=(320, 180), only=["main"])
    make_job.render_all(out, index, stub_camera=True)
    jobs_root = out / "jobs"
    job_dir = out / index["jobs"]["main"]["dir"]
    manifest = json.loads((job_dir / "output" / "manifest.json").read_text(encoding="utf-8"))
    clips = [job_dir / "analysis" / "clips" / clip["clip_id"] for clip in manifest["clips"]]
    resources = _resources(work)
    _orphan_assets(job_dir)
    cap_bytes = int(cap_mb * (1 << 20))
    every_export = max(1, saves // exports)
    now_ms = time.time_ns() // 1_000_000
    save_ms: list[float] = []
    export_s: list[float] = []
    ticks: list[dict[str, Any]] = []
    churned = 0
    exported = 0
    states: dict[str, int] = {}
    for number in range(1, saves + 1):
        clip = clips[number % len(clips)]
        document, etag, _is_seed = store.get(clip)
        nxt = _next(document, etag, f"Hook soak nomor {number}")
        started = time.perf_counter()
        _saved, etag, _warnings = store.put(clip, expected_etag=etag,
                                            idempotency_key=str(uuid.uuid4()),
                                            raw=canonical_bytes(nxt), now_ms=now_ms + number)
        save_ms.append((time.perf_counter() - started) * 1000)
        if number % every_export == 0 and exported < exports:
            started = time.perf_counter()
            request = create_request_v3(job_dir, clip.name, etag, str(uuid.uuid4()),
                                        resources=resources)
            if request["state"] == "queued":
                run_one(jobs_root)
            export_s.append(time.perf_counter() - started)
            exported += 1
        if number % 10 == 0:
            churned += _churn(clips, number // 10, churn_mb / 100, time.time())
        if number % 100 == 0:
            started = time.perf_counter()
            report = janitor.run(jobs_root, now_ms=time.time_ns() // 1_000_000,
                                 cap_bytes=cap_bytes)
            elapsed = time.perf_counter() - started
            caps = _caps(job_dir, clips, cap_bytes)
            ticks.append({"after_saves": number, "janitor_s": round(elapsed, 3),
                          "removed": {key: report[key] for key in (
                              "receipts", "archives", "suggestions", "cache_files", "assets")},
                          "caps_ok": caps["ok"], "cache_bytes": caps["cache_bytes"],
                          "max_archives": max(row["archives"] for row in caps["clips"]),
                          "max_receipts": max(row["receipts_committed"]
                                              for row in caps["clips"])})
    for request in list_requests_v3(job_dir):
        states[request["state"]] = states.get(request["state"], 0) + 1
    final = _caps(job_dir, clips, cap_bytes)
    later = time.time_ns() // 1_000_000 + 31 * DAY_MS
    janitor.run(jobs_root, now_ms=time.time_ns() // 1_000_000, cap_bytes=cap_bytes)
    late = janitor.run(jobs_root, now_ms=later, cap_bytes=cap_bytes)
    suggestions_left = sum(len(list((clip / "suggestions").glob("*.json"))) for clip in clips)
    assets_left = len(list((job_dir / "analysis" / "assets").glob("*.png")))
    passed = (all(tick["caps_ok"] for tick in ticks) and final["ok"]
              and suggestions_left == 0 and assets_left == 0
              and states.get("completed", 0) == exports)
    return {
        "gate": "retention-soak", "task": "T4.3", "pass": passed,
        "environment": {"python": platform.python_version(),
                        "ffmpeg": subprocess.run(["ffmpeg", "-version"], capture_output=True,
                                                 text=True, check=False).stdout.split("\n")[0],
                        "cpu_count": os.cpu_count(), "loadavg": list(os.getloadavg())},
        "saves": saves, "exports": exports, "export_states": states,
        "churn_bytes": churned, "cap_bytes": cap_bytes,
        "save_ms": {"p50": round(statistics.median(save_ms), 2),
                    "p95": round(_percentile(save_ms, 0.95), 2),
                    "max": round(max(save_ms), 2)},
        "export_s": {"p50": round(statistics.median(export_s), 2),
                     "p95": round(_percentile(export_s, 0.95), 2)} if export_s else None,
        "ticks": ticks, "final": final,
        "after_31_days": {"suggestions_removed": late["suggestions"],
                          "assets_removed": late["assets"], "suggestions_left": suggestions_left,
                          "assets_left": assets_left},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--saves", type=int, default=1000)
    parser.add_argument("--exports", type=int, default=50)
    parser.add_argument("--churn-mb", type=float, default=1024.0)
    parser.add_argument("--cap-mb", type=float, default=64.0)
    args = parser.parse_args(argv)
    args.work.mkdir(parents=True, exist_ok=True)
    report = soak(args.work, saves=args.saves, exports=args.exports, churn_mb=args.churn_mb,
                  cap_mb=args.cap_mb)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("pass", "save_ms", "export_s",
                                                   "export_states", "after_31_days")}, indent=1))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
