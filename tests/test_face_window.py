"""The face-track scan (``face_window``): decoded frames, mouth motion and the speaking face.

The videos are drawn here: two "faces" on a textured background, one of them opening and
closing its mouth. ``cv2.FaceDetectorYN`` is replaced by a stub that reports the two faces where
they are drawn, so the test exercises the decoding, the sampling, the mouth motion and the choice
with real OpenCV.
"""

from __future__ import annotations

import pytest

from ai_clipper import face_tracking, face_window

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")

WIDTH, HEIGHT, FPS = 320, 180, 25
LEFT = (30, 50, 70, 70)  # x, y, w, h: centre 65 → 0.203
RIGHT = (210, 46, 80, 80)  # a little larger: centre 250 → 0.781


def landmarks(box):
    x, y, w, h = box
    mouth_y = y + 0.78 * h
    return [x + 0.3 * w, y + 0.38 * h, x + 0.7 * w, y + 0.38 * h, x + 0.5 * w, y + 0.58 * h,
            x + 0.33 * w, mouth_y, x + 0.67 * w, mouth_y]


class TwoFaces:
    """Stands in for ``cv2.FaceDetectorYN``: the two drawn faces in every frame."""

    calls = 0

    @classmethod
    def create(cls, model, config, size, score, nms, top_k):
        assert size == (WIDTH, HEIGHT)
        return cls()

    def detect(self, image):
        type(self).calls += 1
        rows = [[*box, *landmarks(box), 0.9] for box in (RIGHT, LEFT)]
        return 1, np.array(rows, dtype=np.float32)


@pytest.fixture
def two_faces(monkeypatch):
    TwoFaces.calls = 0
    monkeypatch.setattr(cv2, "FaceDetectorYN", TwoFaces)
    return TwoFaces


def write_video(path, speaker_at, seconds=6.0):
    """A 25 fps MJPEG video; ``speaker_at(t)`` names the box whose mouth moves at ``t``."""
    rng = np.random.default_rng(3)
    base = cv2.resize(rng.integers(60, 200, size=(HEIGHT // 6, WIDTH // 6), dtype=np.uint8),
                      (WIDTH, HEIGHT), interpolation=cv2.INTER_CUBIC)
    background = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (WIDTH, HEIGHT))
    assert writer.isOpened()
    for index in range(round(seconds * FPS)):
        frame = background.copy()
        speaker = speaker_at(index / FPS)
        for box in (LEFT, RIGHT):
            x, y, w, h = box
            cv2.rectangle(frame, (x, y), (x + w, y + h), (150, 170, 200), -1)
            open_mouth = box == speaker and (index // 2) % 2 == 0  # ~6 openings a second
            height = max(1, round(0.12 * h)) if open_mouth else 1
            cv2.ellipse(frame, (round(x + 0.5 * w), round(y + 0.78 * h)),
                        (round(0.17 * w), height), 0, 0, 360, (30, 30, 60), -1)
        writer.write(frame)
    writer.release()
    return path


def centre(box):
    return (box[0] + box[2] / 2) / WIDTH


def test_the_face_that_speaks_is_framed_not_the_larger_one(tmp_path, two_faces):
    video = write_video(tmp_path / "left.avi", lambda _t: LEFT)
    times, centres, cuts, width, height = face_window.detect_window(video, start=0.0, end=6.0)
    assert (width, height) == (WIDTH, HEIGHT)
    assert times == face_window.sample_times(0.0, 6.0, 0.75)
    assert centres == [pytest.approx(centre(LEFT))] * len(times)
    assert not any(cuts)
    assert two_faces.calls == len(times)  # one detection per sample


def test_the_crop_cuts_to_the_new_speaker(tmp_path, two_faces):
    video = write_video(tmp_path / "turns.avi", lambda t: LEFT if t < 4.5 else RIGHT, seconds=9)
    times, centres, cuts, *_size = face_window.detect_window(video, start=0.0, end=9.0)
    switch = next(index for index, value in enumerate(centres)
                  if value == pytest.approx(centre(RIGHT)))
    assert 4.5 <= times[switch] <= 6.75  # within a few samples of the turn
    assert centres[:switch] == [pytest.approx(centre(LEFT))] * switch
    assert centres[switch:] == [pytest.approx(centre(RIGHT))] * (len(times) - switch)
    assert cuts == [index == switch for index in range(len(times))]  # a cut, not a pan


def test_the_scan_measures_each_face_and_reports_progress(tmp_path, two_faces):
    video = write_video(tmp_path / "left.avi", lambda _t: LEFT)
    events = []
    scan = face_window.scan_window(video, start=1.0, end=4.0,
                                   progress=lambda done, total: events.append((done, total)))
    assert [sample.time for sample in scan.samples] == scan.times == [0.0, 0.75, 1.5, 2.25]
    assert events == [(0, 4), (1, 4), (2, 4), (3, 4), (4, 4)]
    for sample in scan.samples:
        right, left = sorted(sample.faces, key=lambda face: -face.x)
        assert left.activity > 0.2
        assert right.activity < 0.02  # the still mouth barely registers
        assert (left.x, left.w) == pytest.approx((LEFT[0], LEFT[2]))


def test_mouth_frames_after_a_cut_inside_an_interval_are_not_counted(tmp_path, two_faces):
    """A cut at 1.0 s, between the samples at 0.75 and 1.5 s: after it the picture changes, and
    whatever moves where LEFT's mouth was belongs to the next shot, not to LEFT."""
    rng = np.random.default_rng(5)
    writer = cv2.VideoWriter(str(tmp_path / "cut.avi"), cv2.VideoWriter_fourcc(*"MJPG"), FPS,
                             (WIDTH, HEIGHT))
    first = cv2.cvtColor(cv2.resize(rng.integers(60, 200, size=(30, 53), dtype=np.uint8),
                                    (WIDTH, HEIGHT)), cv2.COLOR_GRAY2BGR)
    for index in range(3 * FPS):
        if index < FPS:
            frame = first.copy()
        else:  # another, brighter shot whose pixels change every frame where the faces were
            frame = np.full((HEIGHT, WIDTH, 3), 240, dtype=np.uint8)
            for x, y, w, h in (LEFT, RIGHT):
                frame[y:y + h, x:x + w] = rng.integers(0, 255, size=(h, w, 3), dtype=np.uint8)
        writer.write(frame)
    writer.release()
    scan = face_window.scan_window(tmp_path / "cut.avi", start=0.0, end=3.0)
    assert [sample.cut for sample in scan.samples] == [False, False, True, False]
    still = scan.samples[1]  # 0.75 s: four still frames before the cut, then noise
    assert all(face.activity is not None and face.activity < 0.02 for face in still.faces)
    noisy = scan.samples[2]  # 1.5 s: inside the noise shot, measured as usual
    assert all(face.activity > 0.2 for face in noisy.faces)


def test_the_window_is_decoded_once(tmp_path, two_faces, monkeypatch):
    video = write_video(tmp_path / "left.avi", lambda _t: LEFT)
    real = cv2.VideoCapture
    seeks = []

    class Capture:
        def __init__(self, *args):
            self._inner = real(*args)

        def set(self, prop, value):
            seeks.append(prop)
            return self._inner.set(prop, value)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(cv2, "VideoCapture", Capture)
    raw = face_tracking.detect_face_track(video, start=0.5, end=5.5, smooth=False)
    assert seeks == [cv2.CAP_PROP_POS_MSEC]
    smoothed = face_tracking.detect_face_track(video, start=0.5, end=5.5)
    assert smoothed[1] == face_tracking.smooth_face_track(raw[1], cuts=raw[2])
    assert raw[0] == smoothed[0] and raw[2] == smoothed[2]


def test_without_a_frame_rate_the_largest_face_is_framed(tmp_path, two_faces, monkeypatch):
    video = write_video(tmp_path / "left.avi", lambda _t: LEFT)
    real = cv2.VideoCapture

    class NoRate:
        def __init__(self, *args):
            self._inner = real(*args)

        def get(self, prop):
            return 0.0 if prop == cv2.CAP_PROP_FPS else self._inner.get(prop)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    monkeypatch.setattr(cv2, "VideoCapture", NoRate)
    scan = face_window.scan_window(video, start=0.0, end=3.0)
    assert all(face.activity is None for sample in scan.samples for face in sample.faces)
    _times, centres, *_rest = face_window.detect_window(video, start=0.0, end=3.0)
    assert centres == [pytest.approx(centre(RIGHT))] * 4


def test_the_same_window_gives_the_same_track(tmp_path):
    """Real YuNet on a faceless video: no face, and the same result twice."""
    video = write_video(tmp_path / "left.avi", lambda _t: LEFT, seconds=3)
    first = face_window.detect_window(video, start=0.0, end=3.0)
    assert first == face_window.detect_window(video, start=0.0, end=3.0)
    assert first[1] == [None] * 4  # drawn rectangles are not faces


def test_a_source_opencv_cannot_open_is_refused(tmp_path):
    bad = tmp_path / "not-a-video.mp4"
    bad.write_bytes(b"nothing here")
    with pytest.raises(RuntimeError):
        face_window.scan_window(bad, start=0.0, end=2.0)
