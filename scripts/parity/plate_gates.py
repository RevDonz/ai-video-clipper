#!/usr/bin/env python3
"""T3.6 gates: the layout switch and face-track (plan §11.3 T3.6, §5.7, §10.1 P-PLATE and
P-FRAME, §10.3 PF-CELLS).

Sub-commands (evidence ``T3.6-<gate>.json`` under ``--evidence``, numbers only):

``camera-plan`` (offline)
    The camera plan of a 180 s window around the middle of each real source, built with the
    camera plan's own detector (``face_window.detect_window``, the default of
    ``camera.build_camera_plan``) and with today's ``face_tracking.detect_face_track`` (one
    decode, as W1 measured it). Budget: ≤ 15 s per window in the image at ``--cpus 4``. The two
    plans are compared sample by sample (they may differ only where two faces have the same
    size, which today's detector orders by OpenCV's thread scheduling). ``--runs 1
    --no-compare --jobs <one job>``: one plan of one source, light enough for the owner's PC.

``switch`` (through the app)
    The editor is open on a real clip at its seed layout (the lane building its cells), then the
    layout is switched at a playhead: the seconds until the editor sees the playhead's cell of
    the new layout ready (the plan asked again every 0.75 s, as the store polls), and until the
    cell file exists. Budget ≤ 3 s for fit-blur and center-crop, on the editor's view. The
    face-track switch (camera analysis included) is reported.

``p-frame`` (through the app and the export path)
    Barcode sources (29.97, 25, 60 → 30 and VFR) seeded with one layout and switched to each of
    the three, 20 cuts plus the seed's cold open, captions on and the hook off (its box covers the
    index bands at the top of the crop layouts): the source frame index of every output frame
    of the lane's plate cells and of the export (``render_edit.load_render_inputs`` → ``final``)
    against the whole-file ``fps`` grid. 0 mismatches over ≥ 2,000 frames per layout.

``p-plate`` (through the app and the export path)
    Per layout after a switch: the lane's plate frames against the lossless ``reference`` of the
    export's plan (text and logo off), SSIM ≥ SSIM(final vs reference) − 0.002, and on the
    column-ruler source the crop x of every plate, reference and final frame equal to the plan
    (0 px), across cuts and cell boundaries. Real clips switched too (SSIM only).

``pf-cells`` (through the app)
    All plate cells of a ~60 s clip after a switch: ≤ 15 s (fit-blur, center-crop) and
    ≤ 25 s (face-track, including the camera plan), two heavy slots. A shorter clip is held to
    the budget twice: as measured and projected to 60 s (``projected_60s_s``).

``--media`` (switch, pf-cells, p-plate): ``synthetic`` (default; the barcode jobs of
``make_job.py``, 1280×720 for the timed gates, so the gates run where the owner's jobs are not,
e.g. in CI) or ``real`` (the owner's clips under ``--jobs-root``; P-PLATE adds their SSIM
cases). P-FRAME is always synthetic.

The app gates reach a running Next server (``POTONGIN_EDITOR_V3=on``, ``JOBS_ROOT`` = ``--jobs-root``:
an empty scratch directory for synthetic media, a scratch copy of the owner's jobs prepared with
``edit_v2.api prepare_job`` for real media) as the editor does: a session cookie, same-origin
headers and the rate limits of plan §9.1; the lane's files are read from ``--jobs-root``. Run it
where the server's FFmpeg is: in the production image, the standalone server and the gate side
by side (the editor-gates workflow, ``suite=command``)::

    export APP_USERNAME=gate APP_PASSWORD=<random> E2E_USERNAME=gate E2E_PASSWORD=<same>
    (cd /app && JOBS_ROOT=/tmp/jobs APP_SESSION_SECRET=<random> POTONGIN_EDITOR_V3=on \\
        PORT=3361 HOSTNAME=127.0.0.1 node server.js) &
    uv run python scripts/parity/plate_gates.py p-frame --base-url http://127.0.0.1:3361 \\
        --jobs-root /tmp/jobs --evidence docs/editor/evidence/W3 --label ci

or locally against real media (``--media real``)::

    docker run --rm --network host --user 1000:1000 -v "$PWD":/w -v "$JOBS":/jobs -w /w \\
        -e PYTHONPATH=/w/src:/w/tests -e HOME=/tmp -e E2E_USERNAME -e E2E_PASSWORD \\
        ai-video-clipper:editor-w3base /app/.venv/bin/python scripts/parity/plate_gates.py \\
        switch --base-url http://127.0.0.1:3296 --jobs-root /jobs --evidence docs/editor/evidence/W3

    docker run --rm --cpus 4 --user 1000:1000 -v "$PWD":/w -v "$JOBS":/jobs:ro -w /w \\
        -e PYTHONPATH=/w/src:/w/tests -e HOME=/tmp ai-video-clipper:editor-w3base \\
        /app/.venv/bin/python scripts/parity/plate_gates.py camera-plan --jobs-root /jobs \\
        --evidence docs/editor/evidence/W3

Stdlib only (plus the image's OpenCV through ``ai_clipper.face_tracking``/``face_window``).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import statistics
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from itertools import pairwise
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from ai_clipper import face_tracking, face_window
from ai_clipper.edit_v2 import camera as camera_module
from ai_clipper.edit_v2.timemap import Fps

TASK = "T3.6"
CAMERA_BUDGET_S = 15.0
CAMERA_WINDOW_MS = 180_000
SWITCH_BUDGET_S = 3.0
STORE_POLL_S = 0.75  # the editor store asks for the plan again while a cell builds (planPollMs)
PF_CELLS_BUDGET_S = {"fit_blur": 15.0, "fill_center": 15.0, "camera": 25.0}
P_PLATE_SSIM_MARGIN = 0.002
P_FRAME_MIN_FRAMES = 2_000
LAYOUTS = ("fit_blur", "fill_center", "camera")
# The owner's P3 jobs (read-only originals; copies are used for the app gates).
REAL_JOBS = {
    "e7f0d37b-6999-40a2-80b8-a09c8ff187ca": "fit-blur, AV1 1280×720 23.976",
    "899226f8-7e57-49d9-8c29-b078b2b91580": "fit-blur, AV1 1280×720 25",
    "860fef1a-8140-4677-8d73-729d18f15431": "face-track, 25 fps",
    "3c7d024c-f1f5-45a6-b767-9f2c190b0c42": "fit-blur, 60 fps",
    "990f3f37-f0a6-490a-a9a2-a6d6cdab004e": "center-crop, VFR",
}


# --- shared ------------------------------------------------------------------------------------


def _load(name: str, path: Path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def lane_gates():
    """``scripts/parity/preview_lane_gates.py`` (T2.3): the app client, clips, helpers."""
    return _load("edit_v2_preview_lane_gates", ROOT / "scripts" / "parity" / "preview_lane_gates.py")


def frame_identity():
    """``scripts/parity/frame_identity.py`` (T1.3): decoders, SSIM, raw frame readers."""
    return _load("edit_v2_frame_identity", ROOT / "scripts" / "parity" / "frame_identity.py")


def summary(values: Sequence[float], digits: int = 2) -> dict[str, float]:
    ordered = sorted(values)
    p95 = ordered[min(len(ordered) - 1, max(0, round(0.95 * (len(ordered) - 1))))]
    return {"n": len(values), "p50": round(statistics.median(values), digits),
            "p95": round(p95, digits), "max": round(max(values), digits),
            "min": round(min(values), digits)}


def environment() -> dict[str, Any]:
    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    quota = None
    try:
        value, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        quota = None if value == "max" else round(int(value) / int(period), 2)
    except (OSError, ValueError):
        pass
    return {"ffmpeg": first[0] if first else None, "python": platform.python_version(),
            "cpus_visible": os.cpu_count(), "cpu_quota": quota,
            "camera_workers": min(face_window.DETECT_WORKERS_MAX, face_window.cpu_budget()),
            "loadavg": [round(x, 2) for x in os.getloadavg()]}


def write_evidence(directory: Path, gate: str, label: str, result: Mapping[str, Any]) -> Path:
    path = directory / f"{TASK}-{gate}.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.update(gate=gate, task=TASK)
    data.setdefault("runs", {})[label] = {**result, "environment": environment()}
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


# --- camera-plan (offline) -------------------------------------------------------------------------


def todays_detector(source, *, start, end, sample_interval=0.75, smooth=True, sequential=False):
    """``face_tracking.detect_face_track`` as W1 measured it (one decode), called through a
    wrapper so that ``build_camera_plan`` does not take its window path."""
    return face_tracking.detect_face_track(source, start=start, end=end,
                                           sample_interval=sample_interval, smooth=smooth,
                                           sequential=sequential)


def _probe(source: Path) -> dict[str, Any]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
         "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=duration", "-of",
         "json", str(source)], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def _timed_plan(source: Path, window: tuple[int, int], detector: Callable | None) -> dict:
    load = [round(value, 2) for value in os.getloadavg()]
    events: list[tuple[int, int]] = []
    began = time.monotonic()
    with camera_module.reporting(lambda done, total: events.append((done, total))):
        if detector is None:
            plan = camera_module.build_camera_plan(source, window, Fps(30, 1), out_w=720,
                                                   out_h=1280)
        else:
            plan = camera_module.build_camera_plan(source, window, Fps(30, 1), out_w=720,
                                                   out_h=1280, detector=detector)
    seconds = time.monotonic() - began
    return {"seconds": round(seconds, 2), "plan": plan, "load_before": load,
            "progress_events": len(events),
            "progress_monotonic": all(b[0] > a[0] for a, b in pairwise(events)),
            "progress_last": list(events[-1]) if events else None}


def camera_plan_gate(jobs_root: Path, jobs: Sequence[str], runs: int = 2,
                     compare: bool = True) -> dict[str, Any]:
    """``runs`` timed plans per source; ``compare``: also today's detector, sample by sample."""
    sources = {}
    for job in jobs:
        source = jobs_root / job / "input" / "source.mp4"
        if not source.is_file():
            continue
        probe = _probe(source)
        duration_ms = int(float(probe["format"]["duration"]) * 1000)
        start = max(0, duration_ms // 2 - CAMERA_WINDOW_MS // 2)
        window = (start, min(duration_ms, start + CAMERA_WINDOW_MS))
        stream = probe["streams"][0]
        fast_runs = [_timed_plan(source, window, None)]
        today = _timed_plan(source, window, todays_detector) if compare else None
        for _ in range(runs - 1):
            fast_runs.append(_timed_plan(source, window, None))
        fast = fast_runs[0]["plan"]
        entry = {
            "role": REAL_JOBS.get(job, ""), "codec": stream["codec_name"],
            "size": [stream["width"], stream["height"]], "rate": stream["r_frame_rate"],
            "window_ms": list(window), "samples": len(fast["samples"]),
            "window_detector_s": [run["seconds"] for run in fast_runs],
            "load_before": [run["load_before"] for run in fast_runs],
            "no_face_spans": len(fast["no_face"]),
            "same_plan_every_run": all(run["plan"] == fast for run in fast_runs),
            "progress": {"events": fast_runs[0]["progress_events"],
                         "monotonic": fast_runs[0]["progress_monotonic"],
                         "last": fast_runs[0]["progress_last"]},
        }
        if today is not None:
            old = today["plan"]
            samples_fast, samples_old = fast["samples"], old["samples"]
            differing = [i for i, (a, b) in enumerate(zip(samples_fast, samples_old)) if a != b]
            entry.update({
                "todays_detector_s": today["seconds"], "todays_load_before": today["load_before"],
                "identical_to_today": fast == old,
                "samples_differing_from_today": len(differing),
                "max_centre_pm_difference": max((abs(samples_fast[i][1] - samples_old[i][1])
                                                 for i in differing), default=0),
                "cuts_equal": fast["cuts"] == old["cuts"],
                "no_face_equal": fast["no_face"] == old["no_face"]})
        entry["pass"] = max(entry["window_detector_s"]) <= CAMERA_BUDGET_S
        sources[job[:8]] = entry
        print(json.dumps({job[:8]: entry}), flush=True)
    return {"budget_s": CAMERA_BUDGET_S, "window_ms": CAMERA_WINDOW_MS, "runs": runs,
            "compared_with_today": compare,
            "detector": "face_window.detect_window (Haar, 0.75 s samples, worker threads)",
            "baseline": "face_tracking.detect_face_track(sequential=True), W1: 14.62 s on e7f0d37b",
            "sources": sources,
            "pass": bool(sources) and all(entry["pass"] for entry in sources.values())}


# --- main ------------------------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="T3.6 layout-switch and face-track gates")
    parser.add_argument("gate", choices=("camera-plan", "switch", "p-frame", "p-plate",
                                         "pf-cells"))
    parser.add_argument("--jobs-root", type=Path, required=True)
    parser.add_argument("--base-url")
    parser.add_argument("--work", type=Path, default=Path("/tmp/t36-plate-gates"))
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--label", default="run")
    parser.add_argument("--jobs", nargs="*", default=list(REAL_JOBS))
    parser.add_argument("--media", choices=("synthetic", "real"), default="synthetic",
                        help="switch, pf-cells, p-plate: the barcode jobs of make_job.py (CI) or "
                        "the owner's real clips under --jobs-root (local)")
    parser.add_argument("--runs", type=int, default=2, help="camera-plan: timed plans per source")
    parser.add_argument("--no-compare", dest="compare", action="store_false",
                        help="camera-plan: skip today's detector (one plan per run, lighter)")
    parser.add_argument("--note", help="where and how the gate ran (stored with the run)")
    args = parser.parse_args(argv)
    started = time.monotonic()
    if args.gate == "camera-plan":
        result = camera_plan_gate(args.jobs_root, args.jobs, args.runs, args.compare)
    else:
        if not args.base_url:
            parser.error("--base-url is required for the app gates")
        gates = AppGates(args.base_url, args.jobs_root, args.work, media=args.media)
        result = getattr(gates, args.gate.replace("-", "_"))()
        result["media"] = "real" if args.gate != "p-frame" and args.media == "real" else "synthetic"
    if args.note:
        result["note"] = args.note
    result["gate_wall_s"] = round(time.monotonic() - started, 1)
    gate = {"camera-plan": "camera-plan", "switch": "switch", "p-frame": "P-FRAME",
            "p-plate": "P-PLATE", "pf-cells": "PF-CELLS"}[args.gate]
    if args.evidence is not None:
        write_evidence(args.evidence, gate, args.label, result)
    print(f"{gate}: {result.get('pass')} ({result['gate_wall_s']} s)", flush=True)
    return 0 if result.get("pass") else 1


# --- the app gates ---------------------------------------------------------------------------------

# (job, rank, target layout, playhead position in the clip: 0, 0.5 or 0.9)
SWITCH_CASES = (
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 1, "fill_center", 0.0),
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 3, "fill_center", 0.5),
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 5, "fill_center", 0.9),
    ("899226f8-7e57-49d9-8c29-b078b2b91580", 1, "fill_center", 0.5),
    ("899226f8-7e57-49d9-8c29-b078b2b91580", 2, "fill_center", 0.9),
    ("e7f0d37b-6999-40a2-80b8-a09c8ff187ca", 1, "fill_center", 0.5),
    ("e7f0d37b-6999-40a2-80b8-a09c8ff187ca", 3, "fill_center", 0.0),
    ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 1, "fit_blur", 0.5),
    ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 3, "fit_blur", 0.0),
    ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 5, "fit_blur", 0.9),
    ("860fef1a-8140-4677-8d73-729d18f15431", 1, "fit_blur", 0.5),
    ("860fef1a-8140-4677-8d73-729d18f15431", 2, "fill_center", 0.0),
    ("860fef1a-8140-4677-8d73-729d18f15431", 3, "fill_center", 0.9),
    # face-track after a switch (the camera plan is analysed first): reported, not gated
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 4, "camera", 0.5),
    ("899226f8-7e57-49d9-8c29-b078b2b91580", 4, "camera", 0.0),
)
# (job, rank, target layout): a ~60 s clip each, switched away from its seed layout
PF_CELLS_CASES = (
    ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 2, "fit_blur"),
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 2, "fill_center"),
    ("899226f8-7e57-49d9-8c29-b078b2b91580", 3, "camera"),
    ("e7f0d37b-6999-40a2-80b8-a09c8ff187ca", 2, "camera"),
    ("860fef1a-8140-4677-8d73-729d18f15431", 4, "fill_center"),
)
# (job, rank, target layouts) of the real P-PLATE cases (SSIM; the crop x is checked on the ruler)
P_PLATE_REAL = (
    ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 2, ("fill_center", "camera")),
    ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 2, ("fit_blur",)),
    ("860fef1a-8140-4677-8d73-729d18f15431", 4, ("fit_blur", "fill_center")),
)
P_FRAME_JOBS = ("main", "fps25", "fps60", "vfr")
# The same gates on the barcode jobs of make_job.py (1280×720, as the owner's AV1 sources; CI):
# seeds main and vfr fit-blur (29.97, VFR), fps25 center-crop (25), fps60 face-track (60).
SYNTHETIC_PERF_SIZE = (1280, 720)
SWITCH_SYNTHETIC = (
    ("main", 1, "fill_center", 0.0),
    ("main", 2, "fill_center", 0.5),
    ("main", 3, "fill_center", 0.9),
    ("fps25", 1, "fit_blur", 0.5),
    ("fps25", 2, "fit_blur", 0.9),
    ("fps25", 3, "fit_blur", 0.0),
    ("fps60", 1, "fit_blur", 0.5),
    ("fps60", 2, "fill_center", 0.0),
    ("fps60", 3, "fill_center", 0.9),
    ("vfr", 1, "fill_center", 0.5),
    ("vfr", 2, "fit_blur", 0.0),
    # face-track after a switch (the camera plan is analysed first): reported, not gated
    ("main", 3, "camera", 0.5),
    ("fps25", 1, "camera", 0.0),
)
PF_CELLS_SYNTHETIC = (
    ("fps60", 1, "fit_blur"),
    ("main", 2, "fit_blur"),
    ("vfr", 1, "fill_center"),
    ("fps60", 2, "fill_center"),
    ("main", 1, "camera"),
    ("fps25", 2, "camera"),
)
PF_CELLS_NOMINAL_S = 60.0  # the budget is for a ~60 s clip; shorter clips are projected to it


def _cell_of(dto: Mapping[str, Any], playhead: int) -> int:
    """The plate cell holding output frame ``playhead`` of a plan DTO."""
    for piece in dto["pieces"]:
        if piece["outF0"] <= playhead < piece["outF0"] + piece["frames"]:
            return (piece["inSf"] + playhead - piece["outF0"]) // dto["plate"]["cellFrames"]
    raise ValueError("playhead outside the clip")


class AppGates:
    """The gates that go through the running app (see the module docstring)."""

    def __init__(self, base_url: str, jobs_root: Path, work: Path, *,
                 media: str = "synthetic") -> None:
        self.media = media
        self.lg = lane_gates()
        self.fi = frame_identity()
        self.app = self.lg.App(base_url, os.environ.get("E2E_USERNAME", ""),
                               os.environ.get("E2E_PASSWORD", ""))
        self.jobs_root, self.work = jobs_root, work
        self.work.mkdir(parents=True, exist_ok=True)

    # helpers -----------------------------------------------------------------------------------

    def clip(self, job: str, rank: int):
        clip = self.lg.find_clip(self.jobs_root, job, rank)
        if clip is None:
            raise SystemExit(f"clip {job[:8]} #{rank} is not prepared under {self.jobs_root}")
        return clip

    def switched(self, clip: Any, layout: str, *, removals: int = 0, text: bool = True,
                 hook: bool = True) -> dict:
        """Revision 1 of ``clip`` after ``SetLayout`` (and ``removals`` cuts; ``text=False``:
        no captions and no hook; ``hook=False``: no hook)."""
        doc = clip.revision()
        doc["audit"]["last_command"] = "SetLayout"
        doc["layout"]["default"]["mode"] = layout
        if not text:
            doc["captions"]["enabled"] = False
        if not text or not hook:
            doc["tracks"] = [t for t in doc["tracks"] if t["kind"] != "hook"]
        if removals:
            clip.with_removals(doc, removals)
        return doc

    def prepared_camera(self, clip: Any) -> dict[str, Any]:
        status, body, ms = self.app.prepare(clip.job_id, clip.id, "camera")
        if status != 202 or body.get("camera") != "ready":
            raise RuntimeError(f"prepare camera: {status} {body}")
        return {"prepare_ms": round(ms, 1)}

    def all_cells(self, clip: Any, dto: Mapping[str, Any], timeout_s: float) -> float | None:
        key = dto["plate"]["plateKey"]
        paths = [clip.preview / "plates" / self.lg.plates.cell_name(key, cell["k"])
                 for cell in dto["plate"]["cells"]]
        return self.lg.wait_for(paths, timeout_s)

    def export_plan(self, clip: Any, doc: Mapping[str, Any]):
        """The export's plan: ``render_edit.load_render_inputs`` (validation, words, the camera
        plan it resolves for a switched layout, assets) exactly as the render worker builds it."""
        from ai_clipper.edit_v2 import render_edit

        return render_edit.load_render_inputs(clip.job_dir, doc).plan

    def render(self, clip: Any, plan: Any, mode: str, name: str) -> Path:
        from ai_clipper.edit_v2 import compile_ffmpeg

        out = self.work / f"{name}.{mode}.{'mkv' if mode == 'reference' else 'mp4'}"
        self.lg.run_to(compile_ffmpeg.compile_job(
            plan, mode=mode, source=clip.source,
            assets_root=clip.job_dir / "analysis" / "assets"), out)
        return out

    def plate_frames(self, clip: Any, plan: Any, key: str, size: int) -> Iterator[bytes]:
        """The lane's plate frames (raw yuv420p) in output order, as the player shows them."""
        from ai_clipper.edit_v2 import timemap as tm

        cache: dict[int, list[bytes]] = {}
        for n in range(plan.total_frames):
            sf = tm.out_to_src(n, plan.pieces)[1]
            k = sf // size
            if k not in cache:
                cache.clear()
                cache[k] = self.fi.decode_yuv420(
                    clip.preview / "plates" / self.lg.plates.cell_name(key, k), plan.output)
            frames = cache[k]
            yield frames[sf % size] if sf % size < len(frames) else b""

    def cases(self, real: Sequence[tuple], synthetic: Sequence[tuple]) -> list[tuple]:
        """The cases of ``--media``: the real table as is, or the synthetic one with each job
        name replaced by the id of its prepared barcode job."""
        if self.media == "real":
            return list(real)
        names = sorted({case[0] for case in synthetic})
        jobs = self.synthetic(names, size=SYNTHETIC_PERF_SIZE)
        return [(jobs[case[0]], *case[1:]) for case in synthetic]

    def synthetic(self, names: Sequence[str], size: tuple[int, int] = (640, 360)) -> dict:
        """The synthetic barcode + column-ruler jobs of ``make_job.py``, copied into the jobs
        root and prepared (seeds, words, peaks; face-track seeds get their camera plan)."""
        make_job = _load("editor_fixture_make_job",
                         ROOT / "scripts" / "editor_fixture" / "make_job.py")
        from ai_clipper.edit_v2 import seed as seed_module

        out = self.work / "synthetic"
        index = make_job.build(out, size=size, only=list(names), force=True)
        jobs = {}
        for name in names:
            entry = index["jobs"][name]
            target = self.jobs_root / entry["id"]
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(out / entry["dir"], target, symlinks=False)
            seed_module.prepare_legacy_job(target)
            jobs[name] = entry["id"]
        return jobs

    # switch -----------------------------------------------------------------------------------

    def cell_ready(self, clip: Any, doc: Mapping[str, Any], playhead: int, cell: int, path: Path,
                   began: float, timeout_s: float = 120.0) -> tuple[float | None, float | None]:
        """Seconds from ``began`` until the playhead's cell file exists and until the editor sees
        it: the plan asked again every ``STORE_POLL_S`` (as the store polls) says it is ready."""
        on_disk = visible = None
        next_poll = time.perf_counter() + STORE_POLL_S
        while time.perf_counter() - began < timeout_s:
            if on_disk is None and path.exists():
                on_disk = time.perf_counter() - began
            if time.perf_counter() >= next_poll:
                status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc, playhead=playhead)
                if status == 200 and any(c["k"] == cell and c["state"] == "ready"
                                         for c in dto["plate"]["cells"]):
                    visible = time.perf_counter() - began
                    break
                next_poll = time.perf_counter() + STORE_POLL_S
            time.sleep(0.01)
        return on_disk, visible

    def switch(self) -> dict[str, Any]:
        cases = []
        for job, rank, layout, where in self.cases(SWITCH_CASES, SWITCH_SYNTHETIC):
            clip = self.clip(job, rank)
            self.lg.clear_preview(clip)
            seed_layout = clip.seed["layout"]["default"]["mode"]
            total = clip.plan(clip.seed, camera=self.lg.plates.camera_for(
                clip.dir, clip.seed)[0]).total_frames
            playhead = min(total - 1, int(total * where))
            # the editor is open at the seed layout: its playhead cell is up, the lane is
            # building the rest in the background when the switch comes
            opened = clip.revision()
            status, dto, _ms = self.app.plan(clip.job_id, clip.id, opened, playhead=playhead)
            if status != 200:
                cases.append({"clip": f"{job[:8]}#{rank}", "error": f"open {status}",
                              "pass": False})
                continue
            first = clip.preview / "plates" / self.lg.plates.cell_name(
                dto["plate"]["plateKey"], _cell_of(dto, playhead))
            opened_s = self.lg.wait_for([first], 60)
            time.sleep(1.0)
            if layout == "camera":
                for path in clip.dir.glob("camera.*.json"):
                    if clip.seed["base"]["camera"]["sha256"] is None:
                        path.unlink()
            doc = self.switched(clip, layout)
            began = time.perf_counter()
            analysis = self.prepared_camera(clip) if layout == "camera" else {}
            status, dto, plan_ms = self.app.plan(clip.job_id, clip.id, doc, playhead=playhead)
            if status != 200:
                cases.append({"clip": f"{job[:8]}#{rank}", "error": f"plan {status}",
                              "pass": False})
                continue
            cell = _cell_of(dto, playhead)
            path = clip.preview / "plates" / self.lg.plates.cell_name(dto["plate"]["plateKey"],
                                                                      cell)
            on_disk, visible = self.cell_ready(clip, doc, playhead, cell, path, began)
            seconds = visible
            entry = {"clip": f"{job[:8]}#{rank}", "from": seed_layout, "to": layout,
                     "fps": list(clip.seed["output"]["fps"]),
                     "clip_seconds": round(total * clip.fps.den / clip.fps.num, 1),
                     "playhead": playhead, "cell": cell,
                     "opened_first_cell_s": None if opened_s is None else round(opened_s, 2),
                     "plan_ms": round(plan_ms, 1),
                     "first_cell_after_switch_s": None if seconds is None else round(seconds, 2),
                     "cell_on_disk_s": None if on_disk is None else round(on_disk, 2),
                     **analysis}
            entry["gated"] = layout in ("fit_blur", "fill_center")
            entry["pass"] = seconds is not None and (not entry["gated"]
                                                     or seconds <= SWITCH_BUDGET_S)
            cases.append(entry)
            print(json.dumps(entry), flush=True)
        def seconds_to(layout: str) -> list[float]:
            return [c["first_cell_after_switch_s"] for c in cases if c.get("to") == layout
                    and c.get("first_cell_after_switch_s") is not None]

        gated = seconds_to("fit_blur") + seconds_to("fill_center")
        return {"budget_s": SWITCH_BUDGET_S, "cases": cases,
                "fit_blur_center_crop_s": summary(gated) if gated else None,
                "by_layout_s": {layout: summary(seconds_to(layout)) if seconds_to(layout) else None
                                for layout in LAYOUTS},
                "pass": bool(gated) and all(c.get("pass") for c in cases)}

    # PF-CELLS ---------------------------------------------------------------------------------

    def pf_cells(self) -> dict[str, Any]:
        cases = []
        for job, rank, layout in self.cases(PF_CELLS_CASES, PF_CELLS_SYNTHETIC):
            clip = self.clip(job, rank)
            self.lg.clear_preview(clip)
            built_camera = False
            if layout == "camera" and clip.seed["base"]["camera"]["sha256"] is None:
                for path in clip.dir.glob("camera.*.json"):
                    path.unlink()
                built_camera = True
            doc = self.switched(clip, layout)
            began = time.perf_counter()
            status, _prepared, prepare_ms = self.app.prepare(clip.job_id, clip.id, layout)
            if status != 202:
                cases.append({"clip": f"{job[:8]}#{rank}", "error": f"prepare {status}",
                              "pass": False})
                continue
            status, dto, plan_ms = self.app.plan(clip.job_id, clip.id, doc, playhead=0)
            if status != 200:
                cases.append({"clip": f"{job[:8]}#{rank}", "error": f"plan {status}",
                              "pass": False})
                continue
            first = self.lg.wait_for([clip.preview / "plates" / self.lg.plates.cell_name(
                dto["plate"]["plateKey"], _cell_of(dto, 0))], 300)
            first_s = None if first is None else time.perf_counter() - began
            done = self.all_cells(clip, dto, 600)
            elapsed = time.perf_counter() - began
            budget = PF_CELLS_BUDGET_S[layout]
            clip_seconds = dto["totalFrames"] * clip.fps.den / clip.fps.num
            projected = None if done is None else elapsed * max(1.0, PF_CELLS_NOMINAL_S
                                                                 / clip_seconds)
            entry = {"clip": f"{job[:8]}#{rank}", "from": clip.seed["layout"]["default"]["mode"],
                     "to": layout, "clip_seconds": round(clip_seconds, 2),
                     "cells": len(dto["plate"]["cells"]), "camera_plan_built": built_camera,
                     "prepare_ms": round(prepare_ms, 1), "plan_ms": round(plan_ms, 1),
                     "first_cell_s": None if first_s is None else round(first_s, 2),
                     "all_cells_s": None if done is None else round(elapsed, 2),
                     "projected_60s_s": None if projected is None else round(projected, 2),
                     "budget_s": budget,
                     "pass": done is not None and elapsed <= budget and projected <= budget}
            cases.append(entry)
            print(json.dumps(entry), flush=True)
            time.sleep(5)  # let the background mix of the case finish
        by_layout = {layout: bool([c for c in cases if c.get("to") == layout])
                     and all(c.get("pass") for c in cases if c.get("to") == layout)
                     for layout in LAYOUTS}
        return {"threshold_s": PF_CELLS_BUDGET_S, "heavy_slots": 2,
                "nominal_clip_s": PF_CELLS_NOMINAL_S, "cases": cases, "pass_by_layout": by_layout,
                "pass": bool(cases) and all(c.get("pass") for c in cases)}

    # P-PLATE ----------------------------------------------------------------------------------

    def p_plate(self) -> dict[str, Any]:
        jobs = self.synthetic(["main"])
        ruler = self.clip(jobs["main"], 1)
        self._sweep_camera(ruler)
        cases = [self._plate_case(ruler, layout, ruler=True) for layout in LAYOUTS]
        for job, rank, layouts in (P_PLATE_REAL if self.media == "real" else ()):
            clip = self.clip(job, rank)
            for layout in layouts:
                cases.append(self._plate_case(clip, layout, ruler=False))
        by_layout = {layout: all(c["pass"] for c in cases if c.get("layout") == layout)
                     for layout in LAYOUTS}
        return {"threshold": {"ssim_margin": P_PLATE_SSIM_MARGIN, "crop_x_px": 0},
                "cases": cases, "pass_by_layout": by_layout,
                "pass": bool(cases) and all(c.get("pass") for c in cases)}

    def _sweep_camera(self, clip: Any) -> None:
        """A camera plan for the ruler clip's window that sweeps the crop, so crop x changes on
        almost every frame (as ``prepare`` would write it: content-named, 0600)."""
        window = clip.seed["base"]["window_ms"]
        samples, cuts = [], []
        for index, t_ms in enumerate(range(window[0], window[1], 750)):
            phase = index % 16
            samples.append([t_ms, 150 + (phase if phase < 8 else 16 - phase) * 90])
            cuts.append(index > 0 and index % 8 == 0)
        plan = {"schema": "potongin.camera-plan/1",
                "source_content_sha256": clip.seed["base"]["source"]["content_sha256"],
                "window_ms": list(window), "fps": list(clip.seed["output"]["fps"]),
                "source": {"w": clip.seed["base"]["source"]["w"],
                           "h": clip.seed["base"]["source"]["h"]},
                "output": {"w": clip.seed["output"]["w"], "h": clip.seed["output"]["h"]},
                "sample_ms": 750, "samples": samples, "cuts": cuts, "no_face": []}
        for path in clip.dir.glob("camera.*.json"):
            path.unlink()
        raw = camera_module.encode_camera_plan(plan)
        path = clip.dir / camera_module.camera_file_name(raw)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)

    def _plate_case(self, clip: Any, layout: str, *, ruler: bool) -> dict[str, Any]:
        from ai_clipper.edit_v2 import layouts as layout_module
        from ai_clipper.edit_v2 import timemap as tm

        name = f"plate-{clip.id}-{layout}"
        label = {"clip": f"{clip.job_id[:8]}#{clip.seed['base']['origin']['rank_at_seed']}",
                 "from": clip.seed["layout"]["default"]["mode"], "layout": layout,
                 "ruler": ruler}
        self.lg.clear_preview(clip)
        if layout == "camera" and not ruler:
            label.update(self.prepared_camera(clip))
        doc = self.switched(clip, layout, removals=10, text=False)
        status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc, playhead=0)
        if status != 200:
            return {**label, "error": f"plan {status}", "pass": False}
        if self.all_cells(clip, dto, 900) is None:
            return {**label, "error": "cells timeout", "pass": False}
        plan = self.export_plan(clip, doc)
        key, size = dto["plate"]["plateKey"], dto["plate"]["cellFrames"]
        reference = self.render(clip, plan, "reference", name)
        final = self.render(clip, plan, "final", name)
        ssim_final = self.fi.ssim_files(final, reference)
        ssim_plate = self.fi.ssim_stream(self.plate_frames(clip, plan, key, size), plan.output,
                                         tuple(plan.fps.to_json()), reference, self.work)
        entry = {**label, "output_frames": plan.total_frames, "pieces": len(plan.pieces),
                 "plate_cells": len(dto["plate"]["cells"]),
                 "export_plan_equals_lane_pieces": [p.to_dto() for p in plan.pieces]
                 == dto["pieces"],
                 "ssim_final_vs_reference": ssim_final, "ssim_plate_vs_reference": ssim_plate,
                 "ssim_margin": round(ssim_plate["All"]
                                      - (ssim_final["All"] - P_PLATE_SSIM_MARGIN), 6)}
        ok = (ssim_plate["All"] >= ssim_final["All"] - P_PLATE_SSIM_MARGIN
              and entry["export_plan_equals_lane_pieces"])
        if ruler and layout in ("fill_center", "camera"):
            source_size = (clip.seed["base"]["source"]["w"], clip.seed["base"]["source"]["h"])
            case = self.fi.Case("switch", tuple(plan.fps.to_json()), 0, layout,
                                source_size=source_size, output=plan.output)
            crop_x = self.fi.crop_decoder(case)
            scaled = layout_module.scaled_size(source_size, plan.output)
            table = (layout_module.crop_positions(plan.camera, plan.fps, source=source_size,
                                                  output=plan.output, first_sf=0,
                                                  count=max(p.out_sf for p in plan.pieces))
                     if layout == "camera" else None)
            centre = (scaled[0] - plan.output[0]) // 2
            mismatches = {"plate": 0, "reference": 0, "final": 0}
            undecodable = 0
            distinct = set()
            cut_frames = cell_edge_frames = 0
            streams = zip((self.fi.gray_of_yuv420(f, plan.output)
                           for f in self.plate_frames(clip, plan, key, size)),
                          self.fi.iter_gray_frames(reference, plan.output),
                          self.fi.iter_gray_frames(final, plan.output))
            for n, planes in enumerate(streams):
                piece, sf = tm.out_to_src(n, plan.pieces)
                want = table[sf] if table is not None else centre
                distinct.add(want)
                cut_frames += n in (piece.out_f0, piece.out_f0 + piece.frames - 1)
                cell_edge_frames += sf % size in (0, size - 1)
                for stream, plane in zip(("plate", "reference", "final"), planes):
                    got = crop_x(plane)
                    undecodable += got is None
                    mismatches[stream] += got != want
            entry.update(crop_x_mismatches=mismatches, crop_x_frames_checked=plan.total_frames,
                         crop_x_undecodable=undecodable, distinct_crop_x=len(distinct),
                         cut_frames=cut_frames, cell_edge_frames=cell_edge_frames)
            ok = ok and not any(mismatches.values())
        reference.unlink()
        final.unlink()
        entry["pass"] = ok
        print(json.dumps({k: v for k, v in entry.items() if not k.startswith("ssim_")}),
              flush=True)
        return entry

    # P-FRAME ----------------------------------------------------------------------------------

    def p_frame(self) -> dict[str, Any]:
        from support import edit_v2_media as media

        from ai_clipper.edit_v2 import timemap as tm

        jobs = self.synthetic(P_FRAME_JOBS)
        results = []
        for name in P_FRAME_JOBS:
            clip = self.clip(jobs[name], 1)
            fps = tuple(clip.seed["output"]["fps"])
            grid = media.grid_indices(clip.source, fps)
            first = media.grid_range(clip.source, fps)[0]
            source_size = (clip.seed["base"]["source"]["w"], clip.seed["base"]["source"]["h"])

            def at(sf: int, grid=grid, first=first) -> int | None:
                return grid[sf - first] if first <= sf < first + len(grid) else None

            for layout in LAYOUTS:
                self.lg.clear_preview(clip)
                label = {"job": name, "fps": list(fps), "hook": False, "from":
                         clip.seed["layout"]["default"]["mode"], "layout": layout}
                if layout == "camera":
                    label.update(self.prepared_camera(clip))
                # captions stay (bottom); the hook box would cover the index bands at the top of
                # the crop layouts (W1: "frames under the hook of the crop layouts not checked")
                doc = self.switched(clip, layout, removals=20, hook=False)
                status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc, playhead=0)
                if status != 200 or self.all_cells(clip, dto, 900) is None:
                    results.append({**label, "error": f"plan {status} or cells", "pass": False})
                    continue
                plan = self.export_plan(clip, doc)
                case = self.fi.Case(name, fps, 0, layout, source_size=source_size,
                                    output=plan.output)
                index_of = self.fi.index_decoder(case)
                expected = [at(tm.out_to_src(n, plan.pieces)[1]) for n in range(plan.total_frames)]
                key, size = dto["plate"]["plateKey"], dto["plate"]["cellFrames"]
                plate = [index_of(self.fi.gray_of_yuv420(f, plan.output)) if f else None
                         for f in self.plate_frames(clip, plan, key, size)]
                final_path = self.render(clip, plan, "final", f"pframe-{name}-{layout}")
                final = [index_of(p) for p in self.fi.iter_gray_frames(final_path, plan.output)]
                final_path.unlink()
                entry = {**label, "pieces": len(plan.pieces),
                         "removals": len(plan.doc["main"]["removals"]),
                         "cold_open": any(s["role"] == "cold_open"
                                          for s in plan.doc["main"]["segments"]),
                         "output_frames": plan.total_frames,
                         "expected_undecodable": sum(v is None for v in expected),
                         "plate_mismatches": sum(a is None or a != b
                                                 for a, b in zip(plate, expected)),
                         "final_frames": len(final),
                         "final_mismatches": sum(a is None or a != b
                                                 for a, b in zip(final, expected))
                         + abs(len(final) - plan.total_frames)}
                entry["pass"] = (not entry["plate_mismatches"] and not entry["final_mismatches"]
                                 and not entry["expected_undecodable"])
                results.append(entry)
                print(json.dumps(entry), flush=True)
        per_layout = {}
        for layout in LAYOUTS:
            rows = [r for r in results if r.get("layout") == layout]
            frames = sum(r.get("output_frames", 0) for r in rows)
            per_layout[layout] = {
                "cases": len(rows), "plate_frames": frames,
                "final_frames": sum(r.get("final_frames", 0) for r in rows),
                "plate_mismatches": sum(r.get("plate_mismatches", 0) for r in rows),
                "final_mismatches": sum(r.get("final_mismatches", 0) for r in rows),
                "pass": bool(rows) and all(r["pass"] for r in rows)
                and frames >= P_FRAME_MIN_FRAMES}
        return {"threshold": {"min_frames_per_layout": P_FRAME_MIN_FRAMES, "mismatches": 0},
                "cases": results, "per_layout": per_layout,
                "pass": all(entry["pass"] for entry in per_layout.values())}


if __name__ == "__main__":
    sys.exit(main())
