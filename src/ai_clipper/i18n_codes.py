"""Stage, reason and warning codes the engine writes beside its Indonesian prose (rombak 07 §10.4).

The web shows ``stage.<code>``, ``reason.<code>`` and ``reason.warning.<code>`` from its message
catalogs (``web/messages/<locale>/{stage,reason}.json``) in the person's language; the prose stays
for logs, old web images and jobs written before the codes existed. Python never knows the UI
language. ``web/lib/i18n/stage.mjs`` holds the same lists, and ``web/tests/i18n-stage-codes``
checks that both agree and that every code has a message in every locale.

- **Stage** (``report(stage, percent, detail, code=..., params=...)``): ``stage_code`` and
  ``stage_params`` on the progress line. Params are numbers.
- **Reason** (``reason_codes`` on a V3 manifest clip, one entry per ``reasons`` item, same order):
  ``{"code": <code>, "params": {...}}``. A reason the engine did not write from a template (the
  LLM's own words, which are content in the video's language) is ``{"code": "text", "params":
  {"text": <reason>}}`` and is shown as written.
- **Warning** (``warning_codes``: the V3 summary's ``warnings`` and, per clip, the warnings that
  name that clip): the ``code[:detail]`` strings split into ``{"code", "params"}`` by
  :data:`WARNING_PARAMS`.
"""

from __future__ import annotations

# Progress stages the engine reports (pipeline.py). The web adds its own (run-job.mjs,
# primary-job-queue.mjs); web/lib/i18n/stage.mjs lists all of them.
STAGE_CODES = (
    "analyze_video",
    "captions_upload",
    "captions_check",
    "transcribe_groq",
    "transcribe_groq_progress",  # {percent}
    "transcribe_audio",
    "transcribe_progress",  # {percent}
    "audio_analysis",
    "select_llm",
    "select_heuristic",
    "select_ranges",
    "select_moments",
    "packaging",
    "render_clip",  # {index, total}
    "finalizing",
    "candidates_generating",
    "candidates_features",
    "candidates_shortlist",
    "candidates_media",
    "candidates_ready",
)

TEXT_REASON = "text"  # not a template: shown as written (params.text)

REASON_CODES = (
    # hook_heuristics._OPENER_REASONS
    "open_question",  # {run}
    "open_setup",  # {run}
    "open_story",
    "open_contrast",
    "open_reveal",
    "open_number",
    "open_cold_open",
    "open_plain",
    # the hook line, with or without its tags (reason.tag.<tag>)
    "hook_line",  # {offset, text}
    "hook_line_tagged",  # {offset, text, tags}
    "teaser_echo",
    "end_laugh",
    "end_recap",
    "end_pause",  # {gap}
    "end_question",
    "laughs",  # {count}
    "silence",  # {ratio}
    "penalty_teaser",
    "penalty_sponsor",
    "penalty_segue",
    "penalty_outro",
    "penalty_greeting",
    "penalty_small_talk",
    "penalty_suspect",
    "penalty_fillers",
    "penalty_dense_laughs",
    "similar_topic",
    # selection_v3.py
    "cold_open",  # {seconds}
    "focus_fill",
    "heuristic_fill",
    "trend",  # {title}
    "trend_sensitive",  # {title}
    "manual_range",  # {label}
    # llm_selection.py
    "llm_rerank",  # {score}
)

# The hook line's tags (hook_heuristics._TAG_LABELS keys): reason.tag.<tag>.
REASON_TAGS = (
    "confession",
    "insider",
    "reveal",
    "contrast",
    "stakes",
    "superlative",
    "number",
    "reported",
    "story",
)

_COUNT = ("count",)
_CLIP = ("clip",)
_DETAIL = ("detail",)

# Every warning code of the V3 summary and its params: the parts after ``code:``, split at ":"
# (the last name takes the rest); a part of digits only is a number. A code without a detail
# has no params.
WARNING_PARAMS: dict[str, tuple[str, ...]] = {
    "media_probe_failed": (),
    "subtitle_rejected": _DETAIL,
    "captions_missing": (),
    "captions_rejected": _DETAIL,
    "groq_fallback": _DETAIL,
    "no_word_timestamps": (),
    "quantized_timestamps": (),
    "punctuation_collapse": _DETAIL,
    "suspect_segments": _COUNT,
    "audio_unavailable": _DETAIL,
    "trend_context_invalid": (),
    "trend_items_skipped": _COUNT,
    "llm_unavailable": _DETAIL,
    "llm_disabled": (),
    "llm_not_configured": (),
    "llm_failed": _DETAIL,
    "llm_chunked": _COUNT,
    "llm_chunk_failed": ("chunk", "detail"),
    "llm_dropped": ("count", "detail"),
    "llm_no_moments": _DETAIL,
    "llm_retry": ("mode", "count"),
    "llm_retry_failed": _DETAIL,
    "llm_rerank_failed": _DETAIL,
    "llm_filled": _COUNT,
    "snap_dropped": _COUNT,
    "trend_ref_ungrounded": _COUNT,
    "trend_packaging_ungrounded": _COUNT,
    "trend_sensitive_humor": _COUNT,
    "focus_terms_unmatchable": _COUNT,
    "focus_literal_ungrounded": _COUNT,
    "focus_packaging_ungrounded": _COUNT,
    "focus_few_matches": _COUNT,
    "focus_topup": _COUNT,
    "focus_topup_failed": _DETAIL,
    "focus_topup_skipped": _DETAIL,
    "few_clips": _COUNT,
    "no_transcript": (),
    "clip_trimmed_to_media": _CLIP,
    "cold_open_beyond_media": _CLIP,
    "clip_beyond_media": _CLIP,
    "llm_providers": _COUNT,
    "llm_models": _COUNT,
    "engine_fallback": _CLIP,
    "clip_failed": _CLIP,
    "thumbnail_failed": _CLIP,
    "auto_reframe_failed": _CLIP,
    "pipeline_failed": _DETAIL,
}
WARNING_CODES = tuple(WARNING_PARAMS)

# Warnings about one rendered clip that its manifest entry repeats as ``warning_codes``: <clip> is
# its index (its clip-XX number). ``engine_fallback`` and ``clip_failed`` are on the entry already
# (``fallbacks``, ``status`` and ``error_code``); the media-fit codes name the selection's rank
# before clips past the video were dropped, so they stay in the summary only.
CLIP_WARNINGS = frozenset({"thumbnail_failed", "auto_reframe_failed"})

_DIGITS = frozenset("0123456789")


def _value(part: str) -> int | str:
    return int(part) if part and len(part) <= 9 and set(part) <= _DIGITS else part


def warning_code(warning: str) -> dict[str, object] | None:
    """``{"code", "params"}`` of one ``code[:detail]`` warning, or ``None`` for an unknown code
    or a detail that does not fit the code's params."""
    if not isinstance(warning, str):
        return None
    code, _, detail = warning.partition(":")
    names = WARNING_PARAMS.get(code)
    if names is None:
        return None
    if not names:
        return {"code": code, "params": {}} if not detail else None
    if not detail:
        return {"code": code, "params": {}} if names == _DETAIL else None
    parts = detail.split(":", len(names) - 1)
    if len(parts) != len(names):
        return None
    params = {name: _value(part) for name, part in zip(names, parts)}
    if any(name in ("count", "clip", "chunk") and not isinstance(params[name], int)
           for name in names):
        return None
    return {"code": code, "params": params}


def warning_codes(warnings: object) -> list[dict[str, object]]:
    """The coded form of ``warnings`` (unknown codes are left out), in order."""
    if isinstance(warnings, (str, bytes)) or not hasattr(warnings, "__iter__"):
        return []
    coded = (warning_code(item) for item in warnings)  # type: ignore[union-attr]
    return [item for item in coded if item is not None]


def clip_warning_codes(warnings: object, index: int) -> list[dict[str, object]]:
    """The coded :data:`CLIP_WARNINGS` that name the clip with this ``index``."""
    return [
        item
        for item in warning_codes(warnings)
        if item["code"] in CLIP_WARNINGS and item["params"] == {"clip": index}
    ]
