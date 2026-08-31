"""Command-line entry point for the clipping spike."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Sequence
from pathlib import Path

from .models import ClipProfile, SelectionMode
from .pipeline import (
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_MAX_MEDIA_CANDIDATES,
    DEFAULT_MEDIA_TIMEOUT,
    MAX_MEDIA_CANDIDATES,
    MAX_MEDIA_TIMEOUT,
    run_pipeline,
)
from .ranking import MAX_RANKING_INPUTS
from .render import RENDER_MODES
from .transcribe import load_whisper_model


def _bounded_int(name: str, maximum: int):
    def parse(value: str) -> int:
        result = int(value)
        if not 1 <= result <= maximum:
            raise argparse.ArgumentTypeError(f"{name} must be between 1 and {maximum}")
        return result

    return parse


def _media_timeout(value: str) -> float:
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= MAX_MEDIA_TIMEOUT:
        raise argparse.ArgumentTypeError(
            f"media timeout must be finite and between 0 and {MAX_MEDIA_TIMEOUT}"
        )
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ai-clipper",
        description="Transcribe a long video and render vertical captioned highlights.",
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/output"))
    parser.add_argument("--artifact-root", type=Path)
    parser.add_argument("--model", default="tiny", help="faster-whisper model name")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--language", default="id")
    parser.add_argument("--min-duration", type=float, default=20.0)
    parser.add_argument("--max-duration", type=float, default=60.0)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument(
        "--render-mode",
        choices=RENDER_MODES,
        default="face-track",
        help="portrait framing strategy",
    )
    parser.add_argument(
        "--selection-mode",
        choices=tuple(mode.value for mode in SelectionMode),
        default=SelectionMode.V1.value,
    )
    parser.add_argument(
        "--clip-profile",
        choices=tuple(profile.value for profile in ClipProfile),
        default=ClipProfile.STANDARD.value,
    )
    parser.add_argument(
        "--max-candidates",
        type=_bounded_int("max candidates", MAX_RANKING_INPUTS),
        default=DEFAULT_MAX_CANDIDATES,
    )
    parser.add_argument(
        "--max-media-candidates",
        type=_bounded_int("max media candidates", MAX_MEDIA_CANDIDATES),
        default=DEFAULT_MAX_MEDIA_CANDIDATES,
    )
    parser.add_argument(
        "--media-timeout",
        type=_media_timeout,
        default=DEFAULT_MEDIA_TIMEOUT,
    )
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    return build_parser().parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        model = load_whisper_model(args.model, device=args.device)

        def emit_progress(stage: str, progress: int, detail: str) -> None:
            payload = json.dumps(
                {"stage": stage, "progress": progress, "detail": detail},
                ensure_ascii=False,
            )
            print(f"POTONGIN_PROGRESS {payload}", flush=True)

        manifest = run_pipeline(
            args.source,
            args.output_dir,
            model=model,
            artifact_root=args.artifact_root,
            language=args.language,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
            limit=args.limit,
            width=args.width,
            height=args.height,
            render_mode=args.render_mode,
            selection_mode=args.selection_mode,
            clip_profile=args.clip_profile,
            max_candidates=args.max_candidates,
            max_media_candidates=args.max_media_candidates,
            media_timeout=args.media_timeout,
            progress=emit_progress,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Pipeline selesai. Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
