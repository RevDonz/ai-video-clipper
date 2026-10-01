"""Plate cells of the preview lane: identity, names, cell sets, camera plans and builds
(plan §3.4 "Plate cells", §4.1 ``preview/plates``, §5.1 ``plate_cells``, §2.6; owner T2.3).

A plate cell is ``cell_frames`` source-grid frames ``[k·C, (k+1)·C)`` run through the layout
graph of the final render, **without text, logo or audio**, and encoded as one short H.264 file
(``compile_ffmpeg`` mode ``plate_cells``). A cell's pixels depend only on the source, the
document's frame rate, output size and layout (plus the camera plan for face-track), the
first frame of the clip window (the clone padding below it) and the toolchain, never on cuts,
captions, the hook, the logo or the audio. So cells are cached under a **plate key** of exactly
those inputs, and an edit of the cuts reuses every cell it still shows.

* ``plate_key`` is ``sha256`` of the canonical identity (``PLATE_SCHEMA``): the compiler version
  and render semantics, the composite format and the plate encode, the lane's thread count (x264
  bits depend on it), the source content, the window's first grid frame, fps, output size,
  layout, the camera plan's sha (camera layout only) and ``toolchain.json``'s sha.
* ``cell_name`` is the flat file name ``<key16>-c<k:07d>.mp4`` under ``preview/plates``.
* ``camera_for`` finds the camera plan of a document: the one ``base.camera.sha256`` names, else
  (a clip seeded with another layout and switched to face-track in the editor) the valid plan of
  this clip's window that ``prepare`` wrote. Camera files are immutable and content-named
  (``camera.<sha16>.json``, the first 16 hex of the sha256 of their bytes); a symlink, a file
  whose name is not its sha, or a plan for another window, rate, output or source is ignored.
* ``lane_threads`` caps a compiled job at the lane's 2 threads (plan §2.6 "``-threads 2``"):
  the decoder, the filter graph and x264. The final render keeps the compiler's 4.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
import stat
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from . import CAMERA_SCHEMA, COMPILER_VERSION, RENDER_SEMANTICS, errors
from . import timemap as tm
from .plan import RenderPlan, Resources
from .timemap import Fps, Piece

PLATE_SCHEMA = "potongin.plate/1"
LANE_THREADS = 2  # plan §2.6: the preview lane's FFmpeg processes use two threads each
CELL_FILE = re.compile(r"([0-9a-f]{16})-c([0-9]{7})\.mp4")
CAMERA_FILE = re.compile(r"camera\.([0-9a-f]{16})\.json")
MAX_CAMERA_BYTES = 4 << 20
MAX_JOB_BYTES = 4 << 20
MAX_CELL = 9_999_999
_HEX64 = re.compile(r"[0-9a-f]{64}")
_THREAD_OPTIONS = ("-threads", "-filter_complex_threads")
_X264_THREADS = re.compile(r"threads=\d+")


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def plate_key(doc: Mapping[str, Any], *, camera_sha256: str | None = None,
              toolchain_sha256: str | None = None) -> str:
    """The cache key of the plate cells a document shows (see the module docstring).

    Raises ``ValueError`` for the camera layout without ``camera_sha256`` and for a malformed
    sha.
    """
    from .compile_ffmpeg import COMPOSITE_FORMAT, FINAL_SCALE_FLAGS, PLATE

    layout = doc["layout"]["default"]["mode"]
    for name, value in (("camera_sha256", camera_sha256), ("toolchain_sha256", toolchain_sha256)):
        if value is not None and not (isinstance(value, str) and _HEX64.fullmatch(value)):
            raise ValueError(f"{name} must be 64 lowercase hex digits")
    if layout == "camera" and camera_sha256 is None:
        raise ValueError("the camera layout needs its camera plan")
    fps = Fps.from_json(doc["output"]["fps"])
    identity = {
        "schema": PLATE_SCHEMA,
        "compiler": COMPILER_VERSION,
        "render_semantics": RENDER_SEMANTICS,
        "composite": COMPOSITE_FORMAT,
        "scale_flags": FINAL_SCALE_FLAGS,
        "encode": [PLATE[0], PLATE[1], LANE_THREADS],
        "source": doc["base"]["source"]["content_sha256"],
        "window_first_sf": tm.sf_floor(doc["base"]["window_ms"][0], fps),
        "fps": fps.to_json(),
        "output": [doc["output"]["w"], doc["output"]["h"]],
        "layout": layout,
        "camera": camera_sha256 if layout == "camera" else None,
        "toolchain": toolchain_sha256,
    }
    return hashlib.sha256(_canonical(identity)).hexdigest()


def cell_name(key: str, k: int) -> str:
    """``<key16>-c<k:07d>.mp4``: the flat name of cell ``k`` of plate ``key`` (plan §4.1)."""
    if not (isinstance(key, str) and _HEX64.fullmatch(key)):
        raise ValueError("the plate key must be 64 lowercase hex digits")
    if type(k) is not int or not 0 <= k <= MAX_CELL:
        raise ValueError("a cell index is an integer in [0, 9999999]")
    return f"{key[:16]}-c{k:07d}.mp4"


def cells_for_pieces(pieces: Sequence[Piece], fps: Fps) -> tuple[int, ...]:
    """The cells that hold the frames of ``pieces``, each once, in output order."""
    size = tm.cell_frames(Fps.from_json(fps))
    cells: dict[int, None] = {}
    for piece in pieces:
        for k in range(piece.in_sf // size, (piece.out_sf - 1) // size + 1):
            cells.setdefault(k, None)
    return tuple(cells)


# --- camera plans ----------------------------------------------------------------------------------


def _read_plan(path: Path) -> tuple[dict, str] | None:
    """A camera plan file: (plan, sha256 of its bytes) when it is a regular file (not a
    symlink) whose name is ``camera.<sha16>.json`` of its own bytes, else None."""
    match = CAMERA_FILE.fullmatch(path.name)
    if match is None:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CAMERA_BYTES:
            return None
        chunks = []
        while chunk := os.read(fd, 1 << 20):
            chunks.append(chunk)
    finally:
        os.close(fd)
    raw = b"".join(chunks)
    sha = hashlib.sha256(raw).hexdigest()
    if sha[:16] != match.group(1):
        return None
    try:
        plan = json.loads(raw)
    except ValueError:
        return None
    return (plan, sha) if isinstance(plan, dict) else None


def _matches(plan: Mapping[str, Any], doc: Mapping[str, Any]) -> bool:
    base = doc["base"]
    return (plan.get("schema") == CAMERA_SCHEMA
            and plan.get("window_ms") == list(base["window_ms"])
            and plan.get("fps") == list(doc["output"]["fps"])
            and plan.get("output") == {"w": doc["output"]["w"], "h": doc["output"]["h"]}
            and plan.get("source_content_sha256") == base["source"]["content_sha256"]
            and isinstance(plan.get("samples"), list) and isinstance(plan.get("cuts"), list))


def camera_for(clip_dir: Path, doc: Mapping[str, Any]) -> tuple[dict | None, str | None]:
    """``(camera plan, its sha256)`` for ``doc``'s layout; ``(None, None)`` for the layouts
    without a camera. Raises ``AnalysisMissing`` (``ref="camera"``) when the face-track layout
    has no usable plan yet (``prepare`` with ``layout: "camera"`` builds it)."""
    if doc["layout"]["default"]["mode"] != "camera":
        return None, None
    clip_dir = Path(clip_dir)
    named = doc["base"]["camera"]["sha256"]
    if isinstance(named, str) and _HEX64.fullmatch(named):
        found = _read_plan(clip_dir / f"camera.{named[:16]}.json")
        if found is not None and found[1] == named and _matches(found[0], doc):
            return found
    try:
        names = sorted(entry.name for entry in os.scandir(clip_dir)
                       if CAMERA_FILE.fullmatch(entry.name))
    except OSError:
        names = []
    for name in names:
        found = _read_plan(clip_dir / name)
        if found is not None and _matches(found[0], doc):
            return found
    raise errors.AnalysisMissing("analysis_missing", path="/layout/default/mode", ref="camera")


# --- plans, jobs and builds --------------------------------------------------------------------------


def plate_plan(doc: Mapping[str, Any], *, camera: Mapping[str, Any] | None,
               resources: Resources) -> RenderPlan:
    """The part of a render plan that ``compile_job(mode="plate_cells")`` reads: the document
    (base, window, output, layout), fps, output size, the camera plan and the resources. Cells
    need no captions, envelopes or assets."""
    fps = Fps.from_json(doc["output"]["fps"])
    pieces = tm.pieces(doc)
    total = tm.total_frames(pieces)
    layout = doc["layout"]["default"]["mode"]
    return RenderPlan(doc=doc, fps=fps, output=(doc["output"]["w"], doc["output"]["h"]),
                      pieces=pieces, total_frames=total, total_samples=tm.smp(total, fps),
                      speech_spans=(), assets={}, plan_sha256="",
                      camera=camera if layout == "camera" else None, resources=resources)


def lane_threads(job: Any, threads: int = LANE_THREADS) -> Any:
    """``job`` (an ``FfmpegJob``) with every thread setting at ``threads``: each ``-threads``
    and ``-filter_complex_threads`` value and x264's ``threads=`` parameter. Raises
    ``ValueError`` when the job has no ``-filter_complex_threads`` (not a compiled job)."""
    if type(threads) is not int or threads < 1:
        raise ValueError("threads must be a positive integer")
    argv = list(job.argv)
    if "-filter_complex_threads" not in argv:
        raise ValueError("not a compiled FFmpeg job (no -filter_complex_threads)")
    for index, token in enumerate(argv[:-1]):
        if token in _THREAD_OPTIONS:
            argv[index + 1] = str(threads)
        elif token == "-x264-params":
            argv[index + 1] = _X264_THREADS.sub(f"threads={threads}", argv[index + 1])
    return dataclasses.replace(job, argv=tuple(argv))


def build_cells(plan: RenderPlan, *, source: Path, assets_root: Path, cells: Sequence[int],
                cancel: threading.Event | None = None,
                timeout_s: float = 300.0) -> dict[int, bytes]:
    """Encode ``cells`` of ``plan`` in one FFmpeg run at the lane's thread count; returns the
    bytes of each cell (``k -> mp4``). Raises ``RenderFailed``/``Cancelled`` (``execute.run``)
    and ``ValueError`` for cells outside the source or wholly below the window."""
    from . import execute
    from .compile_ffmpeg import compile_job

    wanted = sorted(set(cells))
    job = lane_threads(compile_job(plan, mode="plate_cells", source=Path(source),
                                   assets_root=Path(assets_root), cells=wanted))
    result = execute.run(job, output_fd=None, timeout_s=timeout_s, cancel=cancel)
    return {k: result.outputs[f"c{k:07d}.mp4"] for k in wanted}


# --- the job's source -------------------------------------------------------------------------------


def source_path(job_dir: Path) -> Path:
    """The job source: ``job.json``'s ``sourcePath``, as a regular file (not a symlink) inside
    ``job_dir/input`` (the recorded absolute path, or its name inside ``input/`` when the job
    directory moved). ``NotFound`` otherwise."""
    from .source_info import read_regular

    job_dir = Path(job_dir)
    try:
        job = json.loads(read_regular(job_dir / "job.json", MAX_JOB_BYTES))
    except (OSError, ValueError, UnicodeDecodeError):
        raise errors.NotFound() from None
    recorded = job.get("sourcePath") if isinstance(job, dict) else None
    if not isinstance(recorded, str) or not recorded or "\0" in recorded:
        raise errors.NotFound()
    input_dir = job_dir / "input"
    try:
        if not stat.S_ISDIR(os.lstat(input_dir).st_mode):
            raise errors.NotFound()
    except OSError:
        raise errors.NotFound() from None
    real_input = os.path.realpath(input_dir)
    candidates = [input_dir / Path(recorded).name]
    if Path(recorded).is_absolute():
        candidates.insert(0, Path(recorded))
    for candidate in candidates:
        real = os.path.realpath(candidate)
        if os.path.commonpath([real, real_input]) != real_input or real == real_input:
            continue
        try:
            if stat.S_ISREG(os.lstat(candidate).st_mode):
                return candidate
        except OSError:
            continue
    raise errors.NotFound()


__all__ = [
    "CAMERA_FILE",
    "CELL_FILE",
    "LANE_THREADS",
    "PLATE_SCHEMA",
    "build_cells",
    "camera_for",
    "cell_name",
    "cells_for_pieces",
    "lane_threads",
    "plate_key",
    "plate_plan",
    "source_path",
]
