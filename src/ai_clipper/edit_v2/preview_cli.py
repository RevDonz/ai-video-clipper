"""CLI ``python -m ai_clipper.edit_v2.preview_cli``: the server side of the preview lane
(plan §4.2, §4.3, §6, §2.6; owner T2.3). Every call comes from ``web/lib/preview-lane.mjs``
through ``web/lib/python-cli.mjs`` (allowlisted environment, bounded IO, E11).

Protocol (the same as ``edit_v2.api``, docs/editor/CONTRACTS.md §5.9): stdin is one JSON
envelope ``{"op": <op>, …}`` (≤ 3 MiB, no duplicate keys, exactly the keys of its op, camelCase);
ids are checked by regex before use and paths are never accepted (the job is
``$JOBS_ROOT/<jobId>``, the clip ``<job>/analysis/clips/<clipId>``, both real directories).
stdout is one JSON object; a failure is ``{"error": {code, path, ref, messageId}}`` plus
``"errors": [{code, path, ref?, f?}, …]`` when it lists issues. Exit codes: ``errors.EXIT_*``
(0 ok, 1 internal, 2 usage = a malformed envelope, 3 invalid, 4 not found, 6 semantic, 7 schema
too new, 8 analysis missing, 10 render failed, 12 cancelled).

``requestRaw`` is the route's request body in base64, validated here exactly as received: a
JSON object whose ``doc`` member is handed to ``doc.parse_doc`` byte for byte (floats, NaN and
duplicate keys inside it are rejected with their JSON pointer) and whose other members are
``known`` (``{assSha256?}``) and ``playhead`` (an output frame) for ``plan`` and ``audio``, and
``f`` for ``frame``. A document is validated against the seed (``base_changed`` …), or against
the stored revision when the job re-ran and the document is read-only (plan §3.6).

Ops (arguments → result):

``prepare`` ``{jobId, clipId, layout|null}`` → ``{words: "ready", camera: "ready" |
"not_needed", layout, plateKey, cellFrames, cells: [k], ready: [k]}``. Restores a missing words
artifact (``seed.prepare_legacy_job``), builds the camera plan when the layout (the requested
one, else the current document's) is face-track and none exists
(``camera.build_camera_plan``, written immutably as ``camera.<sha16>.json``), and reports the
plate cells of the current document in that layout. Idempotent.

``plan`` ``{jobId, clipId, requestRaw}`` → ``{dto, lane}``: ``dto`` is the plan DTO of plan §4.3
(``text.ass`` omitted when ``known.assSha256`` is the new sha; cell, audio and logo states
``ready`` (with ``url``) or ``queued``), and ``lane`` what Node schedules: ``{playhead, layout,
plateKey, cellFrames, cells, missing, audio: {key, ready}, logo: {asset, w, h, opacityPm, name,
ready} | null, frameKey}``. Publishes the ASS as ``preview/ass/<sha16>.ass``. Nothing heavy runs.

``cells`` ``{jobId, clipId, layout, cells: [k] (1–64), cancelToken|null}`` → ``{plateKey, built,
present}``: encodes the missing cells of the seed's plate in ``layout`` in one FFmpeg run (the
lane's two threads) and publishes ``preview/plates/<key16>-c<k:07d>.mp4``.

``audio`` ``{jobId, clipId, requestRaw, cancelToken|null}`` → ``{audioKey, name, built, samples,
gainCdb, warnings}``: the ``audio_preview`` FLAC of the document (``preview/audio/<key16>.flac``
and its ``<key16>.json``), measured first when ``loudness.needs_measurement`` (the result cached
as ``<mix16>.loudness.json`` by the pre-master mix sha).

``frame`` ``{jobId, clipId, requestRaw, cancelToken|null}`` → ``{name, planSha256, built}``: the
truth frame ``f`` (the compiler's ``frame`` mode) as ``preview/frames/<key16>-<f>-<w>.png``.

``derive`` ``{jobId, clipId, asset, w, h, opacityPm, cancelToken|null}`` → ``{name, built}``: the
logo bitmap at its exact box with the opacity baked in, ``preview/derived/<key16>@<w>x<h>a<pm>.png``
(``key16`` names the asset, the compiler and the toolchain).

Cancellation: a heavy op polls ``preview/.cancel/<cancelToken>`` (written by the lane when the
work is superseded) and ``SIGTERM``; either stops FFmpeg's process group and exits 12. Heavy ops
run at ``nice 5`` (plan §2.6) when started as a process.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import signal
import stat
import sys
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import COMPILER_ID, COMPILER_VERSION, RENDER_SEMANTICS
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN
from .errors import (
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_USAGE,
    AnalysisMissing,
    DocInvalid,
    DocSemanticInvalid,
    EditV2Error,
    NotFound,
    exit_code_for,
    message_id,
)

OPS = ("prepare", "plan", "cells", "audio", "frame", "derive")
MODULE = "ai_clipper.edit_v2.preview_cli"
MAX_ENVELOPE_BYTES = 3 << 20
MAX_REQUEST_BYTES = (1 << 20) + (64 << 10)
MAX_CELLS = 64
MAX_MANIFEST_BYTES = 16 << 20
MAX_META_BYTES = 1 << 20
NICE = 5
CANCEL_POLL_S = 0.05
LAYOUTS = ("fit_blur", "camera", "fill_center")
PREVIEW_DIR = "preview"
CANCEL_DIR = ".cancel"
AUDIO_SCHEMA = "potongin.preview-audio/1"
FRAME_SCHEMA = "potongin.truth-frame/1"
DERIVED_SCHEMA = "potongin.derived-logo/1"
HOOK_FONT_FALLBACK = "DejaVuSans-Bold.ttf"

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                   re.IGNORECASE)
_HEX64 = re.compile(r"[0-9a-f]{64}")
_TOKEN = re.compile(r"[0-9a-f]{32}")
_ASSET = re.compile(r"sha256:[0-9a-f]{64}")
_B64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_WS = re.compile(r"[ \t\n\r]*")
_MAX_SAFE = (1 << 53) - 1


# --- envelope --------------------------------------------------------------------------------------


class _Usage(Exception):
    """A malformed envelope (exit 2): the lane's bug, never the user's."""


def _is_int(value: object, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def _cells_field(value: object) -> bool:
    return (type(value) is list and 1 <= len(value) <= MAX_CELLS
            and all(_is_int(k, 0, 9_999_999) for k in value))


_CHECKS: dict[str, Callable[[object], bool]] = {
    "jobId": lambda v: isinstance(v, str) and _UUID.fullmatch(v) is not None,
    "clipId": lambda v: isinstance(v, str) and CLIP_ID_PATTERN.fullmatch(v) is not None,
    "layoutOrNull": lambda v: v is None or v in LAYOUTS,
    "layout": lambda v: v in LAYOUTS,
    "requestRaw": lambda v: (isinstance(v, str) and len(v) <= (MAX_REQUEST_BYTES * 4) // 3 + 4
                             and _B64.fullmatch(v) is not None),
    "cells": _cells_field,
    "cancelToken": lambda v: v is None or (isinstance(v, str) and _TOKEN.fullmatch(v)
                                           is not None),
    "asset": lambda v: isinstance(v, str) and _ASSET.fullmatch(v) is not None,
    "w": lambda v: _is_int(v, 1, 4096),
    "h": lambda v: _is_int(v, 1, 4096),
    "opacityPm": lambda v: _is_int(v, 200, 1000),
}
_FIELDS: dict[str, dict[str, str]] = {
    "prepare": {"jobId": "jobId", "clipId": "clipId", "layout": "layoutOrNull"},
    "plan": {"jobId": "jobId", "clipId": "clipId", "requestRaw": "requestRaw"},
    "cells": {"jobId": "jobId", "clipId": "clipId", "layout": "layout", "cells": "cells",
              "cancelToken": "cancelToken"},
    "audio": {"jobId": "jobId", "clipId": "clipId", "requestRaw": "requestRaw",
              "cancelToken": "cancelToken"},
    "frame": {"jobId": "jobId", "clipId": "clipId", "requestRaw": "requestRaw",
              "cancelToken": "cancelToken"},
    "derive": {"jobId": "jobId", "clipId": "clipId", "asset": "asset", "w": "w", "h": "h",
               "opacityPm": "opacityPm", "cancelToken": "cancelToken"},
}


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _Usage()
    return result


def _reject(_value: str) -> Any:
    raise _Usage()


def _envelope(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=_reject, parse_float=_reject)
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict:
        raise _Usage()
    op = value.get("op")
    if not isinstance(op, str) or op not in _FIELDS or set(value) != {"op", *_FIELDS[op]}:
        raise _Usage()
    for name, check in _FIELDS[op].items():
        if not _CHECKS[check](value[name]):
            raise _Usage()
    return value


# --- the request body (requestRaw) -----------------------------------------------------------------


@dataclass(frozen=True)
class _Request:
    doc_raw: bytes
    known_ass: str | None
    playhead: int
    f: int | None


def _invalid(path: str = "") -> DocInvalid:
    from .doc import Issue

    return DocInvalid("invalid_json", path=path, issues=(Issue("invalid_json", path),))


def _top_level(text: str) -> dict[str, tuple[int, int]]:
    """The spans ``(start, end)`` of the members of a top-level JSON object; the values are
    only scanned here (a member's own rules are checked by its reader)."""
    decoder = json.JSONDecoder()
    index = _WS.match(text, 0).end()
    if text[index:index + 1] != "{":
        raise _invalid()
    index = _WS.match(text, index + 1).end()
    spans: dict[str, tuple[int, int]] = {}
    if text[index:index + 1] == "}":
        index += 1
    else:
        while True:
            if text[index:index + 1] != '"':
                raise _invalid()
            key, index = json.decoder.scanstring(text, index + 1, True)
            index = _WS.match(text, index).end()
            if text[index:index + 1] != ":":
                raise _invalid()
            start = _WS.match(text, index + 1).end()
            _value, end = decoder.raw_decode(text, start)
            if key in spans:
                raise _invalid()
            spans[key] = (start, end)
            index = _WS.match(text, end).end()
            if text[index:index + 1] == ",":
                index = _WS.match(text, index + 1).end()
                continue
            if text[index:index + 1] == "}":
                index += 1
                break
            raise _invalid()
    if _WS.match(text, index).end() != len(text):
        raise _invalid()
    return spans


def _strict(text: str) -> Any:
    return json.loads(text, object_pairs_hook=_pairs, parse_constant=_reject,
                      parse_float=_reject)


def _request(encoded: str, *, allowed: frozenset[str], required: frozenset[str]) -> _Request:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise _Usage() from None
    if len(raw) > MAX_REQUEST_BYTES:
        raise _invalid()
    try:
        text = raw.decode("utf-8")
        spans = _top_level(text)
    except (UnicodeDecodeError, ValueError, RecursionError, IndexError):
        raise _invalid() from None
    if not required <= set(spans) or not set(spans) <= allowed:
        raise _invalid()
    known = None
    playhead = 0
    frame = None
    try:
        if "known" in spans:
            value = _strict(text[slice(*spans["known"])])
            if type(value) is not dict or not set(value) <= {"assSha256"}:
                raise _invalid("/known")
            known = value.get("assSha256")
            if known is not None and not (isinstance(known, str) and _HEX64.fullmatch(known)):
                raise _invalid("/known/assSha256")
        if "playhead" in spans:
            playhead = _strict(text[slice(*spans["playhead"])])
            if not _is_int(playhead, 0, _MAX_SAFE):
                raise _invalid("/playhead")
        if "f" in spans:
            frame = _strict(text[slice(*spans["f"])])
            if not _is_int(frame, 0, _MAX_SAFE):
                raise _invalid("/f")
    except (_Usage, ValueError, RecursionError):
        raise _invalid() from None
    doc_start, doc_end = spans["doc"]
    return _Request(text[doc_start:doc_end].encode("utf-8"), known, playhead, frame)


_PLAN_FIELDS = frozenset({"doc", "known", "playhead"})
_FRAME_FIELDS = frozenset({"doc", "f"})


# --- paths and files ----------------------------------------------------------------------------------


def _real_dir(path: Path) -> Path:
    """An existing directory that is not a symlink, else NotFound."""
    try:
        info = path.lstat()
    except (FileNotFoundError, NotADirectoryError):
        raise NotFound() from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise NotFound()
    return path


def _job_dir(jobs_root: str | os.PathLike | None, job_id: str) -> Path:
    if jobs_root is None or str(jobs_root) == "":
        raise EditV2Error("internal_error")
    try:
        root = Path(jobs_root).resolve(strict=True)
    except OSError:
        raise EditV2Error("internal_error") from None
    return _real_dir(root / job_id)


def _clip_dir(job: Path, clip_id: str) -> Path:
    for part in (job / "analysis", job / "analysis" / "clips"):
        _real_dir(part)
    return _real_dir(job / "analysis" / "clips" / clip_id)


def _is_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return False


def _read_json(path: Path, limit: int) -> Any:
    from .source_info import read_regular

    try:
        return json.loads(read_regular(path, limit))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return None


def _publish(path: Path, data: bytes) -> bool:
    """Publish immutably (0600, 0700 directories, fsynced; an existing file wins)."""
    from .source_info import write_immutable

    return write_immutable(path, data)


def _publish_run(directory: Path, name: str, run: Callable[[int], None]) -> None:
    """Run ``run(fd)`` into a private temporary file of ``directory``, then link it to
    ``name`` (an existing file wins)."""
    from .source_info import _fsync_directory, ensure_private_dir

    ensure_private_dir(directory)
    temp = directory / f".{name}.{secrets.token_hex(8)}.tmp"
    fd = os.open(temp, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        try:
            run(fd)
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(temp, directory / name, follow_symlinks=False)
        except FileExistsError:
            pass
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass
    _fsync_directory(directory)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def _sha(value: Any) -> str:
    return hashlib.sha256(_canonical(value)).hexdigest()


# --- resources ---------------------------------------------------------------------------------------


_cache: dict[str, Any] = {}


def _resources():
    from .glyphs import RESOURCES_DIR
    from .plan import Resources

    if "resources" not in _cache:
        _cache["resources"] = Resources(RESOURCES_DIR)
    return _cache["resources"]


def _toolchain() -> str | None:
    """sha256 of ``resources/toolchain.json`` (the image writes it), else None (development)."""
    if "toolchain" not in _cache:
        from .plan import toolchain_sha256

        try:
            _cache["toolchain"] = toolchain_sha256(_resources())
        except (FileNotFoundError, NotADirectoryError):
            _cache["toolchain"] = None
    return _cache["toolchain"]


def _fonts_manifest() -> dict[str, Any]:
    if "fonts" not in _cache:
        manifest = _read_json(_resources().fonts_dir / "fonts.json", 1 << 20)
        _cache["fonts"] = manifest if isinstance(manifest, dict) else {}
    return _cache["fonts"]


def _font_entries(doc: Mapping[str, Any]) -> list[dict[str, str]]:
    """The font files the ASS can use: the pack's, the hook design's and the fallback (R6)."""
    from ..captions_ass import load_pack

    manifest = _fonts_manifest()
    by_file = {font.get("file"): font for font in manifest.get("fonts", [])
               if isinstance(font, dict)}
    pack = doc["captions"]["pack"]
    files = [load_pack(pack["id"], pack["v"]).font_file]
    hook = _hook_item(doc)
    if hook is not None:
        design = hook["payload"]["design"]
        spec = _read_json(_resources().hook_design_file(design["id"], design["v"]), 1 << 20)
        font = spec.get("font", {}).get("file") if isinstance(spec, dict) else None
        files.append(font if isinstance(font, str) else HOOK_FONT_FALLBACK)
    files.append(manifest.get("fallback", "DejaVuSans.ttf"))
    entries = []
    for name in dict.fromkeys(files):
        font = by_file.get(name)
        if font is None:
            continue
        sha = font["sha256"]
        entries.append({"family": font["family"],
                        "url": f"/api/resources/fonts/{name}?v={sha[:16]}", "sha256": sha})
    return entries


# --- documents ----------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Validated:
    doc: dict
    seed: dict
    reference: dict  # the seed, or the stored revision of a read-only document
    words: dict
    assets: dict
    warnings: tuple


def _validated(clip: Path, doc_raw: bytes) -> _Validated:
    from . import store
    from .doc import iter_asset_ids, parse_doc, validate_doc

    doc = parse_doc(doc_raw)
    seed_doc, _etag = store.seed(clip)
    reference = seed_doc
    if doc.get("base") != seed_doc["base"]:
        current, _current_etag, _is_seed = store.get(clip)
        if current.get("base") == doc.get("base"):
            reference = current  # the job re-ran: a read-only document keeps its own words
    words = store.load_words(clip, reference["base"]["words"]["sha256"])
    assets = store.load_assets(clip, iter_asset_ids(doc))
    validation = validate_doc(doc, words=words, assets=assets, seed=reference)
    if validation.errors:
        first = validation.errors[0]
        raise DocSemanticInvalid(first.code, path=first.path, ref=first.ref,
                                 issues=validation.errors)
    return _Validated(doc, seed_doc, reference, words, assets, validation.warnings)


def _with_layout(doc: Mapping[str, Any], layout: str) -> dict:
    changed = dict(doc)
    changed["layout"] = {**doc["layout"], "default": {**doc["layout"]["default"], "mode": layout}}
    return changed


def _hook_item(doc: Mapping[str, Any]) -> Mapping[str, Any] | None:
    for track in doc["tracks"]:
        if track["kind"] == "hook" and track["items"]:
            return track["items"][0]
    return None


def _build(clip: Path, validated: _Validated, doc: Mapping[str, Any] | None = None):
    """(render plan, camera sha) of the validated document (or ``doc``, a layout variant)."""
    from . import plates
    from .plan import build_plan

    doc = validated.doc if doc is None else doc
    camera, camera_sha = plates.camera_for(clip, doc)
    plan = build_plan(doc, words=validated.words, camera=camera, assets=validated.assets,
                      resources=_resources())
    return plan, camera_sha


# --- keys --------------------------------------------------------------------------------------------


def audio_key(plan: Any, toolchain_sha256: str | None) -> str:
    """The identity of a preview mix: everything the ``audio_preview`` output depends on (the
    source, the pieces, both envelopes, the music item and asset, the master settings) and
    nothing else, so a caption or layout edit reuses the mix."""
    doc = plan.doc
    source = doc["base"]["source"]
    music = plan.music
    music_identity = None
    if music is not None:
        payload = music["payload"]
        music_identity = {"asset": payload["asset"], "src_in_smp": payload["src_in_smp"],
                          "loop": payload["loop"],
                          "meta": dict(plan.assets.get(payload["asset"], {}))}
    return _sha({
        "schema": AUDIO_SCHEMA,
        "compiler": COMPILER_VERSION,
        "render_semantics": RENDER_SEMANTICS,
        "source": source["content_sha256"] if source["has_audio"] else None,
        "has_audio": source["has_audio"],
        "fps": plan.fps.to_json(),
        "pieces": [[p.in_sf, p.out_sf, p.out_f0, p.frames] for p in plan.pieces],
        "total_samples": plan.total_samples,
        "speech_envelope": [list(point) for point in plan.speech_envelope],
        "music": music_identity,
        "music_envelope": None if plan.music_envelope is None
        else [list(point) for point in plan.music_envelope],
        "master": dict(doc["audio"]["master"]),
        "source_gain_cdb": doc["audio"]["source"]["gain_cdb"],
        "toolchain": toolchain_sha256,
    })


def frame_key(plan_sha256: str, toolchain_sha256: str | None) -> str:
    """The first 16 hex of the truth-frame identity (plan sha, compiler, toolchain)."""
    return _sha({"schema": FRAME_SCHEMA, "plan": plan_sha256, "compiler": COMPILER_VERSION,
                 "toolchain": toolchain_sha256})[:16]


def derived_name(asset: str, w: int, h: int, opacity_pm: int,
                 toolchain_sha256: str | None) -> str:
    """``<key16>@<w>x<h>a<opacity_pm>.png``: the opacity is baked into the bitmap."""
    key = _sha({"schema": DERIVED_SCHEMA, "asset": asset, "compiler": COMPILER_VERSION,
                "toolchain": toolchain_sha256})
    return f"{key[:16]}@{w}x{h}a{opacity_pm}.png"


# --- ops ---------------------------------------------------------------------------------------------


@dataclass
class _Context:
    job: Path
    job_id: str
    clip: Path
    clip_id: str
    cancel: threading.Event

    @property
    def preview(self) -> Path:
        return self.clip / PREVIEW_DIR

    def url(self, kind: str, name: str) -> str:
        return f"/api/jobs/{self.job_id}/clips/{self.clip_id}/media/{kind}/{name}"


def _audio_meta(path: Path) -> dict | None:
    meta = _read_json(path, MAX_META_BYTES)
    if not (isinstance(meta, dict) and _is_int(meta.get("samples"), 0, _MAX_SAFE)
            and type(meta.get("gainCdb")) is int and isinstance(meta.get("warnings"), list)
            and all(isinstance(w, dict) and isinstance(w.get("code"), str)
                    for w in meta["warnings"])):
        return None
    return meta


def _auto_render(ctx: _Context, seed_doc: Mapping[str, Any]) -> tuple[str | None, dict]:
    """(URL of the auto render of this clip, its manifest entry or {})."""
    manifest = _read_json(ctx.job / "output" / "manifest.json", MAX_MANIFEST_BYTES)
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    clips = [c for c in clips if isinstance(c, dict)] if isinstance(clips, list) else []
    rank = seed_doc["base"]["origin"]["rank_at_seed"]
    entry = next((c for c in clips if c.get("clip_id") == ctx.clip_id), None)
    if entry is None:
        entry = next((c for c in clips if c.get("index") == rank and "clip_id" not in c), {})
    index = entry.get("index", rank)
    if not _is_int(index, 1, 99):
        return None, entry
    name = f"clip-{index:02d}.mp4"
    if not _is_file(ctx.job / "output" / name):
        return None, entry
    return f"/api/jobs/{ctx.job_id}/files/output/{name}", entry


def _rev0(ctx: _Context, validated: _Validated, plan: Any) -> dict[str, Any]:
    from . import plates, store
    from .doc import content_equals_seed, iter_asset_ids
    from .plan import build_plan

    seed_doc = validated.seed
    rev0_sha: str | None
    if content_equals_seed(validated.doc, seed_doc):
        rev0_sha = plan.plan_sha256
    else:
        try:
            words = (validated.words if validated.reference is seed_doc
                     else store.load_words(ctx.clip, seed_doc["base"]["words"]["sha256"]))
            camera, _camera_sha = plates.camera_for(ctx.clip, seed_doc)
            rev0_sha = build_plan(seed_doc, words=words, camera=camera,
                                  assets=store.load_assets(ctx.clip, iter_asset_ids(seed_doc)),
                                  resources=_resources()).plan_sha256
        except EditV2Error:
            rev0_sha = None
    url, entry = _auto_render(ctx, seed_doc)
    exact = bool(url is not None and rev0_sha is not None and plan.plan_sha256 == rev0_sha
                 and seed_doc["base"]["engine"]["compiler"] == COMPILER_ID
                 and entry.get("render_engine", COMPILER_ID) == COMPILER_ID
                 and entry.get("plan_sha256", rev0_sha) == rev0_sha)
    return {"planSha256": rev0_sha, "autoRenderUrl": url, "exact": exact}


def _issue_json(issue: Any) -> dict[str, Any]:
    return issue.to_json() if hasattr(issue, "to_json") else dict(issue)


def _plan(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import plates

    request = _request(envelope["requestRaw"], allowed=_PLAN_FIELDS,
                       required=frozenset({"doc"}))
    validated = _validated(ctx.clip, request.doc_raw)
    plan, camera_sha = _build(ctx.clip, validated)
    doc = plan.doc
    toolchain = _toolchain()
    fps = plan.fps
    captions = plan.captions
    assert captions is not None

    ass_sha = captions.ass_sha256
    ass_name = f"{ass_sha[:16]}.ass"
    if not _is_file(ctx.preview / "ass" / ass_name):
        _publish(ctx.preview / "ass" / ass_name, captions.ass.encode("utf-8"))
    text: dict[str, Any] = {"assSha256": ass_sha}
    if request.known_ass != ass_sha:
        text["ass"] = captions.ass
    text["url"] = ctx.url("ass", ass_name)
    text["fonts"] = _font_entries(doc)

    key = plates.plate_key(doc, camera_sha256=camera_sha, toolchain_sha256=toolchain)
    cells = plates.cells_for_pieces(plan.pieces, fps)
    cell_states = []
    missing = []
    for k in cells:
        name = plates.cell_name(key, k)
        if _is_file(ctx.preview / "plates" / name):
            cell_states.append({"k": k, "state": "ready", "url": ctx.url("plates", name)})
        else:
            cell_states.append({"k": k, "state": "queued"})
            missing.append(k)

    upper = doc["captions"]["overrides"]["case"] == "upper"
    cues = []
    for cue in captions.cues:
        words_text = " ".join(word.text for word in cue.words)
        cues.append({"f0": cue.f0, "f1": cue.f1, "text": words_text.upper() if upper
                     else words_text, "words": [word.id for word in cue.words]})
    hook = None
    item = _hook_item(doc)
    if item is not None:
        start = item["start"].get("f", 0)
        if start < plan.total_frames:
            hook = {"f0": start, "f1": min(start + item["dur_f"], plan.total_frames),
                    "lines": list(captions.hook_lines),
                    "overflow": any(i.code == "hook_overflow" for i in plan.warnings)}

    logo_dto = logo_lane = None
    if plan.logo is not None:
        box = plan.logo
        name = derived_name(box.asset, box.w, box.h, box.opacity_pm, toolchain)
        ready = _is_file(ctx.preview / "derived" / name)
        logo_dto = {"box": {"x": box.x, "y": box.y, "w": box.w, "h": box.h},
                    "opacityPm": box.opacity_pm, "state": "ready" if ready else "queued"}
        if ready:
            logo_dto["url"] = ctx.url("derived", name)
        logo_lane = {"asset": box.asset, "w": box.w, "h": box.h, "opacityPm": box.opacity_pm,
                     "name": name, "ready": ready}

    mix = audio_key(plan, toolchain)
    flac = f"{mix[:16]}.flac"
    audio_ready = _is_file(ctx.preview / "audio" / flac)
    audio: dict[str, Any] = {"mixSha256": mix, "state": "ready" if audio_ready else "queued"}
    if audio_ready:
        audio["url"] = ctx.url("audio", flac)
    audio.update(samples=plan.total_samples,
                 musicGainPoints=[] if plan.music_envelope is None
                 else [list(point) for point in plan.music_envelope],
                 speechSpans=[list(span) for span in plan.speech_spans])
    meta = _audio_meta(ctx.preview / "audio" / f"{mix[:16]}.json") if audio_ready else None

    warnings: list[dict[str, Any]] = []
    seen = set()
    for issue in [*validated.warnings, *plan.warnings]:
        entry = _issue_json(issue)
        marker = (entry.get("code"), entry.get("path"), entry.get("ref"))
        if marker not in seen:
            seen.add(marker)
            warnings.append(entry)
    for entry in meta["warnings"] if meta else ():
        marker = (entry.get("code"), entry.get("path"), entry.get("ref"))
        if marker not in seen:
            seen.add(marker)
            warnings.append(entry)

    from .doc import doc_sha256

    dto = {
        "planSha256": plan.plan_sha256,
        "docSha256": doc_sha256(doc),
        "compiler": COMPILER_ID,
        "renderSemantics": RENDER_SEMANTICS,
        "fps": fps.to_json(),
        "totalFrames": plan.total_frames,
        "output": {"w": plan.output[0], "h": plan.output[1]},
        "pieces": [piece.to_dto() for piece in plan.pieces],
        "cues": cues,
        "hook": hook,
        "text": text,
        "plate": {"plateKey": key, "cellFrames": tm.cell_frames(fps), "w": plan.output[0],
                  "h": plan.output[1], "cells": cell_states},
        "logo": logo_dto,
        "audio": audio,
        "rev0": _rev0(ctx, validated, plan),
        "warnings": warnings,
        "errors": [],
    }
    lane = {
        "playhead": min(request.playhead, max(plan.total_frames - 1, 0)),
        "layout": doc["layout"]["default"]["mode"],
        "plateKey": key,
        "cellFrames": tm.cell_frames(fps),
        "cells": list(cells),
        "missing": missing,
        "audio": {"key": mix, "ready": audio_ready},
        "logo": logo_lane,
        "frameKey": frame_key(plan.plan_sha256, toolchain),
    }
    return {"dto": dto, "lane": lane}


def _prepare(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import plates, store
    from .source_info import write_immutable

    seed_doc, _etag = store.seed(ctx.clip)
    if not store.words_exist(ctx.clip, seed_doc["base"]["words"]["sha256"]):
        from . import seed as seed_module

        seed_module.prepare_legacy_job(ctx.job)  # restores the artifact only if identical
        if not store.words_exist(ctx.clip, seed_doc["base"]["words"]["sha256"]):
            raise AnalysisMissing()
    current, _current_etag, _is_seed = store.get(ctx.clip)
    layout = envelope["layout"] or current["layout"]["default"]["mode"]
    doc = _with_layout(current, layout)
    camera_state = "not_needed"
    camera_sha = None
    if layout == "camera":
        try:
            _camera, camera_sha = plates.camera_for(ctx.clip, doc)
        except AnalysisMissing:
            from . import camera as camera_module

            fps = tm.Fps.from_json(doc["output"]["fps"])
            built = camera_module.build_camera_plan(
                plates.source_path(ctx.job), tuple(doc["base"]["window_ms"]), fps,
                out_w=doc["output"]["w"], out_h=doc["output"]["h"])
            raw = camera_module.encode_camera_plan(built)
            write_immutable(ctx.clip / camera_module.camera_file_name(raw), raw)
            _camera, camera_sha = plates.camera_for(ctx.clip, doc)
        camera_state = "ready"
    fps = tm.Fps.from_json(doc["output"]["fps"])
    key = plates.plate_key(doc, camera_sha256=camera_sha, toolchain_sha256=_toolchain())
    cells = plates.cells_for_pieces(tm.pieces(current), fps)
    ready = [k for k in cells if _is_file(ctx.preview / "plates" / plates.cell_name(key, k))]
    return {"words": "ready", "camera": camera_state, "layout": layout, "plateKey": key,
            "cellFrames": tm.cell_frames(fps), "cells": list(cells), "ready": ready}


def _cells(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import plates, store

    seed_doc, _etag = store.seed(ctx.clip)
    doc = _with_layout(seed_doc, envelope["layout"])
    camera, camera_sha = plates.camera_for(ctx.clip, doc)
    key = plates.plate_key(doc, camera_sha256=camera_sha, toolchain_sha256=_toolchain())
    fps = tm.Fps.from_json(doc["output"]["fps"])
    size = tm.cell_frames(fps)
    window = doc["base"]["window_ms"]
    low = tm.sf_floor(window[0], fps)
    high = min(tm.sf_ceil(window[1], fps), tm.sf_ceil(doc["base"]["source"]["duration_ms"], fps))
    wanted = sorted(set(envelope["cells"]))
    if any((k + 1) * size <= low or k * size >= high for k in wanted):
        raise DocSemanticInvalid("range_invalid", path="/cells")
    directory = ctx.preview / "plates"
    present = [k for k in wanted if _is_file(directory / plates.cell_name(key, k))]
    missing = [k for k in wanted if k not in present]
    if missing:
        plan = plates.plate_plan(doc, camera=camera, resources=_resources())
        built = plates.build_cells(plan, source=plates.source_path(ctx.job),
                                   assets_root=ctx.job / "analysis" / "assets", cells=missing,
                                   cancel=ctx.cancel, timeout_s=60.0 + 15.0 * len(missing))
        for k in missing:
            _publish(directory / plates.cell_name(key, k), built[k])
    return {"plateKey": key, "built": missing, "present": present}


def _measure(ctx: _Context, plan: Any, source: Path, assets_root: Path):
    """The pre-master loudness and true peak, cached by the pre-master mix sha."""
    from . import execute, plates
    from .compile_ffmpeg import compile_job
    from .loudness import Loudness, parse_ebur128

    job = plates.lane_threads(compile_job(plan, mode="audio_measure", source=source,
                                          assets_root=assets_root))
    mix = job.expected["mix_sha256"]
    path = ctx.preview / "audio" / f"{mix[:16]}.loudness.json"
    cached = _read_json(path, MAX_META_BYTES)
    if (isinstance(cached, dict) and cached.get("mixSha256") == mix
            and type(cached.get("i_clufs")) is int and type(cached.get("tp_cdb")) is int):
        return Loudness(cached["i_clufs"], cached["tp_cdb"])
    timeout = 60.0 + plan.total_samples / 48_000
    result = execute.run(job, output_fd=None, timeout_s=timeout, cancel=ctx.cancel)
    measured = parse_ebur128(result.stderr)
    _publish(path, _canonical({"mixSha256": mix, "i_clufs": measured.i_clufs,
                               "tp_cdb": measured.tp_cdb}))
    return measured


def _audio(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import execute, plates
    from .compile_ffmpeg import compile_job
    from .loudness import needs_measurement

    request = _request(envelope["requestRaw"], allowed=_PLAN_FIELDS,
                       required=frozenset({"doc"}))
    validated = _validated(ctx.clip, request.doc_raw)
    doc = validated.doc
    if doc["layout"]["default"]["mode"] == "camera":
        try:
            plates.camera_for(ctx.clip, doc)
        except AnalysisMissing:
            doc = _with_layout(doc, "fit_blur")  # the mix does not depend on the layout
    plan, _camera_sha = _build(ctx.clip, validated, doc)
    key = audio_key(plan, _toolchain())
    directory = ctx.preview / "audio"
    name = f"{key[:16]}.flac"
    meta_path = directory / f"{key[:16]}.json"
    meta = _audio_meta(meta_path) if _is_file(directory / name) else None
    if meta is not None:
        return {"audioKey": key, "name": name, "built": False, "samples": meta["samples"],
                "gainCdb": meta["gainCdb"], "warnings": meta["warnings"]}
    source = plates.source_path(ctx.job)
    assets_root = ctx.job / "analysis" / "assets"
    measured = _measure(ctx, plan, source, assets_root) if needs_measurement(plan.doc) else None
    job = plates.lane_threads(compile_job(plan, mode="audio_preview", source=source,
                                          assets_root=assets_root, loudness=measured))
    timeout = 60.0 + plan.total_samples / 48_000
    _publish_run(directory, name, lambda fd: execute.run(job, output_fd=fd, timeout_s=timeout,
                                                          cancel=ctx.cancel))
    warnings = list(job.expected.get("warnings", []))
    meta = {"samples": plan.total_samples, "gainCdb": job.expected["gain_cdb"],
            "warnings": warnings, "mixSha256": job.expected["mix_sha256"]}
    _publish(meta_path, _canonical(meta))
    return {"audioKey": key, "name": name, "built": True, "samples": plan.total_samples,
            "gainCdb": meta["gainCdb"], "warnings": warnings}


def _frame(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import execute, plates
    from .compile_ffmpeg import compile_job

    request = _request(envelope["requestRaw"], allowed=_FRAME_FIELDS, required=_FRAME_FIELDS)
    validated = _validated(ctx.clip, request.doc_raw)
    plan, _camera_sha = _build(ctx.clip, validated)
    frame = request.f
    if frame is None or not 0 <= frame < plan.total_frames:
        raise DocSemanticInvalid("range_invalid", path="/f")
    name = f"{frame_key(plan.plan_sha256, _toolchain())}-{frame}-{plan.output[0]}.png"
    path = ctx.preview / "frames" / name
    if _is_file(path):
        return {"name": name, "planSha256": plan.plan_sha256, "built": False}
    job = compile_job(plan, mode="frame", frame=frame, source=plates.source_path(ctx.job),
                      assets_root=ctx.job / "analysis" / "assets")
    result = execute.run(job, output_fd=None, timeout_s=60.0, cancel=ctx.cancel)
    assert result.output is not None
    _publish(path, result.output)
    return {"name": name, "planSha256": plan.plan_sha256, "built": True}


def _derive(ctx: _Context, envelope: Mapping[str, Any]) -> dict[str, Any]:
    from . import store
    from .compile_ffmpeg import asset_path
    from .derive import derive_image

    asset = envelope["asset"]
    meta = store.load_assets(ctx.clip, [asset]).get(asset)
    if meta is None or meta.get("kind") != "image":
        raise DocSemanticInvalid("asset_missing", path="/asset", ref=asset)
    name = derived_name(asset, envelope["w"], envelope["h"], envelope["opacityPm"],
                        _toolchain())
    path = ctx.preview / "derived" / name
    if _is_file(path):
        return {"name": name, "built": False}
    if ctx.cancel.is_set():
        from .errors import Cancelled

        raise Cancelled("cancelled")
    png = derive_image(asset_path(ctx.job / "analysis" / "assets", asset, "image"),
                       w=envelope["w"], h=envelope["h"], opacity_pm=envelope["opacityPm"])
    _publish(path, png)
    return {"name": name, "built": True}


_HANDLERS: dict[str, Callable[[_Context, Mapping[str, Any]], dict[str, Any]]] = {
    "prepare": _prepare,
    "plan": _plan,
    "cells": _cells,
    "audio": _audio,
    "frame": _frame,
    "derive": _derive,
}
HEAVY_OPS = frozenset({"prepare", "cells", "audio", "frame", "derive"})


# --- cancellation -------------------------------------------------------------------------------------


class _CancelWatch:
    """Sets ``event`` when ``preview/.cancel/<token>`` appears (polled every 50 ms)."""

    def __init__(self, clip: Path, token: str | None, event: threading.Event) -> None:
        self.event = event
        self.stop = threading.Event()
        self.thread = None
        if token is not None:
            marker = clip / PREVIEW_DIR / CANCEL_DIR / token
            self.thread = threading.Thread(target=self._poll, args=(marker,), daemon=True)
            self.thread.start()

    def _poll(self, marker: Path) -> None:
        while not self.stop.is_set() and not self.event.is_set():
            if os.path.lexists(marker):
                self.event.set()
                return
            self.stop.wait(CANCEL_POLL_S)

    def close(self) -> None:
        self.stop.set()


# --- entry points -------------------------------------------------------------------------------------


def _error(error: EditV2Error) -> dict:
    payload: dict[str, Any] = {"error": {"code": error.code, "path": error.path,
                                         "ref": error.ref, "messageId": message_id(error.code)}}
    issues = [issue.to_json() for issue in error.issues if hasattr(issue, "to_json")]
    if issues:
        payload["errors"] = issues
    return payload


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None,
           cancel: threading.Event | None = None, renice: bool = False) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never raises and never echoes paths, user
    text or exception messages (only fixed codes). ``renice`` lowers the priority of the heavy
    ops (the process entry point sets it; in-process callers keep theirs)."""
    usage = {"error": {"code": "internal_error", "path": None, "ref": None,
                       "messageId": message_id("internal_error")}}
    watch = None
    try:
        envelope = _envelope(raw)
        job = _job_dir(jobs_root, envelope["jobId"])
        clip = _clip_dir(job, envelope["clipId"])
        event = cancel if cancel is not None else threading.Event()
        watch = _CancelWatch(clip, envelope.get("cancelToken"), event)
        if renice and envelope["op"] in HEAVY_OPS:
            try:
                os.nice(NICE)
            except OSError:
                pass
        ctx = _Context(job, envelope["jobId"], clip, envelope["clipId"], event)
        return EXIT_OK, _HANDLERS[envelope["op"]](ctx, envelope)
    except _Usage:
        return EXIT_USAGE, usage
    except EditV2Error as error:
        return exit_code_for(error), _error(error)
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        return EXIT_INTERNAL, usage
    finally:
        if watch is not None:
            watch.close()


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; returns the process exit code."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    cancel = threading.Event()

    def terminate(_signum: int, _frame: Any) -> None:
        cancel.set()

    signal.signal(signal.SIGTERM, terminate)
    if arguments:
        code, payload = EXIT_USAGE, handle(b"", jobs_root=None)[1]
    else:
        raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        code, payload = handle(raw, jobs_root=os.environ.get("JOBS_ROOT"), cancel=cancel,
                               renice=True)
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                            .encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return code


__all__ = ["HEAVY_OPS", "MAX_ENVELOPE_BYTES", "OPS", "audio_key", "derived_name",
           "frame_key", "handle", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
