"""CLI ``python -m ai_clipper.edit_v2.api`` for the Node routes (plan §4.2, §11.1 T1.1).

Owner: T1.1. Stub landed by T1.0. Protocol (frozen, see ``docs/editor/CONTRACTS.md``):

* stdin: one JSON envelope ``{"op": <op>, ...}`` with camelCase arguments; ids (``jobId``,
  ``clipId``, …) are validated by regex; paths are never accepted, the job directory is
  ``$JOBS_ROOT/<jobId>``; document bytes travel base64-encoded (``docRaw``) so that they are
  validated exactly as received;
* stdout: one JSON object; on failure ``{"error": {"code", "path", "ref", "messageId"}}`` plus
  ``current``/``etag`` for a revision conflict;
* exit codes: ``errors.EXIT_*`` (0 ok, 3 invalid, 4 not found, 5 conflict, 6 semantic, 7 too
  new, 8 analysis missing, 9 idempotency; 1 unexpected, 2 usage).

The per-op argument and result tables are written by T1.1 in this docstring.
"""

from __future__ import annotations

from collections.abc import Sequence

OPS = ("clips", "prepare_job", "get", "put", "seed", "archive")


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; returns the process exit code."""
    raise NotImplementedError("T1.1: edit_v2.api.main (plan §4.2, §11.1 T1.1)")


if __name__ == "__main__":
    raise SystemExit(main())
