#!/usr/bin/env python3
"""T2.3 gates through the server preview lane (plan §10.1 P-AUD, P-PLATE; §10.3 PF-PLAN,
PF-CELLS, PF-AUDIO, PF-TRUTH).

Everything is measured through the running app: a Next server (``next start``) with
``POTONGIN_EDITOR_V3=on`` and ``JOBS_ROOT`` on a scratch copy of the jobs, reached over HTTP the
way the editor reaches it (session cookie, same-origin headers, the rate limits of plan §9.1).
The lane's files are read back from ``--jobs-root``; the references (``reference`` and
``final`` renders, ``audio_measure``) are compiled here with the production modules, so run the
script where the server's FFmpeg is (the pinned image for the record).

Usage (stdlib only)::

    E2E_USERNAME=… E2E_PASSWORD=… python scripts/parity/preview_lane_gates.py GATE \\
        --base-url http://127.0.0.1:3291 --jobs-root /jobs --evidence docs/editor/evidence/W2 \\
        [--work DIR] [--label NAME]

``GATE``: ``pf-plan``, ``pf-truth``, ``pf-audio``, ``pf-cells``, ``p-aud``, ``p-plate`` or
``all``. The real jobs are the owner's P3 jobs (read-only originals, copied into
``--jobs-root`` and seeded with ``edit_v2.api prepare_job`` beforehand); ``p-plate`` also
builds the synthetic barcode job of ``scripts/editor_fixture/make_job.py`` under ``--work``
(its column ruler gives the crop x). Evidence: ``T2.3-<gate>.json``, numbers only.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import http.client
import http.cookies
import importlib.util
import json
import os
import platform
import random
import shutil
import statistics
import subprocess
import sys
import time

_T0 = time.perf_counter()  # before the ai_clipper imports (stage breakdowns)
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from ai_clipper.edit_v2 import compile_ffmpeg, execute, plates, store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.loudness import needs_measurement, parse_ebur128
from ai_clipper.edit_v2.plan import Resources, build_plan

TASK = "T2.3"
BUDGETS = {"pf_plan_ms": 200, "pf_truth_ms": 600, "pf_audio_ms": 1000,
           "pf_cells_s": {"fit_blur": 15.0, "fill_center": 15.0, "camera": 25.0}}
P_PLATE_SSIM_MARGIN = 0.002
PLAN_INTERVAL_S = 0.105  # plan ≤ 10/s per session (plan §9.1)
FRAME_INTERVAL_S = 0.26  # frame ≤ 4/s per session
# The owner's P3 jobs (docs/plans §11.0) by role; a job missing from --jobs-root is skipped.
REAL = {
    "fit_blur": ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 2),  # 60 fps source → 30, 60.2 s
    "fill_center": ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 2),  # VFR source, 62.2 s
    "camera": ("860fef1a-8140-4677-8d73-729d18f15431", 4),  # face-track, 25 fps, 57.9 s
    "fit_blur_2": ("899226f8-7e57-49d9-8c29-b078b2b91580", 3),  # 23.976 fps, 58.5 s + cold open
    "fit_blur_long": ("3c7d024c-f1f5-45a6-b767-9f2c190b0c42", 1),  # 78.0 s + cold open
    "fill_center_long": ("990f3f37-f0a6-490a-a9a2-a6d6cdab004e", 1),  # 78.1 s + cold open
}


# --- the app over HTTP -----------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class App:
    """The editor's view of the server: a session and paced POSTs."""

    def __init__(self, base_url: str, username: str, password: str) -> None:
        self.base = base_url.rstrip("/")
        self.opener = urllib.request.build_opener(_NoRedirect)
        self.last: dict[str, float] = {}
        form = urllib.parse.urlencode({"username": username, "password": password}).encode()
        request = urllib.request.Request(f"{self.base}/api/auth/login", data=form, method="POST",
                                         headers=self._headers("application/x-www-form-urlencoded"))
        try:
            response = self.opener.open(request, timeout=30)
            headers = response.headers
        except urllib.error.HTTPError as error:  # the 303 of a successful login
            headers = error.headers
        cookie = http.cookies.SimpleCookie(headers.get("Set-Cookie", ""))
        if "potongin_session" not in cookie:
            raise SystemExit("login failed: set E2E_USERNAME and E2E_PASSWORD for the server")
        self.cookie = f"potongin_session={cookie['potongin_session'].value}"

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {"Origin": self.base, "Sec-Fetch-Site": "same-origin"}
        if content_type:
            headers["Content-Type"] = content_type
        if getattr(self, "cookie", None):
            headers["Cookie"] = self.cookie
        return headers

    def _pace(self, kind: str, interval: float) -> None:
        wait = self.last.get(kind, 0.0) + interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self.last[kind] = time.monotonic()

    def post(self, path: str, body: bytes, *, kind: str | None = None,
             interval: float = 0.0) -> tuple[int, bytes, float]:
        if kind:
            self._pace(kind, interval)
        request = urllib.request.Request(f"{self.base}{path}", data=body, method="POST",
                                         headers=self._headers("application/json"))
        started = time.perf_counter()
        try:
            with self.opener.open(request, timeout=300) as response:
                data, status = response.read(), response.status
        except urllib.error.HTTPError as error:
            data, status = error.read(), error.code
        except (OSError, http.client.HTTPException) as error:  # a dropped connection
            print(f"POST {path}: {type(error).__name__}", file=sys.stderr, flush=True)
            data, status = b"{}", 0
        return status, data, (time.perf_counter() - started) * 1000

    def plan(self, job: str, clip: str, doc: Mapping, **fields) -> tuple[int, dict, float]:
        status, data, ms = self.post(f"/api/jobs/{job}/clips/{clip}/preview/plan",
                                     request_body(doc, **fields), kind="plan",
                                     interval=PLAN_INTERVAL_S)
        return status, json.loads(data or b"{}"), ms

    def frame(self, job: str, clip: str, doc: Mapping, f: int) -> tuple[int, bytes, float]:
        return self.post(f"/api/jobs/{job}/clips/{clip}/preview/frame", request_body(doc, f=f),
                         kind="frame", interval=FRAME_INTERVAL_S)

    def prepare(self, job: str, clip: str, layout: str | None) -> tuple[int, dict, float]:
        body = json.dumps({} if layout is None else {"layout": layout}).encode()
        status, data, ms = self.post(f"/api/jobs/{job}/clips/{clip}/prepare", body)
        return status, json.loads(data or b"{}"), ms


# --- documents -------------------------------------------------------------------------------------


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def request_body(doc: Mapping, **fields: Any) -> bytes:
    parts = [b'"doc":' + canonical(doc)]
    parts += [json.dumps(k).encode() + b":" + json.dumps(v).encode() for k, v in fields.items()]
    return b"{" + b",".join(parts) + b"}"


class Clip:
    def __init__(self, jobs_root: Path, job_id: str, clip_dir: Path) -> None:
        self.jobs_root, self.job_id, self.dir = jobs_root, job_id, clip_dir
        self.id = clip_dir.name
        self.job_dir = jobs_root / job_id
        self.seed, self.etag = store.seed(clip_dir)
        self.words = store.load_words(clip_dir, self.seed["base"]["words"]["sha256"])
        self.fps = tm.Fps.from_json(self.seed["output"]["fps"])
        self.source = plates.source_path(self.job_dir)

    @property
    def preview(self) -> Path:
        return self.dir / "preview"

    def revision(self, **changes: Any) -> dict:
        doc = copy.deepcopy(self.seed)
        doc["revision"] = 1
        doc["parent_sha256"] = self.etag
        doc["audit"]["editor"] = "editor-v3/1.0.0"
        doc["audit"]["last_command"] = "SetCaptionOverride"
        for key, value in changes.items():
            target = doc
            parts = key.split("__")
            for part in parts[:-1]:
                target = target[part]
            target[parts[-1]] = value
        return doc

    def body_words(self, doc: Mapping) -> list[dict]:
        body = doc["main"]["segments"][-1]
        scale = 1000 * self.fps.den
        return [w for w in self.words["words"]
                if body["in_sf"] * scale <= (w["s"] + w["e"]) // 2 * self.fps.num
                < body["out_sf"] * scale]

    def removal(self, doc: Mapping, first: int, count: int, rid: str) -> dict | None:
        """A removal of ``count`` body words from index ``first``, cut on the bounds table."""
        words = self.body_words(doc)
        if first + count >= len(words) - 1 or first < 1:
            return None
        chosen = words[first:first + count]
        before = {b["before"]: b for b in self.words["bounds"]}
        after = {b["after"]: b for b in self.words["bounds"]}
        in_sf, out_sf = before[chosen[0]["id"]]["sf"], after[chosen[-1]["id"]]["sf"]
        body = doc["main"]["segments"][-1]
        if not body["in_sf"] < in_sf < out_sf < body["out_sf"]:
            return None
        return {"id": rid, "seg": body["id"], "in_sf": in_sf, "out_sf": out_sf,
                "words": [w["id"] for w in chosen], "reason": "user", "origin": "user"}

    def with_removals(self, doc: dict, count: int, *, offset: int = 0) -> dict:
        words = self.body_words(doc)
        spacing = max(len(words) // (count + 1), 4)
        removals = []
        for index in range(count):
            removal = self.removal(doc, offset + spacing * (index + 1), 2, f"rm_{index + 1}")
            if removal is not None and (not removals or removal["in_sf"] >= removals[-1]["out_sf"]):
                removals.append(removal)
        doc["main"]["removals"] = removals
        return doc

    def plan(self, doc: Mapping, camera: Mapping | None = None, assets: Mapping | None = None):
        return build_plan(doc, words=self.words, camera=camera, assets=assets or {},
                          resources=Resources(RESOURCES_DIR))


def find_clip(jobs_root: Path, job_id: str, rank: int) -> Clip | None:
    clips = jobs_root / job_id / "analysis" / "clips"
    if not clips.is_dir():
        return None
    for seed_file in sorted(clips.glob("clip_*/seed.json")):
        seed = json.loads(seed_file.read_bytes())
        if seed["base"]["origin"]["rank_at_seed"] == rank:
            return Clip(jobs_root, job_id, seed_file.parent)
    return None


def real_clip(jobs_root: Path, role: str) -> Clip | None:
    job_id, rank = REAL[role]
    return find_clip(jobs_root, job_id, rank)


# --- media helpers ---------------------------------------------------------------------------------


def wait_for(paths: Sequence[Path], timeout_s: float, poll_s: float = 0.01) -> float | None:
    """Seconds until every path exists (None on timeout)."""
    started = time.perf_counter()
    pending = list(paths)
    while pending:
        pending = [p for p in pending if not p.exists()]
        if not pending:
            break
        if time.perf_counter() - started > timeout_s:
            return None
        time.sleep(poll_s)
    return time.perf_counter() - started


def pcm(path: Path) -> bytes:
    return subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i",
                           str(path), "-map", "0:a:0", "-f", "s16le", "-acodec", "pcm_s16le",
                           "-"], capture_output=True, check=True).stdout


def run_to(job: Any, out: Path, timeout_s: float = 1800) -> float:
    fd = os.open(out, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        return execute.run(job, output_fd=fd, timeout_s=timeout_s).elapsed_s
    finally:
        os.close(fd)


def measured_loudness(plan: Any, source: Path, assets_root: Path):
    if not needs_measurement(plan.doc):
        return None
    job = compile_ffmpeg.compile_job(plan, mode="audio_measure", source=source,
                                     assets_root=assets_root)
    return parse_ebur128(execute.run(job, output_fd=None, timeout_s=1800).stderr)


def png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def percentile(values: Sequence[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))]


def summary(values: Sequence[float], digits: int = 1) -> dict[str, float]:
    return {"n": len(values), "p50": round(statistics.median(values), digits),
            "p95": round(percentile(values, 0.95), digits), "max": round(max(values), digits),
            "min": round(min(values), digits)}


def clear_preview(clip: Clip, kinds: Sequence[str] = ("plates", "audio", "frames", "derived")) -> None:
    for kind in kinds:
        shutil.rmtree(clip.preview / kind, ignore_errors=True)


def music_asset(job_dir: Path, work: Path, seconds: int = 180) -> tuple[str, dict]:
    """A synthetic music bed (chords over pink noise), normalised like an upload (§9.2: AAC-LC
    192k, 48 kHz, stereo) and stored in the job's asset store."""
    work.mkdir(parents=True, exist_ok=True)
    out = work / "music.m4a"
    graph = (f"sine=f=220:d={seconds}[a];sine=f=277:d={seconds}[b];sine=f=330:d={seconds}[c];"
             f"anoisesrc=color=pink:amplitude=0.08:d={seconds}:seed=7[n];"
             "[a][b][c][n]amix=inputs=4:normalize=0,volume=0.6,"
             "pan=stereo|c0=c0|c1=c0,aresample=48000")
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-filter_complex", graph, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-ac", "2", "-map_metadata", "-1", "-fflags", "+bitexact",
                    "-flags:a", "+bitexact", str(out)], check=True)
    data = out.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    assets = job_dir / "analysis" / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / f"{digest}.m4a").write_bytes(data)
    meta = {"kind": "audio", "mime": "audio/mp4", "duration_ms": seconds * 1000, "lufs_c": -1600}
    (assets / f"{digest}.json").write_text(json.dumps(meta))
    return f"sha256:{digest}", meta


def music_track(asset: str, gain_cdb: int) -> dict:
    return {"id": "tr_mus", "kind": "audio", "role": "music", "items": [{
        "id": "it_music", "type": "audio", "start": {"at": "clip_start"},
        "end": {"at": "clip_end"},
        "payload": {"asset": asset, "src_in_smp": 0, "loop": True, "gain_cdb": gain_cdb,
                    "fade_in_f": 15, "fade_out_f": 30,
                    "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                             "hold_ms": 250, "detector": "words"}},
        "origin": "user"}]}


def with_music(doc: dict, asset: str, meta: Mapping, gain_cdb: int) -> dict:
    doc["tracks"] = [t for t in doc["tracks"] if t["kind"] != "audio"] + [
        music_track(asset, gain_cdb)]
    doc["assets"] = {**doc["assets"], asset: dict(meta)}
    return doc


# --- gates -----------------------------------------------------------------------------------------


class Gates:
    def __init__(self, app: App, jobs_root: Path, work: Path) -> None:
        self.app, self.jobs_root, self.work = app, jobs_root, work
        self.work.mkdir(parents=True, exist_ok=True)
        self._music: dict[str, tuple[str, dict]] = {}

    def music(self, clip: Clip) -> tuple[str, dict]:
        if clip.job_id not in self._music:
            self._music[clip.job_id] = music_asset(clip.job_dir, self.work / clip.job_id)
        return self._music[clip.job_id]

    # PF-PLAN ----------------------------------------------------------------------------------

    def _edits(self, clip: Clip) -> Callable[[int], dict]:
        hook = next((t for t in clip.seed["tracks"] if t["kind"] == "hook" and t["items"]), None)
        packs = ("classic", "karaoke", "bold", "box")

        def edit(i: int) -> dict:
            kind = i % 4
            doc = clip.revision()
            if kind == 0:
                doc["captions"]["overrides"]["y_e5"] = 60000 + (i * 137) % 30000
            elif kind == 1 and hook is not None:
                text = hook["items"][0]["payload"]["text"][:70].rstrip()
                next(t for t in doc["tracks"] if t["kind"] == "hook")["items"][0]["payload"][
                    "text"] = f"{text} {i}"
            elif kind == 2:
                clip.with_removals(doc, 1 + i % 3, offset=i % 5)
            else:
                doc["captions"]["pack"] = {"id": packs[i % 4], "v": 1}
                doc["captions"]["overrides"]["case"] = "upper" if packs[i % 4] == "bold" else "asis"
            return doc

        return edit

    def pf_plan(self) -> dict[str, Any]:
        cases = []
        all_ms: list[float] = []
        for role in ("fit_blur_long", "fill_center_long", "fit_blur_2"):
            clip = real_clip(self.jobs_root, role)
            if clip is None:
                continue
            edit = self._edits(clip)
            known = None
            for i in range(6):  # warm-up: page cache, pyc, the lane's first cells and mix
                status, dto, _ms = self.app.plan(clip.job_id, clip.id, edit(1000 + i))
                known = dto.get("text", {}).get("assSha256")
            times, sizes, failures = [], [], 0
            for i in range(40):
                fields = {"known": {"assSha256": known}} if known else {}
                status, dto, ms = self.app.plan(clip.job_id, clip.id, edit(i), **fields)
                if status != 200:
                    failures += 1
                    continue
                known = dto["text"]["assSha256"]
                times.append(ms)
                sizes.append(len(canonical(dto)))
            cli = self._cli_plan(clip, edit)
            all_ms += times
            cases.append({"role": role, "frames": clip.plan(clip.seed).total_frames,
                          "words": len(clip.words["words"]), "http_ms": summary(times),
                          "failures": failures, "dto_bytes_max": max(sizes),
                          "cli_process_ms": cli})
        overall = summary(all_ms)
        return {"threshold_ms": BUDGETS["pf_plan_ms"], "cases": cases, "http_ms": overall,
                "pass": overall["p95"] <= BUDGETS["pf_plan_ms"]
                and all(c["failures"] == 0 for c in cases)}

    def _cli_plan(self, clip: Clip, edit: Callable[[int], dict], n: int = 20) -> dict:
        """The Python process alone (as python-cli spawns it), for the breakdown."""
        env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(self.jobs_root),
               "LANG": "C.UTF-8", "HOME": os.environ.get("HOME", "/tmp")}
        if "PYTHONPATH" in os.environ:
            env["PYTHONPATH"] = os.environ["PYTHONPATH"]
        times = []
        for i in range(n):
            envelope = {"op": "plan", "jobId": clip.job_id, "clipId": clip.id,
                        "requestRaw": base64.b64encode(request_body(edit(500 + i))).decode()}
            started = time.perf_counter()
            result = subprocess.run([sys.executable, "-m", "ai_clipper.edit_v2.preview_cli"],
                                    input=json.dumps(envelope).encode(), capture_output=True,
                                    env=env, check=False)
            if result.returncode == 0:
                times.append((time.perf_counter() - started) * 1000)
        return summary(times)

    # PF-TRUTH ---------------------------------------------------------------------------------

    def pf_truth(self) -> dict[str, Any]:
        rng = random.Random(23)
        cases, all_ms = [], []
        for role in ("fit_blur", "fill_center", "camera"):
            clip = real_clip(self.jobs_root, role)
            if clip is None:
                continue
            doc = clip.revision()
            doc["captions"]["overrides"]["y_e5"] = 80000  # an edited document (not revision 0)
            total = clip.plan(clip.seed, camera=plates.camera_for(clip.dir, clip.seed)[0]).total_frames
            clear_preview(clip, ("frames",))
            self.app.frame(clip.job_id, clip.id, doc, 0)  # warm-up
            times, bad = [], 0
            for f in rng.sample(range(1, total), 12):
                status, data, ms = self.app.frame(clip.job_id, clip.id, doc, f)
                if status != 200 or png_size(data) != (720, 1280):
                    bad += 1
                    continue
                times.append(ms)
            all_ms += times
            cases.append({"role": role, "layout": clip.seed["layout"]["default"]["mode"],
                          "http_ms": summary(times), "failures": bad,
                          "stages_ms": stage_breakdown("frame", clip, doc, self.work,
                                                       rng.sample(range(1, total), 3))})
        overall = summary(all_ms)
        return {"threshold_ms": BUDGETS["pf_truth_ms"], "cases": cases, "http_ms": overall,
                "pass": overall["p95"] <= BUDGETS["pf_truth_ms"]
                and all(c["failures"] == 0 for c in cases)}

    # PF-AUDIO ---------------------------------------------------------------------------------

    def _ninety(self, clip: Clip) -> dict:
        """A revision whose output is 90 s: the body extended inside the clip window."""
        doc = clip.revision()
        body = doc["main"]["segments"][-1]
        others = sum(s["out_sf"] - s["in_sf"] for s in doc["main"]["segments"][:-1])
        want = 90 * clip.fps.num // clip.fps.den - others
        high = tm.sf_floor(doc["base"]["window_ms"][1], clip.fps)
        body["out_sf"] = min(body["in_sf"] + want, high)
        if body["out_sf"] - body["in_sf"] < want:
            body["in_sf"] = max(body["out_sf"] - want,
                                tm.sf_ceil(doc["base"]["window_ms"][0], clip.fps))
        return doc

    def _mix_latency(self, clip: Clip, docs: Sequence[dict]) -> tuple[list[float], int]:
        times, failures = [], 0
        for doc in docs:
            self.app._pace("plan", PLAN_INTERVAL_S)
            started = time.perf_counter()
            status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc)
            if status != 200:
                failures += 1
                continue
            key16 = dto["audio"]["mixSha256"][:16]
            ready = wait_for([clip.preview / "audio" / f"{key16}.flac",
                              clip.preview / "audio" / f"{key16}.json"], 120)
            if ready is None:
                failures += 1
                continue
            times.append((time.perf_counter() - started) * 1000)
            time.sleep(0.3)  # the next edit comes after the mix, as in a session
        return times, failures

    def pf_audio(self) -> dict[str, Any]:
        clip = real_clip(self.jobs_root, "fit_blur_2")
        if clip is None:
            return {"pass": False, "error": "no clip"}
        asset, meta = self.music(clip)
        base = self._ninety(clip)
        total = clip.plan(base).total_frames
        # warm-up: the first plan of the clip also queues its cells; let them finish
        self.app.plan(clip.job_id, clip.id, base)
        time.sleep(20)
        with_music_docs = []
        for i in range(16):
            doc = with_music(copy.deepcopy(base), asset, meta, -1000 + 7 * i)
            with_music_docs.append(doc)
        music_ms, music_failures = self._mix_latency(clip, with_music_docs)
        speech_docs = []
        for i in range(10):
            doc = copy.deepcopy(base)
            doc["audio"]["source"]["gain_cdb"] = -10 * (i + 1)
            speech_docs.append(doc)
        speech_ms, speech_failures = self._mix_latency(clip, speech_docs)
        music_stages = stage_breakdown("audio", clip, with_music_docs[0], self.work, [])
        speech_stages = stage_breakdown("audio", clip, speech_docs[0], self.work, [])
        result = {"threshold_ms": BUDGETS["pf_audio_ms"],
                  "clip_seconds": round(total * clip.fps.den / clip.fps.num, 2),
                  "with_music_ms": summary(music_ms), "with_music_failures": music_failures,
                  "speech_only_ms": summary(speech_ms), "speech_only_failures": speech_failures,
                  "with_music_stages_ms": music_stages, "speech_only_stages_ms": speech_stages}
        result["pass"] = (music_failures == 0
                          and result["with_music_ms"]["p95"] <= BUDGETS["pf_audio_ms"])
        return result

    # PF-CELLS ---------------------------------------------------------------------------------

    def _cells_case(self, clip: Clip, layout: str, *, build_camera: bool) -> dict[str, Any]:
        clear_preview(clip)
        if build_camera and clip.seed["base"]["camera"]["sha256"] is None:
            for path in clip.dir.glob("camera.*.json"):
                path.unlink()
        doc = clip.revision()
        doc["layout"]["default"]["mode"] = layout
        started = time.perf_counter()
        status, _prepared, prepare_ms = self.app.prepare(clip.job_id, clip.id, layout)
        if status != 202:
            return {"error": f"prepare {status}", "pass": False}
        status, dto, plan_ms = self.app.plan(clip.job_id, clip.id, doc, playhead=0)
        if status != 200:
            return {"error": f"plan {status}", "pass": False}
        key = dto["plate"]["plateKey"]
        cells = [c["k"] for c in dto["plate"]["cells"]]
        paths = [clip.preview / "plates" / plates.cell_name(key, k) for k in cells]
        first = wait_for(paths[:1], 300)
        rest = wait_for(paths, 600)
        elapsed = time.perf_counter() - started
        budget = BUDGETS["pf_cells_s"][layout]
        seconds = round(dto["totalFrames"] * clip.fps.den / clip.fps.num, 2)
        return {"layout": layout, "clip_seconds": seconds, "cells": len(cells),
                "camera_plan_built": build_camera, "prepare_ms": round(prepare_ms, 1),
                "plan_ms": round(plan_ms, 1),
                "first_cell_s": None if first is None else round(first + prepare_ms / 1000, 2),
                "all_cells_s": None if rest is None else round(elapsed, 2),
                "budget_s": budget, "pass": rest is not None and elapsed <= budget}

    def pf_cells(self) -> dict[str, Any]:
        cases = []
        for role, layout, camera in (("fit_blur", "fit_blur", False),
                                     ("fill_center", "fill_center", False),
                                     ("fit_blur_2", "camera", True),
                                     ("camera", "camera", False)):
            clip = real_clip(self.jobs_root, role)
            if clip is None:
                continue
            case = self._cells_case(clip, layout, build_camera=camera)
            case["role"] = role
            cases.append(case)
            time.sleep(5)  # let the background mix of the case finish
        gated = [c for c in cases if not (c.get("layout") == "camera"
                                          and not c.get("camera_plan_built"))]
        return {"threshold_s": BUDGETS["pf_cells_s"], "heavy_slots": 2, "cases": cases,
                "pass": bool(gated) and all(c.get("pass") for c in gated)}

    # P-AUD ------------------------------------------------------------------------------------

    def p_aud(self) -> dict[str, Any]:
        cases = []
        for role, variant in (("fit_blur_2", "seed"), ("fit_blur_2", "edited"),
                              ("fit_blur_2", "music"), ("fill_center", "seed"),
                              ("fit_blur", "edited"), ("camera", "edited")):
            clip = real_clip(self.jobs_root, role)
            if clip is None:
                continue
            doc = clip.seed if variant == "seed" else clip.with_removals(clip.revision(), 4)
            assets: dict[str, Any] = {}
            if variant == "music":
                asset, meta = self.music(clip)
                doc = with_music(doc, asset, meta, -600)
                assets = {asset: meta}
            status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc)
            if status != 200:
                cases.append({"role": role, "variant": variant, "error": status, "pass": False})
                continue
            key16 = dto["audio"]["mixSha256"][:16]
            flac = clip.preview / "audio" / f"{key16}.flac"
            if wait_for([flac, flac.with_suffix(".json")], 300) is None:
                cases.append({"role": role, "variant": variant, "error": "timeout",
                              "pass": False})
                continue
            camera = plates.camera_for(clip.dir, doc)[0] if doc["layout"]["default"][
                "mode"] == "camera" else None
            plan = clip.plan(doc, camera=camera, assets=assets)
            assets_root = clip.job_dir / "analysis" / "assets"
            loudness = measured_loudness(plan, clip.source, assets_root)
            reference = self.work / f"paud-{clip.id}-{variant}.mkv"
            run_to(compile_ffmpeg.compile_job(plan, mode="reference", source=clip.source,
                                              assets_root=assets_root, loudness=loudness),
                   reference)
            preview_pcm, reference_pcm = pcm(flac), pcm(reference)
            reference.unlink()
            entry = {"role": role, "variant": variant,
                     "source_codec": subprocess.run(
                         ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                          "stream=codec_name", "-of", "csv=p=0", str(clip.source)],
                         capture_output=True, text=True, check=False).stdout.strip(),
                     "pieces": len(plan.pieces), "plan_samples": plan.total_samples,
                     "preview_samples": len(preview_pcm) // 4,
                     "reference_samples": len(reference_pcm) // 4,
                     "measured": loudness is not None,
                     "md5_equal": hashlib.md5(preview_pcm).digest()
                     == hashlib.md5(reference_pcm).digest()}
            entry["pass"] = entry["md5_equal"] and entry["preview_samples"] == plan.total_samples
            cases.append(entry)
        return {"threshold": {"pcm_md5": "equal", "samples": "== plan"}, "cases": cases,
                "pass": bool(cases) and all(c["pass"] for c in cases)}

    # P-PLATE ----------------------------------------------------------------------------------

    def p_plate(self) -> dict[str, Any]:
        frame_identity = _load("edit_v2_frame_identity",
                               ROOT / "scripts" / "parity" / "frame_identity.py")
        synthetic = self._synthetic_clip()
        cases = []
        for layout in ("fit_blur", "fill_center", "camera"):
            cases.append(self._plate_case(frame_identity, synthetic, layout, ruler=True))
        for role in ("fit_blur", "fill_center", "camera"):
            clip = real_clip(self.jobs_root, role)
            if clip is not None:
                cases.append(self._plate_case(frame_identity, clip,
                                              clip.seed["layout"]["default"]["mode"],
                                              ruler=False))
        return {"threshold": {"ssim_margin": P_PLATE_SSIM_MARGIN, "crop_x_px": 0},
                "cases": cases, "pass": bool(cases) and all(c["pass"] for c in cases)}

    def _synthetic_clip(self) -> Clip:
        """The synthetic barcode + column-ruler job (640×360, 29.97), seeded through the api
        CLI, with a sweeping camera plan for the face-track case."""
        make_job = _load("editor_fixture_make_job",
                         ROOT / "scripts" / "editor_fixture" / "make_job.py")
        out = self.work / "synthetic"
        index = make_job.build(out, size=(640, 360), only=["main"], force=True)
        entry = index["jobs"]["main"]
        target = self.jobs_root / entry["id"]
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(out / entry["dir"], target, symlinks=False)
        from ai_clipper.edit_v2 import seed as seed_module

        prepared = seed_module.prepare_legacy_job(target)
        clip = Clip(self.jobs_root, entry["id"],
                    target / "analysis" / "clips" / prepared[0]["clip_id"])
        window = clip.seed["base"]["window_ms"]
        samples, cuts = [], []
        for index, t_ms in enumerate(range(window[0], window[1], 750)):
            phase = index % 16
            samples.append([t_ms, 150 + (phase if phase < 8 else 16 - phase) * 90])
            cuts.append(index > 0 and index % 8 == 0)
        camera = {"schema": "potongin.camera-plan/1",
                  "source_content_sha256": clip.seed["base"]["source"]["content_sha256"],
                  "window_ms": list(window), "fps": list(clip.seed["output"]["fps"]),
                  "source": {"w": 640, "h": 360}, "output": {"w": 720, "h": 1280},
                  "sample_ms": 750, "samples": samples, "cuts": cuts, "no_face": []}
        from ai_clipper.edit_v2.camera import camera_file_name, encode_camera_plan

        raw = encode_camera_plan(camera)
        (clip.dir / camera_file_name(raw)).write_bytes(raw)
        return clip

    def _plate_case(self, fi: Any, clip: Clip, layout: str, *, ruler: bool) -> dict[str, Any]:
        from ai_clipper.edit_v2 import layouts

        doc = clip.revision()
        doc["layout"]["default"]["mode"] = layout
        doc["captions"]["enabled"] = False
        doc["tracks"] = [t for t in doc["tracks"] if t["kind"] != "hook"]
        clip.with_removals(doc, 10)
        clear_preview(clip)
        camera = plates.camera_for(clip.dir, doc)[0]
        plan = clip.plan(doc, camera=camera)
        status, dto, _ms = self.app.plan(clip.job_id, clip.id, doc, playhead=0)
        if status != 200:
            return {"layout": layout, "ruler": ruler, "error": status, "pass": False}
        key = dto["plate"]["plateKey"]
        size = dto["plate"]["cellFrames"]
        cells = [c["k"] for c in dto["plate"]["cells"]]
        if wait_for([clip.preview / "plates" / plates.cell_name(key, k) for k in cells],
                    900) is None:
            return {"layout": layout, "ruler": ruler, "error": "cells timeout", "pass": False}
        assets_root = clip.job_dir / "analysis" / "assets"
        reference = self.work / f"plate-{clip.id}-{layout}.reference.mkv"
        final = self.work / f"plate-{clip.id}-{layout}.final.mp4"
        run_to(compile_ffmpeg.compile_job(plan, mode="reference", source=clip.source,
                                          assets_root=assets_root), reference)
        run_to(compile_ffmpeg.compile_job(plan, mode="final", source=clip.source,
                                          assets_root=assets_root), final)
        output = plan.output

        def plate_frames():
            cache: dict[int, list[bytes]] = {}
            for n in range(plan.total_frames):
                sf = tm.out_to_src(n, plan.pieces)[1]
                k = sf // size
                if k not in cache:
                    cache.clear()
                    cache[k] = fi.decode_yuv420(clip.preview / "plates" / plates.cell_name(key, k),
                                                output)
                yield cache[k][sf % size]

        ssim_final = fi.ssim_files(final, reference)
        ssim_plate = fi.ssim_stream(plate_frames(), output, tuple(plan.fps.to_json()), reference,
                                    self.work)
        entry: dict[str, Any] = {
            "layout": layout, "ruler": ruler, "output_frames": plan.total_frames,
            "pieces": len(plan.pieces), "plate_cells": len(cells), "cell_frames": size,
            "ssim_final_vs_reference": ssim_final, "ssim_plate_vs_reference": ssim_plate,
            "ssim_margin": round(ssim_plate["All"] - (ssim_final["All"] - P_PLATE_SSIM_MARGIN),
                                 6)}
        ok = ssim_plate["All"] >= ssim_final["All"] - P_PLATE_SSIM_MARGIN
        if ruler and layout in ("fill_center", "camera"):
            source_size = (clip.seed["base"]["source"]["w"], clip.seed["base"]["source"]["h"])
            case = fi.Case("lane", tuple(plan.fps.to_json()), 0, layout, source_size=source_size,
                           output=output)
            crop_x = fi.crop_decoder(case)
            scaled = layouts.scaled_size(source_size, output)
            table = (layouts.crop_positions(camera, plan.fps, source=source_size, output=output,
                                            first_sf=0, count=max(p.out_sf for p in plan.pieces))
                     if layout == "camera" else None)
            center = (scaled[0] - output[0]) // 2
            mismatches = {"plate": 0, "reference": 0, "final": 0}
            undecodable = 0
            distinct = set()
            streams = zip((fi.gray_of_yuv420(f, output) for f in plate_frames()),
                          fi.iter_gray_frames(reference, output), fi.iter_gray_frames(final, output))
            for n, planes in enumerate(streams):
                sf = tm.out_to_src(n, plan.pieces)[1]
                want = table[sf] if table is not None else center
                distinct.add(want)
                for name, plane in zip(("plate", "reference", "final"), planes):
                    got = crop_x(plane)
                    undecodable += got is None
                    mismatches[name] += got != want
            entry.update(crop_x_mismatches=mismatches, crop_x_frames_checked=plan.total_frames,
                         crop_x_undecodable=undecodable, distinct_crop_x=len(distinct))
            ok = ok and not any(mismatches.values())
        reference.unlink()
        final.unlink()
        entry["pass"] = ok
        return entry


# --- stage breakdowns (a fresh interpreter each, like one lane process) -----------------------------


def _stages(kind: str, jobs_root: Path, job_id: str, clip_id: str, doc_file: Path,
            frame: int | None) -> dict[str, float]:
    """Milliseconds per stage of one truth frame (``kind="frame"``) or one preview mix
    (``kind="audio"``), inside a fresh process; run by ``stages`` (below)."""
    marks = [("start", _T0)]  # "imports" includes this script's own module-level imports
    from ai_clipper.edit_v2 import compile_ffmpeg as cf
    from ai_clipper.edit_v2 import execute as ex
    from ai_clipper.edit_v2 import plates as pl
    from ai_clipper.edit_v2 import preview_cli
    from ai_clipper.edit_v2 import store as st
    from ai_clipper.edit_v2.doc import iter_asset_ids, parse_doc, validate_doc
    from ai_clipper.edit_v2.glyphs import RESOURCES_DIR as resources_dir
    from ai_clipper.edit_v2.loudness import needs_measurement as needs
    from ai_clipper.edit_v2.loudness import parse_ebur128 as ebur
    from ai_clipper.edit_v2.plan import Resources as Res
    from ai_clipper.edit_v2.plan import build_plan as plan_of

    marks.append(("imports", time.perf_counter()))
    clip_dir = jobs_root / job_id / "analysis" / "clips" / clip_id
    doc = parse_doc(doc_file.read_bytes())
    seed, _etag = st.seed(clip_dir)
    words = st.load_words(clip_dir, seed["base"]["words"]["sha256"])
    assets = st.load_assets(clip_dir, iter_asset_ids(doc))
    validate_doc(doc, words=words, assets=assets, seed=seed)
    marks.append(("validate", time.perf_counter()))
    camera = pl.camera_for(clip_dir, doc)[0]
    built = plan_of(doc, words=words, camera=camera, assets=assets,
                    resources=Res(resources_dir))
    marks.append(("plan", time.perf_counter()))
    source = pl.source_path(jobs_root / job_id)
    assets_root = jobs_root / job_id / "analysis" / "assets"
    if kind == "frame":
        job = cf.compile_job(built, mode="frame", frame=frame, source=source,
                             assets_root=assets_root)
        marks.append(("compile_incl_ffprobe", time.perf_counter()))
        ex.run(job, output_fd=None, timeout_s=120)
        marks.append(("ffmpeg_encode_and_png", time.perf_counter()))
    else:
        loudness = None
        if needs(built.doc):
            job = pl.lane_threads(cf.compile_job(built, mode="audio_measure", source=source,
                                                 assets_root=assets_root))
            marks.append(("compile_measure_incl_ffprobe", time.perf_counter()))
            loudness = ebur(ex.run(job, output_fd=None, timeout_s=600).stderr)
            marks.append(("ffmpeg_measure", time.perf_counter()))
        job = preview_cli.lane_audio(cf.compile_job(built, mode="audio_preview", source=source,
                                                    assets_root=assets_root, loudness=loudness))
        marks.append(("compile_preview", time.perf_counter()))
        fd = os.open(doc_file.with_suffix(".flac"), os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            ex.run(job, output_fd=fd, timeout_s=600)
        finally:
            os.close(fd)
        marks.append(("ffmpeg_preview_flac", time.perf_counter()))
    return {name: round(1000 * (at - marks[i][1]), 1)
            for i, (name, at) in enumerate(marks[1:])}


def stage_breakdown(kind: str, clip: Clip, doc: Mapping, work: Path, frames: Sequence[int],
                    runs: int = 3) -> dict[str, Any]:
    """Median stage times over ``runs`` fresh processes; ``process_other`` is the rest of the
    process time (interpreter start and exit, and compiling this script, which the lane's
    CLI does not pay: an upper bound of its start-up)."""
    work.mkdir(parents=True, exist_ok=True)
    doc_file = work / f"stages-{clip.id}.json"
    doc_file.write_bytes(canonical(doc))
    rows = []
    for index in range(runs):
        frame = frames[index % len(frames)] if frames else None
        argv = [sys.executable, str(Path(__file__).resolve()), "stages", kind,
                str(clip.jobs_root), clip.job_id, clip.id, str(doc_file), str(frame)]
        started = time.perf_counter()
        result = subprocess.run(argv, capture_output=True, check=True)
        total = 1000 * (time.perf_counter() - started)
        row = json.loads(result.stdout)
        row["process_other"] = round(total - sum(row.values()), 1)  # start, exit, script compile
        row["total"] = round(total, 1)
        rows.append(row)
    return {name: round(statistics.median(r[name] for r in rows), 1) for name in rows[0]}


# --- evidence --------------------------------------------------------------------------------------


def _load(name: str, path: Path):
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def environment() -> dict[str, Any]:
    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    cpu_max = None
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        cpu_max = None if quota == "max" else round(int(quota) / int(period), 2)
    except (OSError, ValueError):
        pass
    return {"ffmpeg": first[0] if first else None, "python": platform.python_version(),
            "cpus_visible": os.cpu_count(), "cpu_quota": cpu_max,
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


GATES = {"pf-plan": ("PF-PLAN", "pf_plan"), "pf-truth": ("PF-TRUTH", "pf_truth"),
         "pf-audio": ("PF-AUDIO", "pf_audio"), "pf-cells": ("PF-CELLS", "pf_cells"),
         "p-aud": ("P-AUD", "p_aud"), "p-plate": ("P-PLATE", "p_plate")}


def main(argv: Sequence[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments[:1] == ["stages"]:
        kind, jobs_root, job_id, clip_id, doc_file, frame = arguments[1:7]
        print(json.dumps(_stages(kind, Path(jobs_root), job_id, clip_id, Path(doc_file),
                                 None if frame == "None" else int(frame))))
        return 0
    parser = argparse.ArgumentParser(description="T2.3 preview lane gates")
    parser.add_argument("gate", choices=("all", *GATES))
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--jobs-root", type=Path, required=True)
    parser.add_argument("--work", type=Path, default=Path("/tmp/preview-lane-gates"))
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--label", default="run")
    args = parser.parse_args(arguments)
    app = App(args.base_url, os.environ.get("E2E_USERNAME", ""),
              os.environ.get("E2E_PASSWORD", ""))
    gates = Gates(app, args.jobs_root, args.work)
    failed = []
    for name in (list(GATES) if args.gate == "all" else [args.gate]):
        gate, method = GATES[name]
        started = time.monotonic()
        result = getattr(gates, method)()
        result["gate_wall_s"] = round(time.monotonic() - started, 1)
        if args.evidence is not None:
            write_evidence(args.evidence, gate, args.label, result)
        print(f"{gate}: {result.get('pass')} ({result['gate_wall_s']} s)", flush=True)
        if result.get("pass") is False:
            failed.append(gate)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
