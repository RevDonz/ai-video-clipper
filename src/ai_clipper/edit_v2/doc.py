"""clip-edit-v2 document: parse, canonical bytes, hashes and validation (plan §3, §4.4).

Owner: T1.1. The rules, the code assignment and the fixture classification are frozen in
``docs/editor/CONTRACTS.md`` (§3 and "T1.0 resolutions" §5.4/§5.5) and
``tests/fixtures/edit_v2/docs/index.json``.

Python is the only validator (plan §3): the client builds valid documents by construction and
treats a 422 as a bug.

* :func:`parse_doc` is the parse level. It raises on the **first** problem: ``too_large``, then
  ``invalid_json``, then (in document order) ``duplicate_key``/``float_not_allowed``, then
  ``SchemaTooNew`` for a newer ``schema_minor``, then ``unknown_key`` (key sets of §5.5, chosen by
  a track's ``kind`` and an asset's ``kind``), then ``control_char``/``not_nfc`` over every
  string, keys included.
* :func:`validate_doc` is the semantic level. It reports **every** issue and skips a check that
  depends on an invalid value, so one violation never cascades into another code. It expects a
  document that passed :func:`parse_doc`. Warnings (``tight_cut``, ``laughter_cut``,
  ``music_shorter_than_clip``) are computed only for a document without errors.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from bisect import bisect_right
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from json.decoder import scanstring
from typing import Any

from . import COMPILER_ID, DOC_FPS, OUTPUT_SIZES, PACK_IDS, SCHEMA, SWATCHES
from . import timemap as tm
from .clip_id import CLIP_ID_PATTERN
from .errors import DocInvalid, SchemaTooNew

MAX_DOC_BYTES = 1 << 20
MAX_SAFE_INTEGER = (1 << 53) - 1  # documents are read as JS Numbers by the editor


@dataclass(frozen=True)
class Issue:
    """One validation finding: a code of plan §3.7, a JSON pointer, and optional id/frame.

    ``ref`` names the item the issue is about (e.g. a removal id) and ``f`` an output frame to
    jump to; both are used by warnings ("Perlu dicek").
    """

    code: str
    path: str
    ref: str | None = None
    f: int | None = None

    def to_json(self) -> dict[str, Any]:
        """The wire form used in 422 bodies and ``warnings`` lists (``None`` fields omitted)."""
        value: dict[str, Any] = {"code": self.code, "path": self.path}
        if self.ref is not None:
            value["ref"] = self.ref
        if self.f is not None:
            value["f"] = self.f
        return value


@dataclass(frozen=True)
class Validation:
    errors: tuple[Issue, ...]
    warnings: tuple[Issue, ...]

    @property
    def ok(self) -> bool:
        return not self.errors


# --- JSON pointers --------------------------------------------------------------------------------


def _escape(token: object) -> str:
    return str(token).replace("~", "~0").replace("/", "~1")


def _pointer(tokens: list) -> str:
    return "".join("/" + _escape(token) for token in tokens)


def _join(path: str, *tokens: object) -> str:
    return path + "".join("/" + _escape(token) for token in tokens)


# --- canonical bytes and hashes ---------------------------------------------------------------------


def _mapping_default(value: object) -> object:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, tuple):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def canonical_bytes(doc: Mapping) -> bytes:
    """``json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`` as UTF-8."""
    return json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False, default=_mapping_default).encode("utf-8")


def doc_sha256(doc: Mapping) -> str:
    """sha256 hex of ``canonical_bytes(doc)``: the document's ETag."""
    return hashlib.sha256(canonical_bytes(doc)).hexdigest()


_NOT_CONTENT = frozenset({"revision", "parent_sha256", "audit"})


def content_sha256(doc: Mapping) -> str:
    """sha256 hex of the canonical bytes without ``revision``, ``parent_sha256`` and ``audit``."""
    content = {key: value for key, value in doc.items() if key not in _NOT_CONTENT}
    return hashlib.sha256(canonical_bytes(content)).hexdigest()


def content_equals_seed(doc: Mapping, seed: Mapping) -> bool:
    """R10: the document's content equals the seed's content (plan §4.6)."""
    return content_sha256(doc) == content_sha256(seed)


# --- parse level ----------------------------------------------------------------------------------

_WS = re.compile(r"[ \t\n\r]*")
_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?")
_CONTROL = re.compile("[\x00-\x1f\x7f-\x9f\ud800-\udfff]")  # Cc and Cs


def _invalid(code: str, path: str) -> DocInvalid:
    return DocInvalid(code, path=path, issues=(Issue(code, path),))


def _first_json_problem(text: str) -> tuple[str, str] | None:
    """(code, pointer) of the first duplicate key or non-integer number in document order.

    Only called for text that ``json.loads`` accepted, so the grammar is known to be valid
    (``NaN``, ``Infinity`` and ``-Infinity`` included). Iterative: the nesting depth is bounded
    only by what the C decoder accepted.
    """
    stack: list[list] = []  # ["o", seen keys] or ["a", index]
    tokens: list = []
    pos = _WS.match(text, 0).end()
    while True:
        char = text[pos]
        if char == "{":
            pos = _WS.match(text, pos + 1).end()
            if text[pos] == "}":
                pos += 1
            else:
                key, pos = scanstring(text, pos + 1)
                stack.append(["o", {key}])
                tokens.append(key)
                pos = _WS.match(text, _WS.match(text, pos).end() + 1).end()
                continue
        elif char == "[":
            pos = _WS.match(text, pos + 1).end()
            if text[pos] == "]":
                pos += 1
            else:
                stack.append(["a", 0])
                tokens.append(0)
                continue
        elif char == '"':
            _value, pos = scanstring(text, pos + 1)
        elif text.startswith(("NaN", "Infinity", "-Infinity"), pos):
            return "float_not_allowed", _pointer(tokens)
        elif char in "-0123456789":
            match = _NUMBER.match(text, pos)
            if match.group(1) is not None or match.group(2) is not None:
                return "float_not_allowed", _pointer(tokens)
            pos = match.end()
        else:  # true, false, null
            pos += 4 if text.startswith(("true", "null"), pos) else 5
        # The value is complete: continue the enclosing containers.
        while True:
            pos = _WS.match(text, pos).end()
            if not stack:
                return None
            frame = stack[-1]
            if text[pos] == ",":
                pos = _WS.match(text, pos + 1).end()
                if frame[0] == "o":
                    key, pos = scanstring(text, pos + 1)
                    tokens[-1] = key
                    if key in frame[1]:
                        return "duplicate_key", _pointer(tokens)
                    frame[1].add(key)
                    pos = _WS.match(text, _WS.match(text, pos).end() + 1).end()
                else:
                    frame[1] += 1
                    tokens[-1] = frame[1]
                break
            pos += 1  # "}" or "]"
            stack.pop()
            tokens.pop()


def _decode(raw: bytes) -> tuple[dict, str]:
    if not isinstance(raw, (bytes, bytearray, memoryview)):
        raise _invalid("invalid_json", "")
    if len(raw) > MAX_DOC_BYTES:
        raise _invalid("too_large", "")
    try:
        text = bytes(raw).decode("utf-8")
    except UnicodeDecodeError:
        raise _invalid("invalid_json", "") from None
    problem = False

    def pairs(items: list[tuple[str, Any]]) -> dict:
        nonlocal problem
        result = dict(items)
        if len(result) != len(items):
            problem = True
        return result

    def reject(_value: str) -> int:
        nonlocal problem
        problem = True
        return 0

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_float=reject,
                           parse_constant=reject)
    except (ValueError, RecursionError):  # JSONDecodeError, int digit limit, nesting depth
        raise _invalid("invalid_json", "") from None
    if type(value) is not dict:
        raise _invalid("invalid_json", "")
    if problem:
        found = _first_json_problem(text)
        code, path = found if found is not None else ("invalid_json", "")
        raise _invalid(code, path)
    return value, text


def _merge(*specs: Any) -> Any:
    """Union of key-set specs (``None`` is a leaf; dicts merge recursively)."""
    merged: dict[str, Any] = {}
    for spec in specs:
        for key, sub in spec.items():
            if key in merged and isinstance(merged[key], dict) and isinstance(sub, dict):
                merged[key] = _merge(merged[key], sub)
            elif key not in merged or sub is not None:
                merged[key] = sub
    return merged


def _keys(*names: str, **nested: Any) -> dict[str, Any]:
    return {**dict.fromkeys(names), **nested}


class _List:
    """A JSON array whose elements follow ``spec``."""

    __slots__ = ("spec",)

    def __init__(self, spec: Any) -> None:
        self.spec = spec


class _Map:
    """A JSON object with free keys (word ids, asset ids) whose values follow ``spec``."""

    __slots__ = ("spec",)

    def __init__(self, spec: Any) -> None:
        self.spec = spec


class _Kind:
    """An object whose key set is chosen by its ``kind`` (tracks, assets; §5.4 step 5)."""

    __slots__ = ("default", "table")

    def __init__(self, table: Mapping[str, Any], default: Any) -> None:
        self.table = dict(table)
        self.default = default

    def choose(self, value: object) -> Any:
        kind = value.get("kind") if isinstance(value, dict) else None
        return self.table.get(kind, self.default) if isinstance(kind, str) else self.default


class _Obj:
    """A compiled key set: the allowed keys and the specs of the keys that have children."""

    __slots__ = ("allowed", "children")

    def __init__(self, spec: Mapping[str, Any]) -> None:
        self.allowed = frozenset(spec)
        self.children = {key: _compile(sub) for key, sub in spec.items() if sub is not None}


def _leaf_allowed(spec: Any) -> frozenset[str] | None:
    """The key set of an object spec without nested specs (removals, word edits), else None."""
    return spec.allowed if type(spec) is _Obj and not spec.children else None


def _compile(spec: Any) -> Any:
    if isinstance(spec, dict):
        return _Obj(spec)
    if isinstance(spec, _List):
        return _List(_compile(spec.spec))
    if isinstance(spec, _Map):
        return _Map(_compile(spec.spec))
    if isinstance(spec, _Kind):
        return _Kind({kind: _compile(sub) for kind, sub in spec.table.items()},
                     _compile(spec.default))
    return spec


_ANCHOR = _keys("at", "f", "word", "edge", "offset_f", "seg")
_ITEMS = {
    "hook": _keys("id", "type", "dur_f", "origin", start=_ANCHOR,
                  transform=_keys("x_e5", "y_e5"),
                  payload=_keys("text", design=_keys("id", "v"))),
    "visual": _keys("id", "type", "origin", start=_ANCHOR, end=_ANCHOR,
                    transform=_keys("x_e5", "y_e5", "w_e5", "opacity_pm"),
                    payload=_keys("asset", "mode")),
    "audio": _keys("id", "type", "origin", start=_ANCHOR, end=_ANCHOR,
                   payload=_keys("asset", "src_in_smp", "loop", "gain_cdb", "fade_in_f",
                                 "fade_out_f",
                                 duck=_keys("on", "depth_cdb", "attack_ms", "release_ms",
                                            "hold_ms", "detector"))),
}
_TRACKS = {
    "hook": _keys("id", "kind", items=_List(_ITEMS["hook"])),
    "visual": _keys("id", "kind", "band", "role", items=_List(_ITEMS["visual"])),
    "audio": _keys("id", "kind", "role", items=_List(_ITEMS["audio"])),
}
_TRACK_ANY = _keys("id", "kind", "band", "role", items=_List(_merge(*_ITEMS.values())))
_ASSETS = {
    "image": _keys("kind", "mime", "w", "h"),
    "audio": _keys("kind", "mime", "duration_ms", "lufs_c"),
}
_ASSET_ANY = _merge(*_ASSETS.values())


_ROOT = _compile(_keys(
    "schema", "schema_minor", "clip_id", "revision", "parent_sha256",
    base=_keys("job_id", "window_ms", "seed_sha256",
               source=_keys("content_sha256", "w", "h", "fps_native", "vfr", "duration_ms",
                            "has_audio"),
               origin=_keys("kind", "selection_artifact_sha256", "selection_version",
                            "rank_at_seed", "hook_unit_id", "selection_source"),
               words=_keys("sha256", "count"),
               camera=_keys("sha256"),
               engine=_keys("compiler", "render_semantics")),
    output=_keys("w", "h", "fps", "sample_rate", "channels"),
    main=_keys("cut_fade_ms",
               segments=_List(_keys("id", "role", "in_sf", "out_sf")),
               removals=_List(_keys("id", "seg", "in_sf", "out_sf", "words", "reason",
                                    "origin")),
               joins=_List(_keys("after", "style", "audio_fade_ms"))),
    captions=_keys("enabled", pack=_keys("id", "v"),
                   overrides=_keys("y_e5", "size_pm", "case", "highlight", "emphasis"),
                   word_edits=_Map(_keys("text", "hidden", "emphasis"))),
    layout=_keys(default=_keys("mode", "no_face")),
    tracks=_List(_Kind(_TRACKS, _TRACK_ANY)),
    audio=_keys(source=_keys("gain_cdb"), master=_keys("mode", "target_clufs", "tp_cdb")),
    assets=_Map(_Kind(_ASSETS, _ASSET_ANY)),
    audit=_keys("created_at_ms", "updated_at_ms", "editor", "last_command"),
))


def _has_unknown_key(value: object, spec: Any) -> bool:
    """Fast test: does any object hold a key outside its key set (any order)?"""
    if type(spec) is _Kind:
        spec = spec.choose(value)
    if type(spec) is _Obj:
        if not isinstance(value, dict):
            return False
        if not spec.allowed.issuperset(value):
            return True
        return any(key in value and _has_unknown_key(value[key], child)
                   for key, child in spec.children.items())
    if type(spec) is _List or type(spec) is _Map:
        if type(spec) is _List:
            if not isinstance(value, list):
                return False
            items = value
        elif isinstance(value, dict):
            items = value.values()
        else:
            return False
        allowed = _leaf_allowed(spec.spec)
        if allowed is not None:  # the long lists: one set test per element
            return not all(type(item) is not dict or allowed.issuperset(item) for item in items)
        return any(_has_unknown_key(item, spec.spec) for item in items)
    return False


def _unknown_key(value: object, spec: Any) -> list | None:
    """Reversed path tokens of the first key (document order) outside the §5.5 key sets."""
    if type(spec) is _Kind:
        spec = spec.choose(value)
    if type(spec) is _Obj:
        if isinstance(value, dict):
            for key, item in value.items():
                if key not in spec.allowed:
                    return [key]
                child = spec.children.get(key)
                found = None if child is None else _unknown_key(item, child)
                if found is not None:
                    found.append(key)
                    return found
    elif type(spec) is _List:
        if isinstance(value, list):
            for index, item in enumerate(value):
                found = _unknown_key(item, spec.spec)
                if found is not None:
                    found.append(index)
                    return found
    elif type(spec) is _Map and isinstance(value, dict):
        for key, item in value.items():
            found = _unknown_key(item, spec.spec)
            if found is not None:
                found.append(key)
                return found
    return None


# In the JSON text, a Cc or Cs character of a decoded string comes from a raw DEL/C1 character
# (raw U+0000-U+001F is invalid JSON) or from an escape, and a \u escape can also hide a
# non-NFC sequence. Text without these that is NFC as a whole has only clean strings: every
# string is delimited by '"', which never composes or reorders with its neighbours.
_ESCAPE = re.compile(r"\\[bfnrtu]")
_RAW_CONTROL = re.compile("[\x7f-\x9f]")


def _text_clean(text: str) -> bool:
    """Fast proof that no decoded string (keys included) has a Cc/Cs character or is not NFC."""
    if "\\" in text and _ESCAPE.search(text) is not None:
        return False
    if text.isascii():
        return "\x7f" not in text
    return _RAW_CONTROL.search(text) is None and unicodedata.is_normalized("NFC", text)


def _string_problem(text: str) -> str | None:
    if _CONTROL.search(text) is not None:
        return "control_char"
    if not unicodedata.is_normalized("NFC", text):
        return "not_nfc"
    return None


def _text_problem(value: object) -> tuple[str, str] | None:
    """The first string (document order, keys included) with a Cc/Cs character or not NFC."""
    stack: list[tuple[object, list]] = [(value, [])]
    while stack:
        node, path = stack.pop()
        if isinstance(node, str):
            code = _string_problem(node)
            if code is not None:
                return code, _pointer(path)
        elif isinstance(node, dict):
            entries: list[tuple[object, list]] = []
            for key, item in node.items():
                entries.append((key, [*path, key]))  # a key comes before its value
                entries.append((item, [*path, key]))
            stack.extend(reversed(entries))
        elif isinstance(node, list):
            stack.extend(reversed([(item, [*path, index])
                                   for index, item in enumerate(node)]))
    return None


def parse_doc(raw: bytes) -> dict:
    """Parse document bytes; raises ``DocInvalid`` (parse codes) or ``SchemaTooNew``.

    Plan §3.1/§3.7: UTF-8 without BOM, ≤ ``MAX_DOC_BYTES``, no floats/NaN/Infinity, no duplicate
    or unknown keys at any level, every string NFC without Cc/Cs characters. The order of the
    checks and the pointers are those of docs/editor/CONTRACTS.md §5.4.
    """
    doc, text = _decode(raw)
    minor = doc.get("schema_minor")
    if type(minor) is int and minor > 0:
        raise SchemaTooNew(path="/schema_minor", issues=(Issue("schema_too_new",
                                                               "/schema_minor"),))
    if _has_unknown_key(doc, _ROOT):
        unknown = _unknown_key(doc, _ROOT)
        raise _invalid("unknown_key", _pointer(unknown[::-1] if unknown else []))
    if not _text_clean(text):
        problem = _text_problem(doc)
        if problem is not None:
            raise _invalid(*problem)
    return doc


# --- semantic level --------------------------------------------------------------------------------

_ID = re.compile(r"[a-z]{2,3}_[0-9a-z]{1,16}")
_WORD_ID = re.compile(r"w[0-9]{6,7}")
_SHA = re.compile(r"[0-9a-f]{64}")
_ASSET_ID = re.compile(r"sha256:[0-9a-f]{64}")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_LAST_COMMAND = re.compile(r"[A-Za-z]{1,40}")
_ITEM_ORIGIN = re.compile(r"(?:seed|user|suggestion:[a-z]{2,3}_[0-9a-z]{1,16})")
_REMOVAL_ORIGIN = re.compile(r"(?:user|suggestion:[a-z]{2,3}_[0-9a-z]{1,16})")

# (valid in Essentials, defined by a later stage → op_disabled); anything else is range_invalid.
_SEGMENT_ROLES = ({"cold_open", "body"}, {"insert"})
_REMOVAL_REASONS = ({"user", "filler", "repeat", "gap_silent"},
                    {"gap_voiced", "ai_condense", "timeline"})
_JOIN_STYLES = ({"cut"}, {"flash_white", "dip_black", "xfade"})
_CASES = ({"asis", "upper"}, {"lower", "sentence"})
_LAYOUT_MODES = ({"fit_blur", "camera", "fill_center"},
                 {"smart_speaker", "fit_black", "split", "branded"})
_NO_FACE = ({"center"}, {"fail", "fit_blur"})
_DETECTORS = ({"words"}, {"rms"})
_LOGO_MODES = ({"free"}, {"pip", "cutaway", "split_top", "split_bottom"})
_BANDS = ({"over_text"}, {"under_text"})
_VISUAL_ROLES = ({"overlay"}, {"broll"})
_AUDIO_ROLES = ({"music"}, {"sfx", "voice"})
_STAGE2_TYPES = frozenset({"text", "credit", "label", "sticker", "emoji", "video", "effect"})
_ITEM_TYPE = {"hook": "hook", "visual": "image", "audio": "audio"}
_ATOMIC_KEYS = frozenset({"fps", "fps_native"})  # rationals are compared as one value
_REMOVAL_KEYS = frozenset({"id", "seg", "in_sf", "out_sf", "words", "reason", "origin"})
_WORD_EDIT_KEYS = frozenset({"text", "hidden", "emphasis"})
# Removals and word edits (the parts of a document that grow with editing) are first tried on a
# fast path that accepts only entries the generic checks accept without an issue; anything else
# takes the generic path, which reports. Tests run both paths and compare (``_FAST = False``).
_FAST = True

_MISSING = object()


def _same(a: object, b: object) -> bool:
    """JSON equality that keeps types apart (``True`` is not ``1``)."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_same(a[key], b[key]) for key in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b, strict=True))
    return a == b


def _fps(value: object) -> tm.Fps | None:
    if (isinstance(value, list) and len(value) == 2 and all(type(v) is int for v in value)
            and tuple(value) in DOC_FPS):
        return tm.Fps(value[0], value[1])
    return None


class _Validator:
    """One validation run; ``errors`` collects every blocking issue (deduplicated)."""

    def __init__(self, doc: Mapping, words: Mapping, assets: Mapping[str, Mapping],
                 seed: Mapping | None) -> None:
        self.doc = doc
        self.words = words
        self.store = assets
        self.seed = seed
        self.errors: list[Issue] = []
        self._seen: set[tuple[str, str]] = set()
        self.ids: set[str] = set()
        self.word_ids: frozenset[str] | None = None
        # Effective values for dependent checks (the seed's when given: no cascades from a
        # changed base or output, which is reported as base_changed).
        self.fps: tm.Fps | None = None
        self.out_size: tuple[int, int] | None = None
        self.window_ms: tuple[int, int] | None = None
        self.duration_ms: int | None = None
        self.referenced: set[str] = set()
        self.segments: list[dict | None] = []  # valid-geometry segments by index
        self.segment_index: dict[str, int] = {}  # first segment with each (string) id
        self.pieces: tuple[tm.Piece, ...] = ()  # of the valid segments and removals
        self.piece_segment: dict[str, str] = {}  # piece.seg (synthetic) -> segment id
        self.segment_ok: dict[str, bool] = {}  # segment id -> its removals are all valid
        self.cuts: list[tuple[int, int, int]] = []  # (segment index, in_sf, out_sf), valid
        self.removals_ok = True
        self.co_index: int | None = None
        self.body_index: int | None = None
        self.music: tuple[str, str, Mapping, dict] | None = None  # path, id, meta, payload

    # --- reporting and primitive checks ---

    def error(self, code: str, path: str) -> None:
        if (code, path) not in self._seen:
            self._seen.add((code, path))
            self.errors.append(Issue(code, path))

    def obj(self, value: object, path: str) -> dict | None:
        if isinstance(value, dict):
            return value
        self.error("range_invalid", path)
        return None

    def field(self, parent: Mapping, key: str, path: str) -> Any:
        if key not in parent:
            self.error("range_invalid", _join(path, key))
            return _MISSING
        return parent[key]

    def integer(self, parent: Mapping, key: str, path: str, low: int = 0,
                high: int = MAX_SAFE_INTEGER) -> int | None:
        value = self.field(parent, key, path)
        if value is _MISSING:
            return None
        if type(value) is not int or not low <= value <= high:
            self.error("range_invalid", _join(path, key))
            return None
        return value

    def boolean(self, parent: Mapping, key: str, path: str) -> bool | None:
        value = self.field(parent, key, path)
        if value is _MISSING:
            return None
        if type(value) is not bool:
            self.error("range_invalid", _join(path, key))
            return None
        return value

    def string(self, parent: Mapping, key: str, path: str, *,
               pattern: re.Pattern[str] | None = None, choices: object = None,
               length: tuple[int, int] | None = None, nullable: bool = False) -> str | None:
        value = self.field(parent, key, path)
        if value is _MISSING or (nullable and value is None):
            return None
        ok = isinstance(value, str)
        if ok and pattern is not None:
            ok = pattern.fullmatch(value) is not None
        if ok and choices is not None:
            ok = value in choices
        if ok and length is not None:
            ok = length[0] <= len(value) <= length[1]
        if not ok:
            self.error("range_invalid", _join(path, key))
            return None
        return value

    def enum(self, parent: Mapping, key: str, path: str,
             values: tuple[set[str], set[str]]) -> str | None:
        """Essentials value → itself; a later stage's value → op_disabled; else range_invalid."""
        value = self.field(parent, key, path)
        if value is _MISSING:
            return None
        if isinstance(value, str) and value in values[0]:
            return value
        self.error("op_disabled" if isinstance(value, str) and value in values[1]
                   else "range_invalid", _join(path, key))
        return None

    def text(self, parent: Mapping, key: str, path: str, maximum: int) -> str | None:
        """1..maximum code points without leading or trailing whitespace (NFC is parse level)."""
        value = self.string(parent, key, path, length=(1, maximum))
        if value is not None and value.strip() != value:
            self.error("range_invalid", _join(path, key))
            return None
        return value

    def identifier(self, parent: Mapping, path: str) -> str | None:
        value = self.string(parent, "id", path, pattern=_ID)
        if value is not None:
            if value in self.ids:
                self.error("range_invalid", _join(path, "id"))
            self.ids.add(value)
        return value

    def known_words(self) -> frozenset[str]:
        """Ids of the words artifact that are well-formed word ids."""
        if self.word_ids is None:
            entries = self.words.get("words", ()) if isinstance(self.words, Mapping) else ()
            self.word_ids = frozenset(
                entry["id"] for entry in entries
                if isinstance(entry, Mapping) and isinstance(entry.get("id"), str)
                and _WORD_ID.fullmatch(entry["id"]) is not None)
        return self.word_ids

    def word(self, value: object, path: str, *tokens: object) -> None:
        """A word id that must exist in the words artifact (the path is built on error)."""
        if not isinstance(value, str) or _WORD_ID.fullmatch(value) is None:
            self.error("range_invalid", _join(path, *tokens))
        elif value not in self.known_words():
            self.error("unknown_word", _join(path, *tokens))

    # --- sections ---

    def run(self) -> Validation:
        doc = self.doc
        if not isinstance(doc, Mapping):
            return Validation((Issue("range_invalid", ""),), ())
        self.root(doc)
        self.base(doc)
        self.output(doc)
        main = doc.get("main", _MISSING)
        if main is _MISSING:
            self.error("range_invalid", "/main")
        elif self.obj(main, "/main") is not None:
            self.main(main)
        for key, method in (("captions", self.captions), ("layout", self.layout),
                            ("audio", self.audio), ("audit", self.audit)):
            value = doc.get(key, _MISSING)
            if value is _MISSING:
                self.error("range_invalid", f"/{key}")
            elif self.obj(value, f"/{key}") is not None:
                method(value)
        tracks = self.field(doc, "tracks", "")
        if tracks is not _MISSING:
            if isinstance(tracks, list):
                self.tracks(tracks)
            else:
                self.error("range_invalid", "/tracks")
        assets = self.field(doc, "assets", "")
        if assets is not _MISSING and self.obj(assets, "/assets") is not None:
            self.assets(assets)
        if self.seed is not None:
            self.base_changed(doc, self.seed)
        errors = tuple(self.errors)
        warnings = () if errors else self.warnings(doc)
        return Validation(errors, warnings)

    def root(self, doc: Mapping) -> None:
        self.string(doc, "schema", "", choices={SCHEMA})
        self.integer(doc, "schema_minor", "", 0, 0)
        self.string(doc, "clip_id", "", pattern=CLIP_ID_PATTERN)
        revision = self.integer(doc, "revision", "")
        parent = self.field(doc, "parent_sha256", "")
        if parent is _MISSING:
            return
        if parent is not None and (not isinstance(parent, str) or _SHA.fullmatch(parent) is None):
            self.error("range_invalid", "/parent_sha256")
        elif revision is not None and (revision == 0) != (parent is None):
            self.error("parent_mismatch", "/parent_sha256")

    def base(self, doc: Mapping) -> None:
        base = self.field(doc, "base", "")
        if base is _MISSING or self.obj(base, "/base") is None:
            return
        path = "/base"
        self.string(base, "job_id", path, pattern=_UUID)
        duration = None
        source = self.field(base, "source", path)
        if source is not _MISSING and self.obj(source, "/base/source") is not None:
            sp = "/base/source"
            self.string(source, "content_sha256", sp, pattern=_SHA)
            self.integer(source, "w", sp, 16, 8192)
            self.integer(source, "h", sp, 16, 8192)
            native = self.field(source, "fps_native", sp)
            if native is not _MISSING and not (
                    isinstance(native, list) and len(native) == 2
                    and all(type(v) is int and 0 < v <= MAX_SAFE_INTEGER for v in native)):
                self.error("range_invalid", "/base/source/fps_native")
            self.boolean(source, "vfr", sp)
            duration = self.integer(source, "duration_ms", sp, 1)
            self.boolean(source, "has_audio", sp)
        origin = self.field(base, "origin", path)
        if origin is not _MISSING and self.obj(origin, "/base/origin") is not None:
            op = "/base/origin"
            self.string(origin, "kind", op, choices={"v3_clip"})
            self.string(origin, "selection_artifact_sha256", op, pattern=_SHA)
            self.string(origin, "selection_version", op, length=(1, 40))
            self.integer(origin, "rank_at_seed", op, 1)
            self.string(origin, "hook_unit_id", op, length=(1, 16), nullable=True)
            self.string(origin, "selection_source", op, choices={"llm", "heuristic"})
        window = self.field(base, "window_ms", path)
        window_ok = None
        if window is not _MISSING:
            if (isinstance(window, list) and len(window) == 2
                    and all(type(v) is int for v in window)
                    and 0 <= window[0] < window[1] <= MAX_SAFE_INTEGER
                    and (duration is None or window[1] <= duration)):
                window_ok = (window[0], window[1])
            else:
                self.error("range_invalid", "/base/window_ms")
        words = self.field(base, "words", path)
        if words is not _MISSING and self.obj(words, "/base/words") is not None:
            self.string(words, "sha256", "/base/words", pattern=_SHA)
            self.integer(words, "count", "/base/words")
        camera = self.field(base, "camera", path)
        if camera is not _MISSING and self.obj(camera, "/base/camera") is not None:
            self.string(camera, "sha256", "/base/camera", pattern=_SHA, nullable=True)
        self.string(base, "seed_sha256", path, pattern=_SHA)
        engine = self.field(base, "engine", path)
        if engine is not _MISSING and self.obj(engine, "/base/engine") is not None:
            self.string(engine, "compiler", "/base/engine", choices={COMPILER_ID, "legacy"})
            self.integer(engine, "render_semantics", "/base/engine", 1)
        self.window_ms, self.duration_ms = window_ok, duration
        if self.seed is not None:
            self._seed_base()

    def _seed_base(self) -> None:
        try:
            base = self.seed["base"]
            window = base["window_ms"]
            self.window_ms = (int(window[0]), int(window[1]))
            self.duration_ms = int(base["source"]["duration_ms"])
        except (KeyError, TypeError, IndexError, ValueError):
            self.window_ms = self.duration_ms = None

    def output(self, doc: Mapping) -> None:
        output = self.field(doc, "output", "")
        size = fps = None
        if output is not _MISSING and self.obj(output, "/output") is not None:
            width = self.integer(output, "w", "/output")
            height = self.integer(output, "h", "/output")
            if width is not None and width not in {w for w, _h in OUTPUT_SIZES}:
                self.error("range_invalid", "/output/w")
            elif width is not None and height is not None:
                if (width, height) in OUTPUT_SIZES:
                    size = (width, height)
                else:
                    self.error("range_invalid", "/output/h")
            value = self.field(output, "fps", "/output")
            if value is not _MISSING:
                fps = _fps(value)
                if fps is None:
                    self.error("range_invalid", "/output/fps")
            self.integer(output, "sample_rate", "/output", 48_000, 48_000)
            self.integer(output, "channels", "/output", 2, 2)
        self.out_size, self.fps = size, fps
        if self.seed is not None:
            seed_output = self.seed.get("output")
            if isinstance(seed_output, Mapping):
                self.fps = _fps(seed_output.get("fps"))
                pair = (seed_output.get("w"), seed_output.get("h"))
                self.out_size = pair if pair in OUTPUT_SIZES else None

    def main(self, main: Mapping) -> None:
        segments = self.field(main, "segments", "/main")
        if segments is not _MISSING:
            if isinstance(segments, list):
                self.segments_rule(segments)
            else:
                self.error("range_invalid", "/main/segments")
        removals = self.field(main, "removals", "/main")
        if removals is not _MISSING:
            if isinstance(removals, list):
                self.removals_rule(removals)
            else:
                self.error("range_invalid", "/main/removals")
                self.removals_ok = False
        else:
            self.removals_ok = False
        joins = self.field(main, "joins", "/main")
        if joins is not _MISSING:
            if isinstance(joins, list):
                self.joins_rule(joins)
            else:
                self.error("range_invalid", "/main/joins")
        self.integer(main, "cut_fade_ms", "/main", 0, 50)
        if isinstance(segments, list):
            self.segment_frames_rule()

    def segments_rule(self, segments: list) -> None:
        if not segments:
            self.error("range_invalid", "/main/segments")
            return
        bodies: list[int] = []
        cold_opens: list[int] = []
        for index, segment in enumerate(segments):
            path = f"/main/segments/{index}"
            self.segments.append(None)
            if index >= 2:
                self.error("op_disabled", path)
            if self.obj(segment, path) is None:
                continue
            seg_id = self.identifier(segment, path)
            raw_id = segment.get("id")
            if isinstance(raw_id, str):
                self.segment_index.setdefault(raw_id, index)
            role = self.enum(segment, "role", path, _SEGMENT_ROLES)
            in_sf = self.integer(segment, "in_sf", path)
            out_sf = self.integer(segment, "out_sf", path)
            if role == "body":
                if bodies:
                    self.error("range_invalid", path)
                bodies.append(index)
            elif role == "cold_open":
                if cold_opens or index != 0:
                    self.error("cold_open_invalid", path)
                cold_opens.append(index)
            if in_sf is None or out_sf is None:
                continue
            if in_sf >= out_sf:
                self.error("range_invalid", path)
                continue
            if role is None:
                continue  # op_disabled or invalid role: no further checks on it
            self.segments[index] = segment
            if seg_id is not None:
                self.segment_ok.setdefault(seg_id, True)
            if self.window_ms is not None and self.fps is not None:
                low = tm.sf_floor(self.window_ms[0], self.fps)
                high = tm.sf_ceil(self.window_ms[1], self.fps)
                if in_sf < low:
                    self.error("outside_window", _join(path, "in_sf"))
                if out_sf > high:
                    self.error("outside_window", _join(path, "out_sf"))
        if not bodies:
            self.error("range_invalid", "/main/segments")
        self.body_index = bodies[0] if len(bodies) == 1 else None
        self.co_index = cold_opens[0] if len(cold_opens) == 1 else None

    def _segment_by_id(self, seg_id: str) -> tuple[int, dict | None] | None:
        index = self.segment_index.get(seg_id)
        return None if index is None else (index, self.segments[index])

    def fast_removal(self, removal: object) -> tuple[str, int, int] | None:
        """(seg, in_sf, out_sf) of a removal whose every field is valid, else None."""
        if not _FAST or type(removal) is not dict or removal.keys() != _REMOVAL_KEYS:
            return None
        removal_id, seg = removal["id"], removal["seg"]
        in_sf, out_sf, words = removal["in_sf"], removal["out_sf"], removal["words"]
        reason, origin = removal["reason"], removal["origin"]
        if not (type(removal_id) is str and type(seg) is str and type(in_sf) is int
                and type(out_sf) is int and 0 <= in_sf < out_sf <= MAX_SAFE_INTEGER
                and type(words) is list and len(words) <= 400
                and type(reason) is str and reason in _REMOVAL_REASONS[0]
                and type(origin) is str and _REMOVAL_ORIGIN.fullmatch(origin) is not None
                and _ID.fullmatch(removal_id) is not None and removal_id not in self.ids):
            return None
        known = self.known_words()
        for word in words:
            if type(word) is not str or word not in known:
                return None
        self.ids.add(removal_id)
        return seg, in_sf, out_sf

    def removals_rule(self, removals: list) -> None:
        if len(removals) > 2000:
            self.error("range_invalid", "/main/removals")
            self.removals_ok = False
            return
        previous_out: dict[str, int] = {}
        for index, removal in enumerate(removals):
            path = f"/main/removals/{index}"
            fast = self.fast_removal(removal)
            if fast is not None:
                seg, in_sf, out_sf = fast
                geometry = True
            else:
                if self.obj(removal, path) is None:
                    self.removals_ok = False
                    continue
                self.identifier(removal, path)
                seg = self.string(removal, "seg", path)
                in_sf = self.integer(removal, "in_sf", path)
                out_sf = self.integer(removal, "out_sf", path)
                words = self.field(removal, "words", path)
                if words is not _MISSING:
                    if not isinstance(words, list) or len(words) > 400:
                        self.error("range_invalid", _join(path, "words"))
                    else:
                        for position, word in enumerate(words):
                            self.word(word, path, "words", position)
                self.enum(removal, "reason", path, _REMOVAL_REASONS)
                self.string(removal, "origin", path, pattern=_REMOVAL_ORIGIN)
                geometry = in_sf is not None and out_sf is not None
                if geometry and in_sf >= out_sf:
                    self.error("range_invalid", path)
                    geometry = False
            if seg is None:
                self.removals_ok = False
                continue
            found = self._segment_by_id(seg)
            if found is None:
                self.error("removal_outside_segment", _join(path, "seg"))
                continue
            segment_index, segment = found
            if not geometry:
                self.segment_ok[seg] = False
                continue
            if segment is None:
                continue  # the segment itself is invalid (already reported)
            if not (segment["in_sf"] <= in_sf and out_sf <= segment["out_sf"]):
                self.error("removal_outside_segment", path)
                self.segment_ok[seg] = False
                continue
            if in_sf < previous_out.get(seg, in_sf):
                self.error("removal_overlap", path)
            previous_out[seg] = out_sf
            self.cuts.append((segment_index, in_sf, out_sf))

    def joins_rule(self, joins: list) -> None:
        for index, join in enumerate(joins):
            path = f"/main/joins/{index}"
            if self.obj(join, path) is None:
                continue
            self.string(join, "after", path, pattern=_ID)
            self.enum(join, "style", path, _JOIN_STYLES)
            self.integer(join, "audio_fade_ms", path, 0, 250)
        segments = self.doc["main"].get("segments")
        if not isinstance(segments, list) or not segments:
            return  # no segment list to check the joins against (reported on /main/segments)
        cold = next((s for s in segments if isinstance(s, dict)
                     and s.get("role") == "cold_open"), None)
        if cold is None:
            for index in range(len(joins)):
                self.error("cold_open_invalid", f"/main/joins/{index}")
            return
        if not joins:
            self.error("cold_open_invalid", "/main/joins")
            return
        for index in range(1, len(joins)):
            self.error("cold_open_invalid", f"/main/joins/{index}")
        first = joins[0]
        if isinstance(first, dict) and isinstance(first.get("after"), str) \
                and isinstance(cold.get("id"), str) and first["after"] != cold["id"]:
            self.error("cold_open_invalid", "/main/joins/0/after")

    def segment_frames_rule(self) -> None:
        """Body duration and cold-open rules, computed from the valid segments and removals."""
        fps = self.fps
        if fps is None or not self.removals_ok:
            return
        valid = [(index, segment) for index, segment in enumerate(self.segments)
                 if segment is not None]
        synthetic = {index: f"s{index}" for index, _segment in valid}
        removals = [{"seg": synthetic[index], "in_sf": in_sf, "out_sf": out_sf}
                    for index, in_sf, out_sf in self.cuts]
        frames: dict[str, int] = {}
        self.pieces = tm.pieces({"main": {
            "segments": [{"id": synthetic[index], "role": segment["role"],
                          "in_sf": segment["in_sf"], "out_sf": segment["out_sf"]}
                         for index, segment in valid],
            "removals": removals}})
        self.piece_segment = {synthetic[index]: segment.get("id") for index, segment in valid}
        for piece in self.pieces:
            frames[piece.seg] = frames.get(piece.seg, 0) + piece.frames

        def usable(index: int | None) -> dict | None:
            if index is None or self.segments[index] is None:
                return None
            segment = self.segments[index]
            seg_id = segment.get("id")
            ok = self.segment_ok.get(seg_id, True) if isinstance(seg_id, str) else True
            return segment if ok else None

        body = usable(self.body_index)
        if body is not None:
            count = frames.get(synthetic[self.body_index], 0)
            if not tm.sf_ceil(3000, fps) <= count <= tm.sf_floor(300_000, fps):
                self.error("duration_out_of_bounds", f"/main/segments/{self.body_index}")
        co_index = self.co_index
        cold = usable(co_index)
        if cold is None:
            return
        path = f"/main/segments/{co_index}"
        count = frames.get(synthetic[co_index], 0)
        if not tm.sf_ceil(500, fps) <= count <= tm.sf_floor(8000, fps):
            self.error("cold_open_invalid", path)
        body_segment = self.segments[self.body_index] if self.body_index is not None else None
        if body_segment is None:
            return
        if abs(cold["in_sf"] - body_segment["in_sf"]) < 1:
            self.error("cold_open_invalid", path)
        length = cold["out_sf"] - cold["in_sf"]
        # Overlap of [co.in, co.out) with [body.in, body.in + L + 2·num/den), in 1/den frames.
        end = (body_segment["in_sf"] + length) * fps.den + 2 * fps.num
        overlap = max(0, min(cold["out_sf"] * fps.den, end)
                      - max(cold["in_sf"], body_segment["in_sf"]) * fps.den)
        if 5 * overlap > 4 * length * fps.den:
            self.error("cold_open_invalid", path)

    def captions(self, captions: Mapping) -> None:
        path = "/captions"
        self.boolean(captions, "enabled", path)
        pack = self.field(captions, "pack", path)
        if pack is not _MISSING and self.obj(pack, "/captions/pack") is not None:
            pack_id = self.string(pack, "id", "/captions/pack")
            version = self.integer(pack, "v", "/captions/pack", -MAX_SAFE_INTEGER)
            if pack_id is not None and version is not None and (
                    pack_id not in PACK_IDS or version != 1):
                self.error("pack_unknown", "/captions/pack")
        overrides = self.field(captions, "overrides", path)
        if overrides is not _MISSING and self.obj(overrides, "/captions/overrides") is not None:
            op = "/captions/overrides"
            self.integer(overrides, "y_e5", op, 20_000, 92_000)
            self.integer(overrides, "size_pm", op, 700, 1400)
            self.enum(overrides, "case", op, _CASES)
            self.string(overrides, "highlight", op, choices=SWATCHES)
            self.string(overrides, "emphasis", op, choices=SWATCHES)
        edits = self.field(captions, "word_edits", path)
        if edits is _MISSING or self.obj(edits, "/captions/word_edits") is None:
            return
        if len(edits) > 6000:
            self.error("range_invalid", "/captions/word_edits")
            return
        known = self.known_words()
        for word_id, edit in edits.items():
            if (_FAST and word_id in known and type(edit) is dict and edit
                    and edit.keys() <= _WORD_EDIT_KEYS and _fast_word_edit(edit)):
                continue
            ep = _join("/captions/word_edits", word_id)
            self.word(word_id, ep)
            if self.obj(edit, ep) is None:
                continue
            if not edit:
                self.error("range_invalid", ep)
                continue
            if "text" in edit:
                self.text(edit, "text", ep, 40)
            for flag in ("hidden", "emphasis"):
                if flag in edit:
                    self.boolean(edit, flag, ep)

    def layout(self, layout: Mapping) -> None:
        default = self.field(layout, "default", "/layout")
        if default is not _MISSING and self.obj(default, "/layout/default") is not None:
            self.enum(default, "mode", "/layout/default", _LAYOUT_MODES)
            self.enum(default, "no_face", "/layout/default", _NO_FACE)

    def audio(self, audio: Mapping) -> None:
        source = self.field(audio, "source", "/audio")
        if source is not _MISSING and self.obj(source, "/audio/source") is not None:
            self.integer(source, "gain_cdb", "/audio/source", -2400, 1200)
        master = self.field(audio, "master", "/audio")
        if master is not _MISSING and self.obj(master, "/audio/master") is not None:
            self.string(master, "mode", "/audio/master", choices={"off", "normalize"})
            self.integer(master, "target_clufs", "/audio/master", -2400, -900)
            self.integer(master, "tp_cdb", "/audio/master", -300, 0)

    def audit(self, audit: Mapping) -> None:
        created = self.integer(audit, "created_at_ms", "/audit")
        updated = self.integer(audit, "updated_at_ms", "/audit")
        if created is not None and updated is not None and updated < created:
            self.error("range_invalid", "/audit/updated_at_ms")
        self.string(audit, "editor", "/audit", length=(1, 64))
        self.string(audit, "last_command", "/audit", pattern=_LAST_COMMAND)

    def tracks(self, tracks: list) -> None:
        seen: set[str] = set()
        for index, track in enumerate(tracks):
            path = f"/tracks/{index}"
            if index >= 3:
                self.error("op_disabled", path)
            if self.obj(track, path) is None:
                continue
            self.identifier(track, path)
            kind = self.field(track, "kind", path)
            if kind is _MISSING:
                continue
            if kind == "text":
                self.error("op_disabled", path)
                continue
            if not isinstance(kind, str) or kind not in _ITEM_TYPE:
                self.error("range_invalid", _join(path, "kind"))
                continue
            if kind in seen:
                self.error("op_disabled", path)
            seen.add(kind)
            if kind == "visual":
                self.enum(track, "band", path, _BANDS)
                self.enum(track, "role", path, _VISUAL_ROLES)
            elif kind == "audio":
                self.enum(track, "role", path, _AUDIO_ROLES)
            items = self.field(track, "items", path)
            if items is _MISSING:
                continue
            if not isinstance(items, list):
                self.error("range_invalid", _join(path, "items"))
                continue
            for position, item in enumerate(items):
                item_path = _join(path, "items", position)
                if position >= 1:
                    self.error("op_disabled", item_path)
                if self.obj(item, item_path) is not None:
                    self.item(kind, item, item_path)

    def anchor(self, item: Mapping, key: str, path: str, expected: str) -> None:
        value = self.field(item, key, path)
        if value is _MISSING:
            return
        anchor_path = _join(path, key)
        if not isinstance(value, dict):
            self.error("range_invalid", anchor_path)
            return
        at = value.get("at")
        if at == "word":
            self.error("op_disabled", anchor_path)
        elif expected == "out":
            frame = value.get("f")
            if at == "out" and set(value) == {"at", "f"} and type(frame) is int:
                if frame != 0:
                    self.error("op_disabled", anchor_path)
            else:
                self.error("range_invalid", anchor_path)
        elif set(value) != {"at"} or at != expected:
            self.error("range_invalid", anchor_path)

    def item(self, kind: str, item: dict, path: str) -> None:
        self.identifier(item, path)
        expected = _ITEM_TYPE[kind]
        value = self.field(item, "type", path)
        if value is not _MISSING and value != expected:
            stage2 = isinstance(value, str) and value in _STAGE2_TYPES
            self.error("op_disabled" if stage2 else "range_invalid", _join(path, "type"))
        self.string(item, "origin", path, pattern=_ITEM_ORIGIN)
        if kind == "hook":
            self.hook_item(item, path)
        elif kind == "visual":
            self.logo_item(item, path)
        else:
            self.music_item(item, path)

    def hook_item(self, item: dict, path: str) -> None:
        self.anchor(item, "start", path, "out")
        high = tm.sf_floor(30_000, self.fps) if self.fps is not None else MAX_SAFE_INTEGER
        self.integer(item, "dur_f", path, 15, high)
        transform = self.field(item, "transform", path)
        tp = _join(path, "transform")
        if transform is not _MISSING and self.obj(transform, tp) is not None:
            self.integer(transform, "x_e5", tp, 50_000, 50_000)
            self.integer(transform, "y_e5", tp, 6000, 40_000)
        payload = self.field(item, "payload", path)
        if payload is _MISSING or self.obj(payload, _join(path, "payload")) is None:
            return
        pp = _join(path, "payload")
        self.text(payload, "text", pp, 90)
        design = self.field(payload, "design", pp)
        if design is not _MISSING and self.obj(design, _join(pp, "design")) is not None:
            design_id = self.string(design, "id", _join(pp, "design"))
            version = self.integer(design, "v", _join(pp, "design"), -MAX_SAFE_INTEGER)
            if design_id is not None and version is not None and (
                    design_id, version) != ("legacy-bar", 1):
                self.error("op_disabled", _join(pp, "design"))

    def asset(self, payload: Mapping, path: str, kind: str) -> Mapping | None:
        """Resolve an item's asset: its metadata when present in the document and the store."""
        asset_id = self.string(payload, "asset", path, pattern=_ASSET_ID)
        if asset_id is None:
            return None
        self.referenced.add(asset_id)
        entries = self.doc.get("assets")
        entry = entries.get(asset_id) if isinstance(entries, dict) else None
        stored = self.store.get(asset_id) if isinstance(self.store, Mapping) else None
        if entry is None or stored is None:
            self.error("asset_missing", _join(path, "asset"))
            return None
        if not isinstance(entry, dict) or entry.get("kind") != kind:
            self.error("range_invalid", _join(path, "asset"))
            return None
        if not _same(entry, dict(stored)):
            return None  # reported on /assets/<id>
        return entry

    def logo_item(self, item: dict, path: str) -> None:
        self.anchor(item, "start", path, "clip_start")
        self.anchor(item, "end", path, "clip_end")
        transform = self.field(item, "transform", path)
        values = None
        tp = _join(path, "transform")
        if transform is not _MISSING and self.obj(transform, tp) is not None:
            values = (self.integer(transform, "x_e5", tp, 0, 100_000),
                      self.integer(transform, "y_e5", tp, 0, 100_000),
                      self.integer(transform, "w_e5", tp, 4000, 40_000),
                      self.integer(transform, "opacity_pm", tp, 200, 1000))
        payload = self.field(item, "payload", path)
        meta = None
        if payload is not _MISSING and self.obj(payload, _join(path, "payload")) is not None:
            meta = self.asset(payload, _join(path, "payload"), "image")
            self.enum(payload, "mode", _join(path, "payload"), _LOGO_MODES)
        if values is None or None in values[:3] or meta is None or self.out_size is None:
            return
        if not all(type(meta.get(key)) is int and meta[key] > 0 for key in ("w", "h")):
            return
        width, height = self.out_size
        x0, y0, w_px, h_px = tm.logo_box(x_e5=values[0], y_e5=values[1], w_e5=values[2],
                                         asset_w=meta["w"], asset_h=meta["h"], out_w=width,
                                         out_h=height)
        if x0 < 0 or y0 < 0 or x0 + w_px > width or y0 + h_px > height:
            self.error("item_out_of_frame", path)

    def music_item(self, item: dict, path: str) -> None:
        self.anchor(item, "start", path, "clip_start")
        self.anchor(item, "end", path, "clip_end")
        payload = self.field(item, "payload", path)
        if payload is _MISSING or self.obj(payload, _join(path, "payload")) is None:
            return
        pp = _join(path, "payload")
        meta = self.asset(payload, pp, "audio")
        limit = MAX_SAFE_INTEGER
        if meta is not None and type(meta.get("duration_ms")) is int:
            limit = meta["duration_ms"] * 48 - 1
        start = self.integer(payload, "src_in_smp", pp, 0, max(limit, 0))
        loop = self.boolean(payload, "loop", pp)
        self.integer(payload, "gain_cdb", pp, -4800, 600)
        high = tm.sf_floor(10_000, self.fps) if self.fps is not None else MAX_SAFE_INTEGER
        self.integer(payload, "fade_in_f", pp, 0, high)
        self.integer(payload, "fade_out_f", pp, 0, high)
        duck = self.field(payload, "duck", pp)
        if duck is not _MISSING and self.obj(duck, _join(pp, "duck")) is not None:
            dp = _join(pp, "duck")
            self.boolean(duck, "on", dp)
            self.integer(duck, "depth_cdb", dp, 300, 2400)
            self.integer(duck, "attack_ms", dp, 5, 500)
            self.integer(duck, "release_ms", dp, 50, 2000)
            self.integer(duck, "hold_ms", dp, 0, 1000)
            self.enum(duck, "detector", dp, _DETECTORS)
        if meta is not None and start is not None and loop is False:
            self.music = (path, item.get("id"), meta, payload)

    def assets(self, assets: dict) -> None:
        for asset_id, entry in assets.items():
            path = _join("/assets", asset_id)
            if _ASSET_ID.fullmatch(asset_id) is None or asset_id not in self.referenced:
                self.error("range_invalid", path)
            if self.obj(entry, path) is None:
                continue
            kind = self.string(entry, "kind", path, choices={"image", "audio"})
            if kind == "image":
                self.string(entry, "mime", path, choices={"image/png"})
                self.integer(entry, "w", path, 1, 4096)
                self.integer(entry, "h", path, 1, 4096)
            elif kind == "audio":
                self.string(entry, "mime", path, choices={"audio/mp4"})
                self.integer(entry, "duration_ms", path, 1)
                self.integer(entry, "lufs_c", path, -MAX_SAFE_INTEGER)
            stored = self.store.get(asset_id) if isinstance(self.store, Mapping) else None
            if isinstance(stored, Mapping):
                for key in sorted(set(entry) | set(stored)):
                    if key not in entry or key not in stored or not _same(entry[key],
                                                                          stored[key]):
                        self.error("range_invalid", _join(path, key))

    def base_changed(self, doc: Mapping, seed: Mapping) -> None:
        found: list[str] = []
        for key in ("base", "output"):
            if key in doc:
                _diff(doc[key], seed.get(key, _MISSING), [key], found)
        if "clip_id" in doc and not _same(doc["clip_id"], seed.get("clip_id")):
            found.append("/clip_id")
        audit, seed_audit = doc.get("audit"), seed.get("audit")
        if (isinstance(audit, dict) and "created_at_ms" in audit
                and isinstance(seed_audit, Mapping)
                and not _same(audit["created_at_ms"], seed_audit.get("created_at_ms"))):
            found.append("/audit/created_at_ms")
        invalid = [issue.path for issue in self.errors if issue.code == "range_invalid"]
        for path in found:
            if not any(path == bad or path.startswith(bad + "/") or bad.startswith(path + "/")
                       for bad in invalid):
                self.error("base_changed", path)

    # --- warnings ---

    def warnings(self, doc: Mapping) -> tuple[Issue, ...]:
        """Warnings of a document without errors: its pieces are those of every segment and
        removal (computed in ``segment_frames_rule``)."""
        fps = self.fps
        if fps is None:
            return ()
        pieces = self.pieces
        by_segment: dict[str, _Edges] = {}
        for piece in pieces:
            seg_id = self.piece_segment[piece.seg]
            by_segment.setdefault(seg_id, _Edges()).add(piece)
        no_pieces = _Edges()
        found: list[Issue] = []

        def add(issue: Issue) -> None:
            if issue not in found:
                found.append(issue)

        bounds = self.words.get("bounds", ()) if isinstance(self.words, Mapping) else ()
        tight = {entry["sf"] for entry in bounds
                 if isinstance(entry, Mapping) and entry.get("tight") is True
                 and type(entry.get("sf")) is int}
        events = self.words.get("events", ()) if isinstance(self.words, Mapping) else ()
        laughter = [(entry["s"], entry["e"]) for entry in events
                    if isinstance(entry, Mapping) and entry.get("kind") == "laughter"
                    and type(entry.get("s")) is int and type(entry.get("e")) is int]
        segments = doc["main"]["segments"]
        for index, removal in enumerate(doc["main"]["removals"]):
            in_sf, out_sf = removal["in_sf"], removal["out_sf"]
            is_tight = in_sf in tight or out_sf in tight
            laughs = bool(laughter) and (_near_laughter(in_sf, laughter, fps)
                                         or _near_laughter(out_sf, laughter, fps))
            if not (is_tight or laughs):
                continue
            path = f"/main/removals/{index}"
            frame = by_segment.get(removal["seg"], no_pieces).frame(in_sf)
            if is_tight:
                add(Issue("tight_cut", path, removal["id"], frame))
            if laughs:
                add(Issue("laughter_cut", path, removal["id"], frame))
        for index, segment in enumerate(segments):
            own = by_segment.get(segment["id"], no_pieces)
            for edge in (segment["in_sf"], segment["out_sf"]):
                if edge in tight:
                    add(Issue("tight_cut", f"/main/segments/{index}", segment["id"],
                              own.frame(edge)))
        if self.music is not None:
            path, item_id, meta, payload = self.music
            available = meta["duration_ms"] * 48 - payload["src_in_smp"]
            total = tm.smp(tm.total_frames(pieces), fps)
            if available < total:
                frame = -(-available * fps.num // (tm.SAMPLE_RATE * fps.den))
                add(Issue("music_shorter_than_clip", path, item_id, frame))
        return tuple(found)


def _fast_word_edit(edit: dict) -> bool:
    """A word edit whose values are all valid (the generic checks would report nothing)."""
    text = edit.get("text", _MISSING)
    if text is not _MISSING and not (type(text) is str and 1 <= len(text) <= 40
                                     and text.strip() == text):
        return False
    return all(type(edit[flag]) is bool for flag in ("hidden", "emphasis") if flag in edit)


def _diff(value: object, seed: object, tokens: list, found: list[str]) -> None:
    """Pointers where ``value`` differs from ``seed`` (lists element-wise, rationals whole)."""
    if isinstance(value, dict) and isinstance(seed, Mapping):
        for key in list(value) + [k for k in seed if k not in value]:
            if key not in value or key not in seed:
                found.append(_pointer([*tokens, key]))
            else:
                _diff(value[key], seed[key], [*tokens, key], found)
    elif (isinstance(value, list) and isinstance(seed, list) and len(value) == len(seed)
          and tokens[-1] not in _ATOMIC_KEYS):
        for index, (item, other) in enumerate(zip(value, seed, strict=True)):
            _diff(item, other, [*tokens, index], found)
    elif not _same(value, seed):
        found.append(_pointer(tokens))


class _Edges:
    """One segment's pieces (source order), to map a cut boundary to its output frame."""

    __slots__ = ("pieces", "starts")

    def __init__(self) -> None:
        self.pieces: list[tm.Piece] = []
        self.starts: list[int] = []

    def add(self, piece: tm.Piece) -> None:
        self.pieces.append(piece)
        self.starts.append(piece.in_sf)

    def frame(self, sf: int) -> int | None:
        """Output frame of a cut at source-grid boundary ``sf``: inside a piece its frame, in
        a removed range the first frame after the cut."""
        if not self.pieces:
            return None
        position = bisect_right(self.starts, sf) - 1
        if position < 0:
            return self.pieces[0].out_f0
        piece = self.pieces[position]
        if sf <= piece.out_sf:
            return piece.out_f0 + (sf - piece.in_sf)
        if position + 1 < len(self.pieces):
            return self.pieces[position + 1].out_f0
        return piece.out_f0 + piece.frames


def _near_laughter(sf: int, laughter: list[tuple[int, int]], fps: tm.Fps) -> bool:
    """The frame start of ``sf`` lies inside a laughter span or within 300 ms of a point."""
    t = sf * 1000 * fps.den  # milliseconds × num
    for start, end in laughter:
        if start == end:
            if abs(t - start * fps.num) <= 300 * fps.num:
                return True
        elif start * fps.num <= t <= end * fps.num:
            return True
    return False


def validate_doc(
    doc: Mapping, *, words: Mapping, assets: Mapping[str, Mapping], seed: Mapping | None
) -> Validation:
    """Semantic validation of a parsed document (plan §3.3, §3.4, §3.7; CONTRACTS §5.4).

    ``words`` is the clip's ``potongin.words/1`` artifact, ``assets`` the job asset store's
    metadata keyed ``sha256:<hex>`` (document form), ``seed`` the clip's revision 0 (``None``
    when validating the seed itself; then ``base_changed`` is not checked). With a seed, the
    checks that depend on the frame rate, the output size and the analysis window use the
    seed's values, so a changed base is reported once as ``base_changed``.
    """
    return _Validator(doc, words, assets, seed).run()


def iter_asset_ids(doc: Mapping) -> Iterator[str]:
    """Every well-formed ``sha256:<hex>`` id the document names (``assets`` keys and items)."""
    seen: set[str] = set()
    assets = doc.get("assets") if isinstance(doc, Mapping) else None
    candidates: list[object] = list(assets) if isinstance(assets, dict) else []
    tracks = doc.get("tracks") if isinstance(doc, Mapping) else None
    for track in tracks if isinstance(tracks, list) else ():
        items = track.get("items") if isinstance(track, dict) else None
        for item in items if isinstance(items, list) else ():
            payload = item.get("payload") if isinstance(item, dict) else None
            if isinstance(payload, dict):
                candidates.append(payload.get("asset"))
    for candidate in candidates:
        if isinstance(candidate, str) and _ASSET_ID.fullmatch(candidate) and candidate not in seen:
            seen.add(candidate)
            yield candidate


__all__ = [
    "MAX_DOC_BYTES",
    "Issue",
    "Validation",
    "canonical_bytes",
    "content_equals_seed",
    "content_sha256",
    "doc_sha256",
    "iter_asset_ids",
    "parse_doc",
    "validate_doc",
]
