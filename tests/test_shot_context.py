"""The evidence per shot of the automatic layout (``shot_context``, rombak 04 §A4), from scans
built by hand."""

from __future__ import annotations

import pytest

from ai_clipper import shot_context
from ai_clipper.edit_v2.shots import ShotEvidence, load_rules
from ai_clipper.edit_v2.timemap import Fps
from ai_clipper.face_window import Scan
from ai_clipper.speaker_track import Face, Sample

RULES = load_rules().with_values({"speakers.active_pm": 150})
WIDTH, HEIGHT = 1000, 562
FPS = Fps(25, 1)
LEFT = (100, 200, 120, 150)
RIGHT = (700, 210, 130, 150)


def face(box, activity=None) -> Face:
    return Face(*box, activity=activity)


def scan(samples: list[tuple[tuple[Face, ...], float]], *, cut_at: int | None = None) -> Scan:
    times = [index * 0.75 for index in range(len(samples))]
    return Scan(times=times,
                samples=[Sample(time=t, cut=index == cut_at, faces=faces)
                         for index, (t, (faces, _diff)) in enumerate(zip(times, samples,
                                                                         strict=True))],
                width=WIDTH, height=HEIGHT, frame_diff=[diff for _faces, diff in samples])


def context(samples, **kwargs) -> shot_context.Context:
    return shot_context.Context.of(scan(samples, **kwargs), window_ms=(0, 60_000), fps=FPS)


def test_one_still_face_in_the_middle():
    centred = (440, 150, 120, 160)
    ev = context([((face(centred),), 0.01)] * 6).summarize((0, 1000), rules=RULES)
    assert ev == ShotEvidence(samples=6, face_share_pm=1000, faces_p90=1, face_w_med_pm=120,
                              speakers=1, talk_share_pm=(1000,), spread_pm=120,
                              centre_dev_pm=0, motion_med_pm=10)


def test_two_people_taking_turns():
    samples = []
    for index in range(8):
        left_talks = index < 5
        samples.append(((face(LEFT, 0.6 if left_talks else 0.1),
                         face(RIGHT, 0.1 if left_talks else 0.7)), 0.02))
    ev = context(samples).summarize((0, 1000), rules=RULES)
    assert ev.speakers == 2 and ev.talk_share_pm == (625, 375)
    assert ev.spread_pm == 730  # from the left edge of LEFT to the right edge of RIGHT
    assert ev.faces_p90 == 2 and ev.face_w_med_pm == 130
    hint = context(samples).split_hint((0, 1000))
    assert hint is not None
    assert hint.top == (160, 489) and hint.bottom == (765, 507)  # the first to speak on top


def test_a_shot_without_faces_and_its_motion():
    ev = context([((), 0.3), ((), 0.05), ((), 0.1), ((face(LEFT),), 0.2)]).summarize(
        (0, 1000), rules=RULES)
    assert ev.face_share_pm == 250 and ev.faces_p90 == 1
    assert ev.motion_med_pm == 100  # the lower median of 300, 50, 100, 200
    assert ev.talk_share_pm == (1000,)  # a single face is the one speaking


def test_background_faces_are_left_out():
    tiny = (480, 20, 20, 25)  # lower than half the tallest face
    ev = context([((face(LEFT, 0.5), face(tiny, 0.9)), 0.0)] * 4).summarize(
        (0, 1000), rules=RULES)
    assert ev.faces_p90 == 1 and ev.spread_pm == 120 and ev.talk_share_pm == (1000,)


def test_several_unmeasured_faces_have_no_speaker():
    ev = context([((face(LEFT), face(RIGHT)), 0.0)] * 4).summarize((0, 1000), rules=RULES)
    assert ev.speakers == 0 and ev.talk_share_pm == ()
    # the framed face is then the largest one
    assert ev.centre_dev_pm == abs(765 - 500)


def test_a_track_under_the_active_share_is_not_a_speaker():
    samples = [((face(LEFT, 0.6), face(RIGHT, 0.1)), 0.0)] * 9
    samples.append(((face(LEFT, 0.1), face(RIGHT, 0.6)), 0.0))
    ev = context(samples).summarize((0, 1000), rules=RULES)
    assert ev.speakers == 1 and ev.talk_share_pm == (900,)


def test_a_sample_belongs_to_the_shot_of_its_grid_frame():
    ctx = context([((face(LEFT),), 0.0)] * 4 + [((), 0.0)] * 4)
    # samples at 0, 0.75, … 5.25 s: frames 0, 18, 37, 56, 75, 93, 112, 131 at 25 fps
    first = ctx.summarize((0, 75), rules=RULES)
    second = ctx.summarize((75, 200), rules=RULES)
    assert (first.samples, first.face_share_pm) == (4, 1000)
    assert (second.samples, second.face_share_pm) == (4, 0)
    assert ctx.summarize((200, 300), rules=RULES).samples == 0


def test_the_evidence_needs_the_frame_differences():
    plain = scan([((face(LEFT),), 0.0)])
    plain = Scan(plain.times, plain.samples, plain.width, plain.height)
    with pytest.raises(ValueError):
        shot_context.Context.of(plain, window_ms=(0, 1000), fps=FPS)


def test_the_evidence_scan_asks_for_the_frame_differences(monkeypatch, tmp_path):
    calls = []

    def fake(source, **kwargs):
        calls.append(kwargs)
        return "scan"

    monkeypatch.setattr(shot_context, "scan_window", fake)
    assert shot_context.scan_evidence(tmp_path / "a.mp4", (1500, 4500)) == "scan"
    assert calls == [{"start": 1.5, "end": 4.5, "sample_interval": 0.75, "progress": None,
                      "frame_diff": True}]
