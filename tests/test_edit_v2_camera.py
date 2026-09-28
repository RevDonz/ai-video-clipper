"""The face-track camera plan over the whole clip window (plan §5.7, CONTRACTS.md §5.7).

A detector samples the window every 0.75 s and returns raw normalised face centres (``None``
where no face was found); the plan stores the smoothed track of ``face_tracking`` as integer
per-mille centres at absolute source milliseconds, the cut flags, and every run without a
detection longer than 1.5 s as a ``no_face`` span. The detector is stubbed: deterministic and
fast (the real one needs OpenCV and is measured by the gate script).
"""

from __future__ import annotations

import hashlib
import inspect
import json
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar

import pytest

from ai_clipper.edit_v2 import camera
from ai_clipper.edit_v2.camera import (
    NO_FACE_MIN_MS,
    SAMPLE_MS,
    build_camera_plan,
    camera_file_name,
    encode_camera_plan,
)
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.face_tracking import detect_face_track, smooth_face_track

RAW = [0.30, 0.31, None, None, None, None, 0.70, None, 0.72, 0.9, None, None, None]
CUTS = [False] * 6 + [True] + [False] * 6
KEYS = {"schema", "source_content_sha256", "window_ms", "fps", "source", "output", "sample_ms",
        "samples", "cuts", "no_face"}


class StubDetector:
    """Raw centres cycling through ``RAW``; records its calls."""

    def __init__(self, raw=RAW, cuts=CUTS):
        self.raw, self.cuts, self.calls = raw, cuts, []

    def __call__(self, source, *, start, end, sample_interval=0.75):
        self.calls.append((source, start, end, sample_interval))
        times = []
        t = 0.0
        while t < end - start:
            times.append(t)
            t += sample_interval
        n = len(times)
        raw = [self.raw[i % len(self.raw)] for i in range(n)]
        cuts = [self.cuts[i % len(self.cuts)] for i in range(n)]
        return times, raw, cuts, 1280, 720


def _half_up(value):
    return int((Decimal(repr(value)) * 1000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


@pytest.fixture
def source(tmp_path):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"not really a video, the detector is stubbed" * 100)
    return path


def test_plan_from_a_stubbed_detector(source):
    stub = StubDetector()
    plan = build_camera_plan(source, (10_000, 19_750), Fps(30000, 1001), out_w=720, out_h=1280,
                             detector=stub)
    assert set(plan) == KEYS
    assert plan["schema"] == "potongin.camera-plan/1"
    assert plan["source_content_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert plan["window_ms"] == [10_000, 19_750]
    assert plan["fps"] == [30000, 1001]
    assert plan["source"] == {"w": 1280, "h": 720}
    assert plan["output"] == {"w": 720, "h": 1280}
    assert plan["sample_ms"] == SAMPLE_MS == 750
    assert stub.calls == [(source, 10.0, 19.75, 0.75)]
    smoothed = smooth_face_track(RAW, cuts=CUTS)
    assert plan["samples"] == [[10_000 + 750 * i, _half_up(value)]
                               for i, value in enumerate(smoothed)]
    assert plan["cuts"] == CUTS
    # Samples 2–5 have no face: 1500–4500 ms after the window start (3000 ms > 1500 ms). The
    # single miss at sample 7 (750 ms) is not listed; the run 10–12 reaches the window end.
    assert plan["no_face"] == [[11_500, 14_500], [17_500, 19_750]]
    assert NO_FACE_MIN_MS == 1500


def test_a_run_of_exactly_one_and_a_half_seconds_is_not_listed(source):
    stub = StubDetector(raw=[0.5, None, None, 0.5], cuts=[False] * 4)
    plan = build_camera_plan(source, (0, 3000), Fps(25, 1), out_w=720, out_h=1280, detector=stub)
    assert plan["no_face"] == []
    stub = StubDetector(raw=[0.5, None, None, None], cuts=[False] * 4)
    plan = build_camera_plan(source, (0, 3000), Fps(25, 1), out_w=720, out_h=1280, detector=stub)
    assert plan["no_face"] == [[750, 3000]]


def test_plan_is_deterministic_and_canonical(source):
    first = build_camera_plan(source, (0, 30_000), Fps(25, 1), out_w=720, out_h=1280,
                              detector=StubDetector())
    second = build_camera_plan(source, (0, 30_000), Fps(25, 1), out_w=720, out_h=1280,
                               detector=StubDetector())
    raw = encode_camera_plan(first)
    assert raw == encode_camera_plan(second)
    assert raw == json.dumps(first, sort_keys=True, separators=(",", ":"),
                             ensure_ascii=False).encode()
    assert camera_file_name(raw) == f"camera.{hashlib.sha256(raw).hexdigest()[:16]}.json"
    assert all(isinstance(value, int) for sample in first["samples"] for value in sample)


def test_a_detector_that_can_skip_smoothing_is_asked_for_raw_centres(source):
    seen = {}

    def detector(source, *, start, end, sample_interval=0.75, smooth=True):
        seen["smooth"] = smooth
        return [0.0, 0.75, 1.5], [None, 0.4, 0.6], [False, False, False], 640, 360

    plan = build_camera_plan(source, (0, 2000), Fps(25, 1), out_w=720, out_h=1280,
                             detector=detector)
    assert seen == {"smooth": False}
    assert plan["samples"] == [[t, _half_up(c)] for t, c in zip(
        (0, 750, 1500), smooth_face_track([None, 0.4, 0.6], cuts=[False] * 3))]


def test_a_detector_that_can_decode_sequentially_is_asked_to(source):
    seen = {}

    def detector(source, *, start, end, sample_interval=0.75, smooth=True, sequential=False):
        seen.update(smooth=smooth, sequential=sequential)
        return [0.0, 0.75], [0.5, 0.5], [False, False], 640, 360

    build_camera_plan(source, (0, 1500), Fps(25, 1), out_w=720, out_h=1280, detector=detector)
    assert seen == {"smooth": False, "sequential": True}


def counting_capture(real):
    """A stand-in for ``cv2.VideoCapture`` that wraps ``real`` and counts the seeks."""

    class Capture:
        seeks = 0

        def __init__(self, *args):
            self._inner = real(*args)

        def set(self, prop, value):
            type(self).seeks += 1
            return self._inner.set(prop, value)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    return Capture


def test_todays_detector_decodes_the_window_once_in_sequential_mode(tmp_path, edit_v2_ffmpeg,
                                                                     monkeypatch):
    """W1 verifier: a 3 min window of a long-GOP AV1 720p source took 16.35 s (budget 15 s),
    most of it one seek per 0.75 s sample. The camera plan decodes the window once and keeps
    the frame at each sample time; the legacy render keeps its per-sample seeks."""
    cv2 = pytest.importorskip("cv2")
    from support import edit_v2_media as media

    from ai_clipper import face_tracking

    path = media.make_barcode_video(
        tmp_path / "cuts.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=150, scene_cut_every=20,
                        gop=250, audio=None),
    )

    Capture = counting_capture(cv2.VideoCapture)
    monkeypatch.setattr(cv2, "VideoCapture", Capture)
    sequential = face_tracking.detect_face_track(path, start=0.4, end=5.4, smooth=False,
                                                 sequential=True)
    assert Capture.seeks == 1
    Capture.seeks = 0
    seeking = face_tracking.detect_face_track(path, start=0.4, end=5.4, smooth=False)
    assert Capture.seeks == len(seeking[0]) == 7
    assert sequential == seeking  # same sample times, cut flags (scene cuts), no faces, size
    assert any(seeking[2])


def test_the_default_detector_is_todays_face_tracker():
    default = inspect.signature(build_camera_plan).parameters["detector"].default
    assert default is detect_face_track
    assert camera.detect_face_track is detect_face_track


class BoolLike:
    """Stands in for ``numpy.bool_``, which today's detector returns as cut flags."""

    def __init__(self, value):
        self.value = value

    def __bool__(self):
        return self.value

    def __eq__(self, other):
        return self.value == other

    __hash__ = None


def test_bool_like_cut_flags_are_accepted(source):
    def detector(source, *, start, end, sample_interval=0.75):
        return [0.0, 0.75], [0.5, 0.5], [BoolLike(False), BoolLike(True)], 640, 360

    plan = build_camera_plan(source, (0, 1500), Fps(25, 1), out_w=720, out_h=1280,
                             detector=detector)
    assert plan["cuts"] == [False, True]
    assert all(type(flag) is bool for flag in plan["cuts"])


def test_todays_detector_runs_over_a_synthetic_window(tmp_path, edit_v2_ffmpeg):
    pytest.importorskip("cv2")
    from support import edit_v2_media as media

    path = media.make_barcode_video(
        tmp_path / "faceless.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=100, audio=None),
    )
    plan = build_camera_plan(path, (0, 4000), Fps(25, 1), out_w=720, out_h=1280)
    assert [t for t, _centre in plan["samples"]] == [0, 750, 1500, 2250, 3000, 3750]
    assert plan["source"] == {"w": 320, "h": 180}
    assert all(centre == 500 for _t, centre in plan["samples"])  # no face: centred
    # today's detector returns raw centres (smooth=False, W1 integration), so the faceless
    # window is reported instead of a silent centre (plan §5.7)
    assert plan["no_face"] == [[0, 4000]]


@pytest.mark.parametrize(
    "result",
    [
        ([0.0, 0.75], [0.5], [False, False], 1280, 720),  # lengths differ
        ([0.0, 0.0], [0.5, 0.5], [False, False], 1280, 720),  # times not increasing
        ([0.0, 0.75], [0.5, 1.5], [False, False], 1280, 720),  # centre outside [0, 1]
        ([0.0, 0.75], [0.5, 0.5], [False, False], 0, 720),  # no source size
        ([0.0, 0.75], [0.5, 0.5], [False, "yes"], 1280, 720),  # not a flag
    ],
)
def test_rejects_a_malformed_detector_result(source, result):
    with pytest.raises(ValueError):
        build_camera_plan(source, (0, 2000), Fps(25, 1), out_w=720, out_h=1280,
                          detector=lambda *_a, **_k: result)


def test_rejects_a_bad_window(source):
    with pytest.raises(ValueError):
        build_camera_plan(source, (2000, 2000), Fps(25, 1), out_w=720, out_h=1280,
                          detector=StubDetector())


# --- T3.6: the window detector, progress reporting ----------------------------------------------
#
# The camera plan's own detector (``camera.detect_window``) runs today's detection (the same
# cascade, parameters, sampled frames and cut flags as ``face_tracking.detect_face_track`` with
# ``smooth=False, sequential=True``) with the Haar work spread over worker threads, each with its
# own classifier (a shared ``CascadeClassifier`` is not thread-safe: it returns wrong boxes).
# Equal-area faces are chosen by position, not by OpenCV's detection order.


class ContentCascade:
    """Stands in for ``cv2.CascadeClassifier``: one face whose position follows the pixels it is
    given, so two detectors agree only when they looked at the same frames. Pure (thread-safe)."""

    seen: ClassVar[list] = []

    def __init__(self, *_args):
        pass

    def detectMultiScale(self, image, **kwargs):  # OpenCV's method name
        import numpy as np

        type(self).seen.append(tuple(sorted(kwargs.items())))
        digest = hashlib.sha256(image.tobytes()).digest()
        width = image.shape[1]
        x = digest[0] * (width - 40) // 255
        if digest[1] < 40:  # some frames have no face
            return ()
        return np.array([[x, 4, 40, 40]], dtype=np.int32)


class TwoEqualFacesCascade:
    """Two faces of the same size, reported in an order that changes from call to call."""

    calls = 0

    def __init__(self, *_args):
        pass

    def detectMultiScale(self, image, **_kwargs):  # OpenCV's method name
        import numpy as np

        type(self).calls += 1
        faces = [[200, 10, 50, 50], [20, 12, 50, 50]]
        if type(self).calls % 2:
            faces.reverse()
        return np.array(faces, dtype=np.int32)


@pytest.fixture
def cut_video(tmp_path, edit_v2_ffmpeg):
    pytest.importorskip("cv2")
    from support import edit_v2_media as media

    return media.make_barcode_video(
        tmp_path / "cuts.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=200, scene_cut_every=20,
                        gop=250, audio=None))


def test_the_window_detector_samples_todays_frames_and_decisions(cut_video, monkeypatch):
    import cv2

    from ai_clipper import face_tracking

    monkeypatch.setattr(cv2, "CascadeClassifier", ContentCascade)
    ContentCascade.seen = []
    today = face_tracking.detect_face_track(cut_video, start=0.4, end=7.4, smooth=False,
                                            sequential=True)
    today_kwargs = set(ContentCascade.seen)
    ContentCascade.seen = []
    window = camera.detect_window(cut_video, start=0.4, end=7.4, sample_interval=0.75)
    assert window == today
    assert set(ContentCascade.seen) == today_kwargs  # scaleFactor, minNeighbors, minSize
    times, centres, cuts, width, height = window
    assert (width, height) == (320, 180) and len(times) == 10
    assert any(cuts) and any(c is None for c in centres) and any(c is not None for c in centres)


def test_the_window_detector_does_not_depend_on_the_number_of_workers(cut_video, monkeypatch):
    import cv2

    real = camera.detect_window(cut_video, start=0.0, end=6.0, sample_interval=0.75, workers=1)
    assert real == camera.detect_window(cut_video, start=0.0, end=6.0, sample_interval=0.75,
                                        workers=3)
    monkeypatch.setattr(cv2, "CascadeClassifier", ContentCascade)
    one = camera.detect_window(cut_video, start=0.0, end=7.9, sample_interval=0.75, workers=1)
    assert one == camera.detect_window(cut_video, start=0.0, end=7.9, sample_interval=0.75,
                                       workers=4)


def test_equal_faces_are_chosen_by_position_not_by_detection_order(cut_video, monkeypatch):
    import cv2

    monkeypatch.setattr(cv2, "CascadeClassifier", TwoEqualFacesCascade)
    _times, centres, *_rest = camera.detect_window(cut_video, start=0.0, end=3.0,
                                                   sample_interval=0.75, workers=2)
    assert centres == [(20 + 25) / 320] * 4


def test_the_window_detector_leaves_opencv_threads_as_it_found_them(cut_video):
    import cv2

    before = cv2.getNumThreads()
    cv2.setNumThreads(3)
    try:
        camera.detect_window(cut_video, start=0.0, end=2.0, sample_interval=0.75, workers=2)
        assert cv2.getNumThreads() == 3
    finally:
        cv2.setNumThreads(before)


def test_the_window_detector_refuses_a_source_it_cannot_open(tmp_path):
    pytest.importorskip("cv2")
    bad = tmp_path / "not-a-video.mp4"
    bad.write_bytes(b"nothing here")
    with pytest.raises(RuntimeError):
        camera.detect_window(bad, start=0.0, end=2.0, sample_interval=0.75)


def test_the_default_detector_takes_the_window_path(source, monkeypatch):
    calls = []

    def spy(path, *, start, end, sample_interval, progress=None, workers=None):
        calls.append((path, start, end, sample_interval))
        return [0.0, 0.75, 1.5], [0.5, None, 0.6], [False, False, True], 640, 360

    monkeypatch.setattr(camera, "detect_window", spy)
    plan = build_camera_plan(source, (1000, 3000), Fps(25, 1), out_w=720, out_h=1280)
    assert calls == [(source, 1.0, 3.0, 0.75)]
    assert plan["source"] == {"w": 640, "h": 360} and plan["cuts"] == [False, False, True]
    # an explicit detector, or today's tracker replaced by a caller, is called instead
    calls.clear()
    build_camera_plan(source, (1000, 3000), Fps(25, 1), out_w=720, out_h=1280,
                      detector=StubDetector())
    assert calls == []


def test_the_plan_reports_its_progress_per_sample(tmp_path, edit_v2_ffmpeg):
    pytest.importorskip("cv2")
    from support import edit_v2_media as media

    path = media.make_barcode_video(
        tmp_path / "faceless.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=150, audio=None))
    events = []
    with camera.reporting(lambda done, total: events.append((done, total))):
        plan = build_camera_plan(path, (0, 6000), Fps(25, 1), out_w=720, out_h=1280)
    count = len(plan["samples"])
    assert count == 8
    assert events[0] == (0, count) and events[-1] == (count, count)
    assert all(total == count for _done, total in events)
    done = [value for value, _total in events]
    assert done == sorted(set(done))  # strictly increasing
    events.clear()
    build_camera_plan(path, (0, 6000), Fps(25, 1), out_w=720, out_h=1280)
    assert events == []  # outside ``reporting`` nothing is reported


def test_a_detector_of_its_own_reports_the_start_and_the_end(source):
    events = []
    with camera.reporting(lambda done, total: events.append((done, total))):
        plan = build_camera_plan(source, (0, 4500), Fps(25, 1), out_w=720, out_h=1280,
                                 detector=StubDetector())
    assert len(plan["samples"]) == 6
    assert events == [(0, 6), (6, 6)]


def test_a_failing_progress_callback_never_stops_the_plan(source):
    def broken(_done, _total):
        raise OSError("disk full")

    with camera.reporting(broken):
        plan = build_camera_plan(source, (0, 4500), Fps(25, 1), out_w=720, out_h=1280,
                                 detector=StubDetector())
    assert len(plan["samples"]) == 6


def test_the_progress_file_is_written_atomically_and_read_back(tmp_path):
    path = tmp_path / "preview" / "camera.progress.json"
    writer = camera.ProgressFile(path, window_ms=(1000, 181000), min_interval_s=0.0)
    assert camera.read_progress(path) is None
    writer(0, 240)
    assert camera.read_progress(path) == {"window_ms": [1000, 181000], "done": 0, "total": 240}
    assert oct(path.stat().st_mode & 0o777) == oct(0o600)
    writer(120, 240)
    assert camera.read_progress(path)["done"] == 120
    assert not [p for p in path.parent.iterdir() if p.name != path.name]  # no temp file left
    writer.clear()
    assert camera.read_progress(path) is None and not path.exists()


def test_the_progress_file_is_throttled_but_always_ends_complete(tmp_path):
    path = tmp_path / "camera.progress.json"
    writer = camera.ProgressFile(path, window_ms=(0, 9000), min_interval_s=3600.0)
    writer(0, 12)
    writer(5, 12)  # within the interval: not written
    assert camera.read_progress(path)["done"] == 0
    writer(12, 12)  # the last sample is always written
    assert camera.read_progress(path)["done"] == 12


@pytest.mark.parametrize("raw", [b"", b"{", b"[]", b'{"done": 1}',
                                 b'{"schema": "x", "window_ms": [0, 1], "done": 1, "total": 2}',
                                 (b'{"schema": "potongin.camera-progress/1", "window_ms": [0, 1],'
                                  b' "done": 3, "total": 2}')])
def test_a_malformed_progress_file_reads_as_none(tmp_path, raw):
    path = tmp_path / "camera.progress.json"
    path.write_bytes(raw)
    assert camera.read_progress(path) is None


def test_a_symlinked_progress_file_is_not_followed(tmp_path):
    target = tmp_path / "elsewhere.json"
    target.write_text(json.dumps({"schema": "potongin.camera-progress/1", "window_ms": [0, 1],
                                  "done": 1, "total": 2}))
    link = tmp_path / "camera.progress.json"
    link.symlink_to(target)
    assert camera.read_progress(link) is None
