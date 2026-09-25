"""Document, words and plan builders for the Editor V3 tests (plan §11.1 T1.0).

This module builds, deterministically, everything under ``tests/fixtures/edit_v2/docs/``:

* three **contexts** (``contexts/<id>.words.json``, ``contexts/<id>.seed.json`` and the shared
  ``contexts/assets.json``): a words artifact (plan §3.6), the seed (revision 0, plan §3.5) and
  the job asset store (document-form metadata keyed ``sha256:<hex>``);
* **valid** and **invalid** documents (``valid/*.json``, ``invalid/<code>__<variant>.json``),
  each invalid one violating exactly one rule;
* ``index.json``: the expected classification of every fixture (see docs/editor/CONTRACTS.md,
  "Document fixtures").

Regenerate with ``PYTHONPATH=src:tests python -m support.edit_v2_fixtures --write``; the test
suite checks that the committed files equal a fresh render.

The bounds of the fixture words artifacts put each cut at the frame boundary inside the gap that
is nearest the gap centre (the fixtures have no peaks); T1.5's real builder uses the quietest
10 ms bin instead.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ai_clipper.edit_v2 import COMPILER_ID, PACK_DEFAULT_OVERRIDES, RENDER_SEMANTICS
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.clip_id import clip_id
from ai_clipper.edit_v2.plan import RenderPlan
from ai_clipper.edit_v2.timemap import Fps

ROOT = Path(__file__).resolve().parents[2]
DOC_FIXTURES_DIR = ROOT / "tests" / "fixtures" / "edit_v2" / "docs"
INDEX_SCHEMA = "potongin.edit-v2-doc-fixtures/1"
CONTEXT_IDS = ("c30", "c25", "c24")
MAX_DOC_BYTES = 1 << 20
CREATED_AT_MS = 1_790_000_000_000
EDITED_AT_MS = 1_790_000_060_000
PUT_NOW_MS = 1_790_000_120_000  # "now_ms" for the PUT classification of the fixtures


# --- hashing and encoding (plan §3.1) ----------------------------------------------------------


def canonical_bytes(value: Any) -> bytes:
    """``json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`` as UTF-8."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def etag(doc: Mapping) -> str:
    """The document ETag: sha256 of its canonical bytes."""
    return sha256_hex(canonical_bytes(doc))


def _tag(label: str) -> str:
    return sha256_hex(label.encode())


# --- assets --------------------------------------------------------------------------------------

LOGO = "sha256:" + _tag("fixture-logo-square")
LOGO_WIDE = "sha256:" + _tag("fixture-logo-wide")
MUSIC = "sha256:" + _tag("fixture-music-long")
MUSIC_SHORT = "sha256:" + _tag("fixture-music-short")
LOGO_NOT_IN_STORE = "sha256:" + _tag("fixture-logo-not-in-store")


def asset_store() -> dict[str, dict[str, Any]]:
    """The fixture job's asset store metadata in document form (plan §3.2 ``assets``)."""
    return {
        LOGO: {"kind": "image", "mime": "image/png", "w": 512, "h": 512},
        LOGO_WIDE: {"kind": "image", "mime": "image/png", "w": 800, "h": 200},
        MUSIC: {"kind": "audio", "mime": "audio/mp4", "duration_ms": 142_000, "lufs_c": -1620},
        MUSIC_SHORT: {"kind": "audio", "mime": "audio/mp4", "duration_ms": 20_000,
                      "lufs_c": -1400},
    }


# --- contexts ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ContextSpec:
    id: str
    fps: tuple[int, int]
    output: tuple[int, int]
    source_w: int
    source_h: int
    fps_native: tuple[int, int]
    duration_ms: int
    start_ms: int
    end_ms: int
    cold_open_ms: tuple[int, int] | None
    pack: str
    layout: str
    hook_text: str | None
    hook_duration_s: float
    job_id: str
    rank: int
    selection_source: str
    word_offset: int
    unit_offset: int
    has_sound_events: bool = True

    @property
    def source_sha(self) -> str:
        return _tag(f"fixture-source-{self.id}")

    @property
    def window_ms(self) -> tuple[int, int]:
        starts = [self.start_ms] + ([self.cold_open_ms[0]] if self.cold_open_ms else [])
        ends = [self.end_ms] + ([self.cold_open_ms[1]] if self.cold_open_ms else [])
        return max(0, min(starts) - 60_000), min(self.duration_ms, max(ends) + 60_000)


SPECS = {
    "c30": ContextSpec(
        id="c30", fps=(30000, 1001), output=(720, 1280), source_w=1280, source_h=720,
        fps_native=(30000, 1001), duration_ms=3_901_120, start_ms=1_241_930,
        end_ms=1_309_400, cold_open_ms=(1_275_200, 1_279_700), pack="karaoke",
        layout="fit_blur", hook_text="Dia ditahan security di film-nya sendiri",
        hook_duration_s=4.0, job_id="8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", rank=3,
        selection_source="llm", word_offset=48_100, unit_offset=400,
    ),
    "c25": ContextSpec(
        id="c25", fps=(25, 1), output=(720, 1280), source_w=1920, source_h=1080,
        fps_native=(50, 1), duration_ms=2_400_000, start_ms=600_000, end_ms=800_000,
        cold_open_ms=None, pack="classic", layout="camera", hook_text=None,
        hook_duration_s=4.0, job_id="2b7d4c1a-9e0f-4a6b-8c3d-5e7f9a1b2c3d", rank=1,
        selection_source="heuristic", word_offset=12_000, unit_offset=150,
        has_sound_events=False,
    ),
    "c24": ContextSpec(
        id="c24", fps=(24000, 1001), output=(1080, 1920), source_w=1280, source_h=720,
        fps_native=(24000, 1001), duration_ms=100_000, start_ms=45_120, end_ms=90_000,
        cold_open_ms=(62_400, 64_900), pack="karaoke", layout="fill_center",
        hook_text="Kenapa semua orang ketawa?", hook_duration_s=3.5,
        job_id="5c9e1d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f", rank=2, selection_source="llm",
        word_offset=900, unit_offset=12,
    ),
}

VOCAB = (
    "jadi", "gue", "waktu", "itu", "lagi", "syuting", "terus", "security", "nahan", "di",
    "pintu", "masuk", "katanya", "bukan", "kru", "padahal", "film", "sendiri", "beneran",
    "sumpah", "nggak", "tahu", "kenapa", "pokoknya", "orang", "semua", "ketawa", "kita",
    "langsung", "pulang", "abis", "pas", "mau", "ambil", "kopi", "ternyata", "dia", "juga",
    "sama", "aja", "eh", "anu", "sih", "dong", "mah", "hati", "pelan", "kok",
)


def _nearest_boundary(ms_twice: int, fps: Fps) -> int:
    """Frame boundary nearest ``ms_twice / 2`` ms (ties go to the earlier boundary).

    With ``x = ms·num / (1000·den)`` that is ``⌈x − ½⌉ = −round_half_up(−x)``.
    """
    return -tm.div_round_half_up(-ms_twice * fps.num, 2000 * fps.den)


def _bound(a_end: int, b_start: int, fps: Fps, clamp: tuple[int, int]) -> tuple[int, bool]:
    """Frame boundary for a cut between ``a_end`` and ``b_start`` (fixture rule, see module)."""
    if b_start >= a_end:
        first = tm.sf_ceil(a_end, fps)
        last = tm.sf_floor(b_start, fps)
        if first <= last:
            centre_twice = a_end + b_start
            best = min(
                range(first, last + 1),
                key=lambda k: (abs(2 * k * 1000 * fps.den - centre_twice * fps.num), k),
            )
            return best, False
        return _nearest_boundary(a_end + b_start, fps), True
    k = _nearest_boundary(a_end + b_start, fps)
    low, high = tm.sf_ceil(clamp[0], fps), tm.sf_floor(clamp[1], fps)
    return min(max(k, low), high), True


def build_words(spec: ContextSpec) -> dict[str, Any]:
    """The context's ``potongin.words/1`` artifact (plan §3.6)."""
    rng = random.Random(f"words:{spec.id}")
    fps = Fps(*spec.fps)
    start, stop = spec.window_ms
    raw: list[dict[str, Any]] = []
    units: list[dict[str, Any]] = []
    long_gaps: list[tuple[int, int]] = []
    t = start + 250
    unit_number = spec.unit_offset
    done = False
    while not done:
        count = rng.randint(4, 9)
        question = rng.random() < 0.2
        unit_id = f"S{unit_number:04d}"
        members = []
        for _ in range(count):
            duration = rng.randint(180, 420)
            if t + duration > stop - 250:
                done = True
                break
            members.append({"s": t, "e": t + duration, "t": rng.choice(VOCAB), "u": unit_id})
            t += duration + rng.randint(40, 160)
        if not members:
            break
        members[-1]["t"] += "?" if question else "."
        units.append({"id": unit_id, "s": members[0]["s"], "e": members[-1]["e"],
                      "q": question})
        raw.extend(members)
        unit_number += 1
        gap = rng.choice((rng.randint(250, 550), rng.randint(650, 1500)))
        t = members[-1]["e"] + gap
        if gap > 600:
            long_gaps.append((members[-1]["e"], t))

    body_in = tm.sf_floor(spec.start_ms, fps)
    # First word whose midpoint is at least 5 s after the body start.
    first_body = next(
        i for i, word in enumerate(raw)
        if (word["s"] + word["e"]) * fps.num >= 2 * 1000 * fps.den * body_in + 10_000 * fps.num
    )
    # Special cases inside the body, away from its first seconds.
    zero = first_body + 3
    raw[zero]["e"] = raw[zero]["s"]
    tight = first_body + 10
    boundary = tm.sf_ceil(raw[tight]["e"], fps)
    raw[tight]["e"] = boundary * 1000 * fps.den // fps.num + 3  # 3 ms after a frame start
    raw[tight + 1]["s"] = raw[tight]["e"] + 12
    raw[tight + 1]["e"] = max(raw[tight + 1]["e"], raw[tight + 1]["s"] + 150)
    overlap = first_body + 17
    raw[overlap + 1]["s"] = raw[overlap]["e"] - 30
    raw[first_body + 24]["t"] = "wkwk"
    raw[first_body + 5]["t"] = "eh"
    raw[first_body + 6]["t"] = "sih"
    for position in range(1, len(raw)):
        if raw[position]["s"] < raw[position - 1]["s"]:
            raise AssertionError("fixture words must stay in start order")

    words = []
    for index, word in enumerate(raw):
        entry = {
            "id": f"w{spec.word_offset + index:06d}",
            "s": word["s"],
            "e": word["e"],
            "t": word["t"],
            "p_pm": None if index % 23 == 7 else rng.randint(300, 990),
            "u": word["u"],
            "z": False,
        }
        if entry["e"] == entry["s"]:
            following = raw[index + 1]["s"] if index + 1 < len(raw) else entry["s"] + 80
            entry["e"] = min(entry["s"] + 80, following)
            entry["z"] = True
        words.append(entry)

    events: list[dict[str, Any]] = []
    silences: list[list[int]] = []
    body_gaps = [gap for gap in long_gaps if gap[0] > raw[first_body + 30]["e"]]
    laugh_gap = body_gaps[0] if spec.has_sound_events else None
    if laugh_gap is not None:
        point = (laugh_gap[0] + laugh_gap[1]) // 2
        events.append({"kind": "laughter", "s": point, "e": point, "src": "yt-caption"})
    for word in words:
        if word["t"].rstrip(".?") == "wkwk":
            events.append({"kind": "laughter", "s": word["s"], "e": word["e"],
                           "src": "transcript"})
    for index, gap in enumerate(long_gaps):
        if gap != laugh_gap and index % 2 == 0:
            silences.append([gap[0] + 40, gap[1] - 40])
    events.sort(key=lambda item: (item["s"], item["e"], item["src"]))

    bounds = []
    edge, _tight = _bound(start, words[0]["s"], fps, (start, words[0]["e"]))
    bounds.append({"after": None, "before": words[0]["id"], "sf": edge, "tight": _tight,
                   "rms_cdb": -6000})
    gaps = []
    for index in range(len(words) - 1):
        a, b = words[index], words[index + 1]
        sf, is_tight = _bound(a["e"], b["s"], fps, (a["s"], b["e"]))
        bounds.append({"after": a["id"], "before": b["id"], "sf": sf, "tight": is_tight,
                       "rms_cdb": -6500 + (index * 37) % 1500})
        if b["s"] - a["e"] > 600:
            gaps.append({"after": a["id"], "s": a["e"], "e": b["s"],
                         "class": _gap_class(a["e"], b["s"], events, silences)})
    edge, _tight = _bound(words[-1]["e"], stop, fps, (words[-1]["s"], stop))
    bounds.append({"after": words[-1]["id"], "before": None, "sf": edge, "tight": _tight,
                   "rms_cdb": -6000})
    peaks_sha = _tag(f"fixture-peaks-{spec.id}")
    return {
        "schema": "potongin.words/1",
        "clip_id": _clip_id(spec),
        "transcript_sha256": _tag(f"fixture-transcript-{spec.id}"),
        "fps": list(spec.fps),
        "window_ms": list(spec.window_ms),
        "words": words,
        "units": units,
        "bounds": bounds,
        "gaps": gaps,
        "events": events,
        "silences": silences,
        "scene_cuts_ms": [start + 30_000, start + 95_000],
        "peaks": {"file": f"peaks.{peaks_sha[:16]}.bin", "per_sec": 100, "start_ms": start},
        "missing": [] if spec.has_sound_events else ["sound_events"],
    }


def _gap_class(s: int, e: int, events: list[dict], silences: list[list[int]]) -> str:
    if any(event["s"] <= e + 500 and event["e"] >= s - 500 for event in events):
        return "laughter"
    covered = sum(max(0, min(e, b) - max(s, a)) for a, b in silences)
    return "silent" if covered * 5 >= (e - s) * 4 else "voiced"


def _clip_id(spec: ContextSpec) -> str:
    return clip_id(spec.source_sha, spec.start_ms, spec.end_ms, spec.cold_open_ms)


def _hook_track(text: str, dur_f: int, *, y_e5: int = 13000, origin: str = "seed",
                design: tuple[str, int] = ("legacy-bar", 1)) -> dict[str, Any]:
    return {
        "id": "tr_hook",
        "kind": "hook",
        "items": [
            {
                "id": "it_hook",
                "type": "hook",
                "start": {"at": "out", "f": 0},
                "dur_f": dur_f,
                "transform": {"x_e5": 50000, "y_e5": y_e5},
                "payload": {"text": text, "design": {"id": design[0], "v": design[1]}},
                "origin": origin,
            }
        ],
    }


def build_seed(spec: ContextSpec, words: Mapping[str, Any]) -> dict[str, Any]:
    """Revision 0 of the context clip, following the plan §3.5 table."""
    fps = Fps(*spec.fps)
    segments = []
    joins = []
    if spec.cold_open_ms is not None:
        segments.append({"id": "seg_co", "role": "cold_open",
                         "in_sf": tm.sf_floor(spec.cold_open_ms[0], fps),
                         "out_sf": tm.sf_ceil(spec.cold_open_ms[1], fps)})
        joins.append({"after": "seg_co", "style": "cut", "audio_fade_ms": 30})
    segments.append({"id": "seg_b1", "role": "body", "in_sf": tm.sf_floor(spec.start_ms, fps),
                     "out_sf": tm.sf_ceil(spec.end_ms, fps)})
    tracks = []
    if spec.hook_text is not None:
        # dur_f = round_half_up(hook_duration · F)
        dur_f = tm.div_round_half_up(round(spec.hook_duration_s * 1000) * fps.num,
                                     1000 * fps.den)
        tracks.append(_hook_track(spec.hook_text, dur_f))
    co_start = spec.cold_open_ms[0] if spec.cold_open_ms else spec.start_ms
    hook_unit = next(
        unit["id"] for unit in words["units"] if unit["e"] >= co_start
    )
    seed = {
        "schema": "clip-edit-v2",
        "schema_minor": 0,
        "clip_id": _clip_id(spec),
        "revision": 0,
        "parent_sha256": None,
        "base": {
            "job_id": spec.job_id,
            "source": {
                "content_sha256": spec.source_sha,
                "w": spec.source_w,
                "h": spec.source_h,
                "fps_native": list(spec.fps_native),
                "vfr": False,
                "duration_ms": spec.duration_ms,
                "has_audio": True,
            },
            "origin": {
                "kind": "v3_clip",
                "selection_artifact_sha256": _tag(f"fixture-selection-{spec.id}"),
                "selection_version": "selection-v3.0",
                "rank_at_seed": spec.rank,
                "hook_unit_id": hook_unit,
                "selection_source": spec.selection_source,
            },
            "window_ms": list(spec.window_ms),
            "words": {"sha256": sha256_hex(canonical_bytes(words)), "count": len(words["words"])},
            "camera": {"sha256": _tag(f"fixture-camera-{spec.id}")
                       if spec.layout == "camera" else None},
            "seed_sha256": None,
            "engine": {"compiler": COMPILER_ID, "render_semantics": RENDER_SEMANTICS},
        },
        "output": {"w": spec.output[0], "h": spec.output[1], "fps": list(spec.fps),
                   "sample_rate": 48000, "channels": 2},
        "main": {"segments": segments, "removals": [], "joins": joins, "cut_fade_ms": 8},
        "captions": {
            "enabled": True,
            "pack": {"id": spec.pack, "v": 1},
            "overrides": dict(PACK_DEFAULT_OVERRIDES[spec.pack]),
            "word_edits": {},
        },
        "layout": {"default": {"mode": spec.layout, "no_face": "center"}},
        "tracks": tracks,
        "audio": {"source": {"gain_cdb": 0},
                  "master": {"mode": "off", "target_clufs": -1400, "tp_cdb": -100}},
        "assets": {},
        "audit": {"created_at_ms": CREATED_AT_MS, "updated_at_ms": CREATED_AT_MS,
                  "editor": "pipeline/edit-v2/1", "last_command": "Seed"},
    }
    # base.seed_sha256: sha256 of the seed's canonical bytes with this field set to null.
    seed["base"]["seed_sha256"] = sha256_hex(canonical_bytes(seed))
    return seed


@dataclass(frozen=True)
class Context:
    id: str
    words: dict[str, Any]
    seed: dict[str, Any]
    assets: dict[str, dict[str, Any]]

    @property
    def fps(self) -> Fps:
        return Fps.from_json(self.seed["output"]["fps"])


def build_context(context_id: str) -> Context:
    spec = SPECS[context_id]
    words = build_words(spec)
    return Context(context_id, words, build_seed(spec, words), asset_store())


# --- document helpers ------------------------------------------------------------------------------


class _Doc:
    """Mutation helpers over a deep copy of a context's revision-1 document."""

    def __init__(self, context: Context, last_command: str = "ResetToSeed") -> None:
        self.context = context
        self.fps = context.fps
        self.doc = copy.deepcopy(context.seed)
        self.doc["revision"] = 1
        self.doc["parent_sha256"] = etag(context.seed)
        self.doc["audit"].update(updated_at_ms=EDITED_AT_MS, editor="editor-v3/1.0.0",
                                 last_command=last_command)
        self.words = context.words["words"]
        self.bounds = context.words["bounds"]
        self.before = {b["before"]: b for b in self.bounds if b["before"] is not None}
        self.after = {b["after"]: b for b in self.bounds if b["after"] is not None}

    # segments
    def segment(self, seg_id: str) -> dict[str, Any]:
        return next(s for s in self.doc["main"]["segments"] if s["id"] == seg_id)

    @property
    def body(self) -> dict[str, Any]:
        return self.segment("seg_b1")

    def body_words(self, seg_id: str = "seg_b1") -> list[dict[str, Any]]:
        segment = self.context.seed["main"]["segments"]
        span = next(s for s in segment if s["id"] == seg_id)
        lo = 2 * span["in_sf"] * 1000 * self.fps.den
        hi = 2 * span["out_sf"] * 1000 * self.fps.den
        return [w for w in self.words if lo <= (w["s"] + w["e"]) * self.fps.num < hi]

    def window_sf(self) -> tuple[int, int]:
        a, b = self.doc["base"]["window_ms"]
        return tm.sf_floor(a, self.fps), tm.sf_ceil(b, self.fps)

    def set_cold_open(self, in_sf: int | None, out_sf: int | None = None) -> None:
        main = self.doc["main"]
        main["segments"] = [s for s in main["segments"] if s["role"] != "cold_open"]
        main["joins"] = []
        main["removals"] = [r for r in main["removals"] if r["seg"] != "seg_co"]
        if in_sf is not None:
            main["segments"].insert(0, {"id": "seg_co", "role": "cold_open", "in_sf": in_sf,
                                        "out_sf": out_sf})
            main["joins"] = [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}]

    # removals
    def remove_words(self, ids: Sequence[str], *, seg: str = "seg_b1", reason: str = "user",
                     origin: str = "user") -> dict[str, Any]:
        removal = {
            "id": f"rm_{len(self.doc['main']['removals']) + 1}",
            "seg": seg,
            "in_sf": self.before[ids[0]]["sf"],
            "out_sf": self.after[ids[-1]]["sf"],
            "words": list(ids),
            "reason": reason,
            "origin": origin,
        }
        return self.add_removal(removal)

    def add_removal(self, removal: dict[str, Any]) -> dict[str, Any]:
        removals = self.doc["main"]["removals"]
        removals.append(removal)
        removals.sort(key=lambda item: (item["seg"], item["in_sf"]))
        return removal

    def gap_removal(self, in_sf: int, out_sf: int, *, seg: str = "seg_b1",
                    origin: str = "suggestion:cl_1") -> dict[str, Any]:
        return self.add_removal({
            "id": f"rm_{len(self.doc['main']['removals']) + 1}", "seg": seg, "in_sf": in_sf,
            "out_sf": out_sf, "words": [], "reason": "gap_silent", "origin": origin,
        })

    # tracks
    def hook(self) -> dict[str, Any]:
        return next(t for t in self.doc["tracks"] if t["kind"] == "hook")["items"][0]

    def set_hook(self, text: str, dur_f: int = 120, **kwargs: Any) -> None:
        self.doc["tracks"] = [t for t in self.doc["tracks"] if t["kind"] != "hook"]
        self.doc["tracks"].insert(0, _hook_track(text, dur_f, **kwargs))

    def add_logo(self, asset: str = LOGO, *, x_e5: int = 88000, y_e5: int = 7000,
                 w_e5: int = 16000, opacity_pm: int = 850) -> dict[str, Any]:
        item = {
            "id": "it_logo", "type": "image", "start": {"at": "clip_start"},
            "end": {"at": "clip_end"},
            "transform": {"x_e5": x_e5, "y_e5": y_e5, "w_e5": w_e5, "opacity_pm": opacity_pm},
            "payload": {"asset": asset, "mode": "free"}, "origin": "user",
        }
        self.doc["tracks"].append({"id": "tr_ovr", "kind": "visual", "band": "over_text",
                                   "role": "overlay", "items": [item]})
        if asset in self.context.assets:
            self.doc["assets"][asset] = dict(self.context.assets[asset])
        return item

    def add_music(self, asset: str = MUSIC, **payload: Any) -> dict[str, Any]:
        body = {
            "asset": asset, "src_in_smp": 0, "loop": True, "gain_cdb": -1000, "fade_in_f": 15,
            "fade_out_f": 30,
            "duck": {"on": True, "depth_cdb": 1000, "attack_ms": 30, "release_ms": 400,
                     "hold_ms": 250, "detector": "words"},
        }
        duck = payload.pop("duck", {})
        body.update(payload)
        body["duck"].update(duck)
        item = {"id": "it_music", "type": "audio", "start": {"at": "clip_start"},
                "end": {"at": "clip_end"}, "payload": body, "origin": "user"}
        self.doc["tracks"].append({"id": "tr_mus", "kind": "audio", "role": "music",
                                   "items": [item]})
        if asset in self.context.assets:
            self.doc["assets"][asset] = dict(self.context.assets[asset])
        return item


# --- fixture definitions -------------------------------------------------------------------------


@dataclass
class _Fixture:
    name: str  # file stem
    context: str
    check: str  # "put" | "validate"
    doc: dict[str, Any] | None = None
    raw: bytes | None = None
    code: str | None = None
    path: str | None = None
    warnings: tuple[str, ...] = ()
    compact: bool = False
    ascii: bool = False
    replace: tuple[tuple[str, str], ...] = field(default_factory=tuple)

    def render(self) -> bytes:
        if self.raw is not None:
            return self.raw
        if self.compact:
            text = json.dumps(self.doc, separators=(",", ":"), ensure_ascii=self.ascii)
        else:
            text = json.dumps(self.doc, indent=2, ensure_ascii=self.ascii)
        for old, new in self.replace:
            if old not in text:
                raise AssertionError(f"{self.name}: {old!r} not found")
            text = text.replace(old, new, 1)
        return (text + "\n").encode("utf-8", "surrogatepass")


def _pretty(doc: Mapping) -> bytes:
    return (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _valid(contexts: Mapping[str, Context]) -> list[_Fixture]:
    c30, c25, c24 = contexts["c30"], contexts["c25"], contexts["c24"]
    out: list[_Fixture] = []

    def add(name: str, builder: _Doc, warnings: tuple[str, ...] = (), **kwargs: Any) -> None:
        out.append(_Fixture(f"{name}__{builder.context.id}", builder.context.id, "put",
                            doc=builder.doc, warnings=warnings, **kwargs))

    for context in (c30, c25, c24):
        out.append(_Fixture(f"seed__{context.id}", context.id, "validate", doc=context.seed))
        add("rev1_unchanged", _Doc(context))

    d = _Doc(c30, "TrimStart")
    d.body["in_sf"] = d.before[d.body_words()[4]["id"]]["sf"]
    add("trim_start_later", d)
    d = _Doc(c30, "TrimEnd")
    d.body["out_sf"] = d.after[d.body_words()[-6]["id"]]["sf"]
    add("trim_end_earlier", d)
    d = _Doc(c30, "TrimEnd")
    d.body["out_sf"] = d.body["in_sf"] + tm.sf_ceil(3000, d.fps)
    add("body_min_3s", d)
    d = _Doc(c25, "TrimStart")
    low, high = d.window_sf()
    d.body["in_sf"], d.body["out_sf"] = high - tm.sf_floor(300_000, d.fps), high
    add("body_max_300s", d)
    d = _Doc(c30, "NudgeColdOpen")
    co = d.segment("seg_co")
    co["out_sf"] = co["in_sf"] + tm.sf_ceil(500, d.fps)
    add("cold_open_min", d)
    d = _Doc(c30, "NudgeColdOpen")
    co = d.segment("seg_co")
    co["out_sf"] = co["in_sf"] + tm.sf_floor(8000, d.fps)
    add("cold_open_max", d)
    d = _Doc(c30, "SetColdOpen")
    d.set_cold_open(None)
    add("cold_open_removed", d)
    d = _Doc(c25, "SetColdOpen")
    words = d.body_words()
    d.set_cold_open(d.before[words[60]["id"]]["sf"], d.after[words[66]["id"]]["sf"])
    add("cold_open_added", d)
    d = _Doc(c24, "SetColdOpen")
    low, _high = d.window_sf()
    d.set_cold_open(low + 200, low + 290)
    add("cold_open_before_body", d)
    for value in (0, 250):
        d = _Doc(c30, "SetColdOpen")
        d.doc["main"]["joins"][0]["audio_fade_ms"] = value
        add(f"join_fade_{value}", d)
    for value in (0, 50):
        d = _Doc(c30, "RemoveWords")
        d.doc["main"]["cut_fade_ms"] = value
        d.remove_words([w["id"] for w in d.body_words()[40:42]])
        add(f"cut_fade_{value}", d)
    d = _Doc(c30, "RemoveWords")
    d.remove_words([w["id"] for w in d.body_words()[40:42]])
    add("removal_single", d)
    d = _Doc(c30, "RemoveWords")
    for first in (40, 55, 70, 90, 120):
        d.remove_words([w["id"] for w in d.body_words()[first : first + 3]])
    add("removals_many", d)
    d = _Doc(c30, "RemoveGap")
    body = d.body
    d.gap_removal(body["in_sf"], body["in_sf"] + 20, origin="user")
    add("removal_at_body_start", d)
    d = _Doc(c30, "RemoveGap")
    d.gap_removal(d.body["out_sf"] - 25, d.body["out_sf"], origin="user")
    add("removal_at_body_end", d)
    d = _Doc(c30, "RemoveWords")
    co_words = d.body_words("seg_co")
    d.remove_words([co_words[len(co_words) // 2]["id"]], seg="seg_co")
    add("removal_in_cold_open", d)
    d = _Doc(c30, "RemoveGap")
    start = d.after[d.body_words()[80]["id"]]["sf"]
    d.gap_removal(start, start + 10)
    d.gap_removal(start + 11, start + 30)  # leaves a 1-frame sliver, which joins the cut
    add("removal_leaves_sliver", d)
    d = _Doc(c30, "ApplyCleanup")
    for word in d.body_words()[100:160:12]:
        sf = d.after[word["id"]]["sf"]
        d.gap_removal(sf - 2, sf + 2, origin="suggestion:cl_7")
    add("removals_gap_silent", d)
    d = _Doc(c25, "ApplyCleanup")
    body = d.body
    for index in range(2000):
        d.doc["main"]["removals"].append({
            "id": f"rm_{index + 1}", "seg": "seg_b1", "in_sf": body["in_sf"] + 2 * index,
            "out_sf": body["in_sf"] + 2 * index + 1, "words": [], "reason": "gap_silent",
            "origin": "suggestion:cl_1"})
    add("removals_max_2000", d, compact=True)
    d = _Doc(c30, "SetCaptionsEnabled")
    d.doc["captions"]["enabled"] = False
    add("captions_disabled", d)
    for pack in ("classic", "bold", "box"):
        d = _Doc(c30, "SetCaptionPack")
        d.doc["captions"]["pack"]["id"] = pack
        add(f"pack_{pack}", d)
    d = _Doc(c30, "SetCaptionOverride")
    d.doc["captions"]["overrides"].update(y_e5=20000, size_pm=700)
    add("overrides_min", d)
    d = _Doc(c30, "SetCaptionOverride")
    d.doc["captions"]["overrides"].update(y_e5=92000, size_pm=1400, case="upper")
    add("overrides_max", d)
    d = _Doc(c30, "SetCaptionOverride")
    d.doc["captions"]["overrides"].update(highlight="#3DF5A6", emphasis="#52C7FF")
    add("swatches_green_blue", d)
    d = _Doc(c30, "SetCaptionOverride")
    d.doc["captions"]["overrides"].update(highlight="#FFFFFF", emphasis="#FF9F1C")
    add("swatches_white_orange", d)
    d = _Doc(c30, "EditWordText")
    ids = [w["id"] for w in d.body_words()[20:24]]
    d.doc["captions"]["word_edits"] = {
        ids[0]: {"text": "Ijal"}, ids[1]: {"hidden": True}, ids[2]: {"emphasis": True},
        ids[3]: {"text": "SECURITY", "hidden": False, "emphasis": True},
    }
    add("word_edits", d)
    d = _Doc(c30, "EditWordText")
    d.doc["captions"]["word_edits"] = {d.body_words()[25]["id"]: {"text": "Kafé"}}
    add("word_edit_unicode", d)
    for mode in ("camera", "fill_center"):
        d = _Doc(c30, "SetLayout")
        d.doc["layout"]["default"]["mode"] = mode
        add(f"layout_{mode}", d)
    d = _Doc(c30, "SetHookEnabled")
    d.doc["tracks"] = []
    add("hook_removed", d)
    for name, dur_f in (("hook_min_dur", 15), ("hook_max_dur", tm.sf_floor(30_000, c30.fps))):
        d = _Doc(c30, "SetHookDuration")
        d.hook()["dur_f"] = dur_f
        add(name, d)
    for name, y_e5 in (("hook_y_min", 6000), ("hook_y_max", 40000)):
        d = _Doc(c30, "SetHookY")
        d.hook()["transform"]["y_e5"] = y_e5
        add(name, d)
    d = _Doc(c30, "SetHookText")
    text = "Kata security aku bukan kru, padahal ini film aku sendiri, masa ditahan di pintu dulu?"
    text = text + "!" * (90 - len(text))
    assert len(text) == 90
    d.hook()["payload"]["text"] = text
    d.hook()["origin"] = "suggestion:sg_2"
    add("hook_text_90", d)
    d = _Doc(c25, "SetHookEnabled")
    d.set_hook("Pokoknya jangan pulang dulu", dur_f=100, origin="user")
    add("hook_added", d)
    d = _Doc(c30, "SetLogo")
    d.add_logo()
    add("logo", d)
    d = _Doc(c30, "SnapLogo")
    d.add_logo(x_e5=92000, y_e5=50000, w_e5=16000, opacity_pm=200)
    add("logo_edge", d)
    d = _Doc(c30, "ResizeLogo")
    d.add_logo(x_e5=50000, y_e5=50000, w_e5=4000, opacity_pm=1000)
    add("logo_min_size", d)
    d = _Doc(c24, "SetLogo")
    d.add_logo(LOGO_WIDE, x_e5=50000, y_e5=90000, w_e5=40000, opacity_pm=1000)
    add("logo_wide", d)
    d = _Doc(c30, "SetMusic")
    d.add_music()
    add("music", d)
    d = _Doc(c30, "SetMusicLoop")
    d.add_music(loop=False)
    add("music_no_loop_long_asset", d)
    d = _Doc(c30, "SetDuck")
    d.add_music(src_in_smp=142_000 * 48 - 1, gain_cdb=-4800,
                fade_in_f=tm.sf_floor(10_000, c30.fps), fade_out_f=0,
                duck={"depth_cdb": 2400, "attack_ms": 5, "release_ms": 2000, "hold_ms": 0})
    add("music_extremes", d)
    d = _Doc(c30, "SetDuck")
    d.add_music(gain_cdb=600, fade_in_f=0, fade_out_f=tm.sf_floor(10_000, c30.fps),
                duck={"on": False, "depth_cdb": 300, "attack_ms": 500, "release_ms": 50,
                      "hold_ms": 1000})
    add("music_duck_off", d)
    d = _Doc(c30, "SetMusicLoop")
    d.add_music(MUSIC_SHORT, loop=False)
    add("music_shorter_than_clip", d, warnings=("music_shorter_than_clip",))
    d = _Doc(c30, "SetMusic")
    d.add_logo()
    d.add_music()
    add("logo_and_music", d)
    for value in (-2400, 1200):
        d = _Doc(c30, "SetSourceGain")
        d.doc["audio"]["source"]["gain_cdb"] = value
        add(f"source_gain_{'min' if value < 0 else 'max'}", d)
    d = _Doc(c30, "SetLoudness")
    d.doc["audio"]["master"] = {"mode": "normalize", "target_clufs": -2400, "tp_cdb": -300}
    add("master_normalize_min", d)
    d = _Doc(c30, "SetLoudness")
    d.doc["audio"]["master"] = {"mode": "normalize", "target_clufs": -900, "tp_cdb": 0}
    add("master_normalize_max", d)
    d = _Doc(c30, "RemoveWords")
    d.doc["captions"]["pack"]["id"] = "bold"
    d.doc["captions"]["overrides"].update(case="upper", highlight="#FFE14D")
    words = d.body_words()
    d.remove_words([w["id"] for w in words[40:42]])
    d.remove_words([w["id"] for w in words[70:71]], reason="filler", origin="suggestion:cl_7")
    d.doc["captions"]["word_edits"] = {words[20]["id"]: {"text": "Ijal"},
                                       words[45]["id"]: {"emphasis": True},
                                       words[46]["id"]: {"hidden": True}}
    d.hook()["payload"]["text"] = "Dia ditahan security di film-nya sendiri"
    d.hook()["origin"] = "suggestion:sg_2"
    d.add_logo()
    d.add_music()
    add("full_example", d)
    d = _Doc(c30, "RemoveWords")
    tight_words = [w for w in d.body_words() if d.after[w["id"]]["tight"]]
    anchor = tight_words[0]
    index = [w["id"] for w in d.words].index(anchor["id"])
    d.remove_words([d.words[index - 1]["id"], anchor["id"]])
    add("tight_cut", d, warnings=("tight_cut",))
    d = _Doc(c30, "RemoveGap")
    point = next(e for e in c30.words["events"] if e["src"] == "yt-caption")["s"]
    sf = tm.sf_floor(point, d.fps)
    d.gap_removal(sf - 3, sf + 3, origin="user")
    add("laughter_cut", d, warnings=("laughter_cut",))
    return out


def _invalid(contexts: Mapping[str, Context]) -> list[_Fixture]:
    c30, c25 = contexts["c30"], contexts["c25"]
    out: list[_Fixture] = []

    def add(code: str, variant: str, path: str, builder: _Doc | None = None, *,
            raw: bytes | None = None, context: Context = c30, **kwargs: Any) -> None:
        name = f"{code}__{variant}" if variant else code
        doc = builder.doc if builder is not None else None
        ctx = builder.context if builder is not None else context
        out.append(_Fixture(name, ctx.id, "put", doc=doc, raw=raw, code=code, path=path,
                            **kwargs))

    def mutated(fn: Callable[[_Doc], Any], context: Context = c30,
                command: str = "ResetToSeed") -> _Doc:
        builder = _Doc(context, command)
        fn(builder)
        return builder

    base = _pretty(_Doc(c30).doc)
    edit_id = _Doc(c30).body_words()[20]["id"]  # the word every word-edit fixture edits
    edit_path = f"/captions/word_edits/{edit_id}"

    def word_edit(value: dict[str, Any]) -> Callable[[_Doc], None]:
        return lambda b: b.doc["captions"].update(word_edits={edit_id: value})

    # Parse level.
    add("invalid_json", "truncated", "", raw=base[: len(base) * 3 // 5])
    add("invalid_json", "not_utf8", "",
        raw=base.replace(b'"editor-v3/1.0.0"', b'"editor-v3/\xff1.0.0"', 1))
    add("invalid_json", "top_level_array", "", raw=b"[" + base.rstrip() + b"]\n")
    add("invalid_json", "trailing_data", "", raw=base + b"{}\n")
    add("invalid_json", "utf8_bom", "", raw=b"\xef\xbb\xbf" + base)
    add("float_not_allowed", "decimal", "/revision", _Doc(c30),
        replace=(('"revision": 1,', '"revision": 1.0,'),))
    add("float_not_allowed", "exponent", "/main/cut_fade_ms", _Doc(c30),
        replace=(('"cut_fade_ms": 8', '"cut_fade_ms": 8e0'),))
    add("float_not_allowed", "nan", "/audio/source/gain_cdb", _Doc(c30),
        replace=(('"gain_cdb": 0', '"gain_cdb": NaN'),))
    add("float_not_allowed", "infinity", "/audio/master/tp_cdb", _Doc(c30),
        replace=(('"tp_cdb": -100', '"tp_cdb": -Infinity'),))
    add("duplicate_key", "root", "/revision", _Doc(c30),
        replace=(('"revision": 1,', '"revision": 1,\n  "revision": 1,'),))
    add("duplicate_key", "nested", "/captions/overrides/size_pm", _Doc(c30),
        replace=(('"size_pm": 1000,', '"size_pm": 1000,\n      "size_pm": 1000,'),))
    add("unknown_key", "root", "/markers",
        mutated(lambda b: b.doc.update(markers=[])))
    add("unknown_key", "segment", "/main/segments/1/src",
        mutated(lambda b: b.body.update(src="S")))
    add("unknown_key", "layout_ranges", "/layout/ranges",
        mutated(lambda b: b.doc["layout"].update(ranges=[])))
    add("unknown_key", "overrides", "/captions/overrides/words_per_chunk",
        mutated(lambda b: b.doc["captions"]["overrides"].update(words_per_chunk=4)))
    add("unknown_key", "word_edit", f"{edit_path}/emoji_after",
        mutated(word_edit({"emoji_after": "1f602"})))
    add("unknown_key", "audio_source_mute", "/audio/source/mute",
        mutated(lambda b: b.doc["audio"]["source"].update(mute=[])))
    add("unknown_key", "hook_payload", "/tracks/0/items/0/payload/params",
        mutated(lambda b: b.hook()["payload"].update(params={})))
    add("too_large", "", "", raw=base + b" " * (MAX_DOC_BYTES + 1 - len(base)))
    add("not_nfc", "hook_text", "/tracks/0/items/0/payload/text",
        mutated(lambda b: b.hook()["payload"].update(text="Kafé di film sendiri")))
    add("not_nfc", "word_edit", f"{edit_path}/text", mutated(word_edit({"text": "Café"})))
    add("control_char", "hook_text", "/tracks/0/items/0/payload/text",
        mutated(lambda b: b.hook()["payload"].update(text="Dia ditahan\u0007 security")))
    add("control_char", "editor", "/audit/editor",
        mutated(lambda b: b.doc["audit"].update(editor="editor-v3\u0000")))
    add("control_char", "lone_surrogate", f"{edit_path}/text",
        mutated(word_edit({"text": "a\ud800b"})), ascii=True)
    add("schema_too_new", "", "/schema_minor",
        mutated(lambda b: b.doc.update(schema_minor=1)))

    # Semantic: base_changed.
    add("base_changed", "window", "/base/window_ms/0",
        mutated(lambda b: b.doc["base"]["window_ms"].__setitem__(0, b.doc["base"]["window_ms"][0]
                                                                 - 1000)))
    add("base_changed", "source", "/base/source/w",
        mutated(lambda b: b.doc["base"]["source"].update(w=1920)))
    add("base_changed", "output_fps", "/output/fps",
        mutated(lambda b: b.doc["output"].update(fps=[30, 1])))
    add("base_changed", "created_at", "/audit/created_at_ms",
        mutated(lambda b: b.doc["audit"].update(created_at_ms=CREATED_AT_MS + 1)))
    add("base_changed", "clip_id", "/clip_id",
        mutated(lambda b: b.doc.update(clip_id="clip_" + "0" * 24)))
    add("base_changed", "words_sha", "/base/words/sha256",
        mutated(lambda b: b.doc["base"]["words"].update(sha256=_tag("other-words"))))

    # outside_window.
    add("outside_window", "body_in", "/main/segments/1/in_sf",
        mutated(lambda b: b.body.update(in_sf=b.window_sf()[0] - 1)))
    add("outside_window", "body_out", "/main/segments/1/out_sf",
        mutated(lambda b: b.body.update(out_sf=b.window_sf()[1] + 1)))
    add("outside_window", "cold_open", "/main/segments/0/in_sf",
        mutated(lambda b: b.set_cold_open(b.window_sf()[0] - 5, b.window_sf()[0] + 131)))

    # range_invalid.
    def empty_removal(b: _Doc) -> None:
        sf = b.after[b.body_words()[40]["id"]]["sf"]
        b.gap_removal(sf, sf)

    add("range_invalid", "empty_removal", "/main/removals/0", mutated(empty_removal))
    add("range_invalid", "hook_text_too_long", "/tracks/0/items/0/payload/text",
        mutated(lambda b: b.hook()["payload"].update(text="a" * 91)))
    add("range_invalid", "hook_text_whitespace", "/tracks/0/items/0/payload/text",
        mutated(lambda b: b.hook()["payload"].update(text=" Dia ditahan security")))
    add("range_invalid", "word_edit_empty", f"{edit_path}/text", mutated(word_edit({"text": ""})))
    add("range_invalid", "word_edit_too_long", f"{edit_path}/text",
        mutated(word_edit({"text": "x" * 41})))
    add("range_invalid", "word_edit_no_keys", edit_path, mutated(word_edit({})))
    add("range_invalid", "word_edit_whitespace", f"{edit_path}/text",
        mutated(word_edit({"text": "Ijal "})))
    add("range_invalid", "word_edit_hidden_type", f"{edit_path}/hidden",
        mutated(word_edit({"hidden": 1})))
    for variant, key, value in (
        ("y_e5_low", "y_e5", 19999), ("y_e5_high", "y_e5", 92001),
        ("size_pm_low", "size_pm", 699), ("size_pm_high", "size_pm", 1401),
        ("case_value", "case", "title"), ("highlight_not_swatch", "highlight", "#123456"),
        ("highlight_lowercase", "highlight", "#ffe14d"),
        ("emphasis_not_string", "emphasis", 16751242),
    ):
        add("range_invalid", variant, f"/captions/overrides/{key}",
            mutated(lambda b, key=key, value=value: b.doc["captions"]["overrides"].update(
                {key: value})))
    add("range_invalid", "cut_fade_high", "/main/cut_fade_ms",
        mutated(lambda b: b.doc["main"].update(cut_fade_ms=51)))
    add("range_invalid", "join_fade_high", "/main/joins/0/audio_fade_ms",
        mutated(lambda b: b.doc["main"]["joins"][0].update(audio_fade_ms=251)))
    add("range_invalid", "source_gain_high", "/audio/source/gain_cdb",
        mutated(lambda b: b.doc["audio"]["source"].update(gain_cdb=1201)))
    add("range_invalid", "target_clufs", "/audio/master/target_clufs",
        mutated(lambda b: b.doc["audio"]["master"].update(target_clufs=-800)))
    add("range_invalid", "tp_positive", "/audio/master/tp_cdb",
        mutated(lambda b: b.doc["audio"]["master"].update(tp_cdb=1)))
    add("range_invalid", "master_mode", "/audio/master/mode",
        mutated(lambda b: b.doc["audio"]["master"].update(mode="auto")))
    add("range_invalid", "hook_dur_short", "/tracks/0/items/0/dur_f",
        mutated(lambda b: b.hook().update(dur_f=14)))
    add("range_invalid", "hook_dur_long", "/tracks/0/items/0/dur_f",
        mutated(lambda b: b.hook().update(dur_f=tm.sf_floor(30_000, b.fps) + 1)))
    add("range_invalid", "hook_y_low", "/tracks/0/items/0/transform/y_e5",
        mutated(lambda b: b.hook()["transform"].update(y_e5=5999)))
    add("range_invalid", "hook_x", "/tracks/0/items/0/transform/x_e5",
        mutated(lambda b: b.hook()["transform"].update(x_e5=49000)))

    def logo(**transform: int) -> Callable[[_Doc], None]:
        def apply(b: _Doc) -> None:
            b.add_logo()["transform"].update(transform)
        return apply

    add("range_invalid", "logo_w_small", "/tracks/1/items/0/transform/w_e5",
        mutated(logo(w_e5=3999)))
    add("range_invalid", "logo_opacity", "/tracks/1/items/0/transform/opacity_pm",
        mutated(logo(opacity_pm=199)))

    def music(**payload: Any) -> Callable[[_Doc], None]:
        return lambda b: b.add_music(**payload)

    add("range_invalid", "music_gain", "/tracks/1/items/0/payload/gain_cdb",
        mutated(music(gain_cdb=-4801)))
    add("range_invalid", "duck_depth", "/tracks/1/items/0/payload/duck/depth_cdb",
        mutated(music(duck={"depth_cdb": 299})))
    add("range_invalid", "duck_attack", "/tracks/1/items/0/payload/duck/attack_ms",
        mutated(music(duck={"attack_ms": 4})))
    add("range_invalid", "music_fade", "/tracks/1/items/0/payload/fade_in_f",
        mutated(music(fade_in_f=tm.sf_floor(10_000, c30.fps) + 1)))
    add("range_invalid", "src_in_smp", "/tracks/1/items/0/payload/src_in_smp",
        mutated(music(src_in_smp=142_000 * 48)))

    def removal_with(**fields: Any) -> Callable[[_Doc], None]:
        def apply(b: _Doc) -> None:
            b.remove_words([w["id"] for w in b.body_words()[40:42]]).update(fields)
        return apply

    add("range_invalid", "removal_reason", "/main/removals/0/reason",
        mutated(removal_with(reason="bogus")))
    add("range_invalid", "removal_origin", "/main/removals/0/origin",
        mutated(removal_with(origin="ai")))
    add("range_invalid", "word_id_format", "/main/removals/0/words/0",
        mutated(removal_with(words=["x1"])))
    add("range_invalid", "segment_id", "/main/segments/0/id",
        mutated(lambda b: b.body.update(id="Seg-1"), c25))
    add("range_invalid", "type_string", "/main/segments/1/in_sf",
        mutated(lambda b: b.body.update(in_sf=str(b.body["in_sf"]))))
    add("range_invalid", "missing_key", "/captions/enabled",
        mutated(lambda b: b.doc["captions"].pop("enabled")))
    add("range_invalid", "schema_name", "/schema",
        mutated(lambda b: b.doc.update(schema="clip-edit-v3")))
    add("range_invalid", "last_command", "/audit/last_command",
        mutated(lambda b: b.doc["audit"].update(last_command="Remove Words")))

    def duplicate_removal_id(b: _Doc) -> None:
        words = b.body_words()
        b.remove_words([words[40]["id"]])
        b.remove_words([words[50]["id"]])["id"] = "rm_1"

    add("range_invalid", "duplicate_id", "/main/removals/1/id", mutated(duplicate_removal_id))

    def too_many_removals(b: _Doc) -> None:
        body = b.body
        for index in range(2001):
            b.doc["main"]["removals"].append({
                "id": f"rm_{index + 1}", "seg": "seg_b1", "in_sf": body["in_sf"] + 2 * index,
                "out_sf": body["in_sf"] + 2 * index + 1, "words": [], "reason": "gap_silent",
                "origin": "suggestion:cl_1"})

    add("range_invalid", "removal_count", "/main/removals", mutated(too_many_removals, c25),
        compact=True)

    def asset_mime(b: _Doc) -> None:
        b.add_logo()
        b.doc["assets"][LOGO]["mime"] = "image/gif"

    add("range_invalid", "asset_mime", f"/assets/{LOGO}/mime", mutated(asset_mime))
    add("range_invalid", "asset_unreferenced", f"/assets/{MUSIC}",
        mutated(lambda b: b.doc["assets"].update({MUSIC: dict(c30.assets[MUSIC])})))
    add("range_invalid", "no_face", "/layout/default/no_face",
        mutated(lambda b: b.doc["layout"]["default"].update(no_face="left")))
    add("range_invalid", "layout_mode", "/layout/default/mode",
        mutated(lambda b: b.doc["layout"]["default"].update(mode="zoom")))
    add("range_invalid", "item_type_mismatch", "/tracks/0/items/0/type",
        mutated(lambda b: b.hook().update(type="image")))

    # cold_open_invalid.
    def co_length(frames: int) -> Callable[[_Doc], None]:
        def apply(b: _Doc) -> None:
            co = b.segment("seg_co")
            co["out_sf"] = co["in_sf"] + frames
        return apply

    add("cold_open_invalid", "too_short", "/main/segments/0",
        mutated(co_length(tm.sf_ceil(500, c30.fps) - 1)))
    add("cold_open_invalid", "too_long", "/main/segments/0",
        mutated(co_length(tm.sf_floor(8000, c30.fps) + 1)))
    add("cold_open_invalid", "same_start", "/main/segments/0",
        mutated(lambda b: b.set_cold_open(b.body["in_sf"], b.body["in_sf"] + 136)))
    add("cold_open_invalid", "repeats_opening", "/main/segments/0",
        mutated(lambda b: b.set_cold_open(b.body["in_sf"] + 1, b.body["in_sf"] + 137)))

    def not_first(b: _Doc) -> None:
        segments = b.doc["main"]["segments"]
        segments.reverse()

    add("cold_open_invalid", "not_first", "/main/segments/1", mutated(not_first))
    add("cold_open_invalid", "missing_join", "/main/joins",
        mutated(lambda b: b.doc["main"].update(joins=[])))
    add("cold_open_invalid", "join_without_cold_open", "/main/joins/0",
        mutated(lambda b: b.doc["main"].update(
            joins=[{"after": "seg_b1", "style": "cut", "audio_fade_ms": 30}]), c25))

    # duration_out_of_bounds.
    add("duration_out_of_bounds", "short", "/main/segments/1",
        mutated(lambda b: b.body.update(out_sf=b.body["in_sf"] + tm.sf_ceil(3000, b.fps) - 1)))

    def short_after_removal(b: _Doc) -> None:
        b.body["out_sf"] = b.body["in_sf"] + 100
        b.gap_removal(b.body["in_sf"] + 40, b.body["in_sf"] + 60, origin="user")

    add("duration_out_of_bounds", "removals", "/main/segments/1", mutated(short_after_removal))

    def too_long(b: _Doc) -> None:
        _low, high = b.window_sf()
        b.body.update(in_sf=high - tm.sf_floor(300_000, b.fps) - 1, out_sf=high)

    add("duration_out_of_bounds", "long", "/main/segments/0", mutated(too_long, c25))

    # removal_outside_segment / removal_overlap.
    add("removal_outside_segment", "past_end", "/main/removals/0",
        mutated(lambda b: b.gap_removal(b.body["out_sf"] - 10, b.body["out_sf"] + 1,
                                        origin="user")))
    add("removal_outside_segment", "before_start", "/main/removals/0",
        mutated(lambda b: b.gap_removal(b.body["in_sf"] - 1, b.body["in_sf"] + 10,
                                        origin="user")))

    def unknown_segment(b: _Doc) -> None:
        b.remove_words([w["id"] for w in b.body_words()[40:42]])["seg"] = "seg_zz"

    add("removal_outside_segment", "unknown_segment", "/main/removals/0/seg",
        mutated(unknown_segment))

    def overlapping(b: _Doc) -> None:
        start = b.after[b.body_words()[60]["id"]]["sf"]
        b.gap_removal(start, start + 20, origin="user")
        b.gap_removal(start + 10, start + 30, origin="user")

    add("removal_overlap", "overlapping", "/main/removals/1", mutated(overlapping))

    def unsorted(b: _Doc) -> None:
        start = b.after[b.body_words()[60]["id"]]["sf"]
        b.gap_removal(start, start + 10, origin="user")
        b.gap_removal(start + 40, start + 50, origin="user")
        b.doc["main"]["removals"].reverse()

    add("removal_overlap", "unsorted", "/main/removals/1", mutated(unsorted))

    # unknown_word.
    add("unknown_word", "removal", "/main/removals/0/words/1",
        mutated(removal_with(words=[_Doc(c30).body_words()[40]["id"], "w999999"])))
    add("unknown_word", "word_edit", "/captions/word_edits/w999998",
        mutated(lambda b: b.doc["captions"].update(word_edits={"w999998": {"hidden": True}})))

    # asset_missing.
    def logo_not_in_store(b: _Doc) -> None:
        b.add_logo(LOGO_NOT_IN_STORE)
        b.doc["assets"][LOGO_NOT_IN_STORE] = {"kind": "image", "mime": "image/png", "w": 512,
                                              "h": 512}

    add("asset_missing", "not_in_store", "/tracks/1/items/0/payload/asset",
        mutated(logo_not_in_store))

    def music_not_in_doc(b: _Doc) -> None:
        b.add_music()
        del b.doc["assets"][MUSIC]

    add("asset_missing", "not_in_doc_assets", "/tracks/1/items/0/payload/asset",
        mutated(music_not_in_doc))

    # pack_unknown.
    add("pack_unknown", "id", "/captions/pack",
        mutated(lambda b: b.doc["captions"]["pack"].update(id="neon")))
    add("pack_unknown", "version", "/captions/pack",
        mutated(lambda b: b.doc["captions"]["pack"].update(v=2)))

    # op_disabled.
    add("op_disabled", "join_style", "/main/joins/0/style",
        mutated(lambda b: b.doc["main"]["joins"][0].update(style="flash_white")))

    def second_hook(b: _Doc) -> None:
        track = copy.deepcopy(b.doc["tracks"][0])
        track["id"] = "tr_hook2"
        track["items"][0]["id"] = "it_hook2"
        b.doc["tracks"].append(track)

    add("op_disabled", "second_hook_track", "/tracks/1", mutated(second_hook))

    def two_logos(b: _Doc) -> None:
        item = b.add_logo()
        second = copy.deepcopy(item)
        second["id"] = "it_logo2"
        second["transform"]["x_e5"] = 12000
        b.doc["tracks"][-1]["items"].append(second)

    add("op_disabled", "two_items", "/tracks/1/items/1", mutated(two_logos))
    add("op_disabled", "text_track", "/tracks/1",
        mutated(lambda b: b.doc["tracks"].append({"id": "tr_txt", "kind": "text",
                                                  "items": []})))
    add("op_disabled", "hook_design", "/tracks/0/items/0/payload/design",
        mutated(lambda b: b.hook()["payload"].update(design={"id": "sticker-label", "v": 1})))
    add("op_disabled", "duck_detector", "/tracks/1/items/0/payload/duck/detector",
        mutated(music(duck={"detector": "rms"})))
    add("op_disabled", "layout_split", "/layout/default/mode",
        mutated(lambda b: b.doc["layout"]["default"].update(mode="split")))
    add("op_disabled", "removal_reason_gap_voiced", "/main/removals/0/reason",
        mutated(removal_with(reason="gap_voiced")))
    add("op_disabled", "case_lower", "/captions/overrides/case",
        mutated(lambda b: b.doc["captions"]["overrides"].update(case="lower")))
    add("op_disabled", "hook_start_offset", "/tracks/0/items/0/start",
        mutated(lambda b: b.hook().update(start={"at": "out", "f": 30})))

    def insert_segment(b: _Doc) -> None:
        body = b.body
        b.doc["main"]["segments"].append({"id": "seg_in", "role": "insert",
                                          "in_sf": body["in_sf"] + 100,
                                          "out_sf": body["in_sf"] + 200})

    add("op_disabled", "insert_segment", "/main/segments/1/role", mutated(insert_segment, c25))

    def word_anchor(b: _Doc) -> None:
        b.add_logo()["start"] = {"at": "word", "word": b.body_words()[20]["id"], "edge": "start"}

    add("op_disabled", "logo_word_anchor", "/tracks/1/items/0/start", mutated(word_anchor))

    # item_out_of_frame.
    add("item_out_of_frame", "right", "/tracks/1/items/0", mutated(logo(x_e5=95000)))
    add("item_out_of_frame", "top", "/tracks/1/items/0", mutated(logo(y_e5=1000)))

    # revision_mismatch / parent_mismatch.
    add("revision_mismatch", "skip", "/revision", mutated(lambda b: b.doc.update(revision=2)))
    add("revision_mismatch", "large", "/revision", mutated(lambda b: b.doc.update(revision=99)))
    add("parent_mismatch", "other_sha", "/parent_sha256",
        mutated(lambda b: b.doc.update(parent_sha256=_tag("some-other-revision"))))
    add("parent_mismatch", "null", "/parent_sha256",
        mutated(lambda b: b.doc.update(parent_sha256=None)))

    return out


# --- self-consistency checks (a partial validator for the fixture builder only) -------------------


def _check_semantics(doc: Mapping[str, Any], context: Context) -> set[str]:
    """Codes of the computational rules this builder can check; used to prove that every
    valid fixture passes them and every targeted invalid fixture violates exactly its rule."""
    codes: set[str] = set()
    fps = Fps.from_json(doc["output"]["fps"])
    window = doc["base"]["window_ms"]
    low, high = tm.sf_floor(window[0], fps), tm.sf_ceil(window[1], fps)
    segments = doc["main"]["segments"]
    try:
        pieces = tm.pieces(doc)
    except (TypeError, ValueError):
        return {"range_invalid"}
    for segment in segments:
        if segment["in_sf"] < low or segment["out_sf"] > high:
            codes.add("outside_window")
    body = [s for s in segments if s["role"] == "body"]
    if len(body) == 1:
        frames = sum(p.frames for p in pieces if p.seg == body[0]["id"])
        if not tm.sf_ceil(3000, fps) <= frames <= tm.sf_floor(300_000, fps):
            codes.add("duration_out_of_bounds")
    cold = [s for s in segments if s["role"] == "cold_open"]
    if cold:
        co = cold[0]
        frames = sum(p.frames for p in pieces if p.seg == co["id"])
        length = co["out_sf"] - co["in_sf"]
        if segments[0] is not co or not tm.sf_ceil(500, fps) <= frames <= tm.sf_floor(8000, fps):
            codes.add("cold_open_invalid")
        if body and abs(co["in_sf"] - body[0]["in_sf"]) < 1:
            codes.add("cold_open_invalid")
        if body:
            # Overlap with [body.in, body.in + length + 2F), rational end.
            end_num = (body[0]["in_sf"] + length) * fps.den + 2 * fps.num
            overlap_num = max(0, min(co["out_sf"] * fps.den, end_num)
                              - max(co["in_sf"], body[0]["in_sf"]) * fps.den)
            if 5 * overlap_num > 4 * length * fps.den:
                codes.add("cold_open_invalid")
        joins = doc["main"]["joins"]
        if len(joins) != 1 or joins[0]["after"] != co["id"]:
            codes.add("cold_open_invalid")
    elif doc["main"]["joins"]:
        codes.add("cold_open_invalid")
    by_id = {s["id"]: s for s in segments}
    previous: dict[str, int] = {}
    known_words = {w["id"] for w in context.words["words"]}
    for removal in doc["main"]["removals"]:
        segment = by_id.get(removal["seg"])
        if segment is None or not (segment["in_sf"] <= removal["in_sf"]
                                   and removal["out_sf"] <= segment["out_sf"]):
            codes.add("removal_outside_segment")
        if removal["in_sf"] < previous.get(removal["seg"], -1):
            codes.add("removal_overlap")
        previous[removal["seg"]] = removal["out_sf"]
        if any(w not in known_words for w in removal["words"] if w.startswith("w")
               and w[1:].isdigit()):
            codes.add("unknown_word")
    if any(key not in known_words for key in doc["captions"]["word_edits"]):
        codes.add("unknown_word")
    for track in doc["tracks"]:
        for item in track["items"]:
            asset = item.get("payload", {}).get("asset")
            if asset is None:
                continue
            if asset not in doc["assets"] or asset not in context.assets:
                codes.add("asset_missing")
                continue
            if item["type"] == "image":
                meta = context.assets[asset]
                t = item["transform"]
                x0, y0, w, h = tm.logo_box(x_e5=t["x_e5"], y_e5=t["y_e5"], w_e5=t["w_e5"],
                                           asset_w=meta["w"], asset_h=meta["h"],
                                           out_w=doc["output"]["w"], out_h=doc["output"]["h"])
                if x0 < 0 or y0 < 0 or x0 + w > doc["output"]["w"] or y0 + h > doc["output"]["h"]:
                    codes.add("item_out_of_frame")
    return codes


# --- rendering, index and loading ----------------------------------------------------------------


def _fixtures() -> tuple[dict[str, Context], list[_Fixture]]:
    contexts = {context_id: build_context(context_id) for context_id in CONTEXT_IDS}
    return contexts, _valid(contexts) + _invalid(contexts)


_CHECKED_CODES = {"outside_window", "duration_out_of_bounds", "cold_open_invalid",
                  "removal_outside_segment", "removal_overlap", "unknown_word",
                  "asset_missing", "item_out_of_frame"}


def render_doc_fixtures() -> dict[str, bytes]:
    """Every file under ``DOC_FIXTURES_DIR`` (relative posix path → bytes)."""
    contexts, fixtures = _fixtures()
    files: dict[str, bytes] = {}
    for context in contexts.values():
        files[f"contexts/{context.id}.words.json"] = canonical_bytes(context.words)
        files[f"contexts/{context.id}.seed.json"] = canonical_bytes(context.seed)
    files["contexts/assets.json"] = _pretty(asset_store())
    entries = []
    names = set()
    for fixture in fixtures:
        folder = "valid" if fixture.code is None else "invalid"
        relative = f"{folder}/{fixture.name}.json"
        if relative in names:
            raise AssertionError(f"duplicate fixture {relative}")
        names.add(relative)
        data = fixture.render()
        files[relative] = data
        entry: dict[str, Any] = {"file": relative, "context": fixture.context,
                                 "check": fixture.check}
        if fixture.code is None:
            entry["warnings"] = list(fixture.warnings)
        else:
            entry["code"] = fixture.code
            entry["path"] = fixture.path or ""
        entries.append(entry)
        if fixture.doc is not None:
            # Valid documents pass every rule the builder can check; an invalid document breaks
            # exactly its own rule (and no other checked rule).
            found = _check_semantics(fixture.doc, contexts[fixture.context])
            if fixture.code is None:
                ok = not found
            elif fixture.code in _CHECKED_CODES:
                ok = found == {fixture.code}
            else:
                ok = found <= {fixture.code}
            if not ok:
                raise AssertionError(f"{relative}: builder check found {sorted(found)}")
    index = {
        "schema": INDEX_SCHEMA,
        "generator": "tests/support/edit_v2_fixtures.py",
        "put_now_ms": PUT_NOW_MS,
        "assets": "contexts/assets.json",
        "contexts": {
            context_id: {"words": f"contexts/{context_id}.words.json",
                         "seed": f"contexts/{context_id}.seed.json"}
            for context_id in CONTEXT_IDS
        },
        "fixtures": entries,
    }
    files["index.json"] = (json.dumps(index, indent=1, ensure_ascii=False) + "\n").encode()
    return files


def write_doc_fixtures(root: Path = DOC_FIXTURES_DIR) -> None:
    files = render_doc_fixtures()
    for existing in root.rglob("*.json") if root.exists() else ():
        if existing.relative_to(root).as_posix() not in files:
            existing.unlink()
    for relative, data in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def load_index(root: Path = DOC_FIXTURES_DIR) -> dict[str, Any]:
    return json.loads((root / "index.json").read_text(encoding="utf-8"))


def load_context(context_id: str, root: Path = DOC_FIXTURES_DIR) -> Context:
    """A committed context: words artifact, seed and asset store (as the validator gets them)."""
    index = load_index(root)
    entry = index["contexts"][context_id]
    return Context(
        context_id,
        json.loads((root / entry["words"]).read_text(encoding="utf-8")),
        json.loads((root / entry["seed"]).read_text(encoding="utf-8")),
        json.loads((root / index["assets"]).read_text(encoding="utf-8")),
    )


@dataclass(frozen=True)
class FixtureCase:
    """One committed fixture and its expected classification (see index.json)."""

    file: str
    context: str
    check: str  # "put": PUT onto the context seed; "validate": parse + validate_doc(seed=None)
    code: str | None  # expected error code, None for a valid document
    path: str | None  # JSON pointer of the expected issue ("" = document level)
    warnings: tuple[str, ...]  # warnings a valid document must at least produce

    def raw(self, root: Path = DOC_FIXTURES_DIR) -> bytes:
        return (root / self.file).read_bytes()


def load_cases(root: Path = DOC_FIXTURES_DIR) -> tuple[FixtureCase, ...]:
    return tuple(
        FixtureCase(entry["file"], entry["context"], entry["check"], entry.get("code"),
                    entry.get("path"), tuple(entry.get("warnings", ())))
        for entry in load_index(root)["fixtures"]
    )


# --- plan builder ----------------------------------------------------------------------------------


def make_render_plan(doc: Mapping[str, Any], words: Mapping[str, Any]) -> RenderPlan:
    """A ``RenderPlan`` with the frozen fields filled from the time map (fixture use only).

    ``plan_sha256`` here is the sha256 of the document's canonical content (no revision,
    parent or audit); T1.3's real plan hash also covers words, camera, ASS and envelopes.
    """
    fps = Fps.from_json(doc["output"]["fps"])
    pieces = tm.pieces(doc)
    total = tm.total_frames(pieces)
    spans = tm.speech_spans([(w["s"], w["e"]) for w in words["words"]], pieces, fps)
    content = {k: v for k, v in doc.items() if k not in ("revision", "parent_sha256", "audit")}
    return RenderPlan(
        doc=doc,
        fps=fps,
        output=(doc["output"]["w"], doc["output"]["h"]),
        pieces=pieces,
        total_frames=total,
        total_samples=tm.smp(total, fps),
        speech_spans=spans,
        assets=doc["assets"],
        plan_sha256=sha256_hex(canonical_bytes(content)),
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Editor V3 document fixtures")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write", action="store_true")
    group.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    if args.write:
        write_doc_fixtures()
        return 0
    rendered = render_doc_fixtures()
    on_disk = {p.relative_to(DOC_FIXTURES_DIR).as_posix(): p.read_bytes()
               for p in DOC_FIXTURES_DIR.rglob("*.json")}
    return 0 if on_disk == rendered else 1


if __name__ == "__main__":
    sys.exit(main())
