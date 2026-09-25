"""Verify a rendered file against its plan: G1–G3, G3b block, G5 warns (plan §5.9).

| Gate | Check | On failure |
|---|---|---|
| G1 container | MP4 (``ftyp``, ``faststart``: ``moov`` before ``mdat``), one H.264 High yuv420p video
  stream at ``size`` with SAR 1:1, CFR ``num/den`` (every packet step is one frame) and
  BT.709/tv tags, one AAC-LC 48 kHz stereo audio stream | blocks |
| G2 A/V | decoded video frames == ``plan.total_frames`` (``-count_frames``); decoded audio
  samples == ``plan.total_samples`` ± ``SAMPLE_TOLERANCE`` | blocks |
| G3 loudness | only with ``normalize``: integrated loudness at the document's target ± 1 LU
  (or the recorded ``loudness_clamped`` value ± 0.5 LU), true peak ≤ −1.0 dBTP | blocks |
| G3b peak | with music or ``audio.source.gain_cdb > 0``: true peak ≤ −1.0 dBTP on the decoded
  export (§5.6 step 5); revision-0 audio is never measured | blocks |
| G5 text-safe | caption, hook and logo geometry vs the TikTok UI zone | warning ``unsafe_zone`` |

The file is read through its descriptor (``/proc/self/fd/N`` for FFmpeg); nothing is written. A
blocking failure raises ``VerificationFailed`` (``verification_failed``, Indonesian message
``edit.verification_failed``) carrying the report as ``.report``.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from itertools import pairwise
from typing import Any

from . import errors
from . import loudness as _loudness
from .doc import Issue
from .loudness import Loudness
from .plan import RenderPlan, unsafe_zone_issues

SAMPLE_TOLERANCE = 1024  # one AAC frame (G2)
TRUE_PEAK_CEILING_CDB = -100  # −1.0 dBTP (G3, G3b)
LOUDNESS_TOLERANCE_CLU = 100  # ± 1 LU around the target (G3)
CLAMPED_TOLERANCE_CLU = 50  # ± 0.5 LU around a recorded loudness_clamped value (G3)
FFMPEG_THREADS = 4
MP4_BRANDS_REJECTED = (b"qt  ",)  # QuickTime is not the delivered MP4

_STREAM_FIELDS = ("index,codec_type,codec_name,profile,pix_fmt,width,height,sample_aspect_ratio,"
                  "r_frame_rate,time_base,color_range,color_space,color_transfer,color_primaries,"
                  "sample_rate,channels,channel_layout,nb_read_frames")


@dataclass(frozen=True)
class GateResult:
    """One gate: ``problems`` are fixed codes (``size``, ``frame_count``, ``true_peak`` …)."""

    name: str
    blocking: bool
    ok: bool
    problems: tuple[str, ...] = ()
    values: Mapping[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "blocking": self.blocking, "ok": self.ok,
                "problems": list(self.problems), "values": dict(self.values)}


@dataclass(frozen=True)
class VerifyReport:
    """Gate results of one file; ``ok`` means every blocking gate passed."""

    gates: tuple[GateResult, ...]
    warnings: tuple[Issue, ...] = ()

    @property
    def ok(self) -> bool:
        return all(gate.ok for gate in self.gates if gate.blocking)

    def gate(self, name: str) -> GateResult | None:
        return next((gate for gate in self.gates if gate.name == name), None)

    def to_json(self) -> dict[str, Any]:
        return {"ok": self.ok, "gates": [gate.to_json() for gate in self.gates],
                "warnings": [issue.to_json() for issue in self.warnings]}


def _env() -> dict[str, str]:
    return {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}


def _run(argv: Sequence[str], fd: int, *, timeout_s: float) -> str:
    result = subprocess.run(list(argv), stdin=subprocess.DEVNULL, capture_output=True, text=True,
                            env=_env(), pass_fds=(fd,), timeout=timeout_s, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"{argv[0]} exited with {result.returncode}")
    return result.stdout


def _input(fd: int) -> str:
    return f"/proc/self/fd/{fd}"


def _timeout(plan: RenderPlan) -> float:
    """Generous: 60 s plus twice the clip length (decoding runs far faster than real time)."""
    return 60.0 + 2.0 * plan.total_frames * plan.fps.den / plan.fps.num


def _probe(fd: int, timeout_s: float) -> dict[str, Any]:
    output = _run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-threads",
                   str(FFMPEG_THREADS), "-count_frames", "-show_entries",
                   f"format=format_name:stream={_STREAM_FIELDS}", "-of", "json", _input(fd)],
                  fd, timeout_s=timeout_s)
    return json.loads(output)


def _video_pts(fd: int, index: int, timeout_s: float) -> list[int] | None:
    output = _run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                   "-select_streams", str(index), "-show_entries", "packet=pts", "-of", "csv=p=0",
                   _input(fd)], fd, timeout_s=timeout_s)
    values = []
    for line in output.split():
        token = line.strip().rstrip(",")
        if not token.lstrip("-").isdigit():
            return None
        values.append(int(token))
    return sorted(values)


def _audio_samples(fd: int, index: int, channels: int, timeout_s: float) -> int:
    """Samples per channel of the decoded audio stream (native rate and layout)."""
    argv = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads",
            str(FFMPEG_THREADS), "-protocol_whitelist", "file,pipe", "-i", _input(fd), "-map",
            f"0:{index}", "-c:a", "pcm_s16le", "-f", "s16le", "-"]
    total = 0
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, env=_env(), pass_fds=(fd,)) as process:
        assert process.stdout is not None
        try:
            while chunk := process.stdout.read(1 << 20):
                total += len(chunk)
            process.wait(timeout=timeout_s)
        except BaseException:
            process.kill()
            raise
    if process.returncode != 0:
        raise RuntimeError("audio decode failed")
    return total // (2 * max(channels, 1))


def _top_level_boxes(fd: int) -> list[bytes]:
    """The types of the top-level ISO BMFF boxes, in file order (stops at the first bad box)."""
    size = os.fstat(fd).st_size
    position = 0
    kinds = []
    while position + 8 <= size and len(kinds) < 64:
        header = os.pread(fd, 16, position)
        length = int.from_bytes(header[:4], "big")
        kind = header[4:8]
        if length == 1 and len(header) == 16:
            length = int.from_bytes(header[8:16], "big")
        elif length == 0:
            length = size - position
        if length < 8:
            break
        kinds.append(kind)
        position += length
    return kinds


def _major_brand(fd: int) -> bytes:
    return os.pread(fd, 4, 8)


def _fraction(text: str | None) -> Fraction | None:
    try:
        numerator, _, denominator = str(text).partition("/")
        return Fraction(int(numerator), int(denominator))
    except (ValueError, ZeroDivisionError):
        return None


def _cfr(pts: list[int] | None, time_base: str | None, frame: Fraction) -> bool:
    base = _fraction(time_base)
    if not pts or base is None:
        return False
    steps = {later - earlier for earlier, later in pairwise(pts)}
    return len(pts) == 1 or (len(steps) == 1 and steps.pop() * base == frame)


def _g1_g2(fd: int, plan: RenderPlan, size: tuple[int, int]) -> tuple[GateResult, GateResult]:
    timeout_s = _timeout(plan)
    g1: list[str] = []
    g2: list[str] = []
    values1: dict[str, Any] = {}
    values2: dict[str, Any] = {"frames": None, "samples": None,
                               "expected_frames": plan.total_frames,
                               "expected_samples": plan.total_samples}
    kinds = _top_level_boxes(fd)
    if not kinds or kinds[0] != b"ftyp" or _major_brand(fd) in MP4_BRANDS_REJECTED:
        g1.append("container")
    if b"moov" not in kinds or b"mdat" not in kinds or kinds.index(b"moov") > kinds.index(b"mdat"):
        g1.append("faststart")
    try:
        info = _probe(fd, timeout_s)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError):
        g1.append("probe_failed")
        g2.extend(("frame_count", "sample_count"))
        return (GateResult("G1", True, False, tuple(g1), values1),
                GateResult("G2", True, False, tuple(g2), values2))
    if "mp4" not in str(info.get("format", {}).get("format_name", "")).split(","):
        g1.append("container")
    streams = info.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if len(videos) != 1 or len(audios) != 1 or len(streams) != 2:
        g1.append("streams")
    fps = plan.fps
    if videos:
        video = videos[0]
        values1.update(width=video.get("width"), height=video.get("height"),
                       profile=video.get("profile"), pix_fmt=video.get("pix_fmt"))
        checks = (
            ("video_codec", video.get("codec_name") == "h264"),
            ("video_profile", video.get("profile") == "High"),
            ("pix_fmt", video.get("pix_fmt") == "yuv420p"),
            ("size", (video.get("width"), video.get("height")) == (size[0], size[1])),
            ("sar", video.get("sample_aspect_ratio") == "1:1"),
            ("color_tags", (video.get("color_primaries"), video.get("color_transfer"),
                            video.get("color_space"), video.get("color_range"))
             == ("bt709", "bt709", "bt709", "tv")),
        )
        g1.extend(problem for problem, ok in checks if not ok)
        frame = Fraction(fps.den, fps.num)
        try:
            pts = _video_pts(fd, int(video["index"]), timeout_s)
        except (RuntimeError, OSError, subprocess.SubprocessError, KeyError, ValueError):
            pts = None
        if _fraction(video.get("r_frame_rate")) != 1 / frame or not _cfr(
                pts, video.get("time_base"), frame):
            g1.append("frame_rate")
        try:
            values2["frames"] = int(video.get("nb_read_frames"))
        except (TypeError, ValueError):
            pass
    if values2["frames"] != plan.total_frames:
        g2.append("frame_count")
    if audios:
        audio = audios[0]
        values1.update(sample_rate=audio.get("sample_rate"), channels=audio.get("channels"))
        checks = (
            ("audio_codec", audio.get("codec_name") == "aac"),
            ("audio_profile", audio.get("profile") == "LC"),
            ("sample_rate", str(audio.get("sample_rate")) == "48000"),
            ("channels", audio.get("channels") == 2 and audio.get("channel_layout") == "stereo"),
        )
        g1.extend(problem for problem, ok in checks if not ok)
        try:
            values2["samples"] = _audio_samples(fd, int(audio["index"]),
                                                int(audio.get("channels") or 0), timeout_s)
        except (RuntimeError, OSError, subprocess.SubprocessError, KeyError, ValueError):
            pass
    samples = values2["samples"]
    if samples is None or abs(samples - plan.total_samples) > SAMPLE_TOLERANCE:
        g2.append("sample_count")
    g1 = sorted(set(g1), key=g1.index)
    return (GateResult("G1", True, not g1, tuple(g1), values1),
            GateResult("G2", True, not g2, tuple(g2), values2))


def measure_loudness(fd: int) -> Loudness:
    """Integrated loudness and true peak of the decoded first audio stream
    (``ebur128=peak=true``, parsed by ``loudness.parse_ebur128``)."""
    size = os.fstat(fd).st_size
    output = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-threads",
         str(FFMPEG_THREADS), "-protocol_whitelist", "file,pipe", "-i", _input(fd), "-map",
         "0:a:0", "-filter:a", "aformat=sample_fmts=dbl,ebur128=peak=true:framelog=verbose",
         "-f", "null", "-"],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, env=_env(), pass_fds=(fd,),
        timeout=120 + size / 1_000_000, check=False)
    if output.returncode != 0:
        raise RuntimeError("loudness measurement failed")
    return _loudness.parse_ebur128(output.stderr)


def _has_music(doc: Mapping[str, Any]) -> bool:
    return any(track["kind"] == "audio" and track["items"] for track in doc["tracks"])


def _loudness_gates(fd: int, plan: RenderPlan, normalize: bool) -> list[GateResult]:
    doc = plan.doc
    protect = _has_music(doc) or doc["audio"]["source"]["gain_cdb"] > 0
    if not normalize and not protect:
        return []  # revision-0-like audio: never measured
    try:
        measured: Loudness | None = measure_loudness(fd)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError):
        measured = None
    values = {} if measured is None else {"i_clufs": measured.i_clufs,
                                          "tp_cdb": measured.tp_cdb}
    gates = []
    peak_ok = measured is not None and measured.tp_cdb <= TRUE_PEAK_CEILING_CDB
    if normalize:
        problems = []
        if measured is None:
            problems.append("measure_failed")
        else:
            clamped = plan.loudness_clamped_clufs
            target = doc["audio"]["master"]["target_clufs"] if clamped is None else clamped
            tolerance = LOUDNESS_TOLERANCE_CLU if clamped is None else CLAMPED_TOLERANCE_CLU
            if abs(measured.i_clufs - target) > tolerance:
                problems.append("integrated_loudness")
            if not peak_ok:
                problems.append("true_peak")
        gates.append(GateResult("G3", True, not problems, tuple(problems), values))
    if protect:
        problems = ["measure_failed"] if measured is None else ([] if peak_ok else ["true_peak"])
        gates.append(GateResult("G3b", True, not problems, tuple(problems), values))
    return gates


def verify_output(
    fd: int, plan: RenderPlan, *, size: tuple[int, int], normalize: bool
) -> VerifyReport:
    """G1 container, G2 A/V counts, G3 loudness (``normalize``), G3b true peak, G5 text-safe.

    A blocking failure raises ``VerificationFailed`` (``verification_failed``) whose ``report``
    attribute holds the full ``VerifyReport``; otherwise the report is returned (G5 warnings
    included).
    """
    size = (size[0], size[1])
    issues = unsafe_zone_issues(plan.doc, plan.assets, size)
    g5 = GateResult("G5", False, not issues, tuple(dict.fromkeys(i.code for i in issues)),
                    {"issues": len(issues)})
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        gates: tuple[GateResult, ...] = (
            GateResult("G1", True, False, ("not_regular_file",)),
            GateResult("G2", True, False, ("not_regular_file",)),
            g5,
        )
    else:
        g1, g2 = _g1_g2(fd, plan, size)
        gates = (g1, g2, *_loudness_gates(fd, plan, normalize), g5)
    report = VerifyReport(gates=gates, warnings=issues)
    if not report.ok:
        error = errors.VerificationFailed("verification_failed")
        error.report = report
        raise error
    return report


__all__ = [
    "SAMPLE_TOLERANCE",
    "GateResult",
    "VerifyReport",
    "measure_loudness",
    "verify_output",
]
