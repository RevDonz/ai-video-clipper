#!/usr/bin/env python3
"""Plate cache bytes before and after a base-image change (rombak 01 §8.2, §8.4; MU-M0).

``toolchain.json``'s sha is part of every plate key, so a new base image orphans every plate
cell once: opening a clip builds its cells again under the new key, and the old cells stay
until the janitor drops them (30 days unused, or the job's 1 GiB preview cap).

On the synthetic ``main`` job of ``scripts/editor_fixture/make_job.py`` (rendered with the
edit-v2 compiler), every clip's plate cells for its whole seed document are encoded once with
this image's FFmpeg and written under the plate key of the old toolchain (``--old-base``) and
of the toolchain this ``Dockerfile`` pins. A cell's bytes do not depend on the key: the six
rendering packages and the Debian snapshot are the same on both sides, only ``base_image``
changes. Numbers only go to ``--out``.

Usage::

    python scripts/perf/plate_invalidation.py --work /tmp/plates --old-base node:20-…@sha256:… \\
        --out /out/plate-invalidation.json
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for entry in (ROOT / "src", ROOT / "scripts" / "parity"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

import toolchain_guard as tg

from ai_clipper.edit_v2 import plates, store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.plan import Resources


def _make_job_module():
    path = ROOT / "scripts" / "editor_fixture" / "make_job.py"
    spec = importlib.util.spec_from_file_location("editor_fixture_make_job", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _plate_bytes(clips: list[Path]) -> int:
    total = 0
    for clip in clips:
        directory = clip / "preview" / "plates"
        if directory.is_dir():
            total += sum(path.stat().st_size for path in directory.iterdir() if path.is_file())
    return total


def measure(work: Path, *, old_base: str) -> dict[str, Any]:
    new_doc = tg.derive_toolchain((ROOT / "Dockerfile").read_text(encoding="utf-8"))
    old_doc = copy.deepcopy(new_doc)
    old_doc["base_image"] = old_base
    keys = {"old": tg.toolchain_sha256(old_doc), "new": tg.toolchain_sha256(new_doc)}
    make_job = _make_job_module()
    out = work / "fixture"
    if out.exists():
        shutil.rmtree(out)
    index = make_job.build(out, only=["main"])
    make_job.render_all(out, index, stub_camera=True)
    job_dir = out / index["jobs"]["main"]["dir"]
    manifest = json.loads((job_dir / "output" / "manifest.json").read_text(encoding="utf-8"))
    clips = [job_dir / "analysis" / "clips" / clip["clip_id"] for clip in manifest["clips"]]
    resources = Resources(RESOURCES_DIR)
    rows = []
    stages: dict[str, int] = {}
    for side in ("old", "new"):
        for clip in clips:
            doc, _etag, _is_seed = store.get(clip)
            camera, camera_sha = plates.camera_for(clip, doc)
            key = plates.plate_key(doc, camera_sha256=camera_sha, toolchain_sha256=keys[side])
            cells = plates.cells_for_pieces(tm.pieces(doc), doc["output"]["fps"])
            plan = plates.plate_plan(doc, camera=camera, resources=resources)
            built = plates.build_cells(plan, source=plates.source_path(job_dir),
                                       assets_root=job_dir / "analysis" / "assets", cells=cells)
            directory = clip / "preview" / "plates"
            directory.mkdir(parents=True, exist_ok=True)
            for k, data in built.items():
                (directory / plates.cell_name(key, k)).write_bytes(data)
            rows.append({"side": side, "clip_id": clip.name, "layout": doc["layout"]["default"]["mode"],
                         "plate_key16": key[:16], "cells": len(cells),
                         "bytes": sum(len(data) for data in built.values())})
        stages[side] = _plate_bytes(clips)
    old_bytes = sum(row["bytes"] for row in rows if row["side"] == "old")
    new_bytes = sum(row["bytes"] for row in rows if row["side"] == "new")
    return {
        "schema": "potongin.plate-invalidation/1",
        "fixture": {"job": "main", "size": index["size"], "clips": len(clips),
                    "duration_ms": index["duration_ms"]},
        "toolchain_sha256": keys,
        "base_image": {"old": old_base, "new": new_doc["base_image"]},
        "keys_changed": all(row_old["plate_key16"] != row_new["plate_key16"]
                            for row_old, row_new in zip(rows[:len(clips)], rows[len(clips):])),
        "same_bytes_per_cell_set": old_bytes == new_bytes,
        "plates_bytes": {"before": stages["old"], "after_reopen": stages["new"],
                         "after_janitor": stages["new"] - stages["old"]},
        "clips": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--old-base", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    report = measure(args.work, old_base=args.old_base)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["plates_bytes"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
