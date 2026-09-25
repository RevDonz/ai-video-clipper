"""Run an ``FfmpegJob``: fd inputs, private temp dir, timeout, ``-progress`` liveness, cancel.

Owner: T1.3. Stub landed by T1.0 with the frozen Appendix A signature (plan §5.1, §5.2 R8,
§4.6: timeout ``max(120 s, 3 × predicted)``, ``-progress`` must advance within 20 s, the
process group is killed within 2 s of a cancel).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass

from .compile_ffmpeg import FfmpegJob


@dataclass(frozen=True)
class ExecResult:
    """Outcome of one FFmpeg run. Shape owned by T1.3 (no other W1 task reads it)."""


def run(
    job: FfmpegJob,
    *,
    output_fd: int | None,
    timeout_s: float,
    on_progress: Callable[[int], None] | None = None,
    cancel: threading.Event | None = None,
) -> ExecResult:
    """Run ``job`` writing to ``output_fd``; ``on_progress`` receives output frames done.

    Raises ``RenderFailed`` (``render_failed``, ``render_timeout``, ``render_stalled``) or
    ``Cancelled``.
    """
    raise NotImplementedError("T1.3: edit_v2.execute.run (plan §5.1, §5.2 R8)")


__all__ = ["ExecResult", "run"]
