"""Caption and hook track of a document: frame cues + the one ASS file (plan §5.4).

Owner: T1.2a. Stub landed by T1.0 with the frozen Appendix A signatures. The cue builder
(``subtitles.build_frame_cues``) and the ASS emitter (``captions_ass.build_ass_v2``) live in
``subtitles.py`` and ``captions_ass.py`` (additions by T1.2a); ``captions_ass.py`` stays the only
ASS generator. Event times are frame-safe (``timemap.safe_cs``).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .doc import Issue
from .timemap import Piece

if TYPE_CHECKING:
    from ..subtitles import FrameCue


@dataclass(frozen=True)
class CaptionResult:
    cues: tuple[FrameCue, ...]
    ass: str  # the exact bytes (UTF-8) burned by FFmpeg and drawn by JASSUB
    ass_sha256: str
    hook_lines: tuple[str, ...]
    warnings: tuple[Issue, ...]  # hook_overflow, glyph_unsupported:U+XXXX, unsafe_zone, …


def caption_track(doc: Mapping, words: Mapping, pieces: Sequence[Piece]) -> CaptionResult:
    """Cues (≤ 4 words, 600 ms output-time gaps, never across the cold-open join), hook lines and
    the ASS document of ``doc`` over ``pieces`` (plan §3.4 word visibility, §5.4)."""
    raise NotImplementedError("T1.2a: edit_v2.captions.caption_track (plan §5.4)")


__all__ = ["CaptionResult", "caption_track"]
