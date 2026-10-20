"""The yt-dlp version for Pengaturan's "Tentang sistem". Stdlib only.

``python -m ai_clipper.system_info`` reads one envelope ``{"op": "versions"}`` on stdin and writes
``{"yt_dlp": "<version>" | null}`` (exit 0). The version is the installed package's metadata: no
network and no yt-dlp process. A missing package or an odd version string is ``null``. A
malformed envelope exits 2 with the fixed ``internal_error`` body of the editor CLIs.
"""

from __future__ import annotations

import json
import re
import sys
from importlib import metadata

MAX_ENVELOPE_BYTES = 1024
_VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+!_-]{0,39}")
_USAGE = {"error": {"code": "internal_error", "path": None, "ref": None,
                    "messageId": "edit.internal_error"}}


class _Usage(Exception):
    pass


def package_version(name: str) -> str | None:
    """The installed version of ``name``, or None when it is missing or not a plain version."""
    try:
        version = metadata.version(name)
    except Exception:  # noqa: BLE001 - not installed, or unreadable metadata: both are "unknown"
        return None
    if isinstance(version, str) and _VERSION.fullmatch(version):
        return version
    return None


def versions() -> dict[str, str | None]:
    return {"yt_dlp": package_version("yt-dlp")}


def _pairs(pairs: list[tuple[str, object]]) -> dict:
    result = dict(pairs)
    if len(result) != len(pairs):
        raise _Usage()
    return result


def _envelope(raw: bytes) -> None:
    if not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs)
    except (ValueError, UnicodeDecodeError):
        raise _Usage() from None
    if value != {"op": "versions"}:
        raise _Usage()


def _emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, sort_keys=True) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        _envelope(sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1))
    except _Usage:
        _emit(_USAGE)
        return 2
    _emit(versions())
    return 0


if __name__ == "__main__":
    sys.exit(main())
