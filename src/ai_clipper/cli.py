"""Command-line entry point for the clipping spike."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from .captions_ass import CAPTION_STYLES
from .focus import MAX_FOCUS_NOTE_CHARS, parse_focus
from .llm import LLMError
from .models import ClipProfile, SelectionMode
from .pipeline import (
    DEFAULT_HOOK_DURATION,
    DEFAULT_LLM_MODE,
    DEFAULT_MAX_CANDIDATES,
    DEFAULT_MAX_MEDIA_CANDIDATES,
    DEFAULT_MEDIA_TIMEOUT,
    MAX_MEDIA_CANDIDATES,
    MAX_MEDIA_TIMEOUT,
    run_pipeline,
)
from .ranking import MAX_RANKING_INPUTS
from .render import HOOK_DURATION_MAX_SECONDS, RENDER_MODES
from .selection_types import MAX_FOCUS_TERM_CHARS, MAX_FOCUS_TERMS, MIN_FOCUS_TERM_CHARS
from .selection_v3 import LLM_MODES
from .time_ranges import MAX_RANGES, TimeRange, TimeRangeError, check_ranges, parse_time_range
from .transcribe import (
    ENV_CONDITION_ON_PREVIOUS_TEXT,
    ENV_INITIAL_PROMPT,
    ENV_PROMPT_EVERY_WINDOW,
    load_whisper_model,
    whisper_decoding_from_env,
)
from .transcribe_groq import groq_from_env


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


def _language(value: str) -> str | None:
    """The Whisper language; ``auto`` is ``None``, which lets Whisper detect it."""
    return None if value == "auto" else value


def _time_range(value: str) -> TimeRange:
    try:
        return parse_time_range(value)
    except TimeRangeError as error:
        raise argparse.ArgumentTypeError(str(error)) from None


def _hook_duration(value: str) -> float:
    result = float(value)
    if not math.isfinite(result) or not 0 < result <= HOOK_DURATION_MAX_SECONDS:
        raise argparse.ArgumentTypeError(
            f"hook duration must be finite, above 0 and at most {HOOK_DURATION_MAX_SECONDS:g}"
        )
    return result


class _LazyWhisperModel:
    """Loads Whisper on the first ``transcribe`` call, so usable captions skip the load."""

    def __init__(self, load: Callable[[], Any]) -> None:
        self._load = load
        self._model: Any = None

    def transcribe(self, *args: Any, **kwargs: Any) -> Any:
        if self._model is None:
            self._model = self._load()
        return self._model.transcribe(*args, **kwargs)


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
    parser.add_argument(
        "--language",
        type=_language,
        default="id",
        help="spoken language code, or auto to detect it (default: id)",
    )
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
        default=SelectionMode.V3.value,
        help="moment selection (default: v3, the current one; v1 and v2-shadow are kept for old jobs)",
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
    v3 = parser.add_argument_group("Selection V3 (--selection-mode v3)")
    v3.add_argument(
        "--llm",
        dest="llm_mode",
        choices=LLM_MODES,
        default=DEFAULT_LLM_MODE,
        help="LLM moment selection: auto falls back to the local heuristic (default: auto)",
    )
    v3.add_argument(
        "--cold-open",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="play the hook line before the clip (default: on)",
    )
    v3.add_argument(
        "--hook-overlay",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="show the hook text at the top for the first seconds (default: on)",
    )
    v3.add_argument(
        "--hook-duration",
        type=_hook_duration,
        default=DEFAULT_HOOK_DURATION,
        help=f"hook overlay seconds (default: {DEFAULT_HOOK_DURATION:g})",
    )
    v3.add_argument(
        "--captions-dir",
        type=Path,
        help="read-only YouTube json3 captions in manual/ and auto/; usable ones skip Whisper",
    )
    v3.add_argument(
        "--trend-context",
        type=Path,
        help=(
            "Konteks Tren snapshot (analysis/trend-context.json, version 1); an invalid file "
            "only adds the warning trend_context_invalid"
        ),
    )
    v3.add_argument(
        "--focus-term",
        dest="focus_terms",
        action="append",
        metavar="TERM",
        help=(
            f"Fokus klip: a term to look for (repeatable, at most {MAX_FOCUS_TERMS}, "
            f"{MIN_FOCUS_TERM_CHARS}-{MAX_FOCUS_TERM_CHARS} characters); matching clips "
            "come first"
        ),
    )
    v3.add_argument(
        "--focus-note",
        metavar="TEXT",
        help=(
            f"Fokus klip: a note for the AI about the terms (at most {MAX_FOCUS_NOTE_CHARS} "
            "characters; needs --focus-term)"
        ),
    )
    v3.add_argument(
        "--range",
        dest="ranges",
        action="append",
        type=_time_range,
        metavar="START-END",
        help=(
            "Rentang waktu: a time range kept as a clip, such as 10.30-12.05, 1:02:10-1:03:00 or "
            f"630-725 seconds (repeatable, at most {MAX_RANGES} and at most --limit, no "
            "overlaps); the selection fills the other slots"
        ),
    )
    parser.add_argument(
        "--caption-style",
        choices=CAPTION_STYLES,
        default=None,
        help="burned captions (default: karaoke for v3, classic otherwise)",
    )
    parser.add_argument(
        "--word-timestamps",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="ask Whisper for word timestamps (default: on)",
    )
    parser.add_argument(
        "--initial-prompt",
        help=(
            f"Whisper style prompt, 'off' for none (default: ${ENV_INITIAL_PROMPT} "
            "or, for Indonesian, a short punctuated casual Indonesian prompt)"
        ),
    )
    parser.add_argument(
        "--condition-on-previous-text",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "let Whisper condition each window on the previous text "
            f"(default: ${ENV_CONDITION_ON_PREVIOUS_TEXT} or off)"
        ),
    )
    parser.add_argument(
        "--prompt-every-window",
        action=argparse.BooleanOptionalAction,
        default=None,
        help=(
            "put the prompt in front of every 30 s window, not only the first "
            f"(default: ${ENV_PROMPT_EVERY_WINDOW} or on)"
        ),
    )
    return parser


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse ``argv``; ``focus`` is the Fokus klip option built from the focus flags, or None,
    and ``ranges`` the typed time ranges (a tuple, empty without ``--range``).

    The focus text is only ever parsed here and handed to the pipeline as data; it never
    reaches a subprocess command line.
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.focus = parse_focus(args.focus_terms, args.focus_note)
    except (TypeError, ValueError) as error:
        parser.error(f"--focus-term/--focus-note: {error}")
    if args.focus is not None and args.selection_mode != SelectionMode.V3.value:
        parser.error("--focus-term needs --selection-mode v3")
    try:
        args.ranges = check_ranges(args.ranges or (), args.limit)
    except TimeRangeError as error:
        parser.error(f"--range: {error}")
    if args.ranges and args.selection_mode != SelectionMode.V3.value:
        parser.error("--range needs --selection-mode v3")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        decoding = whisper_decoding_from_env(
            os.environ,
            initial_prompt=args.initial_prompt,
            condition_on_previous_text=args.condition_on_previous_text,
            prompt_every_window=args.prompt_every_window,
            language=args.language,
        )
        # Pengaturan "Transkripsi" (opt-in): the worker sets the switch and the key in the env.
        groq = groq_from_env(os.environ, prompt=decoding.initial_prompt)
        if args.selection_mode == SelectionMode.V3.value:
            model: Any = _LazyWhisperModel(
                lambda: load_whisper_model(args.model, device=args.device, decoding=decoding)
            )
        else:
            groq = None
            model = load_whisper_model(args.model, device=args.device, decoding=decoding)

        # A stage summary repeats the latest progress line, so every line stays a full progress
        # event; before the first one the worker's own line (web/scripts/run-job.mjs) applies.
        latest: dict[str, object] = {
            "stage": "analyzing",
            "progress": 0,
            "detail": "Menyiapkan engine AI",
        }

        def emit(event: dict[str, object]) -> None:
            payload = json.dumps(event, ensure_ascii=False)
            print(f"POTONGIN_PROGRESS {payload}", flush=True)

        def emit_progress(stage: str, progress: int, detail: str) -> None:
            latest.update(stage=stage, progress=progress, detail=detail)
            emit(latest)

        def emit_stage_summary(kind: str, values: dict[str, object]) -> None:
            emit({**latest, "summary": {kind: values}})

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
            llm_mode=args.llm_mode,
            cold_open=args.cold_open,
            hook_overlay=args.hook_overlay,
            caption_style=args.caption_style,
            captions_dir=args.captions_dir,
            word_timestamps=args.word_timestamps,
            hook_duration=args.hook_duration,
            progress=emit_progress,
            stage_summary=emit_stage_summary,
            trend_context=args.trend_context,
            focus=args.focus,
            ranges=args.ranges,
            groq=groq,
        )
    except (FileNotFoundError, RuntimeError, ValueError, LLMError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    print(f"Pipeline selesai. Manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
