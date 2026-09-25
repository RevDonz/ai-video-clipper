"""``python -m ai_clipper.edit_v2.preview_server``: the persistent preview worker (plan §10.3
contingency; W2 integration for PF-PLAN and PF-AUDIO).

``web/lib/python-cli.mjs`` starts one per app process (``createPythonServer``) with the same
allowlisted environment as every other child (E11). The server imports the preview lane's
modules once and forks one child per connection. A child is exactly one ``preview_cli`` process
as before (the same envelope and the same result, its own session and process group, SIGTERM
cancels it, heavy ops at nice 5) without the interpreter start-up and the imports (≈ 60–100 ms
of every lane request, measured in the image).

Protocol:

* **Start.** The first line of stdin is ``{"op": "serve", "dir": <absolute path>}``: an existing
  directory, not a symlink, owned by this user, mode 0700 (the caller creates it). The server
  listens on ``<dir>/preview.sock`` (0600) and writes ``{"ready": true, "pid": <pid>}`` and a
  newline to stdout. A bad start line or directory exits 2 (usage) before listening.
* **Request.** A connection sends one envelope (at most ``preview_cli.MAX_ENVELOPE_BYTES``; the
  child reads one byte more, which ``handle`` rejects) and shuts down its write side. The child
  first writes ``{"pid": <pid>}`` and a newline (the caller signals that process group to stop
  it), then ``<exit code>``, a newline, the result object and a newline, and closes.
* **Stop.** EOF on stdin (the app went away) or SIGTERM: the socket is removed and the server
  exits 0. Children that are running finish on their own, as spawned CLI processes did.

The server never starts a thread (it forks); children are reaped by the kernel (SIGCHLD
ignored in the server, restored in each child before it runs FFmpeg).
"""

from __future__ import annotations

import importlib
import json
import os
import selectors
import signal
import socket
import stat
import sys
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import preview_cli
from .errors import EXIT_INTERNAL, EXIT_OK, EXIT_USAGE

SOCKET_NAME = "preview.sock"
MAX_START_BYTES = 4096
BACKLOG = 64
READ_TIMEOUT_S = 30.0
# What the lane's ops import lazily (not ``camera``/``seed``: prepare only, and ``camera`` loads
# the vision stack).
PRELOAD = (
    "ai_clipper.edit_v2.audio_graph",
    "ai_clipper.edit_v2.captions",
    "ai_clipper.edit_v2.compile_ffmpeg",
    "ai_clipper.edit_v2.derive",
    "ai_clipper.edit_v2.doc",
    "ai_clipper.edit_v2.envelope",
    "ai_clipper.edit_v2.execute",
    "ai_clipper.edit_v2.glyphs",
    "ai_clipper.edit_v2.loudness",
    "ai_clipper.edit_v2.plan",
    "ai_clipper.edit_v2.plates",
    "ai_clipper.edit_v2.source_info",
    "ai_clipper.edit_v2.store",
)


class _Stop(Exception):
    """SIGTERM in the server: leave the loop and clean up."""


def _start_directory(line: bytes) -> Path | None:
    """The socket directory named by the start line, when it is private; else None."""
    try:
        start = json.loads(line)
    except (ValueError, UnicodeDecodeError, RecursionError):
        return None
    if not (isinstance(start, dict) and set(start) == {"op", "dir"} and start["op"] == "serve"
            and isinstance(start["dir"], str) and os.path.isabs(start["dir"])
            and len(start["dir"]) < 200):
        return None
    directory = Path(start["dir"])
    try:
        info = directory.lstat()
    except OSError:
        return None
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077):
        return None
    return directory


def _preload() -> None:
    for name in PRELOAD:
        importlib.import_module(name)
    preview_cli._resources()


def _answer(conn: socket.socket) -> None:
    """One request in a forked child: the pid line, the envelope, ``handle``, the result."""
    cancel = threading.Event()
    signal.signal(signal.SIGTERM, lambda _signum, _frame: cancel.set())
    conn.sendall(json.dumps({"pid": os.getpid()}).encode() + b"\n")
    conn.settimeout(READ_TIMEOUT_S)
    raw = bytearray()
    while len(raw) <= preview_cli.MAX_ENVELOPE_BYTES:
        chunk = conn.recv(1 << 16)
        if not chunk:
            break
        raw += chunk
    code, payload = preview_cli.handle(bytes(raw), jobs_root=os.environ.get("JOBS_ROOT"),
                                       cancel=cancel, renice=True)
    conn.sendall(f"{code}\n".encode() + json.dumps(payload, ensure_ascii=False,
                                                  separators=(",", ":")).encode("utf-8")
                 + b"\n")
    conn.close()


def _child(conn: socket.socket, listener: socket.socket, selector: Any) -> None:
    """Never returns: the forked child answers ``conn`` and exits."""
    status = EXIT_INTERNAL
    try:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)  # subprocess reaps FFmpeg itself
        selector.close()
        listener.close()
        os.setsid()  # its own session and process group, as a detached spawn
        devnull = os.open(os.devnull, os.O_RDWR)
        os.dup2(devnull, 0)
        os.dup2(devnull, 1)
        os.close(devnull)
        _answer(conn)
        status = EXIT_OK
    except BaseException:  # noqa: BLE001 - the caller sees a closed connection, no result
        status = EXIT_INTERNAL
    finally:
        os._exit(status)


def serve(directory: Path, *, ready_stream: Any) -> int:
    """Listen on ``directory/preview.sock`` until stdin closes or SIGTERM; returns 0."""
    _preload()
    path = directory / SOCKET_NAME
    try:
        path.unlink()  # a socket a previous server left behind
    except FileNotFoundError:
        pass
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    selector = selectors.DefaultSelector()

    def stop(_signum: int, _frame: Any) -> None:
        raise _Stop()

    previous = signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGCHLD, signal.SIG_IGN)  # the kernel reaps the children
    try:
        mask = os.umask(0o177)
        try:
            listener.bind(str(path))
        finally:
            os.umask(mask)
        listener.listen(BACKLOG)
        selector.register(listener, selectors.EVENT_READ, "accept")
        selector.register(0, selectors.EVENT_READ, "stdin")
        ready_stream.write(json.dumps({"ready": True, "pid": os.getpid()}).encode() + b"\n")
        ready_stream.flush()
        while True:
            for key, _events in selector.select():
                if key.data == "stdin":
                    if not os.read(0, 4096):
                        return EXIT_OK
                    continue
                try:
                    conn, _address = listener.accept()
                except (BlockingIOError, InterruptedError, ConnectionAbortedError):
                    continue
                try:
                    pid = os.fork()
                except OSError:
                    conn.close()  # no pid line: the caller runs the CLI as a process instead
                    continue
                if pid == 0:
                    _child(conn, listener, selector)
                conn.close()
    except _Stop:
        return EXIT_OK
    finally:
        signal.signal(signal.SIGTERM, previous)
        selector.close()
        listener.close()
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def main(argv: Sequence[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments:
        return EXIT_USAGE
    line = sys.stdin.buffer.readline(MAX_START_BYTES + 1)
    directory = _start_directory(line) if len(line) <= MAX_START_BYTES else None
    if directory is None:
        return EXIT_USAGE
    return serve(directory, ready_stream=sys.stdout.buffer)


__all__ = ["BACKLOG", "PRELOAD", "SOCKET_NAME", "main", "serve"]


if __name__ == "__main__":
    raise SystemExit(main())
