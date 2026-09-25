"""Loudness measurement, normalisation gain and peak protection (plan §5.6 steps 4–5).

Owner: T1.4. ``needs_measurement`` and ``output_gain`` are the seam with T1.3's ``compile_job``
(docs/editor/CONTRACTS.md §5.8), so the peak-protection rule lives only here.

* **Measure.** ``audio_measure`` runs the pre-master mix through ``ebur128=peak=true``;
  :func:`parse_ebur128` reads the summary FFmpeg prints at the end (integrated loudness and true
  peak, 0.1 dB resolution) in centi-units.
* **Normalise** (``audio.master.mode == "normalize"``): ``gain = target − I``, clamped so that
  ``TP + gain`` stays at the document's ``tp`` (:func:`master_gain`). When the clamp costs more
  than 1 LU the warning ``loudness_clamped:<achieved> LUFS`` records what was reached.
* **Peak protection** (always on): with a music item or a positive source gain, a true peak
  above −1.0 dBTP gets a constant negative gain so that it lands on −1.0 dBTP; the warning
  ``peak_reduced:<reduction> dB`` names the reduction. Revision 0 (no music, gain 0, mode
  ``off``) is never measured or changed.

**Encode headroom.** Gates G3 and G3b check the true peak of the *decoded AAC export*, and the
AAC-LC 192 kb/s encode raises the true peak of the mastered mix. Measured in the reference image
(FFmpeg 5.1.9, evidence ``T1.4-G3b.json``): +0.4 dB on hot tone bursts, +0.6 dB on a hot
square-wave bed; the ebur128 summary adds up to 0.05 dB of print resolution. Both true-peak
ceilings (the document's ``tp`` and the −1.0 dBTP of peak protection) are therefore applied
``ENCODE_HEADROOM_CDB`` (1.0 dB) below their value on the pre-encode mix: a protected mix is
mastered to −2.0 dBTP, the usual target for loud masters bound for lossy codecs. Content the
encoder pushes further still (a bare full-scale square wave: +2.2 dB) can exceed −1.0 dBTP
after encoding; ``verify`` (G3b) catches it.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from .doc import Issue
from .envelope import music_item
from .errors import RenderFailed

PEAK_CEILING_CDB = -100  # G3b: true peak ≤ −1.0 dBTP with music or a positive source gain
ENCODE_HEADROOM_CDB = 100  # AAC-LC 192k true-peak overshoot allowance (module docstring)
CLAMP_WARNING_CDB = 100  # a clamp costing more than 1 LU warns ``loudness_clamped``
ABSOLUTE_GATE_CLUFS = -7000  # ebur128 reports −70 LUFS when no block passes the gate
SILENCE_TP_CDB = -14400  # "-inf dBFS" (digital silence) is read as −144 dBTP


@dataclass(frozen=True)
class Loudness:
    i_clufs: int  # integrated loudness, centi-LUFS
    tp_cdb: int  # true peak, centi-dBTP


_SUMMARY = "Summary:"
_NUMBER = r"(-?inf|[+-]?\d+(?:\.\d+)?)"
_INTEGRATED = re.compile(r"Integrated loudness:\s*\n\s*I:\s*" + _NUMBER + r"\s+LUFS")
_TRUE_PEAK = re.compile(r"True peak:\s*\n\s*Peak:\s*" + _NUMBER + r"\s+dBFS")


def _centi(text: str, *, floor: int) -> int:
    if text == "-inf":
        return floor
    try:
        return int((Decimal(text) * 100).to_integral_value())
    except InvalidOperation as error:  # pragma: no cover - the regex admits only numbers
        raise RenderFailed("render_failed") from error


def parse_ebur128(stderr: str) -> Loudness:
    """The summary of ``ebur128=peak=true`` from FFmpeg's stderr.

    Only the text after the last ``Summary:`` is read (the per-frame lines also contain
    ``I:``). ``-inf`` (silence) becomes :data:`SILENCE_TP_CDB` for the true peak and the
    absolute gate for the integrated loudness. Raises ``RenderFailed`` (``render_failed``) when
    there is no complete summary, e.g. FFmpeg failed or ``peak=true`` was not set.
    """
    start = stderr.rfind(_SUMMARY)
    if start < 0:
        raise RenderFailed("render_failed")
    summary = stderr[start:]
    integrated = _INTEGRATED.search(summary)
    peak = _TRUE_PEAK.search(summary)
    if integrated is None or peak is None:
        raise RenderFailed("render_failed")
    return Loudness(
        i_clufs=max(_centi(integrated.group(1), floor=ABSOLUTE_GATE_CLUFS), ABSOLUTE_GATE_CLUFS),
        tp_cdb=_centi(peak.group(1), floor=SILENCE_TP_CDB),
    )


def master_gain(measured: Loudness, target_clufs: int, tp_cdb: int) -> tuple[int, bool]:
    """``gain = target − I`` clamped so that ``TP + gain ≤ tp``; returns (gain_cdb, clamped)."""
    gain = target_clufs - measured.i_clufs
    limit = tp_cdb - measured.tp_cdb
    if gain > limit:
        return limit, True
    return gain, False


def needs_measurement(doc: Mapping) -> bool:
    """Whether the pre-master mix must be measured: ``audio.master.mode == "normalize"``, a
    music item exists, or ``audio.source.gain_cdb > 0``. Revision 0 never is (plan §5.6)."""
    audio = doc["audio"]
    return (
        audio["master"]["mode"] == "normalize"
        or audio["source"]["gain_cdb"] > 0
        or music_item(doc) is not None
    )


def format_centi(value: int) -> str:
    """A centi-unit integer as an exact decimal string: ``-380`` → ``"-3.80"``."""
    sign = "-" if value < 0 else ""
    return f"{sign}{abs(value) // 100}.{abs(value) % 100:02d}"


def output_gain(doc: Mapping, measured: Loudness | None) -> tuple[int, tuple[Issue, ...]]:
    """The master-stage gain in cdB and its warnings (``loudness_clamped``, ``peak_reduced``).

    ``normalize`` → ``master_gain``; peak protection (always on) → at most ``−100 − TP`` when
    ``TP > −1.0 dBTP``. ``measured`` is ``None`` exactly when ``needs_measurement`` is false;
    the gain is then 0 and ``compile_job`` adds no volume filter.

    Both ceilings are applied ``ENCODE_HEADROOM_CDB`` lower on the pre-encode mix (module
    docstring). Warnings carry their value after the colon, e.g.
    ``loudness_clamped:-16.30 LUFS`` (the loudness reached) and ``peak_reduced:-3.80 dB``.
    A mix below the absolute gate (silence) is not amplified.
    """
    if not needs_measurement(doc):
        return 0, ()
    if measured is None:
        raise ValueError("this document needs the audio_measure result (loudness.Loudness)")
    master = doc["audio"]["master"]
    normalize = master["mode"] == "normalize"
    warnings: list[Issue] = []
    desired = 0
    gain = 0
    if normalize and measured.i_clufs > ABSOLUTE_GATE_CLUFS:
        desired = master["target_clufs"] - measured.i_clufs
        gain, _clamped = master_gain(measured, master["target_clufs"],
                                     master["tp_cdb"] - ENCODE_HEADROOM_CDB)
    elif normalize:
        desired = master["target_clufs"] - measured.i_clufs  # silence: never reachable
    reduction = 0
    ceiling = PEAK_CEILING_CDB - ENCODE_HEADROOM_CDB
    if measured.tp_cdb + gain > ceiling:
        reduction = ceiling - measured.tp_cdb - gain
        gain += reduction
    if normalize and desired - gain > CLAMP_WARNING_CDB:
        achieved = measured.i_clufs + gain
        warnings.append(Issue(f"loudness_clamped:{format_centi(achieved)} LUFS", "/audio/master"))
    if reduction:
        warnings.append(Issue(f"peak_reduced:{format_centi(reduction)} dB", "/audio"))
    return gain, tuple(warnings)


__all__ = [
    "ABSOLUTE_GATE_CLUFS",
    "CLAMP_WARNING_CDB",
    "ENCODE_HEADROOM_CDB",
    "PEAK_CEILING_CDB",
    "SILENCE_TP_CDB",
    "Loudness",
    "format_centi",
    "master_gain",
    "needs_measurement",
    "output_gain",
    "parse_ebur128",
]
