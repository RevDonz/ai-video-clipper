"""Run an ``FfmpegJob``: fd inputs, private temp dir, timeout, ``-progress`` liveness, cancel.

Plan §5.1, §5.2 R8 and §4.6:

* **Inputs** are opened here (``O_NOFOLLOW``, regular files only; assets must resolve inside
  ``expected["assets_root"]``) and passed to FFmpeg as ``/proc/self/fd/N``; FFmpeg never sees a
  path of the job. Sidecars (``captions.ass``, envelopes …) and ``filter_graph.txt`` are written
  with constant names into a private 0700 directory, which is FFmpeg's working directory and is
  removed afterwards; ``fonts`` there links to the pinned fonts directory.
* **Environment**: an allowlist (``PATH``, locale, ``HOME``/``TMPDIR`` = the private directory,
  ``FONTCONFIG_FILE`` when the job declares it). Nothing of the parent's environment leaks
  (E11). A declared fonts directory or ``fonts.conf`` that is missing is ``render_failed``
  before FFmpeg starts: it would otherwise draw the text with the system's fonts (G-FAIL).
* **Limits**: ``RLIMIT_AS`` 3 GiB, set before FFmpeg runs (util-linux ``prlimit`` execs it);
  a wall-clock
  ``timeout_s``; the ``-progress`` stream must advance (frame, time or size) within
  ``expected["stall_s"]`` (default 20 s), else ``render_stalled``; ``cancel`` kills the process
  group within the 50 ms poll.
* **Outputs**: ``fd`` (FFmpeg writes ``@out`` = ``/proc/self/fd/<output_fd>``), ``null``,
  ``cells`` (plate cells copied into the directory ``output_fd``, or returned when it is None)
  and ``png`` (an optional fixed post step, then ancillary chunks stripped).

Failures raise ``RenderFailed`` (``render_failed``, ``render_timeout``, ``render_stalled``) or
``Cancelled``; the bounded stderr is attached as ``stderr_tail`` and never put in the message.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import errors
from .compile_ffmpeg import FONTS_DIR, GRAPH_FILE, OUTPUT_TOKEN, PROGRESS_TOKEN, FfmpegJob
from .derive import strip_png

STALL_S = 20.0
RLIMIT_AS_BYTES = 3 << 30
STDERR_HEAD = 16 * 1024
STDERR_TAIL = 48 * 1024
POLL_S = 0.05
_INPUT = re.compile(r"@in:(\d+)")
_SIDECAR = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_RESERVED = frozenset({GRAPH_FILE, FONTS_DIR})
_OUTPUTS = ("fd", "null", "cells", "png")


@dataclass(frozen=True)
class ExecResult:
    """Outcome of one FFmpeg run."""

    returncode: int
    elapsed_s: float
    frames: int  # output frames reported by -progress (last value)
    out_time_us: int  # output time reported by -progress, -1 when unknown
    stderr: str  # the first 16 KiB and the last 48 KiB of FFmpeg's stderr
    output: bytes | None = None  # "png": the stripped PNG
    files: tuple[str, ...] = ()  # "cells": names written into the output directory
    outputs: Mapping[str, bytes] = field(default_factory=dict)  # "cells" without a directory


class _Stderr:
    def __init__(self) -> None:
        self.head = bytearray()
        self.tail = bytearray()
        self.dropped = False

    def feed(self, chunk: bytes) -> None:
        room = STDERR_HEAD - len(self.head)
        if room > 0:
            self.head += chunk[:room]
            chunk = chunk[room:]
        if chunk:
            self.tail += chunk
            if len(self.tail) > STDERR_TAIL:
                del self.tail[: len(self.tail) - STDERR_TAIL]
                self.dropped = True

    def text(self) -> str:
        gap = b"\n[...]\n" if self.dropped else b""
        return bytes(self.head + gap + self.tail).decode("utf-8", "replace")


class _Progress:
    """Parses ``-progress`` key=value blocks; liveness = any change of frame, time or size."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.frame = 0
        self.out_time_us = -1
        self.changed_at = time.monotonic()
        self._state: tuple[int, int, int] = (0, -1, -1)
        self._pending: dict[str, int] = {}

    def line(self, text: str) -> None:
        key, _, value = text.strip().partition("=")
        if key in ("frame", "out_time_us", "total_size"):
            try:
                self._pending[key] = int(value)
            except ValueError:
                self._pending[key] = -1
        elif key == "progress":
            state = (self._pending.get("frame", self._state[0]),
                     self._pending.get("out_time_us", self._state[1]),
                     self._pending.get("total_size", self._state[2]))
            with self.lock:
                if state != self._state:
                    self._state = state
                    self.frame = max(state[0], 0)
                    self.out_time_us = state[1]
                    self.changed_at = time.monotonic()


def _drain(stream, sink: Callable[[bytes], None]) -> None:
    try:
        while True:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(65536)
            if not chunk:
                return
            sink(chunk)
    except (OSError, ValueError):
        return


def _drain_progress(fd: int, progress: _Progress) -> None:
    buffer = b""
    try:
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                return
            buffer += chunk
            *lines, buffer = buffer.split(b"\n")
            for line in lines:
                progress.line(line.decode("ascii", "replace"))
    except OSError:
        return
    finally:
        os.close(fd)


def _kill_group(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()


def _env(expected: Mapping[str, Any], work: Path) -> dict[str, str]:
    env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "HOME": str(work), "TMPDIR": str(work)}
    fontconfig = expected.get("fontconfig_file")
    if fontconfig:  # checked by run(): a declared file exists
        env["FONTCONFIG_FILE"] = str(fontconfig)
    return env


def _limited(argv: Sequence[str], env: Mapping[str, str]) -> list[str]:
    """``argv`` under util-linux ``prlimit``, which sets RLIMIT_AS on itself and then execs the
    command (same pid, same process group): FFmpeg starts with the limit, without Python code
    between fork and exec in a threaded worker (``preexec_fn``) and without an unlimited
    window (``prlimit`` on the pid after the start)."""
    tool = shutil.which("prlimit", path=env.get("PATH"))
    if tool is None:
        raise _fail("render_failed", ref="prlimit")
    return [tool, f"--as={RLIMIT_AS_BYTES}:{RLIMIT_AS_BYTES}", "--", *argv]


def _fail(code: str, stderr: _Stderr | None = None, ref: str | None = None) -> errors.RenderFailed:
    error = errors.RenderFailed(code, ref=ref)
    error.stderr_tail = "" if stderr is None else stderr.text()
    return error


def _supervise(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    pass_fds: Sequence[int],
    progress_pipe: tuple[int, int] | None,
    deadline: float,
    stall_s: float,
    on_progress: Callable[[int], None] | None,
    cancel: threading.Event | None,
) -> tuple[int, _Progress, _Stderr]:
    """Start ``argv`` in its own session and watch it; returns (returncode, progress, stderr)
    or raises ``RenderFailed``/``Cancelled`` after killing the process group.

    ``progress_pipe`` is ``(read, write)``: the write end is inherited by FFmpeg and closed here
    right after the start; the read end is always closed (by its reader thread)."""
    progress = _Progress()
    stderr = _Stderr()
    read_fd, write_fd = progress_pipe if progress_pipe is not None else (None, None)
    process = None
    try:
        if cancel is not None and cancel.is_set():
            raise errors.Cancelled("cancelled")
        try:
            process = subprocess.Popen(
                _limited(argv, env), cwd=cwd, env=dict(env), stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                pass_fds=tuple(pass_fds) + ((write_fd,) if write_fd is not None else ()),
                start_new_session=True, close_fds=True)
        except (OSError, subprocess.SubprocessError) as exc:
            raise _fail("render_failed") from exc
    finally:
        if write_fd is not None:
            os.close(write_fd)
        if read_fd is not None and process is None:
            os.close(read_fd)
    readers =[threading.Thread(target=_drain, args=(process.stderr, stderr.feed), daemon=True)]
    if read_fd is not None:
        readers.append(threading.Thread(target=_drain_progress, args=(read_fd, progress),
                                        daemon=True))
    for reader in readers:
        reader.start()
    reason = None
    reported = -1
    try:
        while process.poll() is None:
            now = time.monotonic()
            if cancel is not None and cancel.is_set():
                reason = "cancelled"
            elif now >= deadline:
                reason = "render_timeout"
            elif read_fd is not None and now - progress.changed_at > stall_s:
                reason = "render_stalled"
            if reason is not None:
                _kill_group(process)
                break
            if on_progress is not None and progress.frame != reported:
                reported = progress.frame
                on_progress(reported)
            if cancel is not None:
                cancel.wait(POLL_S)
            else:
                time.sleep(POLL_S)
    except BaseException:
        if process.poll() is None:
            _kill_group(process)
        raise
    finally:
        for reader in readers:
            reader.join(timeout=5)
        if process.stderr is not None:
            process.stderr.close()
    if reason == "cancelled" or (process.returncode and cancel is not None and cancel.is_set()):
        error = errors.Cancelled("cancelled")
        error.stderr_tail = stderr.text()
        raise error
    if reason is not None:
        raise _fail(reason, stderr)
    if on_progress is not None and progress.frame != reported:
        on_progress(progress.frame)
    if process.returncode != 0:
        raise _fail("render_failed", stderr)
    return process.returncode, progress, stderr


def _open_input(path: str) -> int:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0))
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise OSError("input is not a regular file")
    return fd


def _inside(path: str, root: str) -> bool:
    real_root = os.path.realpath(root)
    return os.path.realpath(path).startswith(real_root + os.sep)


def _write_new(directory: Path, name: str, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(directory / name, flags, 0o600)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def _publish_cell(directory_fd: int, name: str, source: Path) -> None:
    temporary = f".{name}.{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o600, dir_fd=directory_fd)
    try:
        with open(source, "rb") as handle:
            while chunk := handle.read(1 << 20):
                view = memoryview(chunk)
                while view:
                    view = view[os.write(fd, view):]
        os.fsync(fd)
    except BaseException:
        os.close(fd)
        os.unlink(temporary, dir_fd=directory_fd)
        raise
    os.close(fd)
    os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)


def _write_output(fd: int, data: bytes) -> None:
    os.lseek(fd, 0, os.SEEK_SET)
    os.ftruncate(fd, 0)
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]


def run(
    job: FfmpegJob,
    *,
    output_fd: int | None,
    timeout_s: float,
    on_progress: Callable[[int], None] | None = None,
    cancel: threading.Event | None = None,
) -> ExecResult:
    """Run ``job`` writing to ``output_fd``; ``on_progress`` receives output frames done.

    Raises ``RenderFailed`` (``render_failed``, ``render_timeout``, ``render_stalled``) or
    ``Cancelled``; ``ValueError`` for a malformed job (unknown token, bad sidecar name).
    """
    started = time.monotonic()
    deadline = started + timeout_s
    expected = job.expected
    kind = expected.get("output", "fd")
    if kind not in _OUTPUTS:
        raise ValueError(f"unknown output kind: {kind}")
    for name in job.sidecars:
        if not _SIDECAR.fullmatch(name) or name in _RESERVED:
            raise ValueError(f"invalid sidecar name: {name!r}")
    for token in job.argv:
        match = _INPUT.fullmatch(token)
        if match is not None and int(match.group(1)) >= len(job.inputs):
            raise ValueError(f"argv refers to a missing input: {token}")
        if token == OUTPUT_TOKEN and output_fd is None:
            raise ValueError("this job writes to output_fd")
    stall_s = float(expected.get("stall_s", STALL_S))
    work = Path(tempfile.mkdtemp(prefix="edit-v2-"))
    fds: list[int] = []
    try:
        os.chmod(work, 0o700)
        for name, data in job.sidecars.items():
            _write_new(work, name, bytes(data))
        _write_new(work, GRAPH_FILE, job.filter_script.encode("utf-8"))
        # The pinned fonts and the fontconfig lockdown (R6): a job that declares them never
        # runs without them, since FFmpeg would draw the text with the system's fonts (G-FAIL).
        fonts = expected.get("fonts_dir")
        if fonts:
            if not os.path.isdir(fonts):
                raise _fail("render_failed", ref="fonts")
            os.symlink(fonts, work / FONTS_DIR)
        fontconfig = expected.get("fontconfig_file")
        if fontconfig and not os.path.isfile(fontconfig):
            raise _fail("render_failed", ref="fontconfig")
        paths = expected.get("paths", {})
        for spec in job.inputs:
            if spec.kind == "sidecar":
                if spec.name not in job.sidecars:
                    raise ValueError(f"input sidecar {spec.name!r} is not in the job")
                path = str(work / spec.name)
            elif spec.kind in ("source", "asset") and spec.name in paths:
                path = str(paths[spec.name])
                if spec.kind == "asset" and not _inside(path, str(expected.get("assets_root"))):
                    raise _fail("render_failed", ref=spec.name)
            else:
                raise ValueError(f"cannot resolve input {spec.kind}:{spec.name}")
            try:
                fds.append(_open_input(path))
            except OSError as exc:
                raise _fail("render_failed", ref=spec.name) from exc
        pass_fds = list(fds)
        pipe = None
        if PROGRESS_TOKEN in job.argv:
            pipe = os.pipe()
        if output_fd is not None and OUTPUT_TOKEN in job.argv:
            pass_fds.append(output_fd)
        argv = []
        for token in job.argv:
            match = _INPUT.fullmatch(token)
            if match is not None:
                argv.append(f"/proc/self/fd/{fds[int(match.group(1))]}")
            elif token == OUTPUT_TOKEN:
                argv.append(f"/proc/self/fd/{output_fd}")
            elif token == PROGRESS_TOKEN:
                assert pipe is not None
                argv.append(f"pipe:{pipe[1]}")
            else:
                argv.append(token)
        env = _env(expected, work)
        returncode, progress, stderr = _supervise(
            argv, cwd=work, env=env, pass_fds=pass_fds, progress_pipe=pipe, deadline=deadline,
            stall_s=stall_s, on_progress=on_progress, cancel=cancel)
        result = {"returncode": returncode, "frames": progress.frame,
                  "out_time_us": progress.out_time_us, "stderr": stderr.text()}
        if kind == "fd" and output_fd is not None and os.fstat(output_fd).st_size == 0:
            raise _fail("render_failed", stderr)  # FFmpeg can exit 0 without writing
        if kind == "cells":
            names = [f"c{int(k):07d}.mp4" for k in sorted(expected.get("cells", {}), key=int)]
            missing = [name for name in names if not (work / name).is_file()]
            if missing:
                raise _fail("render_failed", stderr)
            if output_fd is not None:
                for name in names:
                    _publish_cell(output_fd, name, work / name)
                result["files"] = tuple(names)
            else:
                result["outputs"] = {name: (work / name).read_bytes() for name in names}
        elif kind == "png":
            post = expected.get("post")
            if post:
                _supervise(list(post), cwd=work, env=env, pass_fds=(), progress_pipe=None,
                           deadline=deadline, stall_s=stall_s, on_progress=None, cancel=cancel)
            try:
                png = strip_png((work / expected["result"]).read_bytes())
            except (OSError, ValueError, KeyError) as exc:
                raise _fail("render_failed", stderr) from exc
            if output_fd is not None:
                _write_output(output_fd, png)
            result["output"] = png
        return ExecResult(elapsed_s=time.monotonic() - started, **result)
    finally:
        for fd in fds:
            os.close(fd)
        shutil.rmtree(work, ignore_errors=True)


__all__ = ["RLIMIT_AS_BYTES", "STALL_S", "ExecResult", "run"]
