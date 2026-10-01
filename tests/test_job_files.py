"""Bounded no-follow reads and durable writes inside a job directory (``ai_clipper.job_files``).

These helpers were the storage core of the retired candidate editor's ``edit_manifest.py``; the
clip document store and the render queue keep using them, so their rules are tested here.
"""

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from ai_clipper import job_files
from ai_clipper.job_files import (
    JobFileError,
    JobFileInvalid,
    JobFileNotFound,
    atomic_write,
    ensure_directory,
    fsync_directory,
    read_regular,
    validate_analysis_dir,
)


def test_errors_share_one_base():
    assert issubclass(JobFileInvalid, JobFileError)
    assert issubclass(JobFileNotFound, JobFileError)
    assert not issubclass(JobFileNotFound, JobFileInvalid)


def test_read_regular_returns_the_bytes_up_to_the_limit(tmp_path):
    target = tmp_path / "file.json"
    target.write_bytes(b"x" * 10)
    assert read_regular(target, 10) == b"x" * 10
    with pytest.raises(JobFileInvalid):
        read_regular(target, 9)


def test_read_regular_reports_a_missing_file_as_asked(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_regular(tmp_path / "absent.json", 10)
    with pytest.raises(JobFileNotFound):
        read_regular(tmp_path / "absent.json", 10, missing=True)


def test_read_regular_never_follows_a_symlink_and_never_hangs_on_a_fifo(tmp_path):
    outside = tmp_path / "outside.json"
    outside.write_text("{}")
    link = tmp_path / "link.json"
    link.symlink_to(outside)
    with pytest.raises(JobFileInvalid):
        read_regular(link, 10)
    fifo = tmp_path / "fifo.json"
    os.mkfifo(fifo)
    with pytest.raises(JobFileInvalid):
        read_regular(fifo, 10)
    with pytest.raises(JobFileInvalid):
        read_regular(tmp_path, 10)  # a directory
    with pytest.raises(JobFileInvalid):
        read_regular(outside / "below.json", 10)  # a file used as a directory


def test_validate_analysis_dir_accepts_only_a_real_directory(tmp_path):
    analysis = tmp_path / "job" / "analysis"
    with pytest.raises(JobFileNotFound):
        validate_analysis_dir(analysis)
    analysis.mkdir(parents=True)
    validate_analysis_dir(analysis)
    linked = tmp_path / "linked"
    linked.symlink_to(analysis, target_is_directory=True)
    with pytest.raises(JobFileInvalid):
        validate_analysis_dir(linked)
    (tmp_path / "job-link").symlink_to(tmp_path / "job", target_is_directory=True)
    with pytest.raises(JobFileInvalid):
        validate_analysis_dir(tmp_path / "job-link" / "analysis")  # reached through a symlink
    plain = tmp_path / "plain"
    plain.write_text("")
    with pytest.raises(JobFileInvalid):
        validate_analysis_dir(plain)


def test_ensure_directory_creates_0700_and_fsyncs_the_parent_after_mkdir(tmp_path, monkeypatch):
    synced = []
    real = job_files.fsync_directory

    def recording(path):
        synced.append(Path(path))
        real(path)

    monkeypatch.setattr(job_files, "fsync_directory", recording)
    directory = tmp_path / "render-requests"
    ensure_directory(directory)
    assert directory.is_dir() and stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert synced == [tmp_path]
    ensure_directory(directory)  # an existing directory is accepted
    assert synced == [tmp_path, tmp_path]


def test_ensure_directory_retries_the_parent_fsync_after_a_failure(tmp_path, monkeypatch):
    calls = []

    def fail_once(path):
        calls.append(Path(path))
        if len(calls) == 1:
            raise OSError("injected directory fsync failure")

    monkeypatch.setattr(job_files, "fsync_directory", fail_once)
    directory = tmp_path / "edits"
    with pytest.raises(OSError, match="injected directory fsync failure"):
        ensure_directory(directory)
    assert directory.is_dir()
    ensure_directory(directory)
    assert calls == [tmp_path, tmp_path]


def test_ensure_directory_refuses_a_symlink_or_a_file(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "linked").symlink_to(outside, target_is_directory=True)
    with pytest.raises(JobFileInvalid):
        ensure_directory(tmp_path / "linked")
    (tmp_path / "file").write_text("")
    with pytest.raises(JobFileInvalid):
        ensure_directory(tmp_path / "file")


def test_atomic_write_publishes_a_private_file_and_replaces_without_following(tmp_path):
    target = tmp_path / "request.json"
    atomic_write(tmp_path, target, b'{"a":1}')
    assert target.read_bytes() == b'{"a":1}'
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    outside = tmp_path / "outside.json"
    outside.write_text("keep")
    target.unlink()
    target.symlink_to(outside)
    atomic_write(tmp_path, target, b'{"a":2}')
    assert not target.is_symlink() and target.read_bytes() == b'{"a":2}'
    assert outside.read_text() == "keep"
    assert list(tmp_path.glob(".*.tmp")) == []


def test_atomic_write_failure_keeps_the_current_file_and_cleans_its_temporary(tmp_path,
                                                                              monkeypatch):
    target = tmp_path / "request.json"
    atomic_write(tmp_path, target, b"first")

    def fail_replace(_source, _target):
        raise OSError("injected replace failure")

    monkeypatch.setattr(job_files.os, "replace", fail_replace)
    with pytest.raises(OSError, match="injected replace failure"):
        atomic_write(tmp_path, target, b"second")
    assert target.read_bytes() == b"first"
    assert list(tmp_path.glob(".*.tmp")) == []


def test_fsync_directory_refuses_a_symlinked_directory(tmp_path):
    fsync_directory(tmp_path)
    (tmp_path / "linked").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(OSError):
        fsync_directory(tmp_path / "linked")


def test_importing_the_helpers_pulls_in_no_other_ai_clipper_module():
    code = ("import sys, ai_clipper.job_files; "
            "print(sorted(m for m in sys.modules if m.startswith('ai_clipper.')))")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                            check=True, timeout=60)
    assert result.stdout.strip() == "['ai_clipper.job_files']"
