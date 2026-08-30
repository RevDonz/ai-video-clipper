"""Shared bilingual lexical primitives for candidate analysis."""

from __future__ import annotations

import re

WORDS = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)
QUESTION_CLOSERS = frozenset("\"'”’»)]}）］｝")

# Conservative union of common English and Indonesian function words used by
# candidate boundary detection and feature extraction.
STOP_WORDS = frozenset(
    {
        "a",
        "ada",
        "adalah",
        "akan",
        "an",
        "and",
        "atau",
        "bagaimana",
        "bahwa",
        "banget",
        "because",
        "begitu",
        "can",
        "cara",
        "dalam",
        "dan",
        "dari",
        "deh",
        "dengan",
        "dia",
        "di",
        "dong",
        "entahlah",
        "how",
        "in",
        "ini",
        "is",
        "itu",
        "jadi",
        "juga",
        "kami",
        "kan",
        "karena",
        "ke",
        "kenapa",
        "kita",
        "kok",
        "lah",
        "mau",
        "mengapa",
        "mungkin",
        "nah",
        "near",
        "now",
        "of",
        "oleh",
        "pada",
        "pokoknya",
        "saya",
        "sebagai",
        "sudah",
        "tahu",
        "the",
        "tidak",
        "to",
        "tuh",
        "untuk",
        "we",
        "what",
        "why",
        "ya",
        "yang",
    }
)


def topic_terms(text: str) -> tuple[str, ...]:
    """Return unique content terms in stable first-seen order."""
    ordered: list[str] = []
    seen: set[str] = set()
    for match in WORDS.finditer(text.casefold()):
        word = match.group(0).replace("’", "'")
        if len(word) <= 2 or word in STOP_WORDS or word in seen or word.isdigit():
            continue
        seen.add(word)
        ordered.append(word)
    return tuple(ordered)


def topic_words(text: str) -> set[str]:
    """Return content terms as a set for overlap calculations."""
    return set(topic_terms(text))
