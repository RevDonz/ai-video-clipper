#!/usr/bin/env python3
"""Speaker-framing evaluation: how often the face-track crop misses the person speaking.

The set is a list of 20 s windows of films annotated by AVA ActiveSpeaker v1.0 (Google, CC BY 4.0:
a box per visible face, ~25 times a second, labelled SPEAKING_AUDIBLE or not). The footage is not
committed: ``fetch`` downloads each window from the dataset's public mirror into a cache outside
the repository, and the annotations are read from the dataset's own archive (sha256-pinned).

The measure is the share of speech time (0.1 s steps where at least one visible face is labelled
speaking) in which the 9:16 crop (720×1280, the auto render's size) contains the centre of no
speaking face. Both detectors go through the camera plan's path: raw centres, the smoothing of
``face_tracking.smooth_face_track``, crop x per frame from ``layouts.crop_positions``.

* ``haar``: the detector before YuNet, frozen here (Haar cascade every 0.75 s, the largest face,
  four worker threads), so the comparison stays reproducible after it left ``src``;
* ``largest``: YuNet faces, the largest face (``speaker_track`` without mouth motion);
* ``speaker``: ``face_window.detect_window``, today's detector.

Two kinds of window per film: ``multi`` (the 20 s with the most time showing two or more faces
while someone speaks) and ``single`` (the most time showing one face that speaks). The gates are
fixed before a run (``GATES``) and printed with the numbers. Commands, from the repository root::

    uv run python scripts/eval/speaker_framing.py select --split val --cache DIR --out SET.json
    uv run python scripts/eval/speaker_framing.py fetch --set SET.json --cache DIR [--jobs 3]
    nice -n 10 uv run python scripts/eval/speaker_framing.py run --set SET.json --cache DIR \\
        --out RESULT.json [--limit N]
    nice -n 10 uv run python scripts/eval/speaker_framing.py time --source VIDEO [--window 180]

``fetch`` and ``select`` need the network; ``run`` and ``time`` only read the cache and the
source. The documentation and the last results are in ``docs/evaluation/SPEAKER_FRAMING.md``.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
from collections import deque
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ai_clipper import face_window
from ai_clipper.edit_v2.layouts import crop_positions, scaled_size
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.face_tracking import smooth_face_track
from ai_clipper.speaker_track import Face, Sample, choose

SET_SCHEMA = "potongin.speaker-framing-set/1"
RESULT_SCHEMA = "potongin.speaker-framing-result/1"
ANNOTATIONS = {
    "val": ("https://research.google.com/ava/download/ava_activespeaker_val_v1.0.tar.bz2",
            "ced431ed2006deacd3968954d309c5b780179866b0f63d5d17d4df8a8ec81622"),
    "train": ("https://research.google.com/ava/download/ava_activespeaker_train_v1.0.tar.bz2",
              "528594517178b2d04ab28914d35c95c3e2bdca5c46e7af359921968bef60c3d5"),
}
FILE_NAMES = ("https://s3.amazonaws.com/ava-dataset/annotations/ava_file_names_trainval_v2.1.txt",
              "3cc1cd1262ce727ef367c692a5505ee643bcf32dc930be90d663514fb52bbec2")
VIDEO_URL = "https://s3.amazonaws.com/ava-dataset/trainval/{file}"
LICENCE = "AVA ActiveSpeaker v1.0 annotations: Google, CC BY 4.0. Films: not redistributed."

STEPS_PER_SECOND = 10
WINDOW_STEPS = 200  # 20 s
WINDOW_STRIDE = 10  # 1 s
MIN_STEPS = 100  # a window must show its kind for at least half its time
OUTPUT = (720, 1280)
SPEAKING = "SPEAKING_AUDIBLE"
PAN = 0.1  # a move of the smoothed centre this large between samples, without a cut, is a pan
GATES = {
    "multi_relative": 0.8,  # speaker error on multi windows at most 0.8 × the Haar error ...
    "multi_ci_upper": 0.0,  # ... and the bootstrap 97.5th percentile of (new − Haar) below 0
    "single_tolerance": 0.01,  # single windows: at most 1 point above the Haar error
    "clip_ratio": 3,  # windows better by > 10 points at least 3 × those worse by > 10 points
    "clip_points": 0.10,
}
BOOTSTRAP = 2000
# Otomatis (rombak 04 §A9, RF-M4): the speaker error of the multi set, counted on the steps
# Otomatis frames with the camera, at most 1 point above today's 20.7 %. Set before the run.
AUTO_CAMERA_MULTI_MAX = 0.217


# --- downloads ---------------------------------------------------------------------------------


def _download(url: str, target: Path, sha256: str) -> Path:
    """``url`` into ``target`` once, checked against ``sha256``."""
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == sha256:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, partial.open("wb") as out:
        shutil.copyfileobj(response, out)
    digest = hashlib.sha256(partial.read_bytes()).hexdigest()
    if digest != sha256:
        partial.unlink()
        raise RuntimeError(f"{url}: sha256 {digest} is not the pinned {sha256}")
    os.replace(partial, target)
    return target


def annotations_archive(cache: Path, split: str) -> Path:
    url, sha256 = ANNOTATIONS[split]
    return _download(url, cache / "annotations" / f"{split}.tar.bz2", sha256)


def read_annotations(archive: Path) -> dict[str, dict[int, dict[str, tuple]]]:
    """``{video: {step: {entity: (x1, y1, x2, y2, speaking)}}}``, steps of 0.1 s of film time."""
    videos: dict[str, dict[int, dict[str, tuple]]] = {}
    with tarfile.open(archive, "r:bz2") as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith("-activespeaker.csv"):
                continue
            stream = tar.extractfile(member)
            if stream is None:
                continue
            steps: dict[int, dict[str, tuple]] = {}
            for row in csv.reader(io.TextIOWrapper(stream, encoding="utf-8")):
                _video, t, x1, y1, x2, y2, label, entity = row[:8]
                step = round(float(t) * STEPS_PER_SECOND)
                steps.setdefault(step, {})[entity] = (float(x1), float(y1), float(x2),
                                                      float(y2), label == SPEAKING)
            videos[Path(member.name).name[: -len("-activespeaker.csv")]] = steps
    return videos


def _best_window(steps: dict[int, dict[str, tuple]], wanted: Callable[[dict], bool],
                 avoid: tuple[int, int] | None) -> tuple[int, int] | None:
    """``(first step, count)`` of the 20 s window with the most wanted steps, if enough."""
    first, last = min(steps), max(steps)
    best = None
    for start in range(first, last - WINDOW_STEPS + 1, WINDOW_STRIDE):
        if avoid is not None and start < avoid[1] and avoid[0] < start + WINDOW_STEPS:
            continue
        count = sum(1 for k in range(start, start + WINDOW_STEPS) if wanted(steps.get(k, {})))
        if best is None or count > best[1]:
            best = (start, count)
    return best if best is not None and best[1] >= MIN_STEPS else None


def _multi(faces: dict) -> bool:
    return len(faces) >= 2 and any(face[4] for face in faces.values())


def _single(faces: dict) -> bool:
    return len(faces) == 1 and next(iter(faces.values()))[4]


def select(split: str, cache: Path) -> dict[str, Any]:
    """The set: per film a ``multi`` window and a ``single`` window that does not overlap it."""
    archive = annotations_archive(cache, split)
    names_file = _download(FILE_NAMES[0], cache / "annotations" / "file-names.txt", FILE_NAMES[1])
    names = {line.split(".")[0]: line.strip()
             for line in names_file.read_text(encoding="utf-8").split() if line.strip()}
    clips = []
    for video, steps in sorted(read_annotations(archive).items()):
        if video not in names:
            continue  # not on the public mirror
        multi = _best_window(steps, _multi, None)
        span = None if multi is None else (multi[0], multi[0] + WINDOW_STEPS)
        single = _best_window(steps, _single, span)
        for kind, window in (("multi", multi), ("single", single)):
            if window is not None:
                clips.append({"id": f"{video}-{kind}", "kind": kind, "video": video,
                              "file": names[video], "start": window[0] / STEPS_PER_SECOND,
                              "duration": WINDOW_STEPS / STEPS_PER_SECOND, "steps": window[1]})
    url, sha256 = ANNOTATIONS[split]
    return {"schema": SET_SCHEMA, "split": split, "licence": LICENCE,
            "annotations": {"url": url, "sha256": sha256}, "clips": clips}


def clip_path(cache: Path, clip: dict[str, Any]) -> Path:
    return cache / "clips" / f"{clip['video']}_{clip['start']:.1f}.mp4"


def fetch_clip(cache: Path, clip: dict[str, Any]) -> str:
    """Download one window (re-encoded to H.264 so that every frame of it is exact)."""
    target = clip_path(cache, clip)
    if target.exists():
        return "cached"
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.stem + ".part.mp4")
    command = ["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{clip['start']:.3f}",
               "-i", VIDEO_URL.format(file=clip["file"]), "-t", f"{clip['duration']:.3f}",
               "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-y",
               str(partial)]
    if shutil.which("nice"):
        command = ["nice", "-n", "10", *command]
    result = subprocess.run(command, capture_output=True, text=True, timeout=1800, check=False)
    if result.returncode != 0:
        partial.unlink(missing_ok=True)
        return f"failed: {result.stderr.strip()[-200:]}"
    os.replace(partial, target)
    return "downloaded"


# --- the frozen baseline -----------------------------------------------------------------------


def haar_window(source: Path, *, start: float, end: float, sample_interval: float = 0.75,
                workers: int | None = None) -> tuple[list[float], list[float | None],
                                                     list[bool], int, int]:
    """The face-track detector before YuNet (``face_window.detect_window`` until 2026-10):
    the Haar frontal-face cascade on the equalised grey frame (scale 1.1, 4 neighbours, faces
    at least 8 % of the short side and 24 px), the largest face (equal areas: leftmost), the
    same sample frames and cut flags, the cascade work on up to four threads."""
    import cv2

    if workers is None:
        workers = min(4, face_window.cpu_budget())
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open source video: {source}")
    try:
        width = round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = capture.get(cv2.CAP_PROP_FPS)
        if width <= 0 or height <= 0 or fps <= 0:
            raise RuntimeError("OpenCV could not read the size and frame rate")
        times = face_window.sample_times(start, end, sample_interval)
        minimum = max(round(min(width, height) * 0.08), 24)
        cascade_file = str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")
        local = threading.local()

        def detect(gray: Any) -> float | None:
            cascade = getattr(local, "cascade", None)
            if cascade is None:
                cascade = local.cascade = cv2.CascadeClassifier(cascade_file)
            faces = cascade.detectMultiScale(cv2.equalizeHist(gray), scaleFactor=1.1,
                                             minNeighbors=4, minSize=(minimum, minimum))
            if not len(faces):
                return None
            ordered = sorted(tuple(int(value) for value in face) for face in faces)
            x, _y, w, _h = max(ordered, key=lambda face: face[2] * face[3])
            return (x + w / 2) / width

        centres: list[float | None] = [None] * len(times)
        cuts = [False] * len(times)
        pending: deque[tuple[int, Future | None]] = deque()
        with face_window.one_opencv_thread(cv2), ThreadPoolExecutor(max_workers=workers) as pool:
            previous = None
            current = -1
            exhausted = False
            capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
            for index, relative in enumerate(times):
                target = int((start + relative) * fps + 0.5)
                ok, frame = False, None
                while not exhausted and current < target:
                    if not capture.grab():
                        exhausted = True
                        break
                    current = round(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1
                if not exhausted and current >= target:
                    ok, frame = capture.retrieve()
                future = None
                if ok:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    thumbnail = cv2.resize(gray, face_window.THUMBNAIL)
                    if previous is not None:
                        change = cv2.absdiff(thumbnail, previous).mean() / 255
                        cuts[index] = bool(change >= face_window.CUT_CHANGE)
                    previous = thumbnail
                    future = pool.submit(detect, gray)
                pending.append((index, future))
                while len(pending) > 2 * workers:
                    done, job = pending.popleft()
                    centres[done] = None if job is None else job.result()
            while pending:
                done, job = pending.popleft()
                centres[done] = None if job is None else job.result()
    finally:
        capture.release()
    return times, centres, cuts, width, height


# --- measuring ---------------------------------------------------------------------------------


def ground_truth(steps: dict[int, dict[str, tuple]], clip: dict[str, Any]) -> list[list[float]]:
    """Per 0.1 s step of the window: the x centres (share of the width) of the speaking faces."""
    first = round(clip["start"] * STEPS_PER_SECOND)
    count = round(clip["duration"] * STEPS_PER_SECOND)
    return [[(face[0] + face[2]) / 2 for face in steps.get(first + k, {}).values() if face[4]]
            for k in range(count)]


def misses(truth: Sequence[Sequence[float]], times: Sequence[float],
           centres: Sequence[float | None], cuts: Sequence[bool], size: tuple[int, int],
           *, only: Sequence[bool] | None = None) -> tuple[int, int]:
    """``(missed, speech)`` steps for a raw track, framed as the camera plan frames it. With
    ``only``, just the steps it marks count (Otomatis: the steps of ``camera`` shots)."""
    smoothed = smooth_face_track(list(centres), cuts=list(cuts))
    plan = {"samples": [[round(t * 1000), round(c * 1000)] for t, c in zip(times, smoothed,
                                                                         strict=True)],
            "cuts": list(cuts)}
    scaled = scaled_size(size, OUTPUT)[0]
    xs = crop_positions(plan, Fps(STEPS_PER_SECOND, 1), source=size, output=OUTPUT, first_sf=0,
                        count=len(truth))
    missed = speech = 0
    marks = [True] * len(truth) if only is None else list(only)
    if len(marks) != len(truth):
        raise ValueError("one mark per step")
    for speakers, x, counted in zip(truth, xs, marks, strict=True):
        if not speakers or not counted:
            continue
        speech += 1
        low, high = x / scaled, (x + OUTPUT[0]) / scaled
        if not any(low <= centre <= high for centre in speakers):
            missed += 1
    return missed, speech


def movement(centres: Sequence[float | None], cuts: Sequence[bool]) -> tuple[int, int]:
    """``(cuts that are speaker switches or scene cuts, pans)`` of a track."""
    smoothed = smooth_face_track(list(centres), cuts=list(cuts))
    pans = sum(1 for index in range(1, len(smoothed))
               if not cuts[index] and abs(smoothed[index] - smoothed[index - 1]) >= PAN)
    return sum(1 for flag in cuts[1:] if flag), pans


def camera_steps(ranges: Sequence[dict[str, Any]], fps: Sequence[int], *, count: int
                 ) -> list[bool]:
    """Per 0.1 s step from the window start: whether Otomatis frames it with the camera (the
    range holding the step's first grid frame is ``camera``)."""
    from ai_clipper.edit_v2 import timemap

    grid = Fps(*fps)
    edges = [(int(r["in_sf"]), int(r["out_sf"]), r["mode"]) for r in ranges]
    out = []
    for k in range(count):
        sf = timemap.sf_floor(k * 1000 // STEPS_PER_SECOND, grid)
        out.append(any(a <= sf < b and mode == "camera" for a, b, mode in edges))
    return out


def _document_fps(path: Path) -> tuple[int, int]:
    """The document frame rate of a source (``edit_v2.seed.output_fps`` of its probed rate)."""
    from ai_clipper.edit_v2.seed import output_fps

    out = subprocess.run(
        [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=120, check=True)
    num, _slash, den = out.stdout.strip().split(",")[0].partition("/")
    fps = output_fps({"fps_native": (int(num), int(den or 1)), "vfr": False})
    return fps.num, fps.den


def auto_camera(path: Path, duration: float) -> tuple[list[dict[str, Any]], tuple[int, int]]:
    """The shot ranges Otomatis plans for the window (``shots.prepare_auto`` with the
    committed rules) and the document frame rate they are on."""
    from ai_clipper.edit_v2 import shots

    fps = _document_fps(path)
    _camera, plan = shots.prepare_auto(path, (0, round(duration * 1000)), Fps(*fps),
                                       output=OUTPUT)
    first = plan["shots"][0]["in_sf"] if plan["shots"] else 0
    ranges = [{"in_sf": s["in_sf"] - first, "out_sf": s["out_sf"] - first, "mode": s["mode"]}
              for s in plan["shots"]]
    return ranges, fps


def measure(path: Path, truth: list[list[float]], duration: float, *, auto: bool = False
            ) -> dict[str, Any]:
    began = time.perf_counter()
    haar = haar_window(path, start=0.0, end=duration)
    haar_s = time.perf_counter() - began
    began = time.perf_counter()
    scan = face_window.scan_window(path, start=0.0, end=duration)
    centres, switches = choose(scan.samples, width=scan.width)
    speaker_s = time.perf_counter() - began
    speaker_cuts = [s.cut or w for s, w in zip(scan.samples, switches, strict=True)]
    still = [Sample(s.time, s.cut, tuple(Face(f.x, f.y, f.w, f.h) for f in s.faces))
             for s in scan.samples]
    largest, _ = choose(still, width=scan.width)
    size = (scan.width, scan.height)
    result: dict[str, Any] = {"size": list(size), "seconds": {"haar": round(haar_s, 3),
                                                              "speaker": round(speaker_s, 3)}}
    tracks = {"haar": (haar[0], haar[1], haar[2]),
              "largest": (scan.times, largest, [s.cut for s in scan.samples]),
              "speaker": (scan.times, centres, speaker_cuts)}
    for name, (times, track, cuts) in tracks.items():
        missed, speech = misses(truth, times, track, cuts, size)
        jumps, pans = movement(track, cuts)
        result[name] = {"missed": missed, "speech": speech, "cuts": jumps, "pans": pans,
                        "framed": sum(1 for c in track if c is not None)}
    result["samples"] = len(scan.times)
    if auto:
        ranges, fps = auto_camera(path, duration)
        only = camera_steps(ranges, fps, count=len(truth))
        missed, speech = misses(truth, scan.times, centres, speaker_cuts, size, only=only)
        result["auto_camera"] = {"missed": missed, "speech": speech,
                                 "camera_steps": sum(only), "steps": len(only),
                                 "modes": sorted({r["mode"] for r in ranges})}
    return result


def _error(rows: Sequence[dict], method: str) -> float | None:
    speech = sum(row[method]["speech"] for row in rows)
    return None if not speech else sum(row[method]["missed"] for row in rows) / speech


def _bootstrap(rows: Sequence[dict], seed: int = 20261021) -> tuple[float, float] | None:
    """2.5th and 97.5th percentiles of (speaker error − Haar error) over resampled windows."""
    if not rows:
        return None
    rng = random.Random(seed)
    values = []
    for _ in range(BOOTSTRAP):
        sample = [rows[rng.randrange(len(rows))] for _ in rows]
        speech = sum(row["haar"]["speech"] for row in sample)
        if speech:
            values.append((sum(row["speaker"]["missed"] for row in sample)
                           - sum(row["haar"]["missed"] for row in sample)) / speech)
    values.sort()
    return (values[int(0.025 * len(values))], values[int(0.975 * len(values)) - 1])


def summarise(rows: Sequence[dict]) -> dict[str, Any]:
    kinds: dict[str, Any] = {}
    for kind in ("multi", "single"):
        subset = [row for row in rows if row["kind"] == kind]
        minutes = sum(row["duration"] for row in subset) / 60
        kinds[kind] = {
            "windows": len(subset),
            "error": {m: _error(subset, m) for m in ("haar", "largest", "speaker")},
            "cuts_per_min": {m: (sum(row[m]["cuts"] for row in subset) / minutes
                                 if minutes else None) for m in ("haar", "speaker")},
            "pans_per_min": {m: (sum(row[m]["pans"] for row in subset) / minutes
                                 if minutes else None) for m in ("haar", "speaker")},
            "bootstrap_95": _bootstrap(subset),
        }
    points = GATES["clip_points"]

    def rate(row: dict, method: str) -> float:
        return row[method]["missed"] / row[method]["speech"] if row[method]["speech"] else 0.0

    better = [row["id"] for row in rows if rate(row, "haar") - rate(row, "speaker") > points]
    worse = [row["id"] for row in rows if rate(row, "speaker") - rate(row, "haar") > points]
    seconds = {m: sum(row["seconds"][m] for row in rows) for m in ("haar", "speaker")}
    multi, single = kinds["multi"], kinds["single"]
    checks = {}
    if multi["windows"]:
        checks["multi_relative"] = (multi["error"]["speaker"]
                                    <= GATES["multi_relative"] * multi["error"]["haar"])
        checks["multi_ci_upper"] = multi["bootstrap_95"][1] < GATES["multi_ci_upper"]
    if single["windows"]:
        checks["single_tolerance"] = (single["error"]["speaker"]
                                      <= single["error"]["haar"] + GATES["single_tolerance"])
    checks["clip_ratio"] = len(better) >= GATES["clip_ratio"] * len(worse)
    checks["time"] = seconds["speaker"] <= seconds["haar"]
    out = {"kinds": kinds, "better_windows": better, "worse_windows": worse,
           "seconds": {m: round(v, 2) for m, v in seconds.items()}, "gates": GATES,
           "checks": checks, "pass": bool(checks) and all(checks.values())}
    measured = [row for row in rows if row["kind"] == "multi" and "auto_camera" in row]
    if measured:
        error = _error(measured, "auto_camera")
        out["auto_reframe"] = {
            "windows": len(measured), "multi_error": error, "max": AUTO_CAMERA_MULTI_MAX,
            "camera_share": sum(r["auto_camera"]["camera_steps"] for r in measured)
            / max(1, sum(r["auto_camera"]["steps"] for r in measured)),
            "pass": error is not None and error <= AUTO_CAMERA_MULTI_MAX}
    return out


def run(set_file: Path, cache: Path, *, limit: int | None, kinds: Sequence[str],
        auto: bool = False) -> dict:
    document = json.loads(set_file.read_text(encoding="utf-8"))
    archive = annotations_archive(cache, document["split"])
    annotations = read_annotations(archive)
    rows = []
    skipped = []
    clips = [clip for clip in document["clips"] if clip["kind"] in kinds]
    for clip in clips[:limit]:
        path = clip_path(cache, clip)
        if not path.exists():
            skipped.append(clip["id"])
            continue
        truth = ground_truth(annotations[clip["video"]], clip)
        row = {"id": clip["id"], "kind": clip["kind"], "duration": clip["duration"],
               **measure(path, truth, clip["duration"], auto=auto)}
        rows.append(row)
        print(f"{clip['id']:<24} haar {row['haar']['missed']:>3} largest "
              f"{row['largest']['missed']:>3} speaker {row['speaker']['missed']:>3} "
              f"/ {row['speaker']['speech']:>3}  {row['seconds']['haar']:.1f} s / "
              f"{row['seconds']['speaker']:.1f} s", flush=True)
    import cv2

    return {"schema": RESULT_SCHEMA, "set": set_file.name, "split": document["split"],
            "opencv": cv2.__version__, "python": sys.version.split()[0],
            "output": list(OUTPUT), "skipped": skipped, "summary": summarise(rows),
            "windows": rows}


def timing(source: Path, *, window: float, start: float | None) -> dict[str, Any]:
    """Both detectors over one window of a local source (the camera plan's budget is 15 s for
    3 min on 4 CPUs)."""
    import cv2

    capture = cv2.VideoCapture(str(source))
    frames = capture.get(cv2.CAP_PROP_FRAME_COUNT)
    fps = capture.get(cv2.CAP_PROP_FPS)
    size = (round(capture.get(cv2.CAP_PROP_FRAME_WIDTH)),
            round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    capture.release()
    duration = frames / fps if fps > 0 else window
    if start is None:
        start = max(0.0, duration / 2 - window / 2)
    end = min(duration, start + window)
    result: dict[str, Any] = {"size": list(size), "fps": round(fps, 3), "window_s": [start, end],
                              "cpu_budget": face_window.cpu_budget()}
    for name, detector in (("haar", haar_window), ("speaker", face_window.detect_window)):
        began, cpu = time.perf_counter(), time.process_time()
        times, centres, *_rest = detector(source, start=start, end=end)
        result[name] = {"seconds": round(time.perf_counter() - began, 2),
                        "cpu_seconds": round(time.process_time() - cpu, 2),
                        "samples": len(times),
                        "framed": sum(1 for c in centres if c is not None)}
    result["pass"] = result["speaker"]["seconds"] <= 15.0 and (
        result["speaker"]["seconds"] <= result["haar"]["seconds"])
    return result


def _print_summary(summary: dict[str, Any]) -> None:
    for kind, data in summary["kinds"].items():
        if not data["windows"]:
            continue
        errors = ", ".join(f"{m} {v:.1%}" for m, v in data["error"].items() if v is not None)
        print(f"{kind}: {data['windows']} windows; error {errors}; bootstrap 95% of "
              f"(speaker − haar) {data['bootstrap_95']}")
    print(f"windows better by > 10 points: {len(summary['better_windows'])}, worse: "
          f"{len(summary['worse_windows'])} {summary['worse_windows']}")
    print(f"seconds: {summary['seconds']}; checks: {summary['checks']}; pass: {summary['pass']}")
    if "auto_reframe" in summary:
        print(f"otomatis camera frames, multi: {summary['auto_reframe']}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    pick = commands.add_parser("select")
    pick.add_argument("--split", choices=sorted(ANNOTATIONS), default="val")
    pick.add_argument("--cache", type=Path, required=True)
    pick.add_argument("--out", type=Path, required=True)
    get = commands.add_parser("fetch")
    get.add_argument("--set", type=Path, required=True)
    get.add_argument("--cache", type=Path, required=True)
    get.add_argument("--jobs", type=int, default=3)
    go = commands.add_parser("run")
    go.add_argument("--set", type=Path, required=True)
    go.add_argument("--cache", type=Path, required=True)
    go.add_argument("--out", type=Path)
    go.add_argument("--limit", type=int)
    go.add_argument("--kind", action="append", choices=("multi", "single"))
    go.add_argument("--auto", action="store_true",
                    help="also plan Otomatis per window and count its camera frames (RF-M4)")
    clock = commands.add_parser("time")
    clock.add_argument("--source", type=Path, required=True)
    clock.add_argument("--window", type=float, default=180.0)
    clock.add_argument("--start", type=float)
    clock.add_argument("--out", type=Path)
    args = parser.parse_args(argv)

    if args.command == "select":
        document = select(args.split, args.cache)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
        print(f"{len(document['clips'])} windows → {args.out}")
        return 0
    if args.command == "fetch":
        document = json.loads(args.set.read_text(encoding="utf-8"))
        annotations_archive(args.cache, document["split"])
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = {clip["id"]: pool.submit(fetch_clip, args.cache, clip)
                       for clip in document["clips"]}
            failed = 0
            for clip_id, future in futures.items():
                status = future.result()
                failed += status.startswith("failed")
                print(f"{clip_id}: {status}", flush=True)
        return 1 if failed else 0
    if args.command == "run":
        result = run(args.set, args.cache, limit=args.limit, kinds=args.kind or ("multi", "single"),
                     auto=args.auto)
        _print_summary(result["summary"])
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
        auto = result["summary"].get("auto_reframe", {"pass": True})
        return 0 if result["summary"]["pass"] and auto["pass"] else 1
    result = timing(args.source, window=args.window, start=args.start)
    print(json.dumps(result, indent=1))
    if args.out:
        args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
