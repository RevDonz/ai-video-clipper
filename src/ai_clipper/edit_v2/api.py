"""CLI ``python -m ai_clipper.edit_v2.api`` for the Node routes (plan §4.2, §11.1 T1.1).

Owner: T1.1. Protocol (frozen, see ``docs/editor/CONTRACTS.md`` §5.9):

* stdin: one JSON envelope ``{"op": <op>, ...}`` (≤ 2 MiB, no duplicate keys, exactly the keys
  of its op) with camelCase arguments. Ids are validated by regex before use; paths are never
  accepted: the job directory is ``$JOBS_ROOT/<jobId>`` and a clip directory
  ``<job>/analysis/clips/<clipId>``, each a real directory (no symlink). Document bytes travel
  base64-encoded (``docRaw``) so that they are validated exactly as received.
* stdout: one JSON object and a newline. On failure ``{"error": {"code", "path", "ref",
  "messageId"}}``, plus ``"errors": [{code, path, ref?, f?}, …]`` when the failure lists issues
  (422) and ``"current"``/``"etag"`` for a revision conflict. Messages never contain paths,
  user text or exception details.
* exit codes: ``errors.EXIT_*`` — 0 ok, 1 internal (also ``JOBS_ROOT`` unset), 2 usage (a
  malformed envelope; error code ``internal_error``), 3 invalid (parse level), 4 not found,
  5 revision conflict, 6 semantic, 7 schema too new, 8 analysis missing, 9 idempotency.

Ops (arguments → result):

``clips`` ``{jobId}`` → ``{clips: [{clipId, index, title, hookText, description, hashtags,
durationMs, engine, edit, latestRender, openable, reason}]}``. Read-only. V3 clips come from
``analysis/selection.v3.json`` in rank order (``index`` = rank = the ``clip-NN`` number); when
the selection is unavailable, or the job is not V3, the manifest's clips are listed instead.
``clipId`` needs ``analysis/source.json`` (``content_sha256``) and follows plan §3.5 (the cold
open counts only when the job ran with ``coldOpen``); ``engine`` is the seed's
``base.engine.compiler`` (``"edit-v2/1"`` or ``"legacy"``); ``edit`` is ``{state: "seed" |
"edited", revision, etag, updatedAtMs}`` when ``seed.json`` exists, else null;
``durationMs`` is the current document's length (else the selection's);
``latestRender`` is null until T2.2 adds render-request-v3; ``openable`` is true exactly when
the seed exists and the source file exists. ``reason`` (``errors.CLIP_REASONS``), first
match: ``not_v3``, ``analysis_incomplete`` (no selection and ``.attempts/`` left),
``selection_unreadable``, ``source_missing``, ``transcript_missing`` (no
``output/transcript.json`` and no seed), ``needs_prepare`` (no seed yet).

``prepare_job`` ``{jobId}`` → ``{state: "done", clips: [{clipId, index, openable, reason}]}``:
calls ``seed.prepare_legacy_job(job_dir)`` (T1.5), idempotent.

``get`` ``{jobId, clipId}`` → ``{doc, etag, isSeed, seed, seedEtag, engine, notices, words:
{sha256, url}, readOnly, readOnlyReason}``. Writes nothing. ``readOnly`` is true with
``readOnlyReason: "transcript_changed"`` when the document's ``base.words.sha256`` is not the
seed's (the job re-ran; the seed names the current words); ``words`` is the document's words
artifact, or the seed's when a read-only document's own words are gone. ``notices`` holds
``"legacy_engine"`` for a seed built by prepare of an older job. Exit 8
(``analysis_missing``) when the words artifact does not exist yet.

``seed`` ``{jobId, clipId}`` → the same shape for the seed itself (``?seed=1``, "Kembali ke
versi AI").

``put`` ``{jobId, clipId, expectedEtag, idempotencyKey, docRaw}`` → ``{doc, etag, warnings:
[{code, path, ref?, f?}]}``. ``expectedEtag`` is the ``If-Match`` value (64 lowercase hex),
``idempotencyKey`` a UUID, ``docRaw`` the request body in base64 (see ``store.put``).

``archive`` ``{jobId, clipId, etag}`` → ``{relative, revision}``: the job-relative path of that
revision for a render request (``seed.json`` for revision 0), archiving the current revision
when needed.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import stat
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from .. import edit_manifest as _v1
from ..selection_v3 import SELECTION_ARTIFACT_RELATIVE_PATH, read_selection_artifact
from . import seed as seed_module
from . import store
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN, clip_id, ms_from_seconds
from .errors import (
    CLIP_REASONS,
    EXIT_INTERNAL,
    EXIT_OK,
    EXIT_USAGE,
    AnalysisMissing,
    EditV2Error,
    NotFound,
    RevisionConflict,
    exit_code_for,
    message_id,
)

OPS = ("clips", "prepare_job", "get", "put", "seed", "archive")

MAX_ENVELOPE_BYTES = 2 << 20
MAX_JOB_BYTES = 2 << 20
MAX_MANIFEST_BYTES = 16 << 20
MAX_SOURCE_INFO_BYTES = 1 << 20
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
                   re.IGNORECASE)
_SHA = re.compile(r"[0-9a-f]{64}")
_B64 = re.compile(r"[A-Za-z0-9+/]*={0,2}")
_FIELDS = {
    "clips": ("jobId",),
    "prepare_job": ("jobId",),
    "get": ("jobId", "clipId"),
    "seed": ("jobId", "clipId"),
    "put": ("jobId", "clipId", "expectedEtag", "idempotencyKey", "docRaw"),
    "archive": ("jobId", "clipId", "etag"),
}
_PATTERNS = {
    "jobId": _UUID,
    "clipId": CLIP_ID_PATTERN,
    "expectedEtag": _SHA,
    "etag": _SHA,
    "idempotencyKey": _UUID,
    "docRaw": _B64,
}


class _Usage(Exception):
    """A malformed envelope (exit 2)."""


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


# --- envelope ------------------------------------------------------------------------------------


def _pairs(items: list[tuple[str, Any]]) -> dict:
    result = dict(items)
    if len(result) != len(items):
        raise _Usage()
    return result


def _envelope(raw: bytes) -> dict[str, str]:
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_ENVELOPE_BYTES:
        raise _Usage()
    try:
        value = json.loads(bytes(raw).decode("utf-8"), object_pairs_hook=_pairs,
                           parse_constant=lambda _value: _Usage())
    except (ValueError, RecursionError):
        raise _Usage() from None
    if type(value) is not dict:
        raise _Usage()
    op = value.get("op")
    if not isinstance(op, str) or op not in _FIELDS or set(value) != {"op", *_FIELDS[op]}:
        raise _Usage()
    for name in _FIELDS[op]:
        field = value[name]
        if not isinstance(field, str) or _PATTERNS[name].fullmatch(field) is None:
            raise _Usage()
    return value


# --- paths ---------------------------------------------------------------------------------------


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


def _clip_dir(job: Path, clip_id_value: str) -> Path:
    for part in (job / "analysis", job / "analysis" / "clips"):
        _real_dir(part)
    return _real_dir(job / "analysis" / "clips" / clip_id_value)


def _regular(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return False


def _read_json(path: Path, limit: int) -> object:
    """A small JSON file (regular, not a symlink), or None when missing or unreadable."""
    try:
        raw = _v1._read_regular(path, limit)
    except (OSError, _v1.EditManifestError):
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


# --- ops ------------------------------------------------------------------------------------------


def _words(clip: Path, doc: Mapping, seed_doc: Mapping, read_only: bool) -> str:
    """The sha of the words artifact to serve: the document's, or the seed's when a read-only
    document's own words are gone. ``AnalysisMissing`` when neither exists yet."""
    words_sha = doc["base"]["words"]["sha256"]
    if not store.words_exist(clip, words_sha):
        seed_sha = seed_doc["base"]["words"]["sha256"]
        if read_only and store.words_exist(clip, seed_sha):
            words_sha = seed_sha
        else:
            raise AnalysisMissing()
    return words_sha


def _document(job_id: str, clip: Path, *, seed_only: bool) -> dict:
    seed_doc, seed_etag = store.seed(clip)
    if seed_only:
        doc, etag, is_seed = seed_doc, seed_etag, True
    else:
        doc, etag, is_seed = store.get(clip)
    read_only = doc["base"]["words"]["sha256"] != seed_doc["base"]["words"]["sha256"]
    words_sha = _words(clip, doc, seed_doc, read_only)
    engine = seed_doc["base"]["engine"]["compiler"]
    return {
        "doc": doc,
        "etag": etag,
        "isSeed": is_seed,
        "seed": seed_doc,
        "seedEtag": seed_etag,
        "engine": engine,
        "notices": ["legacy_engine"] if engine == "legacy" else [],
        "words": {"sha256": words_sha,
                  "url": f"/api/jobs/{job_id}/clips/{clip.name}/words"},
        "readOnly": read_only,
        "readOnlyReason": "transcript_changed" if read_only else None,
    }


def _put(clip: Path, envelope: Mapping[str, str], now_ms: int) -> dict:
    encoded = envelope["docRaw"]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise _Usage() from None
    doc, etag, warnings = store.put(clip, expected_etag=envelope["expectedEtag"],
                                    idempotency_key=envelope["idempotencyKey"], raw=raw,
                                    now_ms=now_ms)
    return {"doc": doc, "etag": etag, "warnings": [issue.to_json() for issue in warnings]}


def _archive(clip: Path, etag: str) -> dict:
    relative, revision = store.archive_for_render(clip, etag)
    return {"relative": relative, "revision": revision}


def _prepare_job(job: Path) -> dict:
    results = seed_module.prepare_legacy_job(job)
    if not isinstance(results, list):
        raise EditV2Error("internal_error")
    clips = []
    for entry in results:
        if not isinstance(entry, Mapping):
            raise EditV2Error("internal_error")
        clip_value, index = entry.get("clip_id"), entry.get("index")
        openable, reason = entry.get("openable"), entry.get("reason")
        if not ((clip_value is None or (isinstance(clip_value, str)
                                        and CLIP_ID_PATTERN.fullmatch(clip_value)))
                and type(index) is int and index >= 1 and type(openable) is bool
                and (reason is None or reason in CLIP_REASONS)):
            raise EditV2Error("internal_error")
        clips.append({"clipId": clip_value, "index": index, "openable": openable,
                      "reason": reason})
    return {"state": "done", "clips": clips}


# --- clips ------------------------------------------------------------------------------------------


def _text_or_none(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def _manifest_entries(job: Path) -> list[dict]:
    manifest = _read_json(job / "output" / "manifest.json", MAX_MANIFEST_BYTES)
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    entries = []
    for position, clip in enumerate(clips if isinstance(clips, list) else (), start=1):
        if not isinstance(clip, dict):
            continue
        index = clip.get("index")
        start, end = clip.get("start"), clip.get("end")
        duration = None
        if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, end)) \
                and 0 <= start < end:
            duration = ms_from_seconds(end) - ms_from_seconds(start)
        hashtags = clip.get("hashtags")
        entries.append(_entry(
            index=index if type(index) is int and index >= 1 else position,
            title=_text_or_none(clip.get("title")),
            hook_text=_text_or_none(clip.get("hook_text")),
            description=_text_or_none(clip.get("description")),
            hashtags=[tag for tag in hashtags if isinstance(tag, str)]
            if isinstance(hashtags, list) else [],
            duration_ms=duration))
    return entries


def _entry(*, index: int, title: str | None, hook_text: str | None,
           description: str | None, hashtags: list[str], duration_ms: int | None) -> dict:
    return {"clipId": None, "index": index, "title": title, "hookText": hook_text,
            "description": description, "hashtags": hashtags, "durationMs": duration_ms,
            "engine": None, "edit": None, "latestRender": None, "openable": False,
            "reason": None}


def _with_reason(entries: list[dict], reason: str) -> dict:
    for entry in entries:
        entry["reason"] = reason
    return {"clips": entries}


def _source_exists(job: Path, job_info: Mapping) -> bool:
    source = job_info.get("sourcePath")
    if not isinstance(source, str) or not source or "\0" in source:
        return False
    path = Path(source)
    return _regular(path if path.is_absolute() else job / path)


def _source_sha(job: Path) -> str | None:
    info = _read_json(job / "analysis" / "source.json", MAX_SOURCE_INFO_BYTES)
    value = info.get("content_sha256") if isinstance(info, dict) else None
    return value if isinstance(value, str) and _SHA.fullmatch(value) else None


def _duration_ms(doc: Mapping) -> int:
    fps = tm.Fps.from_json(doc["output"]["fps"])
    frames = tm.total_frames(tm.pieces(doc))
    return tm.div_round_half_up(frames * 1000 * fps.den, fps.num)


def _clips(job: Path) -> dict:
    job_info = _read_json(job / "job.json", MAX_JOB_BYTES)
    if not isinstance(job_info, dict):
        raise NotFound()
    options = job_info.get("options")
    options = options if isinstance(options, dict) else {}
    if options.get("selectionMode") != "v3":
        return _with_reason(_manifest_entries(job), "not_v3")
    selection_path = job / SELECTION_ARTIFACT_RELATIVE_PATH
    selection = None
    if _regular(selection_path):
        try:
            selection = read_selection_artifact(selection_path)
        except (OSError, ValueError):
            selection = None
    if selection is None:
        attempts = job / ".attempts"
        incomplete = not selection_path.exists() and attempts.is_dir() \
            and not attempts.is_symlink() and any(attempts.iterdir())
        return _with_reason(_manifest_entries(job),
                            "analysis_incomplete" if incomplete else "selection_unreadable")
    cold_open = options.get("coldOpen", True) is not False
    source_ok = _source_exists(job, job_info)
    source_sha = _source_sha(job)
    transcript_ok = _regular(job / "output" / "transcript.json")
    clips = []
    for clip in selection.clips:
        start_ms, end_ms = ms_from_seconds(clip.start), ms_from_seconds(clip.end)
        teaser = None
        if cold_open and clip.cold_open is not None:
            teaser = (ms_from_seconds(clip.cold_open[0]), ms_from_seconds(clip.cold_open[1]))
        duration = end_ms - start_ms + (teaser[1] - teaser[0] if teaser else 0)
        entry = _entry(index=clip.rank, title=clip.title, hook_text=_text_or_none(clip.hook_text),
                       description=_text_or_none(clip.description),
                       hashtags=list(clip.hashtags), duration_ms=duration)
        clips.append(entry)
        if source_sha is not None:
            entry["clipId"] = clip_id(source_sha, start_ms, end_ms, teaser)
            _attach_edit(entry, job / "analysis" / "clips" / entry["clipId"])
        if not source_ok:
            entry["reason"] = "source_missing"
        elif entry["edit"] is None:
            entry["reason"] = "needs_prepare" if transcript_ok else "transcript_missing"
        else:
            entry["openable"] = True
    return {"clips": clips}


def _attach_edit(entry: dict, clip: Path) -> None:
    """Fill engine, edit and durationMs from the clip's seed and current document, if any."""
    try:
        _real_dir(clip)
        seed_doc, _seed_etag = store.seed(clip)
        doc, etag, is_seed = store.get(clip)
    except NotFound:
        return
    entry["engine"] = seed_doc["base"]["engine"]["compiler"]
    entry["edit"] = {"state": "seed" if is_seed else "edited", "revision": doc["revision"],
                     "etag": etag, "updatedAtMs": doc["audit"]["updated_at_ms"]}
    entry["durationMs"] = _duration_ms(doc)


# --- entry points ---------------------------------------------------------------------------------


def _error(error: EditV2Error) -> dict:
    payload: dict[str, Any] = {"error": {"code": error.code, "path": error.path,
                                         "ref": error.ref, "messageId": message_id(error.code)}}
    issues = [issue.to_json() for issue in error.issues if hasattr(issue, "to_json")]
    if issues:
        payload["errors"] = issues
    if isinstance(error, RevisionConflict):
        payload["current"] = error.current
        payload["etag"] = error.etag
    return payload


def _dispatch(envelope: Mapping[str, str], jobs_root: str | os.PathLike | None,
              now_ms: int | None) -> dict:
    op = envelope["op"]
    job = _job_dir(jobs_root, envelope["jobId"])
    if op == "clips":
        return _clips(job)
    if op == "prepare_job":
        return _prepare_job(job)
    clip = _clip_dir(job, envelope["clipId"])
    handlers: dict[str, Callable[[], dict]] = {
        "get": lambda: _document(envelope["jobId"], clip, seed_only=False),
        "seed": lambda: _document(envelope["jobId"], clip, seed_only=True),
        "put": lambda: _put(clip, envelope, _now_ms() if now_ms is None else now_ms),
        "archive": lambda: _archive(clip, envelope["etag"]),
    }
    return handlers[op]()


def handle(raw: bytes, *, jobs_root: str | os.PathLike | None,
           now_ms: int | None = None) -> tuple[int, dict]:
    """Run one envelope; (exit code, stdout object). Never raises and never echoes paths,
    user text or exception messages (only fixed codes)."""
    usage = {"error": {"code": "internal_error", "path": None, "ref": None,
                       "messageId": message_id("internal_error")}}
    try:
        envelope = _envelope(raw)
        return EXIT_OK, _dispatch(envelope, jobs_root, now_ms)
    except _Usage:
        return EXIT_USAGE, usage
    except EditV2Error as error:
        return exit_code_for(error), _error(error)
    except Exception:  # noqa: BLE001 - the process boundary exposes fixed codes only
        # The envelope was valid: anything else (corrupt stored data included) is internal.
        return EXIT_INTERNAL, usage


def main(argv: Sequence[str] | None = None) -> int:
    """Run one op from the stdin envelope; returns the process exit code."""
    arguments = sys.argv[1:] if argv is None else list(argv)
    if arguments:
        code, payload = EXIT_USAGE, handle(b"", jobs_root=None)[1]
    else:
        raw = sys.stdin.buffer.read(MAX_ENVELOPE_BYTES + 1)
        code, payload = handle(raw, jobs_root=os.environ.get("JOBS_ROOT"))
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                            .encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()
    return code


__all__ = ["MAX_ENVELOPE_BYTES", "OPS", "handle", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
