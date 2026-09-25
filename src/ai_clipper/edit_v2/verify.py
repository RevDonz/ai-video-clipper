"""Verify a rendered file against its plan: G1–G3, G3b block, G5 warns (plan §5.9).

Owner: T1.3. Stub landed by T1.0 with the frozen Appendix A signature.
"""

from __future__ import annotations

from dataclasses import dataclass

from .plan import RenderPlan


@dataclass(frozen=True)
class VerifyReport:
    """Gate results of one file. Shape owned by T1.3 (no other W1 task reads it)."""


def verify_output(
    fd: int, plan: RenderPlan, *, size: tuple[int, int], normalize: bool
) -> VerifyReport:
    """G1 container, G2 A/V counts, G3 loudness (``normalize``), G3b true peak, G5 text-safe.

    A blocking failure raises ``VerificationFailed`` (``verification_failed``).
    """
    raise NotImplementedError("T1.3: edit_v2.verify.verify_output (plan §5.9)")


__all__ = ["VerifyReport", "verify_output"]
