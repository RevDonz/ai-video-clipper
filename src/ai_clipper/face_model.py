"""YuNet face detection and mouth motion for the face-track crop (OpenCV, imported lazily).

The detector is OpenCV's ``FaceDetectorYN`` with the YuNet model of the OpenCV Zoo
(``resources/models/face_detection_yunet_2023mar.onnx``, MIT, see ``resources/models/
models.json``). Every frame is detected at its size scaled down to at most 640 pixels on the long
side; the boxes and the five landmarks come back in source pixels.

Mouth motion compares the mouth region of one face in two frames a few hundredths of a second
apart: the region (from the mouth-corner landmarks, with a margin) is cut out of each frame,
turned grey and resized to a small patch; the earlier patch is matched inside the later one, so
a head that moves a few pixels does not count, and what is left is the mean absolute difference
of the two patches relative to their contrast. A speaking mouth scores higher than a still one.

Callers pass the ``cv2`` module (and hold OpenCV at one thread, ``face_window``), so this module
imports neither OpenCV nor NumPy at import time.
"""

from __future__ import annotations

import functools
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# src/ai_clipper/face_model.py -> the repository (or /app in the image) -> resources/
MODELS_DIR = Path(__file__).resolve().parents[2] / "resources" / "models"
MODELS_MANIFEST = MODELS_DIR / "models.json"
MODEL_NAME = "face_detection_yunet_2023mar.onnx"

ANALYSIS_LONG_SIDE = 640  # detection runs on frames scaled down to this long side
SCORE_THRESHOLD = 0.6
NMS_THRESHOLD = 0.3
TOP_K = 50

PATCH_W, PATCH_H, PATCH_MARGIN = 32, 20, 4  # the mouth patch and its search margin, in pixels
MOUTH_WIDTH = 1.6  # the region spans this many mouth widths (corner to corner)
MIN_MOUTH_SHARE = 0.3  # a mouth narrower than this share of the face width counts as this wide
CONTRAST_FLOOR = 4.0  # added to the patches' contrast so flat patches do not blow up


@dataclass(frozen=True, slots=True)
class Detection:
    """A face in source pixels: box, score and the YuNet landmarks (right eye, left eye, nose
    tip, right mouth corner, left mouth corner) as ``((x, y), …)``."""

    x: float
    y: float
    w: float
    h: float
    score: float
    landmarks: tuple[tuple[float, float], ...]


@functools.cache
def model_path() -> Path:
    """The YuNet model file, checked against its sha256 in ``models.json``."""
    try:
        manifest = json.loads(MODELS_MANIFEST.read_text(encoding="utf-8"))
        entry = next(item for item in manifest["models"] if item["file"] == MODEL_NAME)
        data = (MODELS_DIR / MODEL_NAME).read_bytes()
    except (OSError, ValueError, KeyError, StopIteration, TypeError) as error:
        raise RuntimeError(f"face model missing: {MODELS_DIR / MODEL_NAME}") from error
    if hashlib.sha256(data).hexdigest() != entry["sha256"]:
        raise RuntimeError(f"face model does not match its sha256: {MODELS_DIR / MODEL_NAME}")
    return MODELS_DIR / MODEL_NAME


def analysis_size(width: int, height: int) -> tuple[int, int]:
    """The size a ``width × height`` frame is detected at (never enlarged)."""
    scale = min(1.0, ANALYSIS_LONG_SIDE / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


class YuNet:
    """``cv2.FaceDetectorYN`` for frames of one size; not shared between threads."""

    def __init__(self, cv2: Any, width: int, height: int) -> None:
        if width <= 0 or height <= 0:
            raise ValueError("the frame size must be positive")
        self._cv2 = cv2
        self.size = (width, height)
        self.analysis = analysis_size(width, height)
        self._scale_x = width / self.analysis[0]
        self._scale_y = height / self.analysis[1]
        if not hasattr(cv2, "FaceDetectorYN"):
            raise RuntimeError("this OpenCV build has no FaceDetectorYN")
        self._detector = cv2.FaceDetectorYN.create(str(model_path()), "", self.analysis,
                                                   SCORE_THRESHOLD, NMS_THRESHOLD, TOP_K)

    def detect(self, frame: Any) -> list[Detection]:
        """The faces of a BGR frame of this detector's size, sorted by position."""
        cv2 = self._cv2
        image = frame
        if self.analysis != self.size:
            image = cv2.resize(frame, self.analysis, interpolation=cv2.INTER_AREA)
        _status, faces = self._detector.detect(image)
        found: list[Detection] = []
        for row in [] if faces is None else faces:
            values = [float(value) for value in row[:15]]
            sx, sy = self._scale_x, self._scale_y
            landmarks = tuple((values[4 + 2 * k] * sx, values[5 + 2 * k] * sy) for k in range(5))
            found.append(Detection(values[0] * sx, values[1] * sy, values[2] * sx,
                                   values[3] * sy, values[14], landmarks))
        found.sort(key=lambda face: (face.x, face.y, face.w, face.h))
        return found


def mouth_region(face: Detection) -> tuple[int, int, int, int] | None:
    """``(x0, y0, x1, y1)`` in source pixels: the mouth region with the search margin."""
    (rx, ry), (lx, ly) = face.landmarks[3], face.landmarks[4]
    width = max(abs(lx - rx), MIN_MOUTH_SHARE * face.w) * MOUTH_WIDTH
    height = width * PATCH_H / PATCH_W
    if width < 4:
        return None
    centre_x, centre_y = (rx + lx) / 2, (ry + ly) / 2
    margin_x = width * PATCH_MARGIN / PATCH_W
    margin_y = height * PATCH_MARGIN / PATCH_H
    return (round(centre_x - width / 2 - margin_x), round(centre_y - height / 2 - margin_y),
            round(centre_x + width / 2 + margin_x), round(centre_y + height / 2 + margin_y))


def mouth_patch(cv2: Any, frame: Any, region: tuple[int, int, int, int]) -> Any | None:
    """The region of a BGR frame (clipped to the frame) as a grey ``float32`` patch with its
    margin, or ``None`` when too little of it is inside the frame."""
    height, width = frame.shape[:2]
    x0, y0 = max(region[0], 0), max(region[1], 0)
    x1, y1 = min(region[2], width), min(region[3], height)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    grey = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    size = (PATCH_W + 2 * PATCH_MARGIN, PATCH_H + 2 * PATCH_MARGIN)
    return cv2.resize(grey, size, interpolation=cv2.INTER_AREA).astype("float32")


def mouth_motion(cv2: Any, earlier: Any, later: Any) -> float:
    """How much the mouth changed between two patches, after the best shift of at most the
    margin (so head motion of a few pixels does not count)."""
    inner = earlier[PATCH_MARGIN:PATCH_MARGIN + PATCH_H, PATCH_MARGIN:PATCH_MARGIN + PATCH_W]
    result = cv2.matchTemplate(later, inner, cv2.TM_SQDIFF)
    _low, _high, (x, y), _at_high = cv2.minMaxLoc(result)
    region = later[y:y + PATCH_H, x:x + PATCH_W]
    a = inner - inner.mean()
    b = region - region.mean()
    contrast = (float(a.std()) + float(b.std())) / 2 + CONTRAST_FLOOR
    return float(abs(a - b).mean()) / contrast


__all__ = ["ANALYSIS_LONG_SIDE", "MODELS_DIR", "MODEL_NAME", "Detection", "YuNet",
           "analysis_size", "model_path", "mouth_motion", "mouth_patch", "mouth_region"]
