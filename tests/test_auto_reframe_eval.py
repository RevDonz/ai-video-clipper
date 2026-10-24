"""The auto-reframe evaluation harness (``scripts/eval/auto_reframe.py``): grid, cut matching,
mode agreement, label checks, the split, the sweep's choice rules and the test-split lock, on
hand-made data (no network, no footage)."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "eval" / "auto_reframe.py"
REGISTRY = ROOT / "docs" / "evaluation" / "TRAINING_SOURCE_REGISTRY.json"
LABELS = ROOT / "docs" / "evaluation" / "auto-reframe"


@pytest.fixture(scope="module")
def harness():
    spec = importlib.util.spec_from_file_location("auto_reframe", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- grid ----------------------------------------------------------------------------------------


def test_the_window_sits_on_the_document_grid(harness):
    assert harness.window_grid(60_000, 120_000, (30, 1)) == (1800, 5400)
    # 29.97: the first frame at or after the start, and ⌊120 s · rate⌋ frames
    first, end = harness.window_grid(60_000, 120_000, (30000, 1001))
    assert first == 1799  # ⌈60000 · 30000 / 1001000⌉ = ⌈1798.2⌉
    assert end - first == 3596


def test_the_document_rate_follows_the_seed_rules(harness):
    assert harness.document_fps((60, 1), vfr=False) == (30, 1)
    assert harness.document_fps((60000, 1001), vfr=False) == (30000, 1001)
    assert harness.document_fps((25, 1), vfr=False) == (25, 1)
    assert harness.document_fps((25, 1), vfr=True) == (30, 1)


# --- cuts ----------------------------------------------------------------------------------------


def test_cuts_match_one_to_one_within_one_frame(harness):
    assert harness.match_cuts([100, 201, 305], [101, 200, 300]) == (2, 1, 1)
    # two predictions near one label: only one of them counts
    assert harness.match_cuts([99, 101], [100]) == (1, 1, 0)
    # the most pairs: 101↔102 and 102↔103, not 102↔102 alone
    assert harness.match_cuts([101, 102], [102, 103]) == (2, 0, 0)
    assert harness.match_cuts([], []) == (0, 0, 0)
    assert harness.match_cuts([10], [], tolerance=1) == (0, 1, 0)


def test_cut_scores_on_empty_sets(harness):
    assert harness.cut_scores(0, 0, 0) == {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    scores = harness.cut_scores(9, 1, 3)
    assert scores["precision"] == pytest.approx(0.9)
    assert scores["recall"] == pytest.approx(0.75)
    assert scores["f1"] == pytest.approx(2 * 0.9 * 0.75 / 1.65)
    assert harness.cut_scores(0, 2, 0)["f1"] == 0.0


def test_camera_plan_cut_flags_land_on_their_sample_frame(harness):
    plan = {"samples": [[0, 500], [750, 500], [1500, 300], [2250, 300]],
            "cuts": [False, False, True, False]}
    assert harness.camera_cut_sf(plan, first_sf=1000, fps=(30, 1)) == [1045]
    # a flag on the first sample is not a cut inside the window
    plan["cuts"] = [True, False, False, False]
    assert harness.camera_cut_sf(plan, first_sf=1000, fps=(30, 1)) == []


def test_scene_cut_times_round_to_the_nearest_frame(harness):
    times = [0.0, 1.0333, 2.5, 119.9, 119.99, 125.0]
    assert harness.scene_cut_sf(times, first_sf=500, fps=(30, 1), frames=3600) == [
        531, 575, 4097]


# --- modes ---------------------------------------------------------------------------------------


def test_agreement_counts_frames_with_the_same_mode(harness):
    window = (100, 200)
    label = ([150], ["camera", "fit_blur"])
    assert harness.agreement(window, ([], ["camera"]), label) == (50, 100)
    assert harness.agreement(window, ([140, 160], ["camera", "fill_center", "fit_blur"]),
                             label) == (80, 100)
    assert harness.agreement(window, label, label) == (100, 100)


# --- labels --------------------------------------------------------------------------------------


def _entry(**overrides):
    entry = {"id": "rf-01", "fps": [30, 1], "window_sf": [1800, 5400],
             "cuts_sf": [2000, 3000], "modes": ["camera", "fit_blur", "camera"]}
    entry.update(overrides)
    return entry


def _window(**overrides):
    window = {"id": "rf-01", "source_id": "s1", "category": "single_speaker", "start_ms": 60_000,
              "duration_ms": 120_000, "split": "dev", "fps": [30, 1]}
    window.update(overrides)
    return window


def test_a_valid_label_passes(harness):
    harness.check_label(_entry(), _window())


@pytest.mark.parametrize("change", [
    {"cuts_sf": [3000, 2000]},  # not increasing
    {"cuts_sf": [2000, 2000], "modes": ["camera", "camera", "camera"]},
    {"cuts_sf": [1800]},  # the first frame is not a cut
    {"cuts_sf": [5400]},  # outside the window
    {"modes": ["camera", "fit_blur"]},  # one mode per shot
    {"modes": ["camera", "zoom", "camera"]},
    {"window_sf": [1800, 5399]},  # not the window's grid
    {"fps": [30000, 1001]},  # not the window's rate
    {"extra": 1},
])
def test_bad_labels_are_refused(harness, change):
    with pytest.raises(harness.LabelError):
        harness.check_label(_entry(**change), _window())


def test_an_unlabelled_entry_is_allowed_only_as_a_placeholder(harness):
    placeholder = _entry(cuts_sf=None, modes=None)
    harness.check_label(placeholder, _window(), allow_empty=True)
    with pytest.raises(harness.LabelError):
        harness.check_label(placeholder, _window())


# --- the set and the split -----------------------------------------------------------------------


def test_window_starts_are_seeded_and_inside_the_source(harness):
    first = harness.window_start_ms(600.0, seed=7, window_id="rf-01")
    assert first == harness.window_start_ms(600.0, seed=7, window_id="rf-01")
    assert first % 1000 == 0
    assert 60_000 <= first <= 600_000 * 0.9 - 120_000
    # too short for the 10 % / 90 % band: the latest start that still fits
    assert harness.window_start_ms(130.0, seed=7, window_id="x") == 10_000


def test_the_split_is_stratified_by_category_and_keeps_sources_together(harness):
    windows = []
    for category, count in (("single_speaker", 4), ("two_person", 3), ("panel", 2)):
        for index in range(count):
            windows.append({"id": f"{category}-{index}", "source_id": f"{category}-{index}",
                            "category": category})
    windows.append({"id": "panel-extra", "source_id": "panel-0", "category": "panel"})
    split = harness.assign_splits(windows, seed=11)
    assert split == harness.assign_splits(windows, seed=11)
    assert split["panel-extra"] == split["panel-0"]
    for category, dev in (("single_speaker", 2), ("two_person", 1)):
        ids = [w["id"] for w in windows if w["category"] == category]
        assert sum(split[i] == "dev" for i in ids) == dev  # odd: dev gets fewer


# --- sweep ---------------------------------------------------------------------------------------


def test_the_sweep_grid_is_the_documented_one(harness):
    grid = harness.SWEEP_GRID
    assert grid["cut.coarse_scene_pm"] == (200, 250, 300, 350, 400)
    assert grid["cut.refine_diff_pm"] == (60, 80, 100, 130, 160)
    assert grid["cut.min_gap_ms"] == (300, 500, 800)
    assert grid["face.present_pm"] == (300, 400, 500, 600)
    assert grid["face.small_w_pm"] == (40, 60, 80, 100)
    assert grid["face.centre_pm"] == (60, 100, 140)
    assert grid["speakers.active_pm"] == (100, 150, 200)
    assert grid["speakers.split_share_pm"] == (200, 250, 300, 350)
    assert grid["motion.still_pm"] == (20, 40, 60)
    assert len(list(harness.configs("cut."))) == 75


def test_stage_one_picks_the_best_f1_that_meets_both_floors(harness):
    rows = [
        {"config": {"cut.coarse_scene_pm": 200, "cut.min_gap_ms": 300}, "precision": 0.99,
         "recall": 0.89, "f1": 0.94},  # recall too low
        {"config": {"cut.coarse_scene_pm": 250, "cut.min_gap_ms": 300}, "precision": 0.96,
         "recall": 0.92, "f1": 0.9396},
        {"config": {"cut.coarse_scene_pm": 300, "cut.min_gap_ms": 500}, "precision": 0.96,
         "recall": 0.92, "f1": 0.9396},  # tie: larger min_gap wins
        {"config": {"cut.coarse_scene_pm": 400, "cut.min_gap_ms": 500}, "precision": 0.96,
         "recall": 0.92, "f1": 0.9396},  # then larger coarse_scene wins
    ]
    assert harness.pick_cut_config(rows)["cut.coarse_scene_pm"] == 400
    assert harness.pick_cut_config(rows[:1]) is None


def test_stage_two_breaks_ties_with_fewer_non_camera_frames(harness):
    rows = [{"config": {"k": 1}, "agreement": 0.86, "non_camera_frames": 900},
            {"config": {"k": 2}, "agreement": 0.86, "non_camera_frames": 400},
            {"config": {"k": 3}, "agreement": 0.80, "non_camera_frames": 0}]
    assert harness.pick_mode_config(rows) == {"k": 2}


# --- gates and the test-split lock ---------------------------------------------------------------


def test_the_gates_are_the_documented_ones(harness):
    assert harness.GATES == {"cut_precision": 0.95, "cut_recall": 0.90, "scan_base_s": 15.0,
                             "scan_per_cut_s": 0.5, "agreement": 0.85,
                             "speaker_framing_multi": 0.217, "owner_accepts": [8, 10]}
    assert harness.scan_budget_s(4) == 17.0


def test_the_test_split_runs_once_and_only_on_purpose(harness, tmp_path):
    lock = tmp_path / "test-run.json"
    with pytest.raises(harness.TestSplitLocked):
        harness.check_test_lock(lock, confirm=False)
    harness.check_test_lock(lock, confirm=True)
    lock.write_text("{}", encoding="utf-8")
    with pytest.raises(harness.TestSplitLocked):
        harness.check_test_lock(lock, confirm=True)


# --- the committed set ---------------------------------------------------------------------------


def test_the_registry_keeps_old_sources_and_records_open_licences(harness):
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    ids = {source.get("video_id") for source in registry["sources"]}
    assert {"DwTmRFyQ53E", "XAY4QYP2sIQ", "0dzvz9JZFIM", "Ive926sC6mc", "0K37SYfox7M"} <= ids
    harness.check_registry(registry)
    block = registry["reframe_eval"]
    assert isinstance(block["split"]["seed"], int)
    assert {w["split"] for w in block["windows"]} == {"dev", "test"}


def test_the_committed_labels_match_the_registry(harness):
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    for split, allow_empty in (("dev", False), ("test", True)):
        labels = json.loads((LABELS / f"labels.{split}.json").read_text(encoding="utf-8"))
        harness.check_labels(labels, registry, split, allow_empty=allow_empty)
