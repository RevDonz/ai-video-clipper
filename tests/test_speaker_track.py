"""Which face the face-track crop follows (``speaker_track``): the face whose mouth moves.

Pure tests on hand-made samples; ``test_face_window.py`` drives the same choice from decoded
frames.
"""

from __future__ import annotations

import pytest

from ai_clipper.speaker_track import RULES, Face, Rules, Sample, choose, link_tracks

WIDTH = 1280
LEFT = (200, 100, 120, 120)  # x, y, w, h: centre 260 → 0.203
RIGHT = (900, 100, 120, 120)  # centre 960 → 0.75
NEAR_LEFT = (260, 100, 120, 120)  # centre 320 → 0.25 (a small move from LEFT)


def face(box, activity=None):
    x, y, w, h = box
    return Face(x, y, w, h, activity)


def samples(*rows, cuts=()):
    """One sample per row of faces, 0.75 s apart; ``cuts`` are the indices preceded by a cut."""
    return [Sample(time=0.75 * index, cut=index in cuts, faces=tuple(row))
            for index, row in enumerate(rows)]


def centre(box):
    return (box[0] + box[2] / 2) / WIDTH


def test_a_single_face_is_framed_whatever_its_activity():
    track = samples([face(LEFT, 0.0)], [face(LEFT, None)], [face(NEAR_LEFT, 0.0)])
    centres, switches = choose(track, width=WIDTH)
    assert centres == [centre(LEFT), centre(LEFT), centre(NEAR_LEFT)]
    assert switches == [False, False, False]


def test_a_lone_face_far_from_the_framed_one_is_a_cut():
    # Another face across the frame without a detected scene cut: a camera change the
    # thumbnail missed, or another person. The crop cuts to it instead of panning across.
    centres, switches = choose(samples([face(LEFT)], [face(RIGHT)]), width=WIDTH)
    assert centres == [centre(LEFT), centre(RIGHT)]
    assert switches == [False, True]
    # after a sample without a face nothing is framed, so nothing switches
    _centres, switches = choose(samples([face(LEFT)], [], [face(RIGHT)]), width=WIDTH)
    assert switches == [False, False, False]


def test_no_face_gives_no_centre():
    centres, switches = choose(samples([], [face(LEFT)], []), width=WIDTH)
    assert centres == [None, centre(LEFT), None]
    assert switches == [False] * 3


def test_the_face_whose_mouth_moves_is_framed_not_the_largest():
    big_listener = (800, 80, 200, 200)
    rows = [[face(LEFT, 0.30), face(big_listener, 0.05)] for _ in range(4)]
    centres, _ = choose(samples(*rows), width=WIDTH)
    assert centres == [centre(LEFT)] * 4


def test_without_any_activity_the_largest_face_is_framed_and_equal_areas_by_position():
    big = (800, 80, 200, 200)
    centres, _ = choose(samples([face(LEFT), face(big)]), width=WIDTH)
    assert centres == [centre(big)]
    # equal areas: the leftmost, whatever order the detector listed them in
    centres, _ = choose(samples([face(RIGHT), face(LEFT)]), width=WIDTH)
    assert centres == [centre(LEFT)]


def test_a_track_score_averages_the_samples_around_it():
    # LEFT speaks loudly at samples 0-2 and is still at 3; RIGHT moves a little throughout.
    rows = [[face(LEFT, 0.4), face(RIGHT, 0.1)]] * 3 + [[face(LEFT, 0.0), face(RIGHT, 0.12)]]
    centres, _ = choose(samples(*rows), width=WIDTH, rules=Rules(window=3))
    assert centres == [centre(LEFT)] * 4  # the window still favours LEFT at sample 3
    centres, _ = choose(samples(*rows), width=WIDTH, rules=Rules(window=0))
    assert centres[3] == centre(RIGHT)  # a one-sample window follows the noise


def test_the_framed_speaker_is_kept_until_another_clearly_leads():
    rules = Rules(window=0, margin=0.05)
    rows = [[face(LEFT, 0.30), face(RIGHT, 0.10)],
            [face(LEFT, 0.20), face(RIGHT, 0.24)],  # RIGHT leads by 0.04 < margin: keep LEFT
            [face(LEFT, 0.10), face(RIGHT, 0.30)]]  # RIGHT leads by 0.20: switch
    centres, switches = choose(samples(*rows), width=WIDTH, rules=rules)
    assert centres == [centre(LEFT), centre(LEFT), centre(RIGHT)]
    assert switches == [False, False, True]


def test_a_switch_across_the_frame_is_a_cut_and_a_short_one_is_not():
    rules = Rules(window=0, margin=0.0)
    far = choose(samples([face(LEFT, 0.3), face(RIGHT, 0.1)], [face(LEFT, 0.1), face(RIGHT, 0.3)]),
                 width=WIDTH, rules=rules)
    assert far[1] == [False, True]
    assert abs(centre(RIGHT) - centre(LEFT)) >= RULES.jump
    near = choose(samples([face(LEFT, 0.3), face(NEAR_LEFT, 0.1)],
                          [face(LEFT, 0.1), face(NEAR_LEFT, 0.3)]), width=WIDTH, rules=rules)
    assert near[0] == [centre(LEFT), centre(NEAR_LEFT)]
    assert near[1] == [False, False]  # 0.047 of the width: the smoothing pans


def test_background_faces_are_never_framed():
    tiny = (1100, 300, 40, 40)  # a third of the tallest face: someone in the background
    rows = [[face(LEFT, 0.05), face(tiny, 0.9)]] * 3
    centres, _ = choose(samples(*rows), width=WIDTH)
    assert centres == [centre(LEFT)] * 3
    # alone, a small face is framed: there is nobody else
    centres, _ = choose(samples([face(tiny, 0.9)]), width=WIDTH)
    assert centres == [centre(tiny)]


def test_activity_is_not_averaged_across_a_scene_cut():
    # Before the cut LEFT spoke; after it, RIGHT speaks. A window reaching back across the cut
    # would still pick LEFT at the first sample after it.
    rows = [[face(LEFT, 0.5), face(RIGHT, 0.0)]] * 3 + [[face(LEFT, 0.0), face(RIGHT, 0.2)]] * 3
    centres, switches = choose(samples(*rows, cuts={3}), width=WIDTH, rules=Rules(window=3))
    assert centres == [centre(LEFT)] * 3 + [centre(RIGHT)] * 3
    assert switches == [False] * 6  # a scene cut is a cut already, not a speaker switch


def test_link_tracks_follows_overlapping_faces_and_restarts_at_cuts():
    moved = (210, 104, 120, 120)  # LEFT a few pixels later: the same person
    rows = samples([face(LEFT), face(RIGHT)], [face(RIGHT), face(moved)], [face(moved)],
                   cuts={2})
    assert link_tracks(rows) == [[0, 1], [1, 0], [2]]


def test_link_tracks_gives_each_previous_face_to_one_face_only():
    rows = samples([face(LEFT)], [face(LEFT), face((205, 100, 120, 120))])
    ids = link_tracks(rows)
    assert ids[0] == [0]
    assert sorted(ids[1]) == [0, 1]
    assert ids[1][0] == 0  # the face that overlaps it most continues the track


def test_choose_rejects_a_frame_without_width():
    with pytest.raises(ValueError):
        choose(samples([face(LEFT)]), width=0)
