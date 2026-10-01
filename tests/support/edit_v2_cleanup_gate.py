"""QG-CLEAN (plan §7.3, §10.2; T3.5): Rapikan on the labelled set and on a real clip.

Stdlib only, so the gate also runs in the toolchain image (which has no pytest)::

    PYTHONPATH=src:tests python -m support.edit_v2_cleanup_gate labels OUT.json
    PYTHONPATH=src:tests python -m support.edit_v2_cleanup_gate media OUT.json \
        --jobs-root ROOT --job JOB_ID [--clip CLIP_ID] [--items 20] [--work DIR]

**Real clip** (``media``, a copy of a real job; the job is prepared first when needed): the
browser's own code (``cleanup-model.mjs`` and the Appendix B commands, run by Node) widens the
body towards the analysis window with TrimStart/TrimEnd until ``--items`` items are open, checks
that many (repeats, then fillers, then silent gaps) and applies them as one ``ApplyCleanup``. The
document is saved as revision 1 (``store.put`` validates it) and exported by
``render_edit.render_document`` (G1–G2 verified). Then:

* the **automated cut-edge check** on every cut: the edge frame lies inside its word gap
  ``[a.e, b.s]`` (or its ``bounds`` entry is ``tight``), and the RMS of the source audio over
  ±10 ms around it is ≤ −35 dBFS unless tight;
* **G-CLICK**: the sample step at every join of the preview mix (the final's pre-encode PCM,
  P-AUD) is below −40 dBFS;
* **G-SYNC**: the export's video and audio end within one frame of each other, and each caption
  onset after a pause is the plan frame: a truth frame with captions at ``f0`` differs from the
  same frame without captions, and at ``f0 − 1`` it does not.

**Labelled set** (``tests/fixtures/edit_v2/fillers-labelled.json``): samples of consecutive
words (``[s_ms, e_ms, text]``) from the synthetic job and the owner's real transcripts, each with
the audio-timeline ``silences`` and the laughter spans around it, and labels on word indices
(the rubric is in the file):

* ``filler`` / ``not_filler``: a filler-lexicon token that is / is not a removable filler;
* ``particle``: a protected particle (must never be listed);
* ``reduplication``: both words of a reduplicated word (must never be listed);
* ``emphatic``: a deliberate repetition (never listed);
* ``stutter``: the removable (earlier) occurrence of a restarted word or phrase;
* ``not_repeat``: the same word twice with different roles (never listed as a repeat).

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
import array
import copy
import json
import math
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from collections.abc import Mapping, Sequence
from fractions import Fraction
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import cleanup

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
RMS_LIMIT_DBFS = -35.0
CLICK_LIMIT_DBFS = -40.0
FFMPEG_THREADS = "4"
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
    by_group: dict[str, list[int]] = {}
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
                lost = [k for k in label["i"] if listed.get(k) != "filler"]
                if lost:
                    misses.append({"sample": sample["id"], "label": name, "i": lost,
                                   "listed": listed.get(lost[0])})
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
            by_group.setdefault(label.get("group", "?"), [0, 0])[0 if true else 1] += 1
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
        "filler_precision_by_group": {group: {"true": t, "false": f, "precision": _ratio(t, t + f)}
                                      for group, (t, f) in sorted(by_group.items())},
        "filler_recall": _ratio(filler_found, filler_labelled),
        "unlabelled_filler_hits": unlabelled,
        "stutter_runs": stutter_runs,
        "stutter_recall": _ratio(stutter_found, stutter_runs),
        "repeat_hit_tokens": repeat_hits,
        "repeat_precision": _ratio(repeat_hits["stutter"], sum(repeat_hits.values())),
        "owner_confirmed": bool(status.get("owner_confirmed")),
        "misses": misses,
    }


# --- the real clip ------------------------------------------------------------------------------

# Run by Node with the browser's modules: widen the body until `want` items are open, check
# repeats, then fillers, then silent gaps, and apply them as one ApplyCleanup.
NODE_APPLY = r"""
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const web = input.web;
const { applyCommand, CommandRejected } = await import(`${web}/lib/editor/commands.mjs`);
const { createContext } = await import(`${web}/lib/editor/doc-model.mjs`);
const { cleanupView, planApply } = await import(`${web}/components/editor/transcript/cleanup-model.mjs`);
const { words, seed, listing, want } = input;
const ctx = createContext({ words, seed });
const list = words.words;
const open = (view) => view.entries.filter((entry) => entry.checkable);
const attempt = (doc, type, args) => {
  try { return applyCommand(doc, type, args, ctx).doc; } catch (error) {
    if (error instanceof CommandRejected) return null;
    throw error;
  }
};
const bodyRange = (doc) => {
  const body = doc.main.segments.find((segment) => segment.role === "body");
  let first = -1;
  let last = -1;
  list.forEach((word, index) => {
    const mid = ctx.midSf(index);
    if (mid >= body.in_sf && mid < body.out_sf) { if (first < 0) first = index; last = index; }
  });
  return [first, last];
};
let doc = structuredClone(seed);
const trims = [];
let view = cleanupView({ listing, doc, words, ctx });
for (let step = 0; open(view).length < want && step < 400; step += 1) {
  const [first, last] = bodyRange(doc);
  let moved = false;
  for (const [type, index] of [["TrimStart", first - 3], ["TrimEnd", last + 3]]) {
    if (index < 0 || index >= list.length) continue;
    const next = attempt(doc, type, { gapWord: list[index].id });
    if (next) { doc = next; trims.push({ type, gapWord: list[index].id }); moved = true; }
  }
  if (!moved) break;
  view = cleanupView({ listing, doc, words, ctx });
}
const rank = { repeat: 0, filler: 1, gap_silent: 2 };
const chosen = open(view).sort((a, b) => rank[a.kind] - rank[b.kind] || a.s - b.s).slice(0, want);
const plan = planApply({ view, checked: new Set(chosen.map((entry) => entry.id)), doc, ctx });
const before = doc;
if (plan.args.items.length) doc = applyCommand(doc, "ApplyCleanup", plan.args, ctx).doc;
const count = (kind) => open(view).filter((entry) => entry.kind === kind).length;
process.stdout.write(JSON.stringify({
  doc, before, trims, items: plan.args.items, skipped: plan.skipped,
  open: { filler: count("filler"), repeat: count("repeat"), gap_silent: count("gap_silent") },
}));
"""


def _run(argv: Sequence[str], *, input_bytes: bytes | None = None, timeout: float = 600.0) -> bytes:
    done = subprocess.run(list(argv), input=input_bytes, capture_output=True, timeout=timeout,
                          check=False)
    if done.returncode != 0:
        raise RuntimeError(f"{argv[0]} failed ({done.returncode}): "
                           f"{done.stderr.decode('utf-8', 'replace')[-1500:]}")
    return done.stdout


def _node_apply(node: str, words: Mapping, seed: Mapping, listing: Mapping, want: int) -> dict:
    payload = json.dumps({"web": str(WEB), "words": words, "seed": seed, "listing": listing,
                          "want": want}).encode()
    out = _run([node, "--input-type=module", "-e", NODE_APPLY], input_bytes=payload)
    return json.loads(out)


def _db(value: float) -> float:
    return 20 * math.log10(value) if value > 0 else -200.0


def _decode_mono(source: Path, start_ms: int, end_ms: int) -> array.array:
    raw = _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-threads",
                FFMPEG_THREADS, "-ss", f"{start_ms / 1000:.3f}", "-t", f"{(end_ms - start_ms) / 1000:.3f}",
                "-i", str(source), "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le",
                "-acodec", "pcm_s16le", "-"])
    samples = array.array("h")
    samples.frombytes(raw[: len(raw) // 2 * 2])
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _rms_dbfs(samples: array.array, centre: int, half: int) -> float:
    lo, hi = max(0, centre - half), min(len(samples), centre + half)
    if hi <= lo:
        return 0.0
    power = sum(value * value for value in samples[lo:hi]) / (hi - lo)
    return round(_db(math.sqrt(power) / 32768), 2)


def cut_edge_check(items: Sequence[Mapping], words: Mapping, doc: Mapping, source: Path) -> dict:
    """The automated cut-edge check (QG-CLEAN) over every cut the items make in ``doc``."""
    from ai_clipper.edit_v2 import timemap as tm

    fps = tm.Fps.from_json(words["fps"])
    segments = {segment["id"]: segment for segment in doc["main"]["segments"]}
    body = next(segment for segment in segments.values() if segment["role"] == "body")
    start = int(cleanup.edge_ms(body["in_sf"], fps)) - 2000
    end = int(cleanup.edge_ms(body["out_sf"], fps)) + 2000
    start = max(0, start)
    pcm = _decode_mono(source, start, end)
    edges = []
    for item in items:
        full = {**item}
        if item["kind"] == "gap_silent":
            gap = next(entry for entry in words["gaps"] if entry["after"] == item["afterWord"])
            full.update(s=gap["s"], e=gap["e"])
        for position, edge in enumerate(cleanup.removal_edges(full, words)):
            sf = edge["sf"]
            removal = next((r for r in doc["main"]["removals"]
                            if r["in_sf"] <= sf <= r["out_sf"]), None)
            if removal is not None:
                segment = segments[removal["seg"]]
                sf = min(max(sf, segment["in_sf"]), segment["out_sf"])
            at = cleanup.edge_ms(sf, fps)
            left, right = edge["gap"]
            inside = left <= at <= right
            rms = _rms_dbfs(pcm, round((at - start) * 48), 480)
            edges.append({
                "item": item["id"], "kind": item["kind"], "edge": "in" if position == 0 else "out",
                "sf": sf, "ms": float(round(at, 2)), "gap_ms": [left, right], "inside_gap": inside,
                "tight": edge["tight"], "rms_dbfs": rms,
                "pass": (inside or edge["tight"]) and (edge["tight"] or rms <= RMS_LIMIT_DBFS),
            })
    return {
        "check": "cut edges inside the word gap (or tight); RMS ±10 ms ≤ −35 dBFS unless tight",
        "edges": len(edges), "tight": sum(edge["tight"] for edge in edges),
        "inside_gap": sum(edge["inside_gap"] for edge in edges),
        "rms_max_dbfs_untight": max((edge["rms_dbfs"] for edge in edges if not edge["tight"]),
                                    default=None),
        "failures": [edge for edge in edges if not edge["pass"]],
        "pass": all(edge["pass"] for edge in edges),
        "per_edge": edges,
    }


def _flac_pcm(path: Path) -> array.array:
    raw = _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path),
                "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "2", "-ar", "48000", "-"])
    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def g_click(plan: Any, source: Path, assets_root: Path, work: Path) -> dict:
    """G-CLICK on the preview mix (bit-identical to the final's pre-encode PCM, P-AUD)."""
    from ai_clipper.edit_v2 import compile_ffmpeg, execute
    from ai_clipper.edit_v2 import timemap as tm

    job = compile_ffmpeg.compile_job(plan, mode="audio_preview", source=source,
                                     assets_root=assets_root)
    path = work / "mix.flac"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        execute.run(job, output_fd=fd, timeout_s=600.0)
    finally:
        os.close(fd)
    pcm = _flac_pcm(path)
    joins = [tm.smp(piece.out_f0, plan.fps) for piece in plan.pieces[1:]]
    steps = [max(abs(pcm[2 * j + c] - pcm[2 * (j - 1) + c]) for c in (0, 1)) for j in joins]
    steps_db = [round(_db(step / 32768), 2) for step in steps]
    return {
        "gate": "G-CLICK", "threshold_dbfs": CLICK_LIMIT_DBFS, "joins": len(joins),
        "max_step_dbfs": max(steps_db, default=None), "steps_dbfs": steps_db,
        "samples": len(pcm) // 2, "plan_samples": plan.total_samples,
        "pass": all(db < CLICK_LIMIT_DBFS for db in steps_db) and len(pcm) // 2 == plan.total_samples,
    }


def _gray(png: bytes) -> bytes:
    return _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "png_pipe",
                 "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"], input_bytes=png)


def _truth_gray(plan: Any, frame: int, source: Path, assets_root: Path) -> bytes:
    from ai_clipper.edit_v2 import compile_ffmpeg, execute

    job = compile_ffmpeg.compile_job(plan, mode="frame", frame=frame, source=source,
                                     assets_root=assets_root)
    result = execute.run(job, output_fd=None, timeout_s=120.0)
    return _gray(result.output)


def _differs(a: bytes, b: bytes, *, level: int = 40) -> int:
    return sum(1 for x, y in zip(a, b, strict=True) if abs(x - y) > level)


def g_sync(plan: Any, plan_off: Any, frames: int | None, samples: int | None, source: Path,
           assets_root: Path, cues: int) -> dict:
    """G-SYNC: A/V end within one frame; caption onsets after a pause at the plan frame."""
    fps = plan.fps
    frame_ms = Fraction(1000 * fps.den, fps.num)
    av_ms = None if frames is None or samples is None else float(
        abs(frames * frame_ms - Fraction(samples * 1000, 48_000)))
    chosen = []
    previous_end = -10
    for cue in plan.captions.cues:
        if cue.f0 >= 1 and cue.f0 - previous_end >= 2:
            chosen.append(cue)
        previous_end = cue.f1
    step = max(1, len(chosen) // cues) if chosen else 1
    sample = chosen[::step][:cues]
    checks = []
    for cue in sample:
        results = {}
        for label, frame in (("before", cue.f0 - 1), ("onset", cue.f0)):
            on = _truth_gray(plan, frame, source, assets_root)
            off = _truth_gray(plan_off, frame, source, assets_root)
            results[label] = _differs(on, off)
        checks.append({"f0": cue.f0, "text": len(cue.words), "differing_px_before": results["before"],
                       "differing_px_at_onset": results["onset"],
                       "pass": results["before"] <= 20 and results["onset"] >= 150})
    return {
        "gate": "G-SYNC", "video_frames": frames, "audio_samples": samples,
        "av_end_difference_ms": None if av_ms is None else round(av_ms, 3),
        "one_frame_ms": round(float(frame_ms), 3),
        "av_pass": av_ms is not None and av_ms <= float(frame_ms),
        "caption_onsets_checked": len(checks), "caption_onsets": checks,
        "caption_pass": bool(checks) and all(check["pass"] for check in checks),
        "pass": av_ms is not None and av_ms <= float(frame_ms) and bool(checks)
        and all(check["pass"] for check in checks),
    }


def _toolchain() -> dict[str, Any]:
    version = _run(["ffmpeg", "-hide_banner", "-version"]).decode().splitlines()[0]
    return {"ffmpeg": version, "python": platform.python_version(),
            "machine": platform.machine(), "cpus": os.cpu_count(),
            "loadavg": [round(value, 2) for value in os.getloadavg()]}


def gate_listing(clip_dir: Path) -> dict:
    """The review list the editor shows for the clip (the CLI's, with the clip's peaks)."""
    return cleanup.clip_listing(clip_dir)


def media_gate(jobs_root: Path, job_id: str, *, clip: str | None, items: int, work: Path,
               node: str, cues: int) -> dict:
    from ai_clipper.edit_v2 import api, render_edit, store

    job = jobs_root / job_id
    clips_dir = job / "analysis" / "clips"
    if not clips_dir.is_dir():
        status, payload = api.handle(json.dumps({"op": "prepare_job", "jobId": job_id}).encode(),
                                     jobs_root=jobs_root)
        if status != 0:
            raise RuntimeError(f"prepare_job failed: {payload}")
    candidates = [clip] if clip else sorted(path.name for path in clips_dir.iterdir()
                                            if path.is_dir() and path.name.startswith("clip_"))
    best = None
    for clip_id in candidates:
        clip_dir = clips_dir / clip_id
        seed_doc, seed_etag = store.seed(clip_dir)
        words = store.load_words(clip_dir, seed_doc["base"]["words"]["sha256"])
        listing = gate_listing(clip_dir)
        applied = _node_apply(node, words, seed_doc, listing, items)
        score = len(applied["items"])
        if best is None or score > best[0]:
            best = (score, clip_id, seed_doc, seed_etag, words, listing, applied)
        if score >= items:
            break
    assert best is not None
    _score, clip_id, seed_doc, seed_etag, words, listing, applied = best
    clip_dir = clips_dir / clip_id
    doc = applied["doc"]
    doc["revision"] = 1
    doc["parent_sha256"] = seed_etag
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    saved, _etag, warnings = store.put(clip_dir, expected_etag=seed_etag,
                                       idempotency_key=str(uuid.uuid4()), raw=raw,
                                       now_ms=time.time_ns() // 1_000_000)
    source = render_edit.job_source(job)
    assets_root = job / "analysis" / "assets"
    edges = cut_edge_check(applied["items"], words, saved, source)
    started = time.monotonic()
    output = work / f"{clip_id}-cleanup.mp4"
    for stale in (output, output.with_suffix(".srt")):
        if stale.exists():
            stale.unlink()
    rendered = render_edit.render_document(saved, job, output, size=(saved["output"]["w"],
                                           saved["output"]["h"]), quality="standar", source=source)
    render_s = time.monotonic() - started
    inputs = render_edit.load_render_inputs(job, saved)
    off = copy.deepcopy(saved)
    off["captions"]["enabled"] = False
    inputs_off = render_edit.load_render_inputs(job, off, validate=False)
    click = g_click(inputs.plan, source, assets_root, work)
    sync = g_sync(inputs.plan, inputs_off.plan, rendered.frames, rendered.samples, source,
                  assets_root, cues)
    verify = dict(rendered.verify or {"gates": [], "warnings": []})
    kinds: dict[str, int] = {}
    for item in applied["items"]:
        kinds[item["kind"]] = kinds.get(item["kind"], 0) + 1
    body_before = next(s for s in applied["before"]["main"]["segments"] if s["role"] == "body")
    seed_body = next(s for s in seed_doc["main"]["segments"] if s["role"] == "body")
    return {
        "gate": "QG-CLEAN (real clip): cut edges, G-CLICK and G-SYNC after applying items",
        "job": job_id, "clip_id": clip_id, "engine_of_seed": seed_doc["base"]["engine"]["compiler"],
        "fps": saved["output"]["fps"], "layout": saved["layout"]["default"]["mode"],
        "listing": {kind: sum(1 for item in listing["items"] if item["kind"] == kind)
                    for kind in ("filler", "repeat", "gap_silent", "gap_voiced")},
        "open_in_clip": applied["open"],
        "body_widened_by_trims": {"trims": len(applied["trims"]),
                                  "seed_body_sf": [seed_body["in_sf"], seed_body["out_sf"]],
                                  "edited_body_sf": [body_before["in_sf"], body_before["out_sf"]]},
        "items_applied": len(applied["items"]), "items_by_kind": kinds,
        "items_skipped": applied["skipped"], "items_wanted": items,
        "one_undo_step": "ApplyCleanup (one command)",
        "saved_revision": saved["revision"], "save_warnings": [issue.to_json() for issue in warnings],
        "removals": len(saved["main"]["removals"]),
        "output_frames": inputs.plan.total_frames, "render_s": round(render_s, 1),
        "g1_g2": [{"gate": gate["name"], "pass": gate["ok"], "problems": gate["problems"]}
                  for gate in verify["gates"] if gate["name"] in ("G1", "G2")],
        "verify_warnings": verify.get("warnings", []),
        "cut_edges": edges, "g_click": click, "g_sync": sync,
        "pass": edges["pass"] and click["pass"] and sync["pass"]
        and all(gate["ok"] for gate in verify["gates"] if gate["name"] in ("G1", "G2")),
        "toolchain": _toolchain(),
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
    media = commands.add_parser("media", help="cut edges, G-CLICK and G-SYNC on a real clip")
    media.add_argument("out", type=Path)
    media.add_argument("--jobs-root", type=Path, required=True)
    media.add_argument("--job", required=True)
    media.add_argument("--clip")
    media.add_argument("--items", type=int, default=20)
    media.add_argument("--cues", type=int, default=12)
    media.add_argument("--work", type=Path)
    media.add_argument("--node", default=shutil.which("node") or "node")
    args = parser.parse_args(argv)
    if args.command == "labels":
        report = evaluate_labelled(json.loads(args.fixture.read_text()))
        _write(args.out, report)
        print(json.dumps({key: report[key] for key in (
            "tokens", "reduplication_pairs", "particle_false_positives",
            "reduplication_false_positives", "filler_precision")}))
        return 0
    if args.command == "media":
        with tempfile.TemporaryDirectory(prefix="qg-clean-") as scratch:
            work = args.work or Path(scratch)
            work.mkdir(parents=True, exist_ok=True)
            report = media_gate(args.jobs_root.resolve(), args.job, clip=args.clip,
                                items=args.items, work=work, node=args.node, cues=args.cues)
        _write(args.out, report)
        print(json.dumps({key: report[key] for key in ("clip_id", "items_applied", "pass")}
                         | {"cut_edges": report["cut_edges"]["pass"],
                            "g_click": report["g_click"]["pass"],
                            "g_sync": report["g_sync"]["pass"]}))
        return 0 if report["pass"] else 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
