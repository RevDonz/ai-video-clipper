"""The cold-open transition: the effect and the whoosh at the join (spec 2026-10-02).

A document's join (``main.joins[0]``, after the cold-open segment) has a ``style`` and an
optional ``sfx``. Neither moves a frame or a sample: pieces, captions, the time map and the
speech envelope are those of a plain cut. Instead:

* **Picture.** ``flash_white`` and ``dip_black`` blend the video layer (under the captions, hook
  and logo) toward a constant colour on a symmetric triangle peaking on ``J``, the first output
  frame after the join. The alpha of output frame ``n`` is sampled at the frame's start,
  ``τ = (n − J)·den/num`` s: ``alpha(τ) = max(0, 1 − |τ|/W)`` with the half-width ``W`` of the
  style (100 ms, 150 ms), as an exact integer in per mille (:func:`alpha_pm`). edit-v2 applies
  it with one ``lutrgb`` per affected frame in the planar-RGB composite (:func:`lut_chain`); the
  browser fills the canvas with the same colour and alpha (:func:`joins_dto`).
* **Sound.** The whoosh (``resources/sfx/whoosh/v1.wav``, pinned by sha256 in :data:`SFX`) is
  added at unity gain to the pre-master mix with its hit (file sample 11,520) on ``smp(J)``.

Nothing here depends on ``plan``, ``compile_ffmpeg`` or ``render``: the legacy renderer imports
this module as well. Stdlib only.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import wave
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import errors
from . import timemap as tm
from .glyphs import RESOURCES_DIR
from .timemap import Fps, Piece

JOIN_STYLES = ("cut", "flash_white", "dip_black")
DISABLED_JOIN_STYLES = ("xfade",)  # overlaps the pieces, so it would move every caption
HALF_WIDTH_MS = {"flash_white": 100, "dip_black": 150}
RGB = {"flash_white": (255, 255, 255), "dip_black": (0, 0, 0)}
YUV_TV = {"flash_white": (235, 128, 128), "dip_black": (16, 128, 128)}  # legacy, 8-bit TV range

SFX_SAMPLE_RATE = 48_000
SFX_CHANNELS = 2
SFX_MAX_BYTES = 1 << 20
LATEST_SFX = {"whoosh": 1}  # the version a new join names (a later sound is a new version)


@dataclass(frozen=True)
class SfxSpec:
    """A pinned sound effect: ``resources/sfx/<id>/v<v>.wav`` with this sha256."""

    id: str
    v: int
    sha256: str
    samples: int  # frames of the file (48 kHz stereo s16le)
    hit_smp: int  # the file sample that lands on the join


SFX: Mapping[tuple[str, int], SfxSpec] = {
    ("whoosh", 1): SfxSpec(
        id="whoosh", v=1,
        sha256="a722efe71a615aec8857742f8a5627164c58c2f2fa2956de165e5e1b0c6c7fa5",
        samples=20_160, hit_smp=11_520),
}


@dataclass(frozen=True)
class SfxPlan:
    id: str  # "whoosh"
    v: int  # 1
    sha256: str  # the pinned WAV sha (SFX[(id, v)].sha256)
    start_smp: int  # output sample where the whoosh's first used sample plays
    skip_smp: int  # whoosh samples dropped at its head (0 in every valid document)
    samples: int  # whoosh samples used = spec.samples - skip_smp
    hit_smp: int  # output sample of the hit = smp(at_f)

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "v": self.v, "sha256": self.sha256, "start_smp": self.start_smp,
                "skip_smp": self.skip_smp, "samples": self.samples, "hit_smp": self.hit_smp}


@dataclass(frozen=True)
class JoinPlan:
    after: str  # "seg_co"
    style: str  # "cut" | "flash_white" | "dip_black"
    at_f: int  # J, the first output frame after the join
    alpha: tuple[tuple[int, int], ...]  # (output frame, alpha_pm) for alpha_pm > 0, ascending
    sfx: SfxPlan | None

    @property
    def visible(self) -> bool:
        """True when the join changes the render (an effect or a sound)."""
        return self.style != "cut" or self.sfx is not None

    def to_json(self) -> dict[str, Any]:
        """The plan-JSON form (hashed into ``plan_sha256``)."""
        return {"after": self.after, "style": self.style, "at_f": self.at_f,
                "alpha_pm": [[frame, alpha] for frame, alpha in self.alpha],
                "sfx": None if self.sfx is None else self.sfx.to_json()}


# --- the join of an auto render (manifest ``cold_open_join``, seed context ``coldOpenJoin``) ----


@dataclass(frozen=True)
class ColdOpenJoin:
    """The style and sound an auto render used at its cold-open join."""

    style: str
    sfx: str | None  # None or "whoosh" (the latest version of it)

    def __post_init__(self) -> None:
        if self.style not in JOIN_STYLES:
            raise ValueError(f"unknown join style: {self.style!r}")
        if self.sfx is not None and self.sfx not in LATEST_SFX:
            raise ValueError(f"unknown join sound: {self.sfx!r}")

    def sfx_json(self) -> dict[str, Any] | None:
        return None if self.sfx is None else {"id": self.sfx, "v": LATEST_SFX[self.sfx]}

    def to_json(self) -> dict[str, Any]:
        """``{"style": …, "sfx": {"id", "v"} | null}``: the manifest and seed-context form."""
        return {"style": self.style, "sfx": self.sfx_json()}

    @classmethod
    def from_json(cls, value: object) -> ColdOpenJoin | None:
        """Strict inverse of :meth:`to_json` (exactly ``style`` and ``sfx``, a known style, and
        ``sfx`` null or a known ``{id, v}``); anything else is None."""
        if type(value) is not dict or set(value) != {"style", "sfx"}:
            return None
        style, sfx = value["style"], value["sfx"]
        if type(style) is not str or style not in JOIN_STYLES:
            return None
        if sfx is None:
            return cls(style, None)
        if (type(sfx) is not dict or set(sfx) != {"id", "v"} or type(sfx["id"]) is not str
                or type(sfx["v"]) is not int or LATEST_SFX.get(sfx["id"]) != sfx["v"]):
            return None
        return cls(style, sfx["id"])

    def doc_join(self, after: str, audio_fade_ms: int) -> dict[str, Any]:
        """The document join; ``sfx`` is absent (never null) without a sound."""
        join: dict[str, Any] = {"after": after, "style": self.style,
                                "audio_fade_ms": audio_fade_ms}
        if self.sfx is not None:
            join["sfx"] = self.sfx_json()
        return join


AUTO_COLD_OPEN_JOIN = ColdOpenJoin("flash_white", "whoosh")
CUT_JOIN = ColdOpenJoin("cut", None)


# --- frame math ------------------------------------------------------------------------------


def alpha_pm(style: str, k: int, fps: Fps) -> int:
    """Alpha (per mille, 0–1000) of the output frame ``k`` frames after the join's first frame
    (``k < 0``: the cold-open side): ``round_half_up(1000·v / (W·num))`` with
    ``v = W·num − 1000·|k|·den`` when ``v > 0``, else 0. ``cut`` is always 0."""
    if style not in JOIN_STYLES:
        raise ValueError(f"unknown join style: {style!r}")
    if type(k) is not int:
        raise TypeError("k must be an integer")
    if style == "cut":
        return 0
    width = HALF_WIDTH_MS[style]
    value = width * fps.num - 1000 * abs(k) * fps.den
    if value <= 0:
        return 0
    return tm.div_round_half_up(1000 * value, width * fps.num)


def side_frames(style: str, fps: Fps) -> tuple[int, int]:
    """(frames before the join, frames from the join on) with an alpha above 0:
    ``(⌈W·F⌉ − 1, ⌈W·F⌉)``; ``(0, 0)`` for ``cut``."""
    if style == "cut":
        return 0, 0
    if style not in HALF_WIDTH_MS:
        raise ValueError(f"unknown join style: {style!r}")
    after = -(-HALF_WIDTH_MS[style] * fps.num // (1000 * fps.den))
    return after - 1, after


def join_alpha(style: str, at_f: int, total_frames: int, fps: Fps) -> tuple[tuple[int, int], ...]:
    """``(frame, alpha_pm)`` of every output frame in ``[0, total_frames)`` with an alpha above
    0, ascending. Frames outside the clip are dropped; the others keep their alpha."""
    before, after = side_frames(style, fps)
    frames = []
    for k in range(-before - 1, after + 1):
        frame = at_f + k
        alpha = alpha_pm(style, k, fps)
        if alpha > 0 and 0 <= frame < total_frames:
            frames.append((frame, alpha))
    return tuple(frames)


def sfx_plan(spec: SfxSpec, at_f: int, fps: Fps) -> SfxPlan:
    """Where the sound plays: its hit on ``smp(at_f)``; a head that would start before the
    clip is skipped."""
    hit = tm.smp(at_f, fps)
    skip = max(0, spec.hit_smp - hit)
    return SfxPlan(id=spec.id, v=spec.v, sha256=spec.sha256, start_smp=max(0, hit - spec.hit_smp),
                   skip_smp=skip, samples=spec.samples - skip, hit_smp=hit)


def plan_joins(doc: Mapping[str, Any], pieces: Sequence[Piece], fps: Fps,
               total_frames: int) -> tuple[JoinPlan, ...]:
    """One :class:`JoinPlan` per document join, in document order.

    ``J`` is the sum of the frames of the pieces of the ``after`` segment. Raises
    ``DocSemanticInvalid`` (``cold_open_invalid``) when that segment has no pieces or no piece
    follows it, and (``sfx_unknown``) for a sound that is not pinned; a validated document has
    neither.
    """
    result = []
    for index, join in enumerate(doc["main"]["joins"]):
        path = f"/main/joins/{index}"
        after = join["after"]
        frames = [piece.frames for piece in pieces if piece.seg == after]
        at_f = sum(frames)
        if not frames or at_f >= total_frames:
            raise errors.DocSemanticInvalid("cold_open_invalid", path=path)
        sfx = None
        if "sfx" in join:
            spec = SFX.get((join["sfx"]["id"], join["sfx"]["v"]))
            if spec is None:
                raise errors.DocSemanticInvalid("sfx_unknown", path=f"{path}/sfx")
            sfx = sfx_plan(spec, at_f, fps)
        style = join["style"]
        result.append(JoinPlan(after=after, style=style, at_f=at_f,
                               alpha=join_alpha(style, at_f, total_frames, fps), sfx=sfx))
    return tuple(result)


# --- FFmpeg (edit-v2) and the plan DTO -------------------------------------------------------


def _seconds(numerator: int, denominator: int) -> str:
    """``numerator/denominator`` seconds rounded half up to 6 decimals, ``%d.%06d`` (≥ 0)."""
    micro = max(0, tm.div_round_half_up(numerator * 1_000_000, denominator))
    return f"{micro // 1_000_000}.{micro % 1_000_000:06d}"


def lut_chain(joins: Iterable[JoinPlan], fps: Fps, composite: str = "gbrp") -> str:
    """The effect for the composite's text chain: ``""`` without an alpha; otherwise ``","``
    and one ``lutrgb`` per affected frame, in frame order, each enabled on exactly its frame
    (``t`` is ``n·den/num`` after ``settb=den/num``; the window is ± half a frame).

    Raises ``ValueError`` when there is an alpha and ``composite`` is not ``gbrp``."""
    entries = sorted((frame, alpha, RGB[join.style][0])
                     for join in joins for frame, alpha in join.alpha)
    if not entries:
        return ""
    if composite != "gbrp":
        raise ValueError("the cold-open effect is composited in gbrp only")
    filters = []
    for frame, alpha, colour in entries:
        expr = f"floor((val*{1000 - alpha}+{colour * alpha + 500})/1000)"
        low = _seconds((2 * frame - 1) * fps.den, 2 * fps.num)
        high = _seconds((2 * frame + 1) * fps.den, 2 * fps.num)
        filters.append(f"lutrgb=r={expr}:g={expr}:b={expr}:enable='between(t,{low},{high})'")
    return "," + ",".join(filters)


def joins_dto(joins: Iterable[JoinPlan]) -> list[dict[str, Any]]:
    """The plan DTO's ``joins`` (``preview/plan``): every join, ``[]`` without one."""
    dto = []
    for join in joins:
        rgb = RGB.get(join.style)
        sfx = join.sfx
        dto.append({
            "after": join.after, "style": join.style, "atF": join.at_f,
            "rgb": None if rgb is None else list(rgb),
            "alphaPm": [[frame, alpha] for frame, alpha in join.alpha],
            "sfx": None if sfx is None else {"id": sfx.id, "v": sfx.v, "startSmp": sfx.start_smp,
                                             "hitSmp": sfx.hit_smp, "samples": sfx.samples},
        })
    return dto


# --- the pinned files ------------------------------------------------------------------------


def sfx_path(resources_root: Path | str, spec: SfxSpec) -> Path:
    """``<resources>/sfx/<id>/v<v>.wav``."""
    return Path(resources_root) / "sfx" / spec.id / f"v{spec.v}.wav"


def _pinned_bytes(path: Path, spec: SfxSpec) -> tuple[bytes, os.stat_result]:
    """The file's bytes (regular file, no final symlink) when its sha256 is the pin."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError as error:
        raise errors.RenderFailed("render_failed", ref="sfx") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > SFX_MAX_BYTES:
            raise errors.RenderFailed("render_failed", ref="sfx")
        chunks = []
        while chunk := os.read(fd, 1 << 16):
            chunks.append(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if hashlib.sha256(data).hexdigest() != spec.sha256:
        raise errors.RenderFailed("render_failed", ref="sfx")
    return data, info


def sfx_file(resources_root: Path | str, spec: SfxSpec) -> Path:
    """The path of the pinned file after checking it (the legacy engine opens it itself).

    Raises ``RenderFailed`` (``render_failed``, ``ref="sfx"``) when it is missing or changed."""
    path = sfx_path(resources_root, spec)
    _pinned_bytes(path, spec)
    return path


_PCM_CACHE: dict[tuple[str, int, int], bytes] = {}


def load_sfx_pcm(resources_root: Path | str, spec: SfxSpec) -> bytes:
    """The interleaved s16le frames of the pinned file (48 kHz, stereo, ``spec.samples``),
    checked against the pin; cached per process by (path, size, mtime).

    Raises ``RenderFailed`` (``render_failed``, ``ref="sfx"``) when it is missing, changed or
    not that format."""
    path = sfx_path(resources_root, spec)
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError as error:
        raise errors.RenderFailed("render_failed", ref="sfx") from error
    key = (str(path), info.st_size, info.st_mtime_ns)
    cached = _PCM_CACHE.get(key)
    if cached is not None:
        return cached
    data, _info = _pinned_bytes(path, spec)
    try:
        with wave.open(io.BytesIO(data), "rb") as handle:
            if (handle.getframerate(), handle.getnchannels(), handle.getsampwidth(),
                    handle.getnframes()) != (SFX_SAMPLE_RATE, SFX_CHANNELS, 2, spec.samples):
                raise errors.RenderFailed("render_failed", ref="sfx")
            frames = handle.readframes(spec.samples)
    except (wave.Error, EOFError) as error:
        raise errors.RenderFailed("render_failed", ref="sfx") from error
    if len(frames) != spec.samples * SFX_CHANNELS * 2:
        raise errors.RenderFailed("render_failed", ref="sfx")
    _PCM_CACHE[key] = frames
    return frames


def default_resources() -> Path:
    """The repository's (or the image's) ``resources/``."""
    return RESOURCES_DIR


__all__ = [
    "AUTO_COLD_OPEN_JOIN",
    "CUT_JOIN",
    "DISABLED_JOIN_STYLES",
    "HALF_WIDTH_MS",
    "JOIN_STYLES",
    "LATEST_SFX",
    "RGB",
    "SFX",
    "YUV_TV",
    "ColdOpenJoin",
    "JoinPlan",
    "SfxPlan",
    "SfxSpec",
    "alpha_pm",
    "default_resources",
    "join_alpha",
    "joins_dto",
    "load_sfx_pcm",
    "lut_chain",
    "plan_joins",
    "sfx_file",
    "sfx_path",
    "sfx_plan",
    "side_frames",
]
