#!/usr/bin/env python3
"""The CI parity suites (plan §10, §11.4 T4.4): the gate runners ``run_all.sh`` calls that the
older gate scripts do not already provide, the evidence built from the browser half, and the
summary that decides the job.

Every evidence file of a CI run is ``<dir>/CI-<gate>.json`` and says pass in one of the shapes
``gate_passed`` reads. Suites (``REQUIRED``):

* ``smoke`` (every pull request): P-TIME (FFmpeg and JASSUB sides), the P-TXT subset, a
  300-frame P-FRAME, G-DET, P-AUD (server) and R10;
* ``toolchain`` (a new toolchain or JASSUB pin): P-TIME, the full P-TXT matrix, P-ENC, P-COLOR
  and P-RT with R10, the evidence ``toolchain_guard.py`` stamps;
* ``full`` (nightly): ``toolchain`` plus P-FRAME (≥ 2,000 frames), P-PLATE, G1/G2, G-DET,
  PF-RENDER, the audio gates and the glyph probe.

CLI (inside the production image, ``PYTHONPATH=src:tests``)::

    ci_gates.py p-time --evidence DIR [--jobs N]
    ci_gates.py p-frame-smoke --evidence DIR
    ci_gates.py p-aud --evidence DIR
    ci_gates.py p-enc --fixtures DIR --evidence DIR --baseline FILE
    ci_gates.py text --browser DIR --fixtures DIR --evidence DIR --jassub VERSION [--color]
    ci_gates.py summary --suite smoke|toolchain|full DIR...
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import frame_identity as fi

PREFIX = "CI-"
GATE_FORMAT = "gbrp"  # the S-COLOR decision (docs/editor/SPIKES.md §1)
SMOKE_P_FRAME_MIN_FRAMES = 300  # plan §10.1 P-FRAME: 300 frames on a pull request
PTIME_RATES = 5

_TOOLCHAIN_GATES = ("P-TIME-ffmpeg", "P-TIME-jassub", "P-TXT", "P-ENC", "P-COLOR", "P-RT", "R10")
REQUIRED: dict[str, tuple[str, ...]] = {
    "smoke": ("P-TIME-ffmpeg", "P-TIME-jassub", "P-TXT", "P-FRAME", "G-DET", "P-AUD", "R10"),
    "toolchain": _TOOLCHAIN_GATES,
    "full": _TOOLCHAIN_GATES + ("P-FRAME", "P-PLATE", "G1-G2", "G-DET", "P-AUD", "G-CLICK", "duck",
                                "G3", "G3b", "glyph-probe"),
}

# Two barcode sources with the geometry of the full gate's cases (20 cuts and a cold open each):
# 470 output frames each, so the smoke shows 940 frames, over the 300 of the plan.
SMOKE_P_FRAME_CASES = (
    fi.Case("smoke_cfr_29.97", (30000, 1001), 760, "fit_blur", hook=True),
    fi.Case("smoke_vfr_30", (30, 1), 760, "fill_center", vfr=True, drop_every=11),
)


class CiGateError(ValueError):
    """An input of the evidence step is not what the gate was measured on."""


def gate_passed(doc: Mapping[str, Any]) -> bool | None:
    """True or False for a gate, None for a report-only measurement."""
    if isinstance(doc.get("pass"), bool):
        return doc["pass"]
    runs = doc.get("runs")
    if isinstance(runs, Mapping) and runs:
        verdicts = [gate_passed(run) for run in runs.values() if isinstance(run, Mapping)]
        decided = [verdict for verdict in verdicts if verdict is not None]
        return all(decided) if decided else None
    summary = doc.get("summary")
    if isinstance(summary, Mapping) and isinstance(summary.get("pass"), bool):
        return summary["pass"]
    for key in ("mismatches", "failures"):
        if isinstance(doc.get(key), int) and not isinstance(doc.get(key), bool):
            return doc[key] == 0
    return None


def summarise(directories: Iterable[Path], required: Sequence[str]) -> tuple[list[dict], bool]:
    """One row per evidence file (and per missing required gate); ok when nothing failed."""
    rows: list[dict] = []
    seen: set[str] = set()
    for directory in directories:
        for path in sorted(Path(directory).glob(f"{PREFIX}*.json")):
            gate = path.stem[len(PREFIX):]
            seen.add(gate)
            try:
                verdict = gate_passed(json.loads(path.read_text(encoding="utf-8")))
                result = {True: "pass", False: "FAIL", None: "report"}[verdict]
            except (OSError, ValueError, AttributeError):
                result = "unreadable"
            rows.append({"gate": gate, "result": result, "file": str(path)})
    rows += [{"gate": gate, "result": "missing", "file": None} for gate in required
             if gate not in seen]
    ok = all(row["result"] in ("pass", "report") for row in rows)
    return rows, ok


def frame_totals_pass(totals: Mapping[str, int], min_frames: int) -> bool:
    """``frame_identity.p_frame``'s verdict with another frame minimum."""
    return (totals["final_frames"] >= min_frames and totals["plate_output_frames"] >= min_frames
            and not totals["final_mismatches"] and not totals["plate_mismatches"]
            and not totals["plate_cell_mismatches"] and not totals["plate_cells_with_wrong_length"]
            and not totals["grid_undecodable"])


def ptime_jassub_evidence(browser: Mapping[str, Any]) -> dict[str, Any]:
    """The JASSUB side of P-TIME from the spec's ``p_time_jassub.json``."""
    clips = list(browser.get("clips") or [])
    keys = ("clip", "fps", "transitions", "hazard_transitions", "frames_rendered", "mismatches",
            "control_one_frame_late_mismatches")
    return {
        "gate": "P-TIME (JASSUB side)", "threshold": {"mismatches": 0, "rates": PTIME_RATES},
        "browser": browser.get("browserVersion"), "jassub": browser.get("jassub"),
        "clips": [{key: clip.get(key) for key in keys} for clip in clips],
        "transitions": sum(clip["transitions"] for clip in clips),
        "hazard_transitions": sum(clip["hazard_transitions"] for clip in clips),
        "mismatches": sum(clip["mismatches"] for clip in clips),
        # the one-frame-late control must flag every edge, or the check could not see an error
        "pass": (len(clips) == PTIME_RATES
                 and all(clip["mismatches"] == 0
                         and clip["control_one_frame_late_mismatches"] == clip["transitions"] > 0
                         for clip in clips)),
    }


def ptxt_evidence(scored: Mapping[str, Any], fmt: str = GATE_FORMAT) -> dict[str, Any]:
    """P-TXT from ``compare.py p-txt`` for the shipped compositing format."""
    entry = (scored.get("formats") or {}).get(fmt)
    if entry is None:
        raise CiGateError(f"no P-TXT results for {fmt}")
    return {
        "gate": "P-TXT", "gate_format": fmt, "thresholds": scored.get("thresholds"),
        "reference": "FFmpeg composite before 4:2:0, BT.709 to RGB",
        "frames": entry["frames_scored"], "clips": sorted(entry["clips"]),
        "worst_gated": entry["worst_gated"], "failures": entry["gate"]["failures"][:20],
        "pass": bool(entry["gate"]["pass"]) and entry["frames_scored"] > 0,
    }


def check_browser_jassub(browser: Mapping[str, Any], pinned: str) -> None:
    if browser.get("jassub") != pinned:
        raise CiGateError(f"the browser drew with JASSUB {browser.get('jassub')}, the pin is {pinned}")


def perf_report(directories: Iterable[Path], *, stack: str = "") -> dict[str, Any]:
    """The performance measurements of a run in one file: every PF-* and layout-switch result.

    Times on shared CI runners are indicative (plan §10.3 budgets are for the reference laptop
    and the production containers)."""
    entries = []
    for directory in directories:
        directory = Path(directory)
        for path in sorted(directory.rglob("*.json")):
            if "PF-" not in path.name and "switch" not in path.name:
                continue
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            verdict = gate_passed(doc) if isinstance(doc, Mapping) else None
            entries.append({"file": str(path.relative_to(directory)),
                            "result": {True: "within budget", False: "over budget",
                                       None: "report"}[verdict],
                            "measurement": doc})
    return {"schema": "potongin.perf-report/1", "stack": stack, "entries": entries}


def _finite(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return "inf" if value > 0 else "-inf"
    if isinstance(value, Mapping):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def write(directory: Path, gate: str, value: Mapping[str, Any]) -> Path:
    path = Path(directory) / f"{PREFIX}{gate}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_finite(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


# --- gate runners ------------------------------------------------------------------------------


def p_frame_smoke(evidence: Path) -> bool:
    with tempfile.TemporaryDirectory(prefix="ci-p-frame-") as tmp:
        result = fi.p_frame(fi.Workspace(Path(tmp)), SMOKE_P_FRAME_CASES)
    result.update(threshold={"min_frames": SMOKE_P_FRAME_MIN_FRAMES, "mismatches": 0},
                  scope="pull-request smoke", toolchain=fi._toolchain())
    result["pass"] = frame_totals_pass(result["totals"], SMOKE_P_FRAME_MIN_FRAMES)
    write(evidence, "P-FRAME", result)
    return result["pass"]


def p_time(evidence: Path, jobs: int) -> bool:
    """The FFmpeg side of P-TIME at all five rates (``support.edit_v2_text``)."""
    from support import edit_v2_text as text

    report = text.run_ptime(jobs=jobs)
    report["toolchain"] = text._toolchain()
    report["pass"] = report["mismatches"] == 0 and report["events"] > 0
    write(evidence, "P-TIME-ffmpeg", report)
    return report["pass"]


def p_aud(evidence: Path) -> bool:
    from support import edit_v2_audio_harness as harness

    harness.set_backend("compiler")
    with tempfile.TemporaryDirectory(prefix="ci-p-aud-") as tmp:
        report = harness.p_aud(Path(tmp) / "paud")
    report.update(backend="compiler", ffmpeg=harness._ffmpeg_version())
    report["pass"] = report["failures"] == 0
    write(evidence, "P-AUD", report)
    return report["pass"]


def p_enc(fixtures: Path, evidence: Path, baseline: Path) -> bool:
    import enc_check

    reference = json.loads(baseline.read_text(encoding="utf-8"))
    measured = enc_check.measure_fixtures(fixtures, formats=(GATE_FORMAT,), baseline=reference)
    entry = measured["formats"][GATE_FORMAT]
    result = {
        "gate": "P-ENC", "format": GATE_FORMAT, "thresholds": measured["thresholds"],
        "baseline": str(baseline), "baseline_tolerance": measured["baseline_tolerance"],
        "domain": measured["domain"], "min_ssim_all": entry["min_ssim_all"],
        "min_ssim_text": entry["min_ssim_text"], "mean_ssim_all": entry["mean_ssim_all"],
        "mean_ssim_text": entry["mean_ssim_text"], "failures": entry["gate"]["failures"],
        "clips": {cid: {key: clip[key] for key in ("ssim_all", "ssim_text", "pass", "gate")}
                  for cid, clip in entry["clips"].items()},
        "pass": bool(entry["gate"]["pass"]),
    }
    write(evidence, "P-ENC", result)
    return result["pass"]


def text_gates(browser: Path, fixtures: Path, evidence: Path, *, jassub: str, color: bool) -> bool:
    p_time = json.loads((browser / "p_time_jassub.json").read_text(encoding="utf-8"))
    check_browser_jassub(p_time, jassub)
    passed = write(evidence, "P-TIME-jassub", ptime_jassub_evidence(p_time))
    p_txt = ptxt_evidence(json.loads((browser / "p_txt.json").read_text(encoding="utf-8")))
    p_txt.update(browser=p_time.get("browserVersion"), jassub=p_time.get("jassub"))
    write(evidence, "P-TXT", p_txt)
    ok = gate_passed(json.loads(passed.read_text())) and p_txt["pass"]
    if color:
        import s_color

        scored = s_color.score_p_color(fixtures, browser, formats=(GATE_FORMAT,))
        entry = scored["formats"][GATE_FORMAT]
        result = {
            "gate": "P-COLOR", "format": GATE_FORMAT,
            "threshold": {"max_abs_mean_delta": scored["max_abs_delta"]},
            "compared": "delivered MP4 (decoded as BT.709) minus JASSUB composite, interior fills",
            "browser": p_time.get("browserVersion"), "jassub": p_time.get("jassub"),
            "worst_max_abs_mean_delta": entry["worst_max_abs_mean_delta"],
            "colors": {name: {"max_abs_mean_delta": c["max_abs_mean_delta"], "pixels": c["pixels"],
                              "pass": c["pass"]} for name, c in entry["colors"].items()},
            "failures": entry["gate"]["failures"], "pass": bool(entry["gate"]["pass"]),
        }
        write(evidence, "P-COLOR", result)
        ok = ok and result["pass"]
    return bool(ok)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("p-time", "p-frame-smoke", "p-aud"):
        commands.add_parser(name).add_argument("--evidence", type=Path, required=True)
    commands.choices["p-time"].add_argument("--jobs", type=int, default=4)
    enc = commands.add_parser("p-enc")
    enc.add_argument("--fixtures", type=Path, required=True)
    enc.add_argument("--evidence", type=Path, required=True)
    enc.add_argument("--baseline", type=Path, required=True)
    text = commands.add_parser("text")
    text.add_argument("--browser", type=Path, required=True)
    text.add_argument("--fixtures", type=Path, required=True)
    text.add_argument("--evidence", type=Path, required=True)
    text.add_argument("--jassub", required=True)
    text.add_argument("--color", action="store_true")
    summary = commands.add_parser("summary")
    summary.add_argument("--suite", choices=sorted(REQUIRED), required=True)
    summary.add_argument("--out", type=Path)
    summary.add_argument("directories", type=Path, nargs="+")
    perf = commands.add_parser("perf-report")
    perf.add_argument("--out", type=Path, required=True)
    perf.add_argument("--stack", default="")
    perf.add_argument("directories", type=Path, nargs="+")
    args = parser.parse_args(argv)

    if args.command == "perf-report":
        report = perf_report(args.directories, stack=args.stack)
        args.out.write_text(json.dumps(_finite(report), indent=2, sort_keys=True) + "\n",
                            encoding="utf-8")
        for entry in report["entries"]:
            print(f"{entry['result']:>14}  {entry['file']}")
        return 0
    if args.command == "summary":
        rows, ok = summarise(args.directories, REQUIRED[args.suite])
        for row in rows:
            print(f"{row['result']:>10}  {row['gate']}")
        if args.out:
            args.out.write_text(json.dumps({"suite": args.suite, "ok": ok, "gates": rows},
                                           indent=2) + "\n", encoding="utf-8")
        return 0 if ok else 1
    if args.command == "p-time":
        ok = p_time(args.evidence, args.jobs)
    elif args.command == "p-frame-smoke":
        ok = p_frame_smoke(args.evidence)
    elif args.command == "p-aud":
        ok = p_aud(args.evidence)
    elif args.command == "p-enc":
        ok = p_enc(args.fixtures, args.evidence, args.baseline)
    else:
        ok = text_gates(args.browser, args.fixtures, args.evidence, jassub=args.jassub,
                        color=args.color)
    print(f"{args.command}: {'pass' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
