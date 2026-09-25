#!/usr/bin/env python3
"""Fixtures, scoring and evidence for the browser player gates (plan §10.1 P-FRAME, P-TIME,
P-TXT, P-LOGO, P-AUD browser half, P-SYNC; §10.3 PF-SEEK, PF-PLAY, PF-LIBASS, PF-MEM; §11.2 T2.4).

``generate`` writes, under ``<out>/player/``, everything ``web/app/parity-harness/player`` loads
through ``/api/parity-fixtures/player/…`` and ``web/e2e/editor-player.spec.mjs`` checks:

* the six P-FRAME cases of ``frame_identity.py`` (barcode + column ruler sources at 29.97 CFR,
  25, 30, VFR and the two source-edge cases; 20 cuts and a cold open where the W1 gate has them):
  the plate cells compiled by ``compile_job(mode="plate_cells")`` (``cells/c<k:07d>.mp4``), the
  preview mix (``audio_preview`` → ``mix.flac``), the final graph's pre-encode PCM
  (``reference`` → ``reference.pcm``, s16le stereo), the plan DTO (plan §4.3) and, per output
  frame, the barcode index of the whole-file ``fps`` grid and the crop x;
* on the 29.97 case, document variants over the same plate cells (the 4 packs, a logo, a
  fallback glyph): the server composite of each probe frame computed from the **decoded plate
  cell frame** with the compiler's own strings (R5: ``gbrp``, ``ass``, the derived logo overlay)
  before the 4:2:0 step (P-TXT, P-LOGO), the plate alone and the composite without the logo; the
  derived logo PNG (``derive_image``); truth frames (``frame`` mode) and the auto render
  (``final`` mode) for the revision-0 fallback;
* the five P-TIME timing fixtures of ``reference_text.timing_ass`` (hazard frames included) over
  a flat plate at each frame rate;
* a 300 s clip for PF-MEM.

``score`` compares the browser composites with the server composites (``compare.py``);
``evidence`` turns the spec's results into ``docs/editor/evidence/W2/T2.4-<gate>.json`` (numbers
only). Everything media-related runs in the toolchain image::

    docker run --rm --user 1000:1000 --cpus 4 -v "$PWD":/w -v "$OUT":/out -w /w \\
      -e PYTHONPATH=/w/src:/w/tests -e HOME=/tmp ai-video-clipper:editor-w1z \\
      /app/.venv/bin/python scripts/parity/player_fixtures.py generate --out /out

Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compare
import frame_identity as fi

from ai_clipper.edit_v2 import COMPILER_ID, PACK_DEFAULT_OVERRIDES, RENDER_SEMANTICS
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.compile_ffmpeg import (
    CAPTIONS_FILE,
    GRAPH_FILE,
    INPUT_TOKEN,
    PROGRESS_TOKEN,
    FfmpegJob,
    InputSpec,
)
from ai_clipper.edit_v2.timemap import Fps

SCHEMA = "potongin.parity-player/1"
BASE = "/api/parity-fixtures/player"
PACKS = ("classic", "karaoke", "bold", "box")
# The §3.2 example's logo, top right (plan §3.2, §3.3).
LOGO_TRANSFORM = {"x_e5": 88000, "y_e5": 7000, "w_e5": 16000, "opacity_pm": 850}
P_LOGO = {"mean_abs": 2.0, "max": 8, "box_px": 0}
LOGO_CHANGE_LEVEL = 16  # a pixel whose difference from the logo-less composite exceeds this
REGION_PAD = 16
FLAT_RGB = "0x3C6E8C"
MAIN_CASE = "cfr_29.97"
PLAY_CASES = ("cfr_29.97", "cfr_25", "cfr_30", "vfr_30")
TRUTH_FRAMES = (0, 150, 400)
LONG_SECONDS = 300
FALLBACK_TEXT = "Suka ♥ banget"  # U+2665: Montserrat lacks it, DejaVu Sans has it (R6)

# Composite strings of the compiler (plan §5.2 R5 with S-COLOR = gbrp; CONTRACTS §5.15).
_TEXT_IN_GBRP = "scale=in_color_matrix=bt709:in_range=tv,format=gbrp"
_TEXT_FILTER = f"ass=filename={CAPTIONS_FILE}:fontsdir=fonts:shaping=complex"
_LOGO_FORMAT_GBRP = "scale,format=gbrap"


# --- documents and plans ------------------------------------------------------------------------


def set_pack(doc: dict[str, Any], pack: str) -> None:
    """Switch the document's caption pack, overrides at the pack defaults (plan §3.3)."""
    doc["captions"]["pack"] = {"id": pack, "v": 1}
    doc["captions"]["overrides"] = dict(PACK_DEFAULT_OVERRIDES[pack])


def cells_needed(plan: Any) -> list[int]:
    """Every plate cell holding a frame of the plan, sorted."""
    size = tm.cell_frames(plan.fps)
    cells: set[int] = set()
    for piece in plan.pieces:
        cells.update(range(piece.in_sf // size, (piece.out_sf - 1) // size + 1))
    return sorted(cells)


def font_entries(resources: Any) -> list[dict[str, Any]]:
    """``text.fonts`` of the DTO: every pinned font (the server's fontconfig sees them all)."""
    data = json.loads((resources.fonts_dir / "fonts.json").read_text(encoding="utf-8"))
    out = []
    for font in data["fonts"]:
        family, style = font["family"], font["style"]
        name = family if style in ("Book", "Regular") or style in family else f"{family} {style}"
        out.append({"family": name, "file": font["file"], "sha256": font["sha256"],
                    "url": f"{BASE}/fonts/{font['file']}"})
    return out


def _sha(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def plan_dto(plan: Any, *, case: str, variant: str, plate_key: str, ready: set[int],
             mix: Mapping[str, Any] | None, fonts: Sequence[Mapping[str, Any]],
             logo_file: str | None, auto_render: str | None,
             ass: str | None = None) -> dict[str, Any]:
    """The plan DTO (plan §4.3) of ``plan`` with fixture URLs. ``ready`` are the cells served;
    ``mix`` ``{sha256, samples}`` or None (no mix yet); ``ass`` replaces the plan's ASS (the
    timing fixtures); ``auto_render`` makes the revision-0 fallback exact for this plan."""
    fps = plan.fps
    ass_text = plan.ass if ass is None else ass
    ass_sha = hashlib.sha256(ass_text.encode("utf-8")).hexdigest()
    cues = []
    if ass is None and plan.captions is not None:
        for cue in plan.captions.cues:
            cues.append({"f0": cue.f0, "f1": cue.f1, "text": " ".join(w.text for w in cue.words),
                         "words": [w.id for w in cue.words]})
    hook = None
    hook_item = next((track["items"][0] for track in plan.doc["tracks"]
                      if track["kind"] == "hook" and track["items"]), None)
    if ass is None and hook_item is not None:
        hook = {"f0": 0, "f1": min(hook_item["dur_f"], plan.total_frames),
                "lines": list(plan.captions.hook_lines), "overflow": False}
    cells = []
    for k in cells_needed(plan):
        cell: dict[str, Any] = {"k": k, "state": "ready" if k in ready else "queued"}
        if k in ready:
            cell["url"] = f"{BASE}/{case}/cells/c{k:07d}.mp4"
        cells.append(cell)
    logo = None
    if plan.logo is not None and logo_file is not None:
        logo = {"box": {"x": plan.logo.x, "y": plan.logo.y, "w": plan.logo.w, "h": plan.logo.h},
                "opacityPm": plan.logo.opacity_pm, "url": f"{BASE}/{case}/{logo_file}"}
    audio = {"mixSha256": mix["sha256"] if mix else "0" * 64,
             "state": "ready" if mix else "queued",
             "url": f"{BASE}/{case}/mix.flac" if mix else None,
             "samples": plan.total_samples, "musicGainPoints": [],
             "speechSpans": [list(span) for span in plan.speech_spans]}
    rev0 = {"planSha256": None, "autoRenderUrl": None, "exact": False}
    if auto_render is not None:
        rev0 = {"planSha256": plan.plan_sha256, "autoRenderUrl": f"{BASE}/{case}/{auto_render}",
                "exact": True}
    return {
        "planSha256": plan.plan_sha256 if ass is None else _sha([plan.plan_sha256, ass_sha]),
        "docSha256": _sha(plan.doc), "compiler": COMPILER_ID, "renderSemantics": RENDER_SEMANTICS,
        "fps": fps.to_json(), "totalFrames": plan.total_frames,
        "output": {"w": plan.output[0], "h": plan.output[1]},
        "pieces": [piece.to_dto() for piece in plan.pieces],
        "cues": cues, "hook": hook,
        "text": {"assSha256": ass_sha, "ass": ass_text,
                 "url": f"{BASE}/{case}/{variant}/captions.ass",
                 "fonts": [{"family": f["family"], "url": f["url"], "sha256": f["sha256"]}
                           for f in fonts]},
        "plate": {"plateKey": plate_key, "cellFrames": tm.cell_frames(fps), "w": plan.output[0],
                  "h": plan.output[1], "cells": cells},
        "logo": logo, "audio": audio, "rev0": rev0,
        "warnings": [issue.to_json() for issue in plan.warnings], "errors": [],
    }


def expected_index(plan: Any, grid: Sequence[int | None], *, first: int) -> list[int | None]:
    """The barcode index every output frame must show: the whole-file grid's frame ``sf``
    (``grid[i]`` is grid frame ``first + i``)."""
    out = []
    for n in range(plan.total_frames):
        sf = tm.out_to_src(n, plan.pieces)[1]
        out.append(grid[sf - first] if first <= sf < first + len(grid) else None)
    return out


def expected_crop_x(plan: Any, source: tuple[int, int]) -> list[int] | None:
    """The crop x of every output frame for the crop layouts (None for fit_blur)."""
    from ai_clipper.edit_v2 import layouts

    if plan.layout == "fit_blur":
        return None
    if plan.layout == "fill_center":
        scaled = layouts.scaled_size(source, plan.output)
        return [(scaled[0] - plan.output[0]) // 2] * plan.total_frames
    count = max(piece.out_sf for piece in plan.pieces)
    table = layouts.crop_positions(plan.camera, plan.fps, source=source, output=plan.output,
                                   first_sf=0, count=count)
    return [table[tm.out_to_src(n, plan.pieces)[1]] for n in range(plan.total_frames)]


def probe_frames(plan: Any, *, count: int = 8) -> list[int]:
    """Frames for the composite comparison, most telling first: the hook fading in and out,
    cue edges and word onsets (karaoke/bold switches), the first frames after cuts."""
    total = plan.total_frames
    hook_item = next((track["items"][0] for track in plan.doc["tracks"]
                      if track["kind"] == "hook" and track["items"]), None)
    hook_end = min(hook_item["dur_f"], total) if hook_item is not None else None
    cues = list(plan.captions.cues) if plan.captions is not None else []
    onsets = [cue.words[1].f0 for cue in cues if len(cue.words) > 1]
    cuts = [piece.out_f0 for piece in plan.pieces[1:]]
    candidates: list[int] = []
    if hook_end is not None:
        candidates += [1, hook_end - 2]
    candidates += [cue.f0 for cue in cues[:1]] + onsets[:1] + cuts[:1]
    candidates += [cue.f0 for cue in cues[1:3]] + onsets[1:2] + cuts[1:3]
    if hook_end is not None:
        candidates.append(hook_end // 2)
    candidates += [cue.f0 for cue in cues[3:]] + onsets[2:] + cuts[3:]
    chosen: list[int] = []
    for frame in candidates:
        if 0 <= frame < total and frame not in chosen:
            chosen.append(frame)
        if len(chosen) == count:
            break
    return sorted(chosen)


# --- scoring --------------------------------------------------------------------------------------


def score_logo(test: Any, reference: Any, nologo: Any, box: Mapping[str, int]) -> dict[str, Any]:
    """P-LOGO for one frame: where the browser drew the logo (pixels differing from the server's
    logo-less composite by more than ``LOGO_CHANGE_LEVEL``, searched in the box padded by 16 px)
    must be exactly the plan's box; inside the box the browser and the server composites differ
    by a mean ≤ 2 and a maximum ≤ 8 levels."""
    x0, y0 = box["x"], box["y"]
    x1, y1 = x0 + box["w"], y0 + box["h"]
    width, height = test.width, test.height
    c = test.channels
    sx0, sy0 = max(0, x0 - REGION_PAD), max(0, y0 - REGION_PAD)
    sx1, sy1 = min(width, x1 + REGION_PAD), min(height, y1 + REGION_PAD)
    found = None
    for y in range(sy0, sy1):
        row_t = test.row(y)
        row_n = nologo.row(y)
        for x in range(sx0, sx1):
            i = x * c
            if max(abs(row_t[i + k] - row_n[i + k]) for k in range(3)) > LOGO_CHANGE_LEVEL:
                found = (x, y, x + 1, y + 1) if found is None else (
                    min(found[0], x), min(found[1], y), max(found[2], x + 1), max(found[3], y + 1))
    total = 0
    worst = 0
    count = 0
    for y in range(y0, y1):
        row_t = test.row(y)
        row_r = reference.row(y)
        for x in range(x0, x1):
            i = x * c
            for k in range(3):
                delta = abs(row_t[i + k] - row_r[i + k])
                total += delta
                worst = max(worst, delta)
                count += 1
    return {"box": list(found) if found else None, "plan_box": [x0, y0, x1, y1],
            "box_exact": found == (x0, y0, x1, y1), "mean_abs": total / count if count else 0.0,
            "max": worst}


def logo_pass(score: Mapping[str, Any]) -> bool:
    return (bool(score["box_exact"]) and score["mean_abs"] <= P_LOGO["mean_abs"]
            and score["max"] <= P_LOGO["max"])


def _read_rgb(path: Path) -> Any:
    return compare.read_png(path).rgb()


def score(fixtures: Path, browser: Path) -> dict[str, Any]:
    """P-TXT and P-LOGO of every probe frame the spec captured (``composite/<case>/<variant>``)."""
    manifest = json.loads((fixtures / "player" / "manifest.json").read_text(encoding="utf-8"))
    p_txt: dict[str, Any] = {"thresholds": compare.P_TXT_THRESHOLDS, "frames": 0, "failures": [],
                             "worst": {"ssim": 1.0, "ssim_text": 1.0, "psnr": float("inf"),
                                       "max": 0, "px_over_16": 0}, "variants": {}}
    p_logo: dict[str, Any] = {"thresholds": P_LOGO, "frames": 0, "failures": [],
                              "worst": {"mean_abs": 0.0, "max": 0}, "frames_detail": []}
    for case in manifest["cases"]:
        for variant in case.get("variants", []):
            per_frame = {}
            for frame in variant["probe_frames"]:
                shot = browser / "composite" / case["id"] / variant["id"] / f"{frame}.png"
                if not shot.is_file():
                    p_txt["failures"].append({"case": case["id"], "variant": variant["id"],
                                              "frame": frame, "missing": True})
                    continue
                test_img = _read_rgb(shot)
                reference = _read_rgb(fixtures / variant["composite"][str(frame)])
                region = compare.Box(*variant["text_region"][str(frame)])
                metrics = compare.p_txt_metrics(reference, test_img, text_region=region)
                per_frame[str(frame)] = metrics
                p_txt["frames"] += 1
                worst = p_txt["worst"]
                for key in ("ssim", "ssim_text", "psnr"):
                    worst[key] = min(worst[key], metrics[key])
                for key in ("max", "px_over_16"):
                    worst[key] = max(worst[key], metrics[key])
                if not compare.p_txt_pass(metrics):
                    p_txt["failures"].append({"case": case["id"], "variant": variant["id"],
                                              "frame": frame, **metrics})
                if variant.get("logo_box"):
                    nologo = _read_rgb(fixtures / variant["nologo"][str(frame)])
                    result = score_logo(test_img, reference, nologo, variant["logo_box"])
                    p_logo["frames"] += 1
                    p_logo["worst"]["mean_abs"] = max(p_logo["worst"]["mean_abs"], result["mean_abs"])
                    p_logo["worst"]["max"] = max(p_logo["worst"]["max"], result["max"])
                    p_logo["frames_detail"].append({"frame": frame, **result})
                    if not logo_pass(result):
                        p_logo["failures"].append({"frame": frame, **result})
            p_txt["variants"][f"{case['id']}/{variant['id']}"] = per_frame
    return {"schema": "potongin.player-scores/1", "p_txt": p_txt, "p_logo": p_logo}


# --- evidence -------------------------------------------------------------------------------------

_DROP_KEYS = ("executable", "details", "files", "procs")


def _numbers_only(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _numbers_only(item) for key, item in value.items() if key not in _DROP_KEYS}
    if isinstance(value, list):
        return [_numbers_only(item) for item in value]
    if isinstance(value, float) and value == float("inf"):
        return "inf"
    return value


def _gate_p_frame(r: dict) -> tuple[dict, bool]:
    ok = r["totals"]["frames"] >= fi.P_FRAME_MIN_FRAMES and r["totals"]["mismatches"] == 0
    return {"threshold": {"min_frames": fi.P_FRAME_MIN_FRAMES, "mismatches": 0}, **r}, ok


def _gate_p_time(r: dict) -> tuple[dict, bool]:
    ok = (len(r["cases"]) == 5 and sum(c["mismatches"] for c in r["cases"]) == 0
          and all(c["control_one_frame_late_flagged"] == c["control_edges"] for c in r["cases"]))
    return {"threshold": {"mismatches": 0}, **r}, ok


def _gate_p_aud(r: dict) -> tuple[dict, bool]:
    ok = len(r["cases"]) >= 4 and all(
        c["contextRate"] == 48000 and c["bufferRate"] == 48000 and c["length"] == c["referenceLength"]
        == c["planSamples"] and c["maxDiffLsb"] <= 1 for c in r["cases"])
    return {"threshold": {"max_diff_lsb": 1, "sample_rate": 48000}, **r}, ok


def _gate_p_sync(r: dict) -> tuple[dict, bool]:
    cases = [{k: c[k] for k in ("case", "fps", "cuts", "presented", "pixel_mismatches",
                                "sync_error_frames", "clock", "first_frame", "last_frame")}
             for c in r["cases"]]
    ok = len(cases) >= 3 and all(c["pixel_mismatches"] == 0 and c["presented"] > 0
                                 and c["sync_error_frames"]["p99"] <= 1 for c in cases)
    return {"threshold": {"p99_frames": 1}, "browser": r["browser"], "loadavg": r.get("loadavg"),
            "cases": cases}, ok


def _gate_pf_play(r: dict) -> tuple[dict, bool]:
    cases = [{k: c[k] for k in ("case", "fps", "cuts", "presented", "drops", "drops_at_cuts",
                                "dropped", "seconds", "drops_per_10s", "holds")}
             for c in r["cases"]]
    ok = len(cases) >= 3 and all(c["drops_at_cuts"] == 0 and c["drops_per_10s"] is not None
                                 and c["drops_per_10s"] <= 1 for c in cases)
    return {"threshold": {"drops_at_cuts": 0, "drops_per_10s": 1}, "browser": r["browser"],
            "loadavg": r.get("loadavg"), "cases": cases}, ok


def _gate_pf_seek(r: dict) -> tuple[dict, bool]:
    return {"threshold": {"p95_ms": 50}, **r}, r["summary"]["p95"] <= 50


def _gate_pf_libass(r: dict) -> tuple[dict, bool]:
    return {"threshold": {"p95_ms": 12}, **r}, r["summary"]["p95"] <= 12


def _gate_pf_mem(r: dict) -> tuple[dict, bool]:
    return {"threshold": {"max_bytes": 1_200_000_000}, **r}, r["peak_bytes"] <= 1_200_000_000


def _gate_scores(which: str) -> Callable[[dict], tuple[dict, bool]]:
    def gate(r: dict) -> tuple[dict, bool]:
        part = r[which]
        body = {key: value for key, value in part.items() if key != "variants"}
        minimum = 30 if which == "p_txt" else 5
        return body, part["frames"] >= minimum and not part["failures"]
    return gate


def _gate_truth(r: dict) -> tuple[dict, bool]:
    ok = (all(t["mode"] == "truth" and t["maxDiff"] == 0 for t in r["truth"])
          and r["fallback"]["mode"] == "auto_render" and r["fallback"]["mismatches"] == 0
          and r["fallback"]["liveAfterCells"] == "live")
    return r, ok


EVIDENCE = (
    ("p_frame.json", "P-FRAME", _gate_p_frame),
    ("p_time.json", "P-TIME", _gate_p_time),
    ("scores.json", "P-TXT", _gate_scores("p_txt")),
    ("scores.json", "P-LOGO", _gate_scores("p_logo")),
    ("p_aud.json", "P-AUD", _gate_p_aud),
    ("p_sync_pf_play.json", "P-SYNC", _gate_p_sync),
    ("p_sync_pf_play.json", "PF-PLAY", _gate_pf_play),
    ("pf_seek.json", "PF-SEEK", _gate_pf_seek),
    ("pf_libass.json", "PF-LIBASS", _gate_pf_libass),
    ("pf_mem.json", "PF-MEM", _gate_pf_mem),
    ("truth_fallback.json", "REV0-TRUTH", _gate_truth),
)


def write_evidence(fixtures: Path, browser: Path, out_dir: Path, *, task: str = "T2.4") -> list[Path]:
    """One ``<task>-<gate>.json`` per gate whose results exist (numbers only: no paths)."""
    manifest = json.loads((fixtures / "player" / "manifest.json").read_text(encoding="utf-8"))
    written = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, gate, build in EVIDENCE:
        source = browser / name
        if not source.is_file():
            continue
        body, ok = build(json.loads(source.read_text(encoding="utf-8")))
        data = {"gate": gate, "task": task, "pass": ok,
                "browser": body.get("browser") if isinstance(body, dict) else None,
                "toolchain": manifest.get("toolchain"), **_numbers_only(body)}
        path = out_dir / f"{task}-{gate}.json"
        path.write_text(json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
                        encoding="utf-8")
        written.append(path)
    return written


# --- media (toolchain image) --------------------------------------------------------------------


def _run(argv: Sequence[str]) -> None:
    subprocess.run(list(argv), check=True, stdin=subprocess.DEVNULL, capture_output=True)


def _execute(job: FfmpegJob, output: Path, *, directory: bool = False) -> None:
    from ai_clipper.edit_v2 import execute

    output.parent.mkdir(parents=True, exist_ok=True)
    if directory:
        output.mkdir(parents=True, exist_ok=True)
        fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
    else:
        fd = os.open(output, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        execute.run(job, output_fd=fd, timeout_s=1800)
    finally:
        os.close(fd)


def composite_job(plan: Any, *, cell: Path, j: int, n: int, resources: Any, text: bool = True,
                  logo: tuple[str, Path] | None = None) -> FfmpegJob:
    """The server composite of output frame ``n`` over frame ``j`` of a decoded plate cell, with
    the compiler's R5 strings: into gbrp, ``ass`` at ``now_ms(n)`` (pts ``n`` in time base
    den/num, as ``frame`` mode), the derived logo overlaid in gbrp; RGB before the 4:2:0 step."""
    from ai_clipper.edit_v2.derive import derive_filter

    fps = plan.fps
    chain = (f"[0:v]trim=start_frame={j}:end_frame={j + 1},setpts=PTS-STARTPTS,"
             f"settb={fps.den}/{fps.num},setpts={n},{_TEXT_IN_GBRP}")
    graph = [chain + (f",{_TEXT_FILTER}" if text else "") + "[vtext]"]
    inputs = [InputSpec("source", "source")]
    paths: dict[str, str] = {"source": str(cell)}
    argv = ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
            "-progress", PROGRESS_TOKEN, "-protocol_whitelist", "file,pipe", "-threads", "4",
            "-i", INPUT_TOKEN.format(0)]
    last = "[vtext]"
    assets_root = cell.parent
    if logo is not None:
        asset_id, asset_path = logo
        box = plan.logo
        inputs.append(InputSpec("asset", asset_id, ("-f", "png_pipe")))
        paths[asset_id] = str(asset_path)
        assets_root = asset_path.parent
        argv += ["-protocol_whitelist", "file,pipe", "-f", "png_pipe", "-i", INPUT_TOKEN.format(1)]
        graph.append(f"[1:v]{derive_filter(box.w, box.h, box.opacity_pm)},{_LOGO_FORMAT_GBRP}[lg]")
        graph.append(f"[vtext][lg]overlay=x={box.x}:y={box.y}:format=gbrp[vlogo]")
        last = "[vlogo]"
    graph.append(f"{last}format=rgb24[vout]")
    argv += ["-filter_complex_script", GRAPH_FILE, "-filter_complex_threads", "4",
             "-map", "[vout]", "-frames:v", "1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
             "-f", "image2", "-c:v", "png", "composite.png"]
    return FfmpegJob(
        argv=tuple(argv), filter_script=";\n".join(graph) + "\n", inputs=tuple(inputs),
        sidecars={CAPTIONS_FILE: plan.ass.encode("utf-8")} if text else {},
        expected={"mode": "parity_composite", "output": "png", "result": "composite.png",
                  "paths": paths, "assets_root": str(assets_root),
                  "fonts_dir": str(resources.fonts_dir),
                  "fontconfig_file": str(resources.fontconfig_file)})


def with_gop(job: FfmpegJob, cell_frames: int, gop: int) -> FfmpegJob:
    """A plate-cell job whose x264 GOP is ``gop`` instead of the cell length (a measurement of
    PF-SEEK with shorter GOPs; the IDR at every cell start is kept by ``-force_key_frames``).
    The compiler's plate encoding is not changed by this script."""
    if not 1 <= gop <= cell_frames:
        raise ValueError("the GOP must lie between 1 and the cell length")
    argv = list(job.argv)
    for index, token in enumerate(argv[:-1]):
        if token == "-g" and argv[index + 1] == str(cell_frames):
            argv[index + 1] = str(gop)
    return FfmpegJob(argv=tuple(argv), filter_script=job.filter_script, inputs=job.inputs,
                     sidecars=job.sidecars, expected=job.expected)


def make_flat_video(path: Path, fps: tuple[int, int], frames: int) -> Path:
    """A flat-colour 640×360 H.264 source (the P-TIME plate: no pixel changes but the text)."""
    _run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
          f"color=c={FLAT_RGB}:s=640x360:r={fps[0]}/{fps[1]}", "-frames:v", str(frames),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "250", "-pix_fmt",
          "yuv420p", "-threads", "4", "-color_primaries", "bt709", "-color_trc", "bt709",
          "-colorspace", "bt709", "-color_range", "tv", "-map_metadata", "-1", "-fflags",
          "+bitexact", "-flags:v", "+bitexact", str(path)])
    return path


def _toolchain() -> dict[str, Any]:
    from support import edit_v2_media as media

    first = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                           check=False).stdout.splitlines()
    return {"ffmpeg": first[0] if first else None,
            "reference_toolchain_problem": media.reference_toolchain_problem(),
            "python": sys.version.split()[0]}


class Generator:
    """Writes ``<out>/player``; ``ws`` is frame_identity's workspace (sources, documents)."""

    def __init__(self, out: Path, work: Path, log: Callable[[str], None],
                 plate_gop: int | None = None) -> None:
        self.out = out / "player"
        self.out.mkdir(parents=True, exist_ok=True)
        self.ws = fi.Workspace(work)
        self.log = log
        self.plate_gop = plate_gop
        self.resources = self.ws.resources
        self.fonts = font_entries(self.resources)

    def rel(self, path: Path) -> str:
        return str(path.relative_to(self.out.parent))

    def copy_fonts(self) -> None:
        target = self.out / "fonts"
        target.mkdir(exist_ok=True)
        for font in self.fonts:
            shutil.copyfile(self.resources.fonts_dir / font["file"], target / font["file"])

    def compile(self, plan: Any, source: Path, mode: str, **kwargs: Any) -> FfmpegJob:
        from ai_clipper.edit_v2.compile_ffmpeg import compile_job

        return compile_job(plan, mode=mode, source=source, assets_root=self.ws.root / "assets",
                           **kwargs)

    def cells(self, plan: Any, source: Path, case: str, wanted: Sequence[int] | None = None) -> set[int]:
        cells = list(wanted) if wanted is not None else cells_needed(plan)
        directory = self.out / case / "cells"
        todo = [k for k in cells if not (directory / f"c{k:07d}.mp4").is_file()]
        if todo:
            self.log(f"{case}: {len(todo)} plate cells")
            # One job per contiguous run: compile_job gives every run of a job its own decoder
            # and x264 encoder in one process, and 8 runs at 720×1280 exceed RLIMIT_AS (3 GiB).
            runs: list[list[int]] = []
            for k in sorted(todo):
                if runs and runs[-1][-1] == k - 1:
                    runs[-1].append(k)
                else:
                    runs.append([k])
            for run in runs:
                job = self.compile(plan, source, "plate_cells", cells=run)
                if self.plate_gop is not None:
                    job = with_gop(job, tm.cell_frames(plan.fps), self.plate_gop)
                _execute(job, directory, directory=True)
        return set(cells)

    def mix(self, plan: Any, source: Path, case: str) -> dict[str, Any]:
        path = self.out / case / "mix.flac"
        if not path.is_file():
            self.log(f"{case}: audio_preview")
            _execute(self.compile(plan, source, "audio_preview"), path)
        return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "samples": plan.total_samples}

    def reference_pcm(self, plan: Any, source: Path, case: str) -> dict[str, Any]:
        from support import edit_v2_media as media

        pcm = self.out / case / "reference.pcm"
        if not pcm.is_file():
            self.log(f"{case}: reference render (PCM)")
            with tempfile.TemporaryDirectory(prefix="player-ref-") as tmp:
                mkv = Path(tmp) / "reference.mkv"
                _execute(self.compile(plan, source, "reference"), mkv)
                pcm.write_bytes(media.read_pcm(mkv).tobytes())
        flac_pcm = media.read_pcm(self.out / case / "mix.flac").tobytes()
        data = pcm.read_bytes()
        return {"pcm": self.rel(pcm), "pcm_md5": hashlib.md5(data).hexdigest(),
                "flac_pcm_md5": hashlib.md5(flac_pcm).hexdigest(),
                "pcm_samples": len(data) // 4}

    def write_plan(self, case: str, variant: str, dto: dict[str, Any]) -> str:
        directory = self.out / case / variant
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "captions.ass").write_text(dto["text"]["ass"], encoding="utf-8")
        path = directory / "plan.json"
        path.write_text(json.dumps(dto, ensure_ascii=False) + "\n", encoding="utf-8")
        return self.rel(path)

    def decode_info(self, case: fi.Case) -> dict[str, Any]:
        from ai_clipper.edit_v2 import layouts

        geometry = fi.geometry(case.layout, case.source_size, case.output)
        info = {"source": list(case.source_size), "scale": geometry["scale"],
                "top": geometry["top"]}
        if case.layout != "fit_blur":
            info["crop_scale"] = layouts.scaled_size(case.source_size, case.output)[0] / case.source_size[0]
        return info

    # the P-FRAME cases -----------------------------------------------------------------------

    def pframe(self, case: fi.Case) -> dict[str, Any]:
        clip = self.ws.clip(case)
        plan = self.ws.plan(case)
        source = clip["source"]
        ready = self.cells(plan, source, case.name)
        mix = self.mix(plan, source, case.name)
        grid = self.ws.grid(case)
        first = self.ws.grid_start(case)
        plate_key = _sha(["plate", case.name, case.layout, list(case.fps)])
        variants: list[dict[str, Any]] = []
        plans: dict[str, str] = {}
        dto = plan_dto(plan, case=case.name, variant="default", plate_key=plate_key, ready=ready,
                       mix=mix, fonts=self.fonts, logo_file=None, auto_render=None)
        plans["default"] = self.write_plan(case.name, "default", dto)
        entry: dict[str, Any] = {
            "id": case.name, "kind": "pframe", "fps": list(case.fps), "layout": case.layout,
            "vfr": case.vfr, "total_frames": plan.total_frames, "pieces": len(plan.pieces),
            "removals": len(plan.doc["main"]["removals"]), "decode": self.decode_info(case),
            "expected": {"index": expected_index(plan, grid, first=first),
                         "crop_x": expected_crop_x(plan, case.source_size)},
            "plans": plans, "default_variant": "default", "variants": variants,
            "play": case.name in PLAY_CASES, "plate_key": plate_key,
        }
        entry.update(self.reference_pcm(plan, source, case.name))
        if case.name == MAIN_CASE:
            self.main_variants(case, entry, ready, mix, plate_key)
        return entry

    def variant_plan(self, case: fi.Case, name: str) -> Any:
        from ai_clipper.edit_v2.plan import build_plan

        clip = self.ws.clip(case)
        doc = json.loads(json.dumps(clip["doc"]))
        assets = dict(clip["assets"])
        if name in PACKS:
            set_pack(doc, name)
        elif name == "logo":
            asset, meta = self.ws.logo_asset()
            assets[asset] = meta
            doc["assets"] = {asset: meta}
            doc["tracks"].append({"id": "tr_ovr", "kind": "visual", "band": "over_text",
                                  "role": "overlay", "items": [{
                                      "id": "it_logo", "type": "image",
                                      "start": {"at": "clip_start"}, "end": {"at": "clip_end"},
                                      "transform": dict(LOGO_TRANSFORM),
                                      "payload": {"asset": asset, "mode": "free"},
                                      "origin": "user"}]})
        elif name == "fallback":
            set_pack(doc, "bold")
            first_word = clip["words"]["words"][0]["id"]
            doc["captions"]["word_edits"] = {first_word: {"text": FALLBACK_TEXT}}
        return build_plan(doc, words=clip["words"], camera=clip["camera"], assets=assets,
                          resources=self.resources)

    def main_variants(self, case: fi.Case, entry: dict[str, Any], ready: set[int],
                      mix: Mapping[str, Any], plate_key: str) -> None:
        clip = self.ws.clip(case)
        source = clip["source"]
        size = tm.cell_frames(Fps(*case.fps))
        cell_dir = self.out / case.name / "cells"
        for name in (*PACKS, "logo", "fallback"):
            plan = self.variant_plan(case, name)
            logo_file = None
            logo_input = None
            if plan.logo is not None:
                from ai_clipper.edit_v2.derive import derive_image

                asset_path = self.ws.root / "assets" / f"{plan.logo.asset.split(':')[1]}.png"
                # (the lane names it <sha16>@<w>x<h>.png; the fixtures route allows no "@")
                logo_file = f"logo-{plan.logo.w}x{plan.logo.h}.png"
                (self.out / case.name / logo_file).write_bytes(derive_image(
                    asset_path, w=plan.logo.w, h=plan.logo.h, opacity_pm=plan.logo.opacity_pm))
                logo_input = (plan.logo.asset, asset_path)
            dto = plan_dto(plan, case=case.name, variant=name, plate_key=plate_key, ready=ready,
                           mix=mix, fonts=self.fonts, logo_file=logo_file, auto_render=None)
            entry["plans"][name] = self.write_plan(case.name, name, dto)
            frames = probe_frames(plan, count=8)
            variant: dict[str, Any] = {"id": name, "pack": plan.doc["captions"]["pack"]["id"],
                                       "probe_frames": frames, "composite": {}, "plate": {},
                                       "text_region": {}, "nologo": None, "logo_box": None}
            if logo_input is not None:
                variant["nologo"] = {}
                variant["logo_box"] = {"x": plan.logo.x, "y": plan.logo.y, "w": plan.logo.w,
                                       "h": plan.logo.h}
            self.log(f"{case.name}/{name}: {len(frames)} composites")
            region = None
            for n in frames:
                sf = tm.out_to_src(n, plan.pieces)[1]
                k, j = divmod(sf, size)
                cell = cell_dir / f"c{k:07d}.mp4"
                base = self.out / case.name / name
                targets = {"composite": base / "composite" / f"{n}.png",
                           "plate": base / "plate" / f"{n}.png"}
                _execute(composite_job(plan, cell=cell, j=j, n=n, resources=self.resources,
                                       logo=logo_input), targets["composite"])
                _execute(composite_job(plan, cell=cell, j=j, n=n, resources=self.resources,
                                       text=False), targets["plate"])
                region_ref = targets["composite"]
                if logo_input is not None:
                    targets["nologo"] = base / "nologo" / f"{n}.png"
                    _execute(composite_job(plan, cell=cell, j=j, n=n, resources=self.resources),
                             targets["nologo"])
                    variant["nologo"][str(n)] = self.rel(targets["nologo"])
                    region_ref = targets["nologo"]
                variant["composite"][str(n)] = self.rel(targets["composite"])
                variant["plate"][str(n)] = self.rel(targets["plate"])
                box = compare.diff_bbox(_read_rgb(targets["plate"]), _read_rgb(region_ref))
                region = box.union(region) if box is not None else region
                variant["text_frames"] = variant.get("text_frames", 0) + (box is not None)
            # One text region per variant (the union over its probe frames, as the W1 text
            # harness): a probe frame between two cues shows no text and is scored there too.
            if region is None:
                raise RuntimeError(f"{case.name}/{name}: no text drawn on any probe frame")
            padded = region.pad(REGION_PAD, *plan.output).to_list()
            variant["text_region"] = {str(n): padded for n in frames}
            entry["variants"].append(variant)
        entry["libass"] = "bold"
        # Truth frames (frame mode) and the auto render (final mode) of the default document.
        plan = self.ws.plan(case)
        truth = {}
        for n in TRUTH_FRAMES:
            path = self.out / case.name / "truth" / f"{n}.png"
            if not path.is_file():
                _execute(self.compile(plan, source, "frame", frame=n), path)
            truth[str(n)] = self.rel(path)
        auto = self.out / case.name / "auto.mp4"
        if not auto.is_file():
            self.log(f"{case.name}: auto render (final)")
            _execute(self.compile(plan, source, "final"), auto)
        fallback_dto = plan_dto(plan, case=case.name, variant="rev0", plate_key=plate_key,
                                ready=set(), mix=mix, fonts=self.fonts, logo_file=None,
                                auto_render="auto.mp4")
        entry["plans"]["rev0"] = self.write_plan(case.name, "rev0", fallback_dto)
        step = max(1, plan.total_frames // 12)
        entry["truth"] = {"frames": list(TRUTH_FRAMES), "files": truth,
                          "fallback_frames": list(range(0, plan.total_frames, step))[:12]}

    # the P-TIME cases ------------------------------------------------------------------------

    def ptime(self, rate: Any) -> dict[str, Any]:
        import reference_text as rt

        from ai_clipper.edit_v2.plan import build_plan

        fps = (rate.num, rate.den)
        name = f"timing_{rate.num}_{rate.den}"
        ass, lanes, transitions = rt.timing_ass(rate)
        last = max(t["frame"] for t in transitions) + 4
        frames = last + 2 * tm.cell_frames(rate)
        source = self.ws.root / f"{name}.mp4"
        if not source.is_file():
            self.log(f"{name}: flat source, {frames} frames")
            make_flat_video(source, fps, frames)
        duration_ms = frames * 1000 * rate.den // rate.num
        info = fi.SourceInfo(640, 360, fps, False, duration_ms, False)
        doc = fi.make_doc(info, fps=fps, body=(0, last), layout="fill_center")
        doc["base"]["window_ms"] = [0, duration_ms]
        plan = build_plan(doc, words=fi.make_words(duration_ms), camera=None, assets={},
                          resources=self.resources)
        size = tm.cell_frames(rate)
        wanted = sorted({f // size for t in transitions
                         for f in range(max(0, t["frame"] - 2), t["frame"] + 2)})
        ready = self.cells(plan, source, name, wanted)
        plate_key = _sha(["plate", name])
        dto = plan_dto(plan, case=name, variant="default", plate_key=plate_key, ready=ready,
                       mix=None, fonts=self.fonts, logo_file=None, auto_render=None, ass=ass)
        return {"id": name, "kind": "ptime", "fps": list(fps), "layout": "fill_center",
                "total_frames": plan.total_frames, "pieces": 1, "variants": [],
                "plans": {"default": self.write_plan(name, "default", dto)},
                "default_variant": "default",
                "lanes": {lane: {**spec, "y": rt.TIMING_LANES[lane]["y"]}
                          for lane, spec in lanes.items()},
                "transitions": transitions, "flat_rgb": FLAT_RGB}

    # PF-MEM ----------------------------------------------------------------------------------

    def long(self) -> dict[str, Any]:
        # A body of exactly 300 s (frames 30 … 9030 of a 9150-frame source), karaoke and hook.
        frames = LONG_SECONDS * 30
        case = fi.Case("long_300s", (30, 1), frames + 150, "fit_blur", hook=True, cuts=0,
                       cold_open=False)
        clip = self.ws.clip(case)
        plan = self.ws.plan(case)
        if plan.total_frames != frames:
            raise RuntimeError(f"long case: {plan.total_frames} frames, expected {frames}")
        source = clip["source"]
        ready = self.cells(plan, source, case.name)
        mix = self.mix(plan, source, case.name)
        plate_key = _sha(["plate", case.name])
        dto = plan_dto(plan, case=case.name, variant="default", plate_key=plate_key, ready=ready,
                       mix=mix, fonts=self.fonts, logo_file=None, auto_render=None)
        return {"id": case.name, "kind": "long", "fps": [30, 1], "layout": "fit_blur",
                "total_frames": plan.total_frames, "pieces": len(plan.pieces), "variants": [],
                "plans": {"default": self.write_plan(case.name, "default", dto)},
                "default_variant": "default", "decode": self.decode_info(case)}


def generate(out: Path, *, only: Sequence[str] | None = None, plate_gop: int | None = None,
             log: Callable[[str], None] = lambda line: None) -> dict[str, Any]:
    import reference_text as rt

    out = Path(out).resolve()
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="player-fixtures-") as tmp:
        gen = Generator(out, Path(tmp), log, plate_gop=plate_gop)
        gen.copy_fonts()
        cases: list[dict[str, Any]] = []
        for case in fi.P_FRAME_CASES:
            if only is None or case.name in only:
                cases.append(gen.pframe(case))
        for rate in rt.TIMING_FPS:
            name = f"timing_{rate.num}_{rate.den}"
            if only is None or name in only:
                cases.append(gen.ptime(rate))
        if only is None or "long_300s" in only:
            cases.append(gen.long())
    manifest = {"schema": SCHEMA, "size": [720, 1280], "fonts": gen.fonts,
                "fallback_family": "DejaVu Sans", "toolchain": _toolchain(),
                "composite": "gbrp", "plate_gop": plate_gop,
                "wall_s": round(time.monotonic() - started, 1), "cases": cases}
    (out / "player" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Browser player fixtures, scores and evidence")
    commands = parser.add_subparsers(dest="command", required=True)
    gen = commands.add_parser("generate")
    gen.add_argument("--out", type=Path, required=True)
    gen.add_argument("--only", help="comma-separated case ids")
    gen.add_argument("--plate-gop", type=int,
                     help="measurement only: x264 GOP of the plate cells (default: the compiler's, "
                          "one GOP per cell)")
    sc = commands.add_parser("score")
    sc.add_argument("--fixtures", type=Path, required=True)
    sc.add_argument("--browser", type=Path, required=True)
    sc.add_argument("--out", type=Path, required=True)
    ev = commands.add_parser("evidence")
    ev.add_argument("--fixtures", type=Path, required=True)
    ev.add_argument("--browser", type=Path, required=True)
    ev.add_argument("--out-dir", type=Path, required=True)
    ev.add_argument("--task", default="T2.4")
    args = parser.parse_args(argv)
    if args.command == "generate":
        manifest = generate(args.out, only=args.only.split(",") if args.only else None,
                            plate_gop=args.plate_gop,
                            log=lambda line: print(line, file=sys.stderr, flush=True))
        print(json.dumps({"cases": [c["id"] for c in manifest["cases"]],
                          "wall_s": manifest["wall_s"], "toolchain": manifest["toolchain"]}))
        return 0
    if args.command == "score":
        result = score(args.fixtures, args.browser)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(_numbers_only(result), indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"p_txt": {k: result["p_txt"][k] for k in ("frames", "worst")},
                          "p_txt_failures": len(result["p_txt"]["failures"]),
                          "p_logo": {k: result["p_logo"][k] for k in ("frames", "worst")},
                          "p_logo_failures": len(result["p_logo"]["failures"])},
                         default=str))
        return 0 if not result["p_txt"]["failures"] and not result["p_logo"]["failures"] else 1
    written = write_evidence(args.fixtures, args.browser, args.out_dir, task=args.task)
    for path in written:
        data = json.loads(path.read_text(encoding="utf-8"))
        print(f"{path.name}: {'pass' if data['pass'] else 'FAIL'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
