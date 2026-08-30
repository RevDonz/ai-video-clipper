"""Deterministic, explainable text features for V2 boundary candidates.

This module deliberately extracts no final score or rank. Text-only multimodal
features stay neutral until Task 4 can supply measured audio, speaker, and video
evidence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, fields
from typing import Literal

from .candidates import BoundaryCandidate
from .lexical import QUESTION_CLOSERS, STOP_WORDS, WORDS, topic_terms
from .models import CandidateFeatures

_SENTENCE_START = re.compile(r"^\s*[\"'“‘«(\[（]*")
_SENTENCE_TERMINAL = re.compile(r"[.!?？！]")
_TITLE_ABBREVIATION = re.compile(r"\b(?:dr|prof)\.$", re.IGNORECASE)
_SENTENCE_CLOSERS = frozenset("\"'”’»)]）］")
_TERMINAL = re.compile(r"[.!?？！](?:[\"'”’»\)\]）］]*)\s*$")

# Pattern recognition is intentionally separate from feature weights. Patterns
# are lexical evidence only; they do not claim general semantic understanding.
_PATTERNS: dict[str, tuple[re.Pattern[str], ...]] = {
    "hook.bold_claim": (
        re.compile(r"\borang\s+jangan\s+terlalu\s+baik\b"),
        re.compile(r"\bbukan\b[^.!?？！]{0,90}\bjustru\b"),
        re.compile(r"\b(?:faktanya|kenyataannya)\b"),
    ),
    "hook.pain_point": (
        re.compile(r"\b(?:sulit|kesulitan|masalah|gagal|kegagalan|risiko|kendala)\b"),
        re.compile(r"\b(?:biaya|tagihan)\b[^.!?？！]{0,40}\b(?:naik|membengkak|mahal)\b"),
    ),
    "hook.open_loop": (
        re.compile(r"\bmau\s+tahu\b[^.!?？！]{0,50}[?？]"),
        re.compile(r"\bada\s+(?:\d+|satu|dua|tiga|empat|lima)\s+(?:alasan|cara|langkah|rahasia)\b"),
        re.compile(
            r"\b(?:nanti|sebentar lagi)\s+(?:akan\s+)?(?:saya|kami|kita)\s+(?:jelaskan|bahas)\b"
        ),
    ),
    "penalty.intro": (
        re.compile(r"^(?:halo|hai)\s+(?:semuanya|teman-teman)\b"),
        re.compile(r"^selamat\s+datang\b"),
    ),
    "penalty.outro": (
        re.compile(r"\bterima\s+kasih\s+(?:sudah|telah)\s+(?:menonton|menyaksikan)\b"),
        re.compile(r"\bsampai\s+jumpa\b"),
    ),
    "penalty.sponsor_first": (
        re.compile(r"^(?:video|episode|konten)\s+ini\s+(?:disponsori|dipersembahkan)\s+oleh\b"),
        re.compile(r"^(?:sponsor|mitra)\s+(?:video|episode|kami)\b"),
        re.compile(r"^this\s+(?:video|episode)\s+is\s+sponsored\s+by\b"),
    ),
}

# Dimension adjustments are auditable independently of phrase normalization.
_RULES = {
    "hook.direct_question": 3.0,
    "hook.bold_claim": 3.0,
    "hook.attributed_numeric_claim": 2.5,
    "hook.pain_point": 2.0,
    "hook.open_loop": 2.0,
    "relevance.topic_overlap": 4.0,
    "relevance.answer_resolution": 1.5,
    "payoff.answer_marker": 3.0,
    "payoff.complete_answer": 3.0,
    "boundary.structured_start": 2.0,
    "boundary.structured_end": 2.0,
    "boundary.terminal": 2.0,
}

_FILLERS = {
    "anu",
    "banget",
    "deh",
    "dong",
    "eh",
    "gitu",
    "hmm",
    "kan",
    "kayak",
    "kok",
    "lah",
    "maksudnya",
    "nih",
    "sih",
    "tuh",
    "ya",
}
_MISSING_CONTEXT = re.compile(
    r"^\s*[\"'“‘«(\[（]*(?P<opening>"
    r"(?:(?:nah|jadi)\s*,?\s*)?"
    r"(?:ini(?!\s+(?:tiga\s+alasan|cara|masalah|alasan)\b)|itu|dia|mereka|beliau)"
    r"\b(?:\s+sebabnya)?|makanya\b|itulah\s+sebabnya\b)"
)
_ROLE_TERM = (
    r"(?:dokter|dr\.?|profesor|prof\.?|peneliti|ilmuwan|ekonom|auditor|"
    r"ceo|chief executive officer|doctor|professor|researcher)"
)
_NUMBER_TERM = r"\d+(?:[.,]\d+)?(?:\s*(?:%|persen|percent|juta|ribu|million))?"
_ATTRIBUTED_NUMBER = (
    re.compile(
        rf"\bmenurut\s+(?P<role>{_ROLE_TERM})(?:\s+[^\W\d_][\w.'’-]*){{0,3}}\s*,?\s*"
        rf"(?:bahwa\s+|sebanyak\s+)?(?P<number>{_NUMBER_TERM})(?=$|[\s,.;:!?？！])"
    ),
    re.compile(
        rf"\b(?P<role>{_ROLE_TERM})(?:\s+[^\W\d_][\w.'’-]*){{0,3}}\s+"
        r"(?:melaporkan|menyatakan|mencatat|menemukan|mengatakan)\s+"
        rf"(?:bahwa\s+|sebanyak\s+)?(?P<number>{_NUMBER_TERM})(?=$|[\s,.;:!?？！])"
    ),
    re.compile(
        rf"\b(?:data|laporan|riset|studi)\s+(?:dari|oleh)\s+(?P<role>{_ROLE_TERM})"
        rf"(?:\s+[^\W\d_][\w.'’-]*){{0,3}}\s+(?:menunjukkan|mencatat|melaporkan)\s+"
        rf"(?P<number>{_NUMBER_TERM})(?=$|[\s,.;:!?？！])"
    ),
)
_ANSWER_MARKER = re.compile(
    r"\b(?:jawabannya(?:\s+adalah)?|solusinya(?:\s+adalah)?|hasilnya|karena|ternyata|"
    r"the\s+answer\s+is|because|the\s+solution\s+is)\b\s*(?:[:,;—-]\s*)?"
)
_ANSWER_PREDICATE_PATTERNS = (
    re.compile(
        r"\b(?:nonaktifkan|menonaktifkan|matikan|mematikan|optimalkan|mengoptimalkan|"
        r"gunakan|menggunakan|lakukan|melakukan|kurangi|mengurangi|tambahkan|menambahkan|"
        r"periksa|memeriksa|hindari|menghindari|pilih|memilih|menyebabkan|membuat|terjadi|"
        r"naik|turun)\b"
    ),
    re.compile(
        r"\b(?:disable|shut\s+down|turn\s+off|use|reduce|check|avoid|choose|causes|makes|"
        r"increase|decrease)\b"
    ),
    # Preserve the earlier conservative lexical evidence accepted by this feature set.
    re.compile(r"\b(?:audit|ditagih|melewati|memakai|cause)\b"),
)
_GENERIC_RESOLUTION_TERMS = frozenset(
    {
        "audit",
        "avoid",
        "cause",
        "causes",
        "check",
        "choose",
        "decrease",
        "disable",
        "ditagih",
        "down",
        "fall",
        "gunakan",
        "hindari",
        "increase",
        "kurangi",
        "lakukan",
        "makes",
        "matikan",
        "melewati",
        "melakukan",
        "memakai",
        "mematikan",
        "memeriksa",
        "memilih",
        "membuat",
        "menambahkan",
        "menggunakan",
        "menghindari",
        "mengoptimalkan",
        "mengurangi",
        "menonaktifkan",
        "menyebabkan",
        "naik",
        "nonaktifkan",
        "off",
        "optimalkan",
        "periksa",
        "pilih",
        "reduce",
        "rise",
        "shut",
        "tambahkan",
        "terjadi",
        "turn",
        "turun",
        "use",
    }
)
_LOW_INFORMATION = frozenset({"begitu", "entahlah", "mungkin", "pokoknya"})
_NOISE_TOKEN = re.compile(r"(?:wk){2,}|(?:ha){2,}|blabla|asdf|qwerty")
_STRUCTURAL_BOUNDARIES = frozenset({"pause", "question", "topic-shift", "transcript-edge"})

_EVIDENCE_SCHEMA: dict[str, tuple[str, Literal["positive", "negative"]]] = {
    "hook.direct_question": ("hook_strength", "positive"),
    "hook.bold_claim": ("hook_strength", "positive"),
    "hook.attributed_numeric_claim": ("hook_strength", "positive"),
    "hook.pain_point": ("hook_strength", "positive"),
    "hook.open_loop": ("hook_strength", "positive"),
    "relevance.topic_overlap": ("hook_relevance", "positive"),
    "relevance.answer_resolution": ("hook_relevance", "positive"),
    "context.pronoun_led": ("standalone_context", "negative"),
    "context.pronoun_led_penalty": ("penalty", "negative"),
    "payoff.answer_marker": ("payoff_completeness", "positive"),
    "payoff.complete_answer": ("payoff_completeness", "positive"),
    "density.repetition_filler": ("information_density", "negative"),
    "density.repetition_filler_penalty": ("penalty", "negative"),
    "penalty.intro": ("penalty", "negative"),
    "penalty.outro": ("penalty", "negative"),
    "penalty.sponsor_first": ("penalty", "negative"),
    "boundary.structured_start": ("boundary_quality", "positive"),
    "boundary.structured_end": ("boundary_quality", "positive"),
    "boundary.terminal": ("boundary_quality", "positive"),
    "topic.extracted_terms": ("topic_value", "positive"),
}
_FEATURE_DIMENSIONS = frozenset(model_field.name for model_field in fields(CandidateFeatures))


@dataclass(frozen=True, slots=True)
class FeatureEvidence:
    """One observed pattern and the dimension it changes."""

    tag: str
    dimension: str
    impact: Literal["positive", "negative"]
    reason: str

    def __post_init__(self) -> None:
        if not all(
            isinstance(value, str) and value.strip()
            for value in (self.tag, self.dimension, self.reason)
        ):
            raise ValueError("feature evidence strings must be non-empty")
        if self.impact not in ("positive", "negative"):
            raise ValueError("feature evidence impact must be positive or negative")
        if self.dimension not in _FEATURE_DIMENSIONS:
            raise ValueError("feature evidence dimension must be a CandidateFeatures field")
        expected = _EVIDENCE_SCHEMA.get(self.tag)
        if expected is None:
            raise ValueError(f"unknown evidence tag: {self.tag}")
        expected_dimension, expected_impact = expected
        if self.dimension != expected_dimension:
            raise ValueError(f"evidence tag {self.tag} requires dimension {expected_dimension}")
        if self.impact != expected_impact:
            raise ValueError(f"evidence tag {self.tag} requires impact {expected_impact}")


@dataclass(frozen=True, slots=True)
class FeatureExtractionResult:
    """Auditable features and lexical evidence, intentionally without ranking."""

    features: CandidateFeatures
    evidence: tuple[FeatureEvidence, ...]
    topic_terms: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.features, CandidateFeatures):
            raise TypeError("features must be CandidateFeatures")
        if not isinstance(self.evidence, tuple) or any(
            not isinstance(item, FeatureEvidence) for item in self.evidence
        ):
            raise TypeError("evidence must be a tuple of FeatureEvidence values")
        if not isinstance(self.topic_terms, tuple) or any(
            not isinstance(term, str) or not term for term in self.topic_terms
        ):
            raise TypeError("topic_terms must be a tuple of non-empty strings")

    @property
    def reasons(self) -> tuple[str, ...]:
        return tuple(item.reason for item in self.evidence)


def _clamp(value: float) -> float:
    return round(min(10.0, max(0.0, value)), 3)


def _normalize(text: str) -> str:
    return " ".join(text.casefold().split())


def _matches(tag: str, text: str) -> bool:
    return any(pattern.search(text) for pattern in _PATTERNS[tag])


def _split_hook_body(text: str) -> tuple[str, str]:
    stripped = text.strip()
    for terminal in _SENTENCE_TERMINAL.finditer(stripped):
        end = terminal.end()
        if terminal.group(0) == ".":
            decimal_point = (
                terminal.start() > 0
                and end < len(stripped)
                and stripped[terminal.start() - 1].isdigit()
                and stripped[end].isdigit()
            )
            if decimal_point or _TITLE_ABBREVIATION.search(stripped[:end]):
                continue
        while end < len(stripped) and stripped[end] in _SENTENCE_CLOSERS:
            end += 1
        return stripped[:end], stripped[end:].strip()
    words = text.split()
    split_at = min(12, len(words))
    return " ".join(words[:split_at]), " ".join(words[split_at:])


def _is_question(text: str) -> bool:
    stripped = text.rstrip()
    while stripped and stripped[-1] in QUESTION_CLOSERS:
        stripped = stripped[:-1].rstrip()
    return stripped.endswith(("?", "？"))


def _substantive_terms(text: str) -> tuple[str, ...]:
    """Return conservative lexical content terms, excluding known noise tokens."""
    return tuple(
        term
        for term in topic_terms(text)
        if term not in _FILLERS
        and term not in _LOW_INFORMATION
        and not _NOISE_TOKEN.fullmatch(term)
    )


def _answer_predicates(text: str) -> tuple[str, ...]:
    """Return literal predicate-pattern matches in textual order."""
    located = sorted(
        (match.start(), " ".join(match.group(0).split()))
        for pattern in _ANSWER_PREDICATE_PATTERNS
        for match in pattern.finditer(text.casefold())
    )
    return tuple(dict.fromkeys(value for _, value in located))


def _attributed_number(text: str) -> re.Match[str] | None:
    return next((match for pattern in _ATTRIBUTED_NUMBER if (match := pattern.search(text))), None)


def extract_features(candidate: BoundaryCandidate) -> FeatureExtractionResult:
    """Extract deterministic Indonesian-first features from one boundary candidate."""
    if not isinstance(candidate, BoundaryCandidate):
        raise TypeError("candidate must be a BoundaryCandidate")

    normalized = _normalize(candidate.text)
    normalized_leading = _normalize(_SENTENCE_START.sub("", candidate.text))
    hook, body = _split_hook_body(candidate.text)
    normalized_hook = _normalize(_SENTENCE_START.sub("", hook))
    normalized_body = _normalize(body)
    evidence: list[FeatureEvidence] = []

    def add(tag: str, dimension: str, impact: Literal["positive", "negative"], reason: str) -> None:
        evidence.append(FeatureEvidence(tag, dimension, impact, reason))

    hook_strength = 3.0
    direct_question = _is_question(normalized_hook)
    if direct_question:
        hook_strength += _RULES["hook.direct_question"]
        add(
            "hook.direct_question",
            "hook_strength",
            "positive",
            "Hook memuat tanda tanya langsung (?/？).",
        )
    for tag, reason in (
        ("hook.bold_claim", "Hook memuat pola klaim tegas/kontradiksi eksplisit."),
        ("hook.pain_point", "Hook memuat kata masalah atau kesulitan eksplisit."),
        (
            "hook.open_loop",
            "Hook memuat janji/open loop eksplisit seperti 'mau tahu' atau jumlah alasan.",
        ),
    ):
        if _matches(tag, normalized_hook):
            hook_strength += _RULES[tag]
            add(tag, "hook_strength", "positive", reason)

    attributed_number = _attributed_number(normalized_hook)
    if attributed_number:
        hook_strength += _RULES["hook.attributed_numeric_claim"]
        add(
            "hook.attributed_numeric_claim",
            "hook_strength",
            "positive",
            "Hook memuat atribusi lokal peran "
            f"'{attributed_number.group('role')}' pada klaim angka "
            f"'{attributed_number.group('number')}'.",
        )

    hook_topics = set(topic_terms(hook))
    body_topics = set(topic_terms(body))
    overlap = hook_topics & body_topics
    hook_relevance = 3.0
    if overlap:
        hook_relevance += _RULES["relevance.topic_overlap"]
        add(
            "relevance.topic_overlap",
            "hook_relevance",
            "positive",
            f"Istilah hook muncul kembali di body: {', '.join(sorted(overlap))}.",
        )

    folded_body = body.casefold()
    marker_match = _ANSWER_MARKER.search(folded_body) if normalized_body else None
    post_marker = folded_body[marker_match.end() :] if marker_match else ""
    post_marker_terms = set(_substantive_terms(post_marker))
    answer_predicates = _answer_predicates(post_marker)
    substantive_answer = (
        marker_match is not None and len(post_marker_terms) >= 3 and bool(answer_predicates)
    )
    hook_resolution_terms = set(_substantive_terms(hook)) - _GENERIC_RESOLUTION_TERMS
    answer_resolution_terms = post_marker_terms - _GENERIC_RESOLUTION_TERMS
    resolution_overlap = hook_resolution_terms & answer_resolution_terms
    terminal_answer = bool(_TERMINAL.search(body))
    complete_answer = substantive_answer and len(resolution_overlap) >= 2 and terminal_answer
    if complete_answer and (direct_question or _matches("hook.open_loop", normalized_hook)):
        hook_relevance += _RULES["relevance.answer_resolution"]
        add(
            "relevance.answer_resolution",
            "hook_relevance",
            "positive",
            f"Pascamarker memuat {len(post_marker_terms)} istilah substantif, predikat literal "
            f"'{answer_predicates[0]}', overlap topik literal {len(resolution_overlap)} "
            f"({', '.join(sorted(resolution_overlap))}), dan tanda terminal={terminal_answer}.",
        )

    standalone_context = 7.0
    missing_context_match = _MISSING_CONTEXT.search(candidate.text.casefold())
    penalty = 0.0
    if missing_context_match:
        standalone_context -= 4.0
        penalty += 2.5
        literal_opening = " ".join(missing_context_match.group("opening").split())
        add(
            "context.pronoun_led",
            "standalone_context",
            "negative",
            f"Pola pembukaan anaforis literal terdeteksi: '{literal_opening}'.",
        )
        add(
            "context.pronoun_led_penalty",
            "penalty",
            "negative",
            f"Pola literal '{literal_opening}' menambahkan penalti 2.5.",
        )

    payoff_completeness = 3.0
    if substantive_answer:
        payoff_completeness += _RULES["payoff.answer_marker"]
        add(
            "payoff.answer_marker",
            "payoff_completeness",
            "positive",
            f"Pascamarker memuat {len(post_marker_terms)} istilah substantif, predikat literal "
            f"'{answer_predicates[0]}', overlap topik literal {len(resolution_overlap)} "
            f"({', '.join(sorted(resolution_overlap))}), dan tanda terminal={terminal_answer}.",
        )
    if complete_answer:
        payoff_completeness += _RULES["payoff.complete_answer"]
        add(
            "payoff.complete_answer",
            "payoff_completeness",
            "positive",
            f"Pascamarker memuat {len(post_marker_terms)} istilah substantif, predikat literal "
            f"'{answer_predicates[0]}', overlap topik literal {len(resolution_overlap)} "
            f"({', '.join(sorted(resolution_overlap))}), dan tanda terminal={terminal_answer}.",
        )

    words = [match.group(0).casefold() for match in WORDS.finditer(candidate.text)]
    content_words = [word for word in words if len(word) > 2 and word not in STOP_WORDS]
    content_ratio = len(content_words) / len(words) if words else 0.0
    unique_ratio = len(set(content_words)) / len(content_words) if content_words else 0.0
    filler_count = sum(word in _FILLERS for word in words)
    repetition_filler = filler_count >= 2 or (len(content_words) >= 5 and unique_ratio < 0.55)
    information_density = 10.0 * (0.55 * content_ratio + 0.45 * unique_ratio)
    if repetition_filler:
        information_density -= 2.0
        penalty += 2.0
        add(
            "density.repetition_filler",
            "information_density",
            "negative",
            f"Teks memuat filler={filler_count} dan rasio unik kata isi={unique_ratio:.3f}.",
        )
        add(
            "density.repetition_filler_penalty",
            "penalty",
            "negative",
            f"Bukti literal filler={filler_count}, rasio unik={unique_ratio:.3f} "
            "menambahkan penalti 2.0.",
        )

    for tag, amount, reason in (
        ("penalty.intro", 2.5, "Pembukaan memuat sapaan intro eksplisit."),
        ("penalty.outro", 3.0, "Teks memuat frasa outro eksplisit."),
        ("penalty.sponsor_first", 4.0, "Klip dimulai dengan penyebutan sponsor eksplisit."),
    ):
        penalty_text = normalized if tag == "penalty.outro" else normalized_leading
        if _matches(tag, penalty_text):
            penalty += amount
            add(tag, "penalty", "negative", reason)

    boundary_quality = 3.0
    start_structures = _STRUCTURAL_BOUNDARIES.intersection(candidate.start_boundary_kinds)
    end_structures = _STRUCTURAL_BOUNDARIES.intersection(candidate.end_boundary_kinds)
    if start_structures:
        boundary_quality += _RULES["boundary.structured_start"]
        add(
            "boundary.structured_start",
            "boundary_quality",
            "positive",
            f"Metadata batas awal memuat: {', '.join(sorted(start_structures))}.",
        )
    if end_structures:
        boundary_quality += _RULES["boundary.structured_end"]
        add(
            "boundary.structured_end",
            "boundary_quality",
            "positive",
            f"Metadata batas akhir memuat: {', '.join(sorted(end_structures))}.",
        )
    if _TERMINAL.search(candidate.text):
        boundary_quality += _RULES["boundary.terminal"]
        add(
            "boundary.terminal",
            "boundary_quality",
            "positive",
            "Teks kandidat berakhir dengan tanda baca terminal.",
        )

    extracted_topic_terms = topic_terms(candidate.text)
    topic_value = 3.0 + 0.7 * min(len(extracted_topic_terms), 10)
    if extracted_topic_terms:
        add(
            "topic.extracted_terms",
            "topic_value",
            "positive",
            f"Istilah topik nonfungsi yang ditemukan: {', '.join(extracted_topic_terms[:10])}.",
        )

    features = CandidateFeatures(
        hook_strength=_clamp(hook_strength),
        hook_relevance=_clamp(hook_relevance),
        standalone_context=_clamp(standalone_context),
        payoff_completeness=_clamp(payoff_completeness),
        information_density=_clamp(information_density),
        emotion_energy=5.0,
        dialogue_dynamics=5.0,
        visual_activity=5.0,
        topic_value=_clamp(topic_value),
        boundary_quality=_clamp(boundary_quality),
        penalty=_clamp(penalty),
    )
    return FeatureExtractionResult(features, tuple(evidence), extracted_topic_terms)
