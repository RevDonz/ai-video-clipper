"""The editor's client commands against the Python validator (plan §10.2 QG-UNDO, §11.2 T2.5).

Python (``edit_v2/doc.py``) is the only validator; the client builds valid documents by
construction (``web/lib/editor/commands.mjs``) and treats a 422 as a bug. This test runs
``node scripts/edit_v2/crosscheck_commands.mjs docs`` for 1,000 random command sequences on the
three fixture contexts. The script streams **every intermediate document** (after each command,
undo and redo, plus two-tab rebase merges and conflict resolutions) as JSON lines: a header
``{"ctx", "seq", "step", "op", "pieces", "seedEqual"}`` followed by the document's canonical bytes
as computed in JavaScript. Every document must

* be byte-identical to Python's ``canonical_bytes`` of itself,
* pass ``validate_doc(doc, words, assets, seed)`` without an error,
* have the JavaScript time map's pieces equal to ``timemap.pieces``,
* agree with ``content_equals_seed`` (R10).

Run ``PYTHONPATH=src:tests python tests/test_edit_v2_crosscheck.py [--sequences N]`` to print
the summary (the gate evidence ``docs/editor/evidence/W2/T2.5-crosscheck.json``); the module
needs no pytest, so it also runs inside the toolchain image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import canonical_bytes, content_equals_seed, parse_doc, validate_doc

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "edit_v2" / "crosscheck_commands.mjs"
SEQUENCES = 1000
SEED = 20260925
MAX_FAILURES = 20


def node_executable() -> str | None:
    return shutil.which("node")


def run_crosscheck(*, sequences: int = SEQUENCES, seed: int = SEED) -> dict[str, Any]:
    """Validate every document the script emits; returns counts and the first failures."""
    node = node_executable()
    if node is None:
        raise RuntimeError("node is not installed")
    contexts = {cid: fixtures.load_context(cid) for cid in fixtures.CONTEXT_IDS}
    started = time.perf_counter()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/tmp")}
    command = [node, str(SCRIPT), "docs", "--sequences", str(sequences), "--seed", str(seed)]
    process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    assert process.stdout is not None
    seen: set[tuple[str, str]] = set()
    failures: list[dict[str, Any]] = []
    documents = distinct = failure_count = 0
    by_op: dict[str, int] = {}
    sequences_seen: set[tuple[str, int]] = set()
    summary_line: dict[str, Any] | None = None
    while True:
        header_raw = process.stdout.readline()
        if not header_raw:
            break
        header = json.loads(header_raw)
        if header.get("summary"):
            summary_line = header
            continue
        raw = process.stdout.readline().rstrip(b"\n")
        documents += 1
        by_op[header["op"]] = by_op.get(header["op"], 0) + 1
        sequences_seen.add((header["ctx"], header["seq"]))
        key = (header["ctx"], hashlib.sha256(raw).hexdigest())
        if key in seen:
            continue
        seen.add(key)
        distinct += 1
        problem = check_document(raw, header, contexts[header["ctx"]])
        if problem is not None:
            failure_count += 1
            if len(failures) < MAX_FAILURES:
                failures.append({**problem, "ctx": header["ctx"], "seq": header["seq"],
                                 "step": header["step"], "op": header["op"]})
    stderr = process.stderr.read().decode("utf-8", "replace") if process.stderr else ""
    returncode = process.wait()
    return {
        "sequences": summary_line["sequences"] if summary_line else 0,
        "script_summary": summary_line,
        "sequence_ids": len(sequences_seen),
        "documents": documents,
        "distinct_documents": distinct,
        "documents_by_op": dict(sorted(by_op.items())),
        "failures": failures,
        "failure_count": failure_count,
        "returncode": returncode,
        "stderr_tail": stderr[-2000:],
        "seconds": round(time.perf_counter() - started, 2),
    }


def check_document(raw: bytes, header: dict[str, Any], context: fixtures.Context
                   ) -> dict[str, Any] | None:
    try:
        doc = parse_doc(raw)
    except Exception as error:  # noqa: BLE001 - reported as a failure with its code
        return {"code": "parse", "detail": getattr(error, "code", repr(error))}
    if canonical_bytes(doc) != raw:
        return {"code": "canonical_bytes_differ"}
    validation = validate_doc(doc, words=context.words, assets=context.assets, seed=context.seed)
    if validation.errors:
        return {"code": "invalid", "errors": [issue.to_json() for issue in validation.errors[:5]]}
    pieces = [[p.seg, p.in_sf, p.out_sf, p.out_f0, p.frames] for p in tm.pieces(doc)]
    if pieces != header["pieces"]:
        return {"code": "pieces_differ", "python": pieces[:5], "js": header["pieces"][:5]}
    if content_equals_seed(doc, context.seed) != header["seedEqual"]:
        return {"code": "seed_equal_differs", "python": not header["seedEqual"]}
    return None


def test_every_document_of_1000_random_command_sequences_passes_the_python_validator():
    import pytest  # here, so that the module also runs as a script where pytest is absent

    if node_executable() is None:
        pytest.skip("node is not installed (the web toolchain runs this cross-check)")
    summary = run_crosscheck()
    assert summary["returncode"] == 0, summary["stderr_tail"]
    assert summary["failure_count"] == 0, summary["failures"]
    assert summary["sequences"] == SEQUENCES
    assert summary["sequence_ids"] >= SEQUENCES
    assert summary["distinct_documents"] >= 10 * SEQUENCES
    for op in ("command", "undo", "redo", "rebase", "resolve"):
        assert summary["documents_by_op"].get(op, 0) > 0, op


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sequences", type=int, default=SEQUENCES)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args(argv)
    summary = run_crosscheck(sequences=args.sequences, seed=args.seed)
    summary["python"] = sys.version.split()[0]
    json.dump(summary, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if summary["failure_count"] == 0 and summary["returncode"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
