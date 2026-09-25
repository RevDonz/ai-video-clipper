"""Layout filter builders shared by ``plate_cells`` and ``final`` (plan §5.2 R3–R4).

Owner: T1.3. Stub landed by T1.0; no cross-task function contract beyond the layout modes.
The builders start from ``render.py``'s fit-blur, center-crop and face-track filter strings
(imported, not modified): ``fit_blur`` with ``gblur`` σ = 35·H/1280 and yuv444p overlay inputs,
``fill_center`` (scale=increase + centred crop) and ``camera`` (integer crop x per source-grid
frame from the camera plan, over ``n + first_sf``, never float ``t``).
"""

from __future__ import annotations

# layout.default.mode values (plan §3.3): fit-blur, face-track, center-crop.
LAYOUT_MODES = ("fit_blur", "camera", "fill_center")

__all__ = ["LAYOUT_MODES"]
