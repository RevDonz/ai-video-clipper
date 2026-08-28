"""Face detection and crop-path helpers for portrait reframing."""

from __future__ import annotations

from pathlib import Path


def smooth_face_track(
    centers: list[float | None],
    *,
    cuts: list[bool] | None = None,
    alpha: float = 0.35,
    cut_threshold: float = 0.22,
    max_hold_misses: int = 2,
) -> list[float]:
    """Smooth detections while resetting stale positions at cuts or long misses."""
    if not centers:
        return []
    if cuts is None:
        cuts = [False] * len(centers)
    if len(cuts) != len(centers):
        raise ValueError("cut flags must match face track length")

    filled: list[float] = []
    previous = 0.5
    has_detection = False
    misses = 0
    for value, is_cut in zip(centers, cuts, strict=True):
        if is_cut:
            previous = 0.5
            has_detection = False
            misses = 0
        if value is None:
            misses += 1
            if not has_detection or misses > max_hold_misses:
                previous = 0.5
                has_detection = False
            filled.append(previous)
            continue

        current = min(max(value, 0.0), 1.0)
        misses = 0
        if not has_detection or abs(current - previous) >= cut_threshold:
            smoothed = current
        else:
            smoothed = previous + alpha * (current - previous)
        filled.append(smoothed)
        previous = smoothed
        has_detection = True
    return filled


def choose_prominent_face(faces, *, source_width: int) -> float:
    """Return the normalized x center of the largest detected face."""
    if source_width <= 0 or len(faces) == 0:
        raise ValueError("at least one face and a positive source width are required")
    x, _y, width, _height = max(faces, key=lambda face: face[2] * face[3])
    return (x + width / 2) / source_width


def build_crop_expression(
    times: list[float],
    centers: list[float],
    *,
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
) -> str:
    """Build a piecewise FFmpeg crop-x expression following normalized face centers."""
    if not times or len(times) != len(centers):
        raise ValueError("face track times and centers must be non-empty and equally sized")
    if source_width <= 0 or source_height <= 0:
        raise ValueError("source dimensions must be positive")

    scale_factor = max(output_width / source_width, output_height / source_height)
    scaled_width = round(source_width * scale_factor)
    if scaled_width % 2:
        scaled_width += 1
    maximum_x = max(scaled_width - output_width, 0)
    positions = [
        min(max(round(center * scaled_width - output_width / 2), 0), maximum_x)
        for center in centers
    ]
    expression = str(positions[-1])
    for index in range(len(positions) - 2, -1, -1):
        expression = f"if(lt(t,{times[index + 1]:.3f}),{positions[index]},{expression})"
    return expression


def detect_face_track(
    source: Path,
    *,
    start: float,
    end: float,
    sample_interval: float = 0.75,
) -> tuple[list[float], list[float], int, int]:
    """Sample faces and scene changes, returning a safe clip-relative crop track."""
    try:
        import cv2
    except ImportError as exc:  # pragma: no cover - exercised without optional extra
        raise RuntimeError(
            "face-track mode requires the vision extra: uv sync --extra vision"
        ) from exc

    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open source video: {source}")
    source_width = round(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_height = round(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if source_width <= 0 or source_height <= 0:
        capture.release()
        raise RuntimeError("OpenCV could not determine source dimensions")

    cascade = cv2.CascadeClassifier(
        str(Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml")
    )
    times: list[float] = []
    raw_centers: list[float | None] = []
    cuts: list[bool] = []
    relative_time = 0.0
    previous_thumbnail = None
    minimum_face = max(round(min(source_width, source_height) * 0.08), 24)
    while relative_time < end - start:
        capture.set(cv2.CAP_PROP_POS_MSEC, (start + relative_time) * 1000)
        ok, frame = capture.read()
        center: float | None = None
        is_cut = False
        if ok:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            thumbnail = cv2.resize(gray, (64, 36))
            if previous_thumbnail is not None:
                change = cv2.absdiff(thumbnail, previous_thumbnail).mean() / 255
                is_cut = change >= 0.18
            previous_thumbnail = thumbnail
            equalized = cv2.equalizeHist(gray)
            faces = cascade.detectMultiScale(
                equalized,
                scaleFactor=1.1,
                minNeighbors=4,
                minSize=(minimum_face, minimum_face),
            )
            if len(faces):
                center = choose_prominent_face(faces, source_width=source_width)
        times.append(relative_time)
        raw_centers.append(center)
        cuts.append(is_cut)
        relative_time += sample_interval
    capture.release()
    return times, smooth_face_track(raw_centers, cuts=cuts), source_width, source_height
