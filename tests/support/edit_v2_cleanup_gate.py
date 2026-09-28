"""QG-CLEAN (plan §7.3, §10.2; T3.5): Rapikan on the labelled set and on a real clip.

Stdlib only, so the gate also runs in the toolchain image (which has no pytest)::

    PYTHONPATH=src:tests python -m support.edit_v2_cleanup_gate labels OUT.json

**Labelled set** (``tests/fixtures/edit_v2/fillers-labelled.json``): samples of consecutive
words (``[s_ms, e_ms, text]``) from the synthetic job and the owner's real transcripts, each with
the audio-timeline ``silences`` and the laughter spans around it, and labels on word indices
(the rubric is in the file):

* ``filler`` / ``not_filler`` — a filler-lexicon token that is / is not a removable filler;
* ``particle`` — a protected particle (must never be listed);
* ``reduplication`` — both words of a reduplicated word (must never be listed);
* ``emphatic`` — a deliberate repetition (never listed);
* ``stutter`` — the removable (earlier) occurrence of a restarted word or phrase;
* ``not_repeat`` — the same word twice with different roles (never listed as a repeat).

``borderline`` marks labels a reasonable editor could flip; precision is reported as labelled
and with every borderline label flipped. Each sample is rebuilt as a words artifact
(:func:`sample_artifact`; the detector reads tokens, their timing, the silences and laughter)
and run through ``cleanup.build_cleanup``. The gate numbers: tokens, reduplication pairs,
particles covered, false positives per never-listed class, and filler precision over **every**
filler hit in the samples (each hit must carry a label). Filler and stutter recall, repeat
precision and the per-form filler precision are informational.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import cleanup

ROOT = Path(__file__).resolve().parents[2]
LABELLED = ROOT / "tests" / "fixtures" / "edit_v2" / "fillers-labelled.json"
LABELS = ("filler", "not_filler", "particle", "reduplication", "emphatic", "stutter",
          "not_repeat")
NEVER_LISTED = ("particle", "reduplication", "emphatic", "not_repeat")
FPS = [30000, 1001]


def labels_of(sample: Mapping[str, Any]) -> list[dict[str, Any]]:
    """The sample's labels with ``i`` always a list of word indices."""
    result = []
    for label in sample["labels"]:
        indexes = label["i"] if isinstance(label["i"], list) else [label["i"]]
        if label["label"] not in LABELS:
            raise ValueError(f"unknown label {label['label']!r} in {sample['id']}")
        result.append({**label, "i": indexes})
    return result


def sample_artifact(sample: Mapping[str, Any]) -> dict[str, Any]:
    """A ``potongin.words/1``-shaped artifact of the sample (no bounds, gaps or peaks)."""
    words = [{"id": f"w{index:06d}", "s": s, "e": e, "t": text, "p_pm": None, "u": None,
              "z": False} for index, (s, e, text) in enumerate(sample["words"])]
    window = [max(0, words[0]["s"] - 1000), words[-1]["e"] + 1000]
    events = [{"kind": "laughter", "s": s, "e": e, "src": "transcript"}
              for s, e in sample.get("laughter", ())]
    return {"schema": "potongin.words/1", "clip_id": "clip_" + "0" * 24,
            "transcript_sha256": "0" * 64, "fps": FPS, "window_ms": window, "words": words,
            "units": [], "bounds": [], "gaps": [], "events": events,
            "silences": [list(span) for span in sample.get("silences", ())],
            "scene_cuts_ms": [], "peaks": None, "missing": []}


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def evaluate_labelled(data: Mapping[str, Any], *, lexicon: cleanup.Lexicon | None = None
                      ) -> dict[str, Any]:
    lexicon = cleanup.load_lexicon() if lexicon is None else lexicon
    counts = {label: 0 for label in LABELS}
    tokens = 0
    sources: dict[str, int] = {"real": 0, "synthetic": 0, "authored": 0}
    particles: set[str] = set()
    fp = {label: 0 for label in NEVER_LISTED}
    hits = {"true": 0, "false": 0, "true_flipped": 0}
    by_form: dict[str, list[int]] = {}
    filler_labelled = filler_found = unlabelled = 0
    stutter_runs = stutter_found = 0
    repeat_hits = {"stutter": 0, "other": 0}
    misses: list[dict[str, Any]] = []
    for sample in data["samples"]:
        sources[sample["source"]] += 1
        artifact = sample_artifact(sample)
        result = cleanup.build_cleanup(artifact, lexicon=lexicon)
        index_of = {word["id"]: k for k, word in enumerate(artifact["words"])}
        listed: dict[int, str] = {}
        for item in result["items"]:
            for word_id in item.get("wordIds", ()):
                listed[index_of[word_id]] = item["kind"]
        label_at: dict[int, dict[str, Any]] = {}
        for label in labels_of(sample):
            name = label["label"]
            counts[name] += 1
            tokens += len(label["i"])
            for k in label["i"]:
                if k in label_at:
                    raise ValueError(f"word {k} of {sample['id']} is labelled twice")
                label_at[k] = label
            if name == "particle":
                particles |= {cleanup.normalize(sample["words"][k][2]) for k in label["i"]}
            if name in fp:
                wrong = [k for k in label["i"] if k in listed]
                fp[name] += len(wrong)
                if wrong:
                    misses.append({"sample": sample["id"], "label": name, "i": wrong,
                                   "listed": listed[wrong[0]]})
            if name == "filler":
                filler_labelled += len(label["i"])
                filler_found += sum(listed.get(k) == "filler" for k in label["i"])
            if name == "stutter":
                stutter_runs += 1
                if all(listed.get(k) == "repeat" for k in label["i"]):
                    stutter_found += 1
        for k, kind in sorted(listed.items()):
            label = label_at.get(k)
            if kind == "repeat":
                repeat_hits["stutter" if label and label["label"] == "stutter" else "other"] += 1
                continue
            form = cleanup.normalize(sample["words"][k][2])
            if label is None:
                unlabelled += 1
                misses.append({"sample": sample["id"], "label": None, "i": [k], "listed": kind})
                continue
            true = label["label"] == "filler"
            flipped = true != bool(label.get("borderline"))
            hits["true" if true else "false"] += 1
            hits["true_flipped"] += flipped
            by_form.setdefault(form, [0, 0])[0 if true else 1] += 1
            if not true:
                misses.append({"sample": sample["id"], "label": label["label"], "i": [k],
                               "listed": kind, "borderline": bool(label.get("borderline"))})
    total = hits["true"] + hits["false"]
    status = data.get("status", {})
    return {
        "gate": "QG-CLEAN (labelled set)",
        "lexicon": {"version": lexicon.version, "sha256": lexicon.sha256,
                    "filler_precheck": lexicon.filler_precheck},
        "samples": len(data["samples"]),
        "sources": sources,
        "tokens": tokens,
        "labels": counts,
        "borderline_labels": sum(bool(label.get("borderline")) for sample in data["samples"]
                                 for label in sample["labels"]),
        "reduplication_pairs": counts["reduplication"],
        "particles_covered": sorted(particles),
        "particle_false_positives": fp["particle"],
        "reduplication_false_positives": fp["reduplication"],
        "emphatic_false_positives": fp["emphatic"],
        "not_repeat_false_positives": fp["not_repeat"],
        "filler_hits": total,
        "filler_true_hits": hits["true"],
        "filler_precision": _ratio(hits["true"], total),
        "filler_precision_borderline_flipped": _ratio(hits["true_flipped"], total),
        "filler_precision_by_form": {form: {"true": t, "false": f, "precision": _ratio(t, t + f)}
                                     for form, (t, f) in sorted(by_form.items())},
        "filler_recall": _ratio(filler_found, filler_labelled),
        "unlabelled_filler_hits": unlabelled,
        "stutter_runs": stutter_runs,
        "stutter_recall": _ratio(stutter_found, stutter_runs),
        "repeat_hit_tokens": repeat_hits,
        "repeat_precision": _ratio(repeat_hits["stutter"], sum(repeat_hits.values())),
        "owner_confirmed": bool(status.get("owner_confirmed")),
        "misses": misses,
    }


def _write(path: Path, data: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m support.edit_v2_cleanup_gate")
    commands = parser.add_subparsers(dest="command", required=True)
    labels = commands.add_parser("labels", help="QG-CLEAN numbers on the labelled set")
    labels.add_argument("out", type=Path)
    labels.add_argument("--fixture", type=Path, default=LABELLED)
    args = parser.parse_args(argv)
    if args.command == "labels":
        report = evaluate_labelled(json.loads(args.fixture.read_text()))
        _write(args.out, report)
        print(json.dumps({key: report[key] for key in (
            "tokens", "reduplication_pairs", "particle_false_positives",
            "reduplication_false_positives", "filler_precision")}))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
