"""Derived logo bitmaps: the exact pixel box with the opacity baked in (plan §5.5, §5.1).

Owner: T1.3. Stub landed by T1.0. ``derive_image`` is not spelled out in Appendix A; T1.0
freezes the signature below (docs/editor/CONTRACTS.md, "T1.0 resolutions").
"""

from __future__ import annotations

from pathlib import Path


def derive_image(
    asset: Path, *, w: int, h: int, opacity_pm: int, timeout_s: float = 20.0
) -> bytes:
    """PNG bytes of ``asset`` scaled to exactly ``w``×``h`` (``scale=w:h:flags=lanczos,
    format=rgba,colorchannelmixer=aa=<opacity>``), ancillary chunks stripped.

    ``w``/``h`` come from ``timemap.logo_box``; both FFmpeg and the browser draw these bytes
    1:1 at ``(x0, y0)``. The preview lane stores them as
    ``preview/derived/<asset_sha16>@<w>x<h>.png``.
    """
    raise NotImplementedError("T1.3: edit_v2.derive.derive_image (plan §5.5)")


__all__ = ["derive_image"]
