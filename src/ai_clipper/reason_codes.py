"""A clip's ``reasons`` read back as codes (rombak 07 §10.4, i18n M5).

The selector writes Indonesian reasons from fixed templates (:mod:`ai_clipper.hook_heuristics`,
:mod:`ai_clipper.selection_v3`, :mod:`ai_clipper.llm_selection`) and the LLM writes its own,
which are content in the video's language. :func:`reason_codes` gives one
``{"code", "params"}`` per reason, in order: a template's code from
:data:`ai_clipper.i18n_codes.REASON_CODES` with the values it was filled with, or
``{"code": "text", "params": {"text": <reason>}}`` for anything else (the LLM's words, or a
reason cut at 300 characters), which the web shows as written.

Reading the reasons back keeps the selection untouched: the clips, their order, scores and
``reasons`` are exactly what they were, the manifest only gains ``reason_codes``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

from .hook_heuristics import _OPENER_REASONS, _TAG_LABELS
from .i18n_codes import REASON_TAGS, TEXT_REASON
from .selection_v3 import (
    COLD_OPEN_REASON,
    FOCUS_FILL_REASON,
    HEURISTIC_FILL_REASON,
    MANUAL_REASON,
    SENSITIVE_TREND_REASON,
    TREND_REASON,
)

MAX_TEXT = 300  # web/lib/i18n/stage.mjs: a longer string param is refused there
MAX_NUMBER = 1_000_000

_FIELD = re.compile(r"\{(\w+)(?::([^}]*))?\}")
# The format of each field in its template, as the producer writes it.
_FORMATS: dict[str, tuple[str, Callable[[str], object]]] = {
    ".0f": (r"\d{1,7}", int),
    ".1f": (r"\d{1,7}\.\d", float),
    ",1f": (r"\d{1,7},\d", lambda text: float(text.replace(",", "."))),
    ".0%": (r"\d{1,7}%", lambda text: int(text[:-1]) / 100),
    "": (r".+", str),
}

# hook_heuristics._reasons writes these from local literals; tests/test_reason_codes.py checks
# that every reason of a heuristic run reads back as a code.
_HOOK_LINE = "Kalimat hook terkuat di detik ke-{offset:.0f}: “{text}”."
_HOOK_LINE_TAGGED = "Kalimat hook terkuat di detik ke-{offset:.0f}: “{text}” ({tags})."
_FIXED = {
    "teaser_echo": "Kalimatnya juga dipakai di teaser pembuka video (dipilih editor kanal).",
    "end_laugh": "Ditutup tepat setelah tawa/tepuk tangan, jadi payoff-nya utuh.",
    "end_recap": "Ditutup dengan kalimat kesimpulan (jadi/akhirnya/makanya).",
    "end_question": "Catatan: berakhir di pertanyaan, jawabannya di luar klip.",
    "penalty_teaser": "Penalti: tumpang-tindih dengan teaser pembuka (potongan berulang).",
    "penalty_sponsor": "Penalti: memuat iklan/sponsor (promo, kode voucher, diskon).",
    "penalty_segue": "Penalti: memuat peralihan segmen di tengah klip.",
    "penalty_outro": "Penalti: memuat salam penutup di akhir video.",
    "penalty_greeting": "Penalti: dibuka dengan salam pembuka kanal.",
    "penalty_small_talk": "Penalti: basa-basi tanya-jawab pendek.",
    "penalty_suspect": "Penalti: memuat bagian transkrip yang meragukan (ASR rusak).",
    "penalty_fillers": "Penalti ringan: kata pengisi jauh di atas rata-rata episode.",
    "penalty_dense_laughs": "Tawa padat di obrolan pendek dibatasi (sering jebakan).",
    "similar_topic": "Topiknya mirip klip lain yang lebih tinggi; skornya dikurangi.",
    "focus_fill": FOCUS_FILL_REASON,
    "heuristic_fill": HEURISTIC_FILL_REASON,
}
_TEMPLATES: tuple[tuple[str, str], ...] = (
    *((f"open_{kind}", template) for kind, template in _OPENER_REASONS.items()),
    ("hook_line_tagged", _HOOK_LINE_TAGGED),
    ("hook_line", _HOOK_LINE),
    *_FIXED.items(),
    ("end_pause", "Ditutup di akhir kalimat dengan jeda {gap:.1f} detik."),
    ("laughs", "Ada {count:.0f} tawa di dalam klip."),
    ("silence", "Ritme bicara lega: rasio hening {ratio:.0%} di atas rata-rata episode."),
    ("cold_open", COLD_OPEN_REASON.replace("{length}", "{seconds:,1f}")),
    ("trend_sensitive", SENSITIVE_TREND_REASON),  # before "trend", which also matches it
    ("trend", TREND_REASON),
    ("manual_range", MANUAL_REASON),
    ("llm_rerank", "Peringkat ulang LLM: {score:,1f}/10"),
)
_TAG_CODES = {label: tag for tag, label in _TAG_LABELS.items()}


def _compile(template: str) -> tuple[re.Pattern[str], dict[str, Callable[[str], object]]]:
    parts: list[str] = []
    converters: dict[str, Callable[[str], object]] = {}
    position = 0
    for field in _FIELD.finditer(template):
        pattern, convert = _FORMATS[field.group(2) or ""]
        parts.append(re.escape(template[position : field.start()]))
        parts.append(f"(?P<{field.group(1)}>{pattern})")
        converters[field.group(1)] = convert
        position = field.end()
    parts.append(re.escape(template[position:]))
    return re.compile("".join(parts), re.DOTALL), converters


_COMPILED = tuple((code, *_compile(template)) for code, template in _TEMPLATES)


def _tags(text: str) -> list[str] | None:
    tags = [_TAG_CODES.get(label) for label in text.split(", ")]
    if not tags or any(tag not in REASON_TAGS for tag in tags):
        return None
    return tags  # type: ignore[return-value]


def _fits(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip()) and len(value) <= MAX_TEXT
    if isinstance(value, (int, float)):
        return 0 <= value <= MAX_NUMBER
    return value is not None


def reason_code(reason: str) -> dict[str, object]:
    """``{"code", "params"}`` of one reason: its template's code, else ``text``."""
    for code, pattern, converters in _COMPILED:
        found = pattern.fullmatch(reason)
        if found is None:
            continue
        params: dict[str, object] = {}
        for name, raw in found.groupdict().items():
            params[name] = _tags(raw) if name == "tags" else converters[name](raw)
        if all(_fits(value) for value in params.values()):
            return {"code": code, "params": params}
    return {"code": TEXT_REASON, "params": {"text": reason}}


def reason_codes(reasons: Iterable[str]) -> list[dict[str, object]]:
    """One coded entry per reason, in the same order."""
    return [reason_code(reason) for reason in reasons]
