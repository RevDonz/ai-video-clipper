#!/usr/bin/env python3
"""T3.3 music gates (plan §10.2 duck, G3, G3b, G-CLICK; §10.1 P-AUD; §10.3 PF-AUDIO).

Everything runs on copies of jobs (the originals are only read): the owner's P3 jobs (local
only) or the synthetic V3 jobs of ``scripts/editor_fixture/make_job.py`` (``setup --synthetic``;
what CI measures, since the P3 media is not on GitHub). The music is made
here (lavfi tones and noise, normalised as §9.2 describes: AAC-LC 192k, 48 kHz, stereo, stored in
the job asset store in the document form of docs/editor/CONTRACTS.md §5.9), documents built the
way the Musik panel builds them (SetMusic's defaults and the Halus/Sedang/Kuat presets of
web/lib/editor/commands.mjs), and the real export path (``render_edit.render_document``:
measurement, master stage, H.264/AAC, G1–G3b verification).

* **duck**: the music-only stem during speech is the unducked stem − depth ± 0.5 dB, and back
  within 1 dB by release + 50 ms after the span's end + hold. Measured on the exports of a
  *silent twin* of each job (the same video stream, words and cuts; the source audio replaced
  by digital silence, so the export's audio is the music stem) and, as a cross-check, on the
  lossless ``reference`` of the same documents.
* **G3** (normalize) and **G3b** (music or source gain > 0, with a deliberately loud track):
  ``ebur128`` on the decoded export.
* **G-CLICK**: the sample step at every join of the lossless ``reference`` (the export's graph
  before AAC) with music in the mix is below −40 dBFS, for cuts on word bounds and inside words;
  the mid-word cuts made hard are the control and must show a click.
* **P-AUD** (server) and **PF-AUDIO**: through the running app's preview lane (``lane``).

Usage (stdlib only; the image is the toolchain of record, see docs/editor/GATES.md)::

    python scripts/parity/audio_gates.py setup --originals <jobs> --jobs-root <scratch> [--twins]
    python scripts/editor_fixture/make_job.py build <fixture> --only main,fps25,fps60,vfr
    python scripts/parity/audio_gates.py setup --synthetic --originals <fixture> \
        --jobs-root <scratch> --twins
    python scripts/parity/audio_gates.py exports --jobs-root <scratch> --work <dir> \\
        --evidence docs/editor/evidence/W3
    E2E_USERNAME=… E2E_PASSWORD=… python scripts/parity/audio_gates.py lane {p-aud,pf-audio} \\
        --base-url http://127.0.0.1:<port> --jobs-root <scratch> --work <dir> --evidence <dir> \\
        [--browser-fixtures <dir>]

Evidence: ``<task>-<gate>.json`` (numbers only; ``AUDIO_GATES_TASK`` names the task, default
T3.3). The browser half of P-AUD is ``web/e2e/editor-music.spec.mjs`` over the fixtures.
"""

from __future__ import annotations

import argparse
import array
import copy
import dataclasses
import hashlib
import importlib.util
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from ai_clipper.edit_v2 import compile_ffmpeg, envelope, errors, execute, render_edit, store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.loudness import Loudness, needs_measurement, parse_ebur128
from ai_clipper.edit_v2.plan import Resources, build_plan

TASK = os.environ.get("AUDIO_GATES_TASK", "T3.3")
RATE = 48_000
THREADS = "4"  # the machine is shared: FFmpeg never gets more
PRESETS = {"halus": 600, "sedang": 1000, "kuat": 1600}  # commands.mjs DUCK_PRESETS
DEFAULT_DUCK = {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                "hold_ms": 250, "detector": "words"}
DUCK_TOLERANCE_DB = 0.5
DUCK_RECOVERY_DB = 1.0
DUCK_WINDOW = 480  # 10 ms RMS windows, as the W1 gate
CLICK_THRESHOLD_DBFS = -40.0
TP_MAX_DBTP = -1.0
G3_TOLERANCE_LU = 1.0
G3_CLAMPED_TOLERANCE_LU = 0.5
# The tool's own renders (the lossless reference and its measurement) are offline: on a shared
# machine FFmpeg may report no progress for longer than the production stall window (20 s).
REFERENCE_STALL_S = 300.0
EDITOR = "editor-v3/1.0.0"
TRACK_ORDER = {"hook": 0, "visual": 1, "audio": 2}

# The clips each gate uses, by role, in two media sets: the owner's P3 jobs (plan §11.0; local
# copies only, they are not on GitHub) and the synthetic V3 jobs of
# scripts/editor_fixture/make_job.py (generated on demand, so the gates also run on CI).
JOBS = ("899226f8-7e57-49d9-8c29-b078b2b91580", "990f3f37-f0a6-490a-a9a2-a6d6cdab004e",
        "3c7d024c-f1f5-45a6-b767-9f2c190b0c42", "860fef1a-8140-4677-8d73-729d18f15431")
P3_ROLES = {
    "cold_open": {"job": JOBS[0], "rank": 3, "clip": "P3 899226f8 #3: fit-blur, 23.976 fps, cold open"},
    "vfr": {"job": JOBS[1], "rank": 2, "clip": "P3 990f3f37 #2: fill-center, VFR"},
    "fps60": {"job": JOBS[2], "rank": 2, "clip": "P3 3c7d024c #2: fit-blur, 60 fps"},
    "fps25": {"job": JOBS[3], "rank": 4, "clip": "P3 860fef1a #4: face-track, 25 fps"},
}
SYNTHETIC_ROLES = {
    "cold_open": {"fixture": "main", "rank": 1,
                  "clip": "synthetic main #1: fit-blur, 29.97 fps CFR, cold open"},
    "vfr": {"fixture": "vfr", "rank": 2, "clip": "synthetic vfr #2: fit-blur, VFR Matroska"},
    "fps60": {"fixture": "fps60", "rank": 1,
              "clip": "synthetic fps60 #1: face-track (the fixture's stub camera), 60 fps, cold open"},
    "fps25": {"fixture": "fps25", "rank": 3, "clip": "synthetic fps25 #3: center-crop, 25 fps"},
}
TWIN_ROLES = ("cold_open", "vfr", "fps60")
CLICK_ROLES = ("cold_open", "vfr", "fps60")
PF_AUDIO_ROLE = "cold_open"
# G3 (every "normalize" row) and G3b (every row): (role, music, the panel's settings)
LOUDNESS_PLANS = (
    ("cold_open", "bed", {"master": "normalize"}),
    ("vfr", "bed", {"master": "normalize", "preset": "kuat"}),
    ("fps60", "bed", {"master": "normalize", "preset": "halus"}),
    ("fps60", "loud", {"master": "normalize", "gain_cdb": 600, "duck_on": False}),
    ("cold_open", "loud", {"gain_cdb": 600, "duck_on": False}),
    ("vfr", "loud", {"gain_cdb": 600, "preset": "kuat"}),
    ("fps60", "loud", {"gain_cdb": 600, "duck_on": False, "source_gain_cdb": 1200}),
    ("fps25", "loud", {"gain_cdb": 600, "duck_on": False, "fade_in_f": 0, "fade_out_f": 0}),
    ("fps25", "bed", {"source_gain_cdb": 1200}),
)
P_AUD_VARIANTS = (
    ("cold_open", "bed", {}),
    ("cold_open", "bed", {"preset": "kuat", "master": "normalize"}),
    ("vfr", "bed", {"preset": "halus", "src_in_smp": 48_000 * 7}),
    ("fps60", "loud", {"gain_cdb": 600, "duck_on": False}),
    ("fps60", "tone", {"loop": False, "source_gain_cdb": 600}),
    ("fps25", "bed", {"fade_in_f": 0, "fade_out_f": 250}),
)
ROLES_FILE = "roles.json"
TWINS_FILE = "twins.json"


# --- FFmpeg helpers ----------------------------------------------------------------------------


def ffmpeg(args: Sequence[str], *, loglevel: str = "error", timeout_s: float = 900) -> str:
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", loglevel, "-y", *args]
    result = subprocess.run(argv, capture_output=True, timeout=timeout_s, check=False)
    stderr = result.stderr.decode("utf-8", "replace")
    if result.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + " | ".join(stderr.strip().splitlines()[-4:]))
    return stderr


def pcm_of(path: Path) -> array.array:
    """The file's first audio stream as interleaved stereo s16 at 48 kHz."""
    data = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i",
                           str(path), "-map", "0:a:0", "-ac", "2", "-ar", str(RATE), "-f",
                           "s16le", "-acodec", "pcm_s16le", "-threads", THREADS, "-"],
                          capture_output=True, check=True).stdout
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def measure_file(path: Path) -> Loudness:
    """``ebur128=peak=true`` over the decoded file: integrated loudness and true peak."""
    stderr = ffmpeg(["-i", str(path), "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose",
                     "-threads", THREADS, "-f", "null", "-"], loglevel="info")
    return parse_ebur128(stderr)


_MUSIC_GRAPHS = {
    # A low chord (A1, E2, A2, E3): tonal, steady and slow-moving, so the stem of the duck gate
    # has no gaps and its natural sample steps stay far under the G-CLICK threshold.
    "tone": ("aevalsrc='0.22*sin(2*PI*55*t)+0.18*sin(2*PI*82.5*t)+0.14*sin(2*PI*110*t)"
             "+0.10*sin(2*PI*165*t)':s=48000:d={d},pan=stereo|c0=c0|c1=c0"),
    # A music bed: a chord over pink noise (the W2 PF-AUDIO asset's recipe).
    "bed": ("aevalsrc='0.12*sin(2*PI*220*t)+0.12*sin(2*PI*277.18*t)+0.12*sin(2*PI*329.63*t)':"
            "s=48000:d={d}[c];anoisesrc=r=48000:color=pink:amplitude=0.08:seed=7:d={d}[n];"
            "[c][n]amix=inputs=2:normalize=0,volume=0.6,pan=stereo|c0=c0|c1=c0"),
    # A deliberately loud master: square bass, a bright chord and noise, limited at full scale
    # (about −6 LUFS, true peak above 0 dBTP once encoded).
    "loud": ("aevalsrc='0.55*sgn(sin(2*PI*55*t))+0.35*sin(2*PI*440*t)+0.25*sin(2*PI*660*t)':"
             "s=48000:d={d}[t];anoisesrc=r=48000:color=pink:amplitude=0.5:seed=3:d={d}[n];"
             "[t][n]amix=inputs=2:normalize=0,volume=4dB,alimiter=limit=0.99:attack=1:"
             "release=30:level=false,pan=stereo|c0=c0|c1=c0"),
}


def make_music(path: Path, kind: str, *, seconds: int = 180) -> Path:
    """A synthetic track, normalised like an upload (§9.2): AAC-LC 192k, 48 kHz, stereo."""
    graph = _MUSIC_GRAPHS[kind].format(d=seconds)
    path.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(["-filter_complex", graph, "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-ac", "2",
            "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
            "-threads", THREADS, str(path)])
    return path


def store_asset(job_dir: Path, path: Path) -> tuple[str, dict[str, Any]]:
    """Put a normalised track into ``analysis/assets/`` as ``<sha>.m4a`` + ``<sha>.json`` (the
    document-form metadata of CONTRACTS §5.9); returns (``sha256:<hex>``, metadata)."""
    data = Path(path).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    directory = Path(job_dir) / "analysis" / "assets"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{digest}.m4a"
    if not target.exists():
        target.write_bytes(data)
    samples = len(pcm_of(target)) // 2
    measured = measure_file(target)
    meta = {"kind": "audio", "mime": "audio/mp4", "duration_ms": samples // 48,
            "lufs_c": measured.i_clufs}
    (directory / f"{digest}.json").write_text(json.dumps(meta, sort_keys=True))
    return f"sha256:{digest}", meta


def silent_twin(source: Path, target: Path) -> Path:
    """The same video stream (copied) with digital silence as its only audio (AAC stereo)."""
    duration = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "format=duration", "-of", "csv=p=0", str(source)],
                              capture_output=True, text=True, check=True).stdout.strip()
    ffmpeg(["-i", str(source), "-f", "lavfi", "-i", f"anullsrc=r={RATE}:cl=stereo",
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
            "-t", duration, "-map_metadata", "-1", "-threads", THREADS, str(target)])
    return target


# --- documents (what the Musik panel sends) -------------------------------------------------------


def default_gain(lufs_c: int) -> int:
    """§3.3: ``clamp(−2600 − lufs_c, −4800, 600)`` (SetMusic's default)."""
    return max(-4800, min(600, -2600 - lufs_c))


def music_doc(seed: Mapping[str, Any], etag: str, asset: str, meta: Mapping[str, Any], *,
              preset: str = "sedang", duck_on: bool = True, gain_cdb: int | None = None,
              fade_in_f: int = 15, fade_out_f: int = 30, loop: bool = True, src_in_smp: int = 0,
              attack_ms: int = 30, release_ms: int = 400, hold_ms: int = 250,
              master: str = "off", source_gain_cdb: int = 0,
              removals: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    """Revision 1 of ``seed`` with the music item SetMusic makes and the panel's settings."""
    doc = copy.deepcopy(dict(seed))
    doc["revision"] = 1
    doc["parent_sha256"] = etag
    doc["audit"] = {**doc["audit"], "editor": EDITOR, "last_command": "SetMusic"}
    item = {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
            "end": {"at": "clip_end"}, "origin": "user",
            "payload": {"asset": asset, "src_in_smp": src_in_smp, "loop": loop,
                        "gain_cdb": default_gain(meta["lufs_c"]) if gain_cdb is None else gain_cdb,
                        "fade_in_f": fade_in_f, "fade_out_f": fade_out_f,
                        "duck": {**DEFAULT_DUCK, "on": duck_on, "depth_cdb": PRESETS[preset],
                                 "attack_ms": attack_ms, "release_ms": release_ms,
                                 "hold_ms": hold_ms}}}
    tracks = [t for t in doc["tracks"] if t["kind"] != "audio"]
    tracks.append({"id": "tr_mus", "kind": "audio", "role": "music", "items": [item]})
    doc["tracks"] = sorted(tracks, key=lambda track: TRACK_ORDER[track["kind"]])
    doc["assets"] = {**{k: v for k, v in doc["assets"].items() if v.get("kind") != "audio"},
                     asset: dict(meta)}
    doc["audio"] = {"source": {"gain_cdb": source_gain_cdb},
                    "master": {**doc["audio"]["master"], "mode": master}}
    doc["main"] = {**doc["main"], "removals": [dict(r) for r in removals]}
    return doc


# --- measurements ----------------------------------------------------------------------------------


def _db(value: float) -> float:
    return -math.inf if value <= 0 else 20 * math.log10(value)


def _round(value: float, digits: int = 3) -> float | None:
    return None if math.isinf(value) or math.isnan(value) else round(value, digits)


def _rms(samples: array.array, start: int, length: int) -> float:
    chunk = samples[2 * start: 2 * (start + length)]
    return math.sqrt(sum(v * v for v in chunk) / len(chunk)) if chunk else 0.0


def duck_rows(ducked: array.array, unducked: array.array, speech_spans: Sequence[tuple[int, int]],
              duck: Mapping[str, Any], total_samples: int) -> dict[str, Any]:
    """The duck gate over two stems of the same music (interleaved stereo s16): inside every
    merged speech span (to its end + hold) each 10 ms window of the ducked stem is the unducked
    one − depth ± 0.5 dB; release + 50 ms after end + hold it is back within 1 dB."""
    depth_db = duck["depth_cdb"] / 100
    attack, hold, release = (duck[key] * RATE // 1000
                             for key in ("attack_ms", "hold_ms", "release_ms"))
    spans = envelope.merge_spans(speech_spans, hold)
    length = min(len(ducked), len(unducked)) // 2
    rows = []
    failures = windows = 0
    for index, (start, end) in enumerate(spans):
        deviations = []
        position = start
        # to end + hold, never past the plan: a decoded AAC export carries a padding tail (G2)
        while position + DUCK_WINDOW <= min(end + hold, total_samples, length):
            reference = _rms(unducked, position, DUCK_WINDOW)
            if reference > 0:
                deviations.append(_db(_rms(ducked, position, DUCK_WINDOW) / reference) + depth_db)
            position += DUCK_WINDOW
        windows += len(deviations)
        worst = max((abs(d) for d in deviations), default=0.0)
        row: dict[str, Any] = {"span": [start, end], "windows": len(deviations),
                               "max_deviation_db": _round(worst)}
        failures += worst > DUCK_TOLERANCE_DB or not deviations
        check = end + hold + release + 50 * RATE // 1000
        following = spans[index + 1][0] - attack if index + 1 < len(spans) else math.inf
        if check + DUCK_WINDOW <= min(following, total_samples, length):
            recovery = _db(_rms(ducked, check, DUCK_WINDOW) / _rms(unducked, check, DUCK_WINDOW))
            row["recovery_db"] = _round(recovery)
            failures += abs(recovery) > DUCK_RECOVERY_DB
        else:
            row["recovery_db"] = None  # the next span's attack starts first (legitimately ducked)
        rows.append(row)
    return {"spans": rows, "windows": windows,
            "recovery_checks": sum(row["recovery_db"] is not None for row in rows),
            "max_deviation_db": max((row["max_deviation_db"] for row in rows), default=None),
            "failures": failures}


def join_steps_dbfs(samples: array.array, joins: Sequence[int]) -> list[float]:
    """The largest sample step (s16, either channel) across each join, in dBFS."""
    return [_db(max(abs(samples[2 * j + c] - samples[2 * (j - 1) + c]) for c in (0, 1)) / 32768)
            for j in joins]


def click_pass(bound_steps: Sequence[float], mid_steps: Sequence[float],
               mid_hard_steps: Sequence[float]) -> bool:
    """G-CLICK: every faded join (cut on word bounds or inside words) steps below −40 dBFS, and
    the same mid-word cuts made hard show at least one click (the measurement is not blind)."""
    return (bool(bound_steps) and bool(mid_steps)
            and all(step < CLICK_THRESHOLD_DBFS for step in (*bound_steps, *mid_steps))
            and any(step >= CLICK_THRESHOLD_DBFS for step in mid_hard_steps))


def g3_pass(*, export_i: float, export_tp: float, target: float, clamped: float | None) -> bool:
    """G3: −14 ± 1 LUFS integrated (or the recorded clamped value ± 0.5 LU), TP ≤ −1.0 dBTP."""
    if clamped is not None:
        loud_ok = abs(export_i - clamped) <= G3_CLAMPED_TOLERANCE_LU
    else:
        loud_ok = abs(export_i - target) <= G3_TOLERANCE_LU
    return loud_ok and export_tp <= TP_MAX_DBTP


def g3b_pass(export_tp: float) -> bool:
    """G3b: true peak ≤ −1.0 dBTP on the decoded export."""
    return export_tp <= TP_MAX_DBTP


def _detail(codes: Sequence[str], code: str) -> float | None:
    for text in codes:
        if text.startswith(f"{code}:"):
            return float(text.split(":", 1)[1].split()[0])
    return None


# --- jobs, clips and renders -----------------------------------------------------------------------


def _load(name: str, path: Path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def lane_tools():
    """The W2 lane gate tool (``preview_lane_gates.py``): its App, Clip and helpers."""
    return _load("preview_lane_gates", ROOT / "scripts" / "parity" / "preview_lane_gates.py")


def resources() -> Resources:
    return Resources(Path(os.environ.get("POTONGIN_RESOURCES_DIR") or RESOURCES_DIR))


def copy_job(original: Path, target: Path) -> Path:
    """A private copy of a job (symlinks refused; the original is only read)."""
    if target.exists():
        return target
    for path in original.rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"{original.name}: symlinks are not copied ({path.name})")
    shutil.copytree(original, target, ignore=shutil.ignore_patterns("worker.log", "clips",
                                                                     "source.json"))
    return target


def p3_roles() -> dict[str, dict[str, Any]]:
    return copy.deepcopy(P3_ROLES)


def synthetic_roles(index: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """The roles over the jobs of a ``make_job.py build`` (its ``fixture.json`` index)."""
    jobs = index.get("jobs", {})
    missing = sorted({spec["fixture"] for spec in SYNTHETIC_ROLES.values()} - set(jobs))
    if missing:
        raise SystemExit("the synthetic fixture lacks the jobs " + ", ".join(missing)
                         + " (make_job.py build --only main,fps25,fps60,vfr)")
    return {role: {"job": jobs[spec["fixture"]]["id"], "rank": spec["rank"], "clip": spec["clip"]}
            for role, spec in SYNTHETIC_ROLES.items()}


def write_roles(jobs_root: Path, roles: Mapping[str, Any], *, media: str) -> Path:
    path = Path(jobs_root) / ROLES_FILE
    path.write_text(json.dumps({"media": media, "roles": roles}, indent=2, sort_keys=True) + "\n")
    return path


def _roles_file(jobs_root: Path) -> dict[str, Any] | None:
    try:
        body = json.loads((Path(jobs_root) / ROLES_FILE).read_text())
    except (OSError, ValueError):
        return None
    return body if isinstance(body, dict) and isinstance(body.get("roles"), dict) else None


def read_roles(jobs_root: Path) -> dict[str, dict[str, Any]]:
    """The roles ``setup`` recorded under ``jobs_root`` (the P3 set when it recorded none)."""
    body = _roles_file(jobs_root)
    return body["roles"] if body else p3_roles()


def media_of(jobs_root: Path) -> str:
    body = _roles_file(jobs_root)
    return str(body.get("media")) if body else "p3"


def make_twin(job_dir: Path, jobs_root: Path) -> Path:
    """The silent twin of a copied job: a new job id, the source with silent audio, the same
    transcript and selection, prepared from scratch (new source sha, so new clip ids)."""
    twin_id = str(uuid.uuid4())
    twin = jobs_root / twin_id
    shutil.copytree(job_dir, twin, ignore=shutil.ignore_patterns(
        "worker.log", "clips", "source.json", "assets", "edits", "preview", "*.mp4"))
    job = json.loads((job_dir / "job.json").read_text())
    source = render_edit.job_source(job_dir)
    silent_twin(source, twin / "input" / source.name)
    job["id"] = twin_id
    job["sourcePath"] = str(twin / "input" / source.name)
    (twin / "job.json").write_text(json.dumps(job, indent=2))
    return twin


def prepare(job_dir: Path) -> list[dict]:
    from ai_clipper.edit_v2.seed import prepare_legacy_job

    return prepare_legacy_job(job_dir)


def clip_dir_of(job_dir: Path, rank: int) -> Path | None:
    for seed_file in sorted((job_dir / "analysis" / "clips").glob("clip_*/seed.json")):
        seed = json.loads(seed_file.read_bytes())
        if seed["base"]["origin"]["rank_at_seed"] == rank:
            return seed_file.parent
    return None


class Clip:
    """One prepared clip of a copied job: its seed, words and the documents built on it."""

    def __init__(self, job_dir: Path, rank: int, role: str, label: str = "") -> None:
        clip_dir = clip_dir_of(job_dir, rank)
        if clip_dir is None:
            raise SystemExit(f"{job_dir.name}: no prepared clip of rank {rank} (run setup)")
        self.job_dir, self.dir, self.role, self.label = job_dir, clip_dir, role, label
        self.seed, self.etag = store.seed(clip_dir)
        self.words = store.load_words(clip_dir, self.seed["base"]["words"]["sha256"])
        self.fps = tm.Fps.from_json(self.seed["output"]["fps"])

    def removals(self, count: int, *, mid_word: bool = False) -> list[dict[str, Any]]:
        """``count`` two-word removals spread over the body, cut on the bounds table; with
        ``mid_word`` each cut is the frame at the middle of its first and last word instead."""
        body = self.seed["main"]["segments"][-1]
        scale = 1000 * self.fps.den
        words = [w for w in self.words["words"]
                 if body["in_sf"] * scale <= (w["s"] + w["e"]) // 2 * self.fps.num
                 < body["out_sf"] * scale]
        before = {b["before"]: b for b in self.words["bounds"]}
        after = {b["after"]: b for b in self.words["bounds"]}
        spacing = max(len(words) // (count + 1), 4)
        out: list[dict[str, Any]] = []
        for index in range(count):
            first = spacing * (index + 1)
            if first + 2 >= len(words) - 1:
                break
            chosen = words[first:first + 2]
            in_sf, out_sf = before[chosen[0]["id"]]["sf"], after[chosen[-1]["id"]]["sf"]
            if mid_word:
                in_sf, out_sf = (tm.sf_floor((w["s"] + w["e"]) // 2, self.fps)
                                 for w in (chosen[0], chosen[-1]))
            if body["in_sf"] < in_sf < out_sf < body["out_sf"] and (
                    not out or in_sf >= out[-1]["out_sf"]):
                out.append({"id": f"rm_{index + 1}", "seg": body["id"], "in_sf": in_sf,
                            "out_sf": out_sf, "words": [w["id"] for w in chosen],
                            "reason": "user", "origin": "user"})
        return out

    def plan(self, doc: Mapping[str, Any]):
        assets = store.load_assets(self.dir, doc["assets"].keys())
        camera = None
        if doc["layout"]["default"]["mode"] == "camera":
            from ai_clipper.edit_v2 import plates

            camera = plates.camera_for(self.dir, doc)[0]
        return build_plan(doc, words=self.words, camera=camera, assets=assets,
                          resources=resources())

    @property
    def seconds(self) -> float:
        frames = tm.total_frames(tm.pieces(self.seed))
        return round(frames * self.fps.den / self.fps.num, 2)


def export(clip: Clip, doc: Mapping[str, Any], out: Path) -> dict[str, Any]:
    """The real export (``render_document``): the MP4, its warnings, its decoded loudness."""
    out.parent.mkdir(parents=True, exist_ok=True)
    for stale in (out, out.with_suffix(".srt")):
        stale.unlink(missing_ok=True)
    started = time.monotonic()
    try:
        result = render_edit.render_document(doc, clip.job_dir, out, size=(doc["output"]["w"],
                                             doc["output"]["h"]), quality="standar",
                                             resources=resources())
    except (errors.EditV2Error, OSError, RuntimeError, ValueError) as error:  # data, not a crash
        return {"error": f"{type(error).__name__}:{getattr(error, 'code', '')}",
                "elapsed_s": round(time.monotonic() - started, 2)}
    measured = measure_file(out)
    return {"path": out, "warnings": list(result.warnings), "samples": result.samples,
            "frames": result.frames, "elapsed_s": round(result.elapsed_s, 2),
            "export_i_lufs": measured.i_clufs / 100, "export_tp_dbtp": measured.tp_cdb / 100}


def patient(job: compile_ffmpeg.FfmpegJob) -> compile_ffmpeg.FfmpegJob:
    """``job`` with the tool's stall window (``REFERENCE_STALL_S``); nothing else changes."""
    return dataclasses.replace(job, expected={**job.expected, "stall_s": REFERENCE_STALL_S})


def reference_pcm(clip: Clip, doc: Mapping[str, Any], work: Path, name: str) -> array.array:
    """The lossless ``reference`` render of ``doc`` (the export's graph without AAC), decoded."""
    plan = clip.plan(doc)
    source = render_edit.job_source(clip.job_dir)
    assets_root = clip.job_dir / "analysis" / "assets"
    measured = None
    if needs_measurement(plan.doc):
        job = compile_ffmpeg.compile_job(plan, mode="audio_measure", source=source,
                                         assets_root=assets_root)
        measured = parse_ebur128(execute.run(patient(job), output_fd=None, timeout_s=1800).stderr)
    job = compile_ffmpeg.compile_job(plan, mode="reference", source=source,
                                     assets_root=assets_root, loudness=measured)
    work.mkdir(parents=True, exist_ok=True)
    out = work / f"{name}.mkv"
    fd = os.open(out, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(patient(job), output_fd=fd, timeout_s=1800)
    finally:
        os.close(fd)
    samples = pcm_of(out)
    out.unlink()
    return samples


# --- the export gates ----------------------------------------------------------------------------


class Exports:
    def __init__(self, jobs_root: Path, work: Path) -> None:
        self.jobs_root, self.work = jobs_root, work
        self._music: dict[tuple[str, str], tuple[str, dict]] = {}
        twins = jobs_root / TWINS_FILE
        self.twins = json.loads(twins.read_text()) if twins.exists() else {}
        self.roles, self.media = read_roles(jobs_root), media_of(jobs_root)

    def clip(self, role: str, *, twin: bool = False) -> Clip:
        entry = self.roles[role]
        job = self.twins[entry["job"]] if twin else entry["job"]
        return Clip(self.jobs_root / job, entry["rank"], role,
                    entry["clip"] + (" (silent twin)" if twin else ""))

    def music(self, clip: Clip, kind: str) -> tuple[str, dict]:
        key = (clip.job_dir.name, kind)
        if key not in self._music:
            track = make_music(self.work / "music" / f"{kind}.m4a", kind) \
                if not (self.work / "music" / f"{kind}.m4a").exists() else \
                self.work / "music" / f"{kind}.m4a"
            self._music[key] = store_asset(clip.job_dir, track)
        return self._music[key]

    def doc(self, clip: Clip, kind: str, **settings: Any) -> dict[str, Any]:
        asset, meta = self.music(clip, kind)
        return music_doc(clip.seed, clip.etag, asset, meta, **settings)

    # duck ----------------------------------------------------------------------------------------

    def duck(self) -> dict[str, Any]:
        cases = []
        for role in TWIN_ROLES:
            clip = self.clip(role, twin=True)
            removals = clip.removals(3)
            flat_doc = self.doc(clip, "tone", duck_on=False, fade_in_f=0, fade_out_f=0,
                                removals=removals)
            flat = export(clip, flat_doc, self.work / "duck" / f"{role}-flat.mp4")
            flat_ref = reference_pcm(clip, flat_doc, self.work / "duck", f"{role}-flat")
            flat_pcm = pcm_of(flat["path"]) if "path" in flat else None
            for preset in PRESETS:
                doc = self.doc(clip, "tone", preset=preset, fade_in_f=0, fade_out_f=0,
                               removals=removals)
                plan = clip.plan(doc)
                ducked = export(clip, doc, self.work / "duck" / f"{role}-{preset}.mp4")
                duck = doc["tracks"][-1]["items"][0]["payload"]["duck"]
                case: dict[str, Any] = {"role": role, "clip": clip.label, "preset": preset,
                                        "depth_db": duck["depth_cdb"] / 100,
                                        "clip_seconds": round(plan.total_samples / RATE, 2),
                                        "pieces": len(plan.pieces),
                                        "speech_spans": len(plan.speech_spans)}
                if "path" not in ducked or flat_pcm is None:
                    case.update(error=ducked.get("error") or flat.get("error"), pass_=False)
                    cases.append(case)
                    continue
                gains = {"ducked": ducked["warnings"], "unducked": flat["warnings"]}
                case["peak_reduced"] = {k: _detail(v, "peak_reduced") for k, v in gains.items()}
                export_rows = duck_rows(pcm_of(ducked["path"]), flat_pcm, plan.speech_spans, duck,
                                        plan.total_samples)
                ref_rows = duck_rows(reference_pcm(clip, doc, self.work / "duck", f"{role}-{preset}"),
                                     flat_ref, plan.speech_spans, duck, plan.total_samples)
                case["export"] = {k: v for k, v in export_rows.items() if k != "spans"}
                case["export"]["spans"] = export_rows["spans"]
                case["reference"] = {k: v for k, v in ref_rows.items() if k != "spans"}
                case["pass"] = export_rows["failures"] == 0 and ref_rows["failures"] == 0 \
                    and not any(case["peak_reduced"].values())
                cases.append(case)
                ducked["path"].unlink(missing_ok=True)
            if "path" in flat:
                flat["path"].unlink(missing_ok=True)
        return {"gate": "duck", "task": TASK, "media": self.media, "tolerance_db": DUCK_TOLERANCE_DB,
                "recovery_tolerance_db": DUCK_RECOVERY_DB, "window_samples": DUCK_WINDOW,
                "method": ("exports (render_document, AAC) of a silent twin of each job: the "
                           "export's audio is the music stem; the lossless reference of the same "
                           "documents as a cross-check; 3 removals per clip; fades 0"),
                "cases": cases, "failures": sum(not c.get("pass", False) for c in cases),
                "pass": bool(cases) and all(c.get("pass", False) for c in cases)}

    # G3 / G3b -------------------------------------------------------------------------------------

    def loudness(self) -> tuple[dict[str, Any], dict[str, Any]]:
        g3_cases, g3b_cases = [], []
        for index, (role, kind, settings) in enumerate(LOUDNESS_PLANS):
            clip = self.clip(role)
            doc = self.doc(clip, kind, removals=clip.removals(2), **settings)
            result = export(clip, doc, self.work / "loudness" / f"{index:02d}-{role}-{kind}.mp4")
            row: dict[str, Any] = {"role": role, "clip": clip.label, "music": kind,
                                   "settings": settings,
                                   "music_lufs": self.music(clip, kind)[1]["lufs_c"] / 100}
            if "path" not in result:
                row.update(error=result["error"], pass_=False)
            else:
                row.update({k: v for k, v in result.items() if k != "path"})
                row["peak_reduced_db"] = _detail(result["warnings"], "peak_reduced")
                row["loudness_clamped_lufs"] = _detail(result["warnings"], "loudness_clamped")
                result["path"].unlink(missing_ok=True)
            if settings.get("master") == "normalize":
                g3_cases.append({**row, "target_lufs": -14.0, "pass": "error" not in row and g3_pass(
                    export_i=row["export_i_lufs"], export_tp=row["export_tp_dbtp"], target=-14.0,
                    clamped=row["loudness_clamped_lufs"])})
            g3b_cases.append({**row, "pass": "error" not in row and g3b_pass(row["export_tp_dbtp"])})
        g3 = {"gate": "G3", "task": TASK, "media": self.media, "threshold": {"target_lufs": -14.0,
              "tolerance_lu": G3_TOLERANCE_LU, "clamped_tolerance_lu": G3_CLAMPED_TOLERANCE_LU,
              "tp_max_dbtp": TP_MAX_DBTP}, "measured_on": "decoded export (AAC-LC 192k)",
              "cases": g3_cases, "failures": sum(not c["pass"] for c in g3_cases),
              "pass": bool(g3_cases) and all(c["pass"] for c in g3_cases)}
        g3b = {"gate": "G3b", "task": TASK, "media": self.media, "threshold": {"tp_max_dbtp": TP_MAX_DBTP},
               "measured_on": "decoded export (AAC-LC 192k)",
               "loud_track": "square bass, bright chord and pink noise limited at full scale",
               "cases": g3b_cases, "failures": sum(not c["pass"] for c in g3b_cases),
               "pass": bool(g3b_cases) and all(c["pass"] for c in g3b_cases)}
        return g3, g3b

    # G-CLICK --------------------------------------------------------------------------------------

    def click(self) -> dict[str, Any]:
        cases = []
        for role in CLICK_ROLES:
            clip = self.clip(role)
            case: dict[str, Any] = {"role": role, "clip": clip.label, "cut_fade_ms": 8}
            measured = {}
            for cut, mid_word in (("word_bounds", False), ("mid_word", True)):
                doc = self.doc(clip, "tone", removals=clip.removals(8, mid_word=mid_word))
                plan = clip.plan(doc)
                joins = [tm.smp(piece.out_f0, plan.fps) for piece in plan.pieces[1:]]
                faded = reference_pcm(clip, doc, self.work / "click", f"{role}-{cut}-faded")
                steps = join_steps_dbfs(faded, joins)
                hard_doc = copy.deepcopy(doc)
                hard_doc["main"]["cut_fade_ms"] = 0
                for join in hard_doc["main"]["joins"]:
                    join["audio_fade_ms"] = 0
                hard = join_steps_dbfs(reference_pcm(clip, hard_doc, self.work / "click",
                                                     f"{role}-{cut}-hard"), joins)
                measured[cut] = (steps, hard)
                case[cut] = {
                    "joins": len(joins), "cold_open": any(p.role == "cold_open" for p in plan.pieces),
                    "steps_dbfs": [_round(v, 2) for v in steps],
                    "max_step_dbfs": _round(max(steps, default=-math.inf), 2),
                    "samples": len(faded) // 2, "plan_samples": plan.total_samples,
                    "control_hard_cuts_max_dbfs": _round(max(hard, default=-math.inf), 2),
                    "control_hard_cuts_at_or_over_threshold": sum(
                        v >= CLICK_THRESHOLD_DBFS for v in hard)}
            case["pass"] = click_pass(measured["word_bounds"][0], measured["mid_word"][0],
                                      measured["mid_word"][1])
            cases.append(case)
        return {"gate": "G-CLICK", "task": TASK, "media": self.media, "threshold_dbfs": CLICK_THRESHOLD_DBFS,
                "measured_on": "lossless reference (the export's graph before AAC), music in the mix",
                "music": "tone chord at SetMusic's default gain, ducking Sedang",
                "cuts": ("8 two-word removals per clip, cut on the bounds table (word_bounds) and "
                         "at the middle of their first and last word (mid_word); the control is "
                         "the mid-word cuts with every fade at 0 ms and must show a click"),
                "cases": cases, "failures": sum(not c["pass"] for c in cases),
                "pass": bool(cases) and all(c["pass"] for c in cases)}


# --- the lane gates (through the running app) ------------------------------------------------------


class Lane:
    def __init__(self, base_url: str, jobs_root: Path, work: Path) -> None:
        self.tools = lane_tools()
        self.app = self.tools.App(base_url, os.environ.get("E2E_USERNAME", ""),
                                  os.environ.get("E2E_PASSWORD", ""))
        self.jobs_root, self.work = jobs_root, work
        self.exports = Exports(jobs_root, work)

    def _plan_and_wait(self, clip: Clip, doc: Mapping[str, Any], *,
                       refresh: bool = False) -> tuple[Path | None, dict]:
        """Plan ``doc`` and wait for its mix; ``refresh`` plans again once it exists, so the DTO
        carries the mix's own warnings (peak_reduced, loudness_clamped), as the editor sees them."""
        status, dto, _ms = self.app.plan(clip.job_dir.name, clip.dir.name, doc)
        if status != 200:
            return None, {"status": status}
        key16 = dto["audio"]["mixSha256"][:16]
        flac = clip.dir / "preview" / "audio" / f"{key16}.flac"
        if self.tools.wait_for([flac, flac.with_suffix(".json")], 300) is None:
            return None, dto
        if refresh:
            status, fresh, _ms = self.app.plan(clip.job_dir.name, clip.dir.name, doc)
            if status == 200:
                dto = fresh
        return flac, dto

    def p_aud(self, fixtures: Path | None) -> dict[str, Any]:
        cases = []
        manifest = []
        if fixtures is not None:
            fixtures.mkdir(parents=True, exist_ok=True)
        for index, (role, kind, settings) in enumerate(P_AUD_VARIANTS):
            clip = self.exports.clip(role)
            doc = self.exports.doc(clip, kind, removals=clip.removals(3), **settings)
            if settings.get("loop") is False:
                # a short track that ends inside the clip (music_shorter_than_clip)
                asset, meta = store_asset(clip.job_dir, make_music(
                    self.work / "music" / "tone-8s.m4a", "tone", seconds=8)
                    if not (self.work / "music" / "tone-8s.m4a").exists()
                    else self.work / "music" / "tone-8s.m4a")
                doc = music_doc(clip.seed, clip.etag, asset, meta, removals=clip.removals(3),
                                **settings)
            flac, dto = self._plan_and_wait(clip, doc, refresh=True)
            case_id = f"{index:02d}-{role}-{kind}"
            if flac is None:
                cases.append({"case": case_id, "error": dto, "pass": False})
                continue
            plan = clip.plan(doc)
            reference = reference_pcm(clip, doc, self.work / "paud", case_id)
            preview = pcm_of(flac)
            entry = {"case": case_id, "role": role, "clip": clip.label, "music": kind,
                     "settings": settings,
                     "plan_samples": plan.total_samples, "preview_samples": len(preview) // 2,
                     "reference_samples": len(reference) // 2,
                     "measured": needs_measurement(plan.doc),
                     "warnings": [w["code"] for w in dto.get("warnings", [])],
                     "md5_equal": hashlib.md5(preview.tobytes()).digest()
                     == hashlib.md5(reference.tobytes()).digest()}
            entry["pass"] = entry["md5_equal"] and entry["preview_samples"] == plan.total_samples
            cases.append(entry)
            if fixtures is not None:
                shutil.copyfile(flac, fixtures / f"{case_id}.flac")
                (fixtures / f"{case_id}.pcm").write_bytes(reference.tobytes())
                manifest.append({"id": case_id, "flac": f"{case_id}.flac", "pcm": f"{case_id}.pcm",
                                 "planSamples": plan.total_samples})
        if fixtures is not None:
            (fixtures / "manifest.json").write_text(json.dumps({"cases": manifest}, indent=2))
        return {"gate": "P-AUD", "task": TASK, "media": self.exports.media, "threshold": {"pcm_md5": "equal",
                "samples": "== plan"}, "through": "the app's preview lane (persistent worker)",
                "cases": cases, "failures": sum(not c["pass"] for c in cases),
                "pass": bool(cases) and all(c["pass"] for c in cases)}

    def pf_audio(self, runs: int = 20) -> dict[str, Any]:
        """Edit → fresh mix on a 90 s clip with music, for the edits the Musik panel makes."""
        clip = self.exports.clip(PF_AUDIO_ROLE)
        asset, meta = self.exports.music(clip, "bed")
        base = music_doc(clip.seed, clip.etag, asset, meta)
        body = base["main"]["segments"][-1]
        others = sum(s["out_sf"] - s["in_sf"] for s in base["main"]["segments"][:-1])
        want = 90 * clip.fps.num // clip.fps.den - others
        high = tm.sf_floor(base["base"]["window_ms"][1], clip.fps)
        body["out_sf"] = min(body["in_sf"] + want, high)
        if body["out_sf"] - body["in_sf"] < want:
            body["in_sf"] = max(body["out_sf"] - want, tm.sf_ceil(base["base"]["window_ms"][0],
                                                                  clip.fps))
        seconds = round(tm.total_frames(tm.pieces(base)) * clip.fps.den / clip.fps.num, 2)
        # warm-up: the first plan of the clip queues its plate cells; let them finish
        self.app.plan(clip.job_dir.name, clip.dir.name, base)
        time.sleep(20)
        shutil.rmtree(clip.dir / "preview" / "audio", ignore_errors=True)
        presets = list(PRESETS)
        edits = []
        for i in range(runs):
            doc = copy.deepcopy(base)
            payload = doc["tracks"][-1]["items"][0]["payload"]
            kind = i % 5
            if kind == 0:
                payload["duck"]["depth_cdb"] = PRESETS[presets[(i // 5) % 3]] + 10 * i
            elif kind == 1:
                payload["gain_cdb"] = default_gain(meta["lufs_c"]) - 10 * (i + 1)
            elif kind == 2:
                payload["fade_in_f"] = 5 + i
            elif kind == 3:
                doc["audio"]["master"]["mode"] = "normalize"
                doc["audio"]["source"]["gain_cdb"] = -50 * i
            else:
                payload["duck"]["release_ms"] = 300 + 50 * i
            edits.append(doc)
        times, failures = [], 0
        loads = []
        for doc in edits:
            self.app._pace("plan", self.tools.PLAN_INTERVAL_S)
            started = time.perf_counter()
            flac, _dto = self._plan_and_wait(clip, doc)
            if flac is None:
                failures += 1
                continue
            times.append((time.perf_counter() - started) * 1000)
            loads.append(os.getloadavg()[0])
            time.sleep(0.3)  # the next edit comes after the mix, as in a session
        stages = self.tools.stage_breakdown("audio", self.tools.Clip(
            self.jobs_root, clip.job_dir.name, clip.dir), edits[0], self.work, [])
        result = {"gate": "PF-AUDIO", "task": TASK, "media": self.exports.media, "clip": clip.label,
                  "threshold_ms": 1000, "clip_seconds": seconds,
                  "edits": ["duck preset/depth", "music gain", "fade in", "normalize + source gain",
                            "release"],
                  "with_music_ms": self.tools.summary(times) if times else None,
                  "failures": failures, "loadavg_during": [round(min(loads), 2), round(max(loads), 2)]
                  if loads else None, "with_music_stages_ms": stages}
        result["pass"] = failures == 0 and bool(times) and result["with_music_ms"]["p95"] <= 1000
        return result


# --- evidence and CLI -------------------------------------------------------------------------------


def environment() -> dict[str, Any]:
    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    return {"ffmpeg": first[0] if first else None, "python": platform.python_version(),
            "cpus_visible": os.cpu_count(), "loadavg": [round(x, 2) for x in os.getloadavg()]}


def _jsonable(value: Any) -> Any:
    if isinstance(value, dict):
        return {("pass" if k == "pass_" else k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Path):
        return value.name
    return value


def write_evidence(directory: Path, gate: str, result: Mapping[str, Any],
                   label: str | None = None) -> Path:
    """``<task>-<gate>.json``; with ``label`` the result joins the file's ``runs`` under that name
    (a timing gate measured at several loads keeps every run)."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{TASK}-{gate}.json"
    body = {**_jsonable(dict(result)), "environment": environment()}
    if label is not None:
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
        runs = previous.get("runs", {}) if isinstance(previous, dict) else {}
        body = {"gate": gate, "task": TASK, "runs": {**runs, label: body}}
    path.write_text(json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    return path


def run_gates(steps: Sequence[tuple[Sequence[str], Any]], evidence: Path | None,
              label: str | None = None) -> list[str]:
    """Run each step (gate names, a function returning their reports) and write each gate's
    evidence as soon as it ends: a crash (a stalled render on a busy machine) fails that step's
    gates alone, keeps the evidence already written and the run goes on."""
    failures: list[str] = []
    for names, compute in steps:
        try:
            reports = compute()
        except (errors.EditV2Error, OSError, RuntimeError, ValueError,
                subprocess.SubprocessError) as error:
            reason = f"{type(error).__name__}: {getattr(error, 'code', None) or error}"
            for gate in names:
                print(f"{gate}: FAIL ({reason})", flush=True)
            failures.extend(names)
            continue
        for gate, report in zip(names, reports, strict=True):
            if evidence is not None:
                write_evidence(evidence, gate, report, label)
            print(f"{gate}: {'pass' if report.get('pass') else 'FAIL'}", flush=True)
            if not report.get("pass"):
                failures.append(gate)
    return failures


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="T3.3 music gates on exports")
    commands = parser.add_subparsers(dest="command", required=True)
    setup = commands.add_parser("setup", help="copy and prepare the jobs (and silent twins)")
    setup.add_argument("--originals", type=Path, required=True,
                       help="the P3 jobs directory, or with --synthetic a make_job.py build")
    setup.add_argument("--synthetic", action="store_true",
                       help="use the synthetic V3 jobs of scripts/editor_fixture/make_job.py")
    setup.add_argument("--jobs-root", type=Path, required=True)
    setup.add_argument("--twins", action="store_true")
    exports = commands.add_parser("exports", help="duck, G3, G3b and G-CLICK on exports")
    exports.add_argument("--jobs-root", type=Path, required=True)
    exports.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "t33-audio")
    exports.add_argument("--evidence", type=Path)
    exports.add_argument("--gate", choices=("all", "duck", "loudness", "click"), default="all")
    lane = commands.add_parser("lane", help="P-AUD and PF-AUDIO through the running app")
    lane.add_argument("gate", choices=("p-aud", "pf-audio"))
    lane.add_argument("--base-url", required=True)
    lane.add_argument("--jobs-root", type=Path, required=True)
    lane.add_argument("--work", type=Path, default=Path(tempfile.gettempdir()) / "t33-lane")
    lane.add_argument("--evidence", type=Path)
    lane.add_argument("--browser-fixtures", type=Path)
    lane.add_argument("--label", help="keep this run beside earlier ones in the evidence file")
    args = parser.parse_args(argv)

    if args.command == "setup":
        args.jobs_root.mkdir(parents=True, exist_ok=True)
        twins = {}
        originals, media, roles = args.originals, "p3", p3_roles()
        if args.synthetic:
            make_job = _load("make_job", ROOT / "scripts" / "editor_fixture" / "make_job.py")
            from ai_clipper.edit_v2 import camera

            # the fixture's stub camera, as `make_job.py build --prepare --stub-camera`
            camera.detect_face_track = make_job._stub_detector
            roles = synthetic_roles(json.loads((args.originals / "fixture.json").read_text()))
            originals, media = args.originals / "jobs", "synthetic"
        for job in dict.fromkeys(entry["job"] for entry in roles.values()):
            copied = copy_job(originals / job, args.jobs_root / job)
            entries = prepare(copied)
            print(job, [(e["index"], e["openable"], e["reason"]) for e in entries], flush=True)
            if args.twins and any(roles[role]["job"] == job for role in TWIN_ROLES):
                twin = make_twin(copied, args.jobs_root)
                twins[job] = twin.name
                entries = prepare(twin)
                print("  twin", twin.name, [(e["index"], e["openable"]) for e in entries], flush=True)
        if twins:
            (args.jobs_root / TWINS_FILE).write_text(json.dumps(twins, indent=2))
        write_roles(args.jobs_root, roles, media=media)
        return 0

    label = getattr(args, "label", None)
    if args.command == "exports":
        gates = Exports(args.jobs_root, args.work)
        steps = [(names, compute) for key, names, compute in (
            ("click", ("G-CLICK",), lambda: (gates.click(),)),
            ("duck", ("duck",), lambda: (gates.duck(),)),
            ("loudness", ("G3", "G3b"), gates.loudness),
        ) if args.gate in ("all", key)]
    else:
        lane_gates = Lane(args.base_url, args.jobs_root, args.work)
        steps = [(("P-AUD",), lambda: (lane_gates.p_aud(args.browser_fixtures),))] \
            if args.gate == "p-aud" else [(("PF-AUDIO",), lambda: (lane_gates.pf_audio(),))]
    failures = run_gates(steps, args.evidence, label)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
