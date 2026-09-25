"""Font coverage and advances from the pack fonts' ``cmap``/``hmtx`` tables (plan §5.4).

Owner: T1.2a. Stub landed by T1.0 with the frozen Appendix A signatures (stdlib ``struct``
only). Used for ``glyph_unsupported:U+XXXX`` warnings and the ``box``/``bold`` line splits.
"""

from __future__ import annotations

from pathlib import Path


def missing_glyphs(text: str, font_file: Path) -> tuple[str, ...]:
    """Characters of ``text`` the font lacks, in first-seen order, without duplicates."""
    raise NotImplementedError("T1.2a: edit_v2.glyphs.missing_glyphs (plan §5.4)")


def advance_px(text: str, font_file: Path, font_size: float) -> float:
    """Advance width of ``text`` in pixels at ``font_size`` from ``hmtx`` (box/bold splits)."""
    raise NotImplementedError("T1.2a: edit_v2.glyphs.advance_px (plan §5.4)")


__all__ = ["advance_px", "missing_glyphs"]
