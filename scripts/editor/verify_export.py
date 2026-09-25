"""G1–G3 (and G3b, G5 warnings) of a downloaded editor export against its document (T2.Z).

Used by ``web/e2e/editor-flow.spec.mjs`` after "Unduh MP4": the document is the one the export
was made from (the editor's saved revision), the plan is built exactly as the render worker
builds it (``render_edit.load_render_inputs``), and the file is checked with the gates every
render passes before it is published (``render_edit.verify_file``, plan §5.9).

    python scripts/editor/verify_export.py --job-dir <JOBS_ROOT/job> --doc <doc.json> --file <mp4>

Prints one JSON object (numbers and gate names only) and exits 0 when every blocking gate
passes, 1 otherwise. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--doc", type=Path, required=True)
    parser.add_argument("--file", type=Path, required=True)
    args = parser.parse_args(argv)

    from ai_clipper.edit_v2 import errors, render_edit

    doc = json.loads(args.doc.read_text(encoding="utf-8"))
    plan = render_edit.load_render_inputs(args.job_dir, doc).plan
    try:
        report = render_edit.verify_file(args.file, plan)
    except errors.VerificationFailed as failure:
        report = getattr(failure, "report", None)
        result = {"ok": False, "error": failure.code,
                  "report": report.to_json() if report is not None else None}
        print(json.dumps(result, sort_keys=True))
        return 1
    result = {"ok": report.ok, "frames": plan.total_frames, "samples": plan.total_samples,
              "report": report.to_json()}
    print(json.dumps(result, sort_keys=True))
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
