"""The face-track scan of one clip window: faces, mouth motion and scene cuts per sample.

The window is decoded once, front to back. Every ``sample_interval`` (0.75 s) the frame the old
per-sample seek would land on (OpenCV's rounding, ``int(seconds·fps + 0.5)``) is a sample:

* its scene-cut flag compares a 64×36 grey thumbnail with the previous sample's (unchanged);
* YuNet (``face_model``) finds its faces;
* until the next sample, about 15 frames a second are cut around each face's mouth, and the
  mouth motion between consecutive frames is averaged into the face's ``activity``. When the
  picture changes like a cut before the next sample, the rest of the interval is not measured.

:func:`detect_window` then lets ``speaker_track.choose`` pick the speaking face per sample and
returns ``(times, centres, cuts, source_w, source_h)``: the shape ``face_tracking`` and the
camera plan use, with a speaker switch that jumps across the frame flagged as a cut, so the crop
cuts to the other person instead of panning. ``progress(done, total)`` is reported per sample.

A source whose frame rate OpenCV cannot read is sampled by seeking; it gets no mouth motion and
the largest face is framed. OpenCV's own pool is held at one thread while any scan runs (the
auto render scans several clips at once, T4.3), which also keeps YuNet's results independent of
the CPU count.

Like ``face_tracking``, OpenCV is imported lazily (the ``vision`` extra); the Editor V3 package
itself stays stdlib-only.
"""

from __future__ import annotations

import math
import os
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .speaker_track import RULES, Face, Rules, Sample, choose_faces

THUMBNAIL = (64, 36)
CUT_CHANGE = 0.18  # mean thumbnail difference (share of 255) that counts as a scene cut
MOTION_RATE = 15.0  # mouth frames per second between samples


def sample_times(start: float, end: float, interval: float) -> list[float]:
    """The sample times of the window (seconds from ``start``, the float accumulation the
    detector always used)."""
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


@dataclass(frozen=True, slots=True)
class Scan:
    """What :func:`scan_window` measured: sample times (seconds from the window start), one
    :class:`speaker_track.Sample` per time, and the source size."""

    times: list[float]
    samples: list[Sample]
    width: int
    height: int


class _Interval:
    """The faces of one sample and their mouth motion until the next sample."""

    def __init__(self, cv2: Any, face_model: Any, frame: Any, detections: Sequence[Any]) -> None:
        self._cv2 = cv2
        self._model = face_model
        self.detections = list(detections)
        self._regions = [face_model.mouth_region(face) for face in self.detections]
        self._patches = [None if region is None else face_model.mouth_patch(cv2, frame, region)
                         for region in self._regions]
        self._sums = [0.0] * len(self.detections)
        self._counts = [0] * len(self.detections)
        self._thumbnail = self._small(frame)
        self._shot_changed = False

    def _small(self, frame: Any) -> Any:
        cv2 = self._cv2
        tiny = cv2.resize(frame, THUMBNAIL, interpolation=cv2.INTER_LINEAR)
        return cv2.cvtColor(tiny, cv2.COLOR_BGR2GRAY)

    def add(self, frame: Any) -> None:
        """A frame between this sample and the next. After a cut-like change the faces are no
        longer where the sample found them, so the rest of the interval is not measured."""
        if not self.detections or self._shot_changed:
            return
        cv2 = self._cv2
        thumbnail = self._small(frame)
        if cv2.absdiff(thumbnail, self._thumbnail).mean() / 255 >= CUT_CHANGE:
            self._shot_changed = True
            return
        self._thumbnail = thumbnail
        for index, region in enumerate(self._regions):
            if region is None:
                continue
            patch = self._model.mouth_patch(cv2, frame, region)
            previous = self._patches[index]
            if patch is not None and previous is not None:
                self._sums[index] += self._model.mouth_motion(cv2, previous, patch)
                self._counts[index] += 1
            self._patches[index] = patch

    def faces(self) -> tuple[Face, ...]:
        return tuple(Face(face.x, face.y, face.w, face.h,
                          self._sums[index] / self._counts[index] if self._counts[index] else None)
                     for index, face in enumerate(self.detections))


def scan_window(
    source: Path,
    *,
    start: float,
    end: float,
    sample_interval: float = 0.75,
    progress: Callable[[int, int], None] | None = None,
) -> Scan:
    """Faces, mouth motion and cut flags over ``[start, end)`` (seconds). Raises
    ``RuntimeError`` when OpenCV cannot read the source or the face model is missing.
    ``progress(done, total)`` is called with ``(0, total)`` first and then once per sample as
    its interval ends, in order."""
    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - exercised without optional extra
        raise RuntimeError(
            "face-track mode requires the vision extra: uv sync --extra vision"
        ) from exc
    from . import face_model

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
        samples: list[Sample] = []
        report(0, total)
        with one_opencv_thread(cv2):
            detector = face_model.YuNet(cv2, source_width, source_height)
            previous_thumbnail = None
            interval: _Interval | None = None
            current = -1  # index of the frame last grabbed in sequential mode
            exhausted = False
            stride = max(1, round(fps / MOTION_RATE)) if sequential else 0
            stop = int(end * fps + 0.5) if sequential else 0  # the first frame after the window
            if sequential:
                capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000)
            anchor = 0  # the frame index of the open interval's sample

            def advance(target: int) -> None:
                """Grab up to ``target``, feeding the open interval its mouth frames."""
                nonlocal current, exhausted
                while not exhausted and current < target:
                    if not capture.grab():
                        exhausted = True
                        break
                    current = round(capture.get(cv2.CAP_PROP_POS_FRAMES)) - 1
                    if (interval is not None and anchor < current < target
                            and (current - anchor) % stride == 0):
                        ok, frame = capture.retrieve()
                        if ok:
                            interval.add(frame)

            def close(index: int, cut: bool) -> None:
                nonlocal interval
                faces = () if interval is None else interval.faces()
                samples.append(Sample(time=times[index], cut=cut, faces=faces))
                interval = None
                report(len(samples), total)

            open_cut = False
            for index, relative_time in enumerate(times):
                ok, frame = False, None
                if sequential:
                    seconds = ((start + relative_time) * 1000) / 1000.0
                    target = int(seconds * fps + 0.5)  # where CAP_PROP_POS_MSEC would land
                    advance(target)
                    if index > 0:
                        close(index - 1, open_cut)
                    if not exhausted and current >= target:
                        ok, frame = capture.retrieve()
                        anchor = current
                else:
                    if index > 0:
                        close(index - 1, open_cut)
                    capture.set(cv2.CAP_PROP_POS_MSEC, (start + relative_time) * 1000)
                    ok, frame = capture.read()
                open_cut = False
                if ok:
                    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                    thumbnail = cv2.resize(gray, THUMBNAIL)
                    if previous_thumbnail is not None:
                        change = cv2.absdiff(thumbnail, previous_thumbnail).mean() / 255
                        open_cut = bool(change >= CUT_CHANGE)
                    previous_thumbnail = thumbnail
                    interval = _Interval(cv2, face_model, frame, detector.detect(frame))
            if sequential and interval is not None:
                last = int((start + times[-1] + sample_interval) * fps + 0.5)
                advance(min(last, stop))
            if times:
                close(len(times) - 1, open_cut)
    finally:
        capture.release()
    return Scan(times=times, samples=samples, width=source_width, height=source_height)


def detect_window(
    source: Path,
    *,
    start: float,
    end: float,
    sample_interval: float = 0.75,
    progress: Callable[[int, int], None] | None = None,
    rules: Rules = RULES,
    boxes: bool = False,
) -> tuple:
    """The speaking face over ``[start, end)`` (seconds): ``(times, raw centres, cuts,
    source_w, source_h)`` with ``None`` where no face was found. See the module docstring.

    With ``boxes=True`` a sixth value follows: the framed face per sample as ``(x, y, w, h)``
    shares of the source frame (``None`` without a face), for the caption check
    (CONTRACTS §5.48)."""
    scan = scan_window(source, start=start, end=end, sample_interval=sample_interval,
                       progress=progress)
    faces, switches = choose_faces(scan.samples, width=scan.width, rules=rules)
    centres = [None if face is None else min(max(face.centre / scan.width, 0.0), 1.0)
               for face in faces]
    cuts = [sample.cut or switch for sample, switch in zip(scan.samples, switches, strict=True)]
    if not boxes:
        return scan.times, centres, cuts, scan.width, scan.height
    shares = [None if face is None else (face.x / scan.width, face.y / scan.height,
                                         face.w / scan.width, face.h / scan.height)
              for face in faces]
    return scan.times, centres, cuts, scan.width, scan.height, shares


__all__ = ["MOTION_RATE", "Scan", "cpu_budget", "detect_window", "one_opencv_thread",
           "sample_times", "scan_window"]
