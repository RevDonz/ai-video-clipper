"""Smoke test for a yt-dlp version: download one short public video the way production does.

Used by ``.github/workflows/ytdlp-update.yml`` after it bumps yt-dlp in ``uv.lock``, and by hand
in the production image (``docs/editor/OPERASIONAL.md``, "YouTube rusak: naikkan yt-dlp").
Stdlib only.

The result is ``pass`` (a file with video and audio), ``broken`` (yt-dlp failed in a way only an
update fixes) or ``inconclusive`` (YouTube bot-checked or rate-limited this IP, the network
failed, or the test video is gone). Inconclusive proves nothing and is never reported as a pass.

    python3 scripts/ytdlp/ytdlp_smoke.py run --expect-lock uv.lock --out /tmp/ytdlp-smoke
    python3 scripts/ytdlp/ytdlp_smoke.py locked-version uv.lock
    python3 scripts/ytdlp/ytdlp_smoke.py compare-locks before.lock after.lock

Exit codes of ``run``: 0 pass, 1 broken, 3 inconclusive, 2 setup or usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Cosmos Laundromat pilot trailer on the Blender Foundation's own channel: 50 s (about 6 MB at
# 720p), public since 2015 and licensed Creative Commons Attribution, so downloading it is allowed.
SMOKE_URL = "https://www.youtube.com/watch?v=u8Y6S6ev-Vg"

# The download flags of web/scripts/run-job.mjs (tests/test_ytdlp_smoke.py keeps them in step).
DOWNLOAD_FLAGS = ("--no-playlist", "--js-runtimes", "node",
                  "--format", "bv*[height<=720]+ba/b[height<=720]",
                  "--merge-output-format", "mp4")

DEFAULT_TIMEOUT = 300
EXIT = {"pass": 0, "broken": 1, "inconclusive": 3}
LABELS = {"pass": "lolos", "broken": "gagal", "inconclusive": "tidak meyakinkan"}

_UNPROVEN = "Hasil ini tidak membuktikan yt-dlp jalan atau rusak."
REASONS: dict[str, tuple[str, str]] = {
    "ok": ("pass", "Video uji terunduh dengan flag produksi: {size}, video dan audio, {duration}."),
    "bot_check": ("inconclusive", "YouTube meminta cek bot atau membatasi IP runner ini. "
                                  + _UNPROVEN),
    "network": ("inconclusive", "Jaringan runner gagal menghubungi YouTube. " + _UNPROVEN),
    "video_unavailable": ("inconclusive", (
        "Video uji tidak tersedia lagi. Ganti `SMOKE_URL` di `scripts/ytdlp/ytdlp_smoke.py` "
        "dengan video pendek berlisensi Creative Commons. ") + _UNPROVEN),
    "format": ("broken", "Format video yang dipakai produksi tidak tersedia."),
    "forbidden": ("broken", "YouTube menolak unduhan media (HTTP 403)."),
    "extractor": ("broken", "yt-dlp tidak bisa membaca halaman atau player YouTube."),
    "timeout": ("broken", "Unduhan tidak selesai dalam {timeout} detik."),
    "no_file": ("broken", "yt-dlp selesai tanpa file video."),
    "bad_file": ("broken", "File hasil unduhan tidak lengkap: {line}."),
    "version_mismatch": ("broken", "yt-dlp yang terpasang {version}, bukan {expected}."),
    "error": ("broken", "yt-dlp gagal dengan galat yang belum dikenali."),
}

def _phrases(*patterns: str) -> re.Pattern[str]:
    return re.compile("|".join(patterns), re.IGNORECASE)


# Checked in this order: a rate-limit notice also says "Video unavailable".
_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bot_check", _phrases(r"confirm you.re not a bot", "confirm you are not a bot",
                           "rate.limited", "HTTP Error 429", "Too Many Requests",
                           "try again later")),
    ("network", _phrases("name resolution", "Name or service not known",
                         "Network is unreachable", r"Connection (?:refused|reset|aborted)",
                         "timed out", "Remote end closed connection", "urlopen error",
                         "EOF occurred")),
    ("video_unavailable", _phrases("video is unavailable", "Video unavailable", "Private video",
                                   "removed by the uploader", "has been terminated",
                                   "confirm your age", "members-only",
                                   "not made this video available in your country")),
    ("format", _phrases("Requested format is not available", "No video formats found")),
    ("forbidden", _phrases("HTTP Error 403")),
    ("extractor", _phrases("Unable to extract", "Signature extraction failed",
                           "nsig extraction", "Failed to extract", "Unsupported URL",
                           "challenge")),
)

_VERSION = re.compile(r"\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?(?:\.(?:post|dev)\d+)?")

# Never handed to yt-dlp, as in web/scripts/run-job.mjs (DOWNLOADER_SECRET), plus the CI tokens.
_SECRET_ENV = re.compile(r"POTONGIN_LLM(?:_.*)?|POTONGIN_SETTINGS_.*|[A-Z0-9_]*API_KEY"
                         r"|APP_PASSWORD|APP_SESSION_SECRET|GH_TOKEN|GITHUB_TOKEN"
                         r"|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN")


class LockError(ValueError):
    pass


class SetupError(RuntimeError):
    pass


@dataclass(frozen=True)
class Verdict:
    status: str
    reason: str
    line: str | None = None


@dataclass(frozen=True)
class MediaCheck:
    ok: bool
    problem: str | None
    bytes: int
    duration: float | None


@dataclass(frozen=True)
class LockChange:
    before: str
    after: str

    @property
    def changed(self) -> bool:
        return self.before != self.after


def valid_version(text: str) -> str:
    """``text`` if it is a yt-dlp version; refuses anything that could reach a shell or output."""
    if not _VERSION.fullmatch(text):
        raise ValueError(f"not a yt-dlp version: {text!r}")
    return text


def _numbers(version: str) -> tuple[int, ...]:
    release = re.sub(r"\.(?:post|dev)\d+$", "", version.strip())
    return tuple(int(part) for part in release.split("."))


def same_version(printed: str, locked: str) -> bool:
    """``yt-dlp --version`` prints 2026.08.19 for the 2026.8.19 on PyPI."""
    try:
        return _numbers(printed) == _numbers(locked)
    except ValueError:
        return False


def _packages(lock_text: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        document = tomllib.loads(lock_text)
    except tomllib.TOMLDecodeError as error:
        raise LockError(f"uv.lock is not TOML: {error}") from error
    packages = document.pop("package", [])
    return document, packages


def locked_version(lock_text: str) -> str:
    _, packages = _packages(lock_text)
    found = [package for package in packages if package.get("name") == "yt-dlp"]
    if len(found) != 1:
        raise LockError(f"uv.lock has {len(found)} yt-dlp packages, expected 1")
    try:
        return valid_version(str(found[0].get("version", "")))
    except ValueError as error:
        raise LockError(str(error)) from error


def compare_locks(before_text: str, after_text: str) -> LockChange:
    """The yt-dlp versions of two locks that may differ only in yt-dlp."""
    change = LockChange(locked_version(before_text), locked_version(after_text))
    (top_before, before), (top_after, after) = _packages(before_text), _packages(after_text)
    if top_before != top_after:
        raise LockError("uv.lock changed outside its packages")
    rest_before = {p["name"]: p for p in before if p.get("name") != "yt-dlp"}
    rest_after = {p["name"]: p for p in after if p.get("name") != "yt-dlp"}
    changed = sorted(name for name in rest_before.keys() | rest_after.keys()
                     if rest_before.get(name) != rest_after.get(name))
    if changed:
        raise LockError(f"uv.lock changed more than yt-dlp: {', '.join(changed)}")
    return change


def classify(returncode: int | None, stderr: str, media: MediaCheck | None) -> Verdict:
    """``returncode`` is None when the download timed out."""
    if returncode == 0:
        if media is None:
            return Verdict("broken", "no_file")
        if not media.ok:
            return Verdict("broken", "bad_file", media.problem)
        return Verdict("pass", "ok")
    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    errors = [line for line in lines if line.startswith("ERROR:")]
    for reason, pattern in _PATTERNS:
        for line in errors or lines:
            if pattern.search(line):
                return Verdict(REASONS[reason][0], reason, line)
    if returncode is None:
        return Verdict("broken", "timeout", errors[-1] if errors else None)
    return Verdict("broken", "error", errors[-1] if errors else (lines[-1] if lines else None))


def probe_media(path: Path, ffprobe: str) -> MediaCheck:
    size = path.stat().st_size
    try:
        completed = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "stream=codec_type:format=duration",
             "-of", "json", str(path)], capture_output=True, text=True, timeout=60, check=False)
        info = json.loads(completed.stdout or "{}")
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        return MediaCheck(False, f"ffprobe gagal ({error})", size, None)
    kinds = {stream.get("codec_type") for stream in info.get("streams", [])}
    try:
        duration = float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = None
    missing = [kind for kind in ("video", "audio") if kind not in kinds]
    if completed.returncode != 0:
        return MediaCheck(False, "ffprobe tidak bisa membaca file", size, duration)
    if missing:
        return MediaCheck(False, f"tidak ada {' dan '.join(missing)}", size, duration)
    if not duration or duration < 1:
        return MediaCheck(False, "durasi kosong", size, duration)
    return MediaCheck(True, None, size, duration)


def _clean_env() -> dict[str, str]:
    return {name: value for name, value in os.environ.items() if not _SECRET_ENV.fullmatch(name)}


def _tail(text: str, lines: int = 20) -> list[str]:
    return [line[:500] for line in text.splitlines() if line.strip()][-lines:]


def run_smoke(url: str, out_dir: Path, *, ytdlp: str = "yt-dlp", ffprobe: str = "ffprobe",
              timeout: int = DEFAULT_TIMEOUT, expected: str | None = None) -> dict[str, Any]:
    """Download ``url`` into ``out_dir/media`` and write ``result.json`` and ``summary.md``."""
    if shutil.which(ffprobe) is None:
        raise SetupError(f"{ffprobe} not found: the smoke checks the file with ffprobe")
    env = _clean_env()
    try:
        printed = subprocess.run([ytdlp, "--version"], capture_output=True, text=True, env=env,
                                 timeout=60, check=True).stdout.strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise SetupError(f"{ytdlp} --version failed: {error}") from error
    media_dir = out_dir / "media"
    if media_dir.exists():
        shutil.rmtree(media_dir)
    media_dir.mkdir(parents=True)
    result: dict[str, Any] = {"url": url, "version": printed, "expected": expected,
                              "timeout": timeout, "returncode": None, "media": None,
                              "stderr_tail": []}
    if expected is not None and not same_version(printed, expected):
        verdict = Verdict("broken", "version_mismatch")
    else:
        argv = [ytdlp, *DOWNLOAD_FLAGS, "--output", str(media_dir / "source.%(ext)s"), url]
        try:
            completed = subprocess.run(argv, capture_output=True, text=True, env=env,
                                       timeout=timeout, check=False)
            returncode, stderr = completed.returncode, completed.stderr
        except subprocess.TimeoutExpired as error:
            returncode = None
            stderr = error.stderr.decode(errors="replace") if isinstance(error.stderr, bytes) \
                else (error.stderr or "")
        files = sorted(path for path in media_dir.iterdir()
                       if path.name.startswith("source.") and not path.name.endswith(".part"))
        media = probe_media(files[0], ffprobe) if returncode == 0 and files else None
        verdict = classify(returncode, stderr, media)
        result.update(returncode=returncode, stderr_tail=_tail(stderr))
        if media is not None:
            result["media"] = {"bytes": media.bytes, "duration": media.duration}
    result.update(status=verdict.status, reason=verdict.reason, line=verdict.line)
    (out_dir / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (out_dir / "summary.md").write_text(summary_markdown(result), encoding="utf-8")
    return result


def _decimal(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def _code(text: str) -> str:
    fence = "``" if "`" in text else "`"
    return f"{fence}{text}{fence}"


def summary_markdown(result: dict[str, Any]) -> str:
    """The run summary in Indonesian: status, one sentence on why, and the error line."""
    media = result.get("media") or {}
    duration = media.get("duration")
    sentence = REASONS[result["reason"]][1].format(
        size=f"{_decimal(media.get('bytes', 0) / 1_000_000)} MB",
        duration=f"{round(duration)} detik" if duration else "durasi tidak diketahui",
        timeout=result.get("timeout"), version=result.get("version"),
        expected=result.get("expected"), line=result.get("line"))
    lines = [f"### Smoke yt-dlp {result.get('version')}: {LABELS[result['status']]}", "",
             sentence, "", f"Video uji: {result['url']}"]
    if result.get("line") and result["reason"] != "bad_file":
        lines += ["", f"Baris galat: {_code(result['line'][:300])}"]
    return "\n".join(lines) + "\n"


def _append(path: str | None, text: str) -> None:
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(text)


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="download the test video and classify the result")
    run.add_argument("--url", default=SMOKE_URL)
    run.add_argument("--out", default="ytdlp-smoke",
                     help="folder for media/, result.json and summary.md")
    run.add_argument("--yt-dlp", dest="ytdlp", default="yt-dlp")
    run.add_argument("--ffprobe", default="ffprobe")
    run.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    expect = run.add_mutually_exclusive_group()
    expect.add_argument("--expect-version", help="fail unless yt-dlp prints this version")
    expect.add_argument("--expect-lock", help="fail unless yt-dlp is the version in this uv.lock")
    run.add_argument("--github-output", help="append status= and reason= to this file")
    run.add_argument("--summary", help="append the Markdown summary to this file")

    locked = commands.add_parser("locked-version", help="print the yt-dlp version of a uv.lock")
    locked.add_argument("lock")

    compare = commands.add_parser("compare-locks",
                                  help="check that two locks differ only in yt-dlp")
    compare.add_argument("before")
    compare.add_argument("after")
    compare.add_argument("--expect-version", help="fail unless AFTER bumps yt-dlp to this version")
    compare.add_argument("--github-output", help="append before=, version=, changed= to this file")
    compare.add_argument("--summary", help="append one Markdown line to this file")

    args = parser.parse_args(argv)
    try:
        if args.command == "locked-version":
            print(locked_version(_read(args.lock)))
            return 0
        if args.command == "compare-locks":
            return _compare(args)
        expected = args.expect_version and valid_version(args.expect_version)
        if args.expect_lock:
            expected = locked_version(_read(args.expect_lock))
        result = run_smoke(args.url, Path(args.out), ytdlp=args.ytdlp, ffprobe=args.ffprobe,
                           timeout=args.timeout, expected=expected or None)
    except (LockError, SetupError, ValueError, OSError) as error:
        print(f"ytdlp_smoke: {error}", file=sys.stderr)
        return 2
    print(summary_markdown(result), end="")
    _append(args.github_output, f"status={result['status']}\nreason={result['reason']}\n")
    _append(args.summary, summary_markdown(result))
    return EXIT[result["status"]]


def _compare(args: argparse.Namespace) -> int:
    change = compare_locks(_read(args.before), _read(args.after))
    print(f"yt-dlp {change.before} -> {change.after}")
    if args.expect_version is not None and (not change.changed
                                            or change.after != args.expect_version):
        print(f"ytdlp_smoke: expected a bump to {args.expect_version}, got "
              f"{change.before} -> {change.after}", file=sys.stderr)
        return 1
    _append(args.github_output, f"before={change.before}\nversion={change.after}\n"
                                f"changed={'true' if change.changed else 'false'}\n")
    line = (f"yt-dlp {change.before} → {change.after}\n" if change.changed
            else f"yt-dlp {change.after} sudah yang terbaru; tidak ada PR.\n")
    _append(args.summary, line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
