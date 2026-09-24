"""Speech-to-text adapter backed by faster-whisper.

Decoding defaults (measured in ``docs/operations/TRANSCRIPTION.md``):

- ``condition_on_previous_text=False``. With Whisper's default (``True``) each 30 s window is
  prompted with the previous text, so one window without punctuation made every later window
  copy that style and whole episodes lost their punctuation (0–4% of segments ending in
  ``.?!``). Decoded on its own, a window cannot inherit the collapse.
- A short, punctuated, casual Indonesian prompt in front of *every* window (faster-whisper's
  ``hotwords`` slot). Whisper's ``initial_prompt`` reaches only the first window once
  conditioning is off, which left ~20% of segments unpunctuated with ``small`` and most of
  them with ``large-v3-turbo``.

``load_whisper_model`` returns a :class:`WhisperEngine` that applies these defaults to every
``transcribe`` call; ``WHISPER_INITIAL_PROMPT``, ``WHISPER_CONDITION_ON_PREVIOUS_TEXT`` and
``WHISPER_PROMPT_EVERY_WINDOW`` change them (:func:`whisper_decoding_from_env`).
"""

from __future__ import annotations

import math
import os
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import Transcription, TranscriptSegment, TranscriptWord

ENV_INITIAL_PROMPT = "WHISPER_INITIAL_PROMPT"
ENV_CONDITION_ON_PREVIOUS_TEXT = "WHISPER_CONDITION_ON_PREVIOUS_TEXT"
ENV_PROMPT_EVERY_WINDOW = "WHISPER_PROMPT_EVERY_WINDOW"
# Only common casual words: Whisper hears the prompt before every window, so a distinctive
# phrase (an earlier "apa kabar?" prompt) got primed into the transcript for similar sounds.
DEFAULT_INITIAL_PROMPT = (
    "Oke, jadi gini. Sebenernya gue juga nggak nyangka, literally. "
    "Terus, kenapa bisa kayak gitu? Ya, karena emang gitu, kan?"
)
DEFAULT_CONDITION_ON_PREVIOUS_TEXT = False
DEFAULT_PROMPT_EVERY_WINDOW = True
# Whisper uses at most 223 prompt tokens (the default is 37); longer prompts cost decoding time.
MAX_INITIAL_PROMPT_CHARS = 400
_PROMPT_OFF_VALUES = frozenset({"off", "none"})
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


def _prompt_problem(prompt: str) -> bool:
    return (
        not prompt
        or len(prompt) > MAX_INITIAL_PROMPT_CHARS
        or prompt != " ".join(prompt.split())
        or not prompt.isprintable()
    )


@dataclass(frozen=True, slots=True)
class WhisperDecoding:
    """Whisper decoding defaults.

    ``initial_prompt`` is single-spaced text or None. With ``prompt_every_window`` it goes in
    front of every 30 s window (faster-whisper's ``hotwords`` slot, which is prepended to the
    prompt of each window); otherwise Whisper sees it before the first window only, and after
    that only when ``condition_on_previous_text`` carries the text along.
    """

    initial_prompt: str | None = DEFAULT_INITIAL_PROMPT
    condition_on_previous_text: bool = DEFAULT_CONDITION_ON_PREVIOUS_TEXT
    prompt_every_window: bool = DEFAULT_PROMPT_EVERY_WINDOW

    def __post_init__(self) -> None:
        if self.initial_prompt is not None:
            if not isinstance(self.initial_prompt, str):
                raise TypeError("initial_prompt must be a string or None")
            if _prompt_problem(self.initial_prompt):
                raise ValueError(
                    "initial_prompt must be non-empty, single-spaced printable text of at most "
                    f"{MAX_INITIAL_PROMPT_CHARS} characters"
                )
        if not isinstance(self.condition_on_previous_text, bool):
            raise TypeError("condition_on_previous_text must be a bool")
        if not isinstance(self.prompt_every_window, bool):
            raise TypeError("prompt_every_window must be a bool")

    def options(self) -> dict[str, object]:
        """Keyword arguments for ``WhisperModel.transcribe``."""
        every = self.prompt_every_window
        return {
            "initial_prompt": None if every else self.initial_prompt,
            "hotwords": self.initial_prompt if every else None,
            "condition_on_previous_text": self.condition_on_previous_text,
        }


def _parse_prompt(name: str, raw: str) -> str | None:
    prompt = " ".join(raw.split())
    if prompt.casefold() in _PROMPT_OFF_VALUES:
        return None
    if _prompt_problem(prompt):
        # Never echo the value: the message ends up in job logs.
        raise ValueError(
            f"{name} harus teks tanpa karakter kontrol, maksimal {MAX_INITIAL_PROMPT_CHARS} "
            "karakter (atau 'off' untuk tanpa prompt)."
        )
    return prompt


def _parse_bool(name: str, raw: str) -> bool:
    lowered = raw.strip().casefold()
    if lowered in _TRUE_VALUES:
        return True
    if lowered in _FALSE_VALUES:
        return False
    raise ValueError(f"{name} harus true/false (atau 1/0).")


def _resolve_bool(
    env: Mapping[str, str], variable: str, explicit: bool | None, name: str, default: bool
) -> bool:
    if explicit is not None:
        if not isinstance(explicit, bool):
            raise TypeError(f"{name} must be a bool or None")
        return explicit
    raw = env.get(variable, "")
    return _parse_bool(variable, raw) if raw.strip() else default


def whisper_decoding_from_env(
    env: Mapping[str, str] | None = None,
    *,
    initial_prompt: str | None = None,
    condition_on_previous_text: bool | None = None,
    prompt_every_window: bool | None = None,
) -> WhisperDecoding:
    """Decoding defaults from explicit values (CLI flags), else the environment, else built in.

    ``WHISPER_INITIAL_PROMPT`` (and ``initial_prompt``) is whitespace-normalized; ``off`` or
    ``none`` means no prompt. ``WHISPER_CONDITION_ON_PREVIOUS_TEXT`` and
    ``WHISPER_PROMPT_EVERY_WINDOW`` take true/false, 1/0, yes/no or on/off. A blank variable
    counts as unset, so compose can always pass it through. Invalid values raise
    ``ValueError`` without echoing them.
    """
    env = os.environ if env is None else env
    defaults = WhisperDecoding()
    if initial_prompt is not None:
        prompt = _parse_prompt("--initial-prompt", initial_prompt)
    elif (raw_prompt := env.get(ENV_INITIAL_PROMPT, "")).strip():
        prompt = _parse_prompt(ENV_INITIAL_PROMPT, raw_prompt)
    else:
        prompt = defaults.initial_prompt
    condition = _resolve_bool(
        env,
        ENV_CONDITION_ON_PREVIOUS_TEXT,
        condition_on_previous_text,
        "condition_on_previous_text",
        defaults.condition_on_previous_text,
    )
    every = _resolve_bool(
        env,
        ENV_PROMPT_EVERY_WINDOW,
        prompt_every_window,
        "prompt_every_window",
        defaults.prompt_every_window,
    )
    return WhisperDecoding(prompt, condition, every)


class WhisperEngine:
    """A loaded Whisper model plus the decoding defaults every ``transcribe`` call gets.

    Options passed to ``transcribe`` win over the defaults. A call that passes its own
    ``initial_prompt`` or ``hotwords`` replaces the configured prompt entirely, so two prompts
    never stack.
    """

    __slots__ = ("decoding", "model")

    def __init__(self, model: Any, decoding: WhisperDecoding) -> None:
        if not isinstance(decoding, WhisperDecoding):
            raise TypeError("decoding must be a WhisperDecoding")
        self.model = model
        self.decoding = decoding

    def transcribe(self, audio: Any, **options: Any) -> Any:
        defaults = self.decoding.options()
        if "initial_prompt" in options or "hotwords" in options:
            del defaults["initial_prompt"], defaults["hotwords"]
        return self.model.transcribe(audio, **{**defaults, **options})


def load_whisper_model(
    model_size: str = "tiny",
    *,
    device: str = "cpu",
    decoding: WhisperDecoding | None = None,
) -> WhisperEngine:
    """Load faster-whisper (int8 on CPU) with ``decoding`` (default: the measured defaults)."""
    if decoding is None:
        decoding = WhisperDecoding()
    elif not isinstance(decoding, WhisperDecoding):
        raise TypeError("decoding must be a WhisperDecoding or None")
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "Transcription dependencies are missing; run `uv sync --extra transcribe`."
        ) from exc
    compute_type = "int8" if device == "cpu" else "float16"
    return WhisperEngine(
        WhisperModel(model_size, device=device, compute_type=compute_type), decoding
    )


def _finite(value: object) -> float | None:
    try:
        result = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _clean_text(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _probability(value: object) -> float | None:
    result = _finite(value) if value is not None and not isinstance(value, bool) else None
    return None if result is None else min(1.0, max(0.0, result))


def _normalize_words(
    raw_words: Iterable[Any] | None, segment_start: float, segment_end: float
) -> tuple[TranscriptWord, ...]:
    """Keep non-empty, finite words, clamped chronologically inside their segment."""
    words: list[TranscriptWord] = []
    earliest = segment_start
    for raw in raw_words or ():
        text = _clean_text(getattr(raw, "word", None))
        start = _finite(getattr(raw, "start", None))
        end = _finite(getattr(raw, "end", None))
        if not text or start is None or end is None:
            continue
        start = min(max(start, earliest, 0.0), segment_end)
        end = min(max(end, start), segment_end)
        words.append(
            TranscriptWord(start, end, text, _probability(getattr(raw, "probability", None)))
        )
        earliest = start
    return tuple(words)


def transcribe_video(
    source: Path,
    *,
    model: Any,
    language: str | None = "id",
    progress_callback: Callable[[float], None] | None = None,
    word_timestamps: bool = True,
    initial_prompt: str | None = None,
    condition_on_previous_text: bool | None = None,
) -> Transcription:
    """Transcribe ``source`` into chronological, non-overlapping segments.

    With ``word_timestamps`` (the default) every segment carries its recognized words.
    ``initial_prompt`` and ``condition_on_previous_text`` are passed to Whisper unchanged when
    given; ``None`` leaves them to the model, i.e. the :class:`WhisperEngine` defaults from
    :func:`load_whisper_model`.
    """
    source = Path(source)
    if not source.is_file():
        raise FileNotFoundError(source)
    decoding: dict[str, object] = {}
    if initial_prompt is not None:
        if not isinstance(initial_prompt, str):
            raise TypeError("initial_prompt must be a string or None")
        decoding["initial_prompt"] = initial_prompt
    if condition_on_previous_text is not None:
        if not isinstance(condition_on_previous_text, bool):
            raise TypeError("condition_on_previous_text must be a bool or None")
        decoding["condition_on_previous_text"] = condition_on_previous_text

    raw_segments, info = model.transcribe(
        str(source),
        language=language,
        vad_filter=True,
        beam_size=5,
        word_timestamps=bool(word_timestamps),
        **decoding,
    )
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    segments: list[TranscriptSegment] = []
    previous_end = 0.0
    for segment in raw_segments:
        raw_start = _finite(getattr(segment, "start", None))
        end = _finite(getattr(segment, "end", None))
        text = _clean_text(getattr(segment, "text", None))
        if raw_start is not None and end is not None:
            start = max(raw_start, previous_end, 0.0)
            if text and end > start:
                words = (
                    _normalize_words(getattr(segment, "words", None), start, end)
                    if word_timestamps
                    else ()
                )
                segments.append(TranscriptSegment(start, end, text, words))
                previous_end = end
        if progress_callback is not None and duration > 0 and end is not None:
            progress_callback(min(1.0, max(0.0, end / duration)))
    detected_language = str(getattr(info, "language", language or "unknown"))
    return Transcription(detected_language, segments)
