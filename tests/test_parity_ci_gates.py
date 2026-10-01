"""The CI parity suites (plan §10, §11.4 T4.4; ``scripts/parity/ci_gates.py``).

What runs in CI is FFmpeg and browser work; what is tested here is the part that decides: how
each evidence file says pass, which gates every suite must produce, the size of the PR smoke and
the evidence built from the browser's outputs.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import ci_gates as cg
import frame_identity as fi


def _write(path: Path, value) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


@pytest.mark.parametrize(("doc", "expected"), [
    ({"pass": True}, True),
    ({"pass": False}, False),
    ({"gate": "P-TIME (FFmpeg side)", "mismatches": 0, "events": 570}, True),
    ({"mismatches": 3}, False),
    ({"failures": 0}, True),
    ({"failures": 1}, False),
    ({"step": "r10", "summary": {"pass": True}}, True),
    ({"runs": {"reference-image-ffmpeg-5.1.9": {"pass": True}, "local": {"pass": False}}}, False),
    ({"runs": {"reference-image-ffmpeg-5.1.9": {"pass": True}}}, True),
    ({"report_only": True, "within_budget": {"p50": True}}, None),
    ({"runs": {"a": {"report_only": True}}}, None),
])
def test_every_evidence_shape_says_pass_or_report(doc, expected):
    assert cg.gate_passed(doc) is expected


def test_the_summary_fails_on_a_failed_or_missing_required_gate(tmp_path):
    _write(tmp_path / "CI-P-FRAME.json", {"pass": True})
    _write(tmp_path / "CI-P-TIME-ffmpeg.json", {"mismatches": 0})
    _write(tmp_path / "CI-PF-RENDER.json", {"report_only": True})
    rows, ok = cg.summarise([tmp_path], required=("P-FRAME", "P-TIME-ffmpeg"))
    assert ok
    assert {row["gate"]: row["result"] for row in rows} == {
        "P-FRAME": "pass", "P-TIME-ffmpeg": "pass", "PF-RENDER": "report"}
    rows, ok = cg.summarise([tmp_path], required=("P-FRAME", "G-DET"))
    assert not ok
    assert {"gate": "G-DET", "result": "missing", "file": None} in rows
    _write(tmp_path / "CI-G-DET.json", {"pass": False})
    _rows, ok = cg.summarise([tmp_path], required=("P-FRAME", "G-DET"))
    assert not ok


def test_an_unreadable_evidence_file_fails_the_summary(tmp_path):
    (tmp_path / "CI-P-AUD.json").write_text("{not json", encoding="utf-8")
    rows, ok = cg.summarise([tmp_path], required=())
    assert not ok
    assert rows[0]["result"] == "unreadable"


def test_every_suite_requires_the_gates_of_the_plan():
    assert set(cg.REQUIRED["smoke"]) == {"P-TIME-ffmpeg", "P-TIME-jassub", "P-TXT", "P-FRAME", "G-DET",
                                         "P-AUD", "R10"}
    assert set(cg.REQUIRED["toolchain"]) >= {"P-TIME-ffmpeg", "P-TIME-jassub", "P-TXT", "P-ENC", "P-COLOR",
                                             "P-RT"}
    assert set(cg.REQUIRED["full"]) >= set(cg.REQUIRED["toolchain"]) | {
        "P-FRAME", "P-PLATE", "G1-G2", "G-DET", "P-AUD", "G-CLICK", "duck", "G3", "G3b", "R10"}


def test_the_pr_smoke_shows_at_least_300_frames_with_cuts_and_a_cold_open():
    frames = 0
    for case in cg.SMOKE_P_FRAME_CASES:
        edges = fi.case_edges(case)
        body = edges["body"][1] - edges["body"][0]
        removed = sum(end - start for start, end in edges["removals"])
        cold = edges["cold_open"][1] - edges["cold_open"][0] if edges["cold_open"] else 0
        frames += body - removed + cold
        assert case.cuts == 20 and case.cold_open
    assert frames >= cg.SMOKE_P_FRAME_MIN_FRAMES == 300
    assert {case.vfr for case in cg.SMOKE_P_FRAME_CASES} == {False, True}


def test_the_smoke_frame_verdict_needs_300_frames_and_no_mismatch():
    clean = {"final_frames": 310, "final_mismatches": 0, "plate_output_frames": 310,
             "plate_mismatches": 0, "plate_cell_frames_checked": 330, "plate_cell_mismatches": 0,
             "plate_cells_with_wrong_length": 0, "grid_undecodable": 0}
    assert cg.frame_totals_pass(clean, 300)
    assert not cg.frame_totals_pass({**clean, "final_frames": 299}, 300)
    for key in ("final_mismatches", "plate_mismatches", "plate_cell_mismatches",
                "plate_cells_with_wrong_length", "grid_undecodable"):
        assert not cg.frame_totals_pass({**clean, key: 1}, 300), key


def _ptime_browser(mismatches=0, control_short=False):
    clips = [{"clip": f"timing-{fps}", "fps": [fps, 1], "transitions": 40, "hazard_transitions": 8,
              "frames_rendered": 120, "mismatches": mismatches,
              "control_one_frame_late_mismatches": 39 if control_short else 40, "details": []}
             for fps in (24, 25, 30, 24000, 30000)]
    return {"browser": "Chrome", "browserVersion": "147.0.7727.15", "jassub": "2.5.16", "clips": clips}


def test_the_jassub_side_of_p_time_needs_five_rates_no_mismatch_and_a_live_control():
    assert cg.ptime_jassub_evidence(_ptime_browser())["pass"] is True
    assert cg.ptime_jassub_evidence(_ptime_browser(mismatches=1))["pass"] is False
    assert cg.ptime_jassub_evidence(_ptime_browser(control_short=True))["pass"] is False
    four = _ptime_browser()
    four["clips"] = four["clips"][:4]
    assert cg.ptime_jassub_evidence(four)["pass"] is False
    summary = cg.ptime_jassub_evidence(_ptime_browser())
    assert summary["transitions"] == 200 and summary["hazard_transitions"] == 40
    assert summary["jassub"] == "2.5.16"


def test_p_txt_evidence_gates_on_the_shipped_format():
    scored = {"thresholds": {"ssim": 0.999}, "formats": {"gbrp": {
        "frames_scored": 30, "worst_gated": {"ssim": 0.9999}, "gate": {"pass": True, "failures": []},
        "clips": {"bold-40": {"pack": "bold", "pass": True, "gate": True, "frames": {"5": {}}}}}}}
    evidence = cg.ptxt_evidence(scored, "gbrp")
    assert evidence["pass"] is True and evidence["frames"] == 30 and evidence["clips"] == ["bold-40"]
    scored["formats"]["gbrp"]["gate"] = {"pass": False, "failures": [{"clip": "bold-40"}]}
    assert cg.ptxt_evidence(scored, "gbrp")["pass"] is False
    with pytest.raises(cg.CiGateError):
        cg.ptxt_evidence(scored, "yuv420p")
    scored["formats"]["gbrp"].update(frames_scored=0, gate={"pass": True, "failures": []})
    assert cg.ptxt_evidence(scored, "gbrp")["pass"] is False


def test_the_perf_report_collects_every_budget_measurement(tmp_path):
    _write(tmp_path / "evidence" / "CI-PF-RENDER.json", {"report_only": True, "summary": {"p50": 0.2}})
    _write(tmp_path / "app" / "evidence" / "audio" / "W3Z-PF-AUDIO.json", {"pass": False, "p95_ms": 1199.5})
    _write(tmp_path / "app" / "evidence" / "plate" / "T3.6-switch.json", {"pass": True})
    _write(tmp_path / "evidence" / "CI-P-FRAME.json", {"pass": True})
    report = cg.perf_report([tmp_path / "evidence", tmp_path / "app"], stack="4 CPU")
    rows = {entry["file"]: entry["result"] for entry in report["entries"]}
    assert rows == {"CI-PF-RENDER.json": "report", "evidence/audio/W3Z-PF-AUDIO.json": "over budget",
                    "evidence/plate/T3.6-switch.json": "within budget"}
    assert report["stack"] == "4 CPU"


def test_the_browser_must_have_drawn_with_the_pinned_jassub():
    with pytest.raises(cg.CiGateError):
        cg.check_browser_jassub(_ptime_browser(), "2.5.17")
    cg.check_browser_jassub(_ptime_browser(), "2.5.16")
