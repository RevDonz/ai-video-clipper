#!/usr/bin/env python3
"""Before/after check of the clip selection: the same clips, order and scores on two trees.

The benchmark CLI has no before/after mode (rombak 08 §8, Fase 2 i18n M5). Run ``dump`` once
with the base tree and once with the branch, then ``compare`` the two files::

    PYTHONPATH=<base>/src python scripts/eval/compare_benchmark_runs.py dump \\
        --gold G.gold.json --transcript T.json [--sound-events S.json] [--audio-timeline A.json] \\
        [--gold ... --transcript ...] --out base.json
    PYTHONPATH=src python scripts/eval/compare_benchmark_runs.py dump ... --out branch.json
    python scripts/eval/compare_benchmark_runs.py compare base.json branch.json

``dump`` runs the heuristic selector (``v3-heuristic``, no network) per episode with K clips and
the duration bounds, and writes every clip field the selector decides: rank, start, end, score,
sub-scores, reasons, packaging, cold open. ``compare`` also takes two ``ai_clipper.benchmark
--json`` reports. It ignores timings (``elapsed_seconds``) and prints each difference; exit 0
means identical, 1 different, 2 unreadable input.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

VOLATILE = frozenset({"elapsed_seconds"})


def _strip(value: object) -> object:
    if isinstance(value, dict):
        return {key: _strip(item) for key, item in value.items() if key not in VOLATILE}
    if isinstance(value, list):
        return [_strip(item) for item in value]
    return value


def differences(before: object, after: object, path: str = "$") -> list[str]:
    """Every place where ``after`` differs from ``before`` (timings ignored)."""
    before, after = _strip(before), _strip(after)
    found: list[str] = []
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(set(before) | set(after)):
            if key not in after:
                found.append(f"{path}.{key}: removed")
            elif key not in before:
                found.append(f"{path}.{key}: added")
            else:
                found.extend(differences(before[key], after[key], f"{path}.{key}"))
    elif isinstance(before, list) and isinstance(after, list):
        if len(before) != len(after):
            found.append(f"{path}: {len(before)} items before, {len(after)} after")
        for index, (old, new) in enumerate(zip(before, after)):
            found.extend(differences(old, new, f"{path}[{index}]"))
    elif before != after or type(before) is not type(after):
        found.append(f"{path}: {before!r} -> {after!r}")
    return found


def _clip(clip: object) -> dict[str, object]:
    return {
        "rank": clip.rank,  # type: ignore[attr-defined]
        "start": clip.start,  # type: ignore[attr-defined]
        "end": clip.end,  # type: ignore[attr-defined]
        "score": clip.score,  # type: ignore[attr-defined]
        "scores": dict(clip.scores),  # type: ignore[attr-defined]
        "reasons": list(clip.reasons),  # type: ignore[attr-defined]
        "source": clip.source,  # type: ignore[attr-defined]
        "title": clip.title,  # type: ignore[attr-defined]
        "hook_text": clip.hook_text,  # type: ignore[attr-defined]
        "description": clip.description,  # type: ignore[attr-defined]
        "hashtags": list(clip.hashtags),  # type: ignore[attr-defined]
        "archetype": clip.archetype,  # type: ignore[attr-defined]
        "cold_open": None if clip.cold_open is None else list(clip.cold_open),  # type: ignore[attr-defined]
        "unit_ids": list(clip.unit_ids),  # type: ignore[attr-defined]
    }


def dump(args: argparse.Namespace) -> int:
    from ai_clipper.benchmark import (
        load_audio_timeline,
        load_gold,
        load_sound_events,
        load_transcript,
    )
    from ai_clipper.selection_v3 import select_clips_v3

    count = len(args.gold)
    if len(args.transcript) != count or any(
        values and len(values) != count for values in (args.sound_events, args.audio_timeline)
    ):
        print("give one --transcript (and optionally one of each other file) per --gold", file=sys.stderr)
        return 2
    episodes = []
    for index, gold_path in enumerate(args.gold):
        gold = load_gold(gold_path)
        transcript = load_transcript(args.transcript[index])
        events = load_sound_events(args.sound_events[index]) if args.sound_events else ()
        audio = load_audio_timeline(args.audio_timeline[index]) if args.audio_timeline else None
        result = select_clips_v3(
            list(transcript.segments),
            k=args.k,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
            llm_mode="off",
            events=events,
            audio=audio,
        )
        episodes.append(
            {
                "source_id": gold.source_id,
                "status": result.status,
                "warnings": list(result.warnings),
                "clips": [_clip(clip) for clip in result.clips],
            }
        )
    payload = {"k": args.k, "duration": [args.min_duration, args.max_duration], "episodes": episodes}
    Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(f"{len(episodes)} episodes, {sum(len(item['clips']) for item in episodes)} clips")
    return 0


def compare(args: argparse.Namespace) -> int:
    try:
        before = json.loads(Path(args.before).read_text("utf-8"))
        after = json.loads(Path(args.after).read_text("utf-8"))
    except (OSError, ValueError) as error:
        print(f"unreadable input: {error}", file=sys.stderr)
        return 2
    found = differences(before, after)
    for line in found:
        print(line)
    print("identical" if not found else f"{len(found)} differences")
    return 0 if not found else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("dump", help="the heuristic selection of each episode, as JSON")
    run.add_argument("--gold", action="append", required=True)
    run.add_argument("--transcript", action="append", required=True)
    run.add_argument("--sound-events", action="append", default=[])
    run.add_argument("--audio-timeline", action="append", default=[])
    run.add_argument("--k", type=int, default=10)
    run.add_argument("--min-duration", type=float, default=20.0)
    run.add_argument("--max-duration", type=float, default=90.0)
    run.add_argument("--out", required=True)
    run.set_defaults(handler=dump)
    check = commands.add_parser("compare", help="the differences between two runs")
    check.add_argument("before")
    check.add_argument("after")
    check.set_defaults(handler=compare)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
