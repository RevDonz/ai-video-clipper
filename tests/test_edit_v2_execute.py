"""execute.run: fd inputs, private temp dir, allowlisted env, RLIMIT_AS, -progress liveness,
timeout and cancel (plan §5.1, §5.2 R8, §4.6). FFmpeg is replaced by a fake script."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import threading
import time
from pathlib import Path

import pytest

from ai_clipper.edit_v2 import errors, execute
from ai_clipper.edit_v2.compile_ffmpeg import FfmpegJob, InputSpec
from ai_clipper.edit_v2.derive import strip_png

FAKE = r'''
import hashlib, json, os, struct, subprocess, sys, time, zlib

args = sys.argv[1:]


def opt(name, default=None):
    return args[args.index(name) + 1] if name in args else default


def png(extra):
    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    raw = b"\x00\x10\x20\x30\x40"
    body = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
    body += chunk(b"tEXt", b"Software\x00fake") if extra else b""
    body += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    return b"\x89PNG\r\n\x1a\n" + body


progress = opt("-progress")
stream = os.fdopen(int(progress.split(":")[1]), "w") if progress else None


def block(frame, end=False):
    if stream is None:
        return
    stream.write(f"frame={frame}\nfps=0.00\nout_time_us={frame * 33366}\n"
                 f"total_size={frame * 100}\nprogress={'end' if end else 'continue'}\n")
    stream.flush()


report = opt("--report")
if report:
    time.sleep(0.2)
    inputs = {}
    for index, token in enumerate(args):
        if index and args[index - 1] == "-i":
            with open(token, "rb") as handle:
                inputs[token] = hashlib.sha256(handle.read()).hexdigest()
    files = {name: oct(os.lstat(name).st_mode & 0o777) for name in os.listdir(".")}
    links = {name: os.readlink(name) for name in os.listdir(".") if os.path.islink(name)}
    with open(report, "w") as handle:
        json.dump({"argv": args, "cwd": os.getcwd(), "env": dict(os.environ),
                   "inputs": inputs, "limits": open("/proc/self/limits").read(),
                   "cwd_mode": oct(os.stat(".").st_mode & 0o777), "files": files,
                   "links": links, "graph": open("filter_graph.txt").read()
                   if os.path.exists("filter_graph.txt") else None}, handle)

behave = opt("--behave", "ok")
if behave == "ok":
    for frame in (1, 5, 10):
        block(frame)
        time.sleep(0.12)
    block(10, end=True)
    target = opt("--write-out")
    if target:
        with open(target, "wb") as handle:
            handle.write(b"rendered bytes")
    for name in (opt("--make") or "").split(","):
        if name:
            with open(name, "wb") as handle:
                handle.write(b"cell " + name.encode())
    for name in (opt("--png") or "").split(","):
        if name:
            with open(name, "wb") as handle:
                handle.write(png(True))
    sys.stderr.write("done\n")
    sys.exit(0)
if behave == "fail":
    sys.stderr.write("boom: something failed\n")
    sys.exit(1)
if behave == "stall":
    block(1)
    time.sleep(60)
if behave == "silent":
    time.sleep(60)
if behave in ("busy", "busy-child"):
    if behave == "busy-child":
        child = subprocess.Popen(["sleep", "60"])
        with open(opt("--pids"), "w") as handle:
            handle.write(f"{os.getpid()} {child.pid}")
    frame = 0
    while True:
        frame += 1
        block(frame)
        time.sleep(0.05)
if behave == "noisy":
    for _ in range(20000):
        sys.stderr.write("x" * 99 + "\n")
    sys.stderr.write("THE-END\n")
    block(1, end=True)
    sys.exit(0)
'''


@pytest.fixture
def fake(tmp_path) -> str:
    path = tmp_path / "fake-ffmpeg"
    path.write_text(f"#!{sys.executable}\n" + FAKE, encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def job(argv, *, inputs=(), sidecars=None, expected=None, script="[0:v]null[v]"):
    return FfmpegJob(argv=tuple(argv), filter_script=script, inputs=tuple(inputs),
                     sidecars=dict(sidecars or {}), expected=dict(expected or {}))


def output_file(tmp_path, name="out.bin"):
    return os.open(tmp_path / name, os.O_RDWR | os.O_CREAT | os.O_TRUNC, 0o600)


def test_success_resolves_tokens_and_reports_progress(fake, tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source bytes")
    report = tmp_path / "report.json"
    envelope = b"\x00\x00\x80\x3f" * 4
    frames = []
    fd = output_file(tmp_path)
    try:
        result = execute.run(
            job([fake, "-progress", "@progress", "-ss", "1.0", "-i", "@in:0", "-f", "f32le",
                 "-i", "@in:1", "-filter_complex_script", "filter_graph.txt",
                 "--report", str(report), "--write-out", "@out"],
                inputs=(InputSpec("source", "source", ("-ss", "1.0")),
                        InputSpec("sidecar", "audio-env.f32", ("-f", "f32le"))),
                sidecars={"captions.ass": b"[Script Info]\n", "audio-env.f32": envelope},
                expected={"paths": {"source": str(source)}, "output": "fd"}),
            output_fd=fd, timeout_s=30, on_progress=frames.append)
        os.lseek(fd, 0, os.SEEK_SET)
        assert os.read(fd, 100) == b"rendered bytes"
    finally:
        os.close(fd)
    assert result.returncode == 0
    assert result.frames == 10
    assert frames and frames == sorted(frames) and frames[-1] == 10
    assert "done" in result.stderr
    info = json.loads(report.read_text())
    argv = info["argv"]
    assert not any(token.startswith("@") for token in argv)
    assert argv[argv.index("-progress") + 1].startswith("pipe:")
    paths = [argv[i + 1] for i, token in enumerate(argv) if token == "-i"]
    assert all(path.startswith("/proc/self/fd/") for path in paths)
    assert info["inputs"][paths[0]] == hashlib.sha256(b"source bytes").hexdigest()
    assert info["inputs"][paths[1]] == hashlib.sha256(envelope).hexdigest()
    assert argv[argv.index("--write-out") + 1] == f"/proc/self/fd/{fd}"
    assert info["graph"] == "[0:v]null[v]"
    assert not Path(info["cwd"]).exists()


def test_private_directory_and_sidecar_modes(fake, tmp_path):
    report = tmp_path / "report.json"
    fonts = tmp_path / "resources" / "fonts"
    fonts.mkdir(parents=True)
    execute.run(job([fake, "-progress", "@progress", "--report", str(report)],
                    sidecars={"captions.ass": b"x"},
                    expected={"output": "null", "fonts_dir": str(fonts)}),
                output_fd=None, timeout_s=30)
    info = json.loads(report.read_text())
    assert info["cwd_mode"] == oct(0o700)
    assert info["files"]["captions.ass"] == oct(0o600)
    assert info["files"]["filter_graph.txt"] == oct(0o600)
    assert info["links"] == {"fonts": str(fonts)}


def test_environment_is_an_allowlist(fake, tmp_path, monkeypatch):
    for name in ("APP_PASSWORD", "APP_SESSION_SECRET", "POTONGIN_SETTINGS_SECRET",
                 "OPENROUTER_API_KEY", "POTONGIN_LLM_MODELS"):
        monkeypatch.setenv(name, "secret-value")
    report = tmp_path / "report.json"
    conf = tmp_path / "fonts.conf"
    conf.write_text("<fontconfig/>")
    execute.run(job([fake, "-progress", "@progress", "--report", str(report)],
                    expected={"output": "null", "fontconfig_file": str(conf)}),
                output_fd=None, timeout_s=30)
    env = json.loads(report.read_text())["env"]
    assert set(env) <= {"PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "FONTCONFIG_FILE"}
    assert env["FONTCONFIG_FILE"] == str(conf)
    assert "secret-value" not in json.dumps(env)


def test_missing_fontconfig_file_is_not_passed(fake, tmp_path):
    report = tmp_path / "report.json"
    execute.run(job([fake, "-progress", "@progress", "--report", str(report)],
                    expected={"output": "null",
                              "fontconfig_file": str(tmp_path / "missing.conf")}),
                output_fd=None, timeout_s=30)
    assert "FONTCONFIG_FILE" not in json.loads(report.read_text())["env"]


def test_address_space_is_limited(fake, tmp_path):
    report = tmp_path / "report.json"
    execute.run(job([fake, "-progress", "@progress", "--report", str(report)],
                    expected={"output": "null"}), output_fd=None, timeout_s=30)
    limits = json.loads(report.read_text())["limits"]
    line = next(line for line in limits.splitlines() if line.startswith("Max address space"))
    assert line.split()[3:5] == [str(execute.RLIMIT_AS_BYTES)] * 2
    assert execute.RLIMIT_AS_BYTES == 3 << 30


def test_failure_raises_render_failed_with_the_stderr_tail(fake):
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "fail"],
                        expected={"output": "null"}), output_fd=None, timeout_s=30)
    assert caught.value.code == "render_failed"
    assert "boom" in caught.value.stderr_tail
    assert "boom" not in str(caught.value)


def test_timeout_kills_the_process_group(fake, tmp_path):
    pids = tmp_path / "pids"
    started = time.monotonic()
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "busy-child",
                         "--pids", str(pids)], expected={"output": "null", "stall_s": 30}),
                    output_fd=None, timeout_s=1.0)
    assert caught.value.code == "render_timeout"
    assert time.monotonic() - started < 5
    for pid in map(int, pids.read_text().split()):
        _assert_gone(pid)


def _assert_gone(pid: int) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        try:
            with open(f"/proc/{pid}/stat") as handle:
                if handle.read().split(") ")[1].startswith("Z"):
                    return  # zombie of an exited process: killed, awaiting its parent
        except FileNotFoundError:
            return
        time.sleep(0.05)
    raise AssertionError(f"process {pid} survived")


def test_a_stalled_process_is_killed(fake):
    started = time.monotonic()
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "stall"],
                        expected={"output": "null", "stall_s": 0.6}),
                    output_fd=None, timeout_s=30)
    assert caught.value.code == "render_stalled"
    assert time.monotonic() - started < 5


def test_a_silent_start_counts_as_a_stall(fake):
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "silent"],
                        expected={"output": "null", "stall_s": 0.5}),
                    output_fd=None, timeout_s=30)
    assert caught.value.code == "render_stalled"


def test_progressing_work_is_not_a_stall(fake):
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "busy"],
                        expected={"output": "null", "stall_s": 0.4}),
                    output_fd=None, timeout_s=1.5)
    assert caught.value.code == "render_timeout"


def test_default_stall_window_is_twenty_seconds():
    assert execute.STALL_S == 20.0


def test_cancel_kills_within_two_seconds(fake, tmp_path):
    cancel = threading.Event()
    pids = tmp_path / "pids"
    threading.Timer(0.5, cancel.set).start()
    started = time.monotonic()
    with pytest.raises(errors.Cancelled) as caught:
        execute.run(job([fake, "-progress", "@progress", "--behave", "busy-child",
                         "--pids", str(pids)], expected={"output": "null"}),
                    output_fd=None, timeout_s=60, cancel=cancel)
    assert caught.value.code == "cancelled"
    assert time.monotonic() - started < 0.5 + 2.0
    for pid in map(int, pids.read_text().split()):
        _assert_gone(pid)


def test_a_cancel_before_start_never_spawns(fake, tmp_path):
    cancel = threading.Event()
    cancel.set()
    report = tmp_path / "report.json"
    with pytest.raises(errors.Cancelled):
        execute.run(job([fake, "-progress", "@progress", "--report", str(report)],
                        expected={"output": "null"}), output_fd=None, timeout_s=30,
                    cancel=cancel)
    assert not report.exists()


def test_stderr_keeps_the_head_and_the_tail(fake):
    result = execute.run(job([fake, "-progress", "@progress", "--behave", "noisy"],
                             expected={"output": "null"}), output_fd=None, timeout_s=30)
    assert "THE-END" in result.stderr
    assert len(result.stderr.encode()) <= execute.STDERR_HEAD + execute.STDERR_TAIL + 64


def test_cells_are_copied_into_the_output_directory(fake, tmp_path):
    directory = tmp_path / "cells"
    directory.mkdir()
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        result = execute.run(
            job([fake, "-progress", "@progress", "--make", "c0000003.mp4,c0000004.mp4"],
                expected={"output": "cells", "cells": {"3": 60, "4": 60}}),
            output_fd=fd, timeout_s=30)
    finally:
        os.close(fd)
    assert result.files == ("c0000003.mp4", "c0000004.mp4")
    assert (directory / "c0000004.mp4").read_bytes() == b"cell c0000004.mp4"
    assert stat.S_IMODE((directory / "c0000003.mp4").stat().st_mode) == 0o600
    assert sorted(p.name for p in directory.iterdir()) == ["c0000003.mp4", "c0000004.mp4"]


def test_cells_without_a_directory_are_returned(fake):
    result = execute.run(
        job([fake, "-progress", "@progress", "--make", "c0000003.mp4"],
            expected={"output": "cells", "cells": {"3": 60}}), output_fd=None, timeout_s=30)
    assert result.outputs == {"c0000003.mp4": b"cell c0000003.mp4"}


def test_a_missing_cell_is_a_failure(fake, tmp_path):
    with pytest.raises(errors.RenderFailed) as caught:
        execute.run(job([fake, "-progress", "@progress", "--make", "c0000003.mp4"],
                        expected={"output": "cells", "cells": {"3": 60, "4": 60}}),
                    output_fd=None, timeout_s=30)
    assert caught.value.code == "render_failed"


def test_png_results_run_the_post_step_and_are_stripped(fake, tmp_path):
    post = [fake, "--behave", "ok", "--png", "frame.png"]
    result = execute.run(
        job([fake, "-progress", "@progress", "--make", "frame.h264"],
            expected={"output": "png", "result": "frame.png", "post": post}),
        output_fd=None, timeout_s=30)
    assert result.output.startswith(b"\x89PNG")
    assert b"tEXt" not in result.output and b"IDAT" in result.output
    assert result.output == strip_png(result.output)
    fd = output_file(tmp_path, "frame.png")
    try:
        execute.run(job([fake, "-progress", "@progress", "--png", "derived.png"],
                        expected={"output": "png", "result": "derived.png"}),
                    output_fd=fd, timeout_s=30)
    finally:
        os.close(fd)
    data = (tmp_path / "frame.png").read_bytes()
    assert data.startswith(b"\x89PNG") and b"tEXt" not in data


def test_bad_tokens_and_sidecar_names_are_rejected(fake):
    with pytest.raises(ValueError):
        execute.run(job([fake, "-i", "@in:0"], expected={"output": "null"}),
                    output_fd=None, timeout_s=30)
    for name in ("../escape.ass", "a/b", "", ".hidden", "fonts", "filter_graph.txt"):
        with pytest.raises(ValueError):
            execute.run(job([fake], sidecars={name: b"x"}, expected={"output": "null"}),
                        output_fd=None, timeout_s=30)
    with pytest.raises(ValueError):
        execute.run(job([fake, "@out"], expected={"output": "fd"}), output_fd=None,
                    timeout_s=30)


def test_assets_must_stay_inside_the_asset_root(fake, tmp_path):
    root = tmp_path / "assets"
    root.mkdir()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"x")
    name = "sha256:" + "a" * 64
    link = root / ("a" * 64 + ".png")
    link.symlink_to(outside)
    with pytest.raises(errors.RenderFailed):
        execute.run(job([fake, "-progress", "@progress", "-i", "@in:0"],
                        inputs=(InputSpec("asset", name),),
                        expected={"output": "null", "assets_root": str(root),
                                  "paths": {name: str(link)}}),
                    output_fd=None, timeout_s=30)
    elsewhere = tmp_path / ("b" * 64 + ".png")
    elsewhere.write_bytes(b"y")
    with pytest.raises(errors.RenderFailed):
        execute.run(job([fake, "-progress", "@progress", "-i", "@in:0"],
                        inputs=(InputSpec("asset", "sha256:" + "b" * 64),),
                        expected={"output": "null", "assets_root": str(root),
                                  "paths": {"sha256:" + "b" * 64: str(elsewhere)}}),
                    output_fd=None, timeout_s=30)
