"""The auto-reframe evaluation harness (``scripts/eval/auto_reframe.py``): grid, cut matching,
mode agreement, label checks, the split, the sweep's choice rules and the test-split lock, on
hand-made data (no network, no footage)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
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


def test_saved_predictions_are_scored_against_a_label(harness):
    prediction = {"id": "rf-01", "fps": [30, 1], "window_sf": [1800, 5400], "sample_frames": 22,
                  "camera_plan_cuts_sf": [2010, 3100], "scene_cuts_sf": [2000, 3001, 4000],
                  "no_face_ms": [[0, 1000]], "seconds": {"camera_plan": 4.2, "scene_pass": 1.1}}
    label = _entry()
    row = harness.score_today(prediction, label)
    assert row["cuts"] == 2
    assert row["camera_plan_cuts"] == {"found": 2, "frame": [0, 2, 2], "sample": [1, 1, 1]}
    assert row["scene_cuts"] == {"found": 3, "frame": [2, 1, 0], "sample": [2, 1, 0]}
    assert row["agreement_camera"] == 200 + 2400  # frames of the two camera shots
    assert row["agreement_fit_blur"] == 1000
    # today's render centres the first 30 frames (no face), so they leave the camera count
    assert row["agreement_today"] == 170 + 2400
    with pytest.raises(harness.LabelError):
        harness.score_today({**prediction, "window_sf": [1801, 5401]}, label)


@pytest.mark.parametrize(("no_face_ms", "expected"), [
    ([], ([], ["camera"])),
    ([[1000, 2500]], ([1830, 1875], ["camera", "fill_center", "camera"])),
    ([[0, 1600]], ([1848], ["fill_center", "camera"])),
    ([[119_000, 120_000]], ([5370], ["camera", "fill_center"])),
    ([[1000, 2500], [2500, 4000]], ([1830, 1920], ["camera", "fill_center", "camera"])),
    ([[0, 120_000]], ([], ["fill_center"])),
])
def test_today_centres_the_no_face_runs(harness, no_face_ms, expected):
    # seed.py writes layout.default.no_face = "center" (CONTRACTS §5.40), so a camera-plan
    # no_face span renders as a centre crop, on the frames layouts.no_face_frames picks
    assert harness.today_modes(no_face_ms, [30, 1], [1800, 5400]) == expected


def _row(name, cuts, frame):
    return {"id": name, "frames": 100, "cuts": cuts,
            "seconds": {"camera_plan": 1.0, "scene_pass": 1.0},
            "camera_plan_cuts": {"found": 0, "frame": [0, 0, cuts], "sample": [0, 0, cuts]},
            "scene_cuts": {"found": frame[0] + frame[1], "frame": frame, "sample": frame},
            "agreement_camera": 0, "agreement_fit_blur": 0, "agreement_today": 0,
            "label_frames": {"camera": 0, "fill_center": 0, "fit_blur": 100, "split": 0}}


def test_the_summary_reports_per_window_scores_next_to_the_pooled_ones(harness):
    rows = [_row("rf-01", 40, [40, 0, 0]), _row("rf-02", 2, [0, 0, 2]), _row("rf-03", 0, [0, 0, 0])]
    block = harness.summarise(rows, {})["all"]
    assert block["scene_cuts"]["recall"] == round(40 / 42, 4)
    # windows without a labelled cut have no recall; windows without a found cut no precision
    assert block["scene_cuts_per_window"] == {"precision": 1.0, "recall": 0.5,
                                              "windows_with_cuts": 2}
    assert block["most_cuts"] == {"id": "rf-01", "cuts": 40, "share": round(40 / 42, 4)}


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


def _profiled_window(harness, *, cuts, faces_until):
    """A profiled 120 s dev window at 25 fps (frames 0–3000): hard cuts where ``cuts`` are and
    one centred, still face in every sample before ``faces_until`` (frames), none after."""
    from ai_clipper.edit_v2.shot_cuts import LAGS

    n = 3000
    diff = [0] * n
    scene = [0] * n
    for cut in cuts:
        diff[cut] = 40_000
        scene[cut] = 50_000
    lag = {}
    for distance in LAGS:
        lag[str(distance)] = [min(sum(diff[max(k - distance + 1, 0):k + 1]), 100_000)
                              if k >= distance else 0 for k in range(n)]
    lag["1"] = diff
    times = [i * 0.75 for i in range(160)]
    samples = [{"cut": False,
                "faces": [[880, 300, 160, 200, 0.4]] if t * 25 < faces_until else []}
               for t in times]
    return {"id": "rf-90", "fps": [25, 1], "window_sf": [0, n], "window_ms": [0, 120_000],
            "profile": {"first_sf": 0, "scene_e5": scene, "lag": lag},
            "scan": {"times": times, "width": 1920, "height": 1080,
                     "frame_diff": [0.01] * len(times), "samples": samples},
            "coarse_cuts_ms": [], "seconds": {"shot_cuts_measure": 4.0, "evidence_scan": 3.0}}


def test_the_sweep_runs_both_stages_on_profiles(harness, tmp_path):
    registry = {"reframe_eval": {"windows": [
        {"id": "rf-90", "split": "dev", "category": "single_speaker", "fps": [25, 1],
         "start_ms": 0, "duration_ms": 120_000}]}}
    labels = {"schema": harness.LABELS_SCHEMA, "split": "dev", "windows": [
        {"id": "rf-90", "fps": [25, 1], "window_sf": [0, 3000], "cuts_sf": [1000, 2000],
         "modes": ["fill_center", "fill_center", "fit_blur"]}]}
    profiles = {"schema": harness.PROFILE_SCHEMA, "split": "dev", "opencv": "x", "python": "3",
                "windows": [_profiled_window(harness, cuts=[1000, 2000], faces_until=2000)]}
    result = harness.sweep(profiles, labels, registry)
    assert result["cut"]["gate_met"] is True
    assert (result["cut"]["precision"], result["cut"]["recall"]) == (1.0, 1.0)
    assert result["mode"]["agreement"] == 1.0
    assert len(result["stage1"]) == 75 and "cuts" not in result["stage1"][0]
    assert set(result["chosen"]) == set(harness.SWEEP_GRID)
    assert result["scan"] == {"windows_within_budget": 1, "windows": 1, "max_measure_s": 4.0}
    assert result["by_category"]["single_speaker"]["agreement"] == 1.0
    # the test split never goes through the sweep, and the profiles must be dev ones
    with pytest.raises(harness.LabelError):
        harness.sweep({**profiles, "split": "test"}, labels, registry)


def test_the_chosen_values_are_written_to_the_rules_file(harness, tmp_path):
    from ai_clipper.edit_v2.shots import load_rules

    target = tmp_path / "rules.v1.json"
    target.write_text(harness.RULES_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    chosen = {key: values[0] for key, values in harness.SWEEP_GRID.items()}
    rules_id = harness.write_rules(chosen, target)
    rules = load_rules(target)
    assert rules.rules_id == rules_id
    assert rules.cut_coarse_scene_pm == 200 and rules.motion_still_pm == 20
    assert rules.scan_timeout_s == load_rules(harness.RULES_PATH).scan_timeout_s


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


def test_the_label_page_lists_the_fetched_windows(harness, tmp_path):
    windows = [_window(id="rf-01"), _window(id="rf-02", source_id="s2")]
    (tmp_path / "windows").mkdir()
    info = {"id": "rf-01", "fps": [30, 1], "window_sf": [1800, 5400], "frames": 3600}
    (tmp_path / "windows" / "rf-01.json").write_text(json.dumps(info), encoding="utf-8")
    page = harness.label_page(windows[:1], "test", tmp_path)
    assert '"id": "rf-01"' in page and "rf-02" not in page
    assert (tmp_path / "windows" / "rf-01.mp4").resolve().as_uri() in page
    assert harness.LABELS_SCHEMA in page
    assert "<\\/" not in page.split("const DATA = ", 1)[0]
    with pytest.raises(FileNotFoundError):
        harness.label_page(windows, "test", tmp_path)


def _export(harness, data, state):
    script = (harness.EXPORT_JS + "\nconst [data, state] = JSON.parse(process.argv[1]);"
              "\nprocess.stdout.write(JSON.stringify(exportLabels(data, state)));")
    out = subprocess.run(["node", "-e", script, json.dumps([data, state])],
                         capture_output=True, text=True, check=True, timeout=30)
    return json.loads(out.stdout)


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node")
def test_the_label_page_exports_only_the_windows_marked_done(harness):
    registry = {"reframe_eval": {"windows": [_window(id="rf-01", split="test"),
                                             _window(id="rf-02", split="test"),
                                             _window(id="rf-03", split="test")]}}
    data = {"schema": harness.LABELS_SCHEMA, "split": "test", "windows": [
        {"id": name, "fps": [30, 1], "window_sf": [1800, 5400]}
        for name in ("rf-01", "rf-02", "rf-03")]}
    state = {"rf-01": {"cuts": [200], "modes": ["camera", "fit_blur"], "done": True},
             "rf-02": {"cuts": [], "modes": ["camera"]}}  # opened, never marked done
    labels = _export(harness, data, state)
    by_id = {entry["id"]: entry for entry in labels["windows"]}
    assert by_id["rf-01"]["cuts_sf"] == [2000] and by_id["rf-01"]["modes"] == ["camera", "fit_blur"]
    for name in ("rf-02", "rf-03"):
        assert by_id[name]["cuts_sf"] is None and by_id[name]["modes"] is None
    with pytest.raises(harness.LabelError, match="not labelled"):
        harness.check_labels(labels, registry, "test")
    harness.check_labels(labels, registry, "test", allow_empty=True)
    state.update({"rf-02": {"cuts": [], "modes": ["camera"], "done": True},
                  "rf-03": {"cuts": [], "modes": ["split"], "done": True}})
    harness.check_labels(_export(harness, data, state), registry, "test")


def test_the_label_page_carries_the_export_and_a_done_mark(harness, tmp_path):
    (tmp_path / "windows").mkdir()
    info = {"id": "rf-01", "fps": [30, 1], "window_sf": [1800, 5400], "frames": 3600}
    (tmp_path / "windows" / "rf-01.json").write_text(json.dumps(info), encoding="utf-8")
    page = harness.label_page([_window(id="rf-01")], "test", tmp_path)
    assert harness.EXPORT_JS in page
    assert 'id="done"' in page


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
