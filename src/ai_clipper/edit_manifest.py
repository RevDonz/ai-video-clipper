"""Canonical Clip Edit Manifest v1 contract and durable revision storage.

The manifest is an immutable edit decision list bound to one exact Task 5
candidate artifact and candidate window. Storage is POSIX-only and assumes a
trusted, job-owned analysis directory; all files opened here are regular,
no-follow, bounded artifacts.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import math
import os
import re
import stat
import threading
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, fields
from datetime import UTC, datetime
from numbers import Real
from pathlib import Path
from typing import Literal

from .ranking import (
    MAX_ARTIFACT_BYTES,
    CandidatesArtifact,
    _canonical_source,
    candidate_artifact_lock,
    read_candidates_artifact,
)

EDIT_MANIFEST_VERSION = "clip-edit-v1.0"
MAX_EDIT_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_CAPTION_CUES = 1000
MAX_OVERLAYS = 2

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_CANDIDATE_ID = re.compile(r"cand_[0-9a-f]{64}\Z")
_CUE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_EDITOR_SCHEMA = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
_COLOR = re.compile(r"#[0-9A-F]{6}\Z")
_ASSET = re.compile(r"assets/([0-9a-f]{64})\.(png|jpg|jpeg|webp)\Z")
_FONT_FAMILIES = frozenset({"Inter", "Noto Sans", "DejaVu Sans", "sans-serif"})
_CAPTION_PRESETS = frozenset({"clean", "bold-keyword", "karaoke", "podcast", "minimal"})
_RENDER_MODES = frozenset({"fit-blur", "face-track", "center-crop"})


class EditManifestError(Exception):
    """Base error for edit-manifest contract and storage failures."""


class EditManifestInvalid(EditManifestError):
    """The request, artifact, binding, or filesystem target is invalid."""


class EditManifestNotFound(EditManifestError):
    """No current manifest exists for the candidate."""


class EditManifestConflict(EditManifestError):
    """The optimistic revision precondition does not match current state."""


def _exact(value: object, expected: set[str], name: str) -> dict[str, object]:
    if type(value) is not dict or set(value) != expected:
        raise ValueError(f"{name} has missing or unknown fields")
    return value


def _number(value: object, name: str, low: float, high: float) -> float:
    if not isinstance(value, Real) or isinstance(value, bool):
        raise TypeError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or not low <= result <= high:
        raise ValueError(f"{name} must be finite and between {low} and {high}")
    if result == 0:
        return 0.0
    return result


def _integer(value: object, name: str, low: int, high: int | None = None) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if value < low or (high is not None and value > high):
        raise ValueError(f"{name} is outside its allowed range")
    return value


def _text(value: object, name: str, maximum: int, *, empty: bool = False) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if len(value) > maximum or (not empty and not value):
        raise ValueError(f"{name} has invalid length")
    if unicodedata.normalize("NFC", value) != value:
        raise ValueError(f"{name} must be NFC normalized")
    if any(unicodedata.category(char) in {"Cc", "Cs"} for char in value):
        raise ValueError(f"{name} must contain Unicode scalar values without controls")
    return value


def _digest(value: object, name: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise ValueError(f"{name} must be a lowercase SHA-256 digest")
    return value


def _utc_timestamp(value: object, name: str) -> str:
    if not isinstance(value, str) or _TIMESTAMP.fullmatch(value) is None:
        raise ValueError(f"{name} must be UTC ISO-8601 with millisecond precision")
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        raise ValueError(f"{name} must be UTC")
    return value


@dataclass(frozen=True, slots=True)
class ManifestIdentity:
    selection_version: str
    candidate_id: str
    candidate_artifact_sha256: str
    source_sha256: str
    candidate_start: float
    candidate_end: float
    profile: str

    def __post_init__(self) -> None:
        _text(self.selection_version, "selection_version", 64)
        if (
            not isinstance(self.candidate_id, str)
            or _CANDIDATE_ID.fullmatch(self.candidate_id) is None
        ):
            raise ValueError("candidate_id is invalid")
        _digest(self.candidate_artifact_sha256, "candidate_artifact_sha256")
        _digest(self.source_sha256, "source_sha256")
        start = _number(self.candidate_start, "candidate_start", 0, float("inf"))
        end = _number(self.candidate_end, "candidate_end", 0, float("inf"))
        if end <= start:
            raise ValueError("candidate window must satisfy 0 <= start < end")
        object.__setattr__(self, "candidate_start", start)
        object.__setattr__(self, "candidate_end", end)
        if self.profile not in {"viral-short", "standard", "deep-dive"}:
            raise ValueError("profile is invalid")

    @classmethod
    def from_dict(cls, value: object) -> ManifestIdentity:
        return cls(**_exact(value, {field.name for field in fields(cls)}, "identity"))


@dataclass(frozen=True, slots=True)
class Timeline:
    start: float
    end: float

    def __post_init__(self) -> None:
        start = _number(self.start, "timeline.start", 0, float("inf"))
        end = _number(self.end, "timeline.end", 0, float("inf"))
        if end <= start:
            raise ValueError("timeline must satisfy 0 <= start < end")
        object.__setattr__(self, "start", start)
        object.__setattr__(self, "end", end)

    @classmethod
    def from_dict(cls, value: object) -> Timeline:
        return cls(**_exact(value, {"start", "end"}, "timeline"))


@dataclass(frozen=True, slots=True)
class SafeArea:
    top: float = 0.05
    right: float = 0.05
    bottom: float = 0.05
    left: float = 0.05

    def __post_init__(self) -> None:
        for name in ("top", "right", "bottom", "left"):
            object.__setattr__(
                self, name, _number(getattr(self, name), f"safe_area.{name}", 0, 0.25)
            )
        if self.top + self.bottom >= 1 or self.left + self.right >= 1:
            raise ValueError("safe area leaves no usable canvas")

    @classmethod
    def from_dict(cls, value: object) -> SafeArea:
        return cls(**_exact(value, {"top", "right", "bottom", "left"}, "safe_area"))


@dataclass(frozen=True, slots=True)
class VisualEdit:
    canvas_width: int = 720
    canvas_height: int = 1280
    render_mode: Literal["fit-blur", "face-track", "center-crop"] = "fit-blur"
    safe_area: SafeArea = SafeArea()
    focal_x: float | None = None
    focal_y: float | None = None

    def __post_init__(self) -> None:
        canvas_width = _integer(self.canvas_width, "canvas_width", 0)
        canvas_height = _integer(self.canvas_height, "canvas_height", 0)
        if canvas_width != 720:
            raise ValueError("v1 canvas_width must be exactly 720")
        if canvas_height != 1280:
            raise ValueError("v1 canvas_height must be exactly 1280")
        object.__setattr__(self, "canvas_width", canvas_width)
        object.__setattr__(self, "canvas_height", canvas_height)
        if self.render_mode not in _RENDER_MODES:
            raise ValueError("render_mode is invalid")
        if not isinstance(self.safe_area, SafeArea):
            raise TypeError("safe_area must be SafeArea")
        if (self.focal_x is None) != (self.focal_y is None):
            raise ValueError("focal_x and focal_y must both be present or absent")
        if self.render_mode == "fit-blur" and self.focal_x is not None:
            raise ValueError("fit-blur does not accept a focal point")
        if self.focal_x is not None:
            object.__setattr__(self, "focal_x", _number(self.focal_x, "focal_x", 0, 1))
            object.__setattr__(self, "focal_y", _number(self.focal_y, "focal_y", 0, 1))

    @classmethod
    def from_dict(cls, value: object) -> VisualEdit:
        body = _exact(
            value,
            {"canvas_width", "canvas_height", "render_mode", "safe_area", "focal_x", "focal_y"},
            "visual",
        )
        return cls(**{**body, "safe_area": SafeArea.from_dict(body["safe_area"])})


@dataclass(frozen=True, slots=True)
class CaptionStyleEdit:
    preset: Literal["clean", "bold-keyword", "karaoke", "podcast", "minimal"] = "clean"
    position: Literal["top", "center", "bottom"] = "bottom"
    font_family: str = "Inter"
    font_size: int = 42
    color: str = "#FFFFFF"
    keyword_color: str = "#DFFF58"
    background_color: str = "#000000"
    background_opacity: float = 0.65
    max_chars_per_line: int = 32
    max_lines: int = 2
    emphasis: Literal["none", "keyword"] = "none"

    def __post_init__(self) -> None:
        if self.preset not in _CAPTION_PRESETS:
            raise ValueError("caption preset is invalid")
        if self.position not in {"top", "center", "bottom"}:
            raise ValueError("caption position is invalid")
        if self.font_family not in _FONT_FAMILIES:
            raise ValueError("font_family is not bundled or allowlisted")
        _integer(self.font_size, "font_size", 18, 96)
        if not isinstance(self.color, str) or _COLOR.fullmatch(self.color) is None:
            raise ValueError("color must use uppercase #RRGGBB")
        if not isinstance(self.keyword_color, str) or _COLOR.fullmatch(self.keyword_color) is None:
            raise ValueError("keyword_color must use uppercase #RRGGBB")
        if (
            not isinstance(self.background_color, str)
            or _COLOR.fullmatch(self.background_color) is None
        ):
            raise ValueError("background_color must use uppercase #RRGGBB")
        object.__setattr__(
            self,
            "background_opacity",
            _number(self.background_opacity, "background_opacity", 0, 1),
        )
        _integer(self.max_chars_per_line, "max_chars_per_line", 8, 80)
        _integer(self.max_lines, "max_lines", 1, 3)
        if self.emphasis not in {"none", "keyword"}:
            raise ValueError("caption emphasis is invalid")

    @classmethod
    def from_dict(cls, value: object) -> CaptionStyleEdit:
        return cls(**_exact(value, {field.name for field in fields(cls)}, "caption_style"))


@dataclass(frozen=True, slots=True)
class CaptionCueEdit:
    cue_id: str
    index: int
    start: float
    end: float
    text: str
    original_text_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.cue_id, str) or _CUE_ID.fullmatch(self.cue_id) is None:
            raise ValueError("cue_id is invalid")
        _integer(self.index, "cue index", 0, MAX_CAPTION_CUES - 1)
        start = _number(self.start, "cue start", 0, float("inf"))
        end = _number(self.end, "cue end", 0, float("inf"))
        if end <= start:
            raise ValueError("cue must satisfy 0 <= start < end")
        object.__setattr__(self, "start", start)
        object.__setattr__(self, "end", end)
        _text(self.text, "cue text", 500)
        _digest(self.original_text_sha256, "original_text_sha256")

    @classmethod
    def from_dict(cls, value: object) -> CaptionCueEdit:
        return cls(**_exact(value, {field.name for field in fields(cls)}, "caption cue"))


@dataclass(frozen=True, slots=True)
class TitleOverlay:
    text: str
    x: float
    y: float
    max_width: float
    kind: Literal["title"] = "title"

    def __post_init__(self) -> None:
        if self.kind != "title":
            raise ValueError("title overlay kind is invalid")
        _text(self.text, "title text", 100)
        object.__setattr__(self, "x", _number(self.x, "title x", 0, 1))
        object.__setattr__(self, "y", _number(self.y, "title y", 0, 1))
        object.__setattr__(self, "max_width", _number(self.max_width, "title max_width", 0.1, 1))

    @classmethod
    def from_dict(cls, value: object) -> TitleOverlay:
        return cls(**_exact(value, {field.name for field in fields(cls)}, "title overlay"))


@dataclass(frozen=True, slots=True)
class LogoOverlay:
    asset: str
    x: float
    y: float
    opacity: float
    scale: float
    kind: Literal["logo"] = "logo"

    def __post_init__(self) -> None:
        if self.kind != "logo":
            raise ValueError("logo overlay kind is invalid")
        if not isinstance(self.asset, str) or _ASSET.fullmatch(self.asset) is None:
            raise ValueError(
                "logo asset must be an allowlisted job-relative content-addressed asset"
            )
        object.__setattr__(self, "x", _number(self.x, "logo x", 0, 1))
        object.__setattr__(self, "y", _number(self.y, "logo y", 0, 1))
        object.__setattr__(self, "opacity", _number(self.opacity, "logo opacity", 0, 1))
        object.__setattr__(self, "scale", _number(self.scale, "logo scale", 0.01, 0.5))

    @classmethod
    def from_dict(cls, value: object) -> LogoOverlay:
        return cls(**_exact(value, {field.name for field in fields(cls)}, "logo overlay"))


Overlay = TitleOverlay | LogoOverlay


@dataclass(frozen=True, slots=True)
class AudioEdit:
    gain_db: float = 0.0
    normalize: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "gain_db", _number(self.gain_db, "gain_db", -24, 12))
        if not isinstance(self.normalize, bool):
            raise TypeError("normalize must be a boolean")

    @classmethod
    def from_dict(cls, value: object) -> AudioEdit:
        return cls(**_exact(value, {"gain_db", "normalize"}, "audio"))


@dataclass(frozen=True, slots=True)
class Audit:
    created_at: str
    updated_at: str
    editor_schema: str

    def __post_init__(self) -> None:
        created = _utc_timestamp(self.created_at, "created_at")
        updated = _utc_timestamp(self.updated_at, "updated_at")
        if updated < created:
            raise ValueError("updated_at cannot precede created_at")
        if (
            not isinstance(self.editor_schema, str)
            or _EDITOR_SCHEMA.fullmatch(self.editor_schema) is None
        ):
            raise ValueError("editor_schema is invalid")
        _text(self.editor_schema, "editor_schema", 64)

    @classmethod
    def from_dict(cls, value: object) -> Audit:
        return cls(**_exact(value, {"created_at", "updated_at", "editor_schema"}, "audit"))


@dataclass(frozen=True, slots=True)
class ClipEditManifest:
    edit_manifest_version: str
    identity: ManifestIdentity
    revision: int
    parent_revision_sha256: str | None
    timeline: Timeline
    visual: VisualEdit
    caption_style: CaptionStyleEdit
    captions: tuple[CaptionCueEdit, ...]
    overlays: tuple[Overlay, ...]
    audio: AudioEdit
    audit: Audit

    def __post_init__(self) -> None:
        if self.edit_manifest_version != EDIT_MANIFEST_VERSION:
            raise ValueError(f"edit_manifest_version must be exactly {EDIT_MANIFEST_VERSION}")
        if not isinstance(self.identity, ManifestIdentity):
            raise TypeError("identity must be ManifestIdentity")
        _integer(self.revision, "revision", 1)
        if self.parent_revision_sha256 is not None:
            _digest(self.parent_revision_sha256, "parent_revision_sha256")
        if (self.revision == 1) != (self.parent_revision_sha256 is None):
            raise ValueError("revision 1 has no parent; later revisions require one")
        if not isinstance(self.timeline, Timeline):
            raise TypeError("timeline must be Timeline")
        if (self.timeline.start, self.timeline.end) != (
            self.identity.candidate_start,
            self.identity.candidate_end,
        ):
            raise ValueError("v1 timeline must equal the immutable candidate window")
        if not isinstance(self.visual, VisualEdit):
            raise TypeError("visual must be VisualEdit")
        if not isinstance(self.caption_style, CaptionStyleEdit):
            raise TypeError("caption_style must be CaptionStyleEdit")
        if not isinstance(self.captions, tuple) or len(self.captions) > MAX_CAPTION_CUES:
            raise TypeError("captions must be a bounded immutable tuple")
        ids: set[str] = set()
        previous_end: float | None = None
        for expected_index, cue in enumerate(self.captions):
            if not isinstance(cue, CaptionCueEdit):
                raise TypeError("captions must contain CaptionCueEdit")
            if cue.index != expected_index or cue.cue_id in ids:
                raise ValueError("caption cue IDs and indices must be unique and contiguous")
            if cue.start < self.timeline.start or cue.end > self.timeline.end:
                raise ValueError("caption cue is outside the candidate window")
            if previous_end is not None and cue.start < previous_end:
                raise ValueError("caption cues must be sorted and non-overlapping")
            ids.add(cue.cue_id)
            previous_end = cue.end
        if not isinstance(self.overlays, tuple) or len(self.overlays) > MAX_OVERLAYS:
            raise TypeError("overlays must be a bounded immutable tuple")
        kinds: set[str] = set()
        safe = self.visual.safe_area
        for overlay in self.overlays:
            if not isinstance(overlay, (TitleOverlay, LogoOverlay)) or overlay.kind in kinds:
                raise ValueError("overlays allow at most one title and one logo")
            if (
                not safe.left <= overlay.x <= 1 - safe.right
                or not safe.top <= overlay.y <= 1 - safe.bottom
            ):
                raise ValueError("overlay anchor must be inside the safe area")
            if isinstance(overlay, TitleOverlay) and (
                overlay.x - overlay.max_width / 2 < safe.left
                or overlay.x + overlay.max_width / 2 > 1 - safe.right
            ):
                raise ValueError("title width must remain inside the safe area")
            if isinstance(overlay, LogoOverlay):
                # x/y are the logo center. Scale is the width of an assumed
                # square-pixel logo as a fraction of canvas width.
                half_width = overlay.scale / 2
                half_height = (
                    overlay.scale * self.visual.canvas_width / self.visual.canvas_height / 2
                )
                if (
                    overlay.x - half_width < safe.left
                    or overlay.x + half_width > 1 - safe.right
                    or overlay.y - half_height < safe.top
                    or overlay.y + half_height > 1 - safe.bottom
                ):
                    raise ValueError("logo footprint must remain inside the safe area")
            kinds.add(overlay.kind)
        if not isinstance(self.audio, AudioEdit) or not isinstance(self.audit, Audit):
            raise TypeError("audio and audit have invalid types")

    @classmethod
    def from_dict(cls, value: object) -> ClipEditManifest:
        body = _exact(value, {field.name for field in fields(cls)}, "manifest")
        if type(body["captions"]) is not list or type(body["overlays"]) is not list:
            raise TypeError("captions and overlays must be arrays")
        if len(body["captions"]) > MAX_CAPTION_CUES or len(body["overlays"]) > MAX_OVERLAYS:
            raise ValueError("manifest list exceeds maximum")
        overlays: list[Overlay] = []
        for item in body["overlays"]:
            if type(item) is not dict:
                raise TypeError("overlay must be an object")
            if item.get("kind") == "title":
                overlays.append(TitleOverlay.from_dict(item))
            elif item.get("kind") == "logo":
                overlays.append(LogoOverlay.from_dict(item))
            else:
                raise ValueError("overlay kind is invalid")
        return cls(
            edit_manifest_version=body["edit_manifest_version"],
            identity=ManifestIdentity.from_dict(body["identity"]),
            revision=body["revision"],
            parent_revision_sha256=body["parent_revision_sha256"],
            timeline=Timeline.from_dict(body["timeline"]),
            visual=VisualEdit.from_dict(body["visual"]),
            caption_style=CaptionStyleEdit.from_dict(body["caption_style"]),
            captions=tuple(CaptionCueEdit.from_dict(item) for item in body["captions"]),
            overlays=tuple(overlays),
            audio=AudioEdit.from_dict(body["audio"]),
            audit=Audit.from_dict(body["audit"]),
        )


def _to_dict(value: object) -> object:
    if isinstance(value, tuple):
        return [_to_dict(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {field.name: _to_dict(getattr(value, field.name)) for field in fields(value)}
    return value


def canonical_manifest_bytes(manifest: ClipEditManifest) -> bytes:
    """Return deterministic RFC-8259 JSON bytes used for revision hashes."""
    if not isinstance(manifest, ClipEditManifest):
        raise TypeError("manifest must be ClipEditManifest")
    try:
        raw = json.dumps(
            _to_dict(manifest),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise EditManifestInvalid() from error
    if len(raw) > MAX_EDIT_MANIFEST_BYTES:
        raise EditManifestInvalid("edit manifest exceeds 2 MiB")
    return raw


def manifest_sha256(manifest: ClipEditManifest) -> str:
    return hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _constant(_value: str) -> object:
    raise ValueError("non-finite JSON number")


def manifest_from_bytes(raw: bytes) -> ClipEditManifest:
    """Strictly decode one bounded manifest (duplicates/non-finite values fail)."""
    try:
        if not isinstance(raw, bytes) or len(raw) > MAX_EDIT_MANIFEST_BYTES:
            raise ValueError("edit manifest exceeds size limit")
        payload = json.loads(
            raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_constant
        )
        return ClipEditManifest.from_dict(payload)
    except EditManifestInvalid:
        raise
    except Exception as error:
        raise EditManifestInvalid() from error


def _manifest_from_canonical_storage(raw: bytes) -> ClipEditManifest:
    manifest = manifest_from_bytes(raw)
    if raw != canonical_manifest_bytes(manifest):
        raise EditManifestInvalid("stored manifest is not canonical JSON")
    return manifest


def _read_regular(path: Path, limit: int, *, missing: bool = False) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        if missing:
            raise EditManifestNotFound() from None
        raise
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.ENOTDIR}:
            raise EditManifestInvalid() from None
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise EditManifestInvalid()
        chunks: list[bytes] = []
        total = 0
        while total <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > limit:
            raise EditManifestInvalid()
        return b"".join(chunks)
    finally:
        os.close(fd)


def _candidate_context(path: Path, candidate_id: str) -> tuple[CandidatesArtifact, object, bytes]:
    if not isinstance(candidate_id, str) or _CANDIDATE_ID.fullmatch(candidate_id) is None:
        raise EditManifestInvalid("candidate ID is invalid")
    try:
        raw = _read_regular(path, MAX_ARTIFACT_BYTES)
        artifact = read_candidates_artifact(path)
        candidate = next(item for item in artifact.candidates if item.candidate_id == candidate_id)
    except EditManifestInvalid:
        raise
    except Exception as error:
        raise EditManifestInvalid() from error
    return artifact, candidate, raw


def _expected_identity(
    artifact: CandidatesArtifact, candidate: object, raw: bytes
) -> ManifestIdentity:
    canonical_source = _canonical_source(artifact.source)
    return ManifestIdentity(
        selection_version=artifact.selection_version,
        candidate_id=candidate.candidate_id,
        candidate_artifact_sha256=hashlib.sha256(raw).hexdigest(),
        source_sha256=hashlib.sha256(canonical_source.encode("utf-8")).hexdigest(),
        candidate_start=candidate.start,
        candidate_end=candidate.end,
        profile=candidate.profile.value,
    )


def create_edit_manifest(
    candidate_artifact_path: str | Path,
    candidate_id: str,
    *,
    captions: tuple[CaptionCueEdit, ...],
    created_at: str,
    editor_schema: str,
    visual: VisualEdit | None = None,
    caption_style: CaptionStyleEdit | None = None,
    overlays: tuple[Overlay, ...] = (),
    audio: AudioEdit | None = None,
) -> ClipEditManifest:
    """Create revision 1 from an exact Task 5 candidate artifact."""
    path = Path(candidate_artifact_path)
    if path.name != "candidates.v2.json":
        raise EditManifestInvalid("candidate artifact name is invalid")
    _validate_analysis_dir(path.parent)
    with candidate_artifact_lock(path.parent, exclusive=False):
        artifact, candidate, raw = _candidate_context(path, candidate_id)
    identity = _expected_identity(artifact, candidate, raw)
    return ClipEditManifest(
        edit_manifest_version=EDIT_MANIFEST_VERSION,
        identity=identity,
        revision=1,
        parent_revision_sha256=None,
        timeline=Timeline(candidate.start, candidate.end),
        visual=visual or VisualEdit(),
        caption_style=caption_style or CaptionStyleEdit(),
        captions=captions,
        overlays=overlays,
        audio=audio or AudioEdit(),
        audit=Audit(created_at, created_at, editor_schema),
    )


def _validate_analysis_dir(analysis_dir: Path) -> None:
    try:
        info = analysis_dir.lstat()
    except FileNotFoundError:
        raise EditManifestNotFound() from None
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or analysis_dir.resolve() != analysis_dir.absolute()
    ):
        raise EditManifestInvalid("analysis directory is not trusted")


def _ensure_directory(path: Path) -> None:
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pass
    try:
        info = path.lstat()
    except OSError as error:
        raise EditManifestInvalid() from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise EditManifestInvalid("edit storage directory is invalid")
    _fsync_directory(path.parent)


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


_storage_thread_lock = threading.RLock()


def _reset_storage_lock() -> None:
    global _storage_thread_lock
    _storage_thread_lock = threading.RLock()


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_reset_storage_lock)


@contextmanager
def _edit_lock(edits_dir: Path, candidate_id: str):
    lock_path = edits_dir / f".{candidate_id}.edit.lock"
    try:
        fd = os.open(
            lock_path,
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
            0o600,
        )
    except OSError as error:
        raise EditManifestInvalid() from error
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise EditManifestInvalid()
        with _storage_thread_lock:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _current_path(edits_dir: Path, candidate_id: str) -> Path:
    return edits_dir / f"{candidate_id}.edit.v1.json"


def _verify_binding(analysis_dir: Path, manifest: ClipEditManifest) -> None:
    artifact, candidate, raw = _candidate_context(
        analysis_dir / "candidates.v2.json", manifest.identity.candidate_id
    )
    if manifest.identity != _expected_identity(artifact, candidate, raw):
        raise EditManifestInvalid("manifest identity does not match candidate artifact")


def _atomic_write(directory: Path, target: Path, raw: bytes) -> None:
    temp = directory / f".{target.name}.{uuid.uuid4()}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        written = 0
        while written < len(raw):
            written += os.write(fd, raw[written:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temp, target)
        _fsync_directory(directory)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _archive_current(edits_dir: Path, manifest: ClipEditManifest, digest: str) -> Path:
    archive_dir = edits_dir / "archive"
    _ensure_directory(archive_dir)
    archive = archive_dir / (
        f"{manifest.identity.candidate_id}.edit.v1.r{manifest.revision}.{digest}.json"
    )
    expected_raw = canonical_manifest_bytes(manifest)
    temp = archive_dir / f".{archive.name}.{uuid.uuid4()}.tmp"
    fd = -1
    try:
        fd = os.open(
            temp,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
        )
        written = 0
        while written < len(expected_raw):
            written += os.write(fd, expected_raw[written:])
        os.fsync(fd)
        os.close(fd)
        fd = -1
        try:
            os.link(temp, archive, follow_symlinks=False)
        except FileExistsError:
            try:
                archived_raw = _read_regular(archive, MAX_EDIT_MANIFEST_BYTES)
            except OSError as error:
                raise EditManifestInvalid("revision archive is invalid") from error
            if archived_raw != expected_raw:
                raise EditManifestInvalid("revision archive collision")
        except OSError as error:
            raise EditManifestInvalid() from error
        _fsync_directory(archive_dir)
        return archive
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def write_edit_manifest(
    analysis_dir: str | Path,
    manifest: ClipEditManifest,
    *,
    expected_revision_sha256: str | None,
) -> str:
    """Atomically create/update current state and return its canonical SHA-256.

    Initial creation requires revision 1 and ``expected_revision_sha256=None``.
    Updates require the exact current digest, revision + 1, and parent digest.
    Every replaced current revision is hard-linked into an append-only archive.
    """
    if not isinstance(manifest, ClipEditManifest):
        raise EditManifestInvalid("manifest type is invalid")
    if expected_revision_sha256 is not None:
        _digest(expected_revision_sha256, "expected_revision_sha256")
    analysis = Path(analysis_dir)
    _validate_analysis_dir(analysis)
    edits = analysis / "edits"
    _ensure_directory(edits)
    target = _current_path(edits, manifest.identity.candidate_id)
    with (
        candidate_artifact_lock(analysis, exclusive=False),
        _edit_lock(edits, manifest.identity.candidate_id),
    ):
        _verify_binding(analysis, manifest)
        try:
            current_raw = _read_regular(target, MAX_EDIT_MANIFEST_BYTES, missing=True)
        except EditManifestNotFound:
            if expected_revision_sha256 is not None or manifest.revision != 1:
                raise EditManifestConflict("manifest has no current revision") from None
        else:
            current = _manifest_from_canonical_storage(current_raw)
            _verify_binding(analysis, current)
            current_digest = manifest_sha256(current)
            if expected_revision_sha256 != current_digest:
                raise EditManifestConflict("current revision digest changed")
            if manifest.identity != current.identity or manifest.timeline != current.timeline:
                raise EditManifestInvalid("revision identity and timeline are immutable")
            if manifest.revision != current.revision + 1:
                raise EditManifestConflict("revision must increment exactly once")
            if manifest.parent_revision_sha256 != current_digest:
                raise EditManifestConflict("parent revision digest does not match current")
            if manifest.audit.created_at != current.audit.created_at:
                raise EditManifestInvalid("created_at is immutable")
            if manifest.audit.updated_at <= current.audit.updated_at:
                raise EditManifestInvalid("updated_at must increase")
            current_bindings = tuple(
                (cue.cue_id, cue.index, cue.start, cue.end, cue.original_text_sha256)
                for cue in current.captions
            )
            next_bindings = tuple(
                (cue.cue_id, cue.index, cue.start, cue.end, cue.original_text_sha256)
                for cue in manifest.captions
            )
            if next_bindings != current_bindings:
                raise EditManifestInvalid("caption source bindings are immutable")
            _archive_current(edits, current, current_digest)
        raw = canonical_manifest_bytes(manifest)
        _atomic_write(edits, target, raw)
        verified = _manifest_from_canonical_storage(_read_regular(target, MAX_EDIT_MANIFEST_BYTES))
        if canonical_manifest_bytes(verified) != raw:
            raise EditManifestInvalid("manifest readback verification failed")
        _verify_binding(analysis, verified)
        return manifest_sha256(verified)


def read_edit_manifest(analysis_dir: str | Path, candidate_id: str) -> ClipEditManifest:
    """Read and validate current state under candidate-generation and edit locks."""
    if not isinstance(candidate_id, str) or _CANDIDATE_ID.fullmatch(candidate_id) is None:
        raise EditManifestInvalid("candidate ID is invalid")
    analysis = Path(analysis_dir)
    _validate_analysis_dir(analysis)
    edits = analysis / "edits"
    _ensure_directory(edits)
    with candidate_artifact_lock(analysis, exclusive=False), _edit_lock(edits, candidate_id):
        manifest = _manifest_from_canonical_storage(
            _read_regular(_current_path(edits, candidate_id), MAX_EDIT_MANIFEST_BYTES, missing=True)
        )
        if manifest.identity.candidate_id != candidate_id:
            raise EditManifestInvalid("candidate path does not match manifest identity")
        _verify_binding(analysis, manifest)
        return manifest
