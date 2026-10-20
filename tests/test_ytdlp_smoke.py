"""The yt-dlp smoke test (``scripts/ytdlp/ytdlp_smoke.py``).

The weekly bump (``.github/workflows/ytdlp-update.yml``) and the emergency procedure
(``docs/editor/OPERASIONAL.md``) download one short public video the way production does. The
result is ``pass``, ``broken`` (yt-dlp needs a fix) or ``inconclusive`` (YouTube bot-checked or
rate-limited the runner's IP, the network failed, or the test video is gone); an inconclusive
smoke is never reported as a pass.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ytdlp"))

import ytdlp_smoke as smoke

LOCK = (ROOT / "uv.lock").read_text(encoding="utf-8")

BOT = ("ERROR: [youtube] u8Y6S6ev-Vg: Sign in to confirm you’re not a bot. Use "
       "--cookies-from-browser or --cookies for the authentication.")
RATE_LIMITED = ("ERROR: [youtube] u8Y6S6ev-Vg: Video unavailable. This content isn't available, "
                "try again later. The current session has been rate-limited by YouTube for up to "
                "an hour.")


# --- versions -----------------------------------------------------------------------------------


def test_the_printed_version_matches_the_locked_one_despite_zero_padding():
    assert smoke.same_version("2026.08.19", "2026.8.19")
    assert smoke.same_version("2026.10.03.232815", "2026.10.3.232815.dev0")
    assert not smoke.same_version("2026.08.19", "2026.9.1")
    assert not smoke.same_version("2026.08.19", "2026.8.19.1")


@pytest.mark.parametrize("text", ["2026.8.19", "2026.10.3.232815.dev0", "2025.1.15.post1"])
def test_valid_versions_pass_through(text):
    assert smoke.valid_version(text) == text


@pytest.mark.parametrize("text", ["", "latest", "2026", "2026.8.19\nchanged=true",
                                  "2026.8.19; rm -rf /", "v2026.8.19", "2026.8.19 "])
def test_versions_that_could_inject_into_outputs_or_shells_are_refused(text):
    with pytest.raises(ValueError):
        smoke.valid_version(text)


def _lock(packages: dict[str, str]) -> str:
    blocks = [f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
              f'source = {{ registry = "https://pypi.org/simple" }}\n'
              for name, version in packages.items()]
    return 'version = 1\nrequires-python = ">=3.11"\n\n' + "\n".join(blocks)


def test_the_locked_version_is_read_from_uv_lock():
    assert smoke.locked_version(_lock({"pytest": "8.4.2", "yt-dlp": "2026.8.19"})) == "2026.8.19"
    assert re.fullmatch(r"\d+(\.\d+)+", smoke.locked_version(LOCK))


@pytest.mark.parametrize("packages", [{"pytest": "8.4.2"}, {"yt-dlp": "not a version"}])
def test_a_lock_without_one_valid_yt_dlp_is_an_error(packages):
    with pytest.raises(smoke.LockError):
        smoke.locked_version(_lock(packages))


def test_comparing_locks_reports_the_bump():
    before = _lock({"pytest": "8.4.2", "yt-dlp": "2026.8.19"})
    change = smoke.compare_locks(before, _lock({"pytest": "8.4.2", "yt-dlp": "2026.10.1"}))
    assert (change.before, change.after, change.changed) == ("2026.8.19", "2026.10.1", True)
    same = smoke.compare_locks(before, before)
    assert (same.before, same.after, same.changed) == ("2026.8.19", "2026.8.19", False)


def test_a_lock_that_changed_more_than_yt_dlp_is_refused():
    before = _lock({"pytest": "8.4.2", "yt-dlp": "2026.8.19"})
    with pytest.raises(smoke.LockError, match="pytest"):
        smoke.compare_locks(before, _lock({"pytest": "8.4.3", "yt-dlp": "2026.10.1"}))
    with pytest.raises(smoke.LockError):
        smoke.compare_locks(before, before.replace('requires-python = ">=3.11"',
                                                   'requires-python = ">=3.12"'))


# --- classification -----------------------------------------------------------------------------


def _media(**overrides):
    values = {"ok": True, "problem": None, "bytes": 6_183_658, "duration": 50.0}
    values.update(overrides)
    return smoke.MediaCheck(**values)


@pytest.mark.parametrize(("stderr", "reason"), [
    (BOT, "bot_check"),
    (BOT.replace("’", "'"), "bot_check"),
    (RATE_LIMITED, "bot_check"),
    ("ERROR: [youtube] x: Unable to download webpage: HTTP Error 429: Too Many Requests",
     "bot_check"),
    (("ERROR: [youtube] u8Y6S6ev-Vg: Unable to download API page: <urlopen error [Errno -3] "
      "Temporary failure in name resolution> (caused by TransportError('...'))"), "network"),
    ("ERROR: [youtube] x: Unable to download webpage: [Errno 101] Network is unreachable",
     "network"),
    ("ERROR: [youtube] BaW_jenozKc: This video is unavailable", "video_unavailable"),
    ("ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video",
     "video_unavailable"),
    ("ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader",
     "video_unavailable"),
])
def test_failures_that_prove_nothing_about_yt_dlp_are_inconclusive(stderr, reason):
    verdict = smoke.classify(1, "WARNING: [youtube] something minor\n" + stderr + "\n", None)
    assert (verdict.status, verdict.reason) == ("inconclusive", reason)
    assert verdict.line == stderr


@pytest.mark.parametrize(("stderr", "reason"), [
    (("ERROR: [youtube] u8Y6S6ev-Vg: Requested format is not available. Use --list-formats "
      "for a list of available formats"), "format"),
    ("ERROR: [youtube] u8Y6S6ev-Vg: No video formats found!", "format"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "forbidden"),
    ("ERROR: [youtube] u8Y6S6ev-Vg: Unable to extract yt initial data; please report this issue",
     "extractor"),
    ("ERROR: [youtube] u8Y6S6ev-Vg: Signature extraction failed: Some formats may be missing",
     "extractor"),
    ("ERROR: something yt-dlp has never printed before", "error"),
])
def test_failures_an_update_has_to_fix_are_broken(stderr, reason):
    verdict = smoke.classify(1, stderr + "\n", None)
    assert (verdict.status, verdict.reason) == ("broken", reason)


def test_error_lines_decide_over_warnings():
    stderr = ("WARNING: [youtube] u8Y6S6ev-Vg: Sign in to confirm you're not a bot (tv client)\n"
              "ERROR: [youtube] u8Y6S6ev-Vg: Requested format is not available\n")
    assert smoke.classify(1, stderr, None).reason == "format"


def test_a_failure_without_error_lines_is_read_whole():
    assert smoke.classify(1, "Traceback ...\nurlopen error timed out\n", None).reason == "network"
    assert smoke.classify(1, "Segmentation fault\n", None).status == "broken"


def test_a_timeout_is_broken_unless_the_output_explains_it():
    assert (smoke.classify(None, "", None).status, smoke.classify(None, "", None).reason) == \
        ("broken", "timeout")
    assert smoke.classify(None, BOT + "\n", None).reason == "bot_check"


def test_success_needs_a_complete_file():
    assert smoke.classify(0, BOT.replace("ERROR", "WARNING"), _media()).status == "pass"
    assert (smoke.classify(0, "", None).status, smoke.classify(0, "", None).reason) == \
        ("broken", "no_file")
    no_audio = smoke.classify(0, "", _media(ok=False, problem="tidak ada audio"))
    assert (no_audio.status, no_audio.reason, no_audio.line) == \
        ("broken", "bad_file", "tidak ada audio")


# --- the report ---------------------------------------------------------------------------------


def _result(status, reason, **extra):
    values = {"status": status, "reason": reason, "version": "2026.10.1", "url": smoke.SMOKE_URL,
              "line": None, "returncode": 1, "media": None, "timeout": 300, "expected": None}
    values.update(extra)
    return values


def test_the_summary_names_each_status_and_never_calls_inconclusive_a_pass():
    passed = smoke.summary_markdown(_result("pass", "ok", returncode=0,
                                            media={"bytes": 6_183_658, "duration": 50.0}))
    assert "lolos" in passed and "6,2 MB" in passed and "50 detik" in passed
    for reason in ("bot_check", "network", "video_unavailable"):
        text = smoke.summary_markdown(_result("inconclusive", reason, line=BOT))
        assert "tidak meyakinkan" in text
        assert "lolos" not in text
    broken = smoke.summary_markdown(_result("broken", "format",
                                            line="ERROR: Requested format is not available"))
    assert "gagal" in broken and "`ERROR: Requested format is not available`" in broken


def test_the_summary_keeps_backticks_in_the_error_line_from_breaking_the_markdown():
    text = smoke.summary_markdown(_result("broken", "error", line="ERROR: a `quoted` thing"))
    assert "``ERROR: a `quoted` thing``" in text


def test_every_reason_has_a_sentence():
    for reason in smoke.REASONS:
        status = smoke.REASONS[reason][0]
        text = smoke.summary_markdown(_result(status, reason, line="x", expected="2026.10.1",
                                              media={"bytes": 1, "duration": 1.0}))
        assert "{" not in text, reason


# --- running yt-dlp -----------------------------------------------------------------------------


def _fake_ytdlp(tmp_path: Path, *, version: str = "2026.10.01", stderr: str = "",
                exit_code: int = 0, media: Path | None = None, sleep: float = 0) -> Path:
    """An executable that answers like yt-dlp and records the call it got."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    script = tmp_path / "fake-yt-dlp"
    script.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, os, shutil, sys, time
        args = sys.argv[1:]
        if args == ["--version"]:
            print({version!r})
            sys.exit(0)
        with open({str(tmp_path / "call.json")!r}, "w") as handle:
            json.dump({{"args": args, "env": sorted(os.environ)}}, handle)
        time.sleep({sleep!r})
        sys.stderr.write({stderr!r})
        media = {str(media) if media else None!r}
        if media:
            target = args[args.index("--output") + 1].replace("%(ext)s", "mp4")
            shutil.copyfile(media, target)
            open(target.replace(".mp4", ".f136.mp4.part"), "w").close()
        sys.exit({exit_code!r})
        """), encoding="utf-8")
    script.chmod(0o755)
    return script


@pytest.fixture(scope="module")
def tiny_mp4(tmp_path_factory, edit_v2_ffmpeg) -> Path:
    path = tmp_path_factory.mktemp("media") / "tiny.mp4"
    subprocess.run([edit_v2_ffmpeg, "-v", "error", "-f", "lavfi", "-i",
                    "testsrc=size=128x72:rate=10:duration=2", "-f", "lavfi", "-i",
                    "sine=frequency=440:duration=2", "-c:v", "mpeg4", "-c:a", "aac", "-shortest",
                    str(path)], check=True, timeout=60)
    return path


@pytest.fixture(scope="module")
def silent_mp4(tmp_path_factory, edit_v2_ffmpeg) -> Path:
    path = tmp_path_factory.mktemp("media") / "silent.mp4"
    subprocess.run([edit_v2_ffmpeg, "-v", "error", "-f", "lavfi", "-i",
                    "testsrc=size=128x72:rate=10:duration=2", "-c:v", "mpeg4", str(path)],
                   check=True, timeout=60)
    return path


def test_a_complete_download_passes_and_uses_the_production_flags(tmp_path, tiny_mp4,
                                                                  monkeypatch):
    monkeypatch.setenv("POTONGIN_LLM_OPENROUTER_API_KEY", "not-a-real-value")
    monkeypatch.setenv("GH_TOKEN", "not-a-real-value")
    monkeypatch.setenv("APP_SESSION_SECRET", "not-a-real-value")
    fake = _fake_ytdlp(tmp_path, media=tiny_mp4)
    result = smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out", ytdlp=str(fake),
                             expected="2026.10.1")
    assert (result["status"], result["reason"], result["version"]) == ("pass", "ok", "2026.10.01")
    assert result["media"]["duration"] == pytest.approx(2.0, abs=0.2)
    call = json.loads((tmp_path / "call.json").read_text())
    assert call["args"][:len(smoke.DOWNLOAD_FLAGS)] == list(smoke.DOWNLOAD_FLAGS)
    assert call["args"][-1] == smoke.SMOKE_URL
    assert call["args"][-2] == str(tmp_path / "out" / "media" / "source.%(ext)s")
    assert not {"POTONGIN_LLM_OPENROUTER_API_KEY", "GH_TOKEN", "APP_SESSION_SECRET"} & \
        set(call["env"])
    assert "PATH" in call["env"]
    written = json.loads((tmp_path / "out" / "result.json").read_text())
    assert written["status"] == "pass"
    assert "lolos" in (tmp_path / "out" / "summary.md").read_text()


def test_a_file_without_audio_is_broken(tmp_path, silent_mp4):
    result = smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out",
                             ytdlp=str(_fake_ytdlp(tmp_path, media=silent_mp4)))
    assert (result["status"], result["reason"]) == ("broken", "bad_file")


@pytest.mark.usefixtures("edit_v2_ffmpeg")
def test_a_bot_check_is_inconclusive_and_keeps_the_error_line(tmp_path):
    fake = _fake_ytdlp(tmp_path, stderr="WARNING: retrying\n" + BOT + "\n", exit_code=1)
    result = smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out", ytdlp=str(fake))
    assert (result["status"], result["reason"], result["line"]) == \
        ("inconclusive", "bot_check", BOT)
    assert result["stderr_tail"][-1] == BOT


@pytest.mark.usefixtures("edit_v2_ffmpeg")
def test_another_version_than_the_locked_one_is_broken_without_downloading(tmp_path):
    fake = _fake_ytdlp(tmp_path, version="2026.08.19")
    result = smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out", ytdlp=str(fake),
                             expected="2026.10.1")
    assert (result["status"], result["reason"]) == ("broken", "version_mismatch")
    assert not (tmp_path / "call.json").exists()


@pytest.mark.usefixtures("edit_v2_ffmpeg")
def test_a_hanging_download_times_out(tmp_path):
    fake = _fake_ytdlp(tmp_path, sleep=30)
    result = smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out", ytdlp=str(fake), timeout=1)
    assert (result["status"], result["reason"]) == ("broken", "timeout")


@pytest.mark.usefixtures("edit_v2_ffmpeg")
def test_a_missing_yt_dlp_is_a_setup_error(tmp_path):
    with pytest.raises(smoke.SetupError):
        smoke.run_smoke(smoke.SMOKE_URL, tmp_path / "out", ytdlp=str(tmp_path / "missing"))


# --- the command line ---------------------------------------------------------------------------


def test_run_exit_codes_and_outputs(tmp_path, tiny_mp4):
    cases = [("pass", _fake_ytdlp(tmp_path / "a", media=tiny_mp4), 0),
             ("broken", _fake_ytdlp(tmp_path / "b", stderr="ERROR: No video formats found!\n",
                                    exit_code=1), 1),
             ("inconclusive", _fake_ytdlp(tmp_path / "c", stderr=BOT + "\n", exit_code=1), 3)]
    for status, fake, code in cases:
        output, summary = tmp_path / f"{status}.out", tmp_path / f"{status}.md"
        summary.write_text("earlier steps\n", encoding="utf-8")
        argv = ["run", "--yt-dlp", str(fake), "--out", str(tmp_path / f"{status}-dir"),
                "--github-output", str(output), "--summary", str(summary)]
        assert smoke.main(argv) == code, status
        assert f"status={status}\n" in output.read_text()
        assert summary.read_text().startswith("earlier steps\n### Smoke yt-dlp")


@pytest.mark.usefixtures("edit_v2_ffmpeg")
def test_run_checks_the_version_of_the_lock(tmp_path):
    lock = tmp_path / "uv.lock"
    lock.write_text(_lock({"yt-dlp": "2026.10.1"}), encoding="utf-8")
    fake = _fake_ytdlp(tmp_path, version="2026.08.19")
    assert smoke.main(["run", "--yt-dlp", str(fake), "--out", str(tmp_path / "out"),
                       "--expect-lock", str(lock)]) == 1
    assert json.loads((tmp_path / "out" / "result.json").read_text())["reason"] == \
        "version_mismatch"


def test_compare_locks_writes_the_step_outputs(tmp_path, capsys):
    before, after = tmp_path / "before.lock", tmp_path / "after.lock"
    before.write_text(_lock({"yt-dlp": "2026.8.19"}), encoding="utf-8")
    after.write_text(_lock({"yt-dlp": "2026.10.1"}), encoding="utf-8")
    output, summary = tmp_path / "out", tmp_path / "summary.md"
    assert smoke.main(["compare-locks", str(before), str(after), "--github-output", str(output),
                       "--summary", str(summary)]) == 0
    assert output.read_text() == "before=2026.8.19\nversion=2026.10.1\nchanged=true\n"
    assert "2026.8.19 → 2026.10.1" in summary.read_text()
    assert smoke.main(["compare-locks", str(before), str(after),
                       "--expect-version", "2026.10.1"]) == 0
    assert smoke.main(["compare-locks", str(before), str(after),
                       "--expect-version", "2026.10.2"]) == 1
    assert smoke.main(["compare-locks", str(before), str(before),
                       "--expect-version", "2026.8.19"]) == 1
    assert smoke.main(["compare-locks", str(before), str(before), "--github-output",
                       str(tmp_path / "same"), "--summary", str(summary)]) == 0
    assert (tmp_path / "same").read_text().endswith("changed=false\n")
    assert "sudah yang terbaru" in summary.read_text()
    assert "2026.8.19" in capsys.readouterr().out


def test_locked_version_prints_the_version(tmp_path, capsys):
    lock = tmp_path / "uv.lock"
    lock.write_text(_lock({"yt-dlp": "2026.10.1"}), encoding="utf-8")
    assert smoke.main(["locked-version", str(lock)]) == 0
    assert capsys.readouterr().out == "2026.10.1\n"


# --- staying in step with production ------------------------------------------------------------


def test_the_smoke_downloads_with_the_flags_of_the_job_worker():
    source = (ROOT / "web" / "scripts" / "run-job.mjs").read_text(encoding="utf-8")
    pairs = dict(zip(smoke.DOWNLOAD_FLAGS[1::2], smoke.DOWNLOAD_FLAGS[2::2]))
    assert smoke.DOWNLOAD_FLAGS[0] == "--no-playlist"
    for flag, value in pairs.items():
        assert f'"{flag}", "{value}"' in source, (
            f"run-job.mjs no longer passes {flag} {value}: update DOWNLOAD_FLAGS in "
            "scripts/ytdlp/ytdlp_smoke.py to what production runs")


def test_the_smoke_video_is_a_youtube_watch_url():
    assert re.fullmatch(r"https://www\.youtube\.com/watch\?v=[\w-]{11}", smoke.SMOKE_URL)
