#!/usr/bin/env python3
"""Auto-reframe evaluation: shot cuts and the 9:16 mode per shot against labelled windows.

The set is about 40 windows of 120 s from openly licensed sources (CC BY, CC0, public domain),
listed in the ``reframe_eval`` block of ``docs/evaluation/TRAINING_SOURCE_REGISTRY.json`` with a
seeded dev/test split. The footage is not committed: ``--fetch`` cuts each window from the
source's public file into a cache outside the repository, re-encoded on the document grid (the
document frame rate of the source, ``edit_v2.seed.output_fps``) so that frame ``k`` of the cached
file is grid frame ``window_sf[0] + k``.

Labels (``docs/evaluation/auto-reframe/labels.<split>.json``): per window the cuts on the grid
(the first frame of each new shot) and the right mode per shot. Measures: cut precision and
recall within ±1 grid frame, the share of frames whose mode matches the label, and the scan time.
The gates are fixed in ``docs/evaluation/AUTO_REFRAME.md`` before the test split ever runs, and
the test split runs once (``--split test --confirm-once``, RF-M4). Commands, from the repository
root::

    uv run python scripts/eval/auto_reframe.py --fetch --split dev --cache DIR
    uv run python scripts/eval/auto_reframe.py --sheets --split dev --cache DIR --out DIR2
    uv run python scripts/eval/auto_reframe.py --label --split test --cache DIR --out PAGE.html
    uv run python scripts/eval/auto_reframe.py --predict --split dev --cache DIR --out PRED.json
    uv run python scripts/eval/auto_reframe.py --score PRED.json --split dev --cache DIR --out RESULT.json
    uv run python scripts/eval/auto_reframe.py --split dev --cache DIR --out RESULT.json
    uv run python scripts/eval/auto_reframe.py --timing --split dev --cache DIR

``--predict`` measures without reading labels (on CI, where the footage is), ``--score`` scores
those predictions against the labels later; plain ``--split dev`` does both. They measure today's
camera mode (Ikuti wajah on every frame, with the camera plan's cut flags and the pipeline's
FFmpeg scene cuts as today's cut sources).

The shot detector of RF-M1 is measured the same way, in two steps::

    uv run python scripts/eval/auto_reframe.py --profile --split dev --cache DIR --out PROFILES.json
    uv run python scripts/eval/auto_reframe.py --sweep --split dev --profiles PROFILES.json --out SWEEP.json

``--profile`` (on CI, no labels read) keeps per window what every rule configuration needs: the
grid profile of ``edit_v2.shot_cuts.measure`` (scene scores and frame differences), the face scan
of ``shot_context.scan_evidence`` and how long each took. ``--sweep`` then runs both stages of
``docs/evaluation/AUTO_REFRAME.md`` on those profiles without footage: stage 1 the cut keys, stage
2 the mode keys with the cuts of stage 1. ``--write-rules`` writes the chosen values to
``resources/reframe/rules.v1.json``. The sweep runs on the dev split only; the test split stays
locked until RF-M4.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator, Mapping, Sequence
from itertools import pairwise, product
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

REGISTRY = ROOT / "docs" / "evaluation" / "TRAINING_SOURCE_REGISTRY.json"
LABEL_DIR = ROOT / "docs" / "evaluation" / "auto-reframe"
TEST_LOCK = LABEL_DIR / "test-run.json"
LABELS_SCHEMA = "potongin.reframe-labels/1"
RESULT_SCHEMA = "potongin.reframe-result/1"
PREDICTION_SCHEMA = "potongin.reframe-prediction/1"
PROFILE_SCHEMA = "potongin.reframe-profile/1"
SWEEP_SCHEMA = "potongin.reframe-sweep/1"
RULES_PATH = ROOT / "resources" / "reframe" / "rules.v1.json"

WINDOW_MS = 120_000
OUTPUT = (720, 1280)
FETCH_MAX_HEIGHT = 720  # Potongin downloads are at most 720p
USER_AGENT = "PotonginEval/1 (open-licence reframe evaluation) ffmpeg"
FETCH_ATTEMPTS = 8
FETCH_PAUSE_S = 5  # between downloads
FETCH_BACKOFF_S = 60
FETCH_MAX_WAIT_S = 900
CATEGORIES = ("single_speaker", "two_person", "panel", "screen", "gameplay_broll")
COMPOSITION = {"single_speaker": 10, "two_person": 10, "panel": 8, "screen": 6,
               "gameplay_broll": 6}
MODES = ("camera", "fill_center", "fit_blur", "split")
RIGHTS = {"creative_commons_attribution", "cc0", "public_domain"}
LICENCE = re.compile(r"^(CC BY [0-9.]+( [A-Za-z]+)?|CC0( 1\.0)?|Public domain)$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

GATES = {
    "cut_precision": 0.95,  # RF-M1, dev split, ±1 grid frame
    "cut_recall": 0.90,
    "scan_base_s": 15.0,  # RF-M1, one 120 s window on CI ...
    "scan_per_cut_s": 0.5,  # ... plus this per cut
    "agreement": 0.85,  # RF-M4, test split, once
    "speaker_framing_multi": 0.217,  # RF-M4, SPEAKER_FRAMING multi error on camera frames
    "owner_accepts": [8, 10],  # RF-M4, split clips the owner accepts
}
SWEEP_GRID: dict[str, tuple[int, ...]] = {
    "cut.coarse_scene_pm": (200, 250, 300, 350, 400),
    "cut.refine_diff_pm": (60, 80, 100, 130, 160),
    "cut.min_gap_ms": (300, 500, 800),
    "face.present_pm": (300, 400, 500, 600),
    "face.small_w_pm": (40, 60, 80, 100),
    "face.centre_pm": (60, 100, 140),
    "speakers.active_pm": (100, 150, 200),
    "speakers.split_share_pm": (200, 250, 300, 350),
    "motion.still_pm": (20, 40, 60),
}
# Label helpers: candidate cuts for the contact sheets (deliberately low, so that the sheets
# show more than a detector would keep).
CANDIDATE_SCENE = 0.08
CANDIDATE_DIFF = 0.04
CANDIDATE_GAP = 3


class LabelError(ValueError):
    """A label file or entry that does not describe its window."""


class TestSplitLocked(RuntimeError):
    """The test split runs once, on purpose, at RF-M4."""


Fps = tuple[int, int]


# --- grid ----------------------------------------------------------------------------------------


def _fps(value: Sequence[int]) -> Fps:
    num, den = value
    if type(num) is not int or type(den) is not int or num <= 0 or den <= 0:
        raise ValueError("fps must be two positive integers")
    return num, den


def window_grid(start_ms: int, duration_ms: int, fps: Sequence[int]) -> tuple[int, int]:
    """``(first_sf, end_sf)``: the first grid frame at or after ``start_ms`` and
    ``⌊duration · rate⌋`` frames."""
    num, den = _fps(fps)
    first = -(-start_ms * num // (1000 * den))
    return first, first + duration_ms * num // (1000 * den)


def document_fps(native: Sequence[int], *, vfr: bool) -> Fps:
    """The document rate the editor would give this source (``edit_v2.seed.output_fps``)."""
    from ai_clipper.edit_v2.seed import output_fps

    rate = output_fps({"fps_native": list(native), "vfr": vfr})
    return rate.num, rate.den


def window_start_ms(duration_s: float, *, seed: int, window_id: str) -> int:
    """A seeded whole-second start between 10 % of the source and 90 % minus the window; the
    latest start that fits when the source is too short for that band."""
    total_ms = int(duration_s * 1000)
    if total_ms < WINDOW_MS:
        raise ValueError(f"{window_id}: the source is shorter than one window")
    low = math.ceil(duration_s * 0.1)
    high = math.floor(duration_s * 0.9 - WINDOW_MS / 1000)
    if high < low:
        return (total_ms - WINDOW_MS) // 1000 * 1000
    rng = random.Random(f"{seed}:{window_id}")
    return rng.randint(low, high) * 1000


# --- cuts ----------------------------------------------------------------------------------------


def match_cuts(predicted: Sequence[int], truth: Sequence[int], tolerance: int = 1
               ) -> tuple[int, int, int]:
    """``(true positives, false positives, false negatives)`` with the largest one-to-one
    matching where a pair is at most ``tolerance`` frames apart (greedy in time order, which is
    optimal on a line)."""
    labels = sorted(truth)
    used = [False] * len(labels)
    start = 0
    matched = 0
    for cut in sorted(predicted):
        while start < len(labels) and (used[start] or labels[start] < cut - tolerance):
            start += 1
        index = start
        while index < len(labels) and labels[index] <= cut + tolerance:
            if not used[index]:
                used[index] = True
                matched += 1
                break
            index += 1
    return matched, len(predicted) - matched, len(labels) - matched


def cut_scores(tp: int, fp: int, fn: int) -> dict[str, float]:
    precision = 1.0 if tp + fp == 0 else tp / (tp + fp)
    recall = 1.0 if tp + fn == 0 else tp / (tp + fn)
    f1 = 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1}


def camera_cut_sf(plan: Mapping[str, Any], *, first_sf: int, fps: Sequence[int]) -> list[int]:
    """The camera plan's cut flags as grid frames: a flag on sample ``i`` (a change since sample
    ``i − 1``) lands on the frame of sample ``i``, where today's crop jumps."""
    num, den = _fps(fps)
    window_start = plan.get("window_ms", [0, 0])[0]
    cuts = []
    for index, ((t_ms, _x), flag) in enumerate(zip(plan["samples"], plan["cuts"], strict=True)):
        if flag and index > 0:
            cuts.append(first_sf + (t_ms - window_start) * num // (1000 * den))
    return sorted({c for c in cuts if c > first_sf})


def scene_cut_sf(times: Sequence[float], *, first_sf: int, fps: Sequence[int], frames: int
                 ) -> list[int]:
    """Scene-cut times (seconds from the window start, frame timestamps) as grid frames."""
    num, den = _fps(fps)
    out = set()
    for t in times:
        k = math.floor(t * num / den + 0.5)
        if 0 < k < frames:
            out.add(first_sf + k)
    return sorted(out)


# --- modes ---------------------------------------------------------------------------------------


def _segments(window: Sequence[int], cuts: Sequence[int], modes: Sequence[str]
              ) -> list[tuple[int, int, str]]:
    bounds = [window[0], *cuts, window[1]]
    return [(bounds[i], bounds[i + 1], modes[i]) for i in range(len(modes))]


def agreement(window: Sequence[int], predicted: tuple[Sequence[int], Sequence[str]],
              label: tuple[Sequence[int], Sequence[str]]) -> tuple[int, int]:
    """``(frames with the label's mode, frames)`` of one window; each side is
    ``(cuts_sf, modes)``."""
    same = 0
    for a0, a1, mode_a in _segments(window, *predicted):
        for b0, b1, mode_b in _segments(window, *label):
            if mode_a == mode_b:
                same += max(0, min(a1, b1) - max(a0, b0))
    return same, window[1] - window[0]


def today_modes(no_face_ms: Sequence[Sequence[int]], fps: Sequence[int], window_sf: Sequence[int]
                ) -> tuple[list[int], list[str]]:
    """Today's camera mode as ``(cuts_sf, modes)``: ``camera``, with the plan's ``no_face``
    spans (ms from the window start) centred, since the seed writes ``no_face: "center"``
    (§5.40). A span covers the frames ``layouts.no_face_frames`` gives it."""
    num, den = fps
    first, end = window_sf
    scale = 1000 * den
    spans = [(s * num, e * num) for s, e in no_face_ms]
    centred = [any(k * scale < e and (k + 1) * scale > s for s, e in spans)
               for k in range(end - first)]
    cuts: list[int] = []
    modes = ["fill_center" if centred and centred[0] else "camera"]
    for k in range(1, len(centred)):
        if centred[k] != centred[k - 1]:
            cuts.append(first + k)
            modes.append("fill_center" if centred[k] else "camera")
    return cuts, modes


# --- labels and the registry ---------------------------------------------------------------------

_LABEL_KEYS = {"id", "fps", "window_sf", "cuts_sf", "modes", "note"}


def check_label(entry: Mapping[str, Any], window: Mapping[str, Any], *,
                allow_empty: bool = False) -> None:
    """Raise :class:`LabelError` unless ``entry`` labels ``window`` (a registry window)."""
    name = entry.get("id", "?")
    unknown = set(entry) - _LABEL_KEYS
    if unknown:
        raise LabelError(f"{name}: unknown keys {sorted(unknown)}")
    if entry.get("id") != window["id"]:
        raise LabelError(f"{name}: not the window {window['id']}")
    if window.get("fps") is None or list(entry.get("fps") or []) != list(window["fps"]):
        raise LabelError(f"{name}: fps is not the window's document rate")
    grid = window_grid(window["start_ms"], window["duration_ms"], window["fps"])
    if list(entry.get("window_sf") or []) != list(grid):
        raise LabelError(f"{name}: window_sf must be {list(grid)}")
    cuts, modes = entry.get("cuts_sf"), entry.get("modes")
    if cuts is None and modes is None:
        if allow_empty:
            return
        raise LabelError(f"{name}: not labelled")
    if not isinstance(cuts, list) or not isinstance(modes, list):
        raise LabelError(f"{name}: cuts_sf and modes must be lists")
    if any(type(c) is not int for c in cuts):
        raise LabelError(f"{name}: cuts must be integers")
    if any(b <= a for a, b in pairwise(cuts)):
        raise LabelError(f"{name}: cuts must increase strictly")
    if cuts and not (grid[0] < cuts[0] and cuts[-1] < grid[1]):
        raise LabelError(f"{name}: cuts must lie inside the window, after its first frame")
    if len(modes) != len(cuts) + 1:
        raise LabelError(f"{name}: one mode per shot ({len(cuts) + 1})")
    if any(mode not in MODES for mode in modes):
        raise LabelError(f"{name}: modes are {', '.join(MODES)}")


def split_windows(registry: Mapping[str, Any], split: str) -> list[dict[str, Any]]:
    windows = registry["reframe_eval"]["windows"]
    return [w for w in windows if split == "all" or w["split"] == split]


def check_labels(labels: Mapping[str, Any], registry: Mapping[str, Any], split: str, *,
                 allow_empty: bool = False) -> None:
    if labels.get("schema") != LABELS_SCHEMA or labels.get("split") != split:
        raise LabelError(f"not a {split} label file ({LABELS_SCHEMA})")
    windows = {w["id"]: w for w in split_windows(registry, split)}
    entries = labels.get("windows")
    if not isinstance(entries, list):
        raise LabelError("windows must be a list")
    ids = [entry.get("id") for entry in entries]
    if sorted(ids) != sorted(windows) or len(set(ids)) != len(ids):
        raise LabelError(f"the {split} labels must cover each {split} window once")
    for entry in entries:
        check_label(entry, windows[entry["id"]], allow_empty=allow_empty)


def check_registry(registry: Mapping[str, Any]) -> None:
    """The reframe block: open licences recorded per source, whole windows, a seeded split."""
    sources = {s["source_id"]: s for s in registry["sources"] if "source_id" in s}
    for source_id, source in sources.items():
        for key in ("url", "media_url", "license", "license_url", "author", "license_checked_at",
                    "accessed_at", "duration_seconds"):
            if source.get(key) in (None, ""):
                raise ValueError(f"{source_id}: {key} is missing")
        if source.get("rights_status") not in RIGHTS:
            raise ValueError(f"{source_id}: rights_status must be one of {sorted(RIGHTS)}")
        if not LICENCE.match(source["license"]) or " SA" in source["license"]:
            raise ValueError(f"{source_id}: {source['license']} is not CC BY, CC0 or public domain")
        for key in ("license_checked_at", "accessed_at"):
            if not DATE.match(source[key]):
                raise ValueError(f"{source_id}: {key} must be YYYY-MM-DD")
    block = registry["reframe_eval"]
    if type(block["split"]["seed"]) is not int:
        raise ValueError("the split seed must be an integer")
    seen = set()
    for window in block["windows"]:
        if window["id"] in seen:
            raise ValueError(f"{window['id']}: duplicate window")
        seen.add(window["id"])
        source = sources.get(window["source_id"])
        if source is None:
            raise ValueError(f"{window['id']}: unknown source {window['source_id']}")
        if window["category"] not in CATEGORIES or window["split"] not in ("dev", "test"):
            raise ValueError(f"{window['id']}: bad category or split")
        if window["duration_ms"] != WINDOW_MS or window["start_ms"] % 1000:
            raise ValueError(f"{window['id']}: windows are 120 s from a whole second")
        if window["start_ms"] + window["duration_ms"] > source["duration_seconds"] * 1000:
            raise ValueError(f"{window['id']}: the window runs past the source")
        if window.get("fps") is not None:
            _fps(window["fps"])
    expected = assign_splits(block["windows"], seed=block["split"]["seed"])
    for window in block["windows"]:
        if window["split"] != expected[window["id"]]:
            raise ValueError(f"{window['id']}: the split is not the seeded one")


def assign_splits(windows: Sequence[Mapping[str, Any]], *, seed: int) -> dict[str, str]:
    """Per category, the sources shuffled with ``seed``: the first half (rounded down) dev, the
    rest test. Windows of one source share its split."""
    split: dict[str, str] = {}
    for category in sorted({w["category"] for w in windows}):
        sources = sorted({w["source_id"] for w in windows if w["category"] == category})
        random.Random(f"{seed}:{category}").shuffle(sources)
        dev = set(sources[: len(sources) // 2])
        for w in windows:
            if w["category"] == category:
                split[w["id"]] = "dev" if w["source_id"] in dev else "test"
    for w in windows:  # a source listed under two categories follows its first window
        first = next(x for x in windows if x["source_id"] == w["source_id"])
        split[w["id"]] = split[first["id"]]
    return split


# --- sweep ---------------------------------------------------------------------------------------


def configs(prefix: str) -> Iterator[dict[str, int]]:
    keys = [key for key in SWEEP_GRID if key.startswith(prefix)]
    for values in product(*(SWEEP_GRID[key] for key in keys)):
        yield dict(zip(keys, values, strict=True))


def pick_cut_config(rows: Sequence[Mapping[str, Any]]) -> dict[str, int] | None:
    """Stage 1: the best F1 among configurations with precision and recall at their floors; ties
    go to the larger ``min_gap_ms``, then the larger ``coarse_scene_pm``."""
    eligible = [r for r in rows if r["precision"] >= GATES["cut_precision"]
                and r["recall"] >= GATES["cut_recall"]]
    if not eligible:
        return None
    best = max(eligible, key=lambda r: (round(r["f1"], 9), r["config"].get("cut.min_gap_ms", 0),
                                        r["config"].get("cut.coarse_scene_pm", 0)))
    return dict(best["config"])


def pick_mode_config(rows: Sequence[Mapping[str, Any]]) -> dict[str, int] | None:
    """Stage 2: the best agreement; ties go to fewer frames that are not ``camera``."""
    if not rows:
        return None
    best = max(rows, key=lambda r: (round(r["agreement"], 9), -r["non_camera_frames"]))
    return dict(best["config"])


def scan_budget_s(cuts: int) -> float:
    return GATES["scan_base_s"] + GATES["scan_per_cut_s"] * cuts


def check_test_lock(lock: Path, *, confirm: bool) -> None:
    if lock.exists():
        raise TestSplitLocked(f"the test split already ran ({lock}); a new one needs new windows")
    if not confirm:
        raise TestSplitLocked("the test split runs once, at RF-M4: pass --confirm-once")


# --- fetching ------------------------------------------------------------------------------------


def _tool(name: str) -> str:
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"{name} is needed")
    return path


def download(url: str, target: Path, *, sha1: str | None) -> Path:
    """The whole file in one request (the media host rate-limits uncached requests per client,
    so a seek over HTTP, which makes several, runs into the limit sooner). A 429 or 503 waits for
    its ``Retry-After``. ``sha1`` (Commons' hash of an original upload) is checked when given."""
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=120) as response, \
                    partial.open("wb") as out:
                shutil.copyfileobj(response, out, 1 << 20)
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 503) or attempt == FETCH_ATTEMPTS:
                raise RuntimeError(f"{url}: HTTP {exc.code}") from exc
            wait = min(int(exc.headers.get("Retry-After") or FETCH_BACKOFF_S), FETCH_MAX_WAIT_S)
            print(f"  HTTP {exc.code}, waiting {wait} s (attempt {attempt})", flush=True)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == FETCH_ATTEMPTS:
                raise RuntimeError(f"{url}: {exc}") from exc
            time.sleep(FETCH_BACKOFF_S * attempt)
    if sha1 is not None:
        digest = hashlib.sha1(partial.read_bytes()).hexdigest()  # Commons' pin for the original
        if digest != sha1:
            partial.unlink()
            raise RuntimeError(f"{url}: sha1 {digest} is not the registry's {sha1}")
    os.replace(partial, target)
    return target


def _probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        [_tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=r_frame_rate,avg_frame_rate,width,height", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=300, check=True)
    stream = json.loads(out.stdout)["streams"][0]

    def rate(text: str) -> tuple[int, int]:
        num, den = (int(v) for v in text.split("/"))
        g = math.gcd(num, den) or 1
        return (num // g, den // g) if num > 0 and den > 0 else (0, 1)

    native, average = rate(stream["r_frame_rate"]), rate(stream["avg_frame_rate"])
    if native[0] == 0:
        native = average
    vfr = native[0] == 0 or (average[0] > 0 and abs(native[0] / native[1] - average[0] /
                                                    average[1]) > native[0] / native[1] * 0.001)
    return {"native": native, "average": average, "vfr": vfr,
            "size": [stream["width"], stream["height"]]}


def window_path(cache: Path, window: Mapping[str, Any]) -> Path:
    return cache / "windows" / f"{window['id']}.mp4"


def media_path(cache: Path, source: Mapping[str, Any]) -> Path:
    suffix = Path(urllib.parse.urlparse(source["media_url"]).path).suffix or ".bin"
    return cache / "media" / f"{source['source_id']}{suffix}"


def fetch_window(cache: Path, window: Mapping[str, Any], source: Mapping[str, Any]) -> dict:
    """Cut one window on the document grid (H.264, at most 720 p). Returns its probe."""
    target = window_path(cache, window)
    info_file = target.with_suffix(".json")
    if target.exists() and info_file.exists():
        return json.loads(info_file.read_text(encoding="utf-8"))
    target.parent.mkdir(parents=True, exist_ok=True)
    original = "/transcoded/" not in source["media_url"]
    media = download(source["media_url"], media_path(cache, source),
                     sha1=source.get("original_sha1") if original else None)
    probe = _probe(media)
    fps = document_fps(probe["native"], vfr=probe["vfr"])
    first, end = window_grid(window["start_ms"], window["duration_ms"], fps)
    seek = f"{first * fps[1] / fps[0]:.6f}"
    partial = target.with_name(target.stem + ".part.mp4")
    command = [_tool("ffmpeg"), "-nostdin", "-v", "error", "-ss", seek, "-i", str(media),
               "-map", "0:v:0", "-map", "0:a:0?",
               "-vf", f"fps={fps[0]}/{fps[1]},scale=-2:'min({FETCH_MAX_HEIGHT},ih)'",
               "-frames:v", str(end - first), "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest",
               "-y", str(partial)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"{window['id']}: {result.stderr.strip()[-300:]}")
    os.replace(partial, target)
    info = {"id": window["id"], "fps": list(fps), "window_sf": [first, end],
            "source_probe": probe, "frames": _frame_count(target),
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    info_file.write_text(json.dumps(info, indent=1) + "\n", encoding="utf-8")
    return info


def _frame_count(path: Path) -> int:
    out = subprocess.run(
        [_tool("ffprobe"), "-v", "error", "-count_frames", "-select_streams", "v:0",
         "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=600, check=True)
    return int(out.stdout.strip().split(",")[0])


def window_info(cache: Path, window: Mapping[str, Any]) -> dict[str, Any]:
    info_file = window_path(cache, window).with_suffix(".json")
    if not info_file.exists():
        raise FileNotFoundError(f"{window['id']}: not fetched (--fetch)")
    return json.loads(info_file.read_text(encoding="utf-8"))


# --- label helpers -------------------------------------------------------------------------------


def frame_profile(path: Path) -> dict[str, list[int]]:
    """Per grid frame: the mean 64×36 grey difference to the previous frame and FFmpeg's scene
    score, both per mille (frame 0 is 0)."""
    import cv2

    capture = cv2.VideoCapture(str(path))
    diffs: list[int] = []
    previous = None
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        tiny = cv2.cvtColor(cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA),
                            cv2.COLOR_BGR2GRAY)
        diffs.append(0 if previous is None else round(cv2.absdiff(tiny, previous).mean()
                                                      / 255 * 1000))
        previous = tiny
    capture.release()
    out = subprocess.run(
        [_tool("ffmpeg"), "-nostdin", "-v", "error", "-i", str(path), "-map", "0:v:0", "-vf",
         "scale=160:-2,select='gte(scene,0)',metadata=mode=print:file=-", "-f", "null", "-"],
        capture_output=True, text=True, timeout=600, check=True)
    scores = [round(float(m) * 1000) for m in re.findall(r"lavfi\.scene_score=([0-9.]+)",
                                                          out.stdout)]
    scores = ([0] + scores)[: len(diffs)] if len(scores) < len(diffs) else scores[: len(diffs)]
    return {"diff_pm": diffs, "scene_pm": scores}


def candidates(profile: Mapping[str, Sequence[int]]) -> list[int]:
    """Local frames (window-relative) where either measure is high; one per ``CANDIDATE_GAP``."""
    diff, scene = profile["diff_pm"], profile["scene_pm"]
    strength = [max(d / (CANDIDATE_DIFF * 1000), s / (CANDIDATE_SCENE * 1000))
                for d, s in zip(diff, scene, strict=False)]
    picked: list[int] = []
    for k in range(1, len(strength)):
        if strength[k] < 1:
            continue
        if picked and k - picked[-1] <= CANDIDATE_GAP:
            if strength[k] > strength[picked[-1]]:
                picked[-1] = k
            continue
        picked.append(k)
    return picked


def contact_sheets(path: Path, info: Mapping[str, Any], out: Path, *, with_candidates: bool = True
                   ) -> dict[str, Any]:
    """``overview.png`` (one tile per second, numbered) and ``cand-N.png`` (frames k−2 … k+1 of
    up to 12 candidates per sheet, numbered with the grid frame), plus ``profile.json``."""
    import cv2
    import numpy as np

    out.mkdir(parents=True, exist_ok=True)
    profile = frame_profile(path)
    found = candidates(profile) if with_candidates else []
    fps = info["fps"]
    first = info["window_sf"][0]
    per_second = {math.floor(s * fps[0] / fps[1]) for s in range(WINDOW_MS // 1000)}
    wanted = set(per_second)
    for k in found:
        wanted.update(range(max(0, k - 2), k + 2))
    frames: dict[int, Any] = {}
    capture = cv2.VideoCapture(str(path))
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index in wanted:
            frames[index] = cv2.resize(frame, (240, 135), interpolation=cv2.INTER_AREA)
        index += 1
    capture.release()
    blank = np.zeros((135, 240, 3), dtype=np.uint8)

    def tile(k: int, text: str) -> Any:
        image = frames.get(k, blank).copy()
        cv2.rectangle(image, (0, 0), (240, 18), (0, 0, 0), -1)
        cv2.putText(image, text, (4, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1,
                    cv2.LINE_AA)
        return image

    seconds = sorted(per_second)
    rows = [np.hstack([tile(k, f"{n}s  k{k}") for n, k in enumerate(seconds[r:r + 10], r)])
            for r in range(0, len(seconds), 10)]
    cv2.imwrite(str(out / "overview.png"), np.vstack(rows))
    sheets = []
    for number, start in enumerate(range(0, len(found), 12), 1):
        block = []
        for k in found[start:start + 12]:
            block.append(np.hstack([tile(j, f"k{j} sf{first + j} d{profile['diff_pm'][j]}"
                                            f" s{profile['scene_pm'][j]}"
                                         if 0 <= j < len(profile["diff_pm"]) else "")
                                    for j in range(k - 2, k + 2)]))
        name = f"cand-{number}.png"
        cv2.imwrite(str(out / name), np.vstack(block))
        sheets.append(name)
    (out / "profile.json").write_text(json.dumps({"id": info["id"], "fps": fps,
                                                  "window_sf": info["window_sf"],
                                                  "candidates": found, **profile}) + "\n",
                                      encoding="utf-8")
    return {"candidates": len(found), "sheets": sheets}


# The page's export, kept apart so a test can run it in Node: a window the labeller did not
# mark done goes out unlabelled (null), which check_labels refuses outside a placeholder file.
EXPORT_JS = """function exportLabels(data, state) {
  return {schema: data.schema, split: data.split, labelled_by: "owner", windows: data.windows.map(w => {
    const s = state[w.id], done = Boolean(s && s.done);
    return {id: w.id, fps: w.fps, window_sf: w.window_sf,
      cuts_sf: done ? s.cuts.map(k => w.window_sf[0] + k) : null, modes: done ? s.modes : null};
  })};
}"""

_PAGE = """<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Label reframe</title>
<style>
:root{--bg:#080907;--surface:#11120f;--line:#292b25;--text:#f7f5ed;--dim:#a5a69d;--accent:#dfff58}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.45 "DM Sans",system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--dim);margin:0 0 12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
video{width:100%;background:#000;border:1px solid var(--line)}
button,select{background:var(--surface);color:var(--text);border:1px solid var(--line);
border-radius:6px;padding:6px 10px;font:inherit;min-height:36px}
button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.main{background:var(--accent);color:#080907;border-color:var(--accent)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);
padding:6px;text-align:left}code{color:var(--accent)}
</style></head><body><main>
<h1>Label reframe</h1>
<p>Pilih jendela, tandai frame pertama tiap shot baru, pilih mode tiap shot, lalu centang
Selesai. Jendela yang belum dicentang diunduh tanpa label.
Tombol: ← → 1 frame, Shift 10 frame, C tandai cut.</p>
<div class="row"><select id="pick" aria-label="Jendela"></select>
<label><input type="checkbox" id="done"> Selesai</label>
<span id="where" aria-live="polite"></span></div>
<video id="video" controls preload="auto"></video>
<div class="row"><button id="back">← 1 frame</button><button id="next">1 frame →</button>
<button id="cut" class="main">Tandai cut (C)</button></div>
<table><thead><tr><th>Shot</th><th>Mulai (sf)</th><th>Mode</th><th></th></tr></thead>
<tbody id="shots"></tbody></table>
<div class="row"><button id="save" class="main">Unduh label</button>
<span id="status" aria-live="polite"></span></div>
</main><script>
const DATA = __DATA__;
__EXPORT__
const MODES = ["camera","fill_center","fit_blur","split"];
const KEY = "reframe-labels-" + DATA.split;
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { state = {}; }
const video = document.getElementById("video"), pick = document.getElementById("pick");
let current = null;
for (const w of DATA.windows) {
  const o = document.createElement("option"); o.value = w.id; pick.append(o);
  if (!state[w.id]) state[w.id] = {cuts: [], modes: ["camera"], done: false};
}
const done = document.getElementById("done");
function names() { for (const o of pick.options) { const w = DATA.windows.find(x => x.id === o.value);
  o.textContent = (state[w.id].done ? "✓ " : "") + w.id + " · " + w.category; } }
function win() { return DATA.windows.find(w => w.id === pick.value); }
function frame() { const w = win(); return Math.floor(video.currentTime * w.fps[0] / w.fps[1] + 1e-3); }
function seek(k) { const w = win(); k = Math.max(0, Math.min(w.frames - 1, k));
  video.currentTime = (k + 0.5) * w.fps[1] / w.fps[0]; }
function keep() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
function draw() {
  const w = win(), s = state[w.id], body = document.getElementById("shots");
  body.textContent = "";
  const starts = [0, ...s.cuts];
  starts.forEach((k, i) => {
    const tr = document.createElement("tr");
    const sel = document.createElement("select"); sel.setAttribute("aria-label", "Mode shot " + (i + 1));
    for (const m of MODES) { const o = document.createElement("option"); o.value = m; o.textContent = m; sel.append(o); }
    sel.value = s.modes[i]; sel.onchange = () => { s.modes[i] = sel.value; keep(); };
    const go = document.createElement("button"); go.textContent = "Lihat"; go.onclick = () => seek(k);
    const td = (x) => { const c = document.createElement("td"); c.append(x); return c; };
    tr.append(td(String(i + 1)), td(String(w.window_sf[0] + k)), td(sel), td(go));
    if (i > 0) { const del = document.createElement("button"); del.textContent = "Hapus cut";
      del.onclick = () => { s.cuts.splice(i - 1, 1); s.modes.splice(i, 1); keep(); draw(); };
      tr.lastChild.append(" ", del); }
    body.append(tr);
  });
}
function mark() {
  const s = state[win().id], k = frame();
  if (k <= 0 || s.cuts.includes(k)) return;
  const i = s.cuts.filter(c => c < k).length;
  s.cuts.splice(i, 0, k); s.modes.splice(i + 1, 0, s.modes[i]); keep(); draw();
}
function show() { const w = win(); video.src = w.src; done.checked = Boolean(state[w.id].done); draw(); }
done.onchange = () => { state[win().id].done = done.checked; keep(); names(); };
video.addEventListener("timeupdate", () => { const w = win(), k = frame();
  document.getElementById("where").textContent = "frame " + k + " · sf " + (w.window_sf[0] + k); });
document.getElementById("back").onclick = () => seek(frame() - 1);
document.getElementById("next").onclick = () => seek(frame() + 1);
document.getElementById("cut").onclick = mark;
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === "ArrowLeft") { e.preventDefault(); seek(frame() - step); }
  if (e.key === "ArrowRight") { e.preventDefault(); seek(frame() + step); }
  if (e.key === "c" || e.key === "C") mark();
});
pick.onchange = show;
document.getElementById("save").onclick = () => {
  const out = exportLabels(DATA, state);
  const left = out.windows.filter(w => w.cuts_sf === null).length;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 1) + "\\n"], {type: "application/json"}));
  a.download = "labels." + DATA.split + ".json"; a.click();
  document.getElementById("status").textContent = left
    ? "Tersimpan ke unduhan. " + left + " jendela belum selesai." : "Tersimpan ke unduhan. Semua selesai.";
};
names(); show();
</script></body></html>
"""


def label_page(selected: Sequence[Mapping[str, Any]], split: str, cache: Path) -> str:
    """The static label page for ``selected`` registry windows (each must be fetched)."""
    windows = []
    for window in selected:
        info = window_info(cache, window)
        windows.append({"id": window["id"], "category": window["category"], "fps": info["fps"],
                        "window_sf": info["window_sf"], "frames": info["frames"],
                        "src": window_path(cache, window).resolve().as_uri()})
    data = json.dumps({"schema": LABELS_SCHEMA, "split": split, "windows": windows})
    return _PAGE.replace("__EXPORT__", EXPORT_JS).replace("__DATA__", data.replace("</", "<\\/"))


# --- measuring today's camera mode ---------------------------------------------------------------


def _scene_times(path: Path) -> list[float]:
    """Today's pipeline scene cuts (``audio_timeline._SCENE_FILTER``) on the window file."""
    from ai_clipper.audio_timeline import _FRAME_LINE, _SCENE_FILTER

    out = subprocess.run(
        [_tool("ffmpeg"), "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error", "-i",
         str(path), "-map", "0:v:0", "-vf", _SCENE_FILTER, "-f", "null", "-"],
        capture_output=True, text=True, timeout=600, check=True)
    times = []
    for line in out.stdout.splitlines():
        match = _FRAME_LINE.match(line)
        if match:
            times.append(float(match.group(1)))
    return times


def predict_today(path: Path, info: Mapping[str, Any]) -> dict[str, Any]:
    """Today's camera mode on one cached window, before any label is read: the camera plan's
    cut flags, the pipeline's scene cuts, and how long each took."""
    from ai_clipper.edit_v2.camera import build_camera_plan
    from ai_clipper.edit_v2.timemap import Fps as GridFps

    fps = tuple(info["fps"])
    first, end = info["window_sf"]
    frames = end - first
    window_ms = (0, frames * 1000 * fps[1] // fps[0])
    began = time.perf_counter()
    plan = build_camera_plan(path, window_ms, GridFps(*fps), out_w=OUTPUT[0], out_h=OUTPUT[1])
    camera_s = time.perf_counter() - began
    began = time.perf_counter()
    scene = scene_cut_sf(_scene_times(path), first_sf=first, fps=fps, frames=frames)
    scene_s = time.perf_counter() - began
    return {"id": info["id"], "fps": list(fps), "window_sf": [first, end],
            "sample_frames": round(plan["sample_ms"] * fps[0] / (1000 * fps[1])),
            "camera_plan_cuts_sf": camera_cut_sf(plan, first_sf=first, fps=fps),
            "scene_cuts_sf": scene,
            "no_face_ms": plan.get("no_face", []),
            "seconds": {"camera_plan": round(camera_s, 2), "scene_pass": round(scene_s, 2)}}


def score_today(prediction: Mapping[str, Any], label: Mapping[str, Any]) -> dict[str, Any]:
    """One window's row: cut matches within one grid frame and within one camera sample, and
    the frames that one mode everywhere (``camera``, or the default ``fit_blur``) gets right,
    and those today's camera mode gets right (``camera`` with ``no_face`` runs centred)."""
    if (list(prediction["window_sf"]) != list(label["window_sf"])
            or list(prediction["fps"]) != list(label["fps"])):
        raise LabelError(f"{label['id']}: the measured window is not the labelled one")
    first, end = label["window_sf"]
    truth = label["cuts_sf"]
    window = (first, end)
    row: dict[str, Any] = {"id": label["id"], "frames": end - first, "cuts": len(truth),
                           "seconds": dict(prediction["seconds"])}
    for name in ("camera_plan_cuts", "scene_cuts"):
        predicted = prediction[f"{name}_sf"]
        row[name] = {"found": len(predicted),
                     "frame": list(match_cuts(predicted, truth, 1)),
                     "sample": list(match_cuts(predicted, truth, prediction["sample_frames"]))}
    labelled = (truth, label["modes"])
    for mode in ("camera", "fit_blur"):
        row[f"agreement_{mode}"] = agreement(window, ([], [mode]), labelled)[0]
    row["agreement_today"] = agreement(
        window, today_modes(prediction["no_face_ms"], label["fps"], window), labelled)[0]
    row["label_frames"] = {mode: agreement(window, ([], [mode]), labelled)[0] for mode in MODES}
    return row


def summarise(rows: Sequence[Mapping[str, Any]], categories: Mapping[str, str]) -> dict:
    def scores(subset: Sequence[Mapping[str, Any]], name: str, key: str) -> dict[str, float]:
        tp, fp, fn = (sum(r[name][key][i] for r in subset) for i in range(3))
        return {**{k: round(v, 4) for k, v in cut_scores(tp, fp, fn).items()},
                "tp": tp, "fp": fp, "fn": fn}

    def per_window(subset: Sequence[Mapping[str, Any]], name: str) -> dict[str, Any]:
        """Mean precision over windows with a found cut, mean recall over windows with a
        labelled cut: one window with many cuts cannot carry the pooled score alone."""
        precision = [r[name]["frame"][0] / (r[name]["frame"][0] + r[name]["frame"][1])
                     for r in subset if r[name]["frame"][0] + r[name]["frame"][1]]
        recall = [r[name]["frame"][0] / r["cuts"] for r in subset if r["cuts"]]
        return {"precision": round(sum(precision) / len(precision), 4) if precision else None,
                "recall": round(sum(recall) / len(recall), 4) if recall else None,
                "windows_with_cuts": len(recall)}

    def block(subset: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        frames = sum(r["frames"] for r in subset)
        cuts = sum(r["cuts"] for r in subset)
        top = max(subset, key=lambda r: r["cuts"], default=None)
        return {
            "windows": len(subset), "cuts": cuts,
            "most_cuts": {"id": top["id"], "cuts": top["cuts"],
                          "share": round(top["cuts"] / cuts, 4)} if top and cuts else None,
            "camera_plan_cuts": scores(subset, "camera_plan_cuts", "frame"),
            "camera_plan_cuts_within_sample": scores(subset, "camera_plan_cuts", "sample"),
            "camera_plan_cuts_per_window": per_window(subset, "camera_plan_cuts"),
            "scene_cuts": scores(subset, "scene_cuts", "frame"),
            "scene_cuts_within_sample": scores(subset, "scene_cuts", "sample"),
            "scene_cuts_per_window": per_window(subset, "scene_cuts"),
            "agreement_today": round(sum(r["agreement_today"] for r in subset) / frames, 4)
            if frames else None,
            "agreement_camera": round(sum(r["agreement_camera"] for r in subset) / frames, 4)
            if frames else None,
            "agreement_fit_blur": round(sum(r["agreement_fit_blur"] for r in subset) / frames, 4)
            if frames else None,
            "label_mode_share": {m: round(sum(r["label_frames"][m] for r in subset) / frames, 4)
                                 for m in MODES} if frames else {},
            "camera_plan_seconds": {
                "max": max((r["seconds"]["camera_plan"] for r in subset), default=None),
                "mean": round(sum(r["seconds"]["camera_plan"] for r in subset) / len(subset), 2)
                if subset else None},
        }

    out = {"all": block(rows)}
    for category in CATEGORIES:
        subset = [r for r in rows if categories.get(r["id"]) == category]
        if subset:
            out[category] = block(subset)
    return out


def predict_split(registry: Mapping[str, Any], split: str, cache: Path) -> dict[str, Any]:
    import cv2

    rows = []
    for window in split_windows(registry, split):
        info = window_info(cache, window)
        row = predict_today(window_path(cache, window), info)
        rows.append(row)
        print(f"{row['id']:<8} camera-plan cuts {len(row['camera_plan_cuts_sf']):>3}  scene cuts "
              f"{len(row['scene_cuts_sf']):>3}  {row['seconds']['camera_plan']} s", flush=True)
    return {"schema": PREDICTION_SCHEMA, "method": "today_camera", "split": split,
            "opencv": cv2.__version__, "python": sys.version.split()[0], "windows": rows}


def score_split(registry: Mapping[str, Any], split: str, predictions: Mapping[str, Any]
                ) -> dict[str, Any]:
    labels = json.loads((LABEL_DIR / f"labels.{split}.json").read_text(encoding="utf-8"))
    check_labels(labels, registry, split)
    if predictions.get("schema") != PREDICTION_SCHEMA or predictions.get("split") != split:
        raise LabelError(f"not {split} predictions ({PREDICTION_SCHEMA})")
    measured = {row["id"]: row for row in predictions["windows"]}
    categories = {w["id"]: w["category"] for w in split_windows(registry, split)}
    rows = []
    for entry in labels["windows"]:
        if entry["id"] not in measured:
            raise LabelError(f"{entry['id']}: no prediction")
        rows.append(score_today(measured[entry["id"]], entry))
    return {"schema": RESULT_SCHEMA, "method": predictions["method"], "split": split,
            "opencv": predictions["opencv"], "python": predictions["python"], "gates": GATES,
            "summary": summarise(rows, categories), "windows": rows}


# --- the shot detector of RF-M1: profiles and the sweep ------------------------------------------


def _scan_json(scan: Any) -> dict[str, Any]:
    return {"times": list(scan.times), "width": scan.width, "height": scan.height,
            "frame_diff": list(scan.frame_diff),
            "samples": [{"cut": bool(sample.cut),
                         "faces": [[f.x, f.y, f.w, f.h, f.activity] for f in sample.faces]}
                        for sample in scan.samples]}


def scan_from_json(value: Mapping[str, Any]) -> Any:
    from ai_clipper.face_window import Scan
    from ai_clipper.speaker_track import Face, Sample

    samples = [Sample(time=t, cut=bool(item["cut"]),
                      faces=tuple(Face(*face[:4], activity=face[4]) for face in item["faces"]))
               for t, item in zip(value["times"], value["samples"], strict=True)]
    return Scan(times=list(value["times"]), samples=samples, width=value["width"],
                height=value["height"], frame_diff=list(value["frame_diff"]))


def coarse_cuts_ms(scan: Any) -> list[int]:
    """The camera plan's cut flags (scene changes and far speaker switches) of a scan, in ms
    from the window start: the detector's extra candidates."""
    from ai_clipper.edit_v2.clip_id import ms_from_seconds
    from ai_clipper.speaker_track import choose_faces

    _faces, switches = choose_faces(scan.samples, width=scan.width)
    return [ms_from_seconds(float(sample.time))
            for sample, switch in zip(scan.samples, switches, strict=True)
            if sample.cut or switch]


def profile_window(path: Path, info: Mapping[str, Any], *, timeout_s: float = 600.0
                   ) -> dict[str, Any]:
    """What every rule configuration needs from one cached window, before any label is read."""
    from ai_clipper import shot_context
    from ai_clipper.edit_v2 import shot_cuts
    from ai_clipper.edit_v2.timemap import Fps as GridFps

    fps = tuple(info["fps"])
    first, end = info["window_sf"]
    window_ms = (0, (end - first) * 1000 * fps[1] // fps[0])
    began = time.perf_counter()
    profile = shot_cuts.measure(path, window_ms, GridFps(*fps), timeout_s=timeout_s)
    measure_s = time.perf_counter() - began
    began = time.perf_counter()
    scan = shot_context.scan_evidence(path, window_ms)
    scan_s = time.perf_counter() - began
    return {"id": info["id"], "fps": list(fps), "window_sf": [first, end],
            "window_ms": list(window_ms), "profile": profile.to_json(), "scan": _scan_json(scan),
            "coarse_cuts_ms": coarse_cuts_ms(scan),
            "seconds": {"shot_cuts_measure": round(measure_s, 2),
                        "evidence_scan": round(scan_s, 2)}}


def profile_split(registry: Mapping[str, Any], split: str, cache: Path,
                  only: Sequence[str] | None = None) -> dict[str, Any]:
    import cv2

    rows = []
    for window in split_windows(registry, split):
        if only and window["id"] not in only:
            continue
        info = window_info(cache, window)
        row = profile_window(window_path(cache, window), info)
        rows.append(row)
        print(f"{row['id']:<8} measure {row['seconds']['shot_cuts_measure']} s  scan "
              f"{row['seconds']['evidence_scan']} s", flush=True)
    return {"schema": PROFILE_SCHEMA, "split": split, "opencv": cv2.__version__,
            "python": sys.version.split()[0], "windows": rows}


def _detect_row(row: Mapping[str, Any], rules: Any, cache: dict) -> list[int]:
    """The detector's cuts of one profiled window, as absolute grid frames."""
    from ai_clipper.edit_v2 import shot_cuts
    from ai_clipper.edit_v2.timemap import Fps as GridFps

    profile = cache.get(("profile", row["id"]))
    if profile is None:
        profile = shot_cuts.Profile.from_json(row["profile"])
        cache[("profile", row["id"])] = profile
    local = shot_cuts.detect(profile, GridFps(*row["fps"]), rules=rules,
                             coarse_cuts_ms=row["coarse_cuts_ms"])
    return [row["window_sf"][0] + k for k in local]


def _context(row: Mapping[str, Any], cache: dict) -> Any:
    from ai_clipper import shot_context
    from ai_clipper.edit_v2.timemap import Fps as GridFps

    key = ("context", row["id"])
    if key not in cache:
        cache[key] = shot_context.Context.of(scan_from_json(row["scan"]),
                                             window_ms=tuple(row["window_ms"]),
                                             fps=GridFps(*row["fps"]))
    return cache[key]


def predict_modes(row: Mapping[str, Any], cuts: Sequence[int], rules: Any, cache: dict
                  ) -> list[str]:
    """The decided mode of every shot of a profiled window cut at ``cuts`` (absolute)."""
    from ai_clipper.edit_v2 import AUTO_SPLIT
    from ai_clipper.edit_v2.shots import crop_width_pm, plan_shots, shot_bounds

    first, end = row["window_sf"]
    local_cuts = [c - first for c in cuts]
    window = (0, end - first)
    context = _context(row, cache)
    key = ("evidence", row["id"], tuple(local_cuts), rules.speakers_active_pm)
    if key not in cache:
        bounds = shot_bounds(local_cuts, window)
        cache[key] = ([context.summarize(b, rules=rules) for b in bounds],
                      context.summarize(window, rules=rules))
    evidences, whole = cache[key]
    crop = crop_width_pm((context.width, context.height), OUTPUT)
    planned = plan_shots(local_cuts, window, evidences, crop_w_pm=crop, rules=rules,
                         split_enabled=AUTO_SPLIT, whole=whole)
    return [shot.mode for shot in planned]


def _cut_row(config: Mapping[str, int], profiles: Sequence[Mapping[str, Any]],
             labels: Mapping[str, Mapping[str, Any]], base: Any, cache: dict
             ) -> dict[str, Any]:
    rules = base.with_values(config)
    tp = fp = fn = 0
    found = {}
    for row in profiles:
        cuts = _detect_row(row, rules, cache)
        found[row["id"]] = cuts
        a, b, c = match_cuts(cuts, labels[row["id"]]["cuts_sf"], 1)
        tp, fp, fn = tp + a, fp + b, fn + c
    return {"config": dict(config), **cut_scores(tp, fp, fn), "tp": tp, "fp": fp, "fn": fn,
            "cuts": found}


def _mode_row(config: Mapping[str, int], profiles: Sequence[Mapping[str, Any]],
              labels: Mapping[str, Mapping[str, Any]], cuts: Mapping[str, Sequence[int]],
              base: Any, cache: dict) -> dict[str, Any]:
    rules = base.with_values(config)
    same = frames = non_camera = 0
    for row in profiles:
        label = labels[row["id"]]
        window = tuple(row["window_sf"])
        modes = predict_modes(row, cuts[row["id"]], rules, cache)
        a, b = agreement(window, (cuts[row["id"]], modes), (label["cuts_sf"], label["modes"]))
        same, frames = same + a, frames + b
        non_camera += b - agreement(window, (cuts[row["id"]], modes), ([], ["camera"]))[0]
    return {"config": dict(config), "agreement": same / frames if frames else 0.0,
            "non_camera_frames": non_camera}


def _mode_configs() -> Iterator[dict[str, int]]:
    keys = [key for key in SWEEP_GRID if not key.startswith("cut.")]
    for values in product(*(SWEEP_GRID[key] for key in keys)):
        yield dict(zip(keys, values, strict=True))


def _window_rows(rows: Sequence[Mapping[str, Any]], by_id: Mapping[str, Mapping[str, Any]],
                 cuts: Mapping[str, Sequence[int]], rules: Any, categories: Mapping[str, str],
                 cache: dict) -> list[dict[str, Any]]:
    out = []
    for row in rows:
        label = by_id[row["id"]]
        found = list(cuts[row["id"]])
        window = tuple(row["window_sf"])
        modes = predict_modes(row, found, rules, cache)
        same, frames = agreement(window, (found, modes), (label["cuts_sf"], label["modes"]))
        budget = scan_budget_s(len(found))
        out.append({"id": row["id"], "category": categories.get(row["id"]), "frames": frames,
                    "cuts": len(label["cuts_sf"]), "found": len(found),
                    "match": list(match_cuts(found, label["cuts_sf"], 1)),
                    "agreement_frames": same, "seconds": dict(row["seconds"]),
                    "scan_budget_s": budget,
                    "scan_within_budget": row["seconds"]["shot_cuts_measure"] <= budget})
    return out


def _block(subset: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    tp, fp, fn = (sum(w["match"][i] for w in subset) for i in range(3))
    frames = sum(w["frames"] for w in subset)
    return {"windows": len(subset), **{k: round(v, 4) for k, v in cut_scores(tp, fp, fn).items()},
            "tp": tp, "fp": fp, "fn": fn,
            "agreement": round(sum(w["agreement_frames"] for w in subset) / frames, 4)
            if frames else None}


def sweep(profiles: Mapping[str, Any], labels: Mapping[str, Any], registry: Mapping[str, Any]
          ) -> dict[str, Any]:
    """Both stages of the sweep on profiled windows (``docs/evaluation/AUTO_REFRAME.md``). When
    no cut configuration meets both floors, stage 2 runs on the best F1 and ``cut.gate_met`` is
    false: the result is reported, never a looser floor."""
    from ai_clipper.edit_v2.shots import load_rules

    split = profiles.get("split")
    if profiles.get("schema") != PROFILE_SCHEMA or split != "dev":
        raise LabelError(f"the sweep runs on dev profiles ({PROFILE_SCHEMA})")
    check_labels(labels, registry, split)
    by_id = {entry["id"]: entry for entry in labels["windows"]}
    rows = profiles["windows"]
    if sorted(row["id"] for row in rows) != sorted(by_id):
        raise LabelError("the profiles must cover every labelled dev window once")
    for row in rows:
        if list(by_id[row["id"]]["window_sf"]) != list(row["window_sf"]):
            raise LabelError(f"{row['id']}: the profiled window is not the labelled one")
    base = load_rules(RULES_PATH)
    cache: dict = {}
    stage1 = [_cut_row(config, rows, by_id, base, cache) for config in configs("cut.")]
    chosen_cut = pick_cut_config(stage1)
    gate_met = chosen_cut is not None
    if chosen_cut is None:
        best = max(stage1, key=lambda r: (round(r["f1"], 9), r["config"]["cut.min_gap_ms"],
                                          r["config"]["cut.coarse_scene_pm"]))
        chosen_cut = dict(best["config"])
    cut_choice = next(r for r in stage1 if r["config"] == chosen_cut)
    cuts = cut_choice["cuts"]
    stage2 = [_mode_row({**chosen_cut, **config}, rows, by_id, cuts, base, cache)
              for config in _mode_configs()]
    chosen = pick_mode_config(stage2)
    assert chosen is not None
    mode_choice = next(r for r in stage2 if r["config"] == chosen)
    rules = base.with_values(chosen)
    categories = {w["id"]: w["category"] for w in split_windows(registry, split)}
    windows = _window_rows(rows, by_id, cuts, rules, categories, cache)
    return {
        "schema": SWEEP_SCHEMA, "split": split, "opencv": profiles.get("opencv"),
        "python": profiles.get("python"), "gates": GATES, "chosen": chosen,
        "rules_id": rules.rules_id,
        "cut": {"gate_met": gate_met, **{key: cut_choice[key] for key in
                                         ("precision", "recall", "f1", "tp", "fp", "fn")}},
        "mode": {"agreement": mode_choice["agreement"],
                 "non_camera_frames": mode_choice["non_camera_frames"]},
        "scan": {"windows_within_budget": sum(w["scan_within_budget"] for w in windows),
                 "windows": len(windows),
                 "max_measure_s": max((w["seconds"]["shot_cuts_measure"] for w in windows),
                                      default=None)},
        "by_category": {category: _block([w for w in windows if w["category"] == category])
                        for category in CATEGORIES
                        if any(w["category"] == category for w in windows)},
        "stage1": [{key: value for key, value in row.items() if key != "cuts"}
                   for row in stage1],
        "stage2_top": sorted(stage2, key=lambda r: (-round(r["agreement"], 9),
                                                    r["non_camera_frames"]))[:25],
        "windows": windows,
    }


def write_rules(chosen: Mapping[str, int], path: Path = RULES_PATH) -> str:
    """Write the chosen sweep values into the rules file; returns the new ``rules_id``."""
    from ai_clipper.edit_v2.shots import load_rules

    expected = load_rules(path).with_values(chosen).rules_id
    value = json.loads(path.read_text(encoding="utf-8"))
    for key, number in chosen.items():
        group, name = key.split(".")
        value[group][name] = number
    groups = [group for group in value if group != "schema"]
    lines = ["{", f'  "schema": {json.dumps(value["schema"])},']
    for index, group in enumerate(groups):
        comma = "," if index < len(groups) - 1 else ""
        lines.append(f'  "{group}": {json.dumps(value[group], separators=(", ", ": "))}{comma}')
    path.write_text("\n".join([*lines, "}"]) + "\n", encoding="utf-8")
    if load_rules(path).rules_id != expected:
        raise RuntimeError("the written rules are not the chosen ones")
    return expected


# --- command line --------------------------------------------------------------------------------


def _sources(registry: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {s["source_id"]: s for s in registry["sources"] if "source_id" in s}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--fetch", action="store_true", help="cut the windows into the cache")
    action.add_argument("--sheets", action="store_true", help="contact sheets for labelling")
    action.add_argument("--label", action="store_true", help="write the static label page")
    action.add_argument("--sweep", action="store_true",
                        help="sweep the rules on --profiles output (RF-M1/RF-M4)")
    action.add_argument("--profile", action="store_true",
                        help="measure what the sweep needs, without reading labels")
    action.add_argument("--timing", action="store_true", help="scan time per window")
    action.add_argument("--predict", action="store_true",
                        help="measure today's camera mode without reading labels")
    action.add_argument("--score", type=Path, metavar="PREDICTIONS",
                        help="score saved --predict output against the labels")
    parser.add_argument("--split", choices=("dev", "test", "all"), required=True)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--profiles", type=Path, help="--sweep: saved --profile output")
    parser.add_argument("--write-rules", action="store_true",
                        help="--sweep: write the chosen values to resources/reframe/rules.v1.json")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--registry", type=Path, default=REGISTRY)
    parser.add_argument("--only", action="append", help="window ids (repeatable)")
    parser.add_argument("--overview-only", action="store_true",
                        help="--sheets: one tile per second, no candidate sheets")
    parser.add_argument("--confirm-once", action="store_true",
                        help="the single test-split run of RF-M4")
    args = parser.parse_args(argv)
    if args.cache is None and not (args.sweep or args.score is not None):
        parser.error("--cache is needed")
    registry = json.loads(args.registry.read_text(encoding="utf-8"))
    check_registry(registry)
    windows = [w for w in split_windows(registry, args.split)
               if not args.only or w["id"] in args.only]
    sources = _sources(registry)

    if args.fetch:
        failed = 0
        for window in windows:
            try:
                cached = window_path(args.cache, window).with_suffix(".json").exists()
                info = fetch_window(args.cache, window, sources[window["source_id"]])
                media_path(args.cache, sources[window["source_id"]]).unlink(missing_ok=True)
                if not cached:
                    time.sleep(FETCH_PAUSE_S)
                print(f"{window['id']}: {info['frames']} frames at {info['fps']}", flush=True)
            except (RuntimeError, subprocess.SubprocessError, KeyError, ValueError) as exc:
                failed += 1
                print(f"{window['id']}: failed: {exc}", flush=True)
        return 1 if failed else 0
    if args.sheets:
        if args.out is None:
            parser.error("--sheets needs --out")
        summary = {}
        for window in windows:
            try:
                info = window_info(args.cache, window)
            except FileNotFoundError as exc:
                print(f"{window['id']}: skipped: {exc}", flush=True)
                continue
            summary[window["id"]] = {"category": window["category"], **contact_sheets(
                window_path(args.cache, window), info, args.out / window["id"],
                with_candidates=not args.overview_only)}
            print(f"{window['id']}: {summary[window['id']]}", flush=True)
        (args.out / "sheets.json").write_text(json.dumps(summary, indent=1) + "\n",
                                              encoding="utf-8")
        return 0
    if args.label:
        if args.out is None or args.split == "all":
            parser.error("--label needs --out and one split")
        args.out.write_text(label_page(windows, args.split, args.cache), encoding="utf-8")
        print(f"{args.out}")
        return 0
    if args.split == "test":
        try:
            check_test_lock(TEST_LOCK, confirm=args.confirm_once)
        except TestSplitLocked as exc:
            print(exc, file=sys.stderr)
            return 2
    if args.split == "test":
        print("the test split's single run is wired up in RF-M4", file=sys.stderr)
        return 2
    if args.sweep:
        if args.split != "dev" or args.profiles is None:
            parser.error("--sweep runs on the dev split and needs --profiles")
        labels = json.loads((LABEL_DIR / "labels.dev.json").read_text(encoding="utf-8"))
        result = sweep(json.loads(args.profiles.read_text(encoding="utf-8")), labels, registry)
        print(json.dumps({key: result[key] for key in ("chosen", "cut", "mode", "scan")},
                         indent=1))
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        if args.write_rules:
            print(f"rules_id {write_rules(result['chosen'])}")
        return 0
    if args.profile:
        if args.split == "all" or args.out is None:
            parser.error("--profile needs one split and --out")
        profiles = profile_split(registry, args.split, args.cache, args.only)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(profiles) + "\n", encoding="utf-8")
        return 0
    if args.split == "all":
        parser.error("measure one split")
    if args.timing:
        for window in windows:
            info = window_info(args.cache, window)
            from ai_clipper.edit_v2.camera import build_camera_plan
            from ai_clipper.edit_v2.timemap import Fps as GridFps

            fps = info["fps"]
            frames = info["window_sf"][1] - info["window_sf"][0]
            began = time.perf_counter()
            build_camera_plan(window_path(args.cache, window), (0, frames * 1000 * fps[1] // fps[0]),
                              GridFps(*fps), out_w=OUTPUT[0], out_h=OUTPUT[1])
            print(f"{window['id']}: camera plan {time.perf_counter() - began:.2f} s", flush=True)
        return 0
    if args.predict:
        predictions = predict_split(registry, args.split, args.cache)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(predictions, indent=1) + "\n", encoding="utf-8")
        return 0
    if args.score is not None:
        predictions = json.loads(args.score.read_text(encoding="utf-8"))
    else:
        predictions = predict_split(registry, args.split, args.cache)
    result = score_split(registry, args.split, predictions)
    print(json.dumps(result["summary"]["all"], indent=1))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
