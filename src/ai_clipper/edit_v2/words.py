"""The words artifact ``potongin.words/1`` with the ``bounds`` snap table (plan §3.6).

Owner: T1.5. Stub landed by T1.0 with the frozen Appendix A signature. Built from
``transcript.json`` as written (read back through ``transcript_io.read_transcript_json``); word
ids are ``w`` + the zero-padded global index of the word in the flattened transcript, segments
without word timestamps split exactly like ``subtitles._segment_words``. The file is the
canonical JSON bytes (plan §3.1 encoding), stored as ``words.<sha16>.json``; ``base.words`` of
the seed holds the full sha256 of those bytes and the word count.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING

from .timemap import Fps

if TYPE_CHECKING:
    from ..audio_timeline import AudioTimeline
    from ..models import Transcription
    from ..sound_events import SoundEvent


def build_words_artifact(
    transcription: Transcription,
    *,
    clip_id: str,
    window_ms: tuple[int, int],
    fps: Fps,
    audio: AudioTimeline | None,
    events: Sequence[SoundEvent],
    peaks: bytes,
) -> dict:
    """Words, units, bounds, gaps, events, silences, scene cuts and the ``missing`` list."""
    raise NotImplementedError("T1.5: edit_v2.words.build_words_artifact (plan §3.6)")


__all__ = ["build_words_artifact"]
