#!/usr/bin/env python3
"""Fixtures of the timeline markers and the cold-open suggestions (plan §11.3 T3.7).

Two files, both derived from the committed document contexts (``tests/fixtures/edit_v2/docs``):

* ``tests/fixtures/edit_v2/marker-vectors.json``: for documents of every context (the seed, cuts
  that hide events, a trim, a new cold open that shows an event twice, a cut inside the cold
  open, and a context stripped of its analysis) the output frames of every laughter, silence
  (at least ``SILENCE_MIN_MS``) and camera-cut marker, from ``timemap.word_frames`` per segment,
  plus the marker kinds the job cannot have (``unavailable``). The browser lane
  (``web/components/editor/timeline/lanes/markers.mjs``) must give exactly these frames.
* ``tests/fixtures/edit_v2/coldopen-vectors.json``: ``coldopen.build_candidates`` of each
  context's seed, the data the cold-open panel's e2e serves as the route's answer.

Usage::

    python scripts/editor/gen_t37_fixtures.py --write | --check
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for _path in (ROOT / "src", ROOT / "tests"):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from support import edit_v2_fixtures as fixtures

from ai_clipper.edit_v2 import coldopen
from ai_clipper.edit_v2 import timemap as tm
from ai_clipper.edit_v2.doc import validate_doc

FIXTURE_DIR = ROOT / "tests" / "fixtures" / "edit_v2"
MARKERS_PATH = FIXTURE_DIR / "marker-vectors.json"
COLDOPEN_PATH = FIXTURE_DIR / "coldopen-vectors.json"
MARKERS_SCHEMA = "potongin.marker-vectors/1"
COLDOPEN_SCHEMA = "potongin.coldopen-vectors/1"
SILENCE_MIN_MS = 600
KINDS = ("laughter", "silence", "camera_cut")
STRIPPABLE = ("audio_timeline", "sound_events")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# --- markers (the Python side of the lane's rules) -----------------------------------------------


def case_words(words: Mapping[str, Any], strip: Sequence[str],
               extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """The words artifact of a case: as a job without ``strip`` analysis would have it
    (CONTRACTS §5.7: no audio timeline empties silences, scene cuts and gap classes; no sound
    events drops the caption tags, transcript laughter stays), plus the ``extra`` events,
    silences and scene cuts of a dense case, merged in sorted order."""
    if not strip and not extra:
        return words  # type: ignore[return-value]
    if any(item not in STRIPPABLE for item in strip):
        raise ValueError("unknown analysis to strip")
    out = copy.deepcopy(dict(words))
    if "audio_timeline" in strip:
        out["silences"], out["scene_cuts_ms"], out["gaps"] = [], [], []
    if "sound_events" in strip:
        out["events"] = [event for event in out["events"] if event["src"] != "yt-caption"]
    out["missing"] = sorted(set(out["missing"]) | set(strip))
    if extra:
        out["events"] = sorted(out["events"] + list(extra["events"]),
                               key=lambda ev: (ev["s"], ev["e"], ev["kind"], ev["src"]))
        out["silences"] = sorted(out["silences"] + [list(pair) for pair in extra["silences"]])
        out["scene_cuts_ms"] = sorted(out["scene_cuts_ms"] + list(extra["scene_cuts_ms"]))
    return out


def dense_extra(words: Mapping[str, Any]) -> dict[str, Any]:
    """An event at every word, cycling laughter tag, camera cut, silence and laughter token, so
    that markers fall on every piece edge and rounding hazard of a document."""
    events, silences, cuts = [], [], []
    for index, word in enumerate(words["words"]):
        kind = index % 4
        if kind == 0:
            mid = (word["s"] + word["e"]) // 2
            events.append({"kind": "laughter", "s": mid, "e": mid, "src": "yt-caption"})
        elif kind == 1:
            cuts.append(word["s"])
        elif kind == 2:
            silences.append([word["e"], word["e"] + SILENCE_MIN_MS + (index % 5) * 37 - 37])
        else:
            events.append({"kind": "laughter", "s": word["s"], "e": word["e"],
                           "src": "transcript"})
    return {"events": events, "silences": silences, "scene_cuts_ms": cuts}


def marker_sources(words: Mapping[str, Any]) -> list[tuple[str, str, int, int]]:
    sources = [("laughter", event["src"], event["s"], event["e"]) for event in words["events"]
               if event["kind"] == "laughter"]
    sources += [("silence", "audio_timeline", s, e) for s, e in words["silences"]
                if e - s >= SILENCE_MIN_MS]
    sources += [("camera_cut", "audio_timeline", ms, ms) for ms in words["scene_cuts_ms"]]
    return sources


def markers(words: Mapping[str, Any], doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every marker of ``words`` in ``doc``, once per segment that shows it."""
    fps = tm.Fps.from_json(doc["output"]["fps"])
    pieces = tm.pieces(doc)
    segments = list(dict.fromkeys(piece.seg for piece in pieces))
    out = []
    for kind, src, s, e in marker_sources(words):
        for seg in segments:
            frames = tm.word_frames(s, e, [p for p in pieces if p.seg == seg], fps)
            if frames is not None:
                out.append({"kind": kind, "src": src, "seg": seg, "s": s, "e": e,
                            "f0": frames[0], "f1": frames[1]})
    out.sort(key=lambda m: (m["f0"], m["f1"], KINDS.index(m["kind"]), m["s"], m["e"], m["src"],
                            m["seg"]))
    return out


def unavailable(words: Mapping[str, Any]) -> list[str]:
    missing = set(words["missing"])
    out = set()
    if "sound_events" in missing:
        out.add("laughter_tags")
    if "audio_timeline" in missing:
        out |= {"silence", "camera_cut"}
    return sorted(out)


# --- documents -----------------------------------------------------------------------------------


class _Builder:
    """Edits of a context's seed, made like the Appendix B commands (edges from ``bounds``)."""

    def __init__(self, context: fixtures.Context) -> None:
        self.context = context
        self.words = context.words
        self.fps = tm.Fps.from_json(context.seed["output"]["fps"])
        self.list = self.words["words"]
        self.before = {b["before"]: b["sf"] for b in self.words["bounds"] if b["before"]}
        self.after = {b["after"]: b["sf"] for b in self.words["bounds"] if b["after"]}
        self.doc = copy.deepcopy(context.seed)
        self.doc["revision"] = 1
        self.doc["parent_sha256"] = fixtures.etag(context.seed)
        edited_at = max(fixtures.EDITED_AT_MS, context.seed["audit"]["created_at_ms"])
        self.doc["audit"].update(updated_at_ms=edited_at, editor="editor-v3/1.0.0",
                                 last_command="RemoveWords")

    def segment(self, role: str) -> dict[str, Any] | None:
        return next((s for s in self.doc["main"]["segments"] if s["role"] == role), None)

    def mid(self, word: Mapping[str, Any]) -> int:
        return (word["s"] + word["e"]) * self.fps.num // (2000 * self.fps.den)

    def body_indices(self, margin_s: float = 3.0) -> list[int]:
        body = self.segment("body")
        margin = round(margin_s * self.fps.num / self.fps.den)
        return [i for i, word in enumerate(self.list)
                if body["in_sf"] + margin <= self.mid(word) < body["out_sf"] - margin]

    def remove(self, first: int, last: int, *, seg: str = "seg_b1", reason: str = "user",
               in_sf: int | None = None, out_sf: int | None = None) -> None:
        ids = [w["id"] for w in self.list[first:last + 1]] if reason != "gap_silent" else []
        start = self.before[self.list[first]["id"]] if in_sf is None else in_sf
        end = self.after[self.list[last]["id"]] if out_sf is None else out_sf
        removals = self.doc["main"]["removals"]
        merged = {"seg": seg, "in_sf": start, "out_sf": end, "words": ids, "reason": reason,
                  "origin": "user"}
        keep = []
        for removal in removals:
            if removal["seg"] == seg and removal["in_sf"] <= merged["out_sf"] \
                    and merged["in_sf"] <= removal["out_sf"]:
                merged["in_sf"] = min(merged["in_sf"], removal["in_sf"])
                merged["out_sf"] = max(merged["out_sf"], removal["out_sf"])
                merged["words"] = sorted(set(merged["words"]) | set(removal["words"]))
                merged["reason"] = "user"
            else:
                keep.append(removal)
        keep.append(merged)
        keep.sort(key=lambda r: (r["seg"], r["in_sf"]))
        for number, removal in enumerate(keep, start=1):
            removal["id"] = f"rm_{number}"
        self.doc["main"]["removals"] = [
            {key: removal[key] for key in ("id", "seg", "in_sf", "out_sf", "words", "reason",
                                           "origin")} for removal in keep]

    def around(self, s: int, e: int) -> tuple[int, int]:
        """The words touching ``[s, e]``, or the two words either side of a point in a gap."""
        touching = [i for i, w in enumerate(self.list) if w["s"] <= e and w["e"] >= s]
        if touching:
            return touching[0], touching[-1]
        prev = max(i for i, w in enumerate(self.list) if w["e"] < s)
        return prev, prev + 1

    def set_cold_open(self, first: int | None, last: int | None = None) -> None:
        main = self.doc["main"]
        main["segments"] = [s for s in main["segments"] if s["role"] != "cold_open"]
        main["removals"] = [r for r in main["removals"] if r["seg"] != "seg_co"]
        main["joins"] = []
        if first is not None:
            main["segments"].insert(0, {"id": "seg_co", "role": "cold_open",
                                        "in_sf": self.before[self.list[first]["id"]],
                                        "out_sf": self.after[self.list[last]["id"]]})
            main["joins"] = [{"after": "seg_co", "style": "cut", "audio_fade_ms": 30}]

    def valid(self) -> bool:
        return not validate_doc(self.doc, words=self.words, assets=self.context.assets,
                                seed=None).errors

    def result(self, name: str) -> dict[str, Any]:
        issues = validate_doc(self.doc, words=self.words, assets=self.context.assets,
                              seed=None).errors
        if issues:
            raise AssertionError(f"{self.context.id}/{name} is invalid: {issues}")
        return self.doc


def _cuts(context: fixtures.Context) -> dict[str, Any]:
    """Removals over the first body laughter, silence and camera cut, a gap shortened in its
    middle (Rapikan) and every sixth sentence's first words."""
    b = _Builder(context)
    inside = set(b.body_indices())
    done: set[str] = set()
    for kind, _src, s, e in marker_sources(b.words):
        if kind in done:
            continue
        first, last = b.around(s, e)
        if first in inside and last in inside:
            b.remove(first, last)
            done.add(kind)
    for s, e in b.words["silences"]:
        # a long silence between two body words, shortened in its middle (RemoveGap's shape)
        earlier = [i for i, w in enumerate(b.list) if w["e"] <= s]
        if e - s < 1200 or not earlier or earlier[-1] + 1 >= len(b.list):
            continue
        left = earlier[-1]
        if b.list[left + 1]["s"] < e or not {left, left + 1} <= inside:
            continue
        low, high = tm.sf_ceil(s + 200, b.fps), tm.sf_floor(e - 200, b.fps)
        if low < high:
            b.remove(left, left, reason="gap_silent", in_sf=low, out_sf=high)
            break
    units = [u["id"] for u in b.words["units"]]
    for unit in units[3::6]:
        members = [i for i, w in enumerate(b.list) if w["u"] == unit and i in inside]
        if len(members) >= 4:
            b.remove(members[0], members[1])
    return b.result("cuts")


def _trim(context: fixtures.Context) -> dict[str, Any]:
    b = _Builder(context)
    inside = b.body_indices()
    body = b.segment("body")
    body["in_sf"] = b.before[b.list[inside[len(inside) // 4]]["id"]]
    body["out_sf"] = b.after[b.list[inside[(3 * len(inside)) // 4]]["id"]]
    b.doc["audit"]["last_command"] = "TrimStart"
    if not b.valid():
        b.set_cold_open(None)
    return b.result("trim")


def _event_units(b: _Builder) -> list[tuple[int, int]]:
    """Body sentences of 1–6 s that hold a marker source's midpoint."""
    inside = set(b.body_indices(margin_s=6.0))
    sources = [(s + e) // 2 for _kind, _src, s, e in marker_sources(b.words)]
    out = []
    for unit in b.words["units"]:
        members = [i for i, w in enumerate(b.list) if w["u"] == unit["id"]]
        if not members or not set(members) <= inside or not 1000 <= unit["e"] - unit["s"] <= 6000:
            continue
        if any(b.list[members[0]]["s"] <= point <= b.list[members[-1]]["e"] for point in sources):
            out.append((members[0], members[-1]))
    return out


def _cold_open(context: fixtures.Context) -> dict[str, Any]:
    """A new cold open over a sentence that holds an event: the event is shown twice."""
    b = _Builder(context)
    for first, last in _event_units(b):
        b.set_cold_open(first, last)
        if b.valid():
            b.doc["audit"]["last_command"] = "SetColdOpen"
            return b.result("cold_open")
    raise AssertionError(f"{context.id}: no sentence with an event makes a cold open")


def _cold_open_cut(context: fixtures.Context) -> dict[str, Any]:
    b = _Builder(context)
    doc = _cold_open(context)
    b.doc = copy.deepcopy(doc)
    co = b.segment("cold_open")
    members = [i for i, w in enumerate(b.list) if co["in_sf"] <= b.mid(w) < co["out_sf"]]
    b.remove(members[1], members[1], seg="seg_co")
    if not b.valid():
        raise AssertionError(f"{context.id}: the cold-open cut is invalid")
    return b.result("cold_open_cut")


def _no_cold_open(context: fixtures.Context) -> dict[str, Any]:
    b = _Builder(context)
    b.set_cold_open(None)
    b.doc["audit"]["last_command"] = "SetColdOpen"
    return b.result("no_cold_open")


def marker_cases() -> list[dict[str, Any]]:
    cases = []
    for context_id in fixtures.CONTEXT_IDS:
        context = fixtures.load_context(context_id)
        docs: list[tuple[str, dict[str, Any], list[str]]] = [
            ("seed", context.seed, []),
            ("cuts", _cuts(context), []),
            ("trim", _trim(context), []),
            ("cold_open", _cold_open(context), []),
            ("cold_open_cut", _cold_open_cut(context), []),
        ]
        if any(s["role"] == "cold_open" for s in context.seed["main"]["segments"]):
            docs.append(("no_cold_open", _no_cold_open(context), []))
        if context_id == "c24":
            docs.append(("no_analysis", context.seed, ["audio_timeline", "sound_events"]))
        for name, doc, strip in docs:
            words = case_words(context.words, strip)
            cases.append({"name": f"{context_id}/{name}", "context": context_id, "strip": strip,
                          "extra": None, "doc": doc, "markers": markers(words, doc),
                          "unavailable": unavailable(words)})
        dense = {"c30": "cuts", "c25": "cuts", "c24": "cold_open_cut"}[context_id]
        doc = next(case["doc"] for case in cases if case["name"] == f"{context_id}/{dense}")
        extra = dense_extra(context.words)
        words = case_words(context.words, [], extra)
        cases.append({"name": f"{context_id}/dense_{dense}", "context": context_id, "strip": [],
                      "extra": extra, "doc": doc, "markers": markers(words, doc),
                      "unavailable": unavailable(words)})
    return cases


def render_markers() -> bytes:
    head = _json({"schema": MARKERS_SCHEMA, "silence_min_ms": SILENCE_MIN_MS})[:-1]
    body = ",\n".join(_json(case) for case in marker_cases())
    return f'{head},"cases":[\n{body}\n]}}\n'.encode()


def render_coldopen() -> bytes:
    lines = []
    for context_id in fixtures.CONTEXT_IDS:
        context = fixtures.load_context(context_id)
        entry = {"wordsSha256": context.seed["base"]["words"]["sha256"],
                 "candidates": [candidate.to_json() for candidate in
                                coldopen.build_candidates(context.seed, context.words)]}
        lines.append(f"{_json(context_id)}:{_json(entry)}")
    head = _json({"schema": COLDOPEN_SCHEMA})[:-1]
    return (f'{head},"contexts":{{\n' + ",\n".join(lines) + "\n}}\n").encode()


def render() -> bytes:
    """The marker vectors (kept for the markers test)."""
    return render_markers()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    outputs = {MARKERS_PATH: render_markers(), COLDOPEN_PATH: render_coldopen()}
    if args.write:
        for path, data in outputs.items():
            path.write_bytes(data)
        return 0
    stale = [path.name for path, data in outputs.items()
             if not path.exists() or path.read_bytes() != data]
    if stale:
        print(f"stale: {', '.join(stale)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
