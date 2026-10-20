import pytest

from ai_clipper.edit_v2 import camera
from ai_clipper.face_tracking import (
    NO_FACE_MIN_SECONDS,
    build_crop_expression,
    choose_prominent_face,
    no_face_seconds,
    smooth_face_track,
)


def test_smooth_face_track_fills_gaps_and_limits_small_jitter():
    track = smooth_face_track([0.25, None, 0.27, 0.75, None], alpha=0.5, cut_threshold=0.2)

    assert track == pytest.approx([0.25, 0.25, 0.25, 0.75, 0.75])


def test_smooth_face_track_defaults_to_center_when_no_face_is_found():
    assert smooth_face_track([None, None]) == [0.5, 0.5]


def test_smooth_face_track_does_not_backfill_leading_misses_from_future_face():
    assert smooth_face_track([None, None, 0.8]) == pytest.approx([0.5, 0.5, 0.8])


def test_smooth_face_track_resets_to_center_on_cut_without_detection():
    assert smooth_face_track(
        [0.2, None, None],
        cuts=[False, True, False],
    ) == pytest.approx([0.2, 0.5, 0.5])


def test_choose_prominent_face_uses_largest_area_not_previous_location():
    faces = [(20, 10, 80, 80), (400, 10, 160, 160)]

    assert choose_prominent_face(faces, source_width=640) == pytest.approx(0.75)


def test_crop_expression_interpolates_instead_of_jumping_between_samples():
    expression = build_crop_expression(
        [0.0, 0.5, 1.0],
        [0.0, 0.5, 1.0],
        source_width=640,
        source_height=360,
        output_width=360,
        output_height=640,
    )

    assert expression == (
        "if(lt(t,0.500),0+(389-0)*(t-0.000)/0.500,"
        "if(lt(t,1.000),389+(778-389)*(t-0.500)/0.500,778))"
    )


def test_crop_expression_does_not_pan_across_a_scene_cut():
    expression = build_crop_expression(
        [0.0, 0.5, 1.0],
        [0.2, 0.2, 0.8],
        cuts=[False, False, True],
        source_width=640,
        source_height=360,
        output_width=360,
        output_height=640,
    )

    assert "if(lt(t,1.000),48," in expression


def test_crop_expression_supports_an_already_portrait_source():
    assert build_crop_expression(
        [0.0],
        [0.5],
        source_width=720,
        source_height=1280,
        output_width=720,
        output_height=1280,
    ) == "0"


def _grid(count: int, step: float = 0.75) -> list[float]:
    times, t = [], 0.0
    for _ in range(count):
        times.append(t)
        t += step  # the detector's own accumulation
    return times


def test_no_face_seconds_counts_only_the_runs_the_crop_centres():
    times = _grid(12)
    # 2 misses (1.5 s, the last face is held), then 3 misses (2.25 s), then a trailing run.
    centres = [0.4, None, None, 0.4, None, None, None, 0.4, 0.4, 0.4, None, None]

    assert no_face_seconds(times, centres, 9.5) == pytest.approx(2.25 + (9.5 - 7.5))
    assert no_face_seconds(times, centres, 9.0) == pytest.approx(2.25)  # 1.5 s at the end: held
    assert NO_FACE_MIN_SECONDS == camera.NO_FACE_MIN_MS / 1000


def test_no_face_seconds_is_the_whole_track_without_any_face_and_zero_with_faces():
    times = _grid(8)

    assert no_face_seconds(times, [None] * 8, 6.0) == pytest.approx(6.0)
    assert no_face_seconds(times, [0.5] * 8, 6.0) == 0.0
    assert no_face_seconds([0.0], [None], 1.2) == 0.0  # shorter than a held gap


@pytest.mark.parametrize("pattern", [
    "x..xxx.xxxx..x", "......", "xxxxxx", "x.x.x.x.", "..xxx...xxxx", "xxx..x",
])
def test_no_face_seconds_matches_the_camera_plans_no_face_spans(pattern):
    times = _grid(len(pattern))
    centres = [None if mark == "x" else 0.5 for mark in pattern]
    end = len(pattern) * 0.75 - 0.2
    spans = camera._no_face([round(t * 1000) for t in times], centres, round(end * 1000))

    expected = sum(b - a for a, b in spans) / 1000
    assert no_face_seconds(times, centres, end) == pytest.approx(expected)
