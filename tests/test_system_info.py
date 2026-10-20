"""``python -m ai_clipper.system_info``: the yt-dlp version for Pengaturan's "Tentang sistem".

The version comes from the installed package's metadata (no network, no yt-dlp process). A
missing or odd version is ``null``, never a crash; a malformed envelope is exit 2.
"""

from __future__ import annotations

import io
import json
import subprocess
import sys
from importlib import metadata
from pathlib import Path

import pytest

from ai_clipper import system_info


def _run(monkeypatch, capsys, stdin: bytes) -> tuple[int, dict]:
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin)))
    code = system_info.main()
    out = capsys.readouterr().out
    assert out.endswith("\n") and out.count("\n") == 1, "one JSON line on stdout"
    return code, json.loads(out)


def test_package_version_reads_installed_metadata():
    assert system_info.package_version("pytest") == metadata.version("pytest")


def test_a_missing_package_is_none():
    assert system_info.package_version("potongin-no-such-package") is None


@pytest.mark.parametrize("value", ["", "1.0 beta", "1.0\nX", "x" * 41, "../../etc", None, 3])
def test_an_odd_version_string_is_none(monkeypatch, value):
    monkeypatch.setattr(system_info.metadata, "version", lambda _name: value)
    assert system_info.package_version("yt-dlp") is None


def test_broken_metadata_is_none(monkeypatch):
    def broken(_name):
        raise OSError("unreadable METADATA")

    monkeypatch.setattr(system_info.metadata, "version", broken)
    assert system_info.package_version("yt-dlp") is None


def test_versions_names_yt_dlp(monkeypatch):
    seen = []

    def version(name):
        seen.append(name)
        return "2026.08.19"

    monkeypatch.setattr(system_info.metadata, "version", version)
    assert system_info.versions() == {"yt_dlp": "2026.08.19"}
    assert seen == ["yt-dlp"]


def test_main_answers_the_versions_op(monkeypatch, capsys):
    monkeypatch.setattr(system_info.metadata, "version", lambda _name: "2026.8.19")
    assert _run(monkeypatch, capsys, b'{"op": "versions"}') == (0, {"yt_dlp": "2026.8.19"})


def test_main_without_yt_dlp_answers_null(monkeypatch, capsys):
    def missing(name):
        raise metadata.PackageNotFoundError(name)

    monkeypatch.setattr(system_info.metadata, "version", missing)
    assert _run(monkeypatch, capsys, b'{"op": "versions"}') == (0, {"yt_dlp": None})


@pytest.mark.parametrize("stdin", [
    b"",
    b"not json",
    b"[]",
    b'{"op": "other"}',
    b'{"op": "versions", "extra": 1}',
    b'{"op": "versions", "op": "versions"}',
    b"\xff\xfe",
    b'{"op": "versions"}' + b" " * 2048,
])
def test_a_malformed_envelope_is_exit_2(monkeypatch, capsys, stdin):
    code, answer = _run(monkeypatch, capsys, stdin)
    assert code == 2
    assert answer == {"error": {"code": "internal_error", "path": None, "ref": None,
                                "messageId": "edit.internal_error"}}


def test_the_module_runs_as_a_cli():
    result = subprocess.run([sys.executable, "-m", "ai_clipper.system_info"],
                            input=b'{"op": "versions"}', capture_output=True, timeout=60,
                            check=False)
    assert result.returncode == 0
    assert result.stderr == b""
    answer = json.loads(result.stdout)
    assert set(answer) == {"yt_dlp"}
    assert answer["yt_dlp"] is None or isinstance(answer["yt_dlp"], str)


def test_the_module_stays_stdlib_only():
    source = Path(system_info.__file__).read_text(encoding="utf-8")
    imports = [line.split()[1] for line in source.splitlines()
               if line.startswith(("import ", "from "))]
    allowed = {"__future__", "json", "re", "sys", "importlib"}
    assert {name.split(".")[0] for name in imports} <= allowed, imports
