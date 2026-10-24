#!/usr/bin/env python3
"""FETCH-M0: the download measurements behind the go/no-go in ``docs/evaluation/UNDUHAN_M0.md``.

Plan 2026-10-24-rombak, 04 §B12. Runs only on GitHub Actions, inside the production image::

    gh workflow run editor-gates.yml -f ref=<branch> -f suite=command \\
        -f command='python scripts/fetch/m0_measure.py --out /out/unduhan-m0.json --only env,youtube'

Phases (``--only``, comma-separated; default all):

* ``env``: tool versions and whether yt-dlp accepts the image's Node as its JS runtime.
* ``extractors`` (M0-7): ``yt-dlp --list-extractors`` names for YouTube, Twitch and Kick.
* ``youtube`` (M0-3, M0-8): ``download_bot_check`` rate over ``--tries`` downloads of a short
  CC-BY video, three ways: the image as it is; Node 24 + yt-dlp-ejs; the same plus a bgutil
  PO-token server. A few player clients once each. Format sizes when YouTube answers at all.
* ``audio`` (M0-1): the codec effect on timing. Openly licensed talks (video.blender.org, CC BY,
  CC BY-SA or public domain); the source audio against AAC 128k (like YouTube 140) and Opus 128k
  (like 251): start offsets, Whisper word times, the audio timeline and the V3 heuristic
  selection on each.
* ``timing`` (M0-2): time to selection, sequential against simulated audio-first, on sources
  near 10/30/60/120 minutes.
* ``sizes`` (M0-8): bytes per hour of the 720p and 1080p files of those sources (metadata).
* ``range`` (M0-6): ``--download-sections`` cut time against the full download, and the A/V
  offset of cut pieces of a flash/beep test source served locally as HLS and DASH.
* ``proxy`` (M0-4): a proxy given through ``--config-locations`` never shows in
  ``/proc/*/cmdline`` or ``/proc/*/environ``, while a local proxy sees the traffic.
* ``kick`` (M0-5): Kick VOD and clip metadata with and without curl_cffi. No media is downloaded
  (streams are not openly licensed).

No cookies, no paid proxy, no LLM key: the selection is the heuristic only. Ad hoc tools (Node 24,
yt-dlp-ejs, bgutil, curl_cffi) are installed into temporary directories inside the CI container
at the versions in ``PINS``; none of them is a Potongin dependency. Each phase writes its result
into the output file as soon as it ends, so a timeout keeps the finished phases.

    python scripts/fetch/m0_measure.py merge RUN1.json RUN2.json ... --out ALL.json
"""

from __future__ import annotations

import argparse
import bisect
import difflib
import hashlib
import http.server
import json
import os
import platform
import re
import select
import shutil
import socket
import socketserver
import statistics
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts" / "ytdlp"))

import ytdlp_smoke as smoke

SCHEMA = "potongin.fetch-m0/1"
PHASES = ("env", "extractors", "youtube", "audio", "timing", "sizes", "range", "proxy",
          "kick")

# Ad hoc measurement tools, never Potongin dependencies. Versions at least two weeks old.
PINS = {
    "node": "24.21.0",
    "bgutil": "2.0.2",
    "bgutil_image_digest": (
        "sha256:d7d34108b76e52c7d3b575fe9e797e4bf41c1b2a08f80c5292eff6f851ce8472"),
    "yt_dlp_ejs": "0.8.0",
    "curl_cffi": "0.16.0",
}

# Cosmos Laundromat pilot trailer, Blender Foundation, CC BY (the yt-dlp smoke video).
YOUTUBE_PROBE = smoke.SMOKE_URL
# YouTube sources with a CC BY licence in docs/evaluation/TRAINING_SOURCE_REGISTRY.json.
YOUTUBE_SOURCES = (YOUTUBE_PROBE, "https://www.youtube.com/watch?v=0dzvz9JZFIM")
YOUTUBE_CLIENTS = ("default", "tv", "web_safari", "mweb", "android_vr", "web_embedded")

PEERTUBE = "https://video.blender.org"
# PeerTube licence ids: 1 CC BY, 2 CC BY-SA, 7 public domain dedication.
OPEN_LICENCES = frozenset({1, 2, 7})
TIMING_TARGETS = (600, 1800, 3600, 7200)

KICK_CHANNELS = ("xqc", "adinross", "amouranth", "trainwreckstv")

_UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
_CLIP_ID = re.compile(r"clip_[A-Za-z0-9_-]{1,100}")
_SLUG = re.compile(r"[A-Za-z0-9_-]{1,64}")
_POT = re.compile(r"Generating an? (\w+) PO Token")
_STAT_FRAME = re.compile(r"pts_time:\s*(-?[0-9.]+)")
_STAT_YAVG = re.compile(r"lavfi\.signalstats\.YAVG=([0-9.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[0-9.]+)")


# --- pure helpers (tests/test_fetch_m0_measure.py) ---------------------------------------------

def extractor_names(listing: str, platforms: Sequence[str] = ("youtube", "twitch", "kick")
                    ) -> dict[str, list[str]]:
    """Names from ``yt-dlp --list-extractors`` that are the platform or ``platform:<kind>``."""
    names = [line.strip() for line in listing.splitlines() if line.strip()]
    return {platform_: sorted(name for name in names
                              if name == platform_ or name.startswith(platform_ + ":"))
            for platform_ in platforms}


def debug_value(stderr: str, key: str) -> str | None:
    prefix = f"[debug] {key}: "
    for line in stderr.splitlines():
        if line.startswith(prefix):
            return line[len(prefix):].strip()
    return None


def js_runtime(value: str | None, name: str) -> dict[str, Any] | None:
    """The ``[debug] JS runtimes`` entry for ``name``: its version and yt-dlp's support."""
    for item in (value or "").split(","):
        item = item.strip()
        if item == f"{name} (unknown)":
            return {"name": name, "version": None, "supported": None}
        if item.startswith(name + "-"):
            version = item[len(name) + 1:]
            unsupported = version.endswith(" (unsupported)")
            return {"name": name, "version": version.removesuffix(" (unsupported)"),
                    "supported": not unsupported}
    return None


def download_outcome(returncode: int | None, stderr: str, has_file: bool) -> str:
    """``ok`` or the smoke test's reason (``bot_check``, ``forbidden``, ``timeout``, ...)."""
    if returncode == 0:
        return "ok" if has_file else "no_file"
    return smoke.classify(returncode, stderr, None).reason


def pot_token_contexts(stderr: str) -> list[str]:
    return _POT.findall(stderr)


def rate(outcomes: Sequence[str], value: str) -> dict[str, Any]:
    count = sum(1 for item in outcomes if item == value)
    return {"tries": len(outcomes), "count": count,
            "share": round(count / len(outcomes), 4) if outcomes else None}


def licensed(video: Mapping[str, Any]) -> bool:
    licence = video.get("licence")
    return isinstance(licence, Mapping) and licence.get("id") in OPEN_LICENCES


def pick_by_duration(videos: Iterable[Mapping[str, Any]], targets: Sequence[int],
                     tolerance: float = 0.35) -> dict[int, Mapping[str, Any] | None]:
    """For each target length, the licensed video closest to it (relative ``tolerance``), each
    video used once; ties go to the smaller uuid."""
    pool = sorted((item for item in videos if licensed(item)), key=lambda item: item["uuid"])
    used: set[str] = set()
    picked: dict[int, Mapping[str, Any] | None] = {}
    for target in targets:
        best = None
        for item in pool:
            gap = abs(float(item["duration"]) - target)
            if item["uuid"] in used or gap > tolerance * target:
                continue
            if best is None or gap < abs(float(best["duration"]) - target):
                best = item
        picked[target] = best
        if best is not None:
            used.add(best["uuid"])
    return picked


def pick_talks(videos: Iterable[Mapping[str, Any]], count: int, min_s: float, max_s: float,
               language: str) -> list[Mapping[str, Any]]:
    """The first ``count`` licensed videos by uuid with the length and spoken language."""
    pool = [item for item in videos if licensed(item)
            and min_s <= float(item["duration"]) <= max_s
            and (item.get("language") or {}).get("id") == language]
    return sorted(pool, key=lambda item: item["uuid"])[:count]


def _overlap(first: Mapping[str, float], second: Mapping[str, float]) -> float:
    shared = min(first["end"], second["end"]) - max(first["start"], second["start"])
    shorter = min(first["end"] - first["start"], second["end"] - second["start"])
    return shared / shorter if shared > 0 and shorter > 0 else 0.0


def clip_deltas(reference: Sequence[Mapping[str, Any]], other: Sequence[Mapping[str, Any]],
                *, limit_ms: int) -> dict[str, Any]:
    """Pair clips that cover the same moment (at least half of the shorter one) and report the
    largest start or end difference of the pairs."""
    pairs: list[tuple[Mapping[str, Any], Mapping[str, Any]]] = []
    free = list(other)
    for item in reference:
        best = max(free, key=lambda candidate: _overlap(item, candidate), default=None)
        if best is not None and _overlap(item, best) >= 0.5:
            pairs.append((item, best))
            free.remove(best)
    deltas = [max(abs(a["start"] - b["start"]), abs(a["end"] - b["end"])) for a, b in pairs]
    worst = round(max(deltas) * 1000) if deltas else None
    return {
        "clips": len(reference),
        "paired": len(pairs),
        "same_rank": sum(1 for a, b in pairs if a.get("rank") == b.get("rank")),
        "unpaired": len(reference) - len(pairs),
        "max_boundary_ms": worst,
        "within_limit": sum(1 for delta in deltas if round(delta * 1000) <= limit_ms),
        "limit_ms": limit_ms,
    }


def _norm_word(text: str) -> str:
    return re.sub(r"[^\w]", "", text.casefold())


def word_deltas(reference: Sequence[tuple[float, str]], other: Sequence[tuple[float, str]]
                ) -> dict[str, Any]:
    """Start-time differences of the words both transcripts share, aligned on the text."""
    first = [_norm_word(text) for _, text in reference]
    second = [_norm_word(text) for _, text in other]
    matcher = difflib.SequenceMatcher(a=first, b=second, autojunk=False)
    deltas: list[int] = []
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            a, b = reference[block.a + offset], other[block.b + offset]
            if first[block.a + offset]:
                deltas.append(round(abs(a[0] - b[0]) * 1000))
    deltas.sort()
    return {
        "reference_words": len(reference),
        "matched": len(deltas),
        "median_ms": deltas[len(deltas) // 2] if deltas else None,
        "p95_ms": deltas[min(len(deltas) - 1, int(len(deltas) * 0.95))] if deltas else None,
        "max_ms": deltas[-1] if deltas else None,
    }


def flash_times(signalstats: str, threshold: float = 128.0) -> list[float]:
    """Frame times where the mean luma rises above ``threshold`` (ffmpeg ``signalstats`` with
    ``metadata=print``)."""
    times: list[float] = []
    current: float | None = None
    bright = False
    for line in signalstats.splitlines():
        if (frame := _STAT_FRAME.search(line)) is not None:
            current = float(frame.group(1))
        elif (value := _STAT_YAVG.search(line)) is not None and current is not None:
            now = float(value.group(1)) > threshold
            if now and not bright:
                times.append(round(current, 6))
            bright = now
    return times


def beep_onsets(silencedetect: str) -> list[float]:
    return [float(value) for value in _SILENCE_END.findall(silencedetect)]


def av_offset(flashes: Sequence[float], beeps: Sequence[float], window: float = 0.5
              ) -> float | None:
    """Median of beep minus nearest flash (seconds), over beeps within ``window`` of one."""
    if not flashes:
        return None
    ordered = sorted(flashes)
    offsets = []
    for beep in beeps:
        at = bisect.bisect_left(ordered, beep)
        near = min(ordered[max(0, at - 1):at + 1], key=lambda flash: abs(beep - flash))
        if abs(beep - near) <= window:
            offsets.append(beep - near)
    return statistics.median(offsets) if offsets else None


def bytes_per_hour(size: int | None, seconds: float | None) -> int | None:
    if not size or not seconds:
        return None
    return round(size * 3600 / seconds)


def range_only_saving(t_audio: float, t_transcribe: float, t_select: float, t_video: float,
                      t_ranges: float) -> float:
    """§B11 gate 1: clips-ready time saved by range-only against audio-first with the video in
    parallel (render time is the same on both sides and left out)."""
    audio_first = max(t_audio + t_transcribe + t_select, t_video)
    range_only = t_audio + t_transcribe + t_select + t_ranges
    return 1 - range_only / audio_first


def range_gate(savings: Sequence[float], offsets_frames: Sequence[float]) -> dict[str, Any]:
    """§B11: median saving at least 40 % and A/V within one frame in at least 95 % of pieces."""
    median = statistics.median(savings) if savings else None
    within = (sum(1 for item in offsets_frames if abs(item) <= 1) / len(offsets_frames)
              if offsets_frames else None)
    return {"median_saving": median, "av_within_one_frame": within,
            "pass": bool(median is not None and within is not None
                         and median >= 0.40 and within >= 0.95)}


def range_report(timing_sources: Sequence[Mapping[str, Any]], cut_seconds: Sequence[float],
                 offsets_frames: Sequence[float], clips: int = 5) -> dict[str, Any]:
    """§B11 inputs from the measured numbers: sources of at least 40 minutes, ``clips`` cuts at
    the median measured cut time one after the other, with Whisper and with captions."""
    cut = statistics.median(cut_seconds) if cut_seconds else None
    rows = []
    for source in timing_sources:
        video, seconds = source.get("video"), source.get("seconds")
        if not video or not seconds or cut is None or float(video["duration"]) < 2400:
            continue
        ranges = clips * cut
        audio = seconds["audio_download_simulated"]
        rows.append({
            "duration": video["duration"], "ranges_seconds": ranges,
            "whisper": range_only_saving(audio, seconds["transcribe"], seconds["select"],
                                         seconds["video_download"], ranges),
            "captions": range_only_saving(audio, 0, seconds["select"],
                                          seconds["video_download"], ranges),
        })
    return {"cut_median_seconds": cut, "clips": clips, "sources": rows,
            "gate_whisper": range_gate([row["whisper"] for row in rows], offsets_frames),
            "gate_captions": range_gate([row["captions"] for row in rows], offsets_frames)}


def kick_decision(without: Sequence[str], with_cffi: Sequence[str]) -> str:
    """04 §B8: Kick is a go only when it works without curl_cffi (or the owner approves it)."""
    if not without:
        return "not_measured"
    if sum(1 for item in without if item == "ok") >= 0.8 * len(without):
        return "metadata_ok_without_curl_cffi"
    if with_cffi and sum(1 for item in with_cffi if item == "ok") >= 0.8 * len(with_cffi):
        return "needs_curl_cffi"
    return "no_go"


def bgutil_decision(bot_without: float | None, bot_with: float | None, tokens: int) -> str:
    """``helps`` only when tokens were made and the bot-check share fell by 25 points or more."""
    if bot_without is None or bot_with is None:
        return "setup_failed"
    if bot_without == 0:
        return "not_needed"
    if tokens == 0:
        return "no_token"
    return "helps" if bot_without - bot_with >= 0.25 else "no_effect"


def scan_proc(proc_root: Path, marker: bytes) -> tuple[list[dict[str, Any]], int]:
    """Processes whose ``cmdline`` or ``environ`` holds ``marker``, and how many were read."""
    hits: list[dict[str, Any]] = []
    seen = 0
    try:
        entries = sorted((name for name in os.listdir(proc_root) if name.isdigit()), key=int)
    except OSError:
        return hits, seen
    for name in entries:
        seen += 1
        for part in ("cmdline", "environ"):
            try:
                data = (proc_root / name / part).read_bytes()
            except OSError:
                continue
            if marker in data:
                hits.append({"pid": int(name), "file": part})
    return hits, seen


def write_proxy_config(path: Path, proxy_url: str) -> Path:
    """The §B7.3 config file: one ``--proxy`` line, mode 0600."""
    if not proxy_url or any(char.isspace() for char in proxy_url):
        raise ValueError("proxy url must be one token")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"--proxy {proxy_url}\n")
    os.chmod(path, 0o600)
    return path


def kick_urls(channel: str, videos: Any, clips: Any, count: int) -> list[str]:
    """VOD then clip page URLs from Kick's channel API payloads (ids checked, at most count)."""
    if not _SLUG.fullmatch(channel):
        return []
    urls: list[str] = []
    for item in videos if isinstance(videos, list) else []:
        if not isinstance(item, dict):
            continue
        uuid = (item.get("video") or {}).get("uuid") if isinstance(item.get("video"), dict) \
            else item.get("uuid")
        if isinstance(uuid, str) and _UUID.fullmatch(uuid):
            urls.append(f"https://kick.com/{channel}/videos/{uuid}")
    for item in (clips or {}).get("clips", []) if isinstance(clips, dict) else []:
        clip_id = item.get("id") if isinstance(item, dict) else None
        if isinstance(clip_id, str) and _CLIP_ID.fullmatch(clip_id):
            urls.append(f"https://kick.com/{channel}/clips/{clip_id}")
    return urls[:count]


def merge_results(results: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    merged: dict[str, Any] = {"schema": SCHEMA, "runs": [], "phases": {}}
    for result in results:
        if result.get("schema") != SCHEMA:
            raise ValueError(f"not a {SCHEMA} result")
        merged["runs"].extend(result.get("runs", []))
        for name, value in result.get("phases", {}).items():
            if name not in merged["phases"]:
                merged["phases"][name] = value
            elif isinstance(merged["phases"][name], list):
                merged["phases"][name].append(value)
            else:
                merged["phases"][name] = [merged["phases"][name], value]
    return merged


def child_env(env: Mapping[str, str]) -> dict[str, str]:
    """The environment for yt-dlp and the tools: no LLM, settings, app or CI secrets."""
    return {name: value for name, value in env.items() if not smoke._SECRET_ENV.fullmatch(name)}


# --- process and file helpers ------------------------------------------------------------------

class Run:
    __slots__ = ("returncode", "seconds", "stderr", "stdout")

    def __init__(self, returncode: int | None, stdout: str, stderr: str, seconds: float):
        self.returncode, self.stdout, self.stderr, self.seconds = (
            returncode, stdout, stderr, seconds)


def run(argv: Sequence[str], *, timeout: float = 600, env: Mapping[str, str] | None = None,
        cwd: Path | None = None) -> Run:
    started = time.monotonic()
    try:
        completed = subprocess.run(list(argv), capture_output=True, text=True, errors="replace",
                                   timeout=timeout, env=dict(env or child_env(os.environ)),
                                   cwd=cwd, check=False)
        return Run(completed.returncode, completed.stdout, completed.stderr,
                   time.monotonic() - started)
    except subprocess.TimeoutExpired as error:
        def text(value: Any) -> str:
            return value.decode(errors="replace") if isinstance(value, bytes) else (value or "")
        return Run(None, text(error.stdout), text(error.stderr), time.monotonic() - started)
    except OSError as error:
        return Run(127, "", str(error), time.monotonic() - started)


def tail(text: str, lines: int = 6) -> list[str]:
    return smoke._tail(text, lines)


def fetch_json(url: str, timeout: float = 30) -> Any:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 potongin-m0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(8 * 1024 * 1024))


def fetch_file(url: str, path: Path, timeout: float = 300) -> Path:
    request = urllib.request.Request(url, headers={"User-Agent": "potongin-m0"})
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=timeout) as response, path.open("wb") as out:
        shutil.copyfileobj(response, out)
    return path


def ffprobe(path: Path) -> dict[str, Any]:
    entries = ("stream=index,codec_type,codec_name,start_time,duration,sample_rate,bit_rate,"
               "r_frame_rate:format=duration,size,bit_rate,format_name")
    result = run(["ffprobe", "-v", "error", "-show_entries", entries, "-of", "json", str(path)],
                 timeout=120)
    try:
        return json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return {}


def stream_starts(info: Mapping[str, Any]) -> dict[str, float | None]:
    starts: dict[str, float | None] = {}
    for stream in info.get("streams", []):
        kind = stream.get("codec_type")
        if kind in ("audio", "video") and kind not in starts:
            try:
                starts[kind] = float(stream.get("start_time"))
            except (TypeError, ValueError):
                starts[kind] = None
    return starts


def first_file(directory: Path, stem: str) -> Path | None:
    files = sorted(path for path in directory.glob(stem + ".*")
                   if not path.name.endswith((".part", ".ytdl", ".json")))
    return files[0] if files else None


def ytdlp_version(ytdlp: str) -> str | None:
    result = run([ytdlp, "--version"], timeout=60)
    return result.stdout.strip() if result.returncode == 0 else None


def peertube_videos(pages: int = 6) -> list[dict[str, Any]]:
    """Local videos with an open licence on video.blender.org, longest first."""
    videos: list[dict[str, Any]] = []
    for page in range(pages):
        query = (f"/api/v1/videos?count=100&start={page * 100}&sort=-duration&isLocal=true"
                 + "".join(f"&licenceOneOf={licence}" for licence in sorted(OPEN_LICENCES)))
        payload = fetch_json(PEERTUBE + query)
        data = payload.get("data") or []
        videos.extend(item for item in data if isinstance(item, dict) and licensed(item))
        if len(data) < 100:
            break
    return videos


def describe(video: Mapping[str, Any]) -> dict[str, Any]:
    return {"uuid": video["uuid"], "name": video.get("name"), "duration": video.get("duration"),
            "licence": (video.get("licence") or {}).get("label"),
            "url": f"{PEERTUBE}/videos/watch/{video['uuid']}"}


def extract(archive: Path, target: Path) -> None:
    """Unpack a downloaded archive, refusing links and paths that leave ``target`` (Python
    3.11.2 in the image has no ``extractall(filter=...)``)."""
    root = target.resolve()
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            path = (root / member.name).resolve()
            if not (member.isfile() or member.isdir() or member.issym()) or (
                    path != root and root not in path.parents):
                raise RuntimeError(f"unsafe archive member: {member.name[:80]}")
            if member.issym():
                link = (path.parent / member.linkname).resolve()
                if root not in link.parents:
                    raise RuntimeError(f"unsafe archive link: {member.name[:80]}")
        if hasattr(tarfile, "data_filter"):
            tar.extractall(root, members=members, filter="data")
        else:
            tar.extractall(root, members=members)


# --- ad hoc tools (CI only) --------------------------------------------------------------------

class Tools:
    """Node 24, temporary yt-dlp venvs and the bgutil server, made once per run on demand."""

    def __init__(self, work: Path):
        self.work = work
        self.problems: dict[str, str] = {}
        self._node: Path | None = None
        self._venvs: dict[str, Path] = {}

    def node(self) -> Path | None:
        if self._node is not None or "node" in self.problems:
            return self._node
        version = PINS["node"]
        base = f"https://nodejs.org/dist/v{version}/"
        name = f"node-v{version}-linux-x64.tar.xz"
        try:
            archive = fetch_file(base + name, self.work / "dl" / name)
            sums = urllib.request.urlopen(base + "SHASUMS256.txt", timeout=60).read().decode()
            expected = next(line.split()[0] for line in sums.splitlines()
                            if line.endswith("  " + name))
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            if digest != expected:
                raise RuntimeError("node archive sha256 mismatch")
            target = self.work / "node24"
            extract(archive, target)
            self._node = target / f"node-v{version}-linux-x64" / "bin" / "node"
        except Exception as error:  # noqa: BLE001 (a measurement records any setup failure)
            self.problems["node"] = f"{type(error).__name__}: {error}"[:300]
        return self._node

    def venv(self, name: str, packages: Sequence[str]) -> Path | None:
        """A uv venv with ``packages``; returns its bin directory."""
        if name in self._venvs or name in self.problems:
            return self._venvs.get(name)
        target = self.work / "venv" / name
        made = run(["uv", "venv", "--python", "/usr/bin/python3", str(target)], timeout=300)
        installed = made.returncode == 0 and run(
            ["uv", "pip", "install", "--python", str(target / "bin" / "python"), *packages],
            timeout=900)
        if made.returncode != 0 or not installed or installed.returncode != 0:
            failed = installed if installed else made
            self.problems[name] = " | ".join(tail(failed.stderr, 4))[:400]
            return None
        self._venvs[name] = target / "bin"
        return self._venvs[name]

    def path_env(self) -> dict[str, str]:
        env = child_env(os.environ)
        node = self.node()
        if node is not None:
            env["PATH"] = f"{node.parent}:{env.get('PATH', '')}"
        return env


class BgutilServer:
    """The bgutil PO-token HTTP server, built from its release source with Node 24."""

    def __init__(self, tools: Tools, port: int = 4416):
        self.tools, self.port = tools, port
        self.process: subprocess.Popen[bytes] | None = None
        self.problem: str | None = None
        self.log = tools.work / "bgutil-server.log"

    def start(self) -> bool:
        node = self.tools.node()
        if node is None:
            self.problem = "node 24 missing"
            return False
        version = PINS["bgutil"]
        try:
            archive = fetch_file(
                f"https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/"
                f"{version}.tar.gz", self.tools.work / "dl" / f"bgutil-{version}.tar.gz")
            target = self.tools.work / "bgutil"
            extract(archive, target)
            server = next(target.glob("*/server"))
        except Exception as error:  # noqa: BLE001
            self.problem = f"source: {type(error).__name__}: {error}"[:300]
            return False
        env = self.tools.path_env()
        # The image sets NODE_ENV=production, which would skip TypeScript (a dev dependency).
        env.pop("NODE_ENV", None)
        npm = node.parent / "npm"
        npx = node.parent / "npx"
        for step in ([str(npm), "ci", "--include=dev", "--no-audit", "--no-fund"],
                     [str(npx), "--no-install", "tsc"]):
            result = run(step, timeout=900, env=env, cwd=server)
            if result.returncode != 0:
                self.problem = f"{step[1]}: " + " | ".join(tail(result.stderr or result.stdout, 4))
                return False
        handle = self.log.open("wb")
        self.process = subprocess.Popen(
            [str(node), "build/main.js", "--port", str(self.port)], cwd=server, env=env,
            stdout=handle, stderr=subprocess.STDOUT)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/ping", timeout=2).read()
                return True
            except OSError:
                time.sleep(1)
        self.problem = "server did not answer /ping in 60 s"
        return False

    def stop(self) -> None:
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()


# --- phases ------------------------------------------------------------------------------------

class Context:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.work = Path(args.work)
        self.work.mkdir(parents=True, exist_ok=True)
        self.tools = Tools(self.work)
        self.ytdlp = shutil.which("yt-dlp") or "yt-dlp"


def phase_env(ctx: Context) -> dict[str, Any]:
    # The debug header comes before any extraction, so a bot-checked URL still prints it.
    header = run([ctx.ytdlp, "-v", "--js-runtimes", "node", "--simulate", "--no-playlist",
                  YOUTUBE_PROBE], timeout=120)
    js = debug_value(header.stderr, "JS runtimes")
    lock = (ROOT / "uv.lock").read_text(encoding="utf-8")
    ffmpeg = run(["ffmpeg", "-version"], timeout=30).stdout.splitlines()
    return {
        "yt_dlp": ytdlp_version(ctx.ytdlp),
        "yt_dlp_locked": smoke.locked_version(lock),
        "node": run(["node", "--version"], timeout=30).stdout.strip(),
        "js_runtimes": js,
        "node_runtime": js_runtime(js, "node"),
        "optional_libraries": debug_value(header.stderr, "Optional libraries"),
        "ffmpeg": ffmpeg[0] if ffmpeg else None,
        "python": platform.python_version(),
        "cpus": os.cpu_count(),
    }


def phase_extractors(ctx: Context) -> dict[str, Any]:
    listing = run([ctx.ytdlp, "--list-extractors"], timeout=120)
    return {"yt_dlp": ytdlp_version(ctx.ytdlp), "names": extractor_names(listing.stdout)}


def _youtube_try(ytdlp: str, url: str, out: Path, extra: Sequence[str], env: Mapping[str, str],
                 *, download: bool = True) -> dict[str, Any]:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    argv = [ytdlp, "-v", "--no-playlist", *extra]
    argv += (["-f", "ba[ext=m4a]/ba", "-o", str(out / "a.%(ext)s")] if download
             else ["--skip-download", "--dump-single-json"])
    result = run([*argv, url], timeout=300, env=env)
    has_file = first_file(out, "a") is not None if download else bool(result.stdout.strip())
    return {"outcome": download_outcome(result.returncode, result.stderr, has_file),
            "seconds": round(result.seconds, 2), "pot": pot_token_contexts(result.stderr),
            "line": next((line[:240] for line in reversed(result.stderr.splitlines())
                          if line.startswith("ERROR:")), None),
            "stdout": result.stdout if not download and result.returncode == 0 else None}


def _youtube_formats(info: Mapping[str, Any]) -> dict[str, Any]:
    duration = info.get("duration")
    audio, video = [], {}
    for item in info.get("formats") or []:
        size = item.get("filesize") or item.get("filesize_approx")
        if item.get("vcodec") == "none" and item.get("acodec") not in (None, "none"):
            audio.append({key: item.get(key) for key in (
                "format_id", "ext", "acodec", "abr", "asr", "language", "format_note",
                "language_preference")} | {"size": size})
        elif item.get("vcodec") not in (None, "none") and item.get("height"):
            for limit in (720, 1080):
                if item["height"] <= limit and size:
                    best = video.get(limit)
                    if best is None or (item["height"], size) > (best["height"], best["size"]):
                        video[limit] = {"format_id": item.get("format_id"),
                                        "height": item["height"], "vcodec": item.get("vcodec"),
                                        "size": size}
    best_audio = max((item for item in audio if item["size"]), key=lambda item: item["size"],
                     default=None)
    return {
        "id": info.get("id"), "title": info.get("title"), "duration": duration,
        "license": info.get("license"), "audio": audio,
        "video": {str(limit): item | {"bytes_per_hour": bytes_per_hour(
            item["size"] + (best_audio or {}).get("size", 0), duration)}
            for limit, item in video.items()},
    }


def phase_youtube(ctx: Context) -> dict[str, Any]:
    tries = ctx.args.tries
    locked = smoke.locked_version((ROOT / "uv.lock").read_text(encoding="utf-8"))
    node = ctx.tools.node()
    node_arg = ["--js-runtimes", f"node:{node}"] if node else ["--js-runtimes", "node"]
    ejs_bin = ctx.tools.venv("ejs", [f"yt-dlp[default]=={locked}",
                                     f"yt-dlp-ejs=={PINS['yt_dlp_ejs']}"])
    pot_bin = ctx.tools.venv("bgutil", [f"yt-dlp[default]=={locked}",
                                        f"yt-dlp-ejs=={PINS['yt_dlp_ejs']}",
                                        f"bgutil-ytdlp-pot-provider=={PINS['bgutil']}"])
    server = BgutilServer(ctx.tools)
    server_ok = pot_bin is not None and server.start()
    env = ctx.tools.path_env()
    arms: list[tuple[str, str | None, list[str]]] = [
        ("image", ctx.ytdlp, ["--js-runtimes", "node"]),
        ("node24_ejs", str(ejs_bin / "yt-dlp") if ejs_bin else None, node_arg),
        ("node24_ejs_bgutil", str(pot_bin / "yt-dlp") if pot_bin and server_ok else None,
         [*node_arg, "--extractor-args",
          f"youtubepot-bgutilhttp:base_url=http://127.0.0.1:{server.port}"]),
    ]
    result: dict[str, Any] = {"url": YOUTUBE_PROBE, "tries": tries, "arms": {},
                              "setup": {"problems": dict(ctx.tools.problems),
                                        "bgutil_server": server.problem or (
                                            "ok" if server_ok else "skipped")},
                              "pins": PINS, "proxy": "not measured: no free proxy allowed"}
    def arm_env(name: str) -> Mapping[str, str]:
        # The image arm keeps the image's own Node 20 on PATH, as production runs it.
        return child_env(os.environ) if name == "image" else env

    result["headers"] = {}
    for name, binary, extra in arms:
        if binary:
            header = run([binary, "-v", *extra, "--simulate", "--no-playlist", YOUTUBE_PROBE],
                         timeout=180, env=arm_env(name))
            result["headers"][name] = {
                key: debug_value(header.stderr, key) for key in (
                    "yt-dlp version", "JS runtimes", "Optional libraries")} | {
                "pot_providers": next((line.split(": ", 1)[-1][:200]
                                       for line in header.stderr.splitlines()
                                       if "PO Token Providers" in line), None)}
    try:
        order = [(name, binary, extra) for name, binary, extra in arms if binary]
        outcomes: dict[str, list[dict[str, Any]]] = {name: [] for name, _, _ in order}
        for attempt in range(tries):  # interleaved, so the arms share the same minutes
            for name, binary, extra in order:
                outcomes[name].append(_youtube_try(
                    binary, YOUTUBE_PROBE, ctx.work / "yt" / name, extra, arm_env(name)))
                time.sleep(2)
            log(f"youtube try {attempt + 1}/{tries}")
        for name, binary, _ in arms:
            items = outcomes.get(name)
            if not items:
                result["arms"][name] = {"skipped": "setup failed"}
                continue
            kinds = [item["outcome"] for item in items]
            result["arms"][name] = {
                "bot_check": rate(kinds, "bot_check"), "ok": rate(kinds, "ok"),
                "outcomes": {kind: kinds.count(kind) for kind in sorted(set(kinds))},
                "pot_tokens": sum(len(item["pot"]) for item in items),
                "median_seconds": statistics.median(item["seconds"] for item in items),
                "last_error": next((item["line"] for item in reversed(items) if item["line"]),
                                   None),
            }
        client_bin = str(ejs_bin / "yt-dlp") if ejs_bin else ctx.ytdlp
        result["clients"] = {}
        for client in YOUTUBE_CLIENTS:
            extra = node_arg + ([] if client == "default" else [
                "--extractor-args", f"youtube:player_client={client}"])
            item = _youtube_try(client_bin, YOUTUBE_PROBE, ctx.work / "yt" / "client", extra, env,
                                download=False)
            result["clients"][client] = {"outcome": item["outcome"], "line": item["line"]}
        working = [name for name, arm in result["arms"].items() if arm.get("ok", {}).get("count")]
        result["sources"] = []
        if working:
            name, binary, extra = next(arm for arm in arms if arm[0] == working[0])
            for url in YOUTUBE_SOURCES:
                item = _youtube_try(binary, url, ctx.work / "yt" / "meta", extra, env,
                                    download=False)
                entry: dict[str, Any] = {"url": url, "outcome": item["outcome"], "via": name}
                if item["stdout"]:
                    entry |= _youtube_formats(json.loads(item["stdout"]))
                result["sources"].append(entry)
        result["decision"] = bgutil_decision(
            (result["arms"].get("node24_ejs") or {}).get("bot_check", {}).get("share"),
            (result["arms"].get("node24_ejs_bgutil") or {}).get("bot_check", {}).get("share"),
            (result["arms"].get("node24_ejs_bgutil") or {}).get("pot_tokens", 0))
    finally:
        server.stop()
    return result


def _download_peertube(ctx: Context, video: Mapping[str, Any], height: int, out: Path,
                       extra: Sequence[str] = ()) -> dict[str, Any]:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    url = f"{PEERTUBE}/videos/watch/{video['uuid']}"
    result = run([ctx.ytdlp, "--no-playlist", "-f",
                  f"bv*[height<={height}]+ba/b[height<={height}]", "--merge-output-format", "mp4",
                  *extra, "-o", str(out / "source.%(ext)s"), url], timeout=5400)
    path = first_file(out, "source")
    size = path.stat().st_size if path else None
    return {"ok": result.returncode == 0 and path is not None, "seconds": round(result.seconds, 2),
            "bytes": size, "path": str(path) if path else None,
            "error": None if result.returncode == 0 else tail(result.stderr, 3)}


def _encode(source: Path, target: Path, codec: str, limit: float | None) -> dict[str, Any]:
    args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), "-map", "0:a:0", "-vn"]
    if limit:
        args += ["-t", str(limit)]
    if codec == "source":
        args += ["-c:a", "copy"]
    elif codec == "aac":
        args += ["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2"]
    elif codec == "opus":
        args += ["-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
    result = run([*args, str(target)], timeout=1800)
    info = ffprobe(target) if result.returncode == 0 else {}
    stream = next((item for item in info.get("streams", []) if item.get("codec_type") == "audio"),
                  {})
    return {"codec": stream.get("codec_name"), "start_time": stream.get("start_time"),
            "sample_rate": stream.get("sample_rate"),
            "bytes": target.stat().st_size if target.exists() else None,
            "error": None if result.returncode == 0 else tail(result.stderr, 3)}


def _whisper(model_name: str, language: str) -> Any:
    from ai_clipper.transcribe import load_whisper_model, whisper_decoding_from_env
    decoding = whisper_decoding_from_env({}, language=language)
    return load_whisper_model(model_name, device="cpu", decoding=decoding)


def _analyze(path: Path, model: Any, language: str, segments: Any = None,
             scene_cuts: bool = False) -> dict[str, Any]:
    """Transcribe (unless ``segments``), measure the audio timeline and run the V3 heuristic."""
    from ai_clipper.audio_timeline import analyze_audio_timeline
    from ai_clipper.selection_v3 import select_clips_v3
    from ai_clipper.transcribe import transcribe_video
    times: dict[str, float] = {}
    if segments is None:
        started = time.monotonic()
        segments = transcribe_video(path, model=model, language=language).segments
        times["transcribe"] = time.monotonic() - started
    started = time.monotonic()
    timeline = analyze_audio_timeline(path, scene_cuts=scene_cuts, timeout=7200)
    times["timeline"] = time.monotonic() - started
    started = time.monotonic()
    selection = select_clips_v3(segments, k=5, min_duration=20.0, max_duration=60.0,
                                llm_mode="off", audio=timeline)
    times["select"] = time.monotonic() - started
    words = [(word.start, word.text) for segment in segments for word in segment.words]
    clips = [{"rank": item.rank, "start": item.start, "end": item.end} for item in selection.clips]
    return {"segments": segments, "words": words, "clips": clips,
            "silences": len(timeline.silences),
            "seconds": {key: round(value, 2) for key, value in times.items()},
            "status": selection.status}


def phase_audio(ctx: Context) -> dict[str, Any]:
    args = ctx.args
    talks = pick_talks(peertube_videos(), args.sources, 600, 2400, "en")
    if args.source_index is not None:
        talks = talks[args.source_index:args.source_index + 1]
    model = _whisper(args.whisper_model, "en")
    result: dict[str, Any] = {"whisper_model": args.whisper_model, "limit_seconds": args.limit,
                              "selection": "heuristic only (no LLM key in CI)", "sources": []}
    for video in talks:
        entry: dict[str, Any] = {"video": describe(video)}
        work = ctx.work / "audio" / video["uuid"]
        download = _download_peertube(ctx, video, 720, work / "dl")
        entry["download"] = {key: download[key] for key in ("ok", "seconds", "bytes", "error")}
        if not download["ok"]:
            result["sources"].append(entry)
            continue
        source = Path(download["path"])
        variants: dict[str, Any] = {}
        for name, codec, ext in (("source", "source", "m4a"), ("aac128", "aac", "m4a"),
                                 ("opus128", "opus", "webm")):
            target = work / f"{name}.{ext}"
            variants[name] = {"file": _encode(source, target, codec, args.limit), "path": target}
        reference = None
        for name, item in variants.items():
            if item["file"]["error"]:
                continue
            analysis = _analyze(item["path"], model, "en")
            item["analysis"] = analysis
            if name == "source":
                reference = analysis
        for name, item in variants.items():
            analysis = item.get("analysis")
            summary: dict[str, Any] = {"file": item["file"]}
            if analysis is not None:
                summary |= {"seconds": analysis["seconds"], "clips": analysis["clips"],
                            "silences": analysis["silences"]}
            if analysis is not None and reference is not None and name != "source":
                summary["whisper_words"] = word_deltas(reference["words"], analysis["words"])
                summary["whisper_clips"] = clip_deltas(reference["clips"], analysis["clips"],
                                                       limit_ms=200)
                # The captions case: the source's transcript on this audio's timeline, so only
                # the audio timeline differs from the reference.
                fixed = _analyze(item["path"], model, "en", segments=reference["segments"])
                summary["captions_clips"] = clip_deltas(reference["clips"], fixed["clips"],
                                                        limit_ms=200)
            entry[name] = summary
        result["sources"].append(entry)
        shutil.rmtree(work, ignore_errors=True)
    return result


def phase_sizes(ctx: Context) -> dict[str, Any]:
    """M0-8 from metadata: bytes per hour of the 720p and 1080p files of the timing sources."""
    picked = pick_by_duration(peertube_videos(), TIMING_TARGETS)
    rows = []
    for target, video in picked.items():
        if video is None:
            continue
        detail = fetch_json(f"{PEERTUBE}/api/v1/videos/{video['uuid']}")
        files = list(detail.get("files") or [])
        for playlist in detail.get("streamingPlaylists") or []:
            files += [item | {"hls": True} for item in playlist.get("files") or []]
        sizes: dict[str, int] = {}
        for item in files:
            height = (item.get("resolution") or {}).get("id")
            if height in (720, 1080) and item.get("size"):
                sizes[str(height)] = max(sizes.get(str(height), 0), int(item["size"]))
        rows.append({"target_seconds": target, "video": describe(video),
                     "bytes": sizes,
                     "bytes_per_hour": {height: bytes_per_hour(size, video["duration"])
                                        for height, size in sizes.items()}})
    return {"source": "video.blender.org file sizes (metadata, no download)", "sources": rows,
            "youtube": "not measured: every YouTube request from the runner was bot-checked"}


def phase_timing(ctx: Context) -> dict[str, Any]:
    args = ctx.args
    picked = pick_by_duration(peertube_videos(), TIMING_TARGETS)
    targets = [t for t in TIMING_TARGETS if args.target is None or t == args.target]
    model = _whisper(args.whisper_model, "en")
    result: dict[str, Any] = {"whisper_model": args.whisper_model,
                              "selection": "heuristic only (no LLM key in CI)",
                              "audio_first": "simulated: audio bytes at 128 kbit/s over the "
                                             "measured download throughput", "sources": []}
    for target in targets:
        video = picked.get(target)
        entry: dict[str, Any] = {"target_seconds": target,
                                 "video": describe(video) if video else None}
        if video is None:
            result["sources"].append(entry)
            continue
        work = ctx.work / "timing" / video["uuid"]
        download = _download_peertube(ctx, video, 720, work / "dl")
        entry["download_720"] = {key: download[key] for key in ("ok", "seconds", "bytes", "error")}
        if not download["ok"]:
            result["sources"].append(entry)
            continue
        source = Path(download["path"])
        audio = work / "audio.m4a"
        encoded = _encode(source, audio, "aac", None)
        full = _analyze(source, model, "en", scene_cuts=True)
        audio_only = _analyze(audio, model, "en", segments=full["segments"])
        duration = float(video["duration"])
        throughput = download["bytes"] / download["seconds"] if download["seconds"] else None
        audio_bytes = 128_000 / 8 * duration
        t_audio = audio_bytes / throughput if throughput else None
        t_transcribe = full["seconds"]["transcribe"]
        sequential = (download["seconds"] + t_transcribe + full["seconds"]["timeline"]
                      + full["seconds"]["select"])
        audio_first = (t_audio or 0) + t_transcribe + audio_only["seconds"]["timeline"] \
            + audio_only["seconds"]["select"]
        entry |= {
            "audio_encode": encoded,
            "throughput_bytes_per_s": round(throughput) if throughput else None,
            "seconds": {"video_download": download["seconds"],
                        "audio_download_simulated": round(t_audio, 2) if t_audio else None,
                        "transcribe": t_transcribe,
                        "timeline_with_scene_pass": full["seconds"]["timeline"],
                        "timeline_audio_only": audio_only["seconds"]["timeline"],
                        "select": full["seconds"]["select"]},
            "time_to_selection": {
                "sequential": round(sequential, 2), "audio_first": round(audio_first, 2),
                "sequential_with_captions": round(sequential - t_transcribe, 2),
                "audio_first_with_captions": round(audio_first - t_transcribe, 2)},
            "bytes_per_hour_720": bytes_per_hour(download["bytes"], duration),
            "whisper_realtime_factor": round(t_transcribe / duration, 4),
        }
        result["sources"].append(entry)
        shutil.rmtree(work, ignore_errors=True)
    return result


# --- range-only ----------------------------------------------------------------------------------

class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        pass


def _serve(directory: Path) -> tuple[socketserver.TCPServer, int]:
    handler = lambda *a, **k: _Quiet(*a, directory=str(directory), **k)
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def make_sync_source(target: Path, seconds: int, fps: int = 30) -> Path:
    """A test source with a one-frame white flash and a 20 ms beep at every even second."""
    period = 2
    video = (f"color=c=black:s=640x360:r={fps}:d={seconds},"
             f"geq=lum='if(lt(mod(N\\,{fps * period})\\,1)\\,235\\,16)':cb=128:cr=128")
    audio = (f"aevalsrc='if(lt(mod(t\\,{period})\\,0.02)\\,0.8*sin(2*PI*1000*t)\\,0)'"
             f":s=48000:d={seconds}")
    result = run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", video,
                  "-f", "lavfi", "-i", audio, "-c:v", "libx264", "-preset", "veryfast",
                  "-pix_fmt", "yuv420p", "-g", str(fps * 2), "-c:a", "aac", "-b:a", "128k",
                  str(target)], timeout=1800)
    if result.returncode != 0:
        raise RuntimeError(" | ".join(tail(result.stderr, 3)))
    return target


def measure_sync(path: Path) -> float | None:
    """A/V offset (seconds, audio minus video) of a cut of the flash/beep source."""
    stats = run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf",
                 "signalstats,metadata=print:file=-", "-f", "null", "-"], timeout=600)
    beeps = run(["ffmpeg", "-nostdin", "-i", str(path), "-map", "0:a:0", "-af",
                 "silencedetect=n=-30dB:d=0.01", "-f", "null", "-"], timeout=600)
    return av_offset(flash_times(stats.stdout), beep_onsets(beeps.stderr))


def _sections(ctx: Context, url: str, out: Path, start: float, length: float,
              force_keyframes: bool) -> dict[str, Any]:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    extra = ["--force-keyframes-at-cuts"] if force_keyframes else []
    result = run([ctx.ytdlp, "--no-playlist", "--download-sections",
                  f"*{start:.3f}-{start + length:.3f}", *extra, "-o",
                  str(out / "piece.%(ext)s"), url], timeout=1800)
    path = first_file(out, "piece")
    info = ffprobe(path) if path else {}
    return {"ok": result.returncode == 0 and path is not None, "seconds": round(result.seconds, 2),
            "bytes": path.stat().st_size if path else None, "starts": stream_starts(info),
            "duration": (info.get("format") or {}).get("duration"), "path": path,
            "error": None if result.returncode == 0 else tail(result.stderr, 3)}


def phase_range(ctx: Context) -> dict[str, Any]:
    args = ctx.args
    fps = 30
    frame = 1 / fps
    work = ctx.work / "range"
    work.mkdir(parents=True, exist_ok=True)
    result: dict[str, Any] = {"synthetic": {}, "peertube": None}
    # 1. A/V offset of cut pieces of a local HLS and DASH test source.
    source = make_sync_source(work / "sync.mp4", args.sync_seconds, fps)
    result["synthetic"]["baseline_offset_s"] = measure_sync(source)
    packages = work / "www"
    packages.mkdir(exist_ok=True)
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), "-c", "copy", "-f", "hls",
         "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_filename",
         str(packages / "h%03d.ts"), str(packages / "index.m3u8")], timeout=600)
    run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(source), "-map", "0:v", "-map",
         "0:a", "-c", "copy", "-f", "dash", "-seg_duration", "6", "-use_template", "1",
         "-use_timeline", "1", str(packages / "manifest.mpd")], timeout=600)
    server, port = _serve(packages)
    try:
        windows = [(37.3 + 23.9 * index) % (args.sync_seconds - 90) + 10
                   for index in range(args.windows)]
        for name, manifest in (("hls", "index.m3u8"), ("dash", "manifest.mpd")):
            url = f"http://127.0.0.1:{port}/{manifest}"
            for force in (False, True):
                key = f"{name}_{'keyframes' if force else 'copy'}"
                pieces = []
                for index, start in enumerate(windows):
                    piece = _sections(ctx, url, work / key / str(index), start, 30.0, force)
                    offset = measure_sync(piece["path"]) if piece["ok"] else None
                    pieces.append({"start": round(start, 3), "ok": piece["ok"],
                                   "seconds": piece["seconds"], "starts": piece["starts"],
                                   "duration": piece["duration"],
                                   "offset_s": offset,
                                   "offset_frames": round(offset / frame, 3)
                                   if offset is not None else None,
                                   "error": piece["error"]})
                offsets = [item["offset_frames"] for item in pieces
                           if item["offset_frames"] is not None]
                result["synthetic"][key] = {
                    "pieces": pieces,
                    "measured": len(offsets),
                    "within_one_frame": (sum(1 for item in offsets if abs(item) <= 1)
                                         / len(offsets)) if offsets else None,
                    "median_seconds": statistics.median(item["seconds"] for item in pieces),
                }
    finally:
        server.shutdown()
    # 2. Cut time against the full download on a real long source (video.blender.org).
    picked = pick_by_duration(peertube_videos(), [3600]).get(3600)
    if picked is not None:
        url = f"{PEERTUBE}/videos/watch/{picked['uuid']}"
        full = _download_peertube(ctx, picked, 720, work / "full")
        cuts = []
        for start in (600.0, 1500.0, 2400.0):
            for force in (False, True):
                piece = _sections(ctx, url, work / "cut", start, 60.0, force)
                cuts.append({"start": start, "keyframes": force, "ok": piece["ok"],
                             "seconds": piece["seconds"], "bytes": piece["bytes"],
                             "starts": piece["starts"], "duration": piece["duration"],
                             "error": piece["error"]})
        result["peertube"] = {"video": describe(picked),
                              "full": {key: full[key] for key in ("ok", "seconds", "bytes")},
                              "cuts": cuts}
        shutil.rmtree(work / "full", ignore_errors=True)
    return result


# --- proxy ---------------------------------------------------------------------------------------

class CountingProxy(threading.Thread):
    """A local HTTP CONNECT proxy that relays bytes and counts the tunnels it opened."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.port = self.listener.getsockname()[1]
        self.tunnels: list[str] = []
        self.auth_seen = 0

    def run(self) -> None:
        while True:
            try:
                client, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        try:
            head = b""
            while b"\r\n\r\n" not in head and len(head) < 65536:
                chunk = client.recv(4096)
                if not chunk:
                    return
                head += chunk
            first = head.split(b"\r\n", 1)[0].decode(errors="replace").split()
            if b"proxy-authorization:" in head.lower():
                self.auth_seen += 1
            if len(first) < 2 or first[0] != "CONNECT":
                client.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
                return
            host, _, port = first[1].rpartition(":")
            upstream = socket.create_connection((host, int(port)), timeout=30)
            self.tunnels.append(host)
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            sockets = [client, upstream]
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    return
                for item in readable:
                    data = item.recv(65536)
                    if not data:
                        return
                    (upstream if item is client else client).sendall(data)
        except OSError:
            return
        finally:
            client.close()

    def close(self) -> None:
        self.listener.close()


def _watch(argv: Sequence[str], marker: bytes, env: Mapping[str, str]) -> dict[str, Any]:
    """Run ``argv`` and scan /proc every 20 ms while it runs."""
    started = time.monotonic()
    process = subprocess.Popen(list(argv), env=dict(env), stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE)
    hits: list[dict[str, Any]] = []
    scans = 0
    seen_max = 0
    while process.poll() is None:
        found, seen = scan_proc(Path("/proc"), marker)
        scans += 1
        seen_max = max(seen_max, seen)
        hits.extend(item for item in found if item not in hits)
        time.sleep(0.02)
    stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
    return {"returncode": process.returncode, "seconds": round(time.monotonic() - started, 2),
            "scans": scans, "processes_seen_max": seen_max, "hits": hits,
            "error": next((line[:200] for line in reversed(stderr.splitlines())
                           if line.startswith("ERROR:")), None)}


def phase_proxy(ctx: Context) -> dict[str, Any]:
    marker = "m0-" + hashlib.sha256(os.urandom(16)).hexdigest()[:16]
    proxy = CountingProxy()
    proxy.start()
    proxy_url = f"http://m0user:{marker}@127.0.0.1:{proxy.port}"
    config = write_proxy_config(ctx.work / "attempt" / ".fetch" / "ytdlp.conf", proxy_url)
    talks = pick_talks(peertube_videos(), 1, 60, 1200, "en")
    target = f"{PEERTUBE}/videos/watch/{talks[0]['uuid']}" if talks else YOUTUBE_PROBE
    out = ctx.work / "proxy"
    env = child_env(os.environ)
    base = [ctx.ytdlp, "--ignore-config", "--no-playlist", "-f", "worst", "-o",
            str(out / "p.%(ext)s")]
    try:
        before = len(proxy.tunnels)
        via_config = _watch([*base, "--config-locations", str(config), target],
                            marker.encode(), env)
        tunnels_config = len(proxy.tunnels) - before
        before = len(proxy.tunnels)
        shutil.rmtree(out, ignore_errors=True)
        via_argv = _watch([*base, "--proxy", proxy_url, target], marker.encode(), env)
        tunnels_argv = len(proxy.tunnels) - before
    finally:
        proxy.close()
        config.unlink(missing_ok=True)
    return {
        "target": target,
        "config_locations": via_config | {"tunnels": tunnels_config},
        "control_argv_proxy": via_argv | {"tunnels": tunnels_argv},
        "proxy_auth_headers_seen": proxy.auth_seen,
        "confirmed": bool(tunnels_config and not via_config["hits"] and via_argv["hits"]),
    }


# --- Kick ----------------------------------------------------------------------------------------

def _kick_api(path: str, python: str | None) -> tuple[Any, str]:
    """GET a Kick API path with urllib (``python`` None) or with curl_cffi impersonation."""
    url = "https://kick.com/api/" + path
    if python is None:
        try:
            return fetch_json(url), "ok"
        except Exception as error:  # noqa: BLE001
            return None, f"{type(error).__name__}: {error}"[:160]
    code = ("import json,sys\nfrom curl_cffi import requests\n"
            "r=requests.get(sys.argv[1],impersonate='chrome',timeout=30)\n"
            "print(r.status_code);print(r.text)")
    result = run([python, "-c", code, url], timeout=90)
    status, _, body = result.stdout.partition("\n")
    if result.returncode != 0 or status.strip() != "200":
        return None, f"status {status.strip() or result.returncode}"
    try:
        return json.loads(body), "ok"
    except json.JSONDecodeError:
        return None, "not json"


def _playlist_status(info: Mapping[str, Any], py: str | None) -> str | None:
    """HTTP status of the first HLS playlist (a text manifest, never a media segment)."""
    url = next((item.get("url") for item in info.get("formats") or []
                if str(item.get("protocol", "")).startswith("m3u8") and item.get("url")), None)
    if not isinstance(url, str) or not url.startswith("https://"):
        return None
    if py is not None:
        code = ("import sys\nfrom curl_cffi import requests\n"
                "print(requests.get(sys.argv[1],impersonate='chrome',timeout=30).status_code)")
        result = run([py, "-c", code, url], timeout=60)
        return result.stdout.strip() or f"failed {result.returncode}"
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 potongin-m0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # https only, checked
            response.read(256 * 1024)
            return str(response.status)
    except urllib.error.HTTPError as error:
        return str(error.code)
    except OSError as error:
        return type(error).__name__


def phase_kick(ctx: Context) -> dict[str, Any]:
    locked = smoke.locked_version((ROOT / "uv.lock").read_text(encoding="utf-8"))
    cffi_bin = ctx.tools.venv("cffi", [f"yt-dlp=={locked}", f"curl_cffi=={PINS['curl_cffi']}"])
    python = str(cffi_bin / "python") if cffi_bin else None
    api: dict[str, Any] = {}
    vods: list[str] = []
    clip_pages: list[str] = []
    for channel in KICK_CHANNELS:
        for client, py in (("urllib", None), ("curl_cffi", python)):
            if client == "curl_cffi" and py is None:
                continue
            videos, videos_status = _kick_api(f"v2/channels/{channel}/videos", py)
            clips, clips_status = _kick_api(f"v2/channels/{channel}/clips", py)
            api[f"{channel}/{client}"] = {"videos": videos_status, "clips": clips_status}
            for url in kick_urls(channel, videos, clips, 50):
                pool = clip_pages if "/clips/" in url else vods
                if url not in pool and sum(1 for item in pool if f"/{channel}/" in item) < 2:
                    pool.append(url)
        if len(vods) >= 3 and len(clip_pages) >= 2:
            break
    # Three VODs and two clips when both exist, five pages in all.
    urls = (vods[:3] + clip_pages[:2] + vods[3:] + clip_pages[2:])[:5]
    arms = {"without_curl_cffi": ctx.ytdlp,
            "with_curl_cffi": str(cffi_bin / "yt-dlp") if cffi_bin else None}
    result: dict[str, Any] = {"api": api, "urls": len(urls), "media": "not downloaded",
                              "setup": dict(ctx.tools.problems), "arms": {}}
    outcomes: dict[str, list[str]] = {}
    for name, binary in arms.items():
        if binary is None:
            continue
        items = []
        for url in urls:
            res = run([binary, "-v", "--no-playlist", "--skip-download", "--dump-single-json",
                       url], timeout=180)
            ok = res.returncode == 0 and bool(res.stdout.strip())
            formats = 0
            playlist = None
            if ok:
                try:
                    info = json.loads(res.stdout)
                    formats = len(info.get("formats") or [])
                    playlist = _playlist_status(
                        info, py=python if name == "with_curl_cffi" else None)
                except json.JSONDecodeError:
                    ok = False
            outcome = "ok" if ok and formats else download_outcome(
                res.returncode if not ok else 1, res.stderr, False)
            items.append({"kind": "clip" if "/clips/" in url else "vod", "outcome": outcome,
                          "formats": formats, "seconds": round(res.seconds, 2),
                          "playlist": playlist,
                          "impersonation_warning": "attempting impersonation" in res.stderr,
                          "line": next((line[:200] for line in reversed(res.stderr.splitlines())
                                        if line.startswith("ERROR:")), None)})
        outcomes[name] = [item["outcome"] for item in items]
        result["arms"][name] = items
    result["decision"] = kick_decision(outcomes.get("without_curl_cffi", []),
                                       outcomes.get("with_curl_cffi", []))
    return result


# --- driver --------------------------------------------------------------------------------------

PHASE_FUNCS: dict[str, Callable[[Context], dict[str, Any]]] = {
    "env": phase_env, "extractors": phase_extractors, "youtube": phase_youtube,
    "audio": phase_audio, "timing": phase_timing, "range": phase_range, "proxy": phase_proxy,
    "kick": phase_kick, "sizes": phase_sizes,
}


def log(message: str) -> None:
    print(f"[m0 {time.strftime('%H:%M:%S')}] {message}", flush=True)


def _write(path: Path, result: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str) + "\n",
                         encoding="utf-8")
    temporary.replace(path)


def measure(args: argparse.Namespace) -> int:
    phases = [name.strip() for name in args.only.split(",") if name.strip()] or list(PHASES)
    unknown = sorted(set(phases) - set(PHASES))
    if unknown:
        raise SystemExit(f"unknown phase: {', '.join(unknown)}")
    ctx = Context(args)
    out = Path(args.out)
    run_info = {"phases": phases, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "pins": PINS}
    result: dict[str, Any] = {"schema": SCHEMA, "runs": [run_info], "phases": {}}
    for name in phases:
        log(f"phase {name}")
        started = time.monotonic()
        try:
            value = PHASE_FUNCS[name](ctx)
        except Exception as error:  # noqa: BLE001 (record and go on with the next phase)
            value = {"error": f"{type(error).__name__}: {error}"[:500]}
        value["phase_seconds"] = round(time.monotonic() - started, 1)
        result["phases"][name] = value
        _write(out, result)
        log(f"phase {name} done in {value['phase_seconds']} s")
    return 0


def _each(value: Any) -> list[Mapping[str, Any]]:
    return [item for item in (value if isinstance(value, list) else [value])
            if isinstance(item, Mapping)]


def report(merged: Mapping[str, Any]) -> dict[str, Any]:
    """The derived numbers of a merged result: the §B11 range-only inputs."""
    phases = merged.get("phases", {})
    timing = [source for item in _each(phases.get("timing")) for source in item.get("sources", [])]
    cuts, offsets = [], []
    for item in _each(phases.get("range")):
        cuts += [cut["seconds"] for cut in (item.get("peertube") or {}).get("cuts", [])
                 if cut.get("ok") and not cut.get("keyframes")]
        for value in (item.get("synthetic") or {}).values():
            if isinstance(value, Mapping) and "pieces" in value:
                offsets += [piece["offset_frames"] for piece in value["pieces"]
                            if piece.get("offset_frames") is not None]
    return {"schema": SCHEMA + "#report", "range_only": range_report(timing, cuts, offsets)}


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["merge"]:
        parser = argparse.ArgumentParser(prog="m0_measure.py merge")
        parser.add_argument("files", nargs="+")
        parser.add_argument("--out", required=True)
        args = parser.parse_args(argv[1:])
        merged = merge_results([json.loads(Path(item).read_text(encoding="utf-8"))
                                for item in args.files])
        _write(Path(args.out), merged)
        return 0
    if argv[:1] == ["report"]:
        parser = argparse.ArgumentParser(prog="m0_measure.py report")
        parser.add_argument("merged")
        parser.add_argument("--out", required=True)
        args = parser.parse_args(argv[1:])
        _write(Path(args.out), report(json.loads(Path(args.merged).read_text(encoding="utf-8"))))
        return 0
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", default="", help=f"phases, comma-separated: {','.join(PHASES)}")
    parser.add_argument("--work", default="/tmp/m0-work")
    parser.add_argument("--tries", type=int, default=20)
    parser.add_argument("--sources", type=int, default=5, help="audio: talks to measure")
    parser.add_argument("--source-index", type=int, help="audio: only this talk")
    parser.add_argument("--target", type=int, choices=TIMING_TARGETS, help="timing: one length")
    parser.add_argument("--limit", type=float, default=600.0, help="audio: seconds per talk")
    parser.add_argument("--whisper-model", default="small")
    parser.add_argument("--windows", type=int, default=20, help="range: pieces per package")
    parser.add_argument("--sync-seconds", type=int, default=900, help="range: test source")
    return measure(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
