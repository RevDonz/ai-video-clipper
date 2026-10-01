"""Today's face detection over a whole clip window, reporting its progress per sample.

The Editor V3 camera plan (``edit_v2.camera``, plan §5.7; T3.6) samples a clip window every
0.75 s. :func:`detect_window` returns exactly what ``face_tracking.detect_face_track(…,
smooth=False, sequential=True)`` returns (same cascade, parameters, sampled frames, equalisation
and cut flags; 0 of 1,202 samples differ on the five real sources), and adds:

* ``progress(done, total)`` after every sample, for the editor's analysis progress;
* the Haar work on up to four worker threads, each with its own ``CascadeClassifier`` (one
  classifier shared by threads returns wrong boxes), while the main thread decodes;
* OpenCV's own pool held at one thread during the run (restored after the last of several
  overlapping runs ends: the auto render plans several clips at once, T4.3), and equal-area
  faces chosen by position (the leftmost, then the topmost) instead of by OpenCV's detection
  order, so the result does not depend on the CPU count.

The work is CPU-bound either way: a 3 min window of the 1280×720 AV1 source costs ~40 CPU-s of
Haar (~160 ms per sample) and ~9 CPU-s of decoding, about 13 s at 4 CPUs with either detector.

Like ``face_tracking``, OpenCV is imported lazily (the ``vision`` extra); the Editor V3 package
itself stays stdlib-only.
"""

from __future__ import annotations

import math
import os
import threading
from collections import deque
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .face_tracking import choose_prominent_face

DETECT_WORKERS_MAX = 4
# face_tracking.detect_face_track's detection and cut constants (kept identical).
SCALE_FACTOR = 1.1
MIN_NEIGHBORS = 4
MIN_FACE_SHARE = 0.08
MIN_FACE_PX = 24
THUMBNAIL = (64, 36)
CUT_CHANGE = 0.18
CASCADE_FILE = "haarcascade_frontalface_default.xml"


def sample_times(start: float, end: float, interval: float) -> list[float]:
    """The sample times of ``face_tracking.detect_face_track`` (its float accumulation)."""
    times: list[float] = []
    relative = 0.0
    while relative < end - start:
        times.append(relative)
        relative += interval
    return times


def cpu_budget() -> int:
    """The CPUs this process may use: its affinity, capped by a cgroup CPU quota."""
    try:
        count = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        count = os.cpu_count() or 1
    quotas = (("/sys/fs/cgroup/cpu.max", None),
              ("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "/sys/fs/cgroup/cpu/cpu.cfs_period_us"))
    for quota_file, period_file in quotas:
        try:
            if period_file is None:
                quota, period = Path(quota_file).read_text(encoding="ascii").split()[:2]
            else:
                quota = Path(quota_file).read_text(encoding="ascii").strip()
                period = Path(period_file).read_text(encoding="ascii").strip()
        except (OSError, ValueError):
            continue
        try:
            if quota not in ("max", "-1") and int(period) > 0 and int(quota) > 0:
                count = min(count, max(1, math.ceil(int(quota) / int(period))))
        except ValueError:
            pass
        break
    return max(1, count)


_threads_lock = threading.Lock()
_threads_holds = 0
_threads_before = 1


@contextmanager
def one_opencv_thread(cv2: Any) -> Iterator[None]:
    """OpenCV's own pool at one thread while any window runs: the first run to start saves the
    count, the last one to end restores it (runs of several clips overlap)."""
    global _threads_holds, _threads_before
    with _threads_lock:
        if _threads_holds == 0:
            _threads_before = cv2.getNumThreads()
            cv2.setNumThreads(1)
        _threads_holds += 1
    try:
        yield
    finally:
        with _threads_lock:
            _threads_holds -= 1
            if _threads_holds == 0:
                cv2.setNumThreads(_threads_before)


def _silent(_done: int, _total: int) -> None:
    return None


def detect_window(
    source: Path,
    *,
    start: float,
    end: float,
    sample_interval: float = 0.75,
    progress: Callable[[int, int], None] | None = None,
    workers: int | None = None,
) -> tuple[list[float], list[float | None], list[bool], int, int]:
    """Faces over ``[start, end)`` (seconds): ``(times, raw centres, cuts, source_w, source_h)``
    as ``face_tracking.detect_face_track(…, smooth=False, sequential=True)`` returns them,
    except that equal-area faces are chosen by position (see the module docstring).

    ``workers`` defaults to the CPU budget, at most ``DETECT_WORKERS_MAX``. ``progress(done,
    total)`` is called from this thread with ``(0, total)`` first and then once per sample as
    the samples finish, in order. Raises ``RuntimeError`` when OpenCV cannot read the source.
    """
    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - exercised without optional extra
        raise RuntimeError(
            "face-track mode requires the vision extra: uv sync --extra vision"
        ) from exc
    if workers is None:
        workers = min(DETECT_WORKERS_MAX, cpu_budget())
    if type(workers) is not int or workers < 1:
        raise ValueError("workers must be a positive integer")
    report = _silent if progress is None else progress

    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open source video: {source}")
    try:
        source_width = round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if source_width <= 0 or source_height <= 0:
            raise RuntimeError("OpenCV could not determine source dimensions")
        fps = capture.get(cv2.CAP_PROP_FPS)
        sequential = fps > 0
        times = sample_times(start, end, sample_interval)
        total = len(times)
        minimum_face = max(round(min(source_width, source_height) * MIN_FACE_SHARE), MIN_FACE_PX)
        cascade_file = str(Path(cv2.data.haarcascades) / CASCADE_FILE)
        local = threading.local()

        def detect(gray: Any) -> float | None:
            cascade = getattr(local, "cascade", None)
            if cascade is None:
                cascade = local.cascade = cv2.CascadeClassifier(cascade_file)
            equalized = cv2.equalizeHist(gray)
            faces = cascade.detectMultiScale(equalized, scaleFactor=SCALE_FACTOR,
                                             minNeighbors=MIN_NEIGHBORS,
                                             minSize=(minimum_face, minimum_face))
            if not len(faces):
                return None
            ordered = sorted(tuple(int(value) for value in face) for face in faces)
            return choose_prominent_face(ordered, source_width=source_width)

        centres: list[float | None] = [None] * total
        cuts: list[bool] = [False] * total
        pending: deque[tuple[int, Future | None]] = deque()
        finished = 0

        def collect(limit: int) -> None:
            nonlocal finished
            while len(pending) > limit:
                index, future = pending.popleft()
                if future is not None:
                    centres[index] = future.result()
                finished += 1
                report(finished, total)

        report(0, total)
        with one_opencv_thread(cv2), ThreadPoolExecutor(
                max_workers=workers, thread_name_prefix="face-window") as pool:
            previous_thumbnail = None
            current = -1  # index of the frame last grabbed in sequential mode
            exhausted = False
            if sequential:
                capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
            for index, relative_time in enumerate(times):
                ok, frame = False, None
                if sequential:
                    seconds = ((start + relative_time) * 1000) / 1000.0
                    target = int(seconds * fps + 0.5)  # where CAP_PROP_POS_MSEC would land
                    while not exhausted and current < target:
                        if not capture.grab():
                            exhausted = True
                            break
                        current = round(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1
                    if not exhausted and current >= target:
                        ok, frame = capture.retrieve()
                else:
                    capture.set(cv2.CAP_PROP_POS_MSEC, (start + relative_time) * 1000)
                    ok, frame = capture.read()
                future = None
                if ok:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    thumbnail = cv2.resize(gray, THUMBNAIL)
                    if previous_thumbnail is not None:
                        change = cv2.absdiff(thumbnail, previous_thumbnail).mean() / 255
                        cuts[index] = bool(change >= CUT_CHANGE)
                    previous_thumbnail = thumbnail
                    future = pool.submit(detect, gray)
                pending.append((index, future))
                collect(2 * workers)  # bounds the frames held in memory
            collect(0)
    finally:
        capture.release()
    return times, centres, cuts, source_width, source_height


__all__ = ["DETECT_WORKERS_MAX", "cpu_budget", "detect_window", "one_opencv_thread",
           "sample_times"]
