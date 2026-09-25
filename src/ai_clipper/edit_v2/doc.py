"""clip-edit-v2 document: parse, canonical bytes, hashes and validation (plan §3, §4.4).

Owner: T1.1. Stub landed by T1.0 with the frozen Appendix A signatures; the rules, the code
assignment and the fixture classification are in ``docs/editor/CONTRACTS.md`` (§3 and "T1.0
resolutions") and ``tests/fixtures/edit_v2/docs/index.json``.

Python is the only validator (plan §3): the client builds valid documents by construction and
treats a 422 as a bug.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

MAX_DOC_BYTES = 1 << 20


@dataclass(frozen=True)
class Issue:
    """One validation finding: a code of plan §3.7, a JSON pointer, and optional id/frame.

    ``ref`` names the item the issue is about (e.g. a removal id) and ``f`` an output frame to
    jump to; both are used by warnings ("Perlu dicek").
    """

    code: str
    path: str
    ref: str | None = None
    f: int | None = None

    def to_json(self) -> dict[str, Any]:
        """The wire form used in 422 bodies and ``warnings`` lists (``None`` fields omitted)."""
        value: dict[str, Any] = {"code": self.code, "path": self.path}
        if self.ref is not None:
            value["ref"] = self.ref
        if self.f is not None:
            value["f"] = self.f
        return value


@dataclass(frozen=True)
class Validation:
    errors: tuple[Issue, ...]
    warnings: tuple[Issue, ...]

    @property
    def ok(self) -> bool:
        return not self.errors


def parse_doc(raw: bytes) -> dict:
    """Parse document bytes; raises ``DocInvalid`` (parse codes) or ``SchemaTooNew``.

    Plan §3.1/§3.7: UTF-8 without BOM, ≤ ``MAX_DOC_BYTES``, no floats/NaN/Infinity, no duplicate
    or unknown keys at any level, every string NFC without Cc/Cs characters.
    """
    raise NotImplementedError("T1.1: edit_v2.doc.parse_doc (plan §3.1, §3.7)")


def canonical_bytes(doc: Mapping) -> bytes:
    """``json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`` as UTF-8."""
    raise NotImplementedError("T1.1: edit_v2.doc.canonical_bytes (plan §3.1)")


def doc_sha256(doc: Mapping) -> str:
    """sha256 hex of ``canonical_bytes(doc)``: the document's ETag."""
    raise NotImplementedError("T1.1: edit_v2.doc.doc_sha256 (plan §3.1, §4.4)")


def content_sha256(doc: Mapping) -> str:
    """sha256 hex of the canonical bytes without ``revision``, ``parent_sha256`` and ``audit``."""
    raise NotImplementedError("T1.1: edit_v2.doc.content_sha256 (plan §4.6, §5.2 R9)")


def content_equals_seed(doc: Mapping, seed: Mapping) -> bool:
    """R10: the document's content equals the seed's content (plan §4.6)."""
    raise NotImplementedError("T1.1: edit_v2.doc.content_equals_seed (plan §4.6 R10)")


def validate_doc(
    doc: Mapping, *, words: Mapping, assets: Mapping[str, Mapping], seed: Mapping | None
) -> Validation:
    """Semantic validation of a parsed document (plan §3.3, §3.4, §3.7).

    ``words`` is the clip's ``potongin.words/1`` artifact, ``assets`` the job asset store's
    metadata keyed ``sha256:<hex>`` (document form), ``seed`` the clip's revision 0 (``None``
    when validating the seed itself; then ``base_changed`` is not checked).
    """
    raise NotImplementedError("T1.1: edit_v2.doc.validate_doc (plan §3.3, §3.4, §3.7)")


__all__ = [
    "MAX_DOC_BYTES",
    "Issue",
    "Validation",
    "canonical_bytes",
    "content_equals_seed",
    "content_sha256",
    "doc_sha256",
    "parse_doc",
    "validate_doc",
]
