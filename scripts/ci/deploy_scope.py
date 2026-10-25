#!/usr/bin/env python3
"""Whether a push to ``main`` changes only documentation (``ci-cd.yml``, job ``changes``).

A docs-only push skips the image build, the parity job and ``Deploy production``; ``Test and
build`` still runs. Documentation is everything under ``docs/`` and every ``*.md`` outside the
folders the image ships (``src/``, ``resources/``, ``web/``): ``src/ai_clipper/prompts/*.md`` are
runtime prompts. Every doubt answers "not docs-only", so the deploy runs: any event other than a
push, a first push (``before`` all zeros), a force push, a ``before`` missing from the clone or
a ``git diff`` that fails.

CLI (stdlib only)::

    deploy_scope.py --event EVENT --before SHA --after SHA [--forced true|false] [--repo DIR]

prints ``docs_only=true|false`` (a ``$GITHUB_OUTPUT`` line) and the reason on stderr.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

SHIPPED = ("src/", "resources/", "web/")
_SHA = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def is_docs(path: str) -> bool:
    if path.startswith("docs/"):
        return True
    return path.endswith(".md") and not path.startswith(SHIPPED)


def docs_only(paths: list[str]) -> bool:
    return bool(paths) and all(is_docs(path) for path in paths)


def changed_paths(before: str, after: str, repo: Path) -> list[str] | None:
    """The paths changed from ``before`` to ``after``, or None when git cannot tell."""
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "diff", "--name-only", "--no-renames", "-z",
             f"{before}^{{commit}}", f"{after}^{{commit}}", "--"],
            check=True, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return [path for path in out.stdout.decode("utf-8", "surrogateescape").split("\0") if path]


def decide(event: str, before: str, after: str, forced: str, *,
           repo: Path = Path(".")) -> tuple[bool, str]:
    if event != "push":
        return False, f"event {event!r} is not a push"
    if forced.strip().lower() == "true":
        return False, "force push"
    if not _SHA.fullmatch(before) or set(before) == {"0"}:
        return False, "no usable before commit (first push?)"
    if not _SHA.fullmatch(after):
        return False, "no usable after commit"
    paths = changed_paths(before, after, repo)
    if paths is None:
        return False, "git diff failed"
    if not docs_only(paths):
        code = [path for path in paths if not is_docs(path)]
        return False, f"{len(code)} non-documentation path(s), e.g. {code[0]}" if code \
            else "no changed paths"
    return True, "docs only"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--event", default="")
    parser.add_argument("--before", default="")
    parser.add_argument("--after", default="")
    parser.add_argument("--forced", default="false")
    parser.add_argument("--repo", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        result, reason = decide(args.event, args.before, args.after, args.forced, repo=args.repo)
    except Exception as error:  # noqa: BLE001 - any failure deploys
        result, reason = False, f"classifier error: {error}"
    print(f"docs_only={'true' if result else 'false'}")
    print(f"deploy scope: {reason}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
