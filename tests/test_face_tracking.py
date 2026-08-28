import pytest

from ai_clipper.face_tracking import build_crop_expression, choose_prominent_face, smooth_face_track


def test_smooth_face_track_fills_gaps_and_limits_small_jitter():
    track = smooth_face_track([0.25, None, 0.27, 0.75, None], alpha=0.5, cut_threshold=0.2)

    assert track == pytest.approx([0.25, 0.25, 0.26, 0.75, 0.75])


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


def test_crop_expression_clamps_face_center_inside_scaled_frame():
    expression = build_crop_expression(
        [0.0, 0.5, 1.0],
        [0.0, 0.5, 1.0],
        source_width=640,
        source_height=360,
        output_width=360,
        output_height=640,
    )

    assert expression == "if(lt(t,0.500),0,if(lt(t,1.000),389,778))"


def test_crop_expression_supports_an_already_portrait_source():
    assert build_crop_expression(
        [0.0],
        [0.5],
        source_width=720,
        source_height=1280,
        output_width=720,
        output_height=1280,
    ) == "0"
