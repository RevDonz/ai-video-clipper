"""Loudness measurement, normalisation gain and peak protection (plan §5.6 steps 4–5).

Owner: T1.4. Stub landed by T1.0 with the frozen Appendix A signatures plus two T1.0 seam
functions (``needs_measurement`` and ``output_gain``) that ``compile_job`` (T1.3) calls, so that
the peak-protection rule lives only here.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .doc import Issue


@dataclass(frozen=True)
class Loudness:
    i_clufs: int  # integrated loudness, centi-LUFS
    tp_cdb: int  # true peak, centi-dBTP


def parse_ebur128(stderr: str) -> Loudness:
    """The summary of ``ebur128=peak=true`` from FFmpeg's stderr."""
    raise NotImplementedError("T1.4: edit_v2.loudness.parse_ebur128 (plan §5.6)")


def master_gain(measured: Loudness, target_clufs: int, tp_cdb: int) -> tuple[int, bool]:
    """``gain = target − I`` clamped so that ``TP + gain ≤ tp``; returns (gain_cdb, clamped)."""
    raise NotImplementedError("T1.4: edit_v2.loudness.master_gain (plan §5.6 step 4)")


def needs_measurement(doc: Mapping) -> bool:
    """Whether the pre-master mix must be measured: ``audio.master.mode == "normalize"``, a
    music item exists, or ``audio.source.gain_cdb > 0``. Revision 0 never is (plan §5.6)."""
    raise NotImplementedError("T1.4: edit_v2.loudness.needs_measurement (plan §5.6 step 5)")


def output_gain(doc: Mapping, measured: Loudness | None) -> tuple[int, tuple[Issue, ...]]:
    """The master-stage gain in cdB and its warnings (``loudness_clamped``, ``peak_reduced``).

    ``normalize`` → ``master_gain``; peak protection (always on) → at most ``−100 − TP`` when
    ``TP > −1.0 dBTP``. ``measured`` is ``None`` exactly when ``needs_measurement`` is false;
    the gain is then 0 and ``compile_job`` adds no volume filter.
    """
    raise NotImplementedError("T1.4: edit_v2.loudness.output_gain (plan §5.6 steps 4–5)")


__all__ = ["Loudness", "master_gain", "needs_measurement", "output_gain", "parse_ebur128"]
