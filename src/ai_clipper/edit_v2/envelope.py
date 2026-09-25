"""Gain envelopes as integer breakpoints and their f32 expansion (plan §5.3, §5.6).

Owner: T1.4. Stub landed by T1.0 with the frozen Appendix A signatures. An ``Envelope`` is a
tuple of ``(sample, gain_e6)`` breakpoints with increasing samples (output samples at 48 kHz;
``gain_e6 = round_half_up(g·10⁶)``); the gain is linear between breakpoints.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from .timemap import Fps, Piece

Envelope = tuple[tuple[int, int], ...]  # (sample, gain_e6), increasing


def speech_envelope(
    pieces: Sequence[Piece],
    joins: Mapping[str, int],
    cut_fade_ms: int,
    fps: Fps,
    gain_cdb: int,
) -> Envelope:
    """Micro-fades at every join (``cut_fade_ms``, or ``joins[segment_id] = audio_fade_ms``
    after that segment, e.g. 30 ms at the cold-open join), clamped to half of each neighbour,
    times the source gain ``gain_cdb``."""
    raise NotImplementedError("T1.4: edit_v2.envelope.speech_envelope (plan §5.3, §5.6)")


def music_envelope(
    speech_spans: Sequence[tuple[int, int]], item: Mapping, total_samples: int, fps: Fps
) -> Envelope:
    """Music gain × fades × ducking (spans merged by ``hold_ms``; attack before, release after;
    minimum on overlap) for the music ``item`` of the document."""
    raise NotImplementedError("T1.4: edit_v2.envelope.music_envelope (plan §5.6)")


def expand_f32(env: Envelope, total_samples: int) -> bytes:
    """Mono little-endian f32 samples at 48 kHz (≤ 150 ms for a 90 s clip)."""
    raise NotImplementedError("T1.4: edit_v2.envelope.expand_f32 (plan §5.6)")


__all__ = ["Envelope", "expand_f32", "music_envelope", "speech_envelope"]
