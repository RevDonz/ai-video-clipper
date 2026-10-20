"""The speaker-framing evaluation harness (``scripts/eval/speaker_framing.py``): window choice,
ground truth, the miss count and the gates, on hand-made data (no network, no footage)."""

from __future__ import annotations

import importlib.util
import io
import json
import tarfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "eval" / "speaker_framing.py"


@pytest.fixture(scope="module")
def harness():
    spec = importlib.util.spec_from_file_location("speaker_framing", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def face(x1, x2, speaking):
    return (x1, 0.1, x2, 0.4, speaking)


def test_the_best_window_counts_only_its_kind(harness):
    steps = {}
    for step in range(9000, 9600):
        two = 9100 <= step < 9300
        faces = {"a": face(0.1, 0.2, two), "b": face(0.7, 0.8, False)} if two else {
            "a": face(0.4, 0.5, True)}
        steps[step] = faces
    assert harness._best_window(steps, harness._multi, None) == (9100, 200)
    single = harness._best_window(steps, harness._single, (9100, 9300))
    assert single == (9300, 200)  # the first window after the multi one, not overlapping it


def test_ground_truth_lists_the_speaking_centres_per_step(harness):
    steps = {9001: {"a": face(0.1, 0.3, True), "b": face(0.6, 0.8, False)}}
    truth = harness.ground_truth(steps, {"start": 900.0, "duration": 0.3})
    assert truth == [[], [pytest.approx(0.2)], []]


def test_a_crop_on_the_speaker_hits_and_one_elsewhere_misses(harness):
    size = (1920, 1080)  # the 720×1280 crop is 31.6 % of the width
    truth = [[0.2]] * 10 + [[]] * 5
    times = [0.0, 0.75, 1.5]
    hit = harness.misses(truth, times, [0.2, 0.2, 0.2], [False] * 3, size)
    assert hit == (0, 10)
    miss = harness.misses(truth, times, [0.8, 0.8, 0.8], [False] * 3, size)
    assert miss == (10, 10)
    centred = harness.misses(truth, times, [None, None, None], [False] * 3, size)
    assert centred == (10, 10)  # no face: the centred crop does not reach x = 0.2


def row(clip_id, kind, haar, speaker, speech=100, seconds=(1.0, 0.5)):
    return {"id": clip_id, "kind": kind, "duration": 20.0,
            "seconds": {"haar": seconds[0], "speaker": seconds[1]},
            "haar": {"missed": haar, "speech": speech, "cuts": 0, "pans": 0},
            "largest": {"missed": haar, "speech": speech, "cuts": 0, "pans": 0},
            "speaker": {"missed": speaker, "speech": speech, "cuts": 0, "pans": 0}}


def test_the_gates_pass_only_on_a_clear_improvement(harness):
    good = [row(f"m{i}", "multi", 40, 15) for i in range(6)] + [
        row(f"s{i}", "single", 10, 5) for i in range(4)]
    summary = harness.summarise(good)
    assert summary["pass"] and all(summary["checks"].values())
    assert len(summary["better_windows"]) == 6 and summary["worse_windows"] == []

    slight = [row(f"m{i}", "multi", 40, 36) for i in range(6)]
    assert not harness.summarise(slight)["checks"]["multi_relative"]

    single_worse = good[:6] + [row(f"s{i}", "single", 5, 10) for i in range(4)]
    assert not harness.summarise(single_worse)["checks"]["single_tolerance"]

    slower = [row(f"m{i}", "multi", 40, 15, seconds=(1.0, 2.0)) for i in range(6)]
    assert not harness.summarise(slower)["checks"]["time"]

    mixed = [row(f"m{i}", "multi", 40, 10) for i in range(5)] + [
        row(f"w{i}", "multi", 10, 30) for i in range(2)]
    checks = harness.summarise(mixed)["checks"]
    assert not checks["clip_ratio"]  # 5 better, 2 worse: fewer than 3 × 2


def test_annotations_are_read_from_the_archive(harness, tmp_path):
    rows = "vid1,900.02,0.1,0.1,0.3,0.4,SPEAKING_AUDIBLE,vid1_900_960:1\n" \
           "vid1,900.04,0.6,0.1,0.8,0.4,NOT_SPEAKING,vid1_900_960:2\n"
    archive = tmp_path / "val.tar.bz2"
    with tarfile.open(archive, "w:bz2") as tar:
        data = rows.encode()
        info = tarfile.TarInfo("ava_activespeaker_test_v1.0/vid1-activespeaker.csv")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    videos = harness.read_annotations(archive)
    assert set(videos) == {"vid1"}
    assert videos["vid1"][9000] == {"vid1_900_960:1": (0.1, 0.1, 0.3, 0.4, True),
                                    "vid1_900_960:2": (0.6, 0.1, 0.8, 0.4, False)}


def test_the_committed_set_is_well_formed(harness):
    document = json.loads((SCRIPT.parents[2] / "docs" / "evaluation" / "speaker-framing"
                           / "set-val.json").read_text(encoding="utf-8"))
    assert document["schema"] == harness.SET_SCHEMA
    assert document["annotations"] == {"url": harness.ANNOTATIONS["val"][0],
                                       "sha256": harness.ANNOTATIONS["val"][1]}
    kinds = [clip["kind"] for clip in document["clips"]]
    assert kinds.count("multi") == 24 and kinds.count("single") == 26
    assert len({clip["id"] for clip in document["clips"]}) == len(kinds)
    for clip in document["clips"]:
        assert clip["duration"] == 20.0 and 900 <= clip["start"] <= 1780
        assert clip["steps"] >= harness.MIN_STEPS
