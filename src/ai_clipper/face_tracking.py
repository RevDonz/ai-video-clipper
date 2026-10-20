"""Face-track crop paths for portrait reframing: smoothing, the crop expression and the track.

OpenCV stays out of this module's import: the detection (``face_window``) is imported when a
track is asked for.
"""

from __future__ import annotations

from pathlib import Path

# A gap without a face up to this long keeps the last framing; a longer run is cropped at the
# centre (edit_v2.camera lists such runs as ``no_face`` with the same rule).
NO_FACE_MIN_SECONDS = 1.5


def smooth_face_track(
    centers: list[float | None],
    *,
    cuts: list[bool] | None = None,
    alpha: float = 0.35,
    cut_threshold: float = 0.22,
    dead_zone: float = 0.025,
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
        distance = abs(current - previous)
        if not has_detection or distance >= cut_threshold:
            smoothed = current
        elif distance <= dead_zone:
            smoothed = previous
        else:
            smoothed = previous + alpha * (current - previous)
        filled.append(smoothed)
        previous = smoothed
        has_detection = True
    return filled


def build_crop_expression(
    times: list[float],
    centers: list[float],
    *,
    cuts: list[bool] | None = None,
    source_width: int,
    source_height: int,
    output_width: int,
    output_height: int,
) -> str:
    """Build a piecewise FFmpeg crop-x expression following normalized face centers."""
    if not times or len(times) != len(centers):
        raise ValueError("face track times and centers must be non-empty and equally sized")
    if cuts is None:
        cuts = [False] * len(times)
    if len(cuts) != len(times):
        raise ValueError("cut flags must match face track length")
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
        duration = times[index + 1] - times[index]
        if duration <= 0:
            raise ValueError("face track times must be strictly increasing")
        if cuts[index + 1] or positions[index] == positions[index + 1]:
            segment = str(positions[index])
        else:
            segment = (
                f"{positions[index]}+({positions[index + 1]}-{positions[index]})*"
                f"(t-{times[index]:.3f})/{duration:.3f}"
            )
        expression = f"if(lt(t,{times[index + 1]:.3f}),{segment},{expression})"
    return expression


def no_face_seconds(times: list[float], centres: list[float | None], end: float) -> float:
    """Seconds of a raw track (``detect_face_track(..., smooth=False)``) inside runs without a
    face longer than ``NO_FACE_MIN_SECONDS``: from a run's first sample to the next sample, or
    to ``end`` (the range's length) for a run at the end."""
    total = 0.0
    run_start: float | None = None
    for time, centre in zip(times, centres, strict=True):
        if centre is None:
            if run_start is None:
                run_start = time
            continue
        if run_start is not None and time - run_start > NO_FACE_MIN_SECONDS:
            total += time - run_start
        run_start = None
    if run_start is not None and end - run_start > NO_FACE_MIN_SECONDS:
        total += end - run_start
    return total


def detect_face_track(
    source: Path,
    *,
    start: float,
    end: float,
    sample_interval: float = 0.75,
    smooth: bool = True,
) -> tuple[list[float], list[float | None], list[bool], int, int]:
    """Sample the speaking face and scene changes, returning a clip-relative crop track.

    The work is ``face_window.detect_window``: the window decoded once, YuNet faces every
    ``sample_interval`` seconds and the face whose mouth moves (see ``speaker_track``). A switch
    to a speaker far across the frame is flagged in ``cuts`` like a scene cut, so the crop jumps
    instead of panning.

    ``smooth=False`` returns the raw centres instead (``None`` where no face was found), so the
    Editor V3 camera plan can smooth them itself and report the no-face runs (plan §5.7); the
    legacy render path keeps the default.
    """
    from .face_window import detect_window

    times, raw_centers, cuts, source_width, source_height = detect_window(
        source, start=start, end=end, sample_interval=sample_interval)
    centers = smooth_face_track(raw_centers, cuts=cuts) if smooth else raw_centers
    return times, centers, cuts, source_width, source_height
