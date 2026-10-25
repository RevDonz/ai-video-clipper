"""Shot cuts of a clip window on the document grid (rombak 04 §A3).

One FFmpeg run decodes the window ``[sf_floor(a), sf_ceil(b))`` exactly as the compiler does
(``-ss`` with a second of pre-roll, ``-copyts``, ``fps=num/den`` and ``trim`` on the grid
index), and measures every grid frame twice (:func:`measure`):

* FFmpeg's ``scene`` score on a 160 px wide picture (the filter of
  ``audio_timeline._SCENE_FILTER``, keeping every frame so any threshold can be applied later);
* the 64×36 grey picture, from which the mean absolute difference to the frame 1, 2, 3 and 12
  frames before is kept (``Profile.lag``, as 1/100000 of 255).

:func:`detect` then finds the cuts with the rules of ``resources/reframe/rules.v1.json``:

1. **Candidates**: frames whose scene score is above ``cut.coarse_scene_pm``, and the camera
   plan's cut flags (``coarse_cuts_ms``; a flag only proposes a candidate, it is never a cut by
   itself).
2. **Refinement**: around each candidate (±500 ms) the frame with the largest difference to its
   predecessor is the cut when that difference reaches ``cut.refine_diff_pm``. A frame the
   picture returns from (or to) within ``FLASH_FRAMES`` is a flash, not a cut.
3. **Gradual transitions** (a fade, a dissolve, a wipe): the middle frame of
   ``2·GRADUAL_HALF`` frames whose ends differ by at least ``cut.refine_diff_pm``, where no
   single frame does, and whose picture is still before and after (a pan never is).
4. **Minimum gap**: of two cuts closer than ``cut.min_gap_ms`` the stronger is kept.

A cut is the first frame of the new shot, never the window's first frame.

:func:`find_cuts` adds the fallbacks, recorded as the shot plan's ``cut_source``: FFmpeg failing
or running out of ``scan.timeout_s`` gives the pipeline's scene cuts of the words artifact
(``scene_cuts``), and without those the window is one shot (``none``).

FFmpeg runs like every ingest child (``assets``): under ``prlimit`` (2 GiB of address space, a
CPU budget from the timeout), in a session of its own, with the allowlisted environment, only
the ``file`` and ``pipe`` protocols, and never as root. Stdlib only.
"""

from __future__ import annotations

import contextlib
import math
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from operator import sub
from pathlib import Path
from typing import Any

from . import timemap as tm
from .assets import RLIMIT_AS_BYTES, child_env
from .compile_ffmpeg import seek_arg
from .shots import Rules
from .source_info import PROTOCOL_WHITELIST
from .timemap import Fps

THUMBNAIL = (64, 36)
THUMBNAIL_BYTES = THUMBNAIL[0] * THUMBNAIL[1]
LAGS = (1, 2, 3, 12)
FLASH_FRAMES = 2  # a picture back within this many frames was a flash
GRADUAL_HALF = 6  # half the span a gradual transition is measured over
STILL_SHARE = 8  # the picture beside a gradual transition changes at most 1/8 of it per 3 frames
REFINE_HALF_MS = 500
FFMPEG_THREADS = 2
SCALE = 100_000  # differences and scene scores are kept as 1/100000

_PTS = re.compile(r"^frame:\s*\d+\s+pts:\s*(-?\d+)")
_SCORE = re.compile(r"^lavfi\.scene_score=([0-9.eE+-]+)$")


class ShotCutsError(RuntimeError):
    """FFmpeg could not measure the window (it failed, was refused or ran out of time)."""


@dataclass(frozen=True)
class Profile:
    """Per grid frame of the window (index 0 = ``first_sf``): FFmpeg's scene score and the
    thumbnail differences to earlier frames, both as 1/100000 (0 where there is no earlier
    frame)."""

    first_sf: int
    scene_e5: tuple[int, ...]
    lag: Mapping[int, tuple[int, ...]]

    @property
    def frames(self) -> int:
        return len(self.scene_e5)

    def to_json(self) -> dict[str, Any]:
        return {"first_sf": self.first_sf, "scene_e5": list(self.scene_e5),
                "lag": {str(key): list(values) for key, values in sorted(self.lag.items())}}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Profile:
        scene = tuple(int(v) for v in value["scene_e5"])
        lag = {int(key): tuple(int(v) for v in values) for key, values in value["lag"].items()}
        if set(lag) != set(LAGS) or any(len(v) != len(scene) for v in lag.values()):
            raise ValueError("a profile holds every lag for every frame")
        return cls(int(value["first_sf"]), scene, lag)


@dataclass(frozen=True)
class Found:
    """The cuts (source-grid frames) and where they came from (``CUT_SOURCES``)."""

    cuts_sf: list[int]
    source: str


# --- measuring ---------------------------------------------------------------------------------


def _difference(a: bytes, b: bytes) -> int:
    total = sum(map(abs, map(sub, a, b)))
    denominator = len(a) * 255
    return (2 * total * SCALE + denominator) // (2 * denominator)


def profile_from_frames(first_sf: int, frames: Sequence[bytes],
                        scene_e5: Sequence[int]) -> Profile:
    """The profile of decoded 64×36 grey frames and their scene scores."""
    if len(scene_e5) != len(frames):
        raise ValueError("one scene score per frame")
    lag = {}
    for distance in LAGS:
        lag[distance] = tuple(0 if k < distance else _difference(frames[k], frames[k - distance])
                              for k in range(len(frames)))
    return Profile(first_sf, tuple(scene_e5), lag)


def _filter(fps: Fps, first: int, end: int) -> str:
    return (f"[0:v]fps={fps.num}/{fps.den},trim=start_pts={first}:end_pts={end},"
            f"split=2[score][small];"
            f"[score]scale=160:-2,select='gte(scene,0)',"
            f"metadata=mode=print:key=lavfi.scene_score:file=scene.txt,nullsink;"
            f"[small]scale={THUMBNAIL[0]}:{THUMBNAIL[1]},format=gray[thumbs]")


def _kill(process: subprocess.Popen) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        process.communicate()


def _scores(text: str, first: int, frames: int) -> list[int]:
    scores = [0] * frames
    pts = None
    for line in text.splitlines():
        line = line.strip()
        match = _PTS.match(line)
        if match:
            pts = int(match.group(1))
            continue
        match = _SCORE.match(line)
        if match and pts is not None and 0 <= pts - first < frames:
            value = float(match.group(1))
            if not math.isfinite(value) or value < 0:
                raise ShotCutsError("a scene score is not a number")
            scores[pts - first] = int(value * SCALE + 0.5)
    return scores


def measure(source: Path, window_ms: tuple[int, int], fps: Fps, *, timeout_s: float) -> Profile:
    """The window's profile (module notes), from one FFmpeg run. Raises :class:`ShotCutsError`
    when FFmpeg fails, is refused or runs past ``timeout_s``."""
    fps = Fps.from_json(fps)
    a, b = window_ms
    first, end = tm.sf_floor(a, fps), tm.sf_ceil(b, fps)
    if not first < end:
        raise ValueError("the window must hold a frame")
    if os.geteuid() == 0:
        raise ShotCutsError("media is never parsed as root")
    with tempfile.TemporaryDirectory(prefix="potongin-shots-") as work:
        os.chmod(work, 0o700)
        env = child_env(Path(work))
        ffmpeg = shutil.which("ffmpeg", path=env["PATH"])
        prlimit = shutil.which("prlimit", path=env["PATH"])
        if ffmpeg is None or prlimit is None:
            raise ShotCutsError("ffmpeg and prlimit are needed")
        cpu = max(1, math.ceil(timeout_s * FFMPEG_THREADS) + 1)
        argv = [prlimit, f"--as={RLIMIT_AS_BYTES}:{RLIMIT_AS_BYTES}", f"--cpu={cpu}:{cpu}", "--",
                ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error",
                *PROTOCOL_WHITELIST, "-threads", str(FFMPEG_THREADS),
                "-ss", seek_arg(first, fps), "-copyts", "-i", str(Path(source).resolve()),
                "-filter_complex", _filter(fps, first, end), "-map", "[thumbs]",
                "-f", "rawvideo", "pipe:1"]
        try:
            process = subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       start_new_session=True, close_fds=True)
        except OSError as exc:
            raise ShotCutsError("ffmpeg could not start") from exc
        try:
            out, err = process.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            _kill(process)
            raise ShotCutsError("the scan ran out of time") from None
        except BaseException:
            _kill(process)
            raise
        if process.returncode != 0:
            tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or ["?"]
            raise ShotCutsError(f"ffmpeg failed: {tail[0][:200]}")
        if not out or len(out) % THUMBNAIL_BYTES:
            raise ShotCutsError("ffmpeg returned no whole frames")
        frames = [out[i:i + THUMBNAIL_BYTES] for i in range(0, len(out), THUMBNAIL_BYTES)]
        if len(frames) > end - first:
            raise ShotCutsError("ffmpeg returned frames outside the window")
        try:
            text = (Path(work) / "scene.txt").read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError as exc:
            raise ShotCutsError("ffmpeg wrote no scene scores") from exc
    return profile_from_frames(first, frames, _scores(text, first, len(frames)))


# --- detecting ---------------------------------------------------------------------------------


def _frames_of_ms(ms: int, fps: Fps) -> int:
    return max(1, -(-ms * fps.num // (1000 * fps.den)))


def _flash(profile: Profile, k: int, threshold: int) -> bool:
    """Frame ``k`` starts or ends a picture that lasts at most ``FLASH_FRAMES`` frames."""
    n = profile.frames
    for j in range(1, FLASH_FRAMES + 1):
        after = k + j  # the frame before k against a frame shortly after it
        if after < n and profile.lag[j + 1][after] < threshold:
            return True
        if k - j - 1 >= 0 and profile.lag[j + 1][k] < threshold:  # k against before the flash
            return True
    return False


def _hard(profile: Profile, candidates: Sequence[int], fps: Fps, threshold: int
          ) -> dict[int, int]:
    half = _frames_of_ms(REFINE_HALF_MS, fps)
    diff = profile.lag[1]
    found: dict[int, int] = {}
    for c in sorted(set(candidates)):
        lo, hi = max(1, c - half), min(profile.frames, c + half)
        if lo >= hi:
            continue
        k = max(range(lo, hi), key=lambda i: (diff[i], -i))
        if diff[k] >= threshold and not _flash(profile, k, threshold):
            found[k] = diff[k]
    return found


def _gradual(profile: Profile, threshold: int) -> dict[int, int]:
    span = 2 * GRADUAL_HALF
    if span not in profile.lag:
        raise ValueError("the profile lacks the gradual lag")
    wide, step, still = profile.lag[span], profile.lag[1], profile.lag[3]
    n = profile.frames
    qualifies: list[tuple[int, int]] = []
    for k in range(GRADUAL_HALF + 3, n - GRADUAL_HALF - 3):
        change = wide[k + GRADUAL_HALF]  # frame k + half against frame k − half
        if change < threshold:
            continue
        if max(step[k - GRADUAL_HALF + 1:k + GRADUAL_HALF + 1]) >= threshold:
            continue  # a hard cut is inside: the refinement finds it
        if (still[k - GRADUAL_HALF] * STILL_SHARE > change
                or still[k + GRADUAL_HALF + 3] * STILL_SHARE > change):
            continue  # the picture moves before or after: a pan, not a transition
        qualifies.append((k, change))
    found: dict[int, int] = {}
    run: list[tuple[int, int]] = []
    for item in [*qualifies, (-10, 0)]:
        if run and item[0] != run[-1][0] + 1:
            k, change = max(run, key=lambda p: (p[1], -p[0]))
            found[k] = change
            run = []
        run.append(item)
    return found


def detect(profile: Profile, fps: Fps, *, rules: Rules,
           coarse_cuts_ms: Sequence[int] = ()) -> list[int]:
    """The cuts of the profiled window as source-grid frames (module notes, steps 1–4)."""
    fps = Fps.from_json(fps)
    threshold = rules.cut_refine_diff_pm * (SCALE // 1000)
    coarse = rules.cut_coarse_scene_pm * (SCALE // 1000)
    candidates = [k for k, score in enumerate(profile.scene_e5) if k > 0 and score > coarse]
    for ms in coarse_cuts_ms:
        k = tm.sf_floor(ms, fps) - profile.first_sf
        if 0 < k < profile.frames:
            candidates.append(k)
    strength = _gradual(profile, threshold)
    strength.update(_hard(profile, candidates, fps, threshold))
    gap = _frames_of_ms(rules.cut_min_gap_ms, fps) if rules.cut_min_gap_ms else 0
    kept: list[int] = []
    for k, _value in sorted(strength.items(), key=lambda item: (-item[1], item[0])):
        if all(abs(k - other) >= gap for other in kept):
            kept.append(k)
    return sorted(profile.first_sf + k for k in kept if k > 0)


def _scene_fallback(scene_cuts_ms: Sequence[int], window_sf: tuple[int, int],
                    fps: Fps) -> list[int]:
    cuts = sorted({tm.sf_floor(int(ms), fps) for ms in scene_cuts_ms})
    return [sf for sf in cuts if window_sf[0] < sf < window_sf[1]]


def find_cuts(source: Path, window_ms: tuple[int, int], fps: Fps, *, rules: Rules,
              coarse_cuts_ms: Sequence[int] = (), scene_cuts_ms: Sequence[int] = (),
              timing: dict[str, float] | None = None) -> Found:
    """The window's cuts with the fallbacks of the module notes. ``timing``, when given, gets
    the seconds the scan took (``scan_s``)."""
    fps = Fps.from_json(fps)
    window_sf = (tm.sf_floor(window_ms[0], fps), tm.sf_ceil(window_ms[1], fps))
    began = time.perf_counter()
    try:
        profile = measure(source, window_ms, fps, timeout_s=rules.scan_timeout_s)
    except ShotCutsError:
        cuts = _scene_fallback(scene_cuts_ms, window_sf, fps)
        return Found(cuts, "scene_cuts" if cuts else "none")
    finally:
        if timing is not None:
            timing["scan_s"] = time.perf_counter() - began
    return Found(detect(profile, fps, rules=rules, coarse_cuts_ms=coarse_cuts_ms), "shot_cuts")


__all__ = [
    "FLASH_FRAMES",
    "GRADUAL_HALF",
    "LAGS",
    "Found",
    "Profile",
    "ShotCutsError",
    "detect",
    "find_cuts",
    "measure",
    "profile_from_frames",
]
