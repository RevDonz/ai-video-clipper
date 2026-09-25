"""Turn a ``RenderPlan`` into FFmpeg work for one mode (plan §5.1, §5.2 R1–R9).

Owner: T1.3. Stub landed by T1.0 with the frozen Appendix A signatures.

``InputSpec`` is also the seam with T1.4: ``audio_graph.audio_fragment`` returns its own inputs
as ``InputSpec`` values, which ``execute.run`` opens as ``/proc/self/fd/N`` (R8: no path and no
user string ever reaches argv or the graph).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .plan import RenderPlan

if TYPE_CHECKING:
    from .loudness import Loudness

MODES = (
    "final",  # pipeline and render-worker: H.264/AAC MP4 at size, plus the .srt sidecar
    "reference",  # gates only: ffv1 in .mkv + pcm_s16le, same graph, no encode loss
    "plate_cells",  # preview lane: layout-only cells, crf 18, IDR at every cell start
    "frame",  # preview lane: one final-graph frame incl. 4:2:0 + intra encode → PNG
    "audio_preview",  # preview lane: the final audio graph → FLAC s16 48 kHz stereo
    "audio_measure",  # pre-master mix → ebur128=peak=true
    "derive_image",  # logo asset → exact pixel box, opacity baked → PNG
)
QUALITIES = ("standar",)  # Essentials; "tinggi" is Stage 2 (K14)


@dataclass(frozen=True, slots=True)
class InputSpec:
    """One FFmpeg input, opened by ``execute.run`` and passed as ``/proc/self/fd/N``.

    ``kind`` is ``"source"`` (the job's source video; ``name`` = ``"source"``), ``"asset"``
    (``name`` = ``"sha256:<hex>"`` in the job asset store) or ``"sidecar"`` (``name`` = a key of
    the job's or fragment's ``sidecars``). ``options`` are input options placed before ``-i``
    (e.g. ``("-f", "f32le", "-ar", "48000", "-ac", "1")`` or ``("-stream_loop", "-1")``).
    """

    kind: str
    name: str
    options: tuple[str, ...] = ()


@dataclass(frozen=True)
class FfmpegJob:
    argv: tuple[str, ...]  # layout decided by T1.3; inputs are resolved by execute.run
    filter_script: str  # the -filter_complex_script text
    inputs: tuple[InputSpec, ...]
    sidecars: Mapping[str, bytes]  # constant names in a private 0700 temp directory
    expected: Mapping[str, Any]  # e.g. frames, samples, size: what verify/execute check


def compile_job(
    plan: RenderPlan,
    *,
    mode: str,
    source: Path,
    assets_root: Path,
    size: tuple[int, int] | None = None,
    quality: str = "standar",
    cells: Sequence[int] = (),
    frame: int | None = None,
    loudness: Loudness | None = None,
) -> FfmpegJob:
    """Compile ``plan`` for ``mode`` (one of ``MODES``). Essentials: ``size`` is always the
    document's output size and ``quality`` ``"standar"``; both stay parameters for Stage 2."""
    raise NotImplementedError("T1.3: edit_v2.compile_ffmpeg.compile_job (plan §5.1, §5.2)")


__all__ = ["MODES", "QUALITIES", "FfmpegJob", "InputSpec", "compile_job"]
