#!/usr/bin/env python3
"""P-LOOK kit and PF-PIPELINE: the new engine next to the legacy engine on real V3 clips
(plan §5.8 item 4, §10.1 P-LOOK, §10.3 PF-PIPELINE, K1; T2.1).

Stdlib only (plus ``ai_clipper``); run it in the pinned image with the worktree's ``src`` on
``PYTHONPATH``. The owner's jobs are **only read**: ``prepare`` copies what the pipeline's
rendering stage needs into a work directory, and every render happens in a copy.

1. ``prepare --src JOBS_ROOT --select JOB:1,2,3 … --work WORK``: per job ``job.json``, the
   source, ``output/{transcript,manifest}.json`` and ``analysis/{selection.v3,audio-timeline,
   sound-events,transcript-quality}.json`` into ``WORK/pristine/<job>/``, and the owner's
   legacy renders of the selected clips (MP4 + SRT) into ``WORK/owner/<job>/``.
2. ``render --work WORK --engine legacy|edit-v2 --label NAME``: per job a fresh copy
   (``WORK/runs/NAME/jobs/<job>``, the source hard-linked from the pristine copy) and
   ``pipeline.render_v3_job`` for the selected ranks, i.e. exactly the pipeline's rendering
   stage after selection (revision 0 through the pipeline path for ``edit-v2``). Wall times per
   job and per clip go to ``WORK/runs/NAME/render.json`` (PF-PIPELINE).
3. ``measure --work WORK --new NAME --legacy NAME|owner --out OUT.json``: per clip
   * SSIM (FFmpeg ``ssim``, the "All" value, both files' planes as coded) of every new frame
     against the legacy frame shown at the same time, for legacy offsets −1, 0, +1 frames:
     per clip the best offset, and per frame the best of the three (plan: "SSIM ≥ 0.98 at the
     best offset within ±1 frame");
   * the caption and hook ink boxes: both engines' ASS (the legacy ``build_ass`` of
     ``render_vertical`` and the seed's ``build_ass_v2``) drawn alone over grey at the middle
     frame of every caption cue and of the hook, each through its own ``ass`` filter string
     and fonts; the box is every pixel more than 24 grey levels from the background, split at
     half height (hook above, captions below); gate ±2 px;
   * integrated loudness and true peak (``ebur128``) of both files; gate ±0.5 LU;
   * the streams and sizes of both files.
4. ``kit --work WORK --new NAME --legacy owner --measure OUT.json --pairs JOB:RANK,… --out DIR``:
   one contact sheet per clip (PNG: rows at the hook, 25/50/75/95 % and after the cold-open
   join, old left, new right, plus a full-size crop of the caption band), three MP4 pairs
   (``lama.mp4``, ``baru.mp4`` and a side-by-side ``berdampingan.mp4``) and ``index.md``.
5. ``evidence --measure OUT.json --legacy-run NAME --new-run NAME --work WORK --out-dir DIR``:
   ``T2.1-P-LOOK.json`` and ``T2.1-PF-PIPELINE.json`` (numbers only).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from ai_clipper import pipeline
from ai_clipper.captions_ass import build_ass
from ai_clipper.edit_v2 import render_edit, store
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.glyphs import RESOURCES_DIR
from ai_clipper.edit_v2.loudness import parse_ebur128
from ai_clipper.selection_v3 import read_selection_artifact
from ai_clipper.subtitles import build_caption_cues
from ai_clipper.transcript_io import read_transcript_json

TASK = "T2.1"
W, H = 720, 1280
SSIM_THRESHOLD = 0.98
BBOX_TOLERANCE_PX = 2
LOUDNESS_TOLERANCE_LU = 0.5
PF_BUDGET = {"fit_blur": 1.35, "fill_center": 1.35, "camera": 1.6}
INK_THRESHOLD = 24
GREY = 128
MAX_BBOX_PROBES = 16
THREADS = 4
LAYOUT_OF = {"fit-blur": "fit_blur", "center-crop": "fill_center", "face-track": "camera"}
ANALYSIS_FILES = ("selection.v3.json", "audio-timeline.json", "sound-events.json",
                  "transcript-quality.json")
_SSIM_LINE = re.compile(r"n:(\d+) .*All:([0-9.]+|inf)")
FONT = RESOURCES_DIR / "fonts" / "DejaVuSans-Bold.ttf"


def _run(argv: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None,
         timeout: float = 3600) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, check=True, stdin=subprocess.DEVNULL,
                          timeout=timeout, env=env, cwd=cwd)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _selection(work: Path) -> dict[str, Any]:
    return _read_json(work / "selection.json")


def _fraction(text: str | None) -> tuple[int, int] | None:
    try:
        num, den = (int(part) for part in str(text).split("/"))
        return (num, den) if num > 0 and den > 0 else None
    except ValueError:
        return None


# --- prepare ------------------------------------------------------------------------------------


def prepare(src: Path, selects: list[str], work: Path) -> dict[str, Any]:
    jobs = []
    for select in selects:
        job_id, _, ranks_text = select.partition(":")
        ranks = sorted(int(rank) for rank in ranks_text.split(",") if rank)
        source_job = src / job_id
        pristine = work / "pristine" / job_id
        (pristine / "input").mkdir(parents=True, exist_ok=True)
        (pristine / "output").mkdir(parents=True, exist_ok=True)
        (pristine / "analysis").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_job / "job.json", pristine / "job.json")
        job = _read_json(source_job / "job.json")
        source_name = Path(job["sourcePath"]).name
        if not (pristine / "input" / source_name).exists():
            shutil.copyfile(source_job / "input" / source_name, pristine / "input" / source_name)
        for name in ("transcript.json", "manifest.json"):
            shutil.copyfile(source_job / "output" / name, pristine / "output" / name)
        for name in ANALYSIS_FILES:
            if (source_job / "analysis" / name).is_file():
                shutil.copyfile(source_job / "analysis" / name, pristine / "analysis" / name)
        owner = work / "owner" / job_id
        owner.mkdir(parents=True, exist_ok=True)
        for rank in ranks:
            for suffix in (".mp4", ".srt"):
                name = f"clip-{rank:02d}{suffix}"
                shutil.copyfile(source_job / "output" / name, owner / name)
        probe = json.loads(_run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                 "-show_entries", ("stream=codec_name,width,height,r_frame_rate,"
                                 "avg_frame_rate"), "-of", "json",
                                 str(pristine / "input" / source_name)]).stdout)["streams"][0]
        jobs.append({"id": job_id, "ranks": ranks, "render_mode": job["options"]["renderMode"],
                     "source": probe})
    report = {"jobs": jobs}
    _write_json(work / "selection.json", report)
    return report


# --- render (PF-PIPELINE) -----------------------------------------------------------------------


def _copy_job(pristine: Path, target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(pristine, target, copy_function=shutil.copy2,
                    ignore=shutil.ignore_patterns("input"))
    (target / "input").mkdir()
    for item in (pristine / "input").iterdir():
        os.link(item, target / "input" / item.name)  # our copy; never written


def render(work: Path, engine: str, label: str, only: list[str] | None) -> dict[str, Any]:
    selection = _selection(work)
    report = {"engine": engine, "label": label, "jobs": [], "environment": _environment()}
    path = work / "runs" / label / "render.json"
    if path.exists():
        report = _read_json(path)
    for job in selection["jobs"]:
        if only is not None and job["id"] not in only:
            continue
        job_dir = work / "runs" / label / "jobs" / job["id"]
        _copy_job(work / "pristine" / job["id"], job_dir)
        load_before = os.getloadavg()
        run = pipeline.render_v3_job(job_dir, render_engine=engine, ranks=job["ranks"])
        entry = {
            "id": job["id"], "render_mode": job["render_mode"],
            "seconds": round(run.seconds, 3),
            "clip_seconds": {str(rank): round(value, 3) for rank, value in run.timings.items()},
            "output_seconds": {str(clip["index"]): clip["duration"] for clip in run.clips},
            "warnings": run.warnings,
            "engines": {str(clip["index"]): clip.get("render_engine", "legacy")
                        for clip in run.clips},
            "loadavg_before": [round(value, 2) for value in load_before],
            "loadavg_after": [round(value, 2) for value in os.getloadavg()],
        }
        report["jobs"] = [item for item in report["jobs"] if item["id"] != job["id"]] + [entry]
        _write_json(path, report)
        print(json.dumps({"job": job["id"], "engine": engine, "seconds": entry["seconds"],
                          "warnings": run.warnings}), flush=True)
    return report


def _environment() -> dict[str, Any]:
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True,
                             check=False).stdout.splitlines()[0]
    return {"ffmpeg": version, "python": platform.python_version(),
            "cpu_count": os.cpu_count(), "affinity": len(os.sched_getaffinity(0))}


# --- measure ------------------------------------------------------------------------------------


def probe(path: Path) -> dict[str, Any]:
    info = json.loads(_run(["ffprobe", "-v", "error", "-count_packets", "-show_entries",
                            ("format=duration,size,bit_rate:stream=codec_type,codec_name,profile,"
                            "pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,"
                            "sample_rate,channels,bit_rate,color_space,color_primaries,"
                            "color_transfer,color_range"), "-of", "json", str(path)]).stdout)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next((s for s in info["streams"] if s["codec_type"] == "audio"), {})
    return {
        "size_bytes": int(info["format"]["size"]),
        "duration_s": round(float(info["format"]["duration"]), 3),
        "bit_rate": int(info["format"].get("bit_rate", 0)),
        "video": {"codec": video.get("codec_name"), "profile": video.get("profile"),
                  "pix_fmt": video.get("pix_fmt"), "w": video.get("width"),
                  "h": video.get("height"), "r_frame_rate": video.get("r_frame_rate"),
                  "avg_frame_rate": video.get("avg_frame_rate"),
                  "frames": int(video.get("nb_read_packets", 0)),
                  "bit_rate": int(video.get("bit_rate", 0) or 0),
                  "color": [video.get(key) for key in ("color_primaries", "color_transfer",
                                                       "color_space", "color_range")]},
        "audio": {"codec": audio.get("codec_name"), "sample_rate": int(audio.get("sample_rate", 0)),
                  "channels": audio.get("channels"),
                  "bit_rate": int(audio.get("bit_rate", 0) or 0)},
    }


def _loudness(path: Path) -> dict[str, float]:
    result = _run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
                   "-threads", str(THREADS), "-i", str(path), "-map", "0:a:0", "-filter:a",
                   "aformat=sample_fmts=dbl,ebur128=peak=true:framelog=verbose", "-f", "null",
                   "-"])
    measured = parse_ebur128(result.stderr.decode("utf-8", "replace"))
    return {"i_lufs": measured.i_clufs / 100, "tp_dbtp": measured.tp_cdb / 100}


def ssim_frames(new: Path, legacy: Path, new_fps: tuple[int, int],
                legacy_fps: tuple[int, int], offset: int) -> list[float]:
    """Per-frame SSIM ("All") of every new frame against the legacy frame shown at the same
    time, the legacy stream shifted by ``offset`` of its own frames."""
    shift = {0: "", 1: "trim=start_frame=1,", -1: "tpad=start=1:start_mode=clone,"}[offset]
    graph = (f"[0:v]setpts=N*{new_fps[1]}/{new_fps[0]}/TB[n];"
             f"[1:v]{shift}setpts=N*{legacy_fps[1]}/{legacy_fps[0]}/TB,"
             f"fps=fps={new_fps[0]}/{new_fps[1]}:round=down[l];"
             "[n][l]ssim=stats_file=ssim.log:shortest=1[out]")
    with tempfile.TemporaryDirectory(prefix="look-ssim-") as scratch:
        _run(["ffmpeg", "-nostdin", "-v", "error", "-threads", str(THREADS), "-i", str(new),
              "-threads", str(THREADS), "-i", str(legacy), "-filter_complex", graph,
              "-filter_complex_threads", str(THREADS), "-map", "[out]", "-f", "null", "-"],
             cwd=Path(scratch))
        values = []
        for line in (Path(scratch) / "ssim.log").read_text().splitlines():
            match = _SSIM_LINE.search(line)
            if match:
                values.append(1.0 if match.group(2) == "inf" else float(match.group(2)))
    return values


def _percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * (len(ordered) - 1)))]


def ssim_report(new: Path, legacy: Path, new_fps: tuple[int, int],
                legacy_fps: tuple[int, int]) -> dict[str, Any]:
    runs = {offset: ssim_frames(new, legacy, new_fps, legacy_fps, offset)
            for offset in (-1, 0, 1)}
    length = min(len(values) for values in runs.values())
    best_offset = max(runs, key=lambda offset: statistics.fmean(runs[offset][:length]))
    at_best = runs[best_offset][:length]
    per_frame = [max(runs[offset][index] for offset in runs) for index in range(length)]
    below = [index for index, value in enumerate(per_frame) if value < SSIM_THRESHOLD]
    return {
        "frames": length,
        "best_offset": best_offset,
        "best_offset_mean": round(statistics.fmean(at_best), 5),
        "best_offset_min": round(min(at_best), 5),
        "best_offset_p1": round(_percentile(at_best, 0.01), 5),
        "per_frame_best_mean": round(statistics.fmean(per_frame), 5),
        "per_frame_best_min": round(min(per_frame), 5),
        "per_frame_best_p1": round(_percentile(per_frame, 0.01), 5),
        "per_frame_best_p5": round(_percentile(per_frame, 0.05), 5),
        "frames_below_threshold": len(below),
        "below_runs": _runs(below),
        "offset_means": {str(offset): round(statistics.fmean(values[:length]), 5)
                         for offset, values in runs.items()},
    }


def _runs(indices: list[int]) -> list[list[int]]:
    """Consecutive frame indices as [first, last] pairs (at most 20)."""
    runs: list[list[int]] = []
    for index in indices:
        if runs and runs[-1][1] == index - 1:
            runs[-1][1] = index
        else:
            runs.append([index, index])
    return runs[:20]


def _legacy_ass(job_dir: Path, rank: int) -> str:
    """The ASS ``render_vertical`` burned into the legacy clip (the same inputs)."""
    job = _read_json(job_dir / "job.json")
    options = job["options"]
    transcript = read_transcript_json(job_dir / "output" / "transcript.json")
    selection = read_selection_artifact(job_dir / "analysis" / "selection.v3.json")
    clip = next(item for item in selection.clips if item.rank == rank)
    teaser = clip.cold_open if options.get("coldOpen", True) else None
    ranges = ((clip.start, clip.end),) if teaser is None else (teaser, (clip.start, clip.end))
    cues = build_caption_cues(transcript.segments, ranges)
    return build_ass(cues, width=W, height=H,
                     duration=sum(end - start for start, end in ranges),
                     caption_style=options.get("captionStyle", "karaoke"),
                     hook_text=clip.hook_text if options.get("hookOverlay", True) else None,
                     hook_duration=pipeline.DEFAULT_HOOK_DURATION)


def _ink_boxes(ass: str, frames: list[int], fps: tuple[int, int], total: int, *,
               new_engine: bool) -> dict[int, dict[str, list[int] | None]]:
    """The ink box of the hook (upper half) and the captions (lower half) of ``ass`` at each
    output frame, drawn alone over grey through the engine's own ``ass`` filter and fonts."""
    select = "+".join(f"eq(n,{frame})" for frame in frames)
    with tempfile.TemporaryDirectory(prefix="look-ass-") as scratch:
        work = Path(scratch)
        (work / "captions.ass").write_text(ass, encoding="utf-8")
        env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": scratch, "LANG": "C.UTF-8"}
        if new_engine:  # the compiler's string, fonts and fontconfig lockdown (R5, R6)
            os.symlink(RESOURCES_DIR / "fonts", work / "fonts")
            env["FONTCONFIG_FILE"] = str(RESOURCES_DIR / "fontconfig" / "fonts.conf")
            text = "ass=filename=captions.ass:fontsdir=fonts:shaping=complex"
        else:  # render.py's string with the system fonts
            text = "ass=filename='captions.ass'"
        seconds = (total + 1) * fps[1] / fps[0]
        output = _run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                       (f"color=c=0x{GREY:02x}{GREY:02x}{GREY:02x}:s={W}x{H}:"
                       f"r={fps[0]}/{fps[1]}:d={seconds:.6f}"), "-vf",
                       f"select='{select}',{text},format=gray", "-fps_mode", "passthrough",
                       "-f", "rawvideo", "-"], env=env, cwd=work).stdout
    boxes = {}
    size = W * H
    for position, frame in enumerate(frames):
        plane = output[position * size:(position + 1) * size]
        boxes[frame] = {"hook": _box(plane, 0, H // 2), "captions": _box(plane, H // 2, H)}
    return boxes


def _box(plane: bytes, top: int, bottom: int) -> list[int] | None:
    ink = bytes(255 if abs(value - GREY) > INK_THRESHOLD else 0 for value in range(256))
    x0, y0, x1, y1 = W, None, -1, None
    for y in range(top, bottom):
        row = plane[y * W:(y + 1) * W].translate(ink)
        first = row.find(b"\xff")
        if first < 0:
            continue
        last = row.rfind(b"\xff")
        y0 = y if y0 is None else y0
        y1 = y
        x0, x1 = min(x0, first), max(x1, last)
    return None if y0 is None else [x0, y0, x1 + 1, y1 + 1]


def bbox_report(new_job: Path, legacy_job: Path, rank: int, clip_id: str) -> dict[str, Any]:
    document, _etag = store.seed(new_job / "analysis" / "clips" / clip_id)
    plan = render_edit.load_render_inputs(new_job, document).plan
    fps = (plan.fps.num, plan.fps.den)
    cues = plan.captions.cues
    step = max(1, math.ceil(len(cues) / MAX_BBOX_PROBES))
    frames = sorted({(cue.f0 + cue.f1) // 2 for cue in cues[::step]})
    hook = [track for track in document["tracks"] if track["kind"] == "hook"]
    if hook:
        frames = sorted({*frames, min(hook[0]["items"][0]["dur_f"], plan.total_frames) // 2})
    new_boxes = _ink_boxes(plan.ass, frames, fps, plan.total_frames, new_engine=True)
    old_boxes = _ink_boxes(_legacy_ass(legacy_job, rank), frames, fps, plan.total_frames,
                           new_engine=False)
    result: dict[str, Any] = {"probes": len(frames)}
    for region in ("captions", "hook"):
        deltas, presence = [], 0
        for frame in frames:
            new_box, old_box = new_boxes[frame][region], old_boxes[frame][region]
            if new_box is None and old_box is None:
                continue
            if new_box is None or old_box is None:
                presence += 1
                continue
            deltas.append(max(abs(a - b) for a, b in zip(new_box, old_box, strict=True)))
        result[region] = {"compared": len(deltas), "max_delta_px": max(deltas, default=None),
                          "presence_mismatch": presence,
                          "within_tolerance": sum(delta <= BBOX_TOLERANCE_PX for delta in deltas)}
    return result


def measure(work: Path, new_label: str, legacy_label: str,
            only: list[str] | None) -> dict[str, Any]:
    selection = _selection(work)
    rows = []
    for job in selection["jobs"]:
        if only is not None and job["id"] not in only:
            continue
        new_job = work / "runs" / new_label / "jobs" / job["id"]
        legacy_job = work / "pristine" / job["id"]
        for rank in job["ranks"]:
            name = f"clip-{rank:02d}.mp4"
            new_file = new_job / "output" / name
            legacy_file = (work / "owner" / job["id"] / name if legacy_label == "owner"
                           else work / "runs" / legacy_label / "jobs" / job["id"] / "output"
                           / name)
            started = time.monotonic()
            new_probe, legacy_probe = probe(new_file), probe(legacy_file)
            new_fps = _fraction(new_probe["video"]["r_frame_rate"])
            legacy_fps = _fraction(legacy_probe["video"]["r_frame_rate"])
            clip_id = _clip_id(new_job, rank)
            row = {
                "job": job["id"], "rank": rank, "render_mode": job["render_mode"],
                "source_fps": job["source"]["r_frame_rate"],
                "source_avg_fps": job["source"]["avg_frame_rate"],
                "source_codec": job["source"]["codec_name"],
                "new": new_probe, "legacy": legacy_probe,
                "ssim": ssim_report(new_file, legacy_file, new_fps, legacy_fps),
                "bbox": bbox_report(new_job, legacy_job, rank, clip_id),
                "loudness": {"new": _loudness(new_file), "legacy": _loudness(legacy_file)},
            }
            row["loudness"]["delta_lu"] = round(
                row["loudness"]["new"]["i_lufs"] - row["loudness"]["legacy"]["i_lufs"], 2)
            row["seconds"] = round(time.monotonic() - started, 1)
            rows.append(row)
            print(json.dumps({"job": job["id"][:8], "rank": rank,
                              "ssim_min": row["ssim"]["per_frame_best_min"],
                              "below": row["ssim"]["frames_below_threshold"],
                              "bbox": [row["bbox"]["captions"]["max_delta_px"],
                                       row["bbox"]["hook"]["max_delta_px"]],
                              "dLU": row["loudness"]["delta_lu"]}), flush=True)
    return {"new": new_label, "legacy": legacy_label, "clips": rows,
            "environment": _environment()}


def _clip_id(job_dir: Path, rank: int) -> str:
    """The clip id of ``rank`` from the run's seeds (the one whose origin rank matches)."""
    for seed_file in sorted((job_dir / "analysis" / "clips").glob("clip_*/seed.json")):
        document = _read_json(seed_file)
        if document["base"]["origin"]["rank_at_seed"] == rank:
            return document["clip_id"]
    raise LookupError(f"no seed for rank {rank} in {job_dir.name}")


# --- kit ----------------------------------------------------------------------------------------


def _label(text: str) -> str:
    return (f"drawtext=fontfile={FONT}:text='{text}':x=10:y=10:fontsize=28:"
            "fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6")


def contact_sheet(legacy: Path, new: Path, times: list[tuple[str, float]], out: Path) -> None:
    """Rows of [old | new] frames at ``times`` (360×640 each) and the caption band of the
    middle row at full size (old above new)."""
    argv = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    graph = []
    rows = []
    for index, (_name, seconds) in enumerate(times):
        for path in (legacy, new):
            argv += ["-ss", f"{seconds:.3f}", "-i", str(path)]
        a, b = 2 * index, 2 * index + 1
        graph.append(f"[{a}:v]scale=360:640,setsar=1,{_label(f'LAMA {seconds:.1f}s')}[a{index}]")
        graph.append(f"[{b}:v]scale=360:640,setsar=1,{_label(f'BARU {seconds:.1f}s')}[b{index}]")
        graph.append(f"[a{index}][b{index}]hstack=inputs=2[r{index}]")
        rows.append(f"[r{index}]")
    middle = times[len(times) // 2][1]
    zoom_a, zoom_b = 2 * len(times), 2 * len(times) + 1
    argv += ["-ss", f"{middle:.3f}", "-i", str(legacy), "-ss", f"{middle:.3f}", "-i", str(new)]
    graph.append(f"[{zoom_a}:v]crop=720:260:0:860,setsar=1,{_label('LAMA caption')}[za]")
    graph.append(f"[{zoom_b}:v]crop=720:260:0:860,setsar=1,{_label('BARU caption')}[zb]")
    graph.append(f"{''.join(rows)}[za][zb]vstack=inputs={len(rows) + 2},format=rgb24[sheet]")
    argv += ["-filter_complex", ";".join(graph), "-map", "[sheet]", "-frames:v", "1", str(out)]
    _run(argv)


def side_by_side(legacy: Path, new: Path, fps: tuple[int, int], out: Path) -> None:
    graph = (f"[0:v]fps={fps[0]}/{fps[1]},scale=540:960,setsar=1,{_label('LAMA')}[a];"
             f"[1:v]fps={fps[0]}/{fps[1]},scale=540:960,setsar=1,{_label('BARU')}[b];"
             "[a][b]hstack=inputs=2[v]")
    _run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-threads", str(THREADS), "-i", str(legacy),
          "-threads", str(THREADS), "-i", str(new), "-filter_complex", graph,
          "-filter_complex_threads", str(THREADS), "-map", "[v]", "-map", "1:a:0", "-c:v",
          "libx264", "-preset", "veryfast", "-crf", "20", "-x264-params", f"threads={THREADS}",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
          str(out)])


def _sheet_times(row: dict[str, Any], cold_open_s: float | None) -> list[tuple[str, float]]:
    duration = min(row["new"]["duration_s"], row["legacy"]["duration_s"])
    times = [("hook", 1.0)]
    times += [(f"{int(100 * part)}%", round(duration * part, 2)) for part in (0.25, 0.5, 0.75)]
    if cold_open_s is not None:
        times.append(("join", round(cold_open_s + 0.5, 2)))
    times.append(("95%", round(duration * 0.95, 2)))
    return sorted(times, key=lambda item: item[1])


def kit(work: Path, new_label: str, legacy_label: str, measured: dict[str, Any],
        pairs: list[str], out: Path) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    (out / "lembar").mkdir(exist_ok=True)
    made = []
    for row in measured["clips"]:
        new_job = work / "runs" / new_label / "jobs" / row["job"]
        name = f"clip-{row['rank']:02d}.mp4"
        legacy = (work / "owner" / row["job"] / name if legacy_label == "owner"
                  else work / "runs" / legacy_label / "jobs" / row["job"] / "output" / name)
        clip_id = _clip_id(new_job, row["rank"])
        document, _etag = store.seed(new_job / "analysis" / "clips" / clip_id)
        pieces = tm.pieces(document)
        fps = tm.Fps.from_json(document["output"]["fps"])
        cold = next((piece for piece in pieces if piece.role == "cold_open"), None)
        cold_s = None if cold is None else cold.frames * fps.den / fps.num
        sheet = out / "lembar" / f"{_short(row)}.png"
        contact_sheet(legacy, new_job / "output" / name, _sheet_times(row, cold_s), sheet)
        made.append(sheet.name)
    pair_dirs = []
    for number, pair in enumerate(pairs, start=1):
        job_id, _, rank_text = pair.partition(":")
        row = next(item for item in measured["clips"]
                   if item["job"] == job_id and item["rank"] == int(rank_text))
        target = out / f"pasangan-{number}-{_kind(row)}"
        target.mkdir(exist_ok=True)
        name = f"clip-{row['rank']:02d}.mp4"
        legacy = (work / "owner" / row["job"] / name if legacy_label == "owner"
                  else work / "runs" / legacy_label / "jobs" / row["job"] / "output" / name)
        new = work / "runs" / new_label / "jobs" / row["job"] / "output" / name
        shutil.copyfile(legacy, target / "lama.mp4")
        shutil.copyfile(new, target / "baru.mp4")
        side_by_side(legacy, new, _fraction(row["new"]["video"]["r_frame_rate"]),
                     target / "berdampingan.mp4")
        pair_dirs.append(target.name)
    (out / "index.md").write_text(index_markdown(measured, made, pair_dirs), encoding="utf-8")
    return {"sheets": made, "pairs": pair_dirs}


def _kind(row: dict[str, Any]) -> str:
    fps = _fraction(row["source_fps"])
    avg = _fraction(row["source_avg_fps"])
    if row["render_mode"] == "face-track":
        return "face-track"
    if fps and fps[0] / fps[1] > 49:
        return "60fps"
    if fps and avg and abs(fps[0] / fps[1] - avg[0] / avg[1]) > 0.01:
        return "vfr"
    return row["render_mode"]


def _short(row: dict[str, Any]) -> str:
    return f"{_kind(row)}-{row['job'][:8]}-klip{row['rank']:02d}"


def _mb(size: int) -> str:
    return f"{size / 1_000_000:.1f}"


def index_markdown(measured: dict[str, Any], sheets: list[str], pairs: list[str]) -> str:
    rows = measured["clips"]
    lines = [
        "# Kit P-LOOK: mesin render baru vs mesin lama (titik cek 2, keputusan K1)",
        "",
        (f"{len(rows)} klip asli dari job Anda dirender ulang dengan mesin baru (revisi 0 lewat "
        "jalur pipeline, di salinan job; job asli tidak disentuh), berdampingan dengan render "
        "lama yang Anda kenal. Kiri/atas = LAMA, kanan/bawah = BARU."),
        "",
        "## Yang perlu dilihat",
        "",
        ("1. **Frame rate tetap.** Sumber 60 fps sekarang jadi 30 fps (50 → 25), dan sumber VFR "
        "(frame rate berubah-ubah) jadi 30 fps konstan. Gerakan cepat di klip 60 fps sedikit "
        "kurang halus; potongan dan caption jatuh tepat di frame yang sama di editor dan di "
        "hasil akhir. Lihat `pasangan-*-60fps` dan `pasangan-*-vfr`."),
        "2. **Audio 48 kHz, AAC 192 kb/s** (dulu 128 kb/s). Kenyaringan sama (selisih di tabel).",
        ("3. **Warna caption tepat.** Mesin lama menggeser warna teks berwarna (kuning karaoke "
        "`#FFE14D`) sampai 23 level karena konversi BT.601; mesin baru menggambar teks di RGB, "
        "jadi warnanya persis. Bandingkan pita caption besar di bawah tiap lembar."),
        ("4. **Encode lebih tajam, file lebih besar.** Standar R7 sekarang `veryfast` crf 18 + "
        "chroma QP −12 (dulu crf 21): tepi teks berwarna lebih bersih, tapi ukuran file naik "
        "(kolom MB). Ini perlu persetujuan Anda (Open 1 di GATES)."),
        ("5. **Face-track** dihitung sekali untuk seluruh jendela klip (±60 s) dan dihaluskan; "
        "arah kamera bisa sedikit berbeda dari mesin lama. Lihat `pasangan-*-face-track`."),
        "6. Tag warna BT.709 sekarang tertulis di file (dulu kosong).",
        "",
        "## Angka per klip",
        "",
        ("SSIM = kemiripan gambar (1,0 = identik) per frame pada offset terbaik ±1 frame; kotak "
        "teks = selisih posisi caption/hook terbesar (piksel); ΔLU = selisih kenyaringan."),
        "",
        ("| Klip | fps lama → baru | audio lama → baru | MB lama → baru | SSIM min / rata-rata "
        "| frame < 0,98 | kotak caption / hook (px) | ΔLU |"),
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in rows:
        new, old = row["new"], row["legacy"]
        lines.append(
            f"| {_short(row)} | {old['video']['r_frame_rate']} → {new['video']['r_frame_rate']} "
            f"| {old['audio']['sample_rate'] // 1000} kHz {old['audio']['bit_rate'] // 1000}k → "
            f"{new['audio']['sample_rate'] // 1000} kHz {new['audio']['bit_rate'] // 1000}k "
            f"| {_mb(old['size_bytes'])} → {_mb(new['size_bytes'])} "
            f"| {row['ssim']['per_frame_best_min']:.3f} / {row['ssim']['per_frame_best_mean']:.4f} "
            f"| {row['ssim']['frames_below_threshold']} / {row['ssim']['frames']} "
            f"| {row['bbox']['captions']['max_delta_px']} / {row['bbox']['hook']['max_delta_px']} "
            f"| {row['loudness']['delta_lu']:+.2f} |")
    total_old = sum(row["legacy"]["size_bytes"] for row in rows)
    total_new = sum(row["new"]["size_bytes"] for row in rows)
    lines += [
        "",
        (f"Total ukuran: {_mb(total_old)} MB lama → {_mb(total_new)} MB baru "
        f"({total_new / total_old:.2f}×)."),
        "",
        "## Isi folder",
        "",
        ("- `lembar/*.png`: satu lembar per klip (baris: hook, 25/50/75/95 % dan setelah "
        "sambungan cold open; lalu pita caption ukuran asli)."),
        *[f"- `{name}/`: `lama.mp4`, `baru.mp4`, `berdampingan.mp4`" for name in pairs],
        "",
        ("Keputusan yang diminta: **K1** (mesin baru untuk klip otomatis V3) dan biaya **R7** "
        "(ukuran file). Selama belum disetujui, `POTONGIN_RENDER_ENGINE` tetap `legacy`."),
        "",
    ]
    return "\n".join(lines)


# --- evidence -----------------------------------------------------------------------------------


def evidence(measured: dict[str, Any], work: Path, legacy_run: str,
             new_run: str) -> tuple[dict[str, Any], dict[str, Any]]:
    clips = []
    for row in measured["clips"]:
        clips.append({
            "clip": _short(row), "render_mode": row["render_mode"],
            "fps": {"source": row["source_fps"], "legacy": row["legacy"]["video"]["r_frame_rate"],
                    "new": row["new"]["video"]["r_frame_rate"]},
            "frames": {"legacy": row["legacy"]["video"]["frames"],
                       "new": row["new"]["video"]["frames"]},
            "ssim": {key: row["ssim"][key] for key in (
                "frames", "best_offset", "best_offset_mean", "best_offset_min",
                "per_frame_best_mean", "per_frame_best_min", "per_frame_best_p1",
                "per_frame_best_p5", "frames_below_threshold")},
            "bbox": row["bbox"],
            "loudness": row["loudness"],
            "audio": {"legacy_hz": row["legacy"]["audio"]["sample_rate"],
                      "new_hz": row["new"]["audio"]["sample_rate"],
                      "legacy_bps": row["legacy"]["audio"]["bit_rate"],
                      "new_bps": row["new"]["audio"]["bit_rate"]},
            "size_bytes": {"legacy": row["legacy"]["size_bytes"], "new": row["new"]["size_bytes"]},
            "video_bps": {"legacy": row["legacy"]["video"]["bit_rate"],
                          "new": row["new"]["video"]["bit_rate"]},
            "color_tags": {"legacy": row["legacy"]["video"]["color"],
                           "new": row["new"]["video"]["color"]},
        })
    ssim_ok = [row["ssim"]["frames_below_threshold"] == 0 for row in measured["clips"]]
    bbox_ok = [all(row["bbox"][region]["presence_mismatch"] == 0
                   and (row["bbox"][region]["max_delta_px"] or 0) <= BBOX_TOLERANCE_PX
                   for region in ("captions", "hook")) for row in measured["clips"]]
    loud_ok = [abs(row["loudness"]["delta_lu"]) <= LOUDNESS_TOLERANCE_LU
               for row in measured["clips"]]
    frames = sum(row["ssim"]["frames"] for row in measured["clips"])
    below = sum(row["ssim"]["frames_below_threshold"] for row in measured["clips"])
    look = {
        "gate": "P-LOOK", "task": TASK,
        "threshold": {"ssim_per_frame_best_offset": SSIM_THRESHOLD,
                      "bbox_px": BBOX_TOLERANCE_PX, "loudness_lu": LOUDNESS_TOLERANCE_LU},
        "legacy_reference": measured["legacy"],
        "clips": clips,
        "summary": {
            "clips": len(clips),
            "layouts": sorted({row["render_mode"] for row in measured["clips"]}),
            "ssim_clips_pass": sum(ssim_ok), "ssim_frames": frames,
            "ssim_frames_below": below,
            "ssim_per_frame_best_min": min(row["ssim"]["per_frame_best_min"]
                                           for row in measured["clips"]),
            "ssim_per_frame_best_mean": round(statistics.fmean(
                row["ssim"]["per_frame_best_mean"] for row in measured["clips"]), 5),
            "bbox_clips_pass": sum(bbox_ok),
            "bbox_max_delta_px": max((row["bbox"][region]["max_delta_px"] or 0)
                                     for row in measured["clips"]
                                     for region in ("captions", "hook")),
            "loudness_clips_pass": sum(loud_ok),
            "loudness_max_delta_lu": max(abs(row["loudness"]["delta_lu"])
                                         for row in measured["clips"]),
            "size_ratio_new_over_legacy": round(
                sum(row["new"]["size_bytes"] for row in measured["clips"])
                / sum(row["legacy"]["size_bytes"] for row in measured["clips"]), 3),
            "pass_measured": all(ssim_ok) and all(bbox_ok) and all(loud_ok),
            "owner_approval": "pending (checkpoint 2, K1)",
        },
        "environment": measured["environment"],
    }
    legacy = _read_json(work / "runs" / legacy_run / "render.json")
    new = _read_json(work / "runs" / new_run / "render.json")
    layouts: dict[str, dict[str, float]] = {}
    jobs = []
    for job in new["jobs"]:
        old = next(item for item in legacy["jobs"] if item["id"] == job["id"])
        layout = LAYOUT_OF[job["render_mode"]]
        bucket = layouts.setdefault(layout, {"legacy_s": 0.0, "new_s": 0.0, "output_s": 0.0,
                                             "clips": 0})
        bucket["legacy_s"] += old["seconds"]
        bucket["new_s"] += job["seconds"]
        bucket["output_s"] += sum(job["output_seconds"].values())
        bucket["clips"] += len(job["clip_seconds"])
        jobs.append({"job": job["id"][:8], "layout": layout, "legacy_s": old["seconds"],
                     "new_s": job["seconds"], "ratio": round(job["seconds"] / old["seconds"], 3),
                     "clips": len(job["clip_seconds"]),
                     "output_s": round(sum(job["output_seconds"].values()), 1),
                     "new_warnings": job["warnings"],
                     "loadavg": {"legacy": old["loadavg_before"], "new": job["loadavg_before"]}})
    for layout, bucket in layouts.items():
        bucket["ratio"] = round(bucket["new_s"] / bucket["legacy_s"], 3)
        bucket["budget"] = PF_BUDGET[layout]
        bucket["pass"] = bucket["ratio"] <= PF_BUDGET[layout]
        bucket["legacy_x_realtime"] = round(bucket["legacy_s"] / bucket["output_s"], 3)
        bucket["new_x_realtime"] = round(bucket["new_s"] / bucket["output_s"], 3)
        for key in ("legacy_s", "new_s", "output_s"):
            bucket[key] = round(bucket[key], 1)
    pf = {"gate": "PF-PIPELINE", "task": TASK,
          "scope": "the V3 rendering stage (per clip: seed artifacts + render + verify + poster; "
                   "per job: source.json), same container and clips for both engines; "
                   "transcription and selection are shared and excluded",
          "threshold": PF_BUDGET, "layouts": layouts, "jobs": jobs,
          "pass": all(bucket["pass"] for bucket in layouts.values()),
          "environment": {"legacy": legacy["environment"], "new": new["environment"]}}
    return look, pf


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    cmd = commands.add_parser("prepare")
    cmd.add_argument("--src", type=Path, required=True)
    cmd.add_argument("--select", action="append", required=True)
    cmd.add_argument("--work", type=Path, required=True)
    cmd = commands.add_parser("render")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--engine", choices=render_edit.ENGINES, required=True)
    cmd.add_argument("--label", required=True)
    cmd.add_argument("--job", action="append", default=None)
    cmd = commands.add_parser("measure")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--new", required=True)
    cmd.add_argument("--legacy", required=True)
    cmd.add_argument("--job", action="append", default=None)
    cmd.add_argument("--out", type=Path, required=True)
    cmd = commands.add_parser("kit")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--new", required=True)
    cmd.add_argument("--legacy", required=True)
    cmd.add_argument("--measure", type=Path, required=True)
    cmd.add_argument("--pairs", default="")
    cmd.add_argument("--out", type=Path, required=True)
    cmd = commands.add_parser("evidence")
    cmd.add_argument("--work", type=Path, required=True)
    cmd.add_argument("--measure", type=Path, required=True)
    cmd.add_argument("--legacy-run", required=True)
    cmd.add_argument("--new-run", required=True)
    cmd.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.command == "prepare":
        print(json.dumps(prepare(args.src, args.select, args.work), indent=1))
    elif args.command == "render":
        render(args.work, args.engine, args.label, args.job)
    elif args.command == "measure":
        result = measure(args.work, args.new, args.legacy, args.job)
        if args.out.exists() and args.job is not None:  # merge a partial run
            previous = _read_json(args.out)
            keep = [row for row in previous["clips"] if row["job"] not in args.job]
            result["clips"] = keep + result["clips"]
        _write_json(args.out, result)
    elif args.command == "kit":
        pairs = [pair for pair in args.pairs.split(",") if pair]
        print(json.dumps(kit(args.work, args.new, args.legacy, _read_json(args.measure), pairs,
                             args.out), indent=1))
    else:
        look, pf = evidence(_read_json(args.measure), args.work, args.legacy_run, args.new_run)
        _write_json(args.out_dir / f"{TASK}-P-LOOK.json", look)
        _write_json(args.out_dir / f"{TASK}-PF-PIPELINE.json", pf)
        print(json.dumps({"P-LOOK": look["summary"], "PF-PIPELINE": pf["layouts"]}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
