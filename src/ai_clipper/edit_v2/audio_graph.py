"""The audio filter fragment: speech pieces, envelopes, music and mix (plan §5.3, §5.6).

Owner: T1.4. Stub landed by T1.0 with the frozen Appendix A signature. The seam with T1.3's
``compile_job`` (docs/editor/CONTRACTS.md, "T1.0 resolutions"):

* **In.** When the source has audio, ``compile_job`` provides one label per piece,
  ``[sa0]``, ``[sa1]``, … (``SOURCE_AUDIO_LABEL``), each the source's first audio stream as
  decoded from that piece's decoder run: native layout and rate, timestamps untouched
  (``-copyts``), no filter applied. The fragment's own inputs (envelope sidecars, the music
  asset) are ``[<first_input_index + k>:a]`` for the k-th ``InputSpec`` of ``inputs``.
* **Out.** Exactly one label, ``[apre]`` (``OUTPUT_LABEL``): the pre-master mix, 48 kHz
  stereo, identical in ``final``, ``reference``, ``audio_preview`` and ``audio_measure``.
  ``compile_job`` appends the master stage (the gain from ``loudness.output_gain``, then
  ``aresample=48000``) or, in ``audio_measure``, ``ebur128=peak=true``.
* Internal labels start with ``au_``; sidecar names match ``audio-[a-z0-9-]+\\.[a-z0-9]+``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .compile_ffmpeg import InputSpec
from .plan import RenderPlan

SOURCE_AUDIO_LABEL = "sa{i}"
OUTPUT_LABEL = "apre"
LABEL_PREFIX = "au_"
AUDIO_MODES = ("final", "reference", "audio_preview", "audio_measure")


@dataclass(frozen=True)
class AudioFragment:
    graph: str  # filtergraph text: consumes [sa<i>] and its own inputs, produces [apre]
    inputs: tuple[InputSpec, ...]
    sidecars: Mapping[str, bytes]  # e.g. f32 envelopes
    mix_sha256: str  # identity of the pre-master mix (caches preview audio and measurements)


def audio_fragment(plan: RenderPlan, *, mode: str, first_input_index: int) -> AudioFragment:
    """The audio fragment of ``plan`` for ``mode`` (one of ``AUDIO_MODES``)."""
    raise NotImplementedError("T1.4: edit_v2.audio_graph.audio_fragment (plan §5.3, §5.6)")


__all__ = [
    "AUDIO_MODES",
    "LABEL_PREFIX",
    "OUTPUT_LABEL",
    "SOURCE_AUDIO_LABEL",
    "AudioFragment",
    "audio_fragment",
]
