""""Hook di video" on the project page: the hook overlay of one clip on or off.

Owner: CONTRACTS §5.57. Stdlib only. Reached through ``api`` (op ``set_hook``). The switch writes
the clip's document through ``store.put`` like the editor's ``SetHookEnabled``: off drops the
hook track, on brings back the seed's hook track (its text, design, length and place), so a clip
switched off and on again equals its seed and exports as the automatic file (R10). The document
schema, the validators and the engine do not change.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping
from pathlib import Path

from . import store
from .doc import canonical_bytes
from .errors import DocSemanticInvalid, RevisionConflict

COMMAND = "SetHookEnabled"
_TRACK_ORDER = {"hook": 0, "visual": 1, "audio": 2}


def _hook_track(doc: Mapping) -> dict | None:
    for track in doc["tracks"]:
        if track.get("kind") == "hook" and track.get("items"):
            return copy.deepcopy(track)
    return None


def _read_only(doc: Mapping, seed_doc: Mapping) -> bool:
    return doc["base"]["words"]["sha256"] != seed_doc["base"]["words"]["sha256"]


def state(doc: Mapping, seed_doc: Mapping) -> dict:
    """``{on, available}``: whether ``doc`` shows a hook, and whether the switch can change it
    (the clip or its seed has a hook, and the document is not read-only)."""
    on = _hook_track(doc) is not None
    has_hook = on or _hook_track(seed_doc) is not None
    return {"on": on, "available": has_hook and not _read_only(doc, seed_doc)}


def with_hook(doc: Mapping, seed_doc: Mapping, on: bool) -> dict:
    """A copy of ``doc`` with the hook off, or on with the seed's hook when it has none."""
    result = copy.deepcopy(dict(doc))
    current = _hook_track(doc)
    if not on:
        result["tracks"] = [track for track in result["tracks"] if track.get("kind") != "hook"]
        return result
    if current is not None:
        return result
    restored = _hook_track(seed_doc)
    if restored is None:
        raise DocSemanticInvalid("range_invalid", path="/tracks")
    tracks = [track for track in result["tracks"] if track.get("kind") != "hook"]
    tracks.append(restored)
    tracks.sort(key=lambda track: _TRACK_ORDER.get(track.get("kind"), 9))
    result["tracks"] = tracks
    return result


def set_hook(clip_dir: Path, *, etag: str, on: bool, idempotency_key: str, now_ms: int) -> dict:
    """Switch the hook of the clip whose document is at ``etag``.

    ``{etag, revision, changed, hook: {on, available}}``. A switch to the state the document
    already has writes nothing (``changed`` false). ``RevisionConflict`` when ``etag`` is not the
    current revision (a retry with the same ``idempotency_key`` replays its save instead),
    ``DocSemanticInvalid`` ``op_disabled`` for a read-only clip and ``range_invalid`` for "on" on
    a clip whose seed has no hook.
    """
    seed_doc, _seed_etag = store.seed(clip_dir)
    base = store.revision(clip_dir, etag)
    if base is None:
        current, current_etag, _is_seed = store.get(clip_dir)
        raise RevisionConflict(current=current, etag=current_etag)
    if _read_only(base, seed_doc):
        raise DocSemanticInvalid("op_disabled", path="/base/words")
    changed = with_hook(base, seed_doc, on)
    if changed == base:
        current, current_etag, _is_seed = store.get(clip_dir)
        if current_etag != etag:
            raise RevisionConflict(current=current, etag=current_etag)
        return {"etag": etag, "revision": base["revision"], "changed": False,
                "hook": state(base, seed_doc)}
    changed["revision"] = base["revision"] + 1
    changed["parent_sha256"] = etag
    # The server stamps updated_at_ms; keeping the base's makes a retry's bytes identical.
    changed["audit"] = {**base["audit"], "last_command": COMMAND}
    saved, saved_etag, _warnings = store.put(clip_dir, expected_etag=etag,
                                             idempotency_key=idempotency_key,
                                             raw=canonical_bytes(changed), now_ms=now_ms)
    return {"etag": saved_etag, "revision": saved["revision"], "changed": True,
            "hook": state(saved, seed_doc)}


__all__ = ["COMMAND", "set_hook", "state", "with_hook"]
