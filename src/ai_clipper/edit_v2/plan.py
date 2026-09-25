"""Resolve a document once into a ``RenderPlan`` and derive the render key (plan §5.1, §5.2 R9).

``build_plan`` is the single resolver: pieces and samples from the time map, the caption track
(``captions.caption_track``, T1.2a), the speech and music envelopes (``envelope``, T1.4), the
logo box, the camera plan and the warnings that come from them. Everything a render depends on
is hashed into ``plan_sha256``:

* the document's **content** (canonical bytes without ``revision``, ``parent_sha256`` and
  ``audit``), so an undo back to the seed gives the seed's plan;
* the words artifact, the camera plan (camera layout only), the asset metadata, the ASS bytes
  (through their sha) and the envelope breakpoints (they determine the f32 bytes exactly);
* the compiler id and ``RENDER_SEMANTICS``, so a pixel-changing compiler change never matches
  an older auto render (``rev0.exact``).

The render key (R9) adds what can change the pixels without changing the plan: the compiler
version, ``resources/toolchain.json`` (FFmpeg, libass, freetype, harfbuzz, fribidi, fontconfig,
base image), ``fonts.json``, the pack and hook-design files the document uses, size, quality and
the loudness/peak measurement.

``RenderPlan``'s first nine fields are frozen because other tasks read them (T1.4's
``audio_fragment``, the fixture plan builder, W2's preview lane); the fields after them have
defaults.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import COMPILER_ID, COMPILER_VERSION, OUTPUT_SIZES, RENDER_SEMANTICS, errors
from . import captions as _captions
from . import envelope as _envelope
from . import timemap as tm
from .captions import CaptionResult
from .doc import Issue
from .layouts import LAYOUT_MODES
from .timemap import Fps, Piece

PLAN_SCHEMA = "potongin.render-plan/1"
RENDER_KEY_PREFIX = b"potongin-render-v1\0"
# TikTok UI zone at 720×1280 (plan §5.9 G5): top, bottom, right; scaled to other sizes.
UI_ZONE_720 = (93, 280, 93)

_HEX64 = re.compile(r"[0-9a-f]{64}")
_RESOURCE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_CONTENT_EXCLUDED = ("revision", "parent_sha256", "audit")


def canonical_bytes(value: Any) -> bytes:
    """Plan §3.1 canonical JSON: sorted keys, no spaces, UTF-8, no NaN."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _sha(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _file_sha(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except FileNotFoundError:
        return None


def content_of(doc: Mapping[str, Any]) -> dict[str, Any]:
    """The document's content: everything except ``revision``, ``parent_sha256`` and ``audit``
    (the same definition as ``doc.content_sha256``, R10)."""
    return {key: value for key, value in doc.items() if key not in _CONTENT_EXCLUDED}


@dataclass(frozen=True)
class Resources:
    """Where the pinned resources live (fonts, caption packs, hook designs, toolchain.json).

    ``root`` is the repository ``resources/`` directory (``/app/resources`` in the image).
    """

    root: Path

    @property
    def fonts_dir(self) -> Path:
        return self.root / "fonts"

    @property
    def fontconfig_file(self) -> Path:
        return self.root / "fontconfig" / "fonts.conf"

    @property
    def toolchain_file(self) -> Path:
        return self.root / "toolchain.json"

    def pack_file(self, pack_id: str, version: int) -> Path:
        return self._versioned("caption-packs", pack_id, version)

    def hook_design_file(self, design_id: str, version: int) -> Path:
        return self._versioned("hook-designs", design_id, version)

    def _versioned(self, kind: str, name: str, version: int) -> Path:
        if not _RESOURCE_ID.fullmatch(name) or type(version) is not int or version < 1:
            raise ValueError(f"invalid {kind} reference")
        return self.root / kind / name / f"v{version}.json"


@dataclass(frozen=True)
class LogoPlacement:
    """The logo's exact pixel box (``timemap.logo_box``) and baked-in opacity."""

    asset: str  # "sha256:<hex>"
    x: int
    y: int
    w: int
    h: int
    opacity_pm: int

    def to_json(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(frozen=True)
class RenderPlan:
    doc: Mapping[str, Any]  # the validated document (full, including base)
    fps: Fps  # doc output fps
    output: tuple[int, int]  # doc output (w, h)
    pieces: tuple[Piece, ...]  # timemap.pieces(doc)
    total_frames: int  # timemap.total_frames(pieces)
    total_samples: int  # timemap.smp(total_frames, fps), 48 kHz
    # timemap.speech_spans of every word of the words artifact over ``pieces`` (output samples,
    # sorted, not merged): the ducking detector ``words`` (plan §5.6).
    speech_spans: tuple[tuple[int, int], ...]
    assets: Mapping[str, Mapping[str, Any]]  # doc["assets"]: metadata by "sha256:<hex>"
    plan_sha256: str  # plan §5.2 R9: content, words, camera, asset shas, ASS and envelopes
    # --- T1.3 additions (defaults keep the fixture plan builder working) ---
    content_sha256: str = ""  # sha256 of the content's canonical bytes (R10)
    words_sha256: str | None = None  # sha256 of the words artifact's canonical bytes
    camera: Mapping[str, Any] | None = None  # the camera plan, camera layout only
    camera_sha256: str | None = None
    captions: CaptionResult | None = None  # captions.caption_track (T1.2a)
    logo: LogoPlacement | None = None
    music: Mapping[str, Any] | None = None  # the music item of the document, if any
    speech_envelope: tuple[tuple[int, int], ...] = ()  # envelope.speech_envelope (T1.4)
    music_envelope: tuple[tuple[int, int], ...] | None = None  # envelope.music_envelope
    warnings: tuple[Issue, ...] = ()  # caption, camera (no_face) and logo (unsafe_zone)
    fonts_sha256: str | None = None  # resources/fonts/fonts.json; None when missing
    packs_sha256: str | None = None  # the pack and hook design the document uses
    resources: Resources | None = None
    # Set by the render path (dataclasses.replace) when loudness.output_gain reported
    # ``loudness_clamped``: the integrated loudness the master stage achieves (G3).
    loudness_clamped_clufs: int | None = None

    @property
    def layout(self) -> str:
        return self.doc["layout"]["default"]["mode"]

    @property
    def ass(self) -> str | None:
        return None if self.captions is None else self.captions.ass

    @property
    def ass_sha256(self) -> str | None:
        return None if self.captions is None else self.captions.ass_sha256

    def srt(self) -> str:
        """The ``.srt`` sidecar of a final render: the caption cues at their frame times."""
        return "" if self.captions is None else srt_text(self.captions.cues, self.fps)

    def to_json(self) -> dict[str, Any]:
        """Deterministic JSON form hashed into ``plan_sha256`` (``plan_sha256`` excluded)."""
        return {
            "schema": PLAN_SCHEMA,
            "compiler": COMPILER_ID,
            "render_semantics": RENDER_SEMANTICS,
            "content_sha256": self.content_sha256 or _sha(content_of(self.doc)),
            "fps": self.fps.to_json(),
            "output": list(self.output),
            "pieces": [piece.to_dto() for piece in self.pieces],
            "total_frames": self.total_frames,
            "total_samples": self.total_samples,
            "speech_spans_sha256": _sha([list(span) for span in self.speech_spans]),
            "words_sha256": self.words_sha256,
            "camera_sha256": self.camera_sha256,
            "assets": {key: dict(value) for key, value in sorted(self.assets.items())},
            "layout": self.layout,
            "ass_sha256": self.ass_sha256,
            "logo": None if self.logo is None else self.logo.to_json(),
            "speech_envelope_sha256": _sha([list(point) for point in self.speech_envelope]),
            "music_envelope_sha256": None if self.music_envelope is None
            else _sha([list(point) for point in self.music_envelope]),
        }


def srt_text(cues: Sequence[Any], fps: Fps) -> str:
    """SRT of frame cues (``f0``, ``f1``, ``words[].text``); a frame's time is its start,
    ``f·1000·den/num`` ms rounded half up."""

    def stamp(frame: int) -> str:
        ms = tm.div_round_half_up(frame * 1000 * fps.den, fps.num)
        hours, rest = divmod(ms, 3_600_000)
        minutes, rest = divmod(rest, 60_000)
        seconds, millis = divmod(rest, 1000)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"

    blocks = [
        f"{number}\n{stamp(cue.f0)} --> {stamp(cue.f1)}\n"
        + " ".join(word.text for word in cue.words)
        for number, cue in enumerate(cues, start=1)
    ]
    return "\n\n".join(blocks) + ("\n" if blocks else "")


# --- resolution --------------------------------------------------------------------------------


def _item(doc: Mapping, kind: str) -> tuple[int, Mapping[str, Any]] | None:
    """(track index, first item) of the track of ``kind``, if it has an item."""
    for index, track in enumerate(doc["tracks"]):
        if track["kind"] == kind and track["items"]:
            return index, track["items"][0]
    return None


def _check_assets(doc: Mapping, store: Mapping[str, Mapping]) -> None:
    for index, track in enumerate(doc["tracks"]):
        for item_index, item in enumerate(track["items"]):
            asset = item.get("payload", {}).get("asset")
            if asset is not None and (asset not in doc["assets"] or asset not in store):
                raise errors.DocSemanticInvalid(
                    "asset_missing", path=f"/tracks/{index}/items/{item_index}/payload/asset",
                    ref=item["id"])


def _logo(doc: Mapping, store: Mapping[str, Mapping],
          output: tuple[int, int]) -> LogoPlacement | None:
    found = _item(doc, "visual")
    if found is None:
        return None
    _index, item = found
    transform = item["transform"]
    asset = item["payload"]["asset"]
    meta = store[asset]
    x0, y0, width, height = tm.logo_box(
        x_e5=transform["x_e5"], y_e5=transform["y_e5"], w_e5=transform["w_e5"],
        asset_w=meta["w"], asset_h=meta["h"], out_w=output[0], out_h=output[1])
    return LogoPlacement(asset, x0, y0, width, height, transform["opacity_pm"])


def ui_zone(output: tuple[int, int]) -> tuple[int, int, int]:
    """(top, bottom, right) of the TikTok UI zone in output pixels (plan §5.9 G5)."""
    width, height = output
    top, bottom, right = UI_ZONE_720
    return (tm.div_round_half_up(top * height, 1280), tm.div_round_half_up(bottom * height, 1280),
            tm.div_round_half_up(right * width, 720))


def unsafe_zone_issues(doc: Mapping, assets: Mapping[str, Mapping], output: tuple[int, int], *,
                       parts: Sequence[str] = ("captions", "hook", "logo")) -> tuple[Issue, ...]:
    """``unsafe_zone`` warnings from plan geometry (plan §5.9 G5): the caption block's bottom
    anchor inside the bottom zone, the hook's top inside the top zone, the logo box touching
    any zone. Text widths are not measured here, so only the vertical anchors of text count."""
    width, height = output
    top, bottom, right = ui_zone(output)
    issues = []
    captions = doc["captions"]
    caption_bottom = captions["overrides"]["y_e5"] * height  # ×100000
    if "captions" in parts and captions["enabled"] and (
        caption_bottom > (height - bottom) * 100_000
    ):
        issues.append(Issue("unsafe_zone", "/captions/overrides/y_e5"))
    hook = _item(doc, "hook")
    if "hook" in parts and hook is not None:
        index, item = hook
        if item["transform"]["y_e5"] * height < top * 100_000:
            issues.append(Issue("unsafe_zone", f"/tracks/{index}/items/0/transform/y_e5",
                                ref=item["id"]))
    logo = _item(doc, "visual")
    if "logo" in parts and logo is not None and logo[1]["payload"]["asset"] in assets:
        index, item = logo
        box = _logo(doc, assets, output)
        assert box is not None
        if box.y < top or box.y + box.h > height - bottom or box.x + box.w > width - right:
            issues.append(Issue("unsafe_zone", f"/tracks/{index}/items/0/transform",
                                ref=item["id"]))
    return tuple(issues)


def _no_face(camera: Mapping, pieces: Sequence[Piece], fps: Fps) -> tuple[Issue, ...]:
    """One ``no_face`` warning per (span, piece) overlap, at the output frame where it starts."""
    issues = []
    scale = 1000 * fps.den
    for start_ms, end_ms in camera.get("no_face", ()):
        for piece in pieces:
            if start_ms * fps.num < piece.out_sf * scale and end_ms * fps.num > piece.in_sf * scale:
                first = max(tm.sf_floor(start_ms, fps), piece.in_sf)
                issues.append(Issue("no_face", "/layout/default/mode",
                                    f=piece.out_f0 + first - piece.in_sf))
    return tuple(issues)


def _packs_sha(doc: Mapping, resources: Resources) -> str | None:
    pack = doc["captions"]["pack"]
    pack_sha = _file_sha(resources.pack_file(pack["id"], pack["v"]))
    if pack_sha is None:
        return None
    hook = _item(doc, "hook")
    design = None
    if hook is not None:
        spec = hook[1]["payload"]["design"]
        design_sha = _file_sha(resources.hook_design_file(spec["id"], spec["v"]))
        if design_sha is None:
            return None
        design = [spec["id"], spec["v"], design_sha]
    return _sha({"pack": [pack["id"], pack["v"], pack_sha], "hook_design": design})


def build_plan(
    doc: Mapping,
    *,
    words: Mapping,
    camera: Mapping | None,
    assets: Mapping[str, Mapping],
    resources: Resources,
) -> RenderPlan:
    """Resolve a validated document into a render plan (pieces, captions, audio, logo, camera).

    Raises ``AnalysisMissing`` (``ref="camera"``) for the camera layout without a camera plan
    and ``DocSemanticInvalid`` (``asset_missing``) when the asset store lacks a referenced asset.
    """
    fps = Fps.from_json(doc["output"]["fps"])
    output = (doc["output"]["w"], doc["output"]["h"])
    pieces = tm.pieces(doc)
    if not pieces:
        raise errors.DocSemanticInvalid("duration_out_of_bounds", path="/main/segments")
    total = tm.total_frames(pieces)
    total_samples = tm.smp(total, fps)
    spans = tm.speech_spans([(word["s"], word["e"]) for word in words["words"]], pieces, fps)
    _check_assets(doc, assets)
    layout = doc["layout"]["default"]["mode"]
    if layout not in LAYOUT_MODES:
        raise errors.DocSemanticInvalid("range_invalid", path="/layout/default/mode")
    used_camera = camera if layout == "camera" else None
    if layout == "camera" and camera is None:
        raise errors.AnalysisMissing("analysis_missing", path="/layout/default/mode",
                                     ref="camera")
    caption = _captions.caption_track(doc, words, pieces)
    music = _item(doc, "audio")
    music_item = None if music is None else music[1]
    joins = {join["after"]: join["audio_fade_ms"] for join in doc["main"]["joins"]}
    speech_envelope = tuple(tuple(point) for point in _envelope.speech_envelope(
        pieces, joins, doc["main"]["cut_fade_ms"], fps, doc["audio"]["source"]["gain_cdb"]))
    music_envelope = None
    if music_item is not None:
        music_envelope = tuple(tuple(point) for point in _envelope.music_envelope(
            spans, music_item, total_samples, fps))
    warnings = [*caption.warnings]
    if used_camera is not None:
        warnings.extend(_no_face(used_camera, pieces, fps))
    warnings.extend(unsafe_zone_issues(doc, assets, output, parts=("logo",)))
    plan = RenderPlan(
        doc=doc,
        fps=fps,
        output=output,
        pieces=pieces,
        total_frames=total,
        total_samples=total_samples,
        speech_spans=spans,
        assets=doc["assets"],
        plan_sha256="",
        content_sha256=_sha(content_of(doc)),
        words_sha256=_sha(words),
        camera=used_camera,
        camera_sha256=None if used_camera is None else _sha(used_camera),
        captions=caption,
        logo=_logo(doc, assets, output),
        music=music_item,
        speech_envelope=speech_envelope,
        music_envelope=music_envelope,
        warnings=tuple(warnings),
        fonts_sha256=_file_sha(resources.fonts_dir / "fonts.json"),
        packs_sha256=_packs_sha(doc, resources),
        resources=resources,
    )
    return dataclasses.replace(plan, plan_sha256=_sha(plan.to_json()))


# --- render key (R9) ------------------------------------------------------------------------------


def toolchain_sha256(resources: Resources) -> str:
    """sha256 of ``resources/toolchain.json`` (written at image build by ``dpkg-query``, E10).

    Raises ``FileNotFoundError`` when the file is missing: an unpinned toolchain has no render
    key.
    """
    return hashlib.sha256(resources.toolchain_file.read_bytes()).hexdigest()


def render_key(
    plan: RenderPlan,
    *,
    size: tuple[int, int],
    quality: str,
    measure_sha: str | None,
    toolchain_sha: str,
) -> str:
    """``sha256("potongin-render-v1\\0" ‖ plan_sha256 ‖ compiler_version ‖ render semantics ‖
    toolchain sha ‖ fonts sha ‖ packs sha ‖ size ‖ quality ‖ loudness/peak measurement sha)``,
    fields joined by NUL (plan §5.2 R9). ``measure_sha`` is ``None`` when nothing was measured.
    """
    from .compile_ffmpeg import QUALITIES

    size = (size[0], size[1])
    if size not in OUTPUT_SIZES or size != plan.output:
        raise ValueError("Essentials renders at the document's output size")
    if quality not in QUALITIES:
        raise ValueError(f"unknown quality: {quality}")
    for name, value in (("plan_sha256", plan.plan_sha256), ("toolchain_sha", toolchain_sha)):
        if not isinstance(value, str) or not _HEX64.fullmatch(value):
            raise ValueError(f"{name} must be 64 lowercase hex digits")
    if measure_sha is not None and not (isinstance(measure_sha, str)
                                        and _HEX64.fullmatch(measure_sha)):
        raise ValueError("measure_sha must be 64 lowercase hex digits or None")
    if plan.fonts_sha256 is None or plan.packs_sha256 is None:
        raise ValueError("resources incomplete: fonts.json or a pack file is missing")
    parts = (plan.plan_sha256, COMPILER_VERSION, str(RENDER_SEMANTICS), toolchain_sha,
             plan.fonts_sha256, plan.packs_sha256, f"{size[0]}x{size[1]}", quality,
             measure_sha or "-")
    return hashlib.sha256(RENDER_KEY_PREFIX + "\0".join(parts).encode("ascii")).hexdigest()


__all__ = [
    "PLAN_SCHEMA",
    "RENDER_KEY_PREFIX",
    "LogoPlacement",
    "RenderPlan",
    "Resources",
    "build_plan",
    "canonical_bytes",
    "content_of",
    "render_key",
    "srt_text",
    "toolchain_sha256",
    "ui_zone",
    "unsafe_zone_issues",
]
