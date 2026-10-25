"""The automatic layout's decisions and its shot plan file (``edit_v2.shots``, rombak 04 §A5–§A6,
CONTRACTS §5.63)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import AUTO_SPLIT, errors, shots
from ai_clipper.edit_v2.shots import (
    Shot,
    ShotEvidence,
    build_shot_plan,
    canonical_ranges,
    crop_width_pm,
    decide_shot,
    load_rules,
    merge_user_ranges,
    plan_shots,
    read_shot_plan,
    write_shot_plan,
)
from ai_clipper.edit_v2.source_info import canonical_json
from ai_clipper.edit_v2.timemap import Fps

VECTORS = json.loads((Path(__file__).parent / "fixtures" / "edit_v2" / "shot-vectors.json")
                     .read_text(encoding="utf-8"))
RULES = load_rules()
CROP = 316  # the 9:16 crop of a 16:9 source


def evidence(**values) -> ShotEvidence:
    base = {"samples": 8, "face_share_pm": 1000, "faces_p90": 1, "face_w_med_pm": 150,
            "speakers": 1, "talk_share_pm": (900,), "spread_pm": 150, "centre_dev_pm": 250,
            "motion_med_pm": 80}
    return ShotEvidence(**{**base, **values})


# --- rules -----------------------------------------------------------------------------------


def test_the_rules_file_holds_every_key_as_an_integer():
    raw = json.loads(shots.RULES_FILE.read_text(encoding="utf-8"))
    assert shots.parse_rules(raw) == RULES
    assert RULES.rules_id == canonical_sha16(raw)
    assert all(type(getattr(RULES, key)) is int for key in shots.RULE_KEYS)


def canonical_sha16(value) -> str:
    import hashlib

    return hashlib.sha256(canonical_json(value)).hexdigest()[:16]


def test_other_values_have_another_rules_id():
    changed = RULES.with_values({"cut.min_gap_ms": RULES.cut_min_gap_ms + 1})
    assert changed.rules_id != RULES.rules_id
    assert changed.with_values({"cut.min_gap_ms": RULES.cut_min_gap_ms}).rules_id == \
        RULES.rules_id
    with pytest.raises(ValueError):
        RULES.with_values({"cut.unknown": 1})


@pytest.mark.parametrize("change", [
    lambda r: r.pop("motion"),
    lambda r: r["cut"].update(extra=1),
    lambda r: r["face"].update(present_pm=1.5),
    lambda r: r["face"].update(present_pm=-1),
    lambda r: r["scan"].update(timeout_s=0),
    lambda r: r.update(schema="other"),
])
def test_a_malformed_rules_file_is_refused(change):
    raw = json.loads(shots.RULES_FILE.read_text(encoding="utf-8"))
    change(raw)
    with pytest.raises(ValueError):
        shots.parse_rules(raw)


# --- the decision table (§A5) -------------------------------------------------------------------


def test_the_crop_width_of_a_wide_source():
    assert crop_width_pm((1920, 1080), (720, 1280)) == CROP
    assert crop_width_pm((1280, 720), (1080, 1920)) == CROP
    assert crop_width_pm((1920, 1080), (720, 720)) == 563  # 1:1
    assert crop_width_pm((1920, 1080), (720, 1280), zoom_pm=1500) == 211
    assert crop_width_pm((720, 1280), (720, 1280)) == 1000


@pytest.mark.parametrize(("values", "expected"), [
    ({"face_share_pm": RULES.face_present_pm - 1}, ("fit_blur", "rf_no_face")),
    ({"speakers": 2, "talk_share_pm": (600, RULES.speakers_split_share_pm),
      "spread_pm": CROP + 1}, ("camera", "rf_two_speakers")),
    ({"faces_p90": 3, "spread_pm": CROP + 1}, ("fit_blur", "rf_group_wide")),
    ({"face_w_med_pm": RULES.face_small_w_pm - 1}, ("fit_blur", "rf_small_face")),
    ({"centre_dev_pm": RULES.face_centre_pm, "motion_med_pm": RULES.motion_still_pm},
     ("fill_center", "rf_centred")),
    ({}, ("camera", "rf_face")),
])
def test_each_rule_of_the_table(values, expected):
    assert decide_shot(evidence(**values), crop_w_pm=CROP, rules=RULES,
                       split_enabled=False) == expected


def test_two_speakers_in_a_wide_shot_split_only_when_the_split_chain_exists():
    two = evidence(speakers=2, talk_share_pm=(600, 400), spread_pm=500)
    assert decide_shot(two, crop_w_pm=CROP, rules=RULES, split_enabled=True) == \
        ("split", "rf_two_speakers")
    assert AUTO_SPLIT is False  # until the RF-M2 spike passes
    assert decide_shot(two, crop_w_pm=CROP, rules=RULES) == ("camera", "rf_two_speakers")


def test_the_first_matching_rule_wins():
    # no face beats everything, two speakers beat the group, the group beats small faces
    assert decide_shot(evidence(face_share_pm=0, faces_p90=4, spread_pm=900), crop_w_pm=CROP,
                       rules=RULES)[1] == "rf_no_face"
    assert decide_shot(evidence(speakers=2, talk_share_pm=(500, 500), faces_p90=3,
                                spread_pm=900), crop_w_pm=CROP, rules=RULES)[1] == \
        "rf_two_speakers"
    assert decide_shot(evidence(faces_p90=3, spread_pm=900, face_w_med_pm=10), crop_w_pm=CROP,
                       rules=RULES)[1] == "rf_group_wide"
    # two speakers who fit in one crop are framed like one
    assert decide_shot(evidence(speakers=2, talk_share_pm=(500, 500), spread_pm=CROP),
                       crop_w_pm=CROP, rules=RULES)[1] == "rf_face"


# --- plan_shots -------------------------------------------------------------------------------


def test_a_short_shot_takes_its_longer_neighbours_mode():
    blur = evidence(face_share_pm=0)
    short = evidence(samples=1)
    planned = plan_shots([100, 120], (0, 400), [evidence(), short, blur], crop_w_pm=CROP,
                         rules=RULES)
    assert [(s.mode, s.reason) for s in planned] == [
        ("camera", "rf_face"), ("fit_blur", "rf_short_merged"), ("fit_blur", "rf_no_face")]
    # equal neighbours: the left one
    planned = plan_shots([100, 120], (0, 220), [evidence(), short, blur], crop_w_pm=CROP,
                         rules=RULES)
    assert planned[1].mode == "camera"
    # the neighbour is short too: the nearest decided shot
    planned = plan_shots([100, 120, 140], (0, 400), [blur, short, short, evidence()],
                         crop_w_pm=CROP, rules=RULES)
    assert [s.mode for s in planned] == ["fit_blur", "camera", "camera", "camera"]


def test_a_window_of_only_short_shots_is_decided_as_a_whole():
    short = evidence(samples=1)
    planned = plan_shots([20], (0, 40), [short, short], crop_w_pm=CROP, rules=RULES,
                         whole=evidence(face_share_pm=0, samples=2))
    assert [(s.mode, s.reason) for s in planned] == [("fit_blur", "rf_no_face")] * 2


def test_neighbouring_shots_with_one_mode_are_one_range():
    planned = [Shot(0, 10, "camera", "rf_face", evidence()),
               Shot(10, 30, "camera", "rf_short_merged", evidence()),
               Shot(30, 50, "fit_blur", "rf_no_face", evidence())]
    assert shots.ranges_of(planned) == [{"in_sf": 0, "out_sf": 30, "mode": "camera"},
                                        {"in_sf": 30, "out_sf": 50, "mode": "fit_blur"}]


def test_cuts_must_lie_inside_the_window():
    for cuts in ([0], [10, 10], [400], [50, 20]):
        with pytest.raises(ValueError):
            shots.shot_bounds(cuts, (0, 400))


# --- layout.ranges (§A6) -------------------------------------------------------------------------


@pytest.mark.parametrize("case", VECTORS["canonical"], ids=lambda c: c["name"])
def test_canonical_ranges_vectors(case):
    assert canonical_ranges(case["ranges"], case["default_mode"]) == case["expected"]


@pytest.mark.parametrize("case", VECTORS["merge"], ids=lambda c: c["name"])
def test_merge_user_ranges_vectors(case):
    assert merge_user_ranges(case["new_auto"], case["old"]) == case["expected"]


def test_a_user_range_is_never_overwritten_by_a_new_analysis():
    for case in VECTORS["merge"]:
        merged = merge_user_ranges(case["new_auto"], case["old"])
        first, end = case["new_auto"][0]["in_sf"], case["new_auto"][-1]["out_sf"]
        for user in (r for r in case["old"] if r["origin"] == "user"):
            lo, hi = max(user["in_sf"], first), min(user["out_sf"], end)
            for sf in range(lo, hi):
                later = [r for r in case["old"] if r["origin"] == "user"
                         and r["in_sf"] > user["in_sf"] and r["in_sf"] <= sf < r["out_sf"]]
                if later:
                    continue
                assert shots.mode_at([(r["in_sf"], r["out_sf"], r["mode"]) for r in merged],
                                     sf) == user["mode"]


def test_mode_at_answers_inside_and_outside_the_ranges():
    ranges = [(10, 20, "camera"), (20, 35, "fit_blur")]
    assert [shots.mode_at(ranges, sf) for sf in (9, 10, 19, 20, 34, 35)] == [
        None, "camera", "camera", "fit_blur", "fit_blur", None]


# --- the shot plan file ----------------------------------------------------------------------


def sample_plan(**changes):
    fps = Fps(30000, 1001)
    planned = plan_shots([36101, 36488], (36055, 39652),
                         [evidence(), evidence(face_share_pm=0), evidence(face_share_pm=0)],
                         crop_w_pm=CROP, rules=RULES)
    arguments = {"rules": RULES, "source_content_sha256": "a" * 64, "camera_sha256": "b" * 64,
                 "window_ms": (1203040, 1323040), "fps": fps, "cut_source": "shot_cuts",
                 "cuts_sf": [36101, 36488], "shots": planned}
    return build_shot_plan(**{**arguments, **changes})


def test_the_shot_plan_of_the_contract():
    plan = sample_plan()
    assert plan["schema"] == "potongin.shot-plan/1"
    assert plan["fps"] == {"num": 30000, "den": 1001}
    assert [(s["in_sf"], s["out_sf"]) for s in plan["shots"]] == [(36055, 36101),
                                                                    (36101, 36488),
                                                                    (36488, 39652)]
    assert plan["ranges"] == [{"in_sf": 36055, "out_sf": 36101, "mode": "camera"},
                              {"in_sf": 36101, "out_sf": 39652, "mode": "fit_blur"}]
    assert plan["split"] is None and plan["rules_id"] == RULES.rules_id


def test_the_shot_plan_round_trips_through_its_file(tmp_path):
    plan = sample_plan()
    name, sha = write_shot_plan(tmp_path, plan)
    raw = (tmp_path / name).read_bytes()
    assert name == shots.shot_file_name(raw) and raw == canonical_json(plan)
    assert oct((tmp_path / name).stat().st_mode & 0o777) == "0o600"
    assert read_shot_plan(tmp_path / name) == plan
    assert shots.load_shot_plan(tmp_path, sha) == plan
    assert write_shot_plan(tmp_path, plan) == (name, sha)  # the same bytes again


def _write(path: Path, raw: bytes) -> Path:
    target = path / shots.shot_file_name(raw)
    target.write_bytes(raw)
    return target


@pytest.mark.parametrize("change", [
    lambda p: p.update(extra=1),
    lambda p: p["shots"][0].update(mode="split"),
    lambda p: p["shots"][0]["evidence"].update(samples="8"),
    lambda p: p["shots"][1].update(in_sf=36100),
    lambda p: p["ranges"].append({"in_sf": 39652, "out_sf": 39700, "mode": "camera"}),
    lambda p: p["ranges"][0].update(mode="fit_blur"),
    lambda p: p["ranges"][0].update(origin="auto"),
    lambda p: p.update(cut_source="guess"),
    lambda p: p.update(cut_source="none"),
    lambda p: p.update(fps={"num": 60, "den": 1}),
    lambda p: p.update(rules_id="xyz"),
])
def test_a_malformed_shot_plan_is_analysis_missing(tmp_path, change):
    plan = sample_plan()
    change(plan)
    target = _write(tmp_path, canonical_json(plan))
    with pytest.raises(errors.AnalysisMissing) as raised:
        read_shot_plan(target)
    assert raised.value.ref == "shots"


def test_unmerged_neighbouring_ranges_are_refused(tmp_path):
    plan = sample_plan()
    plan["ranges"] = [{"in_sf": 36055, "out_sf": 36101, "mode": "camera"},
                      {"in_sf": 36101, "out_sf": 36488, "mode": "fit_blur"},
                      {"in_sf": 36488, "out_sf": 39652, "mode": "fit_blur"}]
    with pytest.raises(errors.AnalysisMissing):
        read_shot_plan(_write(tmp_path, canonical_json(plan)))


def test_a_shot_plan_whose_name_or_bytes_do_not_match_is_refused(tmp_path):
    raw = canonical_json(sample_plan())
    wrong = tmp_path / "shots.0000000000000000.json"
    wrong.write_bytes(raw)
    with pytest.raises(errors.AnalysisMissing):
        read_shot_plan(wrong)
    pretty = json.dumps(sample_plan(), indent=1).encode()
    with pytest.raises(errors.AnalysisMissing):
        read_shot_plan(_write(tmp_path, pretty))
    big = canonical_json({"pad": "x" * shots.MAX_SHOT_PLAN_BYTES})
    with pytest.raises(errors.AnalysisMissing):
        read_shot_plan(_write(tmp_path, big))
    with pytest.raises(errors.AnalysisMissing):
        shots.load_shot_plan(tmp_path, "c" * 64)


def test_a_symlinked_shot_plan_is_never_followed(tmp_path):
    raw = canonical_json(sample_plan())
    real = tmp_path / "real.json"
    real.write_bytes(raw)
    link = tmp_path / shots.shot_file_name(raw)
    os.symlink(real, link)
    with pytest.raises(errors.AnalysisMissing):
        read_shot_plan(link)


def test_a_split_shot_needs_the_clip_split_and_its_crops():
    planned = [Shot(36055, 36101, "split", "rf_two_speakers", evidence()),
               Shot(36101, 39652, "camera", "rf_face", evidence())]
    split, places = shots.split_geometry(
        [shots.SplitHint(top=(250, 400), bottom=(750, 400))], source=(1920, 1080),
        output=(720, 1280))
    plan = sample_plan(cuts_sf=[36101], shots=planned, split=split,
                       split_xy=[places[0], None])
    assert plan["split"] == {"top_pm": 500, "top": {"zoom_pm": 1000},
                             "bottom": {"zoom_pm": 1000}}
    top, bottom = plan["ranges"][0]["split_xy"]["top"], plan["ranges"][0]["split_xy"]["bottom"]
    assert top["x_e5"] < 50_000 < bottom["x_e5"]  # the left person on top, the right below
    with pytest.raises(ValueError):
        sample_plan(cuts_sf=[36101], shots=planned)  # no clip split


# --- prepare_auto, end to end ---------------------------------------------------------------


def test_prepare_auto_shares_one_scan_and_plans_the_shots(tmp_path, edit_v2_ffmpeg, monkeypatch):
    """A window of three shots: a face that moves (camera), no face (latar blur), the face
    again. The scan is made by hand (YuNet is not what is tested here) and shared by the camera
    plan; the cuts come from the real video."""
    import hashlib

    from test_edit_v2_shot_cuts import encode
    from test_edit_v2_shot_cuts import shots as frames_of

    from ai_clipper import shot_context
    from ai_clipper.face_window import Scan, sample_times
    from ai_clipper.speaker_track import Face, Sample

    lengths = [100, 100, 100]  # 25 fps: cuts at 4.0 s and 8.0 s
    video = encode(tmp_path / "three.mp4", frames_of(lengths), "25")
    times = sample_times(0.0, 12.0, 0.75)

    def faces_at(t: float):
        if 4.0 <= t < 8.0:
            return ()
        return (Face(20 + 10 * t, 30, 30, 36, activity=0.5),)

    made = Scan(times=times, samples=[Sample(t, False, faces_at(t)) for t in times],
                width=160, height=90, frame_diff=[0.08] * len(times))
    scans = []

    def fake_scan(source, window_ms, *, progress=None):
        scans.append(window_ms)
        return made

    monkeypatch.setattr(shot_context, "scan_evidence", fake_scan)
    camera_plan, plan = shots.prepare_auto(video, (0, 12_000), Fps(25, 1), output=(720, 1280))
    assert scans == [(0, 12_000)]  # one scan for the camera plan and the evidence
    assert plan["cut_source"] == "shot_cuts" and plan["cuts_sf"] == [100, 200]
    assert [(s["mode"], s["reason"]) for s in plan["shots"]] == [
        ("camera", "rf_face"), ("fit_blur", "rf_no_face"), ("camera", "rf_face")]
    assert plan["ranges"] == [{"in_sf": 0, "out_sf": 100, "mode": "camera"},
                              {"in_sf": 100, "out_sf": 200, "mode": "fit_blur"},
                              {"in_sf": 200, "out_sf": 300, "mode": "camera"}]
    assert plan["camera_sha256"] == hashlib.sha256(canonical_json(camera_plan)).hexdigest()
    assert camera_plan["no_face"] == [[4500, 8250]]
