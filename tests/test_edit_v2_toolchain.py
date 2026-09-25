"""``resources/toolchain.json`` (plan E10, §5.2 R9): written by the image build from
``dpkg-query -W``, hashed into the render key."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import toolchain
from ai_clipper.edit_v2.plan import Resources, toolchain_sha256

ROOT = Path(__file__).resolve().parents[1]
BASE = "node:20-bookworm-slim@sha256:" + "2c" * 32
SNAPSHOT = "20260924T000000Z"
# dpkg-query -W output of the reference image (ai-video-clipper:editor-ref), plus a package the
# toolchain does not track.
DPKG = (
    "ffmpeg\t7:5.1.9-0+deb12u1\n"
    "fontconfig\t2.14.1-4\n"
    "libass9:amd64\t1:0.17.1-1+deb12u1\n"
    "libfreetype6:amd64\t2.12.1+dfsg-5+deb12u4\n"
    "libfribidi0:amd64\t1.0.8-2.1\n"
    "libharfbuzz0b:amd64\t6.0.0+dfsg-3\n"
    "libx264-164:amd64\t2:0.164.3095+gitbaee400-3\n"
)
PINNED = {
    "ffmpeg": "7:5.1.9-0+deb12u1",
    "libass9": "1:0.17.1-1+deb12u1",
    "libfreetype6": "2.12.1+dfsg-5+deb12u4",
    "libharfbuzz0b": "6.0.0+dfsg-3",
    "libfribidi0": "1.0.8-2.1",
    "fontconfig": "2.14.1-4",
}


def test_the_six_rendering_packages_are_tracked():
    assert toolchain.PACKAGES == ("ffmpeg", "libass9", "libfreetype6", "libharfbuzz0b",
                                  "libfribidi0", "fontconfig")


def test_parse_drops_architecture_and_other_packages():
    assert toolchain.parse_dpkg_query(DPKG) == PINNED


@pytest.mark.parametrize("broken, message", [
    (DPKG.replace("fontconfig\t2.14.1-4\n", ""), "missing packages: fontconfig"),
    (DPKG.replace("libass9:amd64\t1:0.17.1-1+deb12u1", "libass9:amd64\t"), "not installed"),
    (DPKG + "libass9:i386\t1:0.17.1-1\n", "two versions"),
    (DPKG + "no tab here\n", "unexpected"),
])
def test_parse_rejects_incomplete_output(broken, message):
    with pytest.raises(toolchain.ToolchainError, match=message):
        toolchain.parse_dpkg_query(broken)


def test_same_package_on_two_architectures_with_one_version_is_accepted():
    assert toolchain.parse_dpkg_query(DPKG + "libass9:i386\t1:0.17.1-1+deb12u1\n") == PINNED


def test_build_records_base_digest_snapshot_and_packages():
    document = toolchain.build(DPKG, base_image=BASE, apt_snapshot=SNAPSHOT)
    assert document == {"schema": "potongin.toolchain/1", "base_image": BASE,
                        "apt_snapshot": SNAPSHOT, "packages": PINNED}


@pytest.mark.parametrize("base", ["node:20-bookworm-slim", "node@sha256:abc",
                                  "node:20@sha256:" + "G" * 64, ""])
def test_the_base_image_must_be_pinned_by_digest(base):
    with pytest.raises(toolchain.ToolchainError, match="digest"):
        toolchain.build(DPKG, base_image=base, apt_snapshot=SNAPSHOT)


def test_the_snapshot_must_be_a_timestamp():
    with pytest.raises(toolchain.ToolchainError, match="apt_snapshot"):
        toolchain.build(DPKG, base_image=BASE, apt_snapshot="latest")
    assert toolchain.build(DPKG, base_image=BASE, apt_snapshot=None)["apt_snapshot"] is None


def test_write_is_canonical_and_read_round_trips(tmp_path):
    path = tmp_path / "toolchain.json"
    first = toolchain.write(path, base_image=BASE, apt_snapshot=SNAPSHOT, dpkg_output=DPKG)
    raw = path.read_bytes()
    assert raw == (json.dumps(first, sort_keys=True, indent=2) + "\n").encode("ascii")
    assert toolchain.read(path) == first
    toolchain.write(path, base_image=BASE, apt_snapshot=SNAPSHOT,
                    dpkg_output="\n".join(reversed(DPKG.splitlines())))
    assert path.read_bytes() == raw  # line order of dpkg-query does not matter


def test_read_rejects_edited_or_foreign_files(tmp_path):
    path = tmp_path / "toolchain.json"
    document = toolchain.write(path, base_image=BASE, apt_snapshot=SNAPSHOT, dpkg_output=DPKG)
    path.write_text(json.dumps(document), encoding="ascii")  # not canonical
    with pytest.raises(toolchain.ToolchainError, match="canonical"):
        toolchain.read(path)
    extra = dict(document, packages=dict(document["packages"], libx264="1"))
    path.write_bytes(toolchain.encode(extra))
    with pytest.raises(toolchain.ToolchainError, match="exactly"):
        toolchain.read(path)
    path.write_text("not json", encoding="ascii")
    with pytest.raises(toolchain.ToolchainError):
        toolchain.read(path)


def test_the_render_key_hashes_the_written_file(tmp_path):
    root = tmp_path / "resources"
    root.mkdir()
    toolchain.write(root / toolchain.FILE_NAME, base_image=BASE, apt_snapshot=SNAPSHOT,
                    dpkg_output=DPKG)
    first = toolchain_sha256(Resources(root))
    toolchain.write(root / toolchain.FILE_NAME, base_image=BASE, apt_snapshot=SNAPSHOT,
                    dpkg_output=DPKG.replace("2.12.1+dfsg-5+deb12u4", "2.12.1+dfsg-5+deb12u5"))
    assert toolchain_sha256(Resources(root)) != first  # a freetype update moves the key


def test_cli_write_and_check(tmp_path):
    if shutil.which("dpkg-query") is None:
        pytest.skip("dpkg-query not available")
    installed = subprocess.run(["dpkg-query", "-W", *toolchain.PACKAGES], capture_output=True,
                               text=True, check=False)
    if installed.returncode != 0:
        pytest.skip("the rendering packages are not all installed through dpkg here")
    path = tmp_path / "toolchain.json"
    env_path = {"PYTHONPATH": str(ROOT / "src")}
    run = [sys.executable, "-m", "ai_clipper.edit_v2.toolchain"]
    written = subprocess.run([*run, "write", str(path), "--base-image", BASE,
                              "--apt-snapshot", SNAPSHOT], capture_output=True, text=True,
                             env=env_path, check=False)
    assert written.returncode == 0, written.stderr
    checked = subprocess.run([*run, "check", str(path)], capture_output=True, text=True,
                             env=env_path, check=False)
    assert checked.returncode == 0, checked.stderr
    assert json.loads(checked.stdout) == toolchain.read(path)["packages"]
    bad = subprocess.run([*run, "write", str(path), "--base-image", "node:20"],
                         capture_output=True, text=True, env=env_path, check=False)
    assert bad.returncode == 1 and "digest" in bad.stderr


def test_the_repository_never_ships_a_toolchain_json():
    """The file describes one image; it is written by the build, never committed."""
    assert not (ROOT / "resources" / "toolchain.json").exists()
    ignored = subprocess.run(["git", "check-ignore", "-q", "resources/toolchain.json"],
                             cwd=ROOT, check=False)
    assert ignored.returncode == 0
