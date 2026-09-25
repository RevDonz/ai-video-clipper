#!/usr/bin/env python3
"""P-RT: revision 0 is the auto render, bit for bit, and an unchanged document exports the
auto file itself (plan §5.8 item 3, §10.1 P-RT, R10; T2.1).

Stdlib only (plus ``ai_clipper``), so it runs unchanged on the host and in the pinned image.
Run each step in the container it stands for, with the worktree's ``src`` on ``PYTHONPATH``:
the auto renders come from the pipeline path (``make_job.py build --render`` for the synthetic
job, ``look_report.py render`` for the owner's jobs) in a "primary-worker" container, and the
checks below run in a "render-worker" container with another CPU set.

* ``rerender JOBS_ROOT --out OUT.json [--job ID …] [--work DIR]``: every clip whose manifest
  entry says ``render_engine: edit-v2/1`` is rendered again from its ``seed.json`` with
  ``render_edit.render_document`` into a fresh path (cache bypass). The video's ``framemd5``,
  the decoded PCM (s16le, 48 kHz, stereo) md5 and the file bytes are compared with the auto
  file (gate: video and PCM identical).
* ``r10 JOBS_ROOT --out OUT.json [--job ID …] [--resources DIR]``: per clip with a seed (a job
  rendered by the legacy engine is prepared first with ``seed.prepare_legacy_job``),
  ``render_edit.render_request`` must hard-link the auto file (same inode) for (1) the seed,
  (2) an undone edit (revision 1 changes the hook text, or the caption pack when there is no
  hook; revision 2 restores it) and (3) the seed under resources whose ``toolchain.json``
  differs. It writes edits and exports into the jobs: run it on copies.
* ``evidence --rerender A.json … --r10 B.json … --out EVIDENCE.json``: the summary file of the
  gate (numbers only) for ``docs/editor/evidence/W2/T2.1-P-RT.json``.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import COMPILER_ID, render_edit, store, toolchain
from ai_clipper.edit_v2 import doc as doc_module
from ai_clipper.edit_v2 import seed as seed_module
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources

GATE = "P-RT"
TASK = "T2.1"


def _run(argv: list[str]) -> bytes:
    return subprocess.run(argv, capture_output=True, check=True, stdin=subprocess.DEVNULL,
                          timeout=3600).stdout


def framemd5(path: Path) -> list[str]:
    """Per-frame md5 of the decoded video (``-f framemd5``), without the header lines."""
    output = _run(["ffmpeg", "-nostdin", "-v", "error", "-threads", "4", "-i", str(path),
                   "-map", "0:v:0", "-f", "framemd5", "-"]).decode("ascii")
    return [line for line in output.splitlines() if line and not line.startswith("#")]


def pcm_md5(path: Path) -> tuple[str, int]:
    """md5 and sample count (per channel) of the decoded audio at s16le, 48 kHz, stereo."""
    pcm = _run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f",
                "s16le", "-ac", "2", "-ar", "48000", "-"])
    return hashlib.md5(pcm).hexdigest(), len(pcm) // 4


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def _jobs(root: Path, only: list[str] | None) -> list[Path]:
    return [path for path in sorted(root.iterdir())
            if path.is_dir() and (only is None or path.name in only)]


def _manifest(job_dir: Path) -> dict[str, Any]:
    return json.loads((job_dir / "output" / "manifest.json").read_text(encoding="utf-8"))


def _rendered(job_dir: Path) -> list[dict[str, Any]]:
    """The manifest's clips whose auto file exists in the job (a tool's copy may hold only
    some of them)."""
    return [entry for entry in _manifest(job_dir).get("clips", [])
            if (job_dir / "output" / Path(entry["output"]).name).is_file()]


def _environment() -> dict[str, Any]:
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                             check=False).stdout.splitlines()[0]
    toolchain_file = RESOURCES_DIR / "toolchain.json"
    return {
        "ffmpeg": version, "python": platform.python_version(),
        "cpu_count": os.cpu_count(), "affinity": len(os.sched_getaffinity(0)),
        "toolchain_sha256": file_sha256(toolchain_file) if toolchain_file.is_file() else None,
        "loadavg": [round(value, 2) for value in os.getloadavg()],
    }


# --- rerender ------------------------------------------------------------------------------------


def rerender(root: Path, *, only: list[str] | None, work: Path) -> dict[str, Any]:
    rows = []
    for job_dir in _jobs(root, only):
        for entry in _rendered(job_dir):
            if entry.get("render_engine") != COMPILER_ID:
                continue
            clip_dir = job_dir / "analysis" / "clips" / entry["clip_id"]
            document, _etag = store.seed(clip_dir)
            auto = job_dir / "output" / Path(entry["output"]).name
            again = work / f"{job_dir.name}-{entry['clip_id']}.mp4"
            started = time.monotonic()
            result = render_edit.render_document(
                document, job_dir, again, size=(document["output"]["w"], document["output"]["h"]),
                quality="standar")
            seconds = time.monotonic() - started
            auto_frames, again_frames = framemd5(auto), framemd5(again)
            (auto_pcm, auto_samples), (again_pcm, again_samples) = pcm_md5(auto), pcm_md5(again)
            rows.append({
                "job": job_dir.name, "clip_id": entry["clip_id"], "index": entry["index"],
                "layout": document["layout"]["default"]["mode"],
                "fps": document["output"]["fps"], "frames": len(auto_frames),
                "samples": auto_samples,
                "video_identical": auto_frames == again_frames,
                "frames_differing": sum(a != b for a, b in zip(auto_frames, again_frames,
                                                               strict=False))
                + abs(len(auto_frames) - len(again_frames)),
                "pcm_identical": auto_pcm == again_pcm and auto_samples == again_samples,
                "bytes_identical": file_sha256(auto) == file_sha256(again),
                "srt_identical": auto.with_suffix(".srt").read_bytes()
                == again.with_suffix(".srt").read_bytes(),
                "plan_sha256_equal": result.plan_sha256 == entry["plan_sha256"],
                "render_key_equal": result.render_key == entry.get("render_key"),
                "rerender_s": round(seconds, 2),
            })
            again.unlink()
            again.with_suffix(".srt").unlink()
    return {"step": "rerender", "environment": _environment(), "clips": rows,
            "summary": {
                "clips": len(rows),
                "video_identical": sum(row["video_identical"] for row in rows),
                "pcm_identical": sum(row["pcm_identical"] for row in rows),
                "bytes_identical": sum(row["bytes_identical"] for row in rows),
                "frames": sum(row["frames"] for row in rows),
                "pass": bool(rows) and all(row["video_identical"] and row["pcm_identical"]
                                           for row in rows)}}


# --- r10 -----------------------------------------------------------------------------------------


def _changed_resources(work: Path) -> Resources:
    """A copy of the resources whose toolchain.json names another Debian snapshot."""
    root = work / "resources-changed"
    if not root.exists():
        shutil.copytree(RESOURCES_DIR, root, ignore=shutil.ignore_patterns("toolchain.json"))
        dpkg = ("ffmpeg\t7:5.1.10-0+deb12u1\nfontconfig\t2.14.1-4\n"
                "libass9:amd64\t1:0.17.1-1+deb12u1\nlibfreetype6:amd64\t2.12.1+dfsg-5+deb12u4\n"
                "libfribidi0:amd64\t1.0.8-2.1\nlibharfbuzz0b:amd64\t6.0.0+dfsg-3\n")
        toolchain.write(root / "toolchain.json", apt_snapshot="20261101T000000Z",
                        base_image="node:20-bookworm-slim@sha256:" + "3d" * 32, dpkg_output=dpkg)
    return Resources(root)


def _request(job_dir: Path, clip_id: str, relative: str, etag: str, revision: int,
             salt: str) -> dict[str, Any]:
    info = json.loads((job_dir / "analysis" / "source.json").read_text(encoding="utf-8"))
    key = hashlib.sha256(f"{clip_id}\0{etag}\0{salt}".encode()).hexdigest()
    return {"version": render_edit.REQUEST_VERSION, "render_id": str(uuid.uuid4()),
            "clip_id": clip_id, "doc_sha256": etag, "doc_revision": revision,
            "doc_relative": relative, "render_key": key, "size": "output",
            "quality": "standar", "output_relative": f"output/edits/{clip_id}/{key[:16]}.mp4",
            "source_content_sha256": info["content_sha256"]}


def _next(clip_dir: Path, document: dict[str, Any], etag: str, change, command: str,
          now_ms: int) -> tuple[dict[str, Any], str]:
    nxt = copy.deepcopy(document)
    nxt["revision"] = document["revision"] + 1
    nxt["parent_sha256"] = etag
    nxt["audit"]["last_command"] = command
    change(nxt)
    saved, new_etag, _warnings = store.put(clip_dir, expected_etag=etag,
                                           idempotency_key=str(uuid.uuid4()),
                                           raw=doc_module.canonical_bytes(nxt), now_ms=now_ms)
    return saved, new_etag


def _edit_and_undo(clip_dir: Path) -> tuple[str, int, str]:
    """Revision 1 changes the hook text (or the caption pack), revision 2 restores it; returns
    the archive of revision 2, its revision and etag."""
    document, etag = store.get(clip_dir)[:2]
    seed_doc, _seed_etag = store.seed(clip_dir)
    hook = [track for track in seed_doc["tracks"] if track["kind"] == "hook"]
    if hook:
        original = hook[0]["items"][0]["payload"]["text"]

        def edit(doc: dict[str, Any]) -> None:
            doc["tracks"][0]["items"][0]["payload"]["text"] = "Teks hook percobaan P-RT"

        def undo(doc: dict[str, Any]) -> None:
            doc["tracks"][0]["items"][0]["payload"]["text"] = original
    else:
        original_pack = copy.deepcopy(seed_doc["captions"])

        def edit(doc: dict[str, Any]) -> None:
            doc["captions"]["pack"]["id"] = ("classic" if original_pack["pack"]["id"] != "classic"
                                             else "karaoke")

        def undo(doc: dict[str, Any]) -> None:
            doc["captions"] = copy.deepcopy(original_pack)
    now = max(document["audit"]["updated_at_ms"], int(time.time() * 1000)) + 1
    first, first_etag = _next(clip_dir, document, etag, edit, "SetHookText", now)
    second, second_etag = _next(clip_dir, first, first_etag, undo, "Undo", now + 1)
    if not doc_module.content_equals_seed(second, seed_doc):
        raise AssertionError("the undo did not restore the seed's content")
    relative, revision = store.archive_for_render(clip_dir, second_etag)
    return relative, revision, second_etag


def r10(root: Path, *, only: list[str] | None, work: Path) -> dict[str, Any]:
    changed = _changed_resources(work)
    rows = []
    for job_dir in _jobs(root, only):
        entries = _rendered(job_dir)
        if any("render_engine" not in entry for entry in entries):
            seed_module.prepare_legacy_job(job_dir)  # a job rendered by the legacy engine
        for entry in entries:
            engine = entry.get("render_engine", "legacy")
            listing = seed_module.inspect_job(job_dir)
            clip_id = entry.get("clip_id") or next(
                (item["clip_id"] for item in listing if item["index"] == entry["index"]), None)
            if clip_id is None:
                rows.append({"job": job_dir.name, "index": entry["index"], "engine": engine,
                             "case": "seed", "linked": False, "reason": "no_seed"})
                continue
            clip_dir = job_dir / "analysis" / "clips" / clip_id
            auto = job_dir / "output" / Path(entry["output"]).name
            _seed_doc, seed_etag = store.seed(clip_dir)
            seed_relative, _revision = store.archive_for_render(clip_dir, seed_etag)
            cases = [("seed", seed_relative, 0, seed_etag, None)]
            relative, revision, etag = _edit_and_undo(clip_dir)
            cases.append(("undone_edit", relative, revision, etag, None))
            cases.append(("changed_toolchain", seed_relative, 0, seed_etag, changed))
            for case, relative, revision, etag, resources in cases:
                request = _request(job_dir, clip_id, relative, etag, revision, case)
                started = time.monotonic()
                row = {"job": job_dir.name, "index": entry["index"], "clip_id": clip_id,
                       "engine": engine, "case": case}
                try:
                    result = render_edit.render_request(
                        job_dir, request, heartbeat=lambda *_: None, cancel=threading.Event(),
                        resources=resources)
                    row.update(reused=result.reused, warnings=list(result.warnings),
                               linked=result.reused == "auto_file"
                               and os.stat(result.output).st_ino == os.stat(auto).st_ino
                               and os.stat(result.srt).st_ino
                               == os.stat(auto.with_suffix(".srt")).st_ino)
                except Exception as error:  # noqa: BLE001 - recorded as a failed case
                    row.update(linked=False, error=type(error).__name__,
                               code=getattr(error, "code", None))
                row["seconds"] = round(time.monotonic() - started, 2)
                rows.append(row)
    by_case: dict[str, dict[str, int]] = {}
    for row in rows:
        bucket = by_case.setdefault(f"{row['engine']}:{row['case']}", {"cases": 0, "linked": 0})
        bucket["cases"] += 1
        bucket["linked"] += bool(row["linked"])
    linked = sum(bool(row["linked"]) for row in rows)
    return {"step": "r10", "environment": _environment(), "cases": rows,
            "summary": {"cases": len(rows), "linked": linked, "by_case": by_case,
                        "linked_pct": round(100 * linked / len(rows), 2) if rows else None,
                        "pass": bool(rows) and linked == len(rows)}}


# --- evidence ------------------------------------------------------------------------------------


def evidence(reruns: list[dict[str, Any]], checks: list[dict[str, Any]],
             labels: list[str]) -> dict[str, Any]:
    sets = []
    for label, rerun, check in zip(labels, reruns, checks, strict=True):
        clips = rerun["clips"]
        sets.append({
            "set": label,
            "rerender": {**rerun["summary"],
                         "layouts": sorted({row["layout"] for row in clips}),
                         "fps": sorted({"/".join(map(str, row["fps"])) for row in clips}),
                         "srt_identical": sum(row["srt_identical"] for row in clips),
                         "plan_sha256_equal": sum(row["plan_sha256_equal"] for row in clips),
                         "render_key_equal": sum(row["render_key_equal"] for row in clips),
                         "environment": rerun["environment"]},
            "r10": {**check["summary"], "environment": check["environment"]},
        })
    return {"gate": GATE, "task": TASK,
            "threshold": {"video_framemd5": "identical", "pcm_md5": "identical",
                          "r10_hard_link_pct": 100},
            "sets": sets,
            "pass": bool(sets) and all(item["rerender"]["pass"] and item["r10"]["pass"]
                                       for item in sets)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("rerender", "r10"):
        command = commands.add_parser(name)
        command.add_argument("jobs_root", type=Path)
        command.add_argument("--out", type=Path, required=True)
        command.add_argument("--job", action="append", default=None)
        command.add_argument("--work", type=Path, default=None)
    merge = commands.add_parser("evidence")
    merge.add_argument("--rerender", type=Path, action="append", required=True)
    merge.add_argument("--r10", type=Path, action="append", required=True)
    merge.add_argument("--label", action="append", required=True)
    merge.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "evidence":
        report = evidence([json.loads(path.read_text()) for path in args.rerender],
                          [json.loads(path.read_text()) for path in args.r10], args.label)
    else:
        with tempfile.TemporaryDirectory(prefix="rt-check-") as scratch:
            work = Path(scratch) if args.work is None else args.work
            work.mkdir(parents=True, exist_ok=True)
            step = rerender if args.command == "rerender" else r10
            report = step(args.jobs_root, only=args.job, work=work)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report.get("summary", {"pass": report.get("pass")}), indent=1))
    passed = report.get("pass") if args.command == "evidence" else report["summary"]["pass"]
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
