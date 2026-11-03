"""Shot cuts of a clip window on the document grid (rombak 04 §A3).

One FFmpeg run decodes the window ``[sf_floor(a), sf_ceil(b))`` exactly as the compiler does
(``-ss`` with a second of pre-roll, ``-copyts``, ``fps=num/den`` and ``trim`` on the grid
index), and measures every grid frame three times (:func:`measure`):

* FFmpeg's ``scene`` score on a 160 px wide picture (the filter of
  ``audio_timeline._SCENE_FILTER``, keeping every frame so any threshold can be applied later);
* the 64×36 grey picture, from which the mean absolute difference to the frame 1, 2, 3 and 12
  frames before is kept (``Profile.lag``, as 1/100000 of 255);
* the edges of the 320×180 grey picture (FFmpeg's ``edgedetect``), against those of the frame
  before: the share of this frame's edges that have no edge within a pixel in the frame before,
  plus the share of that frame's edges that have none here (``Profile.edge_pm``, 0 to 2000). A
  new picture replaces the edges; a shape changing colour or a person moving leaves most of them
  where they were, whatever the size of the difference. Pictures with few edges count against
  ``EDGE_FLOOR``, so that a few pixels of a nearly empty picture are no change of composition.

:func:`detect` then finds the cuts with the rules of ``resources/reframe/rules.v1.json``:

1. **Candidates**: frames whose scene score is above ``cut.coarse_scene_pm``, and the camera
   plan's cut flags (``coarse_cuts_ms``; a flag only proposes a candidate, it is never a cut by
   itself).
2. **Refinement**: around each candidate (±500 ms) the frame with the largest difference to its
   predecessor is the cut when that difference reaches ``cut.refine_diff_pm`` and the frame
   carries at least half of the change across it (a step of a dissolve or of a camera move does
   not). A frame the picture returns from (or to) within ``FLASH_FRAMES`` is a flash, not a cut.
3. **Lone jumps**: a difference of at least half ``cut.refine_diff_pm`` that is ``JUMP_RATIO``
   times both neighbours' is a cut between two similar pictures (the scene score misses those),
   under the same two conditions. Under ``cut.refine_diff_pm`` itself the edges must confirm it
   (``EDGE_CONFIRM_PM``).
4. **Edge jumps**: an edge change of at least ``EDGE_JUMP_PM`` that stands out from both
   neighbours (``EDGE_ALONE``), or of at least ``EDGE_SETTLED_PM`` after which the picture settles
   (twice the next frame's: a transition ending in a new picture), is a cut however small the
   difference is: flat pictures, slides. A picture that returns within ``FLASH_FRAMES``, measured
   against the jump's own difference, is still a flash.
5. **Gradual transitions** (a fade, a dissolve, a wipe): ``2·GRADUAL_HALF`` frames whose ends
   differ by at least ``cut.refine_diff_pm``, where no single frame carries half of it, and
   whose picture is still before and after (a pan never is). The cut is the first frame by which
   half of the frame-to-frame change has happened; two transitions within ``DIP_FRAMES`` are one
   dip through black or white, cut where the new picture arrives.
6. **Minimum gap**: of two cuts closer than ``cut.min_gap_ms`` the stronger is kept.

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
import threading
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
EDGE_SIZE = (320, 180)
EDGE_BYTES = EDGE_SIZE[0] * EDGE_SIZE[1]
EDGE_LOW, EDGE_HIGH = 0.08, 0.2  # edgedetect's thresholds
EDGE_FLOOR = EDGE_BYTES // 100  # a share counts against at least 1% of the picture's pixels
EDGE_CONFIRM_PM = 800  # a lone jump under the refine threshold changes at least this much
EDGE_JUMP_PM = 1100  # an edge change this large that stands out is a cut by itself
EDGE_ALONE = (3, 2)  # ... standing out: at least 3/2 of both neighbours'
EDGE_SETTLED_PM = 1500  # ... or this large, and at least twice the next frame's
# a stacked frame of the pipe: the thumbnail, padded to the edge picture's width, on the edges
FRAME_BYTES = EDGE_SIZE[0] * THUMBNAIL[1] + EDGE_BYTES
LAGS = (1, 2, 3, 12)
FLASH_FRAMES = 2  # a picture back within this many frames was a flash
GRADUAL_HALF = 6  # half the span a gradual transition is measured over
STILL_SHARE = 8  # the picture beside a gradual transition changes at most 1/8 of it per 3 frames
ABRUPT_SHARE = 2  # a cut's frame carries at least half of the change across it
JUMP_RATIO = 4  # a difference this many times both neighbours' is a candidate by itself
JUMP_SHARE = 2  # ... and a cut from half the refine threshold (two similar pictures)
DIP_FRAMES = 4 * GRADUAL_HALF  # two transitions this close are one dip through black/white
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
    thumbnail differences to earlier frames, both as 1/100000, and the edge change to the frame
    before, 0 to 2000 (all 0 where there is no earlier frame)."""

    first_sf: int
    scene_e5: tuple[int, ...]
    lag: Mapping[int, tuple[int, ...]]
    edge_pm: tuple[int, ...]

    @property
    def frames(self) -> int:
        return len(self.scene_e5)

    def to_json(self) -> dict[str, Any]:
        return {"first_sf": self.first_sf, "scene_e5": list(self.scene_e5),
                "lag": {str(key): list(values) for key, values in sorted(self.lag.items())},
                "edge_pm": list(self.edge_pm)}

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> Profile:
        scene = tuple(int(v) for v in value["scene_e5"])
        lag = {int(key): tuple(int(v) for v in values) for key, values in value["lag"].items()}
        if set(lag) != set(LAGS) or any(len(v) != len(scene) for v in lag.values()):
            raise ValueError("a profile holds every lag for every frame")
        edge_pm = tuple(int(v) for v in value["edge_pm"])
        if len(edge_pm) != len(scene):
            raise ValueError("a profile holds the edge change of every frame")
        return cls(int(value["first_sf"]), scene, lag, edge_pm)


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


_EDGE_DIGITS = bytes.maketrans(bytes(range(256)), b"0" + b"1" * 255)
_EDGE_ALL = (1 << EDGE_BYTES) - 1
_EDGE_NOT_FIRST = int(("0" + "1" * (EDGE_SIZE[0] - 1)) * EDGE_SIZE[1], 2)
_EDGE_NOT_LAST = int(("1" * (EDGE_SIZE[0] - 1) + "0") * EDGE_SIZE[1], 2)


class _Edges:
    """A frame's edge pixels as one big integer, the top left pixel its highest bit, and the
    pixels within one pixel of them."""

    __slots__ = ("bits", "count", "near")

    def __init__(self, picture: bytes) -> None:
        bits = int(picture.translate(_EDGE_DIGITS), 2)
        self.bits = bits
        self.count = bits.bit_count()
        wide = bits | ((bits >> 1) & _EDGE_NOT_FIRST) | ((bits << 1) & _EDGE_NOT_LAST)
        self.near = (wide | (wide >> EDGE_SIZE[0]) | (wide << EDGE_SIZE[0])) & _EDGE_ALL

    def change_from(self, before: _Edges) -> int:
        """The share of these edges new since ``before`` plus the share of its edges gone."""
        entering = (self.bits & ~before.near).bit_count()
        leaving = (before.bits & ~self.near).bit_count()
        return (entering * 1000 // max(self.count, EDGE_FLOOR)
                + leaving * 1000 // max(before.count, EDGE_FLOOR))


def profile_from_frames(first_sf: int, frames: Sequence[bytes],
                        scene_e5: Sequence[int], edge_pm: Sequence[int]) -> Profile:
    """The profile of decoded 64×36 grey frames, their scene scores and edge changes."""
    if len(scene_e5) != len(frames) or len(edge_pm) != len(frames):
        raise ValueError("one scene score and one edge change per frame")
    lag = {}
    for distance in LAGS:
        lag[distance] = tuple(0 if k < distance else _difference(frames[k], frames[k - distance])
                              for k in range(len(frames)))
    return Profile(first_sf, tuple(scene_e5), lag, tuple(edge_pm))


def _filter(fps: Fps, first: int, end: int) -> str:
    return (f"[0:v]fps={fps.num}/{fps.den},trim=start_pts={first}:end_pts={end},"
            f"split=3[score][small][fine];"
            f"[score]scale=160:-2,select='gte(scene,0)',"
            f"metadata=mode=print:key=lavfi.scene_score:file=scene.txt,nullsink;"
            f"[small]scale={THUMBNAIL[0]}:{THUMBNAIL[1]},format=gray,"
            f"pad={EDGE_SIZE[0]}:{THUMBNAIL[1]}[thumbs];"
            f"[fine]scale={EDGE_SIZE[0]}:{EDGE_SIZE[1]},format=gray,"
            f"edgedetect=low={EDGE_LOW}:high={EDGE_HIGH}[edges];"
            f"[thumbs][edges]vstack[stacked]")


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


def _read_frames(process: subprocess.Popen, limit: int) -> tuple[list[bytes], list[int]]:
    """The thumbnails and edge changes of the stacked frames on the process's stdout. The frames
    are not kept: a window of edge pictures would be 200 MB."""
    width, height = EDGE_SIZE[0], THUMBNAIL[1]
    thumbs: list[bytes] = []
    changes: list[int] = []
    before = None
    while True:
        frame = process.stdout.read(FRAME_BYTES)
        if not frame:
            return thumbs, changes
        if len(frame) != FRAME_BYTES:
            raise ShotCutsError("ffmpeg returned no whole frames")
        if len(thumbs) == limit:
            raise ShotCutsError("ffmpeg returned frames outside the window")
        thumbs.append(b"".join(frame[y * width:y * width + THUMBNAIL[0]] for y in range(height)))
        edges = _Edges(frame[width * height:])
        changes.append(0 if before is None else edges.change_from(before))
        before = edges


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
                "-filter_complex", _filter(fps, first, end), "-map", "[stacked]",
                "-f", "rawvideo", "pipe:1"]
        errors = Path(work) / "stderr.txt"
        try:
            with errors.open("wb") as sink:
                process = subprocess.Popen(argv, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=sink,
                                           start_new_session=True, close_fds=True)
        except OSError as exc:
            raise ShotCutsError("ffmpeg could not start") from exc
        expired = threading.Event()

        def expire() -> None:
            expired.set()
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)

        watchdog = threading.Timer(timeout_s, expire)
        watchdog.daemon = True
        watchdog.start()
        try:
            try:
                frames, changes = _read_frames(process, end - first)
                process.wait()
            except ShotCutsError:
                if expired.is_set():
                    raise ShotCutsError("the scan ran out of time") from None
                _kill(process)
                raise
            except BaseException:
                _kill(process)
                raise
        finally:
            watchdog.cancel()
            process.stdout.close()
        if expired.is_set():
            raise ShotCutsError("the scan ran out of time")
        if process.returncode != 0:
            err = errors.read_text(encoding="utf-8", errors="replace")
            tail = err.strip().splitlines()[-1:] or ["?"]
            raise ShotCutsError(f"ffmpeg failed: {tail[0][:200]}")
        if not frames:
            raise ShotCutsError("ffmpeg returned no whole frames")
        try:
            text = (Path(work) / "scene.txt").read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError as exc:
            raise ShotCutsError("ffmpeg wrote no scene scores") from exc
    return profile_from_frames(first, frames, _scores(text, first, len(frames)), changes)


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


def _abrupt(profile: Profile, k: int) -> bool:
    """Frame ``k`` carries at least half of the change across it (from the frame two before
    to the frame after): a cut, not a step of a dissolve or of a camera move."""
    after = min(k + 1, profile.frames - 1)
    across = profile.lag[3][after] if after >= 3 else profile.lag[1][k]
    return ABRUPT_SHARE * profile.lag[1][k] >= across


def _isolated(profile: Profile, threshold: int, confirmed_under: int) -> dict[int, int]:
    """Cuts between two similar pictures, which the scene score passes over: a difference of
    at least ``threshold`` that stands alone (``JUMP_RATIO`` times both neighbours'), carries
    the change across it and is no flash. Under ``confirmed_under`` the edges must confirm it."""
    diff = profile.lag[1]
    edges = profile.edge_pm
    n = profile.frames
    found = {}
    for k in range(1, n):
        if diff[k] < threshold or (diff[k] < confirmed_under and edges[k] < EDGE_CONFIRM_PM):
            continue
        neighbours = max(diff[k - 1] if k > 1 else 0, diff[k + 1] if k + 1 < n else 0)
        if (diff[k] >= JUMP_RATIO * neighbours and _abrupt(profile, k)
                and not _flash(profile, k, threshold)):
            found[k] = diff[k]
    return found


def _edge_jumps(profile: Profile, threshold: int) -> dict[int, int]:
    """Cuts the edges show, whatever the difference: a large edge change that stands out from
    both neighbours, or a larger one after which the picture settles, and no flash. A flash is
    measured against the frame's own difference, which can be far under ``threshold``."""
    edges, diff = profile.edge_pm, profile.lag[1]
    n = profile.frames
    found = {}
    for k in range(1, n):
        change = edges[k]
        if change < EDGE_JUMP_PM:
            continue
        after = edges[k + 1] if k + 1 < n else 0
        alone = EDGE_ALONE[1] * change >= EDGE_ALONE[0] * max(edges[k - 1], after)
        settled = change >= EDGE_SETTLED_PM and change >= 2 * after
        if (alone or settled) and not _flash(profile, k, min(threshold, diff[k] // JUMP_SHARE)):
            found[k] = diff[k]
    return found


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
        if (diff[k] >= threshold and _abrupt(profile, k)
                and not _flash(profile, k, threshold)):
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
        if ABRUPT_SHARE * max(step[k - GRADUAL_HALF + 1:k + GRADUAL_HALF + 1]) >= change:
            continue  # one frame carries half of it: a cut, which the refinement finds
        if (still[k - GRADUAL_HALF] * STILL_SHARE > change
                or still[k + GRADUAL_HALF + 3] * STILL_SHARE > change):
            continue  # the picture moves before or after: a pan, not a transition
        qualifies.append((k, change))
    transitions: list[tuple[int, int]] = []
    run: list[tuple[int, int]] = []
    for item in [*qualifies, (-10, 0)]:
        if run and item[0] != run[-1][0] + 1:
            centre, change = max(run, key=lambda p: (p[1], -p[0]))
            frame = _half_way(step, centre)
            # a dip through black or white is the old picture leaving, then the new one
            # arriving: one cut, where the new picture arrives
            if transitions and frame - transitions[-1][0] <= DIP_FRAMES:
                transitions.pop()
            transitions.append((frame, change))
            run = []
        run.append(item)
    return dict(transitions)


def _half_way(step: Sequence[int], centre: int) -> int:
    """The first frame of a transition around ``centre`` by which half of its frame-to-frame
    change has happened: where the new picture is at least half there."""
    frames = range(centre - GRADUAL_HALF + 1, centre + GRADUAL_HALF + 1)
    total = sum(step[k] for k in frames)
    done = 0
    for k in frames:
        done += step[k]
        if 2 * done >= total:
            return k
    return centre


def detect(profile: Profile, fps: Fps, *, rules: Rules,
           coarse_cuts_ms: Sequence[int] = ()) -> list[int]:
    """The cuts of the profiled window as source-grid frames (module notes, steps 1–6)."""
    fps = Fps.from_json(fps)
    threshold = rules.cut_refine_diff_pm * (SCALE // 1000)
    coarse = rules.cut_coarse_scene_pm * (SCALE // 1000)
    candidates = [k for k, score in enumerate(profile.scene_e5) if k > 0 and score > coarse]
    for ms in coarse_cuts_ms:
        k = tm.sf_floor(ms, fps) - profile.first_sf
        if 0 < k < profile.frames:
            candidates.append(k)
    strength = _gradual(profile, threshold)
    strength.update(_isolated(profile, threshold // JUMP_SHARE, threshold))
    strength.update(_edge_jumps(profile, threshold // JUMP_SHARE))
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
    "EDGE_SIZE",
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
