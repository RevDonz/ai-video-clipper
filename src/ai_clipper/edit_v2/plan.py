"""Resolve a document once into a ``RenderPlan`` and derive the render key (plan §5.1, §5.2 R9).

Owner: T1.3. Stub landed by T1.0 with the frozen Appendix A signatures.

``RenderPlan``'s first nine fields are frozen because other tasks read them (T1.4's
``audio_fragment``, the fixture plan builder in ``tests/support/edit_v2_fixtures.py``, W2's
preview lane). T1.3 may add fields after them, each with a default.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .timemap import Fps, Piece


@dataclass(frozen=True)
class Resources:
    """Where the pinned resources live (fonts, caption packs, hook designs, toolchain.json).

    ``root`` is the repository ``resources/`` directory (``/app/resources`` in the image). T1.3
    may add fields with defaults.
    """

    root: Path


@dataclass(frozen=True)
class RenderPlan:
    doc: Mapping[str, Any]  # the validated document (full, including base)
    fps: Fps  # doc output fps
    output: tuple[int, int]  # doc output (w, h)
    pieces: tuple[Piece, ...]  # timemap.pieces(doc)
    total_frames: int  # timemap.total_frames(pieces)
    total_samples: int  # timemap.smp(total_frames, fps), 48 kHz
    # timemap.speech_spans of every word of the words artifact over ``pieces`` (output samples,
    # sorted, not merged): the ducking detector ``words`` (plan §5.6).
    speech_spans: tuple[tuple[int, int], ...]
    assets: Mapping[str, Mapping[str, Any]]  # doc["assets"]: metadata by "sha256:<hex>"
    plan_sha256: str  # plan §5.2 R9: content, words, camera, asset shas, ASS and envelopes

    def to_json(self) -> dict[str, Any]:
        """Deterministic JSON form hashed into ``plan_sha256`` (T1.3)."""
        raise NotImplementedError("T1.3: edit_v2.plan.RenderPlan.to_json (plan §5.1)")


def build_plan(
    doc: Mapping,
    *,
    words: Mapping,
    camera: Mapping | None,
    assets: Mapping[str, Mapping],
    resources: Resources,
) -> RenderPlan:
    """Resolve a validated document into a render plan (pieces, captions, audio, logo, camera)."""
    raise NotImplementedError("T1.3: edit_v2.plan.build_plan (plan §5.1)")


def render_key(
    plan: RenderPlan,
    *,
    size: tuple[int, int],
    quality: str,
    measure_sha: str | None,
    toolchain_sha: str,
) -> str:
    """``sha256("potongin-render-v1\\0" ‖ plan_sha256 ‖ compiler_version ‖ toolchain sha ‖ fonts
    sha ‖ packs sha ‖ size ‖ quality ‖ loudness/peak measurement sha)`` (plan §5.2 R9)."""
    raise NotImplementedError("T1.3: edit_v2.plan.render_key (plan §5.2 R9)")


__all__ = ["RenderPlan", "Resources", "build_plan", "render_key"]
