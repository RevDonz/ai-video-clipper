#!/usr/bin/env python3
"""The toolchain guard (plan §10, §11.4 T4.4): no new rendering toolchain or JASSUB pin without
fresh P-TIME, P-TXT, P-ENC, P-COLOR and P-RT evidence measured on it.

``toolchain.json`` is written by the image build from the Dockerfile's pins (the base image
digest, the Debian snapshot and the six rendering packages), so the guard derives the same
document from the Dockerfile without building; ``image`` checks inside the built image that the
two agree byte for byte. The JASSUB pin is ``web/package.json`` (an exact version) and its
``web/package-lock.json`` entry (version and integrity).

The record ``docs/editor/evidence/toolchain/record.json`` names, per gate, the evidence files of
the last run on the current pins. Every such file carries a ``stamp`` (toolchain sha, JASSUB pin,
commit, workflow run) written by the run that measured it. ``check`` fails when the pins differ
from the record or when any gate's evidence is missing, failed or stamped for other pins.

CLI (stdlib only; the CI runner's python3 with ``src`` on ``PYTHONPATH``)::

    toolchain_guard.py check [--repo DIR]
    toolchain_guard.py state [--repo DIR] [--out FILE]
    toolchain_guard.py image --toolchain /app/resources/toolchain.json [--repo DIR]
    toolchain_guard.py stamp --state STATE.json [--commit SHA] [--run ID] FILE...
    toolchain_guard.py record --state STATE.json --gate GATE=PATH ... --out FILE
        [--commit SHA] [--run ID]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))

from ai_clipper.edit_v2 import toolchain

RECORD = Path("docs/editor/evidence/toolchain/record.json")
RECORD_SCHEMA = "potongin.toolchain-record/1"
STAMP_SCHEMA = "potongin.evidence-stamp/1"
REQUIRED_GATES = ("P-TIME", "P-TXT", "P-ENC", "P-COLOR", "P-RT")
REMEDY = ("measure them on the new pins with `gh workflow run ci-cd.yml --ref <branch> -f "
          "suite=toolchain`, then commit the run's `toolchain-evidence` artifact "
          "(docs/editor/evidence/toolchain/) with the change")

_ARG = re.compile(r"^ARG\s+(NODE_IMAGE|DEBIAN_SNAPSHOT)=(\S+)\s*$", re.MULTILINE)
_PIN = re.compile(r"(?<![\w.+-])(" + "|".join(re.escape(p) for p in toolchain.PACKAGES)
                  + r")(?:=([0-9A-Za-z.+~:-]+))?(?![\w.+-])")
_EXACT = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


class GuardError(ValueError):
    """The pins cannot be read unambiguously."""


def derive_toolchain(dockerfile: str) -> dict[str, Any]:
    """The ``toolchain.json`` document the image build writes for these Dockerfile pins."""
    args: dict[str, list[str]] = {}
    for name, value in _ARG.findall(dockerfile):
        args.setdefault(name, []).append(value)
    for name in ("NODE_IMAGE", "DEBIAN_SNAPSHOT"):
        if len(args.get(name, [])) != 1:
            raise GuardError(f"the Dockerfile must set ARG {name}=<value> exactly once")
    install = [line for line in _logical_lines(dockerfile)
               if "apt-get install" in line and "ffmpeg" in line]
    if len(install) != 1:
        raise GuardError("the Dockerfile must install the rendering packages in one apt-get command")
    pins: dict[str, list[str | None]] = {}
    for package, version in _PIN.findall(install[0]):
        pins.setdefault(package, []).append(version or None)
    lines = []
    for package in toolchain.PACKAGES:
        versions = pins.get(package, [])
        if len(versions) != 1 or versions[0] is None:
            raise GuardError(f"{package} must be pinned exactly once (package=version)")
        lines.append(f"{package}\t{versions[0]}\n")
    try:
        return toolchain.build("".join(lines), base_image=args["NODE_IMAGE"][0],
                               apt_snapshot=args["DEBIAN_SNAPSHOT"][0])
    except toolchain.ToolchainError as error:
        raise GuardError(str(error)) from error


def _logical_lines(text: str) -> list[str]:
    return text.replace("\\\n", " ").splitlines()


def toolchain_sha256(document: Mapping[str, Any]) -> str:
    return hashlib.sha256(toolchain.encode(document)).hexdigest()


def jassub_pin(package: Mapping[str, Any], lock: Mapping[str, Any]) -> dict[str, str]:
    """``{version, integrity}`` of the JASSUB the web app installs (an exact pin)."""
    version = (package.get("dependencies") or {}).get("jassub")
    if not isinstance(version, str) or not _EXACT.fullmatch(version):
        raise GuardError("web/package.json must pin jassub to an exact version")
    entry = (lock.get("packages") or {}).get("node_modules/jassub") or {}
    if entry.get("version") != version:
        raise GuardError("web/package-lock.json does not install the jassub version package.json pins")
    integrity = entry.get("integrity")
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        raise GuardError("web/package-lock.json has no sha512 integrity for jassub")
    return {"version": version, "integrity": integrity}


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def current(repo: Path = ROOT) -> dict[str, Any]:
    """The pins of a checkout: ``{toolchain, toolchain_sha256, jassub}``."""
    document = derive_toolchain((repo / "Dockerfile").read_text(encoding="utf-8"))
    pin = jassub_pin(_json(repo / "web" / "package.json"), _json(repo / "web" / "package-lock.json"))
    return {"toolchain": document, "toolchain_sha256": toolchain_sha256(document), "jassub": pin}


def stamp(evidence: Mapping[str, Any], state: Mapping[str, Any], *, commit: str | None,
          run: str | None) -> dict[str, Any]:
    """``evidence`` with the pins it was measured on (it must say pass or fail)."""
    if not isinstance(evidence.get("pass"), bool):
        raise GuardError("evidence without a pass/fail verdict cannot be stamped")
    return {**evidence, "stamp": {"schema": STAMP_SCHEMA,
                                  "toolchain_sha256": state["toolchain_sha256"],
                                  "jassub": dict(state["jassub"]), "commit": commit, "run": run}}


def make_record(state: Mapping[str, Any], gates: Mapping[str, Sequence[str]], *,
                commit: str | None, run: str | None) -> dict[str, Any]:
    missing = [gate for gate in REQUIRED_GATES if not gates.get(gate)]
    if missing:
        raise GuardError("no evidence for " + ", ".join(missing))
    return {"schema": RECORD_SCHEMA, "toolchain": state["toolchain"],
            "toolchain_sha256": state["toolchain_sha256"], "jassub": dict(state["jassub"]),
            "gates": {gate: list(gates[gate]) for gate in REQUIRED_GATES},
            "commit": commit, "run": run}


def _changed_fields(old: Any, new: Mapping[str, Any]) -> list[str]:
    if not isinstance(old, Mapping):
        return ["toolchain"]
    changed = [key for key in ("base_image", "apt_snapshot") if old.get(key) != new.get(key)]
    old_packages = old.get("packages") if isinstance(old.get("packages"), Mapping) else {}
    changed += [f"{name} {old_packages.get(name)} -> {version}"
                for name, version in new["packages"].items() if old_packages.get(name) != version]
    return changed


def _inside(repo: Path, relative: object) -> Path | None:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        return None
    path = (repo / relative).resolve()
    return path if path.is_relative_to(repo.resolve()) else None


def check(repo: Path = ROOT, record_path: Path | None = None) -> list[str]:
    """Problems that block the change (an empty list passes)."""
    try:
        state = current(repo)
    except (OSError, ValueError) as error:
        return [f"cannot read the pins: {error}"]
    path = repo / (record_path or RECORD)
    try:
        record = _json(path)
        if record.get("schema") != RECORD_SCHEMA:
            raise ValueError("unknown schema")
    except (OSError, ValueError) as error:
        reason = "missing" if isinstance(error, FileNotFoundError) else type(error).__name__
        return [f"no usable toolchain record at {record_path or RECORD} ({reason}): {REMEDY}"]
    problems = []
    if record.get("toolchain_sha256") != state["toolchain_sha256"]:
        fields = ", ".join(_changed_fields(record.get("toolchain"), state["toolchain"]))
        problems.append(f"the rendering toolchain changed ({fields}) without fresh "
                        f"P-TIME/P-TXT/P-ENC/P-COLOR/P-RT evidence: {REMEDY}")
    if record.get("jassub") != state["jassub"]:
        recorded = (record.get("jassub") or {}).get("version")
        problems.append(f"the JASSUB pin changed ({recorded} -> {state['jassub']['version']}) "
                        f"without fresh P-TIME/P-TXT/P-ENC/P-COLOR/P-RT evidence: {REMEDY}")
    gates = record.get("gates") if isinstance(record.get("gates"), Mapping) else {}
    for gate in REQUIRED_GATES:
        files = gates.get(gate)
        if not isinstance(files, list) or not files:
            problems.append(f"{gate}: the record names no evidence: {REMEDY}")
            continue
        for relative in files:
            evidence_path = _inside(repo, relative)
            if evidence_path is None:
                problems.append(f"{gate}: {relative!r} is not a path inside the repository")
                continue
            try:
                evidence = _json(evidence_path)
            except (OSError, ValueError):
                problems.append(f"{gate}: {relative} is missing or not JSON: {REMEDY}")
                continue
            if evidence.get("pass") is not True:
                problems.append(f"{gate}: {relative} does not record a pass")
                continue
            mark = evidence.get("stamp") if isinstance(evidence.get("stamp"), Mapping) else {}
            if (mark.get("toolchain_sha256") != state["toolchain_sha256"]
                    or mark.get("jassub") != state["jassub"]):
                problems.append(f"{gate}: {relative} has no stamp for the current toolchain "
                                f"and JASSUB pin: {REMEDY}")
    return problems


def check_image(dockerfile: str, image_toolchain: bytes) -> list[str]:
    """The image's ``toolchain.json`` must be exactly what the Dockerfile pins derive."""
    derived = derive_toolchain(dockerfile)
    if toolchain.encode(derived) == image_toolchain:
        return []
    try:
        image = json.loads(image_toolchain.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        return ["the image's toolchain.json is not JSON"]
    fields = ", ".join(_changed_fields(image, derived)) or "byte form"
    return [f"the image's toolchain.json differs from the Dockerfile pins ({fields})"]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "state", "image"):
        command = commands.add_parser(name)
        command.add_argument("--repo", type=Path, default=ROOT)
    commands.choices["state"].add_argument("--out", type=Path)
    commands.choices["image"].add_argument("--toolchain", type=Path, required=True)
    stamp_cmd = commands.add_parser("stamp")
    stamp_cmd.add_argument("--state", type=Path, required=True)
    stamp_cmd.add_argument("--commit")
    stamp_cmd.add_argument("--run")
    stamp_cmd.add_argument("files", type=Path, nargs="+")
    record_cmd = commands.add_parser("record")
    record_cmd.add_argument("--state", type=Path, required=True)
    record_cmd.add_argument("--gate", action="append", default=[], help="GATE=repo-relative path")
    record_cmd.add_argument("--out", type=Path, required=True)
    record_cmd.add_argument("--commit")
    record_cmd.add_argument("--run")
    args = parser.parse_args(argv)

    if args.command == "check":
        problems = check(args.repo.resolve())
        for problem in problems:
            print(f"toolchain guard: {problem}", file=sys.stderr)
        if not problems:
            print("toolchain guard: the toolchain and JASSUB pins match the recorded evidence")
        return 1 if problems else 0
    if args.command == "image":
        problems = check_image((args.repo / "Dockerfile").read_text(encoding="utf-8"),
                               args.toolchain.read_bytes())
        for problem in problems:
            print(f"toolchain guard: {problem}", file=sys.stderr)
        return 1 if problems else 0
    if args.command == "state":
        text = json.dumps(current(args.repo.resolve()), indent=2, sort_keys=True) + "\n"
        if args.out:
            args.out.write_text(text, encoding="utf-8")
        else:
            sys.stdout.write(text)
        return 0
    state = _json(args.state)
    if args.command == "stamp":
        for path in args.files:
            stamped = stamp(_json(path), state, commit=args.commit, run=args.run)
            path.write_text(json.dumps(stamped, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 0
    gates: dict[str, list[str]] = {}
    for item in args.gate:
        gate, _, relative = item.partition("=")
        gates.setdefault(gate, []).append(relative)
    record = make_record(state, gates, commit=args.commit, run=args.run)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
