"""The toolchain guard (plan §10, §11.4 T4.4; ``scripts/parity/toolchain_guard.py``).

A change to the rendering toolchain (the Dockerfile pins that ``toolchain.json`` records) or to
the JASSUB pin must come with fresh P-TIME, P-TXT, P-ENC, P-COLOR and P-RT evidence measured on
the new pins. The guard derives the toolchain document from the Dockerfile (the image writes the
same bytes; ``image`` checks that inside the built image) and compares it and the JASSUB pin
with the committed record and the stamps of the evidence files the record names.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "parity"))

import toolchain_guard as tg

from ai_clipper.edit_v2 import toolchain

DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
PACKAGE = json.loads((ROOT / "web" / "package.json").read_text(encoding="utf-8"))
LOCK = json.loads((ROOT / "web" / "package-lock.json").read_text(encoding="utf-8"))


def _repo(tmp_path: Path, *, dockerfile: str = DOCKERFILE, package=None, lock=None) -> Path:
    (tmp_path / "web").mkdir()
    (tmp_path / "Dockerfile").write_text(dockerfile, encoding="utf-8")
    (tmp_path / "web" / "package.json").write_text(json.dumps(package or PACKAGE), encoding="utf-8")
    (tmp_path / "web" / "package-lock.json").write_text(json.dumps(lock or LOCK), encoding="utf-8")
    return tmp_path


def _write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _recorded_repo(tmp_path: Path) -> Path:
    """A repository whose record and evidence match its own pins."""
    repo = _repo(tmp_path)
    state = tg.current(repo)
    gates = {}
    for gate in tg.REQUIRED_GATES:
        relative = f"docs/editor/evidence/toolchain/{gate}.json"
        _write(repo / relative, tg.stamp({"gate": gate, "pass": True}, state, commit="abc", run="1"))
        gates[gate] = [relative]
    _write(repo / tg.RECORD, tg.make_record(state, gates, commit="abc", run="1"))
    return repo


# --- deriving the toolchain document ----------------------------------------------------------


def test_the_dockerfile_gives_the_toolchain_document_the_image_writes():
    document = tg.derive_toolchain(DOCKERFILE)
    assert toolchain.validate(document) == document
    assert document["base_image"].startswith("node:20-bookworm-slim@sha256:")
    assert document["apt_snapshot"] == "20260924T000000Z"
    assert document["packages"]["ffmpeg"] == "7:5.1.9-0+deb12u1"
    assert document["packages"]["libass9"] == "1:0.17.1-1+deb12u1"
    assert set(document["packages"]) == set(toolchain.PACKAGES)
    assert tg.toolchain_sha256(document) == hashlib.sha256(toolchain.encode(document)).hexdigest()


def test_any_pin_change_changes_the_toolchain_sha():
    base = tg.toolchain_sha256(tg.derive_toolchain(DOCKERFILE))
    for old, new in (("libass9=1:0.17.1-1+deb12u1", "libass9=1:0.17.1-1+deb12u2"),
                     ("ARG DEBIAN_SNAPSHOT=20260924T000000Z", "ARG DEBIAN_SNAPSHOT=20261001T000000Z"),
                     ("ffmpeg=7:5.1.9-0+deb12u1", "ffmpeg=7:5.1.10-0+deb12u1")):
        assert old in DOCKERFILE
        assert tg.toolchain_sha256(tg.derive_toolchain(DOCKERFILE.replace(old, new))) != base


@pytest.mark.parametrize("mangle", [
    lambda text: text.replace("ARG DEBIAN_SNAPSHOT=20260924T000000Z", "ARG DEBIAN_SNAPSHOT"),
    lambda text: text.replace("fontconfig=2.14.1-4", "fontconfig"),
    lambda text: text.replace("libfribidi0=1.0.8-2.1", "libfribidi0=1.0.8-2.1 libfribidi0=1.0.9-1"),
    lambda text: text.replace("ARG NODE_IMAGE=node:20-bookworm-slim@sha256:", "ARG NODE_IMAGE=node:20-bookworm-slim:"),
])
def test_an_unpinned_or_ambiguous_dockerfile_is_refused(mangle):
    with pytest.raises(tg.GuardError):
        tg.derive_toolchain(mangle(DOCKERFILE))


def test_the_jassub_pin_is_exact_and_matches_the_lock():
    pin = tg.jassub_pin(PACKAGE, LOCK)
    assert pin["version"] == PACKAGE["dependencies"]["jassub"]
    assert pin["integrity"].startswith("sha512-")
    loose = copy.deepcopy(PACKAGE)
    loose["dependencies"]["jassub"] = "^" + pin["version"]
    with pytest.raises(tg.GuardError):
        tg.jassub_pin(loose, LOCK)
    drifted = copy.deepcopy(LOCK)
    drifted["packages"]["node_modules/jassub"]["version"] = "9.9.9"
    with pytest.raises(tg.GuardError):
        tg.jassub_pin(PACKAGE, drifted)


def test_the_image_check_compares_bytes_with_the_derivation():
    derived = toolchain.encode(tg.derive_toolchain(DOCKERFILE))
    assert tg.check_image(DOCKERFILE, derived) == []
    other = json.loads(derived)
    other["packages"]["libass9"] = "1:0.17.1-1+deb12u2"
    problems = tg.check_image(DOCKERFILE, toolchain.encode(other))
    assert problems and "libass9" in problems[0]


# --- stamps, the record and the check ------------------------------------------------------------


def test_a_repository_whose_record_matches_its_pins_passes(tmp_path):
    assert tg.check(_recorded_repo(tmp_path)) == []


def test_a_toolchain_change_without_fresh_evidence_fails(tmp_path):
    repo = _recorded_repo(tmp_path)
    (repo / "Dockerfile").write_text(DOCKERFILE.replace("libass9=1:0.17.1-1+deb12u1",
                                                        "libass9=1:0.17.1-1+deb12u2"))
    problems = tg.check(repo)
    assert any("toolchain" in p and "libass9" in p for p in problems)
    # Updating only the record is not enough: every gate's evidence carries the old stamp.
    state = tg.current(repo)
    record = json.loads((repo / tg.RECORD).read_text())
    _write(repo / tg.RECORD, tg.make_record(state, record["gates"], commit="def", run="2"))
    problems = tg.check(repo)
    assert len(problems) == len(tg.REQUIRED_GATES)
    assert all("stamp" in p for p in problems)


def test_a_jassub_change_without_fresh_evidence_fails(tmp_path):
    repo = _recorded_repo(tmp_path)
    package = copy.deepcopy(PACKAGE)
    lock = copy.deepcopy(LOCK)
    package["dependencies"]["jassub"] = "2.5.17"
    lock["packages"]["node_modules/jassub"]["version"] = "2.5.17"
    lock["packages"]["node_modules/jassub"]["integrity"] = "sha512-other"
    (repo / "web" / "package.json").write_text(json.dumps(package))
    (repo / "web" / "package-lock.json").write_text(json.dumps(lock))
    assert any("JASSUB" in p for p in tg.check(repo))


def test_fresh_evidence_with_matching_stamps_passes_after_a_change(tmp_path):
    repo = _recorded_repo(tmp_path)
    (repo / "Dockerfile").write_text(DOCKERFILE.replace("ARG DEBIAN_SNAPSHOT=20260924T000000Z",
                                                        "ARG DEBIAN_SNAPSHOT=20261001T000000Z"))
    state = tg.current(repo)
    gates = {}
    for gate in tg.REQUIRED_GATES:
        relative = f"docs/editor/evidence/toolchain/{gate}.json"
        _write(repo / relative, tg.stamp({"gate": gate, "pass": True}, state, commit="def", run="2"))
        gates[gate] = [relative]
    _write(repo / tg.RECORD, tg.make_record(state, gates, commit="def", run="2"))
    assert tg.check(repo) == []


def test_missing_failed_or_unstamped_evidence_fails(tmp_path):
    repo = _recorded_repo(tmp_path)
    record = json.loads((repo / tg.RECORD).read_text())
    (repo / record["gates"]["P-ENC"][0]).unlink()
    failed = repo / record["gates"]["P-COLOR"][0]
    _write(failed, {**json.loads(failed.read_text()), "pass": False})
    unstamped = repo / record["gates"]["P-RT"][0]
    _write(unstamped, {"gate": "P-RT", "pass": True})
    del record["gates"]["P-TIME"]
    _write(repo / tg.RECORD, record)
    problems = "\n".join(tg.check(repo))
    for gate in ("P-ENC", "P-COLOR", "P-RT", "P-TIME"):
        assert gate in problems
    assert "P-TXT" not in problems


def test_no_record_is_a_failure_with_the_remedy(tmp_path):
    problems = tg.check(_repo(tmp_path))
    assert len(problems) == 1
    assert "suite=toolchain" in problems[0]


def test_record_paths_stay_inside_the_repository(tmp_path):
    repo = _recorded_repo(tmp_path)
    record = json.loads((repo / tg.RECORD).read_text())
    record["gates"]["P-TXT"] = ["../outside.json"]
    _write(repo / tg.RECORD, record)
    assert any("P-TXT" in p for p in tg.check(repo))


def test_stamp_keeps_the_evidence_and_adds_the_state():
    state = tg.current(ROOT)
    stamped = tg.stamp({"gate": "P-TXT", "pass": True, "frames": 30}, state, commit="c0ffee", run="7")
    assert stamped["frames"] == 30
    assert stamped["stamp"] == {"schema": tg.STAMP_SCHEMA, "toolchain_sha256": state["toolchain_sha256"],
                                "jassub": state["jassub"], "commit": "c0ffee", "run": "7"}
    with pytest.raises(tg.GuardError):
        tg.stamp({"gate": "P-TIME", "mismatches": 0}, state, commit=None, run=None)
