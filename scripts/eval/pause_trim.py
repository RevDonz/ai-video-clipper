#!/usr/bin/env python3
"""Pause trimming in automatic clips: how much dead air the seed's trims remove.

For every labelled moment of ``docs/evaluation/gold/*.gold.json`` (the selection benchmark's
clip-sized spans) this builds the words artifact the pipeline would build (the transcript, the
audio timeline, the caption tags and, with ``--peaks``, the clip's audio peaks) and runs
``cleanup.auto_pause_removals`` over the span as the body (CONTRACTS §5.57). Nothing is
rendered; ``--peaks`` decodes the audio of each window once (FFmpeg, mono 16 kHz).

The episode files are not committed: ``--eval-root`` is a folder with one directory per
episode holding ``transcript.json`` (``--transcript yt`` reads ``yt/transcript.json``),
``audio-timeline.json``, ``yt/analysis/sound-events.json`` and, for ``--peaks``, ``source.mp4``
or ``audio.m4a`` (``--media DIR`` adds ``DIR/<episode>-source.mp4``). Command, from the
repository root::

    nice -n 10 uv run python scripts/eval/pause_trim.py --eval-root DIR [--transcript yt] \\
        [--peaks] [--media DIR]

The method and the last results are in ``docs/evaluation/PAUSE_TRIM.md``.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from ai_clipper.audio_timeline import AudioTimeline
from ai_clipper.edit_v2 import cleanup
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.peaks import bin_count, build_peaks
from ai_clipper.edit_v2.words import build_words_artifact
from ai_clipper.sound_events import events_from_dict
from ai_clipper.transcript_io import read_transcript_json

ROOT = Path(__file__).resolve().parents[2]
GOLD = ROOT / "docs" / "evaluation" / "gold"
FPS = tm.Fps(30, 1)
CLIP_ID = "clip_" + "0" * 24
WINDOW_MARGIN_MS = 60_000


def _media(episode: Path, media: Path | None) -> Path | None:
    candidates = [episode / "source.mp4", episode / "audio.m4a"]
    if media is not None:
        candidates.append(media / f"{episode.name}-source.mp4")
    return next((path for path in candidates if path.is_file()), None)


def measure(eval_root: Path, *, transcript: str, peaks: bool, media: Path | None) -> dict:
    clips = []
    for gold in sorted(GOLD.glob("*.gold.json")):
        episode = eval_root / gold.name.split(".")[0]
        path = episode / ("transcript.json" if transcript == "whisper" else "yt/transcript.json")
        timeline = episode / "audio-timeline.json"
        if not path.is_file() or not timeline.is_file():
            continue
        words_in = read_transcript_json(path)
        audio = AudioTimeline.from_dict(json.loads(timeline.read_text(encoding="utf-8")))
        tags_path = episode / "yt" / "analysis" / "sound-events.json"
        tags = (events_from_dict(json.loads(tags_path.read_text(encoding="utf-8")))[0]
                if tags_path.is_file() else None)
        source = _media(episode, media) if peaks else None
        duration_ms = round(audio.duration * 1000)
        for moment in json.loads(gold.read_text(encoding="utf-8"))["moments"]:
            start, end = round(moment["start"] * 1000), round(moment["end"] * 1000)
            window = (max(0, start - WINDOW_MARGIN_MS), min(duration_ms, end + WINDOW_MARGIN_MS))
            raw = (build_peaks(source, window) if source is not None
                   else bytes(2 * bin_count(window)))
            words = build_words_artifact(words_in, clip_id=CLIP_ID, window_ms=window, fps=FPS,
                                         audio=audio, events=tags, peaks=raw)
            body = {"id": "seg_b1", "role": "body", "in_sf": tm.sf_floor(start, FPS),
                    "out_sf": tm.sf_ceil(end, FPS)}
            removals = cleanup.auto_pause_removals(
                words, body=body, peaks=raw if source is not None else None)
            inside = [gap for gap in words["gaps"] if start <= gap["s"] and gap["e"] <= end]
            clips.append({
                "episode": episode.name, "moment": moment["id"], "body_ms": end - start,
                "trims": len(removals),
                "removed_ms": round(sum(r["out_sf"] - r["in_sf"] for r in removals)
                                    * 1000 * FPS.den / FPS.num),
                "gaps": {kind: sum(1 for gap in inside if gap["class"] == kind)
                         for kind in ("silent", "voiced", "laughter")},
            })
    body = sum(clip["body_ms"] for clip in clips)
    removed = sum(clip["removed_ms"] for clip in clips)
    shares = sorted(clip["removed_ms"] / clip["body_ms"] for clip in clips)
    trims = sum(clip["trims"] for clip in clips)
    return {
        "transcript": transcript, "peaks": peaks, "clips": len(clips),
        "body_s": round(body / 1000, 1), "removed_s": round(removed / 1000, 1),
        "removed_share": round(removed / body, 4) if body else 0.0,
        "clips_trimmed": sum(1 for clip in clips if clip["trims"]),
        "trims": trims, "mean_trim_ms": round(removed / trims) if trims else 0,
        "share_p50": round(statistics.median(shares), 4) if shares else 0.0,
        "share_p90": round(shares[int(len(shares) * 0.9)], 4) if shares else 0.0,
        "share_max": round(shares[-1], 4) if shares else 0.0,
        "gaps_over_600ms": {kind: sum(clip["gaps"][kind] for clip in clips)
                            for kind in ("silent", "voiced", "laughter")},
        "per_clip": clips,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--eval-root", type=Path, required=True)
    parser.add_argument("--transcript", choices=("whisper", "yt"), default="whisper")
    parser.add_argument("--peaks", action="store_true")
    parser.add_argument("--media", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    result = measure(args.eval_root, transcript=args.transcript, peaks=args.peaks,
                     media=args.media)
    summary = {key: value for key, value in result.items() if key != "per_clip"}
    print(json.dumps(summary, indent=1))
    if args.out is not None:
        args.out.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
