"""The automatic layout ("Otomatis"): one 9:16 mode per shot (rombak 04 §A5, CONTRACTS §5.63).

A clip window is cut into shots (``shot_cuts``), every shot gets its evidence (``shot_context``:
faces, who speaks, motion), and :func:`decide_shot` turns the evidence into a mode with a reason
code. The first rule that matches wins:

1. too few samples with a face → ``fit_blur`` (``rf_no_face``);
2. two people speaking in turn and further apart than the crop → ``split`` when the split chain
   is enabled, else ``camera`` (``rf_two_speakers``);
3. three or more faces wider than the crop → ``fit_blur`` (``rf_group_wide``);
4. the face too small to carry a crop → ``fit_blur`` (``rf_small_face``);
5. the face at the centre and the picture still → ``fill_center`` (``rf_centred``);
6. otherwise → ``camera`` (``rf_face``).

:func:`plan_shots` decides every shot with at least two samples, gives a shorter one the mode of
its longer neighbour (``rf_short_merged``) and merges neighbours with the same mode into the
ranges the document carries (``layout.ranges``). The shot plan file
``shots.<sha16>.json`` (``potongin.shot-plan/1``) holds both and is read back strictly by
:func:`read_shot_plan`.

The thresholds live in ``resources/reframe/rules.v1.json``; they are set by the dev-split sweep
of ``scripts/eval/auto_reframe.py`` (``docs/evaluation/AUTO_REFRAME.md``), never by hand, and
their ``rules_id`` is part of every shot plan. Everything here is integer arithmetic on per-mille
values, so the plan is the same on every machine.

:func:`canonical_ranges` and :func:`merge_user_ranges` are the document side (§A6): the
canonical form of ``layout.ranges`` and the re-analysis that never overwrites a user's range.
Stdlib only; :func:`prepare_auto` is the one function that reaches OpenCV, through
``shot_context`` (imported when it runs, like ``camera`` reaches ``face_window``).
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, fields
from itertools import pairwise
from pathlib import Path
from typing import Any

from . import AUTO_SPLIT, DOC_FPS, PAN_E5_MAX, SPLIT_ZOOM_RANGE, ZOOM_RANGE, errors
from . import timemap as tm
from .layouts import picture_size, scaled_size, split_bands, split_crop, zoomed_output
from .source_info import canonical_json, sha256_hex, write_immutable
from .timemap import Fps

SHOT_SCHEMA = "potongin.shot-plan/1"
RULES_SCHEMA = "potongin.reframe-rules/1"
RULES_FILE = Path(__file__).resolve().parents[3] / "resources" / "reframe" / "rules.v1.json"
MAX_SHOT_PLAN_BYTES = 256 * 1024
MAX_SHOTS = 200
MAX_RANGES = 200

AUTO_MODES = ("camera", "fill_center", "fit_blur", "split")
USER_MODES = ("camera", "fill_center", "fit_blur")
ORIGINS = ("auto", "user")
CUT_SOURCES = ("shot_cuts", "scene_cuts", "none")
REASONS = ("rf_no_face", "rf_two_speakers", "rf_group_wide", "rf_small_face", "rf_centred",
           "rf_face", "rf_short_merged")
MIN_SAMPLES = 2  # a shot with fewer samples (about 1.5 s) takes its neighbour's mode
SPLIT_TOP_PM = 500  # the automatic split's bands: half and half


# --- rules -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Rules:
    """The thresholds of ``resources/reframe/rules.v1.json`` (integers, see the module notes)."""

    cut_coarse_scene_pm: int
    cut_refine_diff_pm: int
    cut_min_gap_ms: int
    scan_timeout_s: int
    face_present_pm: int
    face_small_w_pm: int
    face_centre_pm: int
    speakers_active_pm: int
    speakers_split_share_pm: int
    motion_still_pm: int
    rules_id: str = ""

    def with_values(self, values: Mapping[str, int]) -> Rules:
        """A copy with some thresholds replaced, by their file names (``cut.min_gap_ms``); the
        sweep's way of trying a configuration. ``rules_id`` then names the new values."""
        changes = {}
        for key, value in values.items():
            name = key.replace(".", "_")
            if name not in RULE_KEYS or type(value) is not int:
                raise ValueError(f"unknown rule or not an integer: {key}")
            changes[name] = value
        data = {name: getattr(self, name) for name in RULE_KEYS} | changes
        return Rules(**data, rules_id=_rules_id(_rules_json(data)))


RULE_KEYS = tuple(field.name for field in fields(Rules) if field.name != "rules_id")
_RULE_GROUPS = {"cut": ("coarse_scene_pm", "refine_diff_pm", "min_gap_ms"),
                "scan": ("timeout_s",),
                "face": ("present_pm", "small_w_pm", "centre_pm"),
                "speakers": ("active_pm", "split_share_pm"),
                "motion": ("still_pm",)}


def _rules_json(values: Mapping[str, int]) -> dict[str, Any]:
    return {"schema": RULES_SCHEMA,
            **{group: {key: values[f"{group}_{key}"] for key in keys}
               for group, keys in _RULE_GROUPS.items()}}


def _rules_id(value: Mapping[str, Any]) -> str:
    return sha256_hex(canonical_json(value))[:16]


def parse_rules(value: object) -> Rules:
    """Rules from the parsed file; ``ValueError`` unless it holds exactly the known integer
    keys (each at least 0, the timeout at least 1)."""
    if not isinstance(value, dict) or set(value) != {"schema", *_RULE_GROUPS}:
        raise ValueError("a rules file holds schema, cut, scan, face, speakers and motion")
    if value["schema"] != RULES_SCHEMA:
        raise ValueError(f"rules schema must be {RULES_SCHEMA}")
    data: dict[str, int] = {}
    for group, keys in _RULE_GROUPS.items():
        part = value[group]
        if not isinstance(part, dict) or set(part) != set(keys):
            raise ValueError(f"rules {group} holds {', '.join(keys)}")
        for key in keys:
            number = part[key]
            if type(number) is not int or number < 0:
                raise ValueError(f"rule {group}.{key} must be a non-negative integer")
            data[f"{group}_{key}"] = number
    if data["scan_timeout_s"] < 1:
        raise ValueError("rule scan.timeout_s must be at least 1")
    return Rules(**data, rules_id=_rules_id(value))


def load_rules(path: Path = RULES_FILE) -> Rules:
    """The rules of ``path`` (default ``resources/reframe/rules.v1.json``)."""
    return parse_rules(json.loads(Path(path).read_text(encoding="utf-8")))


# --- evidence and the decision ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ShotEvidence:
    """What ``shot_context.summarize`` measured over one shot (rombak 04 §A4); per-mille values
    are of the source width or of the shot's samples."""

    samples: int
    face_share_pm: int
    faces_p90: int
    face_w_med_pm: int
    speakers: int
    talk_share_pm: tuple[int, ...]
    spread_pm: int
    centre_dev_pm: int
    motion_med_pm: int

    def to_json(self) -> dict[str, Any]:
        return {"samples": self.samples, "face_share_pm": self.face_share_pm,
                "faces_p90": self.faces_p90, "face_w_med_pm": self.face_w_med_pm,
                "speakers": self.speakers, "talk_share_pm": list(self.talk_share_pm),
                "spread_pm": self.spread_pm, "centre_dev_pm": self.centre_dev_pm,
                "motion_med_pm": self.motion_med_pm}

    @classmethod
    def from_json(cls, value: object) -> ShotEvidence:
        if not isinstance(value, dict) or set(value) != set(EVIDENCE_KEYS):
            raise ValueError("evidence keys")
        for key in EVIDENCE_KEYS:
            if key == "talk_share_pm":
                shares = value[key]
                if (not isinstance(shares, list)
                        or not all(type(v) is int and 0 <= v <= 1000 for v in shares)
                        or any(b > a for a, b in pairwise(shares))):
                    raise ValueError("talk_share_pm")
            elif type(value[key]) is not int or value[key] < 0:
                raise ValueError(key)
        for key in ("face_share_pm", "face_w_med_pm", "spread_pm", "centre_dev_pm",
                    "motion_med_pm"):
            if value[key] > 1000:
                raise ValueError(key)
        return cls(**{**value, "talk_share_pm": tuple(value["talk_share_pm"])})


EVIDENCE_KEYS = tuple(field.name for field in fields(ShotEvidence))


@dataclass(frozen=True, slots=True)
class SplitHint:
    """The two people a split shot would show: each one's face centre (``x_pm``, ``y_pm`` of
    the source), the one who speaks first on top."""

    top: tuple[int, int]
    bottom: tuple[int, int]


def crop_width_pm(source: tuple[int, int], output: tuple[int, int], *,
                  zoom_pm: int = ZOOM_RANGE[0], content: Sequence[int] | None = None) -> int:
    """The crop's width in per mille of the picture's width: the output width over the width
    of the scaled (and zoomed) picture, rounded half up (the 9:16 crop of a 16:9 source: 316)."""
    picture = picture_size(source, content)
    scaled = scaled_size(picture, zoomed_output(output, zoom_pm))[0]
    return min(tm.div_round_half_up(output[0] * 1000, scaled), 1000)


def decide_shot(ev: ShotEvidence, *, crop_w_pm: int, rules: Rules,
                split_enabled: bool = AUTO_SPLIT) -> tuple[str, str]:
    """``(mode, reason)`` of one shot: the first rule of the module notes that matches."""
    if ev.face_share_pm < rules.face_present_pm:
        return "fit_blur", "rf_no_face"
    if (ev.speakers >= 2 and len(ev.talk_share_pm) >= 2
            and ev.talk_share_pm[1] >= rules.speakers_split_share_pm
            and ev.spread_pm > crop_w_pm):
        return ("split" if split_enabled else "camera"), "rf_two_speakers"
    if ev.faces_p90 >= 3 and ev.spread_pm > crop_w_pm:
        return "fit_blur", "rf_group_wide"
    if ev.face_w_med_pm < rules.face_small_w_pm:
        return "fit_blur", "rf_small_face"
    if ev.centre_dev_pm <= rules.face_centre_pm and ev.motion_med_pm <= rules.motion_still_pm:
        return "fill_center", "rf_centred"
    return "camera", "rf_face"


@dataclass(frozen=True, slots=True)
class Shot:
    in_sf: int
    out_sf: int
    mode: str
    reason: str
    evidence: ShotEvidence

    def to_json(self) -> dict[str, Any]:
        return {"in_sf": self.in_sf, "out_sf": self.out_sf, "mode": self.mode,
                "reason": self.reason, "evidence": self.evidence.to_json()}


def shot_bounds(cuts_sf: Sequence[int], window_sf: tuple[int, int]) -> list[tuple[int, int]]:
    """The shots ``[in_sf, out_sf)`` of a window cut at ``cuts_sf`` (strictly increasing, inside
    the window and not on its first frame)."""
    first, end = window_sf
    if not first < end:
        raise ValueError("the window must hold a frame")
    edges = [first, *cuts_sf, end]
    if any(b <= a for a, b in pairwise(edges)):
        raise ValueError("cuts must be strictly increasing inside the window")
    return list(pairwise(edges))


def _resolve_short(decided: list[tuple[str, str] | None],
                   lengths: Sequence[int]) -> list[str | None]:
    """The mode a short shot takes: its longer decided neighbour's (the left one on a tie),
    looking further out while a neighbour is short itself; ``None`` without any decided shot."""
    modes: list[str | None] = []
    for index, choice in enumerate(decided):
        if choice is not None:
            modes.append(choice[0])
            continue
        left = next((i for i in range(index - 1, -1, -1) if decided[i] is not None), None)
        right = next((i for i in range(index + 1, len(decided)) if decided[i] is not None), None)
        if left is None and right is None:
            modes.append(None)
            continue
        if left is None or (right is not None and lengths[right] > lengths[left]):
            pick = right
        else:
            pick = left
        modes.append(decided[pick][0])
    return modes


def plan_shots(
    cuts_sf: Sequence[int],
    window_sf: tuple[int, int],
    evidences: Sequence[ShotEvidence],
    *,
    crop_w_pm: int,
    rules: Rules,
    split_enabled: bool = AUTO_SPLIT,
    whole: ShotEvidence | None = None,
) -> list[Shot]:
    """One decided :class:`Shot` per shot of the window (module notes). ``evidences`` is one per
    shot; ``whole`` is the evidence of the whole window, which decides every shot when none has
    enough samples of its own (a window cut into nothing but short shots)."""
    bounds = shot_bounds(cuts_sf, window_sf)
    if len(evidences) != len(bounds):
        raise ValueError("one evidence per shot")
    decided = [decide_shot(ev, crop_w_pm=crop_w_pm, rules=rules, split_enabled=split_enabled)
               if ev.samples >= MIN_SAMPLES else None for ev in evidences]
    lengths = [out_sf - in_sf for in_sf, out_sf in bounds]
    modes = _resolve_short(decided, lengths)
    fallback = None
    if all(choice is None for choice in decided):
        fallback = decide_shot(whole or _empty_evidence(), crop_w_pm=crop_w_pm, rules=rules,
                               split_enabled=split_enabled)
    shots = []
    for (in_sf, out_sf), ev, choice, mode in zip(bounds, evidences, decided, modes, strict=True):
        if choice is not None:
            shots.append(Shot(in_sf, out_sf, choice[0], choice[1], ev))
        elif mode is not None:
            shots.append(Shot(in_sf, out_sf, mode, "rf_short_merged", ev))
        else:
            assert fallback is not None
            shots.append(Shot(in_sf, out_sf, fallback[0], fallback[1], ev))
    return shots


def _empty_evidence() -> ShotEvidence:
    return ShotEvidence(0, 0, 0, 0, 0, (), 0, 0, 0)


def split_geometry(hints: Sequence[SplitHint], *, source: tuple[int, int],
                   output: tuple[int, int]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """``layout.split`` of the clip (``top_pm`` and each band's zoom, one per clip) and the
    ``split_xy`` of each split range: the crop that puts each person's face centre in the middle
    of its band, as far as the crop can travel."""
    bands = dict(zip(("top", "bottom"), split_bands(output, SPLIT_TOP_PM), strict=True))
    zoom = SPLIT_ZOOM_RANGE[0]
    split = {"top_pm": SPLIT_TOP_PM, "top": {"zoom_pm": zoom}, "bottom": {"zoom_pm": zoom}}
    places = []
    for hint in hints:
        place: dict[str, Any] = {}
        for band, (x_pm, y_pm) in (("top", hint.top), ("bottom", hint.bottom)):
            _x, _y, w, h = split_crop(source, bands[band],
                                      {"x_e5": 0, "y_e5": 0, "zoom_pm": zoom})
            place[band] = {"x_e5": _travel_e5(x_pm * source[0], w, source[0]),
                           "y_e5": _travel_e5(y_pm * source[1], h, source[1])}
        places.append(place)
    return split, places


def _travel_e5(centre_pm_px: int, size: int, total: int) -> int:
    """Where along its travel (0–100000) a crop of ``size`` puts ``centre_pm_px / 1000``."""
    travel = (total - size) - (total - size) % 2
    if travel <= 0:
        return PAN_E5_MAX // 2
    left = tm.div_round_half_up(centre_pm_px - 500 * size, 1000)
    return min(max(tm.div_round_half_up(left * PAN_E5_MAX, travel), 0), PAN_E5_MAX)


def ranges_of(shots: Sequence[Shot], split_xy: Sequence[Mapping[str, Any] | None] | None = None
              ) -> list[dict[str, Any]]:
    """The shot plan's ``ranges``: neighbouring shots with the same mode (and, for split, the
    same crops) merged."""
    out: list[dict[str, Any]] = []
    for index, shot in enumerate(shots):
        place = split_xy[index] if split_xy is not None and shot.mode == "split" else None
        if out and out[-1]["mode"] == shot.mode and out[-1].get("split_xy") == place:
            out[-1]["out_sf"] = shot.out_sf
            continue
        entry: dict[str, Any] = {"in_sf": shot.in_sf, "out_sf": shot.out_sf, "mode": shot.mode}
        if place is not None:
            entry["split_xy"] = place
        out.append(entry)
    return out


# --- layout.ranges in the document (§A6) -------------------------------------------------------


def _range_key(entry: Mapping[str, Any]) -> tuple:
    return (entry["mode"], entry["origin"], canonical_json(entry.get("split_xy")))


def canonical_ranges(ranges: Sequence[Mapping[str, Any]],
                     default_mode: str) -> list[dict[str, Any]] | None:
    """``layout.ranges`` in canonical form: equal neighbours (mode, origin, split crops) merged;
    ``None`` (no ranges) when the default mode is not ``auto`` and every range is automatic."""
    merged: list[dict[str, Any]] = []
    for entry in ranges:
        item = {key: entry[key] for key in ("in_sf", "out_sf", "mode", "origin")}
        if "split_xy" in entry:
            item["split_xy"] = entry["split_xy"]
        if merged and merged[-1]["out_sf"] == item["in_sf"] and _range_key(merged[-1]) == \
                _range_key(item):
            merged[-1]["out_sf"] = item["out_sf"]
        else:
            merged.append(item)
    if default_mode != "auto" and all(entry["origin"] == "auto" for entry in merged):
        return None
    return merged


def auto_ranges(plan_ranges: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """A shot plan's ranges as document ranges (``origin: "auto"``)."""
    out = []
    for entry in plan_ranges:
        item = {"in_sf": entry["in_sf"], "out_sf": entry["out_sf"], "mode": entry["mode"],
                "origin": "auto"}
        if "split_xy" in entry:
            item["split_xy"] = entry["split_xy"]
        out.append(item)
    return out


def merge_user_ranges(new_auto: Sequence[Mapping[str, Any]],
                      old: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """A new analysis's automatic partition with the user's old ranges laid over it (§A6): each
    old ``origin:"user"`` range, in ``in_sf`` order, is clipped to the new window, dropped when
    nothing is left, else overwrites the partition on its frames; then the canonical form (the
    default mode is ``auto`` here, so the ranges stay)."""
    if not new_auto:
        raise ValueError("the new analysis has no ranges")
    first, end = new_auto[0]["in_sf"], new_auto[-1]["out_sf"]
    parts = [dict(entry) for entry in new_auto]
    for user in sorted((dict(entry) for entry in old if entry.get("origin") == "user"),
                       key=lambda entry: entry["in_sf"]):
        lo, hi = max(user["in_sf"], first), min(user["out_sf"], end)
        if lo >= hi:
            continue
        user = {**user, "in_sf": lo, "out_sf": hi}
        out: list[dict[str, Any]] = []
        for part in parts:
            if part["out_sf"] <= lo or part["in_sf"] >= hi:
                out.append(part)
                continue
            if part["in_sf"] < lo:
                out.append({**part, "out_sf": lo})
            if part["out_sf"] > hi:
                out.append({**part, "in_sf": hi})
        out.append(user)
        parts = sorted(out, key=lambda entry: entry["in_sf"])
    result = canonical_ranges(parts, "auto")
    assert result is not None
    return result


def mode_at(ranges: Sequence[tuple[int, int, str]], sf: int) -> str | None:
    """The mode of the range holding source-grid frame ``sf``; ``None`` outside every range."""
    lo, hi = 0, len(ranges)
    while lo < hi:
        mid = (lo + hi) // 2
        if ranges[mid][0] <= sf:
            lo = mid + 1
        else:
            hi = mid
    index = lo - 1
    if index >= 0 and ranges[index][0] <= sf < ranges[index][1]:
        return ranges[index][2]
    return None


# --- the shot plan file ----------------------------------------------------------------------


def encode_shot_plan(plan: Mapping[str, Any]) -> bytes:
    return canonical_json(plan)


def shot_file_name(raw: bytes) -> str:
    """``shots.<sha16>.json``: the first 16 hex digits of the sha256 of the bytes."""
    return f"shots.{hashlib.sha256(raw).hexdigest()[:16]}.json"


def build_shot_plan(*, rules: Rules, source_content_sha256: str, camera_sha256: str,
                    window_ms: tuple[int, int], fps: Fps, cut_source: str,
                    cuts_sf: Sequence[int], shots: Sequence[Shot],
                    split: Mapping[str, Any] | None = None,
                    split_xy: Sequence[Mapping[str, Any] | None] | None = None) -> dict[str, Any]:
    """The ``potongin.shot-plan/1`` object (CONTRACTS §5.63); checked like a read file."""
    plan = {
        "schema": SHOT_SCHEMA,
        "rules_id": rules.rules_id,
        "source_content_sha256": source_content_sha256,
        "camera_sha256": camera_sha256,
        "window_ms": [window_ms[0], window_ms[1]],
        "fps": {"num": fps.num, "den": fps.den},
        "cut_source": cut_source,
        "cuts_sf": list(cuts_sf),
        "split": None if split is None else dict(split),
        "shots": [shot.to_json() for shot in shots],
        "ranges": ranges_of(shots, split_xy),
    }
    check_shot_plan(plan)
    return plan


def _hex(value: object, size: int) -> bool:
    return (isinstance(value, str) and len(value) == size
            and all(c in "0123456789abcdef" for c in value))


def _int(value: object, low: int = 0, high: int | None = None) -> bool:
    return type(value) is int and value >= low and (high is None or value <= high)


def _check_split_xy(value: object) -> None:
    if not isinstance(value, dict) or set(value) != {"top", "bottom"}:
        raise ValueError("split_xy holds top and bottom")
    for band in value.values():
        if (not isinstance(band, dict) or set(band) != {"x_e5", "y_e5"}
                or not all(_int(v, 0, PAN_E5_MAX) for v in band.values())):
            raise ValueError("split_xy band holds x_e5 and y_e5 in 0..100000")


def check_shot_plan(plan: object) -> None:
    """Raises ``ValueError`` unless ``plan`` is a valid shot plan (CONTRACTS §5.63): exactly its
    keys and types, shots that partition the window at its cuts, ranges that are the merged
    shots (the split crops on split ranges only)."""
    keys = {"schema", "rules_id", "source_content_sha256", "camera_sha256", "window_ms", "fps",
            "cut_source", "cuts_sf", "split", "shots", "ranges"}
    if not isinstance(plan, dict) or set(plan) != keys:
        raise ValueError("shot plan keys")
    if plan["schema"] != SHOT_SCHEMA or not _hex(plan["rules_id"], 16):
        raise ValueError("schema or rules_id")
    if not _hex(plan["source_content_sha256"], 64) or not _hex(plan["camera_sha256"], 64):
        raise ValueError("shas")
    window = plan["window_ms"]
    if (not isinstance(window, list) or len(window) != 2 or not all(_int(v) for v in window)
            or window[0] >= window[1]):
        raise ValueError("window_ms")
    fps_value = plan["fps"]
    if (not isinstance(fps_value, dict) or set(fps_value) != {"num", "den"}
            or (fps_value["num"], fps_value["den"]) not in DOC_FPS
            or not all(type(v) is int for v in fps_value.values())):
        raise ValueError("fps")
    fps = Fps(fps_value["num"], fps_value["den"])
    window_sf = (tm.sf_floor(window[0], fps), tm.sf_ceil(window[1], fps))
    if plan["cut_source"] not in CUT_SOURCES:
        raise ValueError("cut_source")
    cuts = plan["cuts_sf"]
    if not isinstance(cuts, list) or not all(_int(v) for v in cuts):
        raise ValueError("cuts_sf")
    if plan["cut_source"] == "none" and cuts:
        raise ValueError("no cut source, no cuts")
    bounds = shot_bounds(cuts, window_sf)
    shots = plan["shots"]
    if not isinstance(shots, list) or not 1 <= len(shots) <= MAX_SHOTS or len(shots) != len(
            bounds):
        raise ValueError("shots")
    for shot, (in_sf, out_sf) in zip(shots, bounds, strict=True):
        if not isinstance(shot, dict) or set(shot) != {"in_sf", "out_sf", "mode", "reason",
                                                        "evidence"}:
            raise ValueError("shot keys")
        if shot["in_sf"] != in_sf or shot["out_sf"] != out_sf:
            raise ValueError("shots must be the window cut at its cuts")
        if shot["mode"] not in AUTO_MODES or shot["reason"] not in REASONS:
            raise ValueError("shot mode or reason")
        ShotEvidence.from_json(shot["evidence"])
    has_split = any(shot["mode"] == "split" for shot in shots)
    split = plan["split"]
    if has_split != (split is not None):
        raise ValueError("split is set exactly when a shot is split")
    if split is not None and (
            not isinstance(split, dict) or set(split) != {"top_pm", "top", "bottom"}
            or split["top_pm"] not in (300, 500, 700) or type(split["top_pm"]) is not int
            or not all(isinstance(split[b], dict) and set(split[b]) == {"zoom_pm"}
                       and _int(split[b]["zoom_pm"], *SPLIT_ZOOM_RANGE)
                       for b in ("top", "bottom"))):
        raise ValueError("split")
    ranges = plan["ranges"]
    if not isinstance(ranges, list) or not 1 <= len(ranges) <= MAX_RANGES:
        raise ValueError("ranges")
    edge = window_sf[0]
    mode_by_frame = {shot["in_sf"]: shot["mode"] for shot in shots}
    starts = [shot["in_sf"] for shot in shots]
    previous: tuple | None = None
    for entry in ranges:
        allowed = {"in_sf", "out_sf", "mode"} | ({"split_xy"} if entry.get("mode") == "split"
                                                  else set())
        if not isinstance(entry, dict) or not {"in_sf", "out_sf", "mode"} <= set(entry) <= \
                allowed:
            raise ValueError("range keys")
        if entry["mode"] == "split":
            if "split_xy" not in entry:
                raise ValueError("a split range carries split_xy")
            _check_split_xy(entry["split_xy"])
        if entry["in_sf"] != edge or not _int(entry["out_sf"]) or entry["out_sf"] <= edge:
            raise ValueError("ranges must partition the window")
        covered = [s for s in starts if entry["in_sf"] <= s < entry["out_sf"]]
        if (not covered or covered[0] != entry["in_sf"]
                or (entry["out_sf"] != window_sf[1] and entry["out_sf"] not in starts)
                or any(mode_by_frame[s] != entry["mode"] for s in covered)):
            raise ValueError("ranges must be the merged shots")
        key = (entry["mode"], canonical_json(entry.get("split_xy")))
        if key == previous:
            raise ValueError("equal neighbouring ranges must be merged")
        previous = key
        edge = entry["out_sf"]
    if edge != window_sf[1]:
        raise ValueError("ranges must partition the window")


def read_shot_plan(path: Path) -> dict[str, Any]:
    """The shot plan at ``path``, strictly (CONTRACTS §5.63): a regular file (never a symlink)
    of at most 256 KiB whose name is its sha16, canonical bytes of a valid plan. Anything else
    raises ``AnalysisMissing("analysis_missing", ref="shots")``."""
    path = Path(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as exc:
        raise errors.AnalysisMissing("analysis_missing", ref="shots") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SHOT_PLAN_BYTES:
            raise errors.AnalysisMissing("analysis_missing", ref="shots")
        raw = os.read(fd, MAX_SHOT_PLAN_BYTES + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_SHOT_PLAN_BYTES or path.name != shot_file_name(raw):
        raise errors.AnalysisMissing("analysis_missing", ref="shots")
    try:
        plan = json.loads(raw)
        check_shot_plan(plan)
        if encode_shot_plan(plan) != raw:
            raise ValueError("not canonical")
    except (ValueError, TypeError, KeyError) as exc:
        raise errors.AnalysisMissing("analysis_missing", ref="shots") from exc
    return plan


def load_shot_plan(clip_dir: Path, sha256: str) -> dict[str, Any]:
    """The shot plan a document names (``base.shots.sha256``) in its clip directory."""
    if not _hex(sha256, 64):
        raise errors.AnalysisMissing("analysis_missing", ref="shots")
    plan = read_shot_plan(Path(clip_dir) / f"shots.{sha256[:16]}.json")
    if sha256_hex(encode_shot_plan(plan)) != sha256:
        raise errors.AnalysisMissing("analysis_missing", ref="shots")
    return plan


def write_shot_plan(clip_dir: Path, plan: Mapping[str, Any]) -> tuple[str, str]:
    """Publish the plan as ``<clip_dir>/shots.<sha16>.json`` (immutable, 0600); returns ``(name,
    sha256)``. An existing file of that name must hold the same bytes."""
    check_shot_plan(plan)
    raw = encode_shot_plan(plan)
    if len(raw) > MAX_SHOT_PLAN_BYTES:
        raise ValueError("the shot plan is larger than 256 KiB")
    name = shot_file_name(raw)
    target = Path(clip_dir) / name
    if not write_immutable(target, raw):
        read_shot_plan(target)
    return name, sha256_hex(raw)


# --- one clip, end to end (rombak 04 §A1) ------------------------------------------------------


def prepare_auto(
    source: Path,
    window_ms: tuple[int, int],
    fps: Fps,
    *,
    output: tuple[int, int],
    camera_plan: Mapping[str, Any] | None = None,
    scene_cuts_ms: Sequence[int] = (),
    rules: Rules | None = None,
    zoom_pm: int = ZOOM_RANGE[0],
    content: Sequence[int] | None = None,
    split_enabled: bool = AUTO_SPLIT,
    progress: Callable[[int, int], None] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(camera plan, shot plan)`` of one clip window: the camera plan (built from the scan the
    evidence uses, byte for byte today's, unless one is given), the shot cuts, the evidence per
    shot and the decided shot plan. Nothing is written; the caller publishes both files."""
    from .. import shot_context
    from . import camera as _camera
    from . import shot_cuts

    rules = load_rules() if rules is None else rules
    fps = Fps.from_json(fps)
    a, b = window_ms
    window_sf = (tm.sf_floor(a, fps), tm.sf_ceil(b, fps))
    if camera_plan is None:
        scan = shot_context.scan_evidence(source, window_ms, progress=progress)
        camera_plan = _camera.build_camera_plan(source, window_ms, fps, out_w=output[0],
                                                out_h=output[1], scan=scan)
    else:
        scan = shot_context.scan_evidence(source, window_ms, progress=progress)
    coarse = [t for (t, _c), cut in zip(camera_plan["samples"], camera_plan["cuts"],
                                        strict=True) if cut]
    found = shot_cuts.find_cuts(source, window_ms, fps, coarse_cuts_ms=coarse,
                                scene_cuts_ms=scene_cuts_ms, rules=rules)
    width, height = scan.width, scan.height
    context = shot_context.Context.of(scan, window_ms=window_ms, fps=fps)
    bounds = shot_bounds(found.cuts_sf, window_sf)
    evidences = [context.summarize(shot, rules=rules) for shot in bounds]
    whole = context.summarize(window_sf, rules=rules)
    crop_w = crop_width_pm((width, height), output, zoom_pm=zoom_pm, content=content)
    shots = plan_shots(found.cuts_sf, window_sf, evidences, crop_w_pm=crop_w, rules=rules,
                       split_enabled=split_enabled, whole=whole)
    split = None
    split_xy = None
    if any(shot.mode == "split" for shot in shots):
        hints = [context.split_hint(shot_range) if shot.mode == "split" else None
                 for shot, shot_range in zip(shots, bounds, strict=True)]
        split, places = split_geometry([h for h in hints if h is not None],
                                       source=(width, height), output=output)
        iterator = iter(places)
        split_xy = [next(iterator) if hint is not None else None for hint in hints]
    plan = build_shot_plan(
        rules=rules, source_content_sha256=camera_plan["source_content_sha256"],
        camera_sha256=sha256_hex(canonical_json(camera_plan)), window_ms=(a, b), fps=fps,
        cut_source=found.source, cuts_sf=found.cuts_sf, shots=shots, split=split,
        split_xy=split_xy)
    return dict(camera_plan), plan


__all__ = [
    "AUTO_MODES",
    "CUT_SOURCES",
    "EVIDENCE_KEYS",
    "MAX_SHOT_PLAN_BYTES",
    "MIN_SAMPLES",
    "ORIGINS",
    "REASONS",
    "RULES_FILE",
    "RULE_KEYS",
    "SHOT_SCHEMA",
    "USER_MODES",
    "Rules",
    "Shot",
    "ShotEvidence",
    "SplitHint",
    "auto_ranges",
    "build_shot_plan",
    "canonical_ranges",
    "check_shot_plan",
    "crop_width_pm",
    "decide_shot",
    "encode_shot_plan",
    "load_rules",
    "load_shot_plan",
    "merge_user_ranges",
    "mode_at",
    "parse_rules",
    "plan_shots",
    "prepare_auto",
    "ranges_of",
    "read_shot_plan",
    "shot_bounds",
    "shot_file_name",
    "split_geometry",
    "write_shot_plan",
]
