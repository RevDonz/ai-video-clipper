"""Bounded no-follow reads and durable writes of small files inside a job directory.

Used by the clip document store (``edit_v2.store``, ``edit_v2.api``) and the render queue. The
rules are those of the retired candidate editor's store, unchanged: files are regular and never
reached through a final symlink, reads are bounded, writes go temp → fsync → rename → directory
fsync with 0600 files in 0700 directories. Stdlib only, so importing it costs nothing (PF-PLAN).
"""

from __future__ import annotations

import errno
import os
import stat
import uuid
from pathlib import Path


class JobFileError(Exception):
    """Base error of a job file or directory."""


class JobFileInvalid(JobFileError):
    """A symlink, a special file, a file over its limit or an untrusted directory."""


class JobFileNotFound(JobFileError):
    """The file (with ``missing=True``) or the directory does not exist."""


def read_regular(path: Path, limit: int, *, missing: bool = False) -> bytes:
    """The bytes of a regular file of at most ``limit`` bytes, opened without following a final
    symlink and without blocking on a FIFO. A missing file raises ``FileNotFoundError``, or
    ``JobFileNotFound`` when ``missing`` is true."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        if missing:
            raise JobFileNotFound() from None
        raise
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise JobFileInvalid() from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise JobFileInvalid()
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise JobFileInvalid()
        return b"".join(chunks)
    finally:
        os.close(fd)


def fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_analysis_dir(analysis_dir: Path) -> None:
    """``analysis_dir`` is a real directory reached without any symlink."""
    try:
        info = analysis_dir.lstat()
    except FileNotFoundError:
        raise JobFileNotFound() from None
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or analysis_dir.resolve() != analysis_dir.absolute()
    ):
        raise JobFileInvalid("analysis directory is not trusted")


def ensure_directory(path: Path) -> None:
    """Create a 0700 directory or accept an existing real one; the parent is fsynced each time,
    so a retry after a failed fsync makes the directory durable."""
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    try:
        info = path.lstat()
    except OSError as error:
        raise JobFileInvalid() from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise JobFileInvalid("storage directory is invalid")
    fsync_directory(path.parent)


def atomic_write(directory: Path, target: Path, raw: bytes) -> None:
    """Replace ``target`` (in ``directory``) with ``raw``: a 0600 temporary file, fsync, rename,
    directory fsync. A failure leaves the previous file and no temporary behind."""
    temp = directory / f".{target.name}.{uuid.uuid4()}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        written = 0
        while written < len(raw):
            written += os.write(fd, raw[written:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temp, target)
        fsync_directory(directory)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp.unlink()
        except FileNotFoundError:
            pass
