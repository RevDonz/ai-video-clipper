"""Command-line entry point for the clipping spike."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from .pipeline import run_pipeline
from .render import RENDER_MODES
from .transcribe import load_whisper_model


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ai-clipper",
        description="Transcribe a long video and render vertical captioned highlights.",
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/output"))
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
            language=args.language,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
            limit=args.limit,
            width=args.width,
            height=args.height,
            render_mode=args.render_mode,
            progress=emit_progress,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Pipeline selesai. Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
