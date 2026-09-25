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


class CountingCapture:
    """Wraps ``cv2.VideoCapture`` and counts the seeks."""

    seeks = 0

    def __init__(self, *args):
        import cv2

        self._inner = cv2.VideoCapture(*args)

    def set(self, prop, value):
        type(self).seeks += 1
        return self._inner.set(prop, value)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def test_todays_detector_decodes_the_window_once_in_sequential_mode(tmp_path, edit_v2_ffmpeg,
                                                                     monkeypatch):
    """W1 verifier: a 3 min window of a long-GOP AV1 720p source took 16.35 s (budget 15 s),
    most of it one seek per 0.75 s sample. The camera plan decodes the window once and keeps
    the frame at each sample time; the legacy render keeps its per-sample seeks."""
    cv2 = pytest.importorskip("cv2")
    from support import edit_v2_media as media

    import ai_clipper.face_tracking as face_tracking

    path = media.make_barcode_video(
        tmp_path / "cuts.mp4",
        media.VideoSpec(width=320, height=180, fps=(25, 1), frames=150, scene_cut_every=20,
                        gop=250, audio=None),
    )

    class Capture(CountingCapture):
        seeks = 0

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
