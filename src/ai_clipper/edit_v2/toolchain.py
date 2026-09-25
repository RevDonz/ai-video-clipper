"""``resources/toolchain.json``: the pinned rendering toolchain of the image (plan E10, §5.2 R9).

The image build writes the file once, after the pinned apt packages are installed::

    python -m ai_clipper.edit_v2.toolchain write /app/resources/toolchain.json \\
        --base-image node:20-bookworm-slim@sha256:<64 hex> --apt-snapshot 20260924T000000Z

It records ``dpkg-query -W`` for the six packages that decide how text and video are rendered
(FFmpeg, libass, freetype, harfbuzz, fribidi, fontconfig: the ``ffmpeg -version`` line alone
misses a freetype or harfbuzz change that alters glyph rasterisation), the base image digest and
the Debian snapshot the packages came from. ``plan.toolchain_sha256`` hashes the file's bytes
into the render key, so an image rebuilt with any other toolchain renders to new keys, while
revision 0 stays the auto file by content identity (R10).

The bytes are canonical (sorted keys, two-space indent, trailing newline), so the same toolchain
always gives the same sha. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

SCHEMA = "potongin.toolchain/1"
PACKAGES = ("ffmpeg", "libass9", "libfreetype6", "libharfbuzz0b", "libfribidi0", "fontconfig")
FILE_NAME = "toolchain.json"

_BASE_IMAGE = re.compile(r"[a-z0-9][a-z0-9._/:-]{0,200}@sha256:[0-9a-f]{64}")
_SNAPSHOT = re.compile(r"[0-9]{8}T[0-9]{6}Z")
_PACKAGE = re.compile(r"[a-z0-9][a-z0-9.+-]*")
_VERSION = re.compile(r"[0-9A-Za-z.+~:-]+")


class ToolchainError(ValueError):
    """The dpkg output, the base image reference or a stored file is not acceptable."""


def parse_dpkg_query(text: str, packages: Sequence[str] = PACKAGES) -> dict[str, str]:
    """``{package: version}`` from ``dpkg-query -W`` output (``name[:arch]<TAB>version``).

    Every package of ``packages`` must be installed exactly once (an architecture qualifier is
    dropped; two architectures with different versions are an error), with a non-empty version.
    Lines of other packages are ignored.
    """
    found: dict[str, str] = {}
    for line in text.splitlines():
        if not line.strip():
            continue
        name, tab, version = line.partition("\t")
        name = name.strip().split(":", 1)[0]
        version = version.strip()
        if not tab or not _PACKAGE.fullmatch(name):
            raise ToolchainError(f"unexpected dpkg-query line: {line!r}")
        if name not in packages:
            continue
        if not version or not _VERSION.fullmatch(version):
            raise ToolchainError(f"{name} is not installed")
        if found.get(name, version) != version:
            raise ToolchainError(f"{name} is installed in two versions")
        found[name] = version
    missing = [name for name in packages if name not in found]
    if missing:
        raise ToolchainError("missing packages: " + ", ".join(missing))
    return {name: found[name] for name in packages}


def build(dpkg_output: str, *, base_image: str, apt_snapshot: str | None) -> dict[str, Any]:
    """The toolchain document of an image."""
    if not _BASE_IMAGE.fullmatch(base_image):
        raise ToolchainError("base_image must be pinned by digest (<name>@sha256:<64 hex>)")
    if apt_snapshot is not None and not _SNAPSHOT.fullmatch(apt_snapshot):
        raise ToolchainError("apt_snapshot must look like 20260924T000000Z")
    return {
        "schema": SCHEMA,
        "base_image": base_image,
        "apt_snapshot": apt_snapshot,
        "packages": parse_dpkg_query(dpkg_output),
    }


def encode(document: Mapping[str, Any]) -> bytes:
    """Canonical bytes of a toolchain document."""
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode(
        "ascii")


def validate(document: Any) -> dict[str, Any]:
    """Check a stored toolchain document; returns it as a dict."""
    if not isinstance(document, dict) or set(document) != {"schema", "base_image",
                                                            "apt_snapshot", "packages"}:
        raise ToolchainError("not a toolchain document")
    if document["schema"] != SCHEMA:
        raise ToolchainError("unknown toolchain schema")
    packages = document["packages"]
    if not isinstance(packages, dict) or tuple(sorted(packages)) != tuple(sorted(PACKAGES)):
        raise ToolchainError("the toolchain must list exactly the pinned packages")
    lines = "".join(f"{name}\t{version}\n" for name, version in packages.items()
                    if isinstance(version, str))
    return build(lines, base_image=document["base_image"],
                 apt_snapshot=document["apt_snapshot"])


def read(path: Path) -> dict[str, Any]:
    """Read and validate ``toolchain.json``; the bytes must be canonical."""
    raw = Path(path).read_bytes()
    try:
        document = json.loads(raw.decode("ascii"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ToolchainError("toolchain.json is not JSON") from error
    document = validate(document)
    if encode(document) != raw:
        raise ToolchainError("toolchain.json is not in canonical form")
    return document


def dpkg_query(packages: Sequence[str] = PACKAGES) -> str:
    """``dpkg-query -W`` for ``packages`` (the image build runs this)."""
    binary = shutil.which("dpkg-query")
    if binary is None:
        raise ToolchainError("dpkg-query not found")
    result = subprocess.run([binary, "-W", *packages], capture_output=True, text=True,
                            check=False, timeout=30)
    if result.returncode != 0:
        raise ToolchainError("dpkg-query failed: " + result.stderr.strip()[:200])
    return result.stdout


def write(path: Path, *, base_image: str, apt_snapshot: str | None,
          dpkg_output: str | None = None) -> dict[str, Any]:
    """Write ``toolchain.json`` (canonical bytes) and return the document."""
    document = build(dpkg_query() if dpkg_output is None else dpkg_output,
                     base_image=base_image, apt_snapshot=apt_snapshot)
    Path(path).write_bytes(encode(document))
    return document


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write or check resources/toolchain.json")
    commands = parser.add_subparsers(dest="command", required=True)
    write_cmd = commands.add_parser("write", help="record the installed toolchain")
    write_cmd.add_argument("path", type=Path)
    write_cmd.add_argument("--base-image", required=True)
    write_cmd.add_argument("--apt-snapshot", default=None)
    check_cmd = commands.add_parser("check", help="validate a toolchain.json")
    check_cmd.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "write":
            document = write(args.path, base_image=args.base_image,
                             apt_snapshot=args.apt_snapshot)
        else:
            document = read(args.path)
    except (OSError, ToolchainError) as error:
        print(f"toolchain: {error}", file=sys.stderr)
        return 1
    print(json.dumps(document["packages"], sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = [
    "FILE_NAME",
    "PACKAGES",
    "SCHEMA",
    "ToolchainError",
    "build",
    "dpkg_query",
    "encode",
    "main",
    "parse_dpkg_query",
    "read",
    "validate",
    "write",
]
