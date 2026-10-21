""""Pakai di semua klip": one settings group of a clip copied to every other clip of its job.

Owner: CONTRACTS §5.48. Stdlib only. Reached through ``api`` (ops ``apply_all`` and
``undo_apply_all``); every write is an ordinary ``store.put`` of the target clip, so each clip
keeps its own revision chain, If-Match and receipts.

* Groups (``GROUPS``): ``captions`` (``enabled``, ``pack``, ``overrides``; ``word_edits`` belong
  to the clip's words and stay), ``logo`` (the overlay track with its asset metadata, and the text
  watermark) and ``layout`` (``layout`` without ``keyframes``: they are frames of the source
  clip's own window).
* A target is written only while that group is still its seed's (``part(doc) == part(seed)``)
  or what an earlier batch wrote there (not undone); otherwise it is skipped as ``edited``. Other reasons: ``not_ready`` (no seed or words yet),
  ``read_only`` (the job re-ran with other words), ``conflict`` (saved elsewhere while the batch
  ran), ``invalid`` (the result does not validate for that clip). A target that already matches
  is ``unchanged`` and not written.
* The batch record ``analysis/apply-all/<batchId>.json`` (canonical JSON, 0600) is written before
  the first save and names, per target, the revision it starts from. Saves use idempotency keys
  derived from the batch id, so a retry after a crash replays what was saved and finishes the
  rest. The newest ``RECORDS_KEEP`` records are kept.
* Undo writes, for each applied clip still at the batch's revision, a new revision with the
  group restored; a clip saved since is skipped as ``changed``. A second undo answers the same.
"""

from __future__ import annotations

import copy
import fcntl
import json
import os
import stat
import time
import uuid
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .. import job_files
from . import store
from .doc import canonical_bytes
from .errors import (
    AnalysisMissing,
    DocInvalid,
    DocSemanticInvalid,
    EditV2Error,
    IdempotencyConflict,
    NotFound,
    RevisionConflict,
)

GROUPS = ("captions", "logo", "layout")
SKIP_REASONS = ("edited", "not_ready", "read_only", "conflict", "invalid")
UNDO_SKIP_REASONS = ("changed", "invalid")
APPLY_COMMAND = "ApplyToAllClips"
UNDO_COMMAND = "UndoApplyToAllClips"
RECORDS_DIR = "analysis/apply-all"
RECORDS_KEEP = 50
RECORD_SCHEMA = "potongin.apply-all/1"
MAX_RECORD_BYTES = 4 << 20
_LOCK = ".lock"
_KEYS = uuid.UUID("6f1d3c52-8e0b-4f7a-9a51-2c4b7d9e0f13")
_CAPTION_KEYS = ("enabled", "pack", "overrides")
_TRACK_ORDER = {"hook": 0, "visual": 1, "audio": 2}


# --- the model -------------------------------------------------------------------------------------


def _group(group: str) -> str:
    if group not in GROUPS:
        raise ValueError(f"unknown group {group!r}")
    return group


def _overlay(doc: Mapping) -> dict | None:
    for track in doc["tracks"]:
        if track.get("kind") == "visual":
            return copy.deepcopy(track)
    return None


def _asset_ids(track: Mapping | None) -> list[str]:
    if track is None:
        return []
    ids = []
    for item in track.get("items", ()):
        asset = item.get("payload", {}).get("asset")
        if isinstance(asset, str):
            ids.append(asset)
    return ids


def part(doc: Mapping, group: str) -> dict:
    """The settings of ``group`` in ``doc``, as compared with the seed's."""
    if _group(group) == "captions":
        return {key: copy.deepcopy(doc["captions"][key]) for key in _CAPTION_KEYS}
    if group == "logo":
        overlay = _overlay(doc)
        assets = {asset: copy.deepcopy(doc["assets"][asset]) for asset in _asset_ids(overlay)
                  if asset in doc["assets"]}
        return {"overlay": overlay, "watermark": copy.deepcopy(doc.get("watermark")),
                "assets": assets}
    return copy.deepcopy(doc["layout"])


def copied_part(doc: Mapping, group: str) -> dict:
    """What another clip receives: ``part`` without the source clip's framing keyframes."""
    value = part(doc, group)
    if group == "layout":
        value.pop("keyframes", None)
    return value


def with_part(doc: Mapping, group: str, value: Mapping) -> dict:
    """A copy of ``doc`` with ``group`` set to ``value`` (from ``part`` or ``copied_part``)."""
    result = copy.deepcopy(dict(doc))
    value = copy.deepcopy(dict(value))
    if _group(group) == "captions":
        result["captions"] = {**result["captions"], **value}
    elif group == "logo":
        tracks = [track for track in result["tracks"] if track.get("kind") != "visual"]
        if value["overlay"] is not None:
            tracks.append(value["overlay"])
        tracks.sort(key=lambda track: _TRACK_ORDER.get(track.get("kind"), 9))
        result["tracks"] = tracks
        if value["watermark"] is None:
            result.pop("watermark", None)
        else:
            result["watermark"] = value["watermark"]
        known = {**result["assets"], **value["assets"]}
        referenced = [asset for track in tracks for asset in _asset_ids(track)]
        result["assets"] = {asset: known[asset] for asset in referenced if asset in known}
    else:
        result["layout"] = value
    return result


def _revision_of(current: Mapping, etag: str, changed: dict, command: str) -> dict:
    changed["revision"] = current["revision"] + 1
    changed["parent_sha256"] = etag
    # The server stamps updated_at_ms; keeping the current one makes a retry's bytes identical.
    changed["audit"] = {**current["audit"], "last_command": command}
    return changed


# --- storage ---------------------------------------------------------------------------------------


def _records(job: Path) -> Path:
    directory = job / RECORDS_DIR
    job_files.ensure_directory(directory)
    return directory


@contextmanager
def _locked(job: Path) -> Iterator[Path]:
    """The job's batch lock: one batch or undo at a time per job."""
    directory = _records(job)
    fd = os.open(directory / _LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise EditV2Error("internal_error")
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _read_record(directory: Path, batch_id: str) -> dict | None:
    try:
        raw = job_files.read_regular(directory / f"{batch_id}.json", MAX_RECORD_BYTES)
    except FileNotFoundError:
        return None
    except (OSError, job_files.JobFileError):
        raise EditV2Error("internal_error") from None
    try:
        record = json.loads(raw)
    except ValueError:
        raise EditV2Error("internal_error") from None
    if type(record) is not dict or record.get("schema") != RECORD_SCHEMA:
        raise EditV2Error("internal_error")
    return record


def _write_record(directory: Path, record: Mapping) -> None:
    stamped = {**record, "writtenNs": time.time_ns()}
    job_files.atomic_write(directory, directory / f"{record['batchId']}.json",
                           canonical_bytes(stamped))


def _prune(directory: Path, keep: int) -> None:
    """Keep the newest ``keep`` records (by their ``atMs``, then by when they were written)."""
    found = []
    for path in directory.glob("*.json"):
        try:
            record = json.loads(job_files.read_regular(path, MAX_RECORD_BYTES))
            at_ms, written = record.get("atMs", 0), record.get("writtenNs", 0)
        except (OSError, ValueError, AttributeError, job_files.JobFileError):
            at_ms, written = 0, 0
        found.append(tuple(value if type(value) is int else 0 for value in (at_ms, written))
                     + (path,))
    found.sort(key=lambda item: item[:2], reverse=True)
    for _at, _written, path in found[keep:]:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def _key(batch_id: str, clip: str, kind: str) -> str:
    return str(uuid.uuid5(_KEYS, f"{batch_id}\0{kind}\0{clip}"))


def _entry(index: int, clip: str | None, reason: str | None = None) -> dict:
    entry: dict[str, Any] = {"clipId": clip, "index": index}
    if reason is not None:
        entry["reason"] = reason
    return entry


def _save(directory: Path, doc: Mapping, *, expected: str, key: str, now_ms: int) -> str:
    _saved, etag, _warnings = store.put(directory, expected_etag=expected, idempotency_key=key,
                                        raw=canonical_bytes(doc), now_ms=now_ms)
    return etag


# --- apply -----------------------------------------------------------------------------------------


def _earlier_values(directory: Path, group: str) -> dict[str, list]:
    """Per clip, the values earlier batches of ``group`` wrote to it and no undo took back."""
    values: dict[str, list] = {}
    for path in sorted(directory.glob("*.json")):
        try:
            record = json.loads(job_files.read_regular(path, MAX_RECORD_BYTES))
        except (OSError, ValueError, job_files.JobFileError):
            continue
        if type(record) is not dict or record.get("state") != "done" or record.get("group") != group:
            continue
        try:
            restored = {entry["clipId"] for entry in record.get("undo", {}).get("restored", ())}
            for entry in record["applied"]:
                if entry["clipId"] not in restored:
                    values.setdefault(entry["clipId"], []).append(record["value"])
        except (AttributeError, KeyError, TypeError):
            continue  # a record this module did not write gives no pass
    return values


def _classify(directory: Path, group: str, value: Mapping,
              earlier: Sequence[object] = ()) -> tuple[str, dict | None]:
    """("plan", {before}) for a clip to write, ("unchanged", None), or (reason, None).

    The group counts as changed by hand when it is neither the seed's nor a value an earlier
    batch wrote to this clip (``earlier``), so a second batch updates the first one's clips."""
    try:
        seed_doc, _seed_etag = store.seed(directory)
        doc, etag, _is_seed = store.get(directory)
    except NotFound:
        return "not_ready", None
    if doc["base"]["words"]["sha256"] != seed_doc["base"]["words"]["sha256"]:
        return "read_only", None
    if not store.words_exist(directory, doc["base"]["words"]["sha256"]):
        return "not_ready", None
    before = part(doc, group)
    if part(with_part(doc, group, value), group) == before:
        return "unchanged", None
    if before != part(seed_doc, group) and before not in earlier:
        return "edited", None
    return "plan", {"etag": etag, "part": before}


def _start(job: Path, directory: Path, clips: Sequence[tuple[int, str | None]], *, source: str,
           source_etag: str, group: str, batch_id: str, now_ms: int) -> dict:
    source_dir = job / "analysis" / "clips" / source
    doc, etag, _is_seed = store.get(source_dir)
    if etag != source_etag:
        raise RevisionConflict(current=doc, etag=etag)
    value = copied_part(doc, group)
    earlier = _earlier_values(directory, group)
    planned, skipped, unchanged = [], [], []
    for index, clip in clips:
        if clip == source:
            continue
        if clip is None:
            skipped.append(_entry(index, None, "not_ready"))
            continue
        verdict, before = _classify(job / "analysis" / "clips" / clip, group, value,
                                    earlier.get(clip, ()))
        if verdict == "plan":
            planned.append({**_entry(index, clip), "before": before})
        elif verdict == "unchanged":
            unchanged.append(_entry(index, clip))
        else:
            skipped.append(_entry(index, clip, verdict))
    return {"schema": RECORD_SCHEMA, "batchId": batch_id, "group": group, "sourceClipId": source,
            "sourceEtag": source_etag, "atMs": now_ms, "state": "running", "value": value,
            "planned": planned, "skipped": skipped, "unchanged": unchanged}


def _write(job: Path, record: Mapping, target: Mapping, now_ms: int) -> tuple[str, Any]:
    """("applied", after etag) or ("skipped", reason) for one planned clip."""
    directory = job / "analysis" / "clips" / target["clipId"]
    expected = target["before"]["etag"]
    try:
        current = store.revision(directory, expected)
        if current is None:
            return "skipped", "conflict"
        changed = with_part(current, record["group"], record["value"])
        doc = _revision_of(current, expected, changed, APPLY_COMMAND)
        etag = _save(directory, doc, expected=expected, now_ms=now_ms,
                     key=_key(record["batchId"], target["clipId"], "apply"))
    except (RevisionConflict, IdempotencyConflict):
        return "skipped", "conflict"
    except (DocInvalid, DocSemanticInvalid):
        return "skipped", "invalid"
    except (NotFound, AnalysisMissing):
        return "skipped", "not_ready"
    return "applied", etag


def _result(record: Mapping) -> dict:
    return {"batchId": record["batchId"], "group": record["group"],
            "applied": [_entry(item["index"], item["clipId"]) for item in record["applied"]],
            "skipped": sorted(record["skipped"], key=lambda item: item["index"]),
            "unchanged": record["unchanged"]}


def apply(job: Path, clips: Sequence[tuple[int, str | None]], *, source: str, source_etag: str,
          group: str, batch_id: str, now_ms: int) -> dict:
    """Copy ``group`` of clip ``source`` (at ``source_etag``) to the other ``clips`` (index,
    clip id or None, in the job's order). Returns ``{batchId, group, applied, skipped,
    unchanged}``; the same ``batch_id`` with the same arguments replays it."""
    _group(group)
    with _locked(job) as directory:
        record = _read_record(directory, batch_id)
        if record is not None:
            if (record["group"], record["sourceClipId"], record["sourceEtag"]) != (
                    group, source, source_etag):
                raise IdempotencyConflict()
            if record["state"] == "done":
                return _result(record)
        else:
            record = _start(job, directory, clips, source=source, source_etag=source_etag,
                            group=group, batch_id=batch_id, now_ms=now_ms)
            _write_record(directory, record)
        applied, skipped = [], list(record["skipped"])
        for target in record["planned"]:
            outcome, detail = _write(job, record, target, now_ms)
            if outcome == "applied":
                applied.append({**_entry(target["index"], target["clipId"]), "after": detail,
                                "before": target["before"]})
            else:
                skipped.append(_entry(target["index"], target["clipId"], detail))
        record = {**record, "state": "done", "applied": applied, "skipped": skipped}
        _write_record(directory, record)
        _prune(directory, RECORDS_KEEP)
        return _result(record)


# --- undo ------------------------------------------------------------------------------------------


def _restore(job: Path, record: Mapping, entry: Mapping, now_ms: int) -> str | None:
    """None when the clip is restored, else the skip reason."""
    directory = job / "analysis" / "clips" / entry["clipId"]
    expected = entry["after"]
    try:
        current = store.revision(directory, expected)
        if current is None:
            return "changed"
        restored = with_part(current, record["group"], entry["before"]["part"])
        doc = _revision_of(current, expected, restored, UNDO_COMMAND)
        _save(directory, doc, expected=expected, now_ms=now_ms,
              key=_key(record["batchId"], entry["clipId"], "undo"))
    except (RevisionConflict, IdempotencyConflict, NotFound):
        return "changed"
    except (DocInvalid, DocSemanticInvalid, AnalysisMissing):
        return "invalid"
    return None


def undo(job: Path, *, batch_id: str, now_ms: int) -> dict:
    """Restore every clip the batch changed and nobody saved since. Returns ``{batchId, group,
    restored, skipped}``; a second call answers the same without writing."""
    with _locked(job) as directory:
        record = _read_record(directory, batch_id)
        if record is None or record["state"] != "done":
            raise NotFound()
        if "undo" in record:
            return record["undo"]
        restored, skipped = [], []
        for entry in record["applied"]:
            reason = _restore(job, record, entry, now_ms)
            if reason is None:
                restored.append(_entry(entry["index"], entry["clipId"]))
            else:
                skipped.append(_entry(entry["index"], entry["clipId"], reason))
        result = {"batchId": batch_id, "group": record["group"], "restored": restored,
                  "skipped": skipped}
        _write_record(directory, {**record, "undo": result})
        return result


__all__ = [
    "APPLY_COMMAND",
    "GROUPS",
    "RECORDS_DIR",
    "RECORDS_KEEP",
    "SKIP_REASONS",
    "UNDO_COMMAND",
    "UNDO_SKIP_REASONS",
    "apply",
    "copied_part",
    "part",
    "undo",
    "with_part",
]
