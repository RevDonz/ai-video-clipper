"""``python -m ai_clipper.edit_v2.preview_server``: the persistent preview worker of plan §10.3
(W2 integration; PF-PLAN, PF-AUDIO).

A fork server: it imports the preview lane's modules once and forks one child per connection
on a Unix socket in a private directory. Each child is one ``preview_cli`` run (the same
envelope and result, its own session, SIGTERM → cancelled, nice for heavy ops) without the
interpreter start-up and imports.
"""

from __future__ import annotations

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from support import edit_v2_fixtures as fixtures
from test_edit_v2_plates import synthetic_job
from test_edit_v2_preview_cli import _is_child_ffmpeg, _state
from test_edit_v2_store import make_clip

from ai_clipper.edit_v2 import plates, preview_cli, preview_server, store

ROOT = Path(__file__).resolve().parents[1]


def body(doc: dict) -> bytes:
    from ai_clipper.edit_v2.doc import canonical_bytes

    return b'{"doc":' + canonical_bytes(doc) + b"}"


class Server:
    def __init__(self, jobs_root: Path, directory: Path) -> None:
        env = {"PATH": os.environ.get("PATH", ""), "JOBS_ROOT": str(jobs_root),
               "PYTHONPATH": str(ROOT / "src"), "HOME": str(directory)}
        self.directory = directory
        self.process = subprocess.Popen(
            [sys.executable, "-m", "ai_clipper.edit_v2.preview_server"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        self.process.stdin.write(json.dumps({"op": "serve", "dir": str(directory)}).encode()
                                 + b"\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        self.ready = json.loads(line) if line else None

    @property
    def socket_path(self) -> str:
        return str(self.directory / preview_server.SOCKET_NAME)

    def request(self, envelope: bytes, *, pid_seen=None) -> tuple[int, int, dict]:
        """(child pid, exit code, result object) of one envelope."""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(120)
            conn.connect(self.socket_path)
            conn.sendall(envelope)
            conn.shutdown(socket.SHUT_WR)
            data = b""
            while b"\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                data += chunk
            head, _, rest = data.partition(b"\n")
            pid = json.loads(head)["pid"]
            if pid_seen is not None:
                pid_seen(pid)
            while True:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                rest += chunk
        code_line, _, payload = rest.partition(b"\n")
        return pid, int(code_line), json.loads(payload)

    def close(self) -> int:
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                return self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        return self.process.wait()


@pytest.fixture
def private_dir(tmp_path) -> Path:
    directory = tmp_path / "sock"
    directory.mkdir(mode=0o700)
    return directory


@pytest.fixture
def c30(tmp_path):
    context = fixtures.load_context("c30")
    clip = make_clip(tmp_path / "jobs", context)
    return {"root": tmp_path / "jobs", "clip": clip, "seed": context.seed,
            "jobId": context.seed["base"]["job_id"], "clipId": context.seed["clip_id"]}


def plan_envelope(case: dict) -> bytes:
    return json.dumps({"op": "plan", "jobId": case["jobId"], "clipId": case["clipId"],
                       "requestRaw": base64.b64encode(body(case["seed"])).decode()}).encode()


def test_a_child_answers_exactly_what_the_cli_answers(c30, private_dir):
    server = Server(c30["root"], private_dir)
    try:
        assert server.ready == {"ready": True, "pid": server.process.pid}
        assert (private_dir / preview_server.SOCKET_NAME).is_socket()
        envelope = plan_envelope(c30)
        pid, code, result = server.request(envelope)
        assert pid != server.process.pid
        expected_code, expected = preview_cli.handle(envelope, jobs_root=c30["root"])
        assert (code, result) == (expected_code, expected) and code == 0
        pid2, code, result = server.request(b'{"op": "plan"}')  # malformed: usage, as the CLI
        assert pid2 != pid
        assert (code, result) == preview_cli.handle(b'{"op": "plan"}', jobs_root=c30["root"])
        assert code == 2
    finally:
        assert server.close() == 0
    assert not (private_dir / preview_server.SOCKET_NAME).exists()


def test_concurrent_requests_each_get_their_own_child(c30, private_dir):
    server = Server(c30["root"], private_dir)
    results = []
    try:
        threads = [threading.Thread(target=lambda: results.append(
            server.request(plan_envelope(c30)))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=120)
    finally:
        server.close()
    assert len(results) == 4
    assert len({pid for pid, _code, _result in results}) == 4
    assert all(code == 0 for _pid, code, _result in results)
    assert len({json.dumps(result, sort_keys=True) for _pid, _code, result in results}) == 1


def test_the_socket_directory_must_be_private(c30, tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir(mode=0o755)
    shared.chmod(0o755)
    server = Server(c30["root"], shared)
    assert server.ready is None
    assert server.process.wait(timeout=10) == 2
    assert not (shared / preview_server.SOCKET_NAME).exists()
    link = tmp_path / "link"
    private = tmp_path / "private"
    private.mkdir(mode=0o700)
    link.symlink_to(private)
    server = Server(c30["root"], link)
    assert server.ready is None and server.process.wait(timeout=10) == 2


def test_the_server_exits_when_its_parent_closes_stdin(c30, private_dir):
    server = Server(c30["root"], private_dir)
    server.process.stdin.close()
    assert server.process.wait(timeout=10) == 0
    assert not (private_dir / preview_server.SOCKET_NAME).exists()


@pytest.fixture(scope="module")
def job(tmp_path_factory, request):
    request.getfixturevalue("edit_v2_libass")
    return synthetic_job(tmp_path_factory.mktemp("server-job"))


def test_a_child_leads_its_own_group_and_sigterm_cancels_it(job, tmp_path):
    """The lane stops a child as it stopped a CLI process: SIGTERM to the child's group; the
    child kills FFmpeg's session, answers ``cancelled`` (12) and publishes nothing."""
    directory = tmp_path / "sock"
    directory.mkdir(mode=0o700)
    clip = job["clips"][0]
    case = {"root": job["jobs_root"], "jobId": job["job_id"], "clipId": clip.name,
            "seed": store.seed(clip)[0]}
    server = Server(job["jobs_root"], directory)
    try:
        _pid, code, planned = server.request(plan_envelope(case))
        assert code == 0
        lane = planned["lane"]
        wanted = [k for k in lane["cells"] if not (
            clip / "preview" / "plates" / plates.cell_name(lane["plateKey"], k)).exists()][:4]
        envelope = json.dumps({"op": "cells", "jobId": case["jobId"], "clipId": case["clipId"],
                               "layout": "fit_blur", "cells": wanted,
                               "cancelToken": None}).encode()
        seen = {}

        def stop_when_ffmpeg_runs(pid: int) -> None:
            seen["pid"] = pid
            assert os.getsid(pid) == pid and os.getpgid(pid) == pid
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                ffmpeg = [int(p) for p in os.listdir("/proc") if p.isdigit()
                          and _is_child_ffmpeg(int(p), pid)]
                if ffmpeg:
                    seen["ffmpeg"] = ffmpeg
                    os.killpg(pid, signal.SIGTERM)
                    return
                time.sleep(0.05)

        _pid, code, result = server.request(envelope, pid_seen=stop_when_ffmpeg_runs)
        assert seen.get("ffmpeg"), "FFmpeg never started"
        assert code == 12 and result["error"]["code"] == "cancelled"
        time.sleep(0.2)
        assert not any(os.path.exists(f"/proc/{pid}") and _state(pid) != "Z"
                       for pid in seen["ffmpeg"])
        for k in wanted:
            assert not (clip / "preview" / "plates" /
                        plates.cell_name(lane["plateKey"], k)).exists()
        assert server.process.poll() is None  # the server itself was not touched
    finally:
        server.close()
