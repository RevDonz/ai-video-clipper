"""YuNet detection and mouth motion (``face_model``) with the pinned model and real OpenCV."""

from __future__ import annotations

import hashlib
import json
import shutil
from typing import ClassVar

import pytest

from ai_clipper import face_model

cv2 = pytest.importorskip("cv2")
np = pytest.importorskip("numpy")


@pytest.fixture
def clean_model_cache():
    face_model.model_path.cache_clear()
    yield
    face_model.model_path.cache_clear()


def test_the_pinned_model_matches_its_manifest(clean_model_cache):
    manifest = json.loads(face_model.MODELS_MANIFEST.read_text(encoding="utf-8"))
    (entry,) = manifest["models"]
    path = face_model.model_path()
    data = path.read_bytes()
    assert path.name == face_model.MODEL_NAME == entry["file"]
    assert hashlib.sha256(data).hexdigest() == entry["sha256"]
    assert len(data) == entry["bytes"]
    assert entry["license"] == "MIT"
    assert (face_model.MODELS_DIR / entry["license_file"]).read_text().startswith("MIT License")


def test_a_changed_or_missing_model_is_refused(tmp_path, monkeypatch, clean_model_cache):
    shutil.copy(face_model.MODELS_MANIFEST, tmp_path / "models.json")
    (tmp_path / face_model.MODEL_NAME).write_bytes(b"not the model")
    monkeypatch.setattr(face_model, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(face_model, "MODELS_MANIFEST", tmp_path / "models.json")
    with pytest.raises(RuntimeError, match="sha256"):
        face_model.model_path()
    face_model.model_path.cache_clear()
    (tmp_path / face_model.MODEL_NAME).unlink()
    with pytest.raises(RuntimeError, match="missing"):
        face_model.model_path()


def test_frames_are_detected_at_most_640_pixels_on_the_long_side():
    assert face_model.analysis_size(1920, 1080) == (640, 360)
    assert face_model.analysis_size(1280, 720) == (640, 360)
    assert face_model.analysis_size(720, 1280) == (360, 640)
    assert face_model.analysis_size(640, 346) == (640, 346)
    assert face_model.analysis_size(320, 180) == (320, 180)  # never enlarged


def test_yunet_runs_on_this_opencv_and_finds_nothing_in_a_faceless_frame():
    assert hasattr(cv2, "FaceDetectorYN")
    detector = face_model.YuNet(cv2, 1280, 720)
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    frame[:, ::40] = 255  # stripes, no face
    assert detector.detect(frame) == []


class ScaledStub:
    """Stands in for ``cv2.FaceDetectorYN``: two faces in analysis pixels, listed right first."""

    created: ClassVar[list] = []

    @classmethod
    def create(cls, model, config, size, score, nms, top_k):
        cls.created.append((size, score, nms, top_k))
        return cls()

    def detect(self, image):
        assert image.shape[:2] == (360, 640)
        right = [400, 100, 80, 80, 420, 130, 460, 130, 440, 150, 425, 165, 455, 165, 0.9]
        left = [100, 110, 60, 60, 115, 130, 145, 130, 130, 140, 118, 155, 142, 155, 0.8]
        return 1, np.array([right, left], dtype=np.float32)


def test_boxes_and_landmarks_come_back_in_source_pixels_sorted_by_position(monkeypatch):
    monkeypatch.setattr(cv2, "FaceDetectorYN", ScaledStub)
    detector = face_model.YuNet(cv2, 1920, 1080)
    left, right = detector.detect(np.zeros((1080, 1920, 3), dtype=np.uint8))
    assert ScaledStub.created[-1] == ((640, 360), face_model.SCORE_THRESHOLD,
                                      face_model.NMS_THRESHOLD, face_model.TOP_K)
    assert (left.x, left.y, left.w, left.h) == pytest.approx((300, 330, 180, 180))
    assert left.score == pytest.approx(0.8)
    assert left.landmarks[3] == pytest.approx((354, 465))  # right mouth corner, × 3
    assert (right.x, right.w) == pytest.approx((1200, 240))


def face_at(x, y, size):
    """A detection whose mouth corners sit a third of the box apart, low in the box."""
    mouth_y = y + 0.75 * size
    landmarks = ((x + 0.3 * size, y + 0.35 * size), (x + 0.7 * size, y + 0.35 * size),
                 (x + 0.5 * size, y + 0.55 * size), (x + 0.35 * size, mouth_y),
                 (x + 0.65 * size, mouth_y))
    return face_model.Detection(x, y, size, size, 0.9, landmarks)


def textured(height=360, width=640, seed=7):
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, size=(height // 8, width // 8), dtype=np.uint8)
    grey = cv2.resize(base, (width, height), interpolation=cv2.INTER_CUBIC)
    return cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)


def test_a_still_mouth_scores_zero_and_a_moving_one_scores_more():
    frame = textured()
    face = face_at(200, 80, 160)
    region = face_model.mouth_region(face)
    still = face_model.mouth_patch(cv2, frame, region)
    assert still.shape == (face_model.PATCH_H + 2 * face_model.PATCH_MARGIN,
                           face_model.PATCH_W + 2 * face_model.PATCH_MARGIN)
    assert face_model.mouth_motion(cv2, still, face_model.mouth_patch(cv2, frame, region)) == 0
    opened = frame.copy()
    x0, y0, x1, y1 = region
    cv2.ellipse(opened, ((x0 + x1) // 2, (y0 + y1) // 2), ((x1 - x0) // 4, (y1 - y0) // 4), 0, 0,
                360, (20, 20, 20), -1)
    moving = face_model.mouth_motion(cv2, still, face_model.mouth_patch(cv2, opened, region))
    assert moving > 0.2


def test_a_head_shifting_a_few_pixels_barely_counts():
    frame = textured()
    face = face_at(200, 80, 160)
    region = face_model.mouth_region(face)
    earlier = face_model.mouth_patch(cv2, frame, region)
    shifted = np.roll(frame, (3, -4), axis=(0, 1))  # the whole picture moves 3 px down, 4 left
    later = face_model.mouth_patch(cv2, shifted, region)
    opened = frame.copy()
    x0, y0, x1, y1 = region
    cv2.ellipse(opened, ((x0 + x1) // 2, (y0 + y1) // 2), ((x1 - x0) // 4, (y1 - y0) // 4), 0, 0,
                360, (20, 20, 20), -1)
    spoken = face_model.mouth_motion(cv2, earlier, face_model.mouth_patch(cv2, opened, region))
    assert face_model.mouth_motion(cv2, earlier, later) < spoken / 3


def test_a_mouth_at_the_frame_edge_is_clipped_and_a_tiny_one_is_not_measured():
    frame = textured()
    edge = face_model.mouth_region(face_at(560, 250, 120))  # reaches past the right edge
    assert edge[2] > 640
    assert face_model.mouth_patch(cv2, frame, edge) is not None
    assert face_model.mouth_region(face_at(10, 10, 6)) is None  # a mouth under 4 pixels wide
