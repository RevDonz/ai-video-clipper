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


def test_todays_detector_decodes_the_window_once(tmp_path, edit_v2_ffmpeg, monkeypatch):
    """W1 verifier: a 3 min window of a long-GOP AV1 720p source took 16.35 s (budget 15 s),
    most of it one seek per 0.75 s sample. The detector decodes the window once and keeps the
    frame at each sample time; the legacy render goes through the same scan."""
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
    track = face_tracking.detect_face_track(path, start=0.4, end=5.4, smooth=False)
    assert Capture.seeks == 1
    assert len(track[0]) == 7 and track[1] == [None] * 7  # no faces, sample times, size
    assert any(track[2])  # the scene cuts


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
# The camera plan's own detector (``camera.detect_window``) is today's detection: the window
# decoded once, YuNet faces per sample and the speaking face (``face_window``, tested in
# test_face_window.py). ``ContentFaces`` stands in for ``cv2.FaceDetectorYN`` here.


class ContentFaces:
    """Stands in for ``cv2.FaceDetectorYN``: one face whose position follows the pixels it is
    given, so two runs agree only when they looked at the same frames."""

    @classmethod
    def create(cls, model, config, size, score, nms, top_k):
        return cls()

    def detect(self, image):
        import numpy as np

        digest = hashlib.sha256(image.tobytes()).digest()
        width = image.shape[1]
        x = digest[0] * (width - 40) // 255
        if digest[1] < 40:  # some frames have no face
            return 1, None
        row = [x, 4, 40, 40, x + 12, 16, x + 28, 16, x + 20, 24, x + 13, 33, x + 27, 33, 0.9]
        return 1, np.array([row], dtype=np.float32)


@pytest.fixture
def cut_video(tmp_path, edit_v2_ffmpeg):
    pytest.importorskip("cv2")
    from support import edit_v2_media as media

    return media.make_barcode_video(
        tmp_path / "cuts.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=200, scene_cut_every=20,
                        gop=250, audio=None))


def test_the_window_detector_is_todays_track_without_smoothing(cut_video, monkeypatch):
    import cv2

    from ai_clipper import face_tracking

    monkeypatch.setattr(cv2, "FaceDetectorYN", ContentFaces)
    today = face_tracking.detect_face_track(cut_video, start=0.4, end=7.4, smooth=False)
    window = camera.detect_window(cut_video, start=0.4, end=7.4, sample_interval=0.75)
    assert window == today
    times, centres, cuts, width, height = window
    assert (width, height) == (320, 180) and len(times) == 10
    assert any(cuts) and any(c is None for c in centres) and any(c is not None for c in centres)


def test_the_window_detector_leaves_opencv_threads_as_it_found_them(cut_video):
    import cv2

    before = cv2.getNumThreads()
    cv2.setNumThreads(3)
    try:
        camera.detect_window(cut_video, start=0.0, end=2.0, sample_interval=0.75)
        assert cv2.getNumThreads() == 3
    finally:
        cv2.setNumThreads(before)


class FakeOpenCvThreads:
    def __init__(self, threads):
        self.threads = threads

    def getNumThreads(self):  # OpenCV's method name
        return self.threads

    def setNumThreads(self, value):  # OpenCV's method name
        self.threads = value


def test_overlapping_windows_hold_opencv_at_one_thread_until_the_last_ends():
    """T4.3: the auto render runs camera plans of several clips at once; the first window to
    start keeps OpenCV's own pool at one thread and the last one to end restores it."""
    from ai_clipper import face_window

    cv2 = FakeOpenCvThreads(3)
    first, second = (face_window.one_opencv_thread(cv2) for _ in range(2))
    first.__enter__()
    assert cv2.threads == 1
    second.__enter__()
    first.__exit__(None, None, None)
    assert cv2.threads == 1  # the second window is still running
    second.__exit__(None, None, None)
    assert cv2.threads == 3
    with face_window.one_opencv_thread(cv2):
        assert cv2.threads == 1
    assert cv2.threads == 3


def test_the_window_detector_refuses_a_source_it_cannot_open(tmp_path):
    pytest.importorskip("cv2")
    bad = tmp_path / "not-a-video.mp4"
    bad.write_bytes(b"nothing here")
    with pytest.raises(RuntimeError):
        camera.detect_window(bad, start=0.0, end=2.0, sample_interval=0.75)


def test_the_default_detector_takes_the_window_path(source, monkeypatch):
    calls = []

    def spy(path, *, start, end, sample_interval, progress=None):
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


# --- the framed face's box (CONTRACTS §5.50) ------------------------------------------------------


def test_a_detector_with_boxes_adds_the_framed_face_per_sample(source):
    """A sixth value, the framed face per sample as ``(x, y, w, h)`` shares of the frame, becomes
    ``faces``: per-mille integers rounded half up, clamped inside the frame, ``None`` kept."""

    def detector(path, *, start, end, sample_interval=0.75):
        boxes = [(0.25, 0.1, 0.2, 0.3), None, (0.9, 0.85, 0.2, 0.2), (0.0005, 0.0, 0.1, 0.1)]
        return [0.0, 0.75, 1.5, 2.25], [0.35, None, 1.0, 0.05], [False] * 4, 1280, 720, boxes

    plan = build_camera_plan(source, (1000, 4000), Fps(25, 1), out_w=720, out_h=1280,
                             detector=detector)
    assert set(plan) == KEYS | {"faces"}
    assert plan["faces"] == [[250, 100, 200, 300], None, [900, 850, 100, 150], [1, 0, 100, 100]]


def test_a_detector_without_boxes_keeps_todays_plan(source):
    plan = build_camera_plan(source, (1000, 4000), Fps(25, 1), out_w=720, out_h=1280,
                             detector=StubDetector())
    assert set(plan) == KEYS


def test_boxes_must_be_parallel_to_the_samples(source):
    def detector(path, *, start, end, sample_interval=0.75):
        return [0.0, 0.75], [0.5, 0.5], [False, False], 1280, 720, [(0.1, 0.1, 0.1, 0.1)]

    with pytest.raises(ValueError):
        build_camera_plan(source, (1000, 3000), Fps(25, 1), out_w=720, out_h=1280,
                          detector=detector)


def test_the_window_detector_is_asked_for_boxes_when_it_takes_them(source, monkeypatch):
    calls = []

    def spy(path, *, start, end, sample_interval, progress=None, boxes=False):
        calls.append(boxes)
        result = [0.0, 0.75, 1.5], [0.5, None, 0.6], [False, False, True], 640, 360
        return (*result, [(0.4, 0.2, 0.2, 0.3), None, (0.5, 0.2, 0.2, 0.3)]) if boxes else result

    monkeypatch.setattr(camera, "detect_window", spy)
    plan = build_camera_plan(source, (1000, 3000), Fps(25, 1), out_w=720, out_h=1280)
    assert calls == [True]
    assert plan["faces"] == [[400, 200, 200, 300], None, [500, 200, 200, 300]]


def test_a_plan_from_a_shared_scan_has_the_same_bytes(cut_video, monkeypatch):
    """The auto layout scans a window once for its camera plan and its shot evidence
    (rombak 04 §A4): the plan built from that scan is byte for byte today's plan."""
    import cv2

    from ai_clipper import face_window

    monkeypatch.setattr(cv2, "FaceDetectorYN", ContentFaces)
    fps = Fps(25, 1)
    today = encode_camera_plan(build_camera_plan(cut_video, (400, 7400), fps, out_w=720,
                                                 out_h=1280))
    scan = face_window.scan_window(cut_video, start=0.4, end=7.4, frame_diff=True)
    events = []
    with camera.reporting(lambda done, total: events.append((done, total))):
        shared = encode_camera_plan(build_camera_plan(cut_video, (400, 7400), fps, out_w=720,
                                                      out_h=1280, scan=scan))
    assert shared == today
    assert events[0] == (0, len(scan.times)) and events[-1] == (len(scan.times),) * 2
    with pytest.raises(ValueError, match="today's detector"):
        build_camera_plan(cut_video, (400, 7400), fps, out_w=720, out_h=1280,
                          detector=StubDetector(), scan=scan)
