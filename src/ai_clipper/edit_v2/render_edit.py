"""Revision 0, editor exports and the auto-render engine switch (plan §5.8, §4.6, R10).

Owner: T2.1 (wave W2). Every render of a document goes through :func:`render_document`:
``load_render_inputs`` (words, camera plan, assets, validation, ``plan.build_plan``) → the
loudness/peak measurement when the document needs one → ``compile_ffmpeg.compile_job`` in
``final`` mode → ``execute.run`` into a private sibling temporary → ``verify.verify_output``
(G1–G3, G3b block; G5 warns) → no-clobber publication of the MP4 and its ``.srt`` (the frame
cues, ``RenderPlan.srt``). Nothing is published unless the blocking gates pass.

**The pipeline (auto render, plan §5.8).** With ``POTONGIN_RENDER_ENGINE=edit-v2``
(:func:`engine_from_env`; anything else, including unset, is ``legacy``) the V3 pipeline builds
one :class:`AutoRenderer` per job, schedules every clip (:meth:`AutoRenderer.schedule`: several
clips at once, T4.3) and takes each clip's result with :meth:`AutoRenderer.render`. It reads back
what the pipeline wrote (``output/transcript.json``, ``analysis/selection.v3.json``,
``analysis/audio-timeline.json``, ``analysis/sound-events.json``), so the seed of a new job and
the seed ``prepare`` would build for the same job use the same inputs. Per clip it writes
``analysis/source.json`` (once per job), the peaks, the words artifact, the camera plan
(face-track only) and ``seed.json`` (``seed.build_seed``, engine ``edit-v2/1``, editor
``pipeline/edit-v2/1``), each immutable, then renders **from the seed file** into
``output/clip-NN.mp4``. When the new engine fails for a clip the pipeline renders that clip
with the legacy engine (``engine_fallback:<rank>``); :meth:`AutoRenderer.fallback` first removes
the ``seed.json`` this run wrote for it, so no seed claims the new engine for a legacy file (the
editor's ``prepare`` later seeds it as a legacy-engine clip; the analysis files stay).

**Exports (plan §4.6).** :func:`render_request` runs one ``render-request-v3`` for the
render-worker: it checks every field it reads before any work (``RenderFailed``,
``ref="request"``), loads the archived document (``doc_relative``) and checks its sha,
revision and clip id (``ref="document"``), then, in this order:

1. an export already published at ``output_relative`` that passes G1–G2 is reused
   (``reused="existing"``);
2. **R10**: when the document's content equals the seed, the auto file itself
   (``output/clip-NN.mp4`` and its ``.srt``, found through the manifest) is re-verified and
   hard-linked to ``output_relative`` (``reused="auto_file"``), whatever the toolchain or engine
   version. An edit-v2 auto file is re-verified with G1–G2 against the seed's plan; a
   legacy-engine auto file (a job rendered before the switch, or a fallback clip) with the legacy
   contract (H.264/AAC, size, SAR 1:1, duration within 0.25 s of the manifest). A missing or
   failing auto file renders normally and the result carries ``auto_file_unavailable``;
3. otherwise the document is rendered and published at ``output_relative`` (the name carries the
   request's render key, R9), from the source snapshot when the request names one (its content
   sha is checked) or else from the job's own source.

``heartbeat(stage, progress_pm)`` receives ``("merender", 0…1000)`` while FFmpeg runs,
``("memverifikasi", 1000)`` before the gates and ``("selesai", 1000)`` at the end; ``cancel``
kills FFmpeg (``Cancelled``) and nothing is published.

The render key (R9) needs ``resources/toolchain.json`` (written at image build, never
committed): without it :func:`render_key_for` returns ``None`` and the manifest records
``render_key: null`` (local runs outside the image).
"""

from __future__ import annotations

import dataclasses
import errno
import gzip
import hashlib
import json
import math
import os
import re
import stat
import threading
import time
import zlib
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self

from .. import render as _legacy
from ..audio_timeline import AudioTimeline
from ..face_window import cpu_budget
from ..selection_v3 import SELECTION_ARTIFACT_RELATIVE_PATH, selection_from_dict
from ..sound_events import events_from_dict
from ..transcript_io import MAX_TRANSCRIPT_BYTES, transcription_from_json_bytes
from . import COMPILER_ID, OUTPUT_SIZES, compile_ffmpeg, errors, execute, store, verify
from . import camera as _camera
from . import loudness as _loudness
from . import seed as _seed
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN, manifest_clip_id
from .doc import MAX_DOC_BYTES, canonical_bytes, content_equals_seed, parse_doc, validate_doc
from .glyphs import RESOURCES_DIR
from .loudness import Loudness
from .peaks import build_peaks, peaks_file_name
from .plan import RenderPlan, Resources, build_plan, render_key, toolchain_sha256
from .source_info import (
    SourceInfoError,
    canonical_json,
    ensure_source_info,
    file_sha256,
    read_regular,
    sha256_hex,
    write_immutable,
)
from .timemap import Fps
from .transitions import CUT_JOIN, ColdOpenJoin
from .words import build_words_artifact, encode_words, words_file_name

ENGINE_ENV = "POTONGIN_RENDER_ENGINE"
ENGINE_LEGACY = "legacy"
ENGINE_EDIT_V2 = "edit-v2"
ENGINES = (ENGINE_LEGACY, ENGINE_EDIT_V2)
LEGACY_ENGINE_ID = "legacy"  # manifest render_engine / seed base.engine.compiler of old files

REQUEST_VERSION = "render-request-v3"
STAGES = ("antre", "merender", "memverifikasi", "selesai")  # plan §4.6
SIZE_OUTPUT = "output"  # the only export size in Essentials (K14)
PROGRESS_FULL = 1000

# Timeout of one render: max(120 s, 3 × predicted), predicted = output seconds × k(layout)
# (plan §4.6). k is the p95 real-time factor measured at W1 (0.35× fit-blur, synthetic source,
# 4 CPUs) rounded up for a loaded machine; FFmpeg must also report progress every 20 s.
MIN_TIMEOUT_S = 120.0
TIMEOUT_FACTOR = 3
PREDICTED_X = {"fit_blur": 0.5, "camera": 0.5, "fill_center": 0.4}
PIPELINE_MIN_TIMEOUT_S = float(_legacy.FFMPEG_TIMEOUT_SECONDS)  # never stricter than legacy
# PF-PIPELINE (T4.3): the auto render runs several clips at once. A "heavy slot" is one final
# encode or one camera plan, each about FFMPEG_THREADS CPUs busy (x264 and the filters at
# 4 threads; the Haar detection on 4 workers). Every FFmpeg argument stays as it was, so the
# pixels do not change; only the clips overlap. Four slots fill the K15 PC (16 threads): a
# job of four clips encodes them all at once (measured: 3 slots left the fourth clip alone).
RENDER_SLOTS_MAX = 4

MAX_JOB_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_SELECTION_BYTES = 8 * 1024 * 1024
MAX_AUDIO_TIMELINE_BYTES = 32 * 1024 * 1024
MAX_SOUND_EVENTS_BYTES = 8 * 1024 * 1024
MAX_CAMERA_BYTES = 4 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_DOC_BYTES
LOUDNESS_SCHEMA = "potongin.loudness/1"
ZERO_SHA = "0" * 64  # placeholder shas of the provisional seed (window, fps and clip id)

TRANSCRIPT_NAME = "transcript.json"
AUDIO_TIMELINE_RELATIVE_PATH = Path("analysis") / "audio-timeline.json"
SOUND_EVENTS_RELATIVE_PATH = Path("analysis") / "sound-events.json"
CLIPS_RELATIVE_PATH = Path("analysis") / "clips"
ASSETS_RELATIVE_PATH = Path("analysis") / "assets"
SEED_FILE = "seed.json"

_SHA = re.compile(r"[0-9a-f]{64}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_AUTO_NAME = re.compile(r"clip-[0-9]{2,4}\.mp4")
_ARCHIVE = re.compile(r"edit/archive/r(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})\.json\.gz")
_SNAPSHOT_EXTENSION = re.compile(r"[a-z0-9]{1,10}")
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
_FILE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)


def engine_from_env(env: Mapping[str, str] | None = None) -> str:
    """``"edit-v2"`` only when ``POTONGIN_RENDER_ENGINE`` is exactly that; else ``"legacy"``.

    The flag is fail-safe: unset, empty or an unknown value keeps today's engine (K1)."""
    value = (os.environ if env is None else env).get(ENGINE_ENV)
    return ENGINE_EDIT_V2 if value == ENGINE_EDIT_V2 else ENGINE_LEGACY


# --- results ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderResult:
    """One published render: the MP4 and its ``.srt`` (never clobbered)."""

    clip_id: str
    output: Path
    srt: Path
    render_engine: str  # COMPILER_ID, or the auto file's engine for an R10 link
    plan_sha256: str
    render_key: str | None  # None without resources/toolchain.json
    reused: str | None = None  # "auto_file" (R10), "existing" (a published export), None
    frames: int | None = None  # decoded video frames (G2); None for a legacy auto file
    samples: int | None = None  # decoded audio samples per channel (G2)
    elapsed_s: float = 0.0
    warnings: tuple[str, ...] = ()  # codes, detail after ":" (errors.message renders them)
    verify: Mapping[str, Any] | None = None  # VerifyReport.to_json(), None for a legacy file

    def to_json(self) -> dict[str, Any]:
        return {
            "clipId": self.clip_id, "output": str(self.output), "srt": str(self.srt),
            "renderEngine": self.render_engine, "planSha256": self.plan_sha256,
            "renderKey": self.render_key, "reused": self.reused, "frames": self.frames,
            "samples": self.samples, "elapsedS": round(self.elapsed_s, 3),
            "warnings": list(self.warnings),
            "verify": None if self.verify is None else dict(self.verify),
        }


@dataclass(frozen=True)
class RenderInputs:
    """Everything one document's render reads, resolved once (``load_render_inputs``)."""

    doc: Mapping[str, Any]
    clip_dir: Path
    seed: Mapping[str, Any] | None
    words: Mapping[str, Any]
    camera: Mapping[str, Any] | None
    assets: Mapping[str, Mapping[str, Any]]
    plan: RenderPlan
    resources: Resources


# --- inputs, keys and timeouts ------------------------------------------------------------------


def _fail(ref: str, code: str = "render_failed") -> errors.RenderFailed:
    return errors.RenderFailed(code, ref=ref)


def _clip_directory(job_dir: Path, value: object) -> Path:
    if not isinstance(value, str) or CLIP_ID_PATTERN.fullmatch(value) is None:
        raise errors.DocSemanticInvalid("range_invalid", path="/clip_id")
    return Path(job_dir) / CLIPS_RELATIVE_PATH / value


def _load_camera(clip_dir: Path, doc: Mapping[str, Any]) -> dict[str, Any]:
    """The camera plan of a camera-layout document: the seed's (``base.camera.sha256``), else
    the one prepared for this window, rate and size (a later layout switch, W3)."""
    sha = doc["base"]["camera"]["sha256"]
    if sha is not None:
        names = [f"camera.{sha[:16]}.json"]
    else:
        names = sorted(path.name for path in clip_dir.glob("camera.*.json"))
    for name in names:
        try:
            raw = read_regular(clip_dir / name, MAX_CAMERA_BYTES)
        except (OSError, ValueError):
            continue
        digest = sha256_hex(raw)
        if (sha is not None and digest != sha) or name != f"camera.{digest[:16]}.json":
            continue
        try:
            plan = json.loads(raw)
        except ValueError:
            continue
        if (sha is not None or (plan.get("window_ms") == list(doc["base"]["window_ms"])
                                and plan.get("fps") == list(doc["output"]["fps"])
                                and plan.get("output") == {"w": doc["output"]["w"],
                                                           "h": doc["output"]["h"]})):
            return plan
    raise errors.AnalysisMissing("analysis_missing", path="/layout/default/mode", ref="camera")


def load_render_inputs(job_dir: Path, doc: Mapping[str, Any], *,
                       resources: Resources | None = None, validate: bool = True) -> RenderInputs:
    """Words, camera plan, assets and seed of ``doc``'s clip, the semantic validation (every
    error raises ``DocSemanticInvalid`` with all issues) and the render plan."""
    resources = Resources(RESOURCES_DIR) if resources is None else resources
    clip_dir = _clip_directory(job_dir, doc.get("clip_id"))
    words = store.load_words(clip_dir, doc["base"]["words"]["sha256"])
    try:
        seed_doc: Mapping[str, Any] | None = store.seed(clip_dir)[0]
    except errors.NotFound:
        seed_doc = None
    camera = (_load_camera(clip_dir, doc)
              if doc["layout"]["default"]["mode"] == "camera" else None)
    assets = store.load_assets(clip_dir, doc.get("assets", {}).keys())
    if validate:
        validation = validate_doc(doc, words=words, assets=assets, seed=seed_doc)
        if validation.errors:
            first = validation.errors[0]
            raise errors.DocSemanticInvalid(first.code, path=first.path, ref=first.ref,
                                            issues=validation.errors)
    plan = build_plan(doc, words=words, camera=camera, assets=assets, resources=resources)
    return RenderInputs(doc, clip_dir, seed_doc, words, camera, assets, plan, resources)


def measure_sha256(measured: Loudness | None) -> str | None:
    """The loudness/peak measurement's part of the render key (R9); ``None`` when nothing was
    measured (revision-0 audio)."""
    if measured is None:
        return None
    return sha256_hex(canonical_json({"schema": LOUDNESS_SCHEMA, "i_clufs": measured.i_clufs,
                                      "tp_cdb": measured.tp_cdb}))


def render_key_for(plan: RenderPlan, measured: Loudness | None,
                   resources: Resources) -> str | None:
    """R9 for an Essentials export (the document's size, Standar); ``None`` without a pinned
    toolchain (``resources/toolchain.json``)."""
    try:
        toolchain = toolchain_sha256(resources)
    except FileNotFoundError:
        return None
    return render_key(plan, size=plan.output, quality="standar",
                      measure_sha=measure_sha256(measured), toolchain_sha=toolchain)


def render_slots(budget: int | None = None) -> int:
    """Heavy slots of the auto render (``AutoRenderer``): one per ``FFMPEG_THREADS`` CPUs of
    the CPU ``budget`` (default: this process's affinity, capped by a cgroup CPU quota), rounded
    up, at least 1 and at most ``RENDER_SLOTS_MAX``. Rounding up uses a quota of 6 CPUs fully
    (two clips at 4 threads each); one clip alone keeps about 4 CPUs busy."""
    budget = cpu_budget() if budget is None else budget
    if type(budget) is not int or budget < 1:
        raise ValueError("budget must be a positive integer")
    return max(1, min(RENDER_SLOTS_MAX, -(-budget // compile_ffmpeg.FFMPEG_THREADS)))


def render_timeout_s(doc: Mapping[str, Any]) -> float:
    """``max(120 s, 3 × predicted)`` with ``predicted = output seconds × k(layout)``."""
    fps = Fps.from_json(doc["output"]["fps"])
    frames = tm.total_frames(tm.pieces(doc))
    seconds = frames * fps.den / fps.num
    factor = PREDICTED_X.get(doc["layout"]["default"]["mode"], max(PREDICTED_X.values()))
    return max(MIN_TIMEOUT_S, TIMEOUT_FACTOR * seconds * factor)


def _measure(inputs: RenderInputs, source: Path, assets_root: Path,
             cancel: threading.Event | None, timeout_s: float) -> Loudness | None:
    if not _loudness.needs_measurement(inputs.doc):
        return None
    job = compile_ffmpeg.compile_job(inputs.plan, mode="audio_measure", source=source,
                                     assets_root=assets_root)
    result = execute.run(job, output_fd=None, timeout_s=timeout_s, cancel=cancel)
    return _loudness.parse_ebur128(result.stderr)


def _with_measurement(plan: RenderPlan, measured: Loudness | None) -> RenderPlan:
    """The plan with ``loudness_clamped_clufs`` set when the master stage cannot reach the
    target (G3 then checks the value reached)."""
    if measured is None:
        return plan
    gain, issues = _loudness.output_gain(plan.doc, measured)
    if any(errors.base_code(issue.code) == "loudness_clamped" for issue in issues):
        return dataclasses.replace(plan, loudness_clamped_clufs=measured.i_clufs + gain)
    return plan


# --- files -------------------------------------------------------------------------------------------


def _strict_json(raw: bytes) -> Any:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    def constant(_value: str) -> Any:
        raise ValueError("non-finite JSON number")

    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique, parse_constant=constant)


def _read_json(path: Path, limit: int) -> Any:
    try:
        return _strict_json(read_regular(path, limit))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return None


def job_id_for(artifact_root: Path) -> str | None:
    """The id of the job whose artifacts go to ``artifact_root``: the job directory itself
    (legacy runner) or a queue attempt ``<job>/.attempts/<attempt>`` of it. The id comes from
    the job's ``job.json`` and must name its directory; anything else is ``None``."""
    root = Path(artifact_root)
    candidates = [root]
    if root.parent.name == ".attempts":
        candidates.append(root.parent.parent)
    for directory in candidates:
        job = _read_json(directory / "job.json", MAX_JOB_BYTES)
        value = job.get("id") if isinstance(job, dict) else None
        if isinstance(value, str) and _UUID.fullmatch(value) and directory.name == value:
            return value
    return None


def _regular(path: Path) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def job_source(job_dir: Path) -> Path:
    """The job's own source: ``job.json``'s ``sourcePath``, a regular file inside ``input/``
    (the rule of ``seed.prepare_legacy_job``); ``RenderFailed(ref="source")`` otherwise."""
    job_dir = Path(job_dir)
    job = _read_json(job_dir / "job.json", MAX_JOB_BYTES)
    recorded = job.get("sourcePath") if isinstance(job, dict) else None
    input_dir = job_dir / "input"
    if isinstance(recorded, str) and recorded and "\0" not in recorded and not os.path.islink(
            input_dir) and input_dir.is_dir():
        real_input = os.path.realpath(input_dir)
        candidates = [input_dir / Path(recorded).name]
        if Path(recorded).is_absolute():
            candidates.insert(0, Path(recorded))
        for candidate in candidates:
            real = os.path.realpath(candidate)
            if os.path.commonpath([real, real_input]) == real_input and real != real_input \
                    and _regular(candidate):
                return candidate
    raise _fail("source")


def _checked_source(source: Path, expected_sha: str) -> Path:
    try:
        if file_sha256(source) == expected_sha:
            return source
    except (OSError, SourceInfoError):
        pass
    raise _fail("source")


def _ensure_directory(path: Path) -> None:
    """Create ``path`` (0700, parents too) unless it exists; symlinks are refused."""
    missing = []
    current = path
    while not os.path.lexists(current):
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            pass
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise _fail("output")


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]
    os.fsync(fd)


class _Destination:
    """``output`` and ``output.srt`` published from sibling temporaries without clobbering
    (``render.render_vertical``'s rules: ``O_EXCL`` temporaries, ``link`` into place, the
    directory fsynced; an existing destination or a symlink is ``RenderFailed(ref="output")``)."""

    def __init__(self, output: Path) -> None:
        self.output = Path(output).absolute()
        self.srt = self.output.with_suffix(".srt")
        if self.output.suffix != ".mp4":
            raise ValueError("the render output must be an .mp4 file")
        self.directory_fd = -1
        self.temps: dict[str, tuple[int, str]] = {}
        self.published: list[tuple[str, os.stat_result]] = []
        self.done = False

    def __enter__(self) -> Self:
        _ensure_directory(self.output.parent)
        try:
            self.directory_fd = os.open(self.output.parent, _DIRECTORY_FLAGS)
        except OSError as exc:
            raise _fail("output") from exc
        try:
            self.require_absent()
        except BaseException:
            os.close(self.directory_fd)
            raise
        return self

    def require_absent(self) -> None:
        for name in (self.srt.name, self.output.name):
            try:
                _legacy._require_destination_absent(self.directory_fd, name)
            except RuntimeError as exc:
                raise _fail("output") from exc

    def temp(self, kind: str) -> int:
        fd, name = _legacy._create_sibling_temp(self.directory_fd, f".{kind}")
        self.temps[kind] = (fd, name)
        return fd

    def link(self, source_name: str | Path, name: str, *, dir_fd: int | None) -> None:
        os.link(source_name, name, src_dir_fd=dir_fd, dst_dir_fd=self.directory_fd,
                follow_symlinks=False)
        self.published.append((name, os.stat(name, dir_fd=self.directory_fd,
                                             follow_symlinks=False)))

    def publish_temps(self) -> None:
        self.require_absent()
        self.link(self.temps["srt"][1], self.srt.name, dir_fd=self.directory_fd)
        self.link(self.temps["mp4"][1], self.output.name, dir_fd=self.directory_fd)
        os.fsync(self.directory_fd)
        self.done = True

    def __exit__(self, kind, _value, _traceback) -> None:
        try:
            if kind is not None or not self.done:
                for name, info in self.published:
                    _legacy._unlink_if_same(self.directory_fd, name, info)
            for fd, name in self.temps.values():
                os.close(fd)
                _legacy._unlink_quietly(self.directory_fd, name)
        finally:
            os.close(self.directory_fd)


def _open_regular(path: Path) -> int:
    fd = os.open(path, _FILE_FLAGS)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError(errno.EINVAL, "not a regular file")
    return fd


def verify_file(path: Path, plan: RenderPlan) -> verify.VerifyReport:
    """G1–G3/G3b (and G5 warnings) of a published file through its descriptor; a blocking
    failure raises ``VerificationFailed`` like ``verify.verify_output``."""
    fd = _open_regular(Path(path))
    try:
        return verify.verify_output(fd, plan, size=plan.output,
                                    normalize=plan.doc["audio"]["master"]["mode"] == "normalize")
    finally:
        os.close(fd)


def _codes(*groups) -> tuple[str, ...]:
    seen: dict[str, None] = {}
    for group in groups:
        for item in group:
            code = item if isinstance(item, str) else getattr(item, "code", None)
            if code is None and isinstance(item, Mapping):
                code = item.get("code")
            if isinstance(code, str):
                seen.setdefault(code, None)
    return tuple(seen)


# --- the render --------------------------------------------------------------------------------


def _render(inputs: RenderInputs, output: Path, *, source: Path, job_dir: Path,
            progress: Callable[[int], None] | None, stage: Callable[[str, int], None] | None,
            cancel: threading.Event | None, timeout_s: float | None,
            warnings: tuple[str, ...] = (),
            encode_slot: AbstractContextManager | None = None) -> RenderResult:
    started = time.monotonic()
    slot = nullcontext() if encode_slot is None else encode_slot
    timeout = render_timeout_s(inputs.doc) if timeout_s is None else float(timeout_s)
    assets_root = Path(job_dir) / ASSETS_RELATIVE_PATH
    with _Destination(output) as destination:
        measured = _measure(inputs, source, assets_root, cancel, timeout)
        plan = _with_measurement(inputs.plan, measured)
        key = render_key_for(plan, measured, inputs.resources)
        job = compile_ffmpeg.compile_job(plan, mode="final", source=source,
                                         assets_root=assets_root, loudness=measured)
        _write_all(destination.temp("srt"), str(job.expected["srt"]).encode("utf-8"))
        video_fd = destination.temp("mp4")
        total = max(plan.total_frames, 1)

        def frames_done(frames: int) -> None:
            if progress is not None:
                progress(min(PROGRESS_FULL, frames * PROGRESS_FULL // total))

        with slot:  # the encode only: the gates below run beside the next clip's encode
            execute.run(job, output_fd=video_fd, timeout_s=timeout, on_progress=frames_done,
                        cancel=cancel)
        os.fsync(video_fd)
        if stage is not None:
            stage("memverifikasi", PROGRESS_FULL)
        report = verify.verify_output(
            video_fd, plan, size=plan.output,
            normalize=plan.doc["audio"]["master"]["mode"] == "normalize")
        if cancel is not None and cancel.is_set():
            raise errors.Cancelled("cancelled")
        destination.publish_temps()
    counts = report.gate("G2")
    values = {} if counts is None else counts.values
    return RenderResult(
        clip_id=inputs.doc["clip_id"], output=destination.output, srt=destination.srt,
        render_engine=COMPILER_ID, plan_sha256=plan.plan_sha256, render_key=key,
        frames=values.get("frames"), samples=values.get("samples"),
        elapsed_s=time.monotonic() - started,
        warnings=_codes(warnings, plan.warnings, job.expected.get("warnings", ()),
                        report.warnings),
        verify=report.to_json())


def render_document(
    doc: Mapping[str, Any],
    job_dir: Path,
    output: Path,
    *,
    size: tuple[int, int],
    quality: str,
    progress: Callable[[int], None] | None = None,
    cancel: threading.Event | None = None,
    source: Path | None = None,
    resources: Resources | None = None,
    timeout_s: float | None = None,
    encode_slot: AbstractContextManager | None = None,
) -> RenderResult:
    """Render ``doc`` of the job at ``job_dir`` to ``output`` (MP4) and ``output.srt``.

    Essentials: ``size`` is the document's output size and ``quality`` ``"standar"`` (else
    ``ValueError``). ``progress`` receives per-mille of the frames written. ``source`` defaults
    to the job's own source; its content sha must be the document's. Nothing is published
    unless G1–G3/G3b pass; an existing ``output`` or ``.srt`` is never overwritten.
    ``encode_slot`` (a context manager, e.g. a semaphore) is held around the final encode only
    (``AutoRenderer``'s heavy slots).
    """
    output_size = (doc["output"]["w"], doc["output"]["h"])
    if tuple(size) != output_size or output_size not in OUTPUT_SIZES:
        raise ValueError("Essentials renders at the document's output size")
    if quality not in compile_ffmpeg.QUALITIES:
        raise ValueError(f"unknown quality: {quality}")
    inputs = load_render_inputs(job_dir, doc, resources=resources)
    source = job_source(job_dir) if source is None else Path(source)
    source = _checked_source(source, doc["base"]["source"]["content_sha256"])
    return _render(inputs, Path(output), source=source, job_dir=Path(job_dir), progress=progress,
                   stage=None, cancel=cancel, timeout_s=timeout_s, encode_slot=encode_slot)


# --- R10: the auto file ------------------------------------------------------------------------


@dataclass(frozen=True)
class AutoFile:
    """The auto render of a clip (``output/clip-NN.mp4`` + ``.srt``) and the engine that made
    it, found through ``output/manifest.json``."""

    video: Path
    srt: Path
    engine: str  # "edit-v2/1" or "legacy"
    duration_s: float | None  # the manifest's rendered duration (legacy verification)


def _manifest_clip_id(entry: Mapping[str, Any], source_sha: str) -> str | None:
    return manifest_clip_id(entry, source_sha)


def auto_file(job_dir: Path, doc: Mapping[str, Any]) -> AutoFile | None:
    """The auto render of ``doc``'s clip: the manifest entry whose ``clip_id`` is the
    document's (for a manifest written before the engine switch, the id computed from the
    entry's start, end and cold open), when its MP4 and ``.srt`` exist in ``output/``."""
    job_dir = Path(job_dir)
    manifest = _read_json(job_dir / "output" / "manifest.json", MAX_MANIFEST_BYTES)
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    source_sha = doc["base"]["source"]["content_sha256"]
    for entry in clips if isinstance(clips, list) else ():
        if not isinstance(entry, dict) or _manifest_clip_id(entry, source_sha) != doc["clip_id"]:
            continue
        name = os.path.basename(str(entry.get("output", "")))
        if _AUTO_NAME.fullmatch(name) is None:
            return None
        video = job_dir / "output" / name
        if not (_regular(video) and _regular(video.with_suffix(".srt"))):
            return None
        engine = entry.get("render_engine", LEGACY_ENGINE_ID)
        duration = entry.get("duration")
        duration = float(duration) if isinstance(duration, (int, float)) and not isinstance(
            duration, bool) and math.isfinite(duration) else None
        return AutoFile(video, video.with_suffix(".srt"), engine if isinstance(engine, str)
                        else "", duration)
    return None


def _auto_file_ok(found: AutoFile, fd: int, inputs: RenderInputs) -> dict[str, Any] | None:
    """Re-verify the auto file (G1–G2 for edit-v2, the legacy contract for legacy files);
    returns the report JSON (edit-v2) or ``{}`` (legacy), ``None`` when it fails."""
    seed_engine = inputs.seed["base"]["engine"]["compiler"] if inputs.seed else None
    if found.engine != seed_engine:
        return None
    if found.engine == COMPILER_ID:
        try:
            report = verify.verify_output(fd, inputs.plan, size=inputs.plan.output,
                                          normalize=False)
        except errors.VerificationFailed:
            return None
        return report.to_json()
    if found.engine != LEGACY_ENGINE_ID:
        return None
    plan = inputs.plan
    duration = found.duration_s
    if duration is None:
        duration = plan.total_frames * plan.fps.den / plan.fps.num
    try:
        _legacy._verify_rendered_media(Path(f"/proc/self/fd/{fd}"), width=plan.output[0],
                                       height=plan.output[1], duration=duration,
                                       inherited_fd=fd)
    except (RuntimeError, OSError, ValueError):
        return None
    return {}


def _export_auto_file(job_dir: Path, inputs: RenderInputs, output: Path) -> RenderResult | None:
    """R10: hard-link the verified auto file to ``output`` (``None`` when unavailable)."""
    started = time.monotonic()
    found = auto_file(job_dir, inputs.doc)
    if found is None:
        return None
    try:
        video_fd = _open_regular(found.video)
    except OSError:
        return None
    try:
        report = _auto_file_ok(found, video_fd, inputs)
        if report is None:
            return None
        identity = os.fstat(video_fd)
        with _Destination(output) as destination:
            destination.link(found.srt, destination.srt.name, dir_fd=None)
            destination.link(found.video, destination.output.name, dir_fd=None)
            linked = destination.published[-1][1]
            if (linked.st_dev, linked.st_ino) != (identity.st_dev, identity.st_ino):
                raise _fail("output")  # the file changed between the check and the link
            os.fsync(destination.directory_fd)
            destination.done = True
    finally:
        os.close(video_fd)
    counts = next((gate for gate in report.get("gates", ()) if gate["name"] == "G2"), None)
    values = {} if counts is None else counts["values"]
    return RenderResult(
        clip_id=inputs.doc["clip_id"], output=destination.output, srt=destination.srt,
        render_engine=found.engine, plan_sha256=inputs.plan.plan_sha256,
        render_key=render_key_for(inputs.plan, None, inputs.resources), reused="auto_file",
        frames=values.get("frames"), samples=values.get("samples"),
        elapsed_s=time.monotonic() - started, verify=report or None)


def _is_seed_content(inputs: RenderInputs) -> bool:
    return inputs.seed is not None and content_equals_seed(inputs.doc, inputs.seed)


def _existing_export(job_dir: Path, output: Path, inputs: RenderInputs) -> RenderResult | None:
    """A render already published at ``output`` (same render key): the auto file an earlier
    R10 request linked there, or an export reused after G1–G2."""
    started = time.monotonic()
    if not os.path.lexists(output):
        return None
    if not (_regular(output) and _regular(output.with_suffix(".srt"))):
        raise _fail("output")
    found = auto_file(job_dir, inputs.doc) if _is_seed_content(inputs) else None
    if found is not None and os.path.samefile(found.video, output):
        return RenderResult(
            clip_id=inputs.doc["clip_id"], output=output, srt=output.with_suffix(".srt"),
            render_engine=found.engine, plan_sha256=inputs.plan.plan_sha256,
            render_key=render_key_for(inputs.plan, None, inputs.resources), reused="auto_file",
            elapsed_s=time.monotonic() - started)
    try:
        report = verify_file(output, inputs.plan)
    except errors.VerificationFailed as exc:
        raise _fail("output") from exc
    counts = report.gate("G2")
    return RenderResult(
        clip_id=inputs.doc["clip_id"], output=output, srt=output.with_suffix(".srt"),
        render_engine=COMPILER_ID, plan_sha256=inputs.plan.plan_sha256,
        render_key=render_key_for(inputs.plan, None, inputs.resources), reused="existing",
        frames=None if counts is None else counts.values.get("frames"),
        samples=None if counts is None else counts.values.get("samples"),
        elapsed_s=time.monotonic() - started, verify=report.to_json())


# --- render_request --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Request:
    clip_id: str
    doc_sha256: str
    doc_revision: int
    doc_relative: str
    render_key: str
    output_relative: str
    source_sha256: str
    snapshot_relative: str | None


def _request(request: object) -> _Request:
    """Every field ``render_request`` reads, checked before any work (``ref="request"``)."""
    def text(name: str, pattern: re.Pattern[str] | None = None) -> str:
        value = request.get(name)
        if not isinstance(value, str) or (pattern is not None and not pattern.fullmatch(value)):
            raise _fail("request")
        return value

    if not isinstance(request, Mapping) or request.get("version") != REQUEST_VERSION:
        raise _fail("request")
    clip = text("clip_id", CLIP_ID_PATTERN)
    doc_sha = text("doc_sha256", _SHA)
    revision = request.get("doc_revision")
    if type(revision) is not int or revision < 0:
        raise _fail("request")
    relative = text("doc_relative")
    prefix = f"analysis/clips/{clip}/"
    archive = _ARCHIVE.fullmatch(relative[len(prefix):]) if relative.startswith(prefix) else None
    if relative == f"{prefix}{SEED_FILE}":
        if revision != 0:
            raise _fail("request")
    elif archive is None or int(archive.group(1)) != revision or archive.group(2) != doc_sha:
        raise _fail("request")
    key = text("render_key", _SHA)
    if request.get("size") != SIZE_OUTPUT or request.get("quality") not in compile_ffmpeg.QUALITIES:
        raise _fail("request")
    output = text("output_relative")
    if output != f"output/edits/{clip}/{key[:16]}.mp4":
        raise _fail("request")
    source_sha = text("source_content_sha256", _SHA)
    snapshot = request.get("source_snapshot_relative")
    if snapshot is not None:
        prefix = f"analysis/render-inputs/source.{source_sha}."
        if not (isinstance(snapshot, str) and snapshot.startswith(prefix)
                and _SNAPSHOT_EXTENSION.fullmatch(snapshot[len(prefix):])):
            raise _fail("request")
    return _Request(clip, doc_sha, revision, relative, key, output, source_sha, snapshot)


def _gunzip(data: bytes, limit: int) -> bytes:
    decompressor = zlib.decompressobj(wbits=31)
    raw = decompressor.decompress(data, limit + 1)
    if len(raw) > limit or not decompressor.eof or decompressor.unused_data:
        raise ValueError("archive is not one complete gzip member within the size limit")
    return raw


def _request_document(job_dir: Path, fields: _Request) -> dict[str, Any]:
    """The archived document of the request; its sha (the ETag), revision and clip id must
    be the request's (``ref="document"``)."""
    path = job_dir / fields.doc_relative
    try:
        data = read_regular(path, MAX_ARCHIVE_BYTES if path.suffix == ".gz" else MAX_DOC_BYTES)
        raw = _gunzip(data, MAX_DOC_BYTES) if path.suffix == ".gz" else data
        document = parse_doc(raw)
    except (OSError, ValueError, gzip.BadGzipFile, zlib.error, errors.EditV2Error) as exc:
        raise _fail("document") from exc
    if (hashlib.sha256(canonical_bytes(document)).hexdigest() != fields.doc_sha256
            or document.get("clip_id") != fields.clip_id
            or document.get("revision") != fields.doc_revision):
        raise _fail("document")
    return document


def _request_source(job_dir: Path, fields: _Request, doc: Mapping[str, Any]) -> Path:
    expected = doc["base"]["source"]["content_sha256"]
    if fields.source_sha256 != expected:
        raise _fail("source")
    if fields.snapshot_relative is not None:
        path = job_dir / fields.snapshot_relative
        if not _regular(path):
            raise _fail("source")
        return _checked_source(path, expected)
    return _checked_source(job_source(job_dir), expected)


def render_request(
    job_dir: Path,
    request: Mapping[str, Any],
    *,
    heartbeat: Callable[[str, int], None],
    cancel: threading.Event,
    resources: Resources | None = None,
    timeout_s: float | None = None,
) -> RenderResult:
    """Run one ``render-request-v3`` (module docstring): an existing export, R10, or a render
    of the archived document, published at ``output_relative`` with its ``.srt``."""
    fields = _request(request)
    job_dir = Path(job_dir)
    heartbeat("merender", 0)
    document = _request_document(job_dir, fields)
    inputs = load_render_inputs(job_dir, document, resources=resources)
    output = job_dir / fields.output_relative
    if cancel.is_set():
        raise errors.Cancelled("cancelled")
    existing = _existing_export(job_dir, output, inputs)
    if existing is not None:
        heartbeat("selesai", PROGRESS_FULL)
        return existing
    warnings: tuple[str, ...] = ()
    if _is_seed_content(inputs):
        linked = _export_auto_file(job_dir, inputs, output)
        if linked is not None:
            heartbeat("selesai", PROGRESS_FULL)
            return linked
        warnings = ("auto_file_unavailable",)
    source = _request_source(job_dir, fields, document)
    result = _render(inputs, output, source=source, job_dir=job_dir,
                     progress=lambda pm: heartbeat("merender", pm), stage=heartbeat,
                     cancel=cancel, timeout_s=timeout_s, warnings=warnings)
    heartbeat("selesai", PROGRESS_FULL)
    return result


# --- the pipeline: revision 0 of every clip ---------------------------------------------------


@dataclass(frozen=True)
class AutoOptions:
    """The pipeline options a seed depends on (plan §3.5)."""

    render_mode: str  # face-track | fit-blur | center-crop
    caption_style: str  # karaoke | classic
    cold_open: bool
    hook_overlay: bool
    hook_duration: float  # seconds
    width: int
    height: int
    # The cold-open transition of the auto render (spec 2026-10-02 §6.2); the default keeps a
    # construction without it on today's cut.
    cold_open_join: ColdOpenJoin = CUT_JOIN

    def job(self, job_id: str, seed_at_ms: int) -> dict[str, Any]:
        """The ``job`` mapping of ``seed.build_seed``."""
        return {"id": job_id,
                "options": {"renderMode": self.render_mode, "captionStyle": self.caption_style,
                            "coldOpen": self.cold_open, "hookOverlay": self.hook_overlay},
                "renderSize": [self.width, self.height], "hookDuration": self.hook_duration,
                "seedAtMs": seed_at_ms, "seedBy": "pipeline",
                "coldOpenJoin": self.cold_open_join.to_json()}


@dataclass(frozen=True)
class AutoClip:
    """Revision 0 of one clip, seeded and rendered by the edit-v2 compiler."""

    clip_id: str
    render_engine: str
    render_key: str | None
    plan_sha256: str
    cold_open: bool  # the seed kept the clip's cold open
    result: RenderResult
    # The seed's join when it kept the cold open (the manifest's cold_open_join), else None.
    cold_open_join: ColdOpenJoin | None = None

    def manifest_fields(self) -> dict[str, Any]:
        return {"clip_id": self.clip_id, "render_engine": self.render_engine,
                "render_key": self.render_key, "plan_sha256": self.plan_sha256}


def _write_or_match(path: Path, data: bytes) -> None:
    """Publish immutable ``data`` or confirm the existing file holds exactly it."""
    if write_immutable(path, data):
        return
    if read_regular(path, max(len(data), 1)) != data:
        raise SourceInfoError(f"{path.name} exists with other content")


class AutoRenderer:
    """Seeds and renders revision 0 of every clip of one V3 job (module docstring).

    The constructor reads everything once (and writes ``analysis/source.json``); any failure
    there means no clip can use the new engine.

    **Several clips at once (T4.3, PF-PIPELINE).** :meth:`schedule` starts every clip in the
    background; :meth:`render` then returns (or raises) the scheduled clip's result, so the
    pipeline keeps its order, its per-clip fallback and its manifest. ``slots`` heavy steps run
    at once (a final encode or a camera plan, :func:`render_slots`), and one more worker seeds
    or verifies another clip meanwhile. Every clip is rendered by exactly the FFmpeg job it
    would get alone, so the files are byte-identical to one clip at a time. :meth:`close` stops
    what was scheduled and never consumed (FFmpeg is killed, nothing is published) and waits
    for the workers. Without :meth:`schedule`, :meth:`render` works synchronously as before.
    """

    def __init__(self, *, job_dir: Path, source: Path, output_dir: Path, options: AutoOptions,
                 job_id: str | None = None, detector: Callable | None = None,
                 resources: Resources | None = None,
                 min_timeout_s: float = PIPELINE_MIN_TIMEOUT_S, slots: int | None = None) -> None:
        self.slots = render_slots() if slots is None else slots
        if type(self.slots) is not int or self.slots < 1:
            raise ValueError("slots must be a positive integer")
        self._heavy = threading.BoundedSemaphore(self.slots)
        self._cancel = threading.Event()
        self._pool: ThreadPoolExecutor | None = None
        self._scheduled: dict[int, tuple[Path, Future]] = {}
        self.order: list[int] = []  # the ranks in the order they were handed to the workers
        self.job_dir = Path(job_dir)
        self.source = Path(source)
        self.options = options
        self.detector = detector
        self.resources = Resources(RESOURCES_DIR) if resources is None else resources
        self.min_timeout_s = min_timeout_s
        if (options.width, options.height) not in OUTPUT_SIZES:
            raise ValueError("the render size is not a document output size")
        self.job_id = job_id if job_id is not None else job_id_for(self.job_dir)
        if self.job_id is None or not _UUID.fullmatch(self.job_id):
            raise _fail("job")
        self.source_info = ensure_source_info(self.job_dir, self.source)
        self.transcription = transcription_from_json_bytes(
            read_regular(Path(output_dir) / TRANSCRIPT_NAME, MAX_TRANSCRIPT_BYTES))
        self.audio = self._audio()
        self.events = self._events()
        raw = read_regular(self.job_dir / SELECTION_ARTIFACT_RELATIVE_PATH, MAX_SELECTION_BYTES)
        self.selection_sha = sha256_hex(raw)
        self.clips = {clip.rank: clip for clip in selection_from_dict(_strict_json(raw)).clips}
        self.written: dict[int, tuple[Path, tuple[int, int]]] = {}
        self.clip_ids: dict[int, str] = {}

    def _audio(self) -> AudioTimeline | None:
        payload = _read_json(self.job_dir / AUDIO_TIMELINE_RELATIVE_PATH,
                             MAX_AUDIO_TIMELINE_BYTES)
        try:
            return None if payload is None else AudioTimeline.from_dict(payload)
        except (TypeError, ValueError):
            return None

    def _events(self) -> Any:
        payload = _read_json(self.job_dir / SOUND_EVENTS_RELATIVE_PATH, MAX_SOUND_EVENTS_BYTES)
        try:
            return None if payload is None else events_from_dict(payload)[0]
        except (TypeError, ValueError):
            return None

    def _seed(self, rank: int) -> tuple[Path, dict[str, Any]]:
        clip = self.clips[rank]
        job = self.options.job(self.job_id, time.time_ns() // 1_000_000)
        face_track = self.options.render_mode == "face-track"
        common = {"clip": clip, "job": job, "source_info": self.source_info,
                  "selection_sha": self.selection_sha}
        provisional = _seed.build_seed(words_sha=ZERO_SHA, words_count=0,
                                       camera_sha=ZERO_SHA if face_track else None, **common)
        clip_id_value = provisional["clip_id"]
        self.clip_ids[rank] = clip_id_value
        window = (provisional["base"]["window_ms"][0], provisional["base"]["window_ms"][1])
        fps = Fps.from_json(provisional["output"]["fps"])
        directory = self.job_dir / CLIPS_RELATIVE_PATH / clip_id_value
        peaks = build_peaks(self.source, window)
        _write_or_match(directory / peaks_file_name(peaks), peaks)
        words = build_words_artifact(self.transcription, clip_id=clip_id_value, window_ms=window,
                                     fps=fps, audio=self.audio, events=self.events, peaks=peaks)
        words_raw = encode_words(words)
        _write_or_match(directory / words_file_name(words_raw), words_raw)
        camera_sha = None
        if face_track:
            detector = _camera.detect_face_track if self.detector is None else self.detector
            with self._heavy:  # the Haar detection keeps about as many CPUs busy as an encode
                camera_plan = _camera.build_camera_plan(
                    self.source, window, fps, out_w=self.options.width,
                    out_h=self.options.height, detector=detector)
            camera_raw = _camera.encode_camera_plan(camera_plan)
            _write_or_match(directory / _camera.camera_file_name(camera_raw), camera_raw)
            camera_sha = sha256_hex(camera_raw)
        seed_doc = _seed.build_seed(words_sha=sha256_hex(words_raw),
                                    words_count=len(words["words"]), camera_sha=camera_sha,
                                    **common)
        path = directory / SEED_FILE
        if write_immutable(path, _seed.encode_seed(seed_doc)):
            info = os.lstat(path)
            self.written[rank] = (path, (info.st_dev, info.st_ino))
        else:
            existing, _etag = store.seed(directory)
            if (existing["base"]["engine"]["compiler"] != COMPILER_ID
                    or not content_equals_seed(existing, seed_doc)):
                raise _seed.SeedError("another seed exists for this clip")
        document, _etag = store.seed(directory)  # render from the file (plan §3.5)
        return directory, document

    def _seconds(self, rank: int) -> float:
        """The clip's expected output length: its window plus its cold open."""
        clip = self.clips.get(rank)
        if clip is None:
            return 0.0
        teaser = clip.cold_open if self.options.cold_open else None
        return (clip.end - clip.start) + (teaser[1] - teaser[0] if teaser else 0.0)

    def schedule(self, items: Sequence[tuple[int, Path]]) -> None:
        """Start seeding and rendering every ``(rank, output)`` in the background, the
        longest clips first (the job ends with its shortest clips, so its tail is short; see
        the class docstring). Once per renderer; a single clip is left to :meth:`render`."""
        if self._pool is not None or self._scheduled:
            raise RuntimeError("this renderer has already scheduled its clips")
        items = [(rank, Path(output)) for rank, output in items]
        ranks = [rank for rank, _output in items]
        if len(set(ranks)) != len(ranks):
            raise ValueError("every rank is scheduled once")
        if len(items) < 2:
            return
        items.sort(key=lambda item: -self._seconds(item[0]))  # stable: ties keep rank order
        self.order = [rank for rank, _output in items]
        self._pool = ThreadPoolExecutor(max_workers=min(len(items), self.slots + 1),
                                        thread_name_prefix="edit-v2-auto")
        for rank, output in items:
            self._scheduled[rank] = (output, self._pool.submit(self._render_clip, rank, output))

    def render(self, rank: int, output: Path) -> AutoClip:
        """Seed the clip of ``rank`` and render it from ``seed.json`` to ``output``; for a
        scheduled clip, wait for its result."""
        scheduled = self._scheduled.pop(rank, None)
        if scheduled is not None:
            if scheduled[0] != Path(output):
                raise ValueError("the clip was scheduled with another output")
            return scheduled[1].result()
        return self._render_clip(rank, output)

    def close(self) -> None:
        """Stop the scheduled clips nobody took (their FFmpeg is killed and nothing of them is
        published) and wait for the workers. Never raises; idempotent."""
        pool, self._pool = self._pool, None
        if pool is None:
            return
        if self._scheduled:
            self._cancel.set()
        pool.shutdown(wait=True, cancel_futures=True)
        self._scheduled.clear()

    def _render_clip(self, rank: int, output: Path) -> AutoClip:
        if self._cancel.is_set():
            raise errors.Cancelled("cancelled")
        _directory, document = self._seed(rank)
        timeout = max(self.min_timeout_s, render_timeout_s(document))
        result = render_document(document, self.job_dir, output,
                                 size=(self.options.width, self.options.height),
                                 quality="standar", source=self.source,
                                 resources=self.resources, timeout_s=timeout,
                                 cancel=self._cancel, encode_slot=self._heavy)
        cold_open = any(segment["role"] == "cold_open"
                        for segment in document["main"]["segments"])
        joins = document["main"]["joins"]
        join = None
        if cold_open and joins:
            sound = joins[0].get("sfx")
            join = (ColdOpenJoin(joins[0]["style"], None) if sound is None
                    else ColdOpenJoin(joins[0]["style"], sound["id"], sound["v"]))
        return AutoClip(clip_id=document["clip_id"], render_engine=COMPILER_ID,
                        render_key=result.render_key, plan_sha256=result.plan_sha256,
                        cold_open=cold_open, result=result, cold_open_join=join)

    def fallback(self, rank: int) -> str | None:
        """Before the legacy engine renders the clip of ``rank``: remove the ``seed.json`` this
        run wrote for it (it would claim the new engine); returns the clip id when known.
        Never raises."""
        try:
            written = self.written.pop(rank, None)
            if written is not None:
                path, identity = written
                info = os.lstat(path)
                if (info.st_dev, info.st_ino) == identity:
                    os.unlink(path)
        except OSError:
            pass
        return self.clip_ids.get(rank)


__all__ = [
    "ENGINES",
    "ENGINE_EDIT_V2",
    "ENGINE_ENV",
    "ENGINE_LEGACY",
    "RENDER_SLOTS_MAX",
    "REQUEST_VERSION",
    "STAGES",
    "AutoClip",
    "AutoFile",
    "AutoOptions",
    "AutoRenderer",
    "RenderInputs",
    "RenderResult",
    "auto_file",
    "engine_from_env",
    "job_id_for",
    "job_source",
    "load_render_inputs",
    "measure_sha256",
    "render_document",
    "render_key_for",
    "render_request",
    "render_slots",
    "render_timeout_s",
    "verify_file",
]
