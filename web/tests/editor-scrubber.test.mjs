// Mode Cepat's scrubber (docs/plans/2026-10-02-editor-mode-cepat.md §7, AC8): the marks it draws
// come from the timeline's own marker model (buildMarkers, the marker fixtures of the Python
// vectors), the cold-open range and the join mark from the time map and the Transisi model; the
// drawing merges marks closer than 6 px; the keys and the pointer map frames and pixels both ways.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { caseWords } from "../components/editor/timeline/lanes/__dev__/marker-cases.mjs";
import { buildMarkers, markerText, unavailableNote } from "../components/editor/timeline/lanes/markers.mjs";
import {
  MERGE_PX,
  SNAP_PX,
  drawGroups,
  frameAtPx,
  legendItems,
  nearestMark,
  nextMark,
  pxAtFrame,
  scrubberKey,
  scrubberMarks,
  valueText,
} from "../components/editor/scrubber/scrubber-model.mjs";
import { formatClock, frameToMs } from "../components/editor/shell-model.mjs";
import { pieces, totalFrames } from "../lib/editor/timemap.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureDir = path.join(repo, "tests", "fixtures", "edit_v2");
const vectors = JSON.parse(readFileSync(path.join(fixtureDir, "marker-vectors.json"), "utf8"));
const contextWords = (id) => JSON.parse(readFileSync(path.join(fixtureDir, "docs", "contexts", `${id}.words.json`), "utf8"));
const caseOf = (name) => {
  const kase = vectors.cases.find((entry) => entry.name === name);
  return { doc: structuredClone(kase.doc), words: caseWords(contextWords(kase.context), kase) };
};
const clone = (value) => structuredClone(value);

// --- marks from the timeline's marker model ------------------------------------------------

test("a mark at every laugh and pause frame of buildMarkers (±0), camera cuts left out, on every fixture", () => {
  let checked = 0;
  for (const kase of vectors.cases) {
    const words = caseWords(contextWords(kase.context), kase);
    const { markers, unavailable } = buildMarkers(words, kase.doc);
    const model = scrubberMarks({ doc: kase.doc, words });
    const expected = markers.filter((marker) => marker.kind !== "camera_cut").map((marker) => [marker.kind, marker.f0]);
    assert.deepEqual(model.marks.map((mark) => [mark.kind, mark.f]), expected, kase.name);
    assert.deepEqual(model.unavailable, unavailable, kase.name);
    assert.ok(model.marks.every((mark) => mark.kind !== "camera_cut"), kase.name);
    checked += expected.length;
  }
  assert.ok(checked >= 400, `only ${checked} marks checked`);
});

test("each mark carries the marker lane's text and time, and a unique key", () => {
  const { doc, words } = caseOf("c30/seed");
  const model = scrubberMarks({ doc, words });
  const { markers } = buildMarkers(words, doc);
  const kept = markers.filter((marker) => marker.kind !== "camera_cut");
  assert.ok(model.marks.length >= 4);
  model.marks.forEach((mark, index) => {
    const text = markerText(kept[index], { fps: doc.output.fps, words });
    assert.equal(mark.text, text.short);
    assert.equal(mark.time, text.time);
    assert.equal(mark.key, kept[index].key);
  });
  assert.equal(new Set(model.marks.map((mark) => mark.key)).size, model.marks.length);
});

test("the cold-open range is [0, J) from the time map's pieces, and a clip without one has none", () => {
  const { doc, words } = caseOf("c30/seed");
  const J = pieces(doc).filter((piece) => piece.role === "cold_open").reduce((sum, piece) => sum + piece.frames, 0);
  assert.ok(J > 0);
  assert.deepEqual(scrubberMarks({ doc, words }).coldOpen, { f0: 0, f1: J });
  const plain = caseOf("c30/no_cold_open");
  assert.equal(scrubberMarks(plain).coldOpen, null);
  assert.equal(scrubberMarks(plain).join, null);
});

test("the join mark sits at J for Kilat putih and Gelap sebentar, for Potong langsung only with the whoosh", () => {
  const { doc, words } = caseOf("c30/seed");
  const J = pieces(doc).filter((piece) => piece.role === "cold_open").reduce((sum, piece) => sum + piece.frames, 0);
  const withJoin = (style, sfx) => {
    const next = clone(doc);
    next.main.joins[0].style = style;
    if (sfx) next.main.joins[0].sfx = { id: "whoosh", v: 1 };
    else delete next.main.joins[0].sfx;
    return scrubberMarks({ doc: next, words }).join;
  };
  assert.equal(withJoin("cut", false), null, "a plain cut has no mark");
  assert.deepEqual(withJoin("cut", true), { key: "join", kind: "join", f: J, style: "cut", sfx: true, text: "Transisi: Potong langsung + whoosh",
    time: markerTime(J, doc) });
  assert.deepEqual(withJoin("flash_white", false), { key: "join", kind: "join", f: J, style: "flash_white", sfx: false,
    text: "Transisi: Kilat putih", time: markerTime(J, doc) });
  assert.equal(withJoin("dip_black", true).text, "Transisi: Gelap sebentar + whoosh");
});

const markerTime = (f, doc) => formatClock(frameToMs(f, doc.output.fps));

test("the unavailable kinds pass through, and the lane's note is the scrubber's note", () => {
  const { doc, words } = caseOf("c24/no_analysis");
  const model = scrubberMarks({ doc, words });
  assert.deepEqual(model.unavailable, ["camera_cut", "laughter_tags", "silence"]);
  assert.match(unavailableNote(model.unavailable), /tidak tersedia untuk job ini/);
  assert.deepEqual(scrubberMarks({ doc: null, words: null }), { marks: [], coldOpen: null, join: null, unavailable: [], stops: [] });
});

test("the legend names Tawa, Jeda and Cold open, and Transisi only with a join mark", () => {
  const { doc, words } = caseOf("c30/seed");
  assert.deepEqual(legendItems(scrubberMarks({ doc, words })), ["Tawa", "Jeda", "Cold open"]);
  const next = clone(doc);
  next.main.joins[0].style = "flash_white";
  assert.deepEqual(legendItems(scrubberMarks({ doc: next, words })), ["Tawa", "Jeda", "Cold open", "Transisi"]);
});

// --- drawing: marks closer than 6 px merge ---------------------------------------------------

const mark = (kind, f, text = kind === "laughter" ? "Tawa, dari tag caption YouTube" : "Jeda 0,8 dtk") => ({
  key: `${kind}:${f}`, kind, f, text, time: `t${f}`,
});

test("marks closer than 6 px merge into one dot at the group's earliest frame, labelled with every mark", () => {
  assert.equal(MERGE_PX, 6);
  const marks = [mark("laughter", 100), mark("silence", 102), mark("laughter", 300), mark("silence", 306), mark("silence", 900)];
  const groups = drawGroups(marks, 1);
  assert.deepEqual(groups.map((group) => [group.f, group.x, group.marks.length]), [[100, 100, 2], [300, 300, 1], [306, 306, 1], [900, 900, 1]]);
  assert.equal(groups[0].label, "Tawa, Jeda · t100");
  assert.equal(groups[0].kind, "laughter", "a group with a laugh draws as a laugh");
  assert.equal(groups[1].label, "Tawa, dari tag caption YouTube · t300");
  assert.equal(groups[3].kind, "silence");
  // At 0.1 px per frame everything within 60 frames of a group's first mark joins it.
  const coarse = drawGroups(marks, 0.1);
  assert.deepEqual(coarse.map((group) => [group.f, group.marks.length]), [[100, 2], [300, 2], [900, 1]]);
  assert.equal(coarse[1].label, "Tawa, Jeda · t300");
});

test("the model keeps every mark at its own frame; only the drawing merges", () => {
  const { doc, words } = caseOf("c30/dense_cuts");
  const model = scrubberMarks({ doc, words });
  const total = totalFrames(pieces(doc));
  const groups = drawGroups(model.marks, 600 / total);
  assert.ok(groups.length < model.marks.length, "the dense case merges at 600 px");
  assert.equal(groups.reduce((sum, group) => sum + group.marks.length, 0), model.marks.length);
  for (const group of groups) {
    assert.equal(group.f, Math.min(...group.marks.map((entry) => entry.f)));
    for (const entry of group.marks) assert.ok((entry.f - group.f) * (600 / total) < MERGE_PX, group.label);
  }
  for (let i = 1; i < groups.length; i += 1) assert.ok((groups[i].f - groups[i - 1].f) * (600 / total) >= MERGE_PX);
});

test("several marks of one kind are counted in the label", () => {
  const groups = drawGroups([mark("laughter", 10), mark("laughter", 11), mark("silence", 12), mark("laughter", 13)], 1);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Tawa (3), Jeda · t10");
});

// --- pixels and frames -----------------------------------------------------------------------

test("px ↔ frame round trips on the plan's frame scale", () => {
  for (const [width, total] of [[600, 1800], [1000, 997], [333, 30], [1, 2]]) {
    const scale = { width, total };
    for (const f of [0, 1, Math.floor(total / 3), total - 2, total - 1]) {
      if (f < 0) continue;
      assert.equal(frameAtPx(pxAtFrame(f, scale), scale), f, `${width}/${total} f=${f}`);
    }
    assert.equal(frameAtPx(-20, scale), 0);
    assert.equal(frameAtPx(width + 50, scale), total - 1);
    assert.equal(pxAtFrame(total, scale), width);
  }
  assert.equal(frameAtPx(10, { width: 0, total: 100 }), 0);
  assert.equal(pxAtFrame(10, { width: 600, total: 0 }), 0);
});

test("a press within 6 px of a mark snaps to it; the nearest wins, the earlier on a tie", () => {
  assert.equal(SNAP_PX, 6);
  const marks = [mark("laughter", 100), mark("silence", 112), { key: "join", kind: "join", f: 140, text: "Transisi: Kilat putih", time: "t" }];
  assert.equal(nearestMark(marks, 106, 1)?.f, 100, "a tie at 6 px each side: the earlier");
  assert.equal(nearestMark(marks, 107, 1)?.f, 112);
  assert.equal(nearestMark(marks, 135, 1)?.f, 140, "the join mark snaps too");
  assert.equal(nearestMark(marks, 125, 1), null, "13 px from either");
  assert.equal(nearestMark(marks, 160, 0.25)?.f, 140, "20 frames at 0.25 px each is 5 px");
  assert.equal(nearestMark([], 5, 1), null);
});

test("PageUp and PageDown stops: every mark, the cold-open edges and the join, in frame order", () => {
  const { doc, words } = caseOf("c30/seed");
  const next = clone(doc);
  next.main.joins[0].style = "dip_black";
  const model = scrubberMarks({ doc: next, words });
  const J = model.coldOpen.f1;
  const expected = [...new Set([0, J, ...model.marks.map((entry) => entry.f)])].sort((a, b) => a - b);
  assert.deepEqual(model.stops, expected);
  assert.equal(nextMark(model.stops, 0, 1), expected[1]);
  assert.equal(nextMark(model.stops, expected[2], -1), expected[1]);
  assert.equal(nextMark(model.stops, expected[2] - 1, 1), expected[2]);
  assert.equal(nextMark(model.stops, expected.at(-1), 1), null);
  assert.equal(nextMark(model.stops, 0, -1), null);
  const plain = scrubberMarks(caseOf("c30/no_cold_open"));
  assert.deepEqual(plain.stops, [...new Set(plain.marks.map((entry) => entry.f))].sort((a, b) => a - b));
});

// --- keys and the value text -----------------------------------------------------------------

const FPS = [30000, 1001];
const key = (name, mods = {}) => ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("←/→ step a frame, Shift a second, Home and End go to the ends, PageUp/PageDown to the marks", () => {
  const ctx = { frame: 100, total: 900, fps: FPS, stops: [0, 60, 150, 400] };
  const at = (event, over = {}) => scrubberKey(event, { ...ctx, ...over });
  assert.deepEqual(at(key("ArrowRight")), { kind: "seek", frame: 101 });
  assert.deepEqual(at(key("ArrowLeft")), { kind: "seek", frame: 99 });
  assert.deepEqual(at(key("ArrowRight", { shiftKey: true })), { kind: "seek", frame: 130 });
  assert.deepEqual(at(key("ArrowLeft", { shiftKey: true })), { kind: "seek", frame: 70 });
  assert.deepEqual(at(key("ArrowLeft", { shiftKey: true }), { frame: 10 }), { kind: "seek", frame: 0 });
  assert.deepEqual(at(key("ArrowRight"), { frame: 899 }), { kind: "seek", frame: 899 });
  assert.deepEqual(at(key("Home")), { kind: "seek", frame: 0 });
  assert.deepEqual(at(key("End")), { kind: "seek", frame: 899 });
  assert.deepEqual(at(key("PageDown")), { kind: "seek", frame: 150 });
  assert.deepEqual(at(key("PageUp")), { kind: "seek", frame: 60 });
  assert.deepEqual(at(key("PageDown"), { frame: 400 }), { kind: "seek", frame: 400 }, "no later mark: stay");
  assert.deepEqual(at(key("PageUp"), { frame: 0 }), { kind: "seek", frame: 0 });
});

test("Space and K play or pause from the scrubber; other keys stay global", () => {
  const at = (event) => scrubberKey(event, { frame: 5, total: 90, fps: FPS, stops: [] });
  assert.deepEqual(at(key(" ")), { kind: "toggle" });
  assert.deepEqual(at(key("k")), { kind: "toggle" });
  assert.deepEqual(at(key("K", { shiftKey: true })), { kind: "toggle" });
  assert.equal(at(key("z", { ctrlKey: true })), null);
  assert.equal(at(key("ArrowRight", { ctrlKey: true })), null);
  assert.equal(at(key("'")), null);
  assert.equal(at(key("?")), null);
  assert.equal(at(key("Enter")), null);
});

test("aria-valuetext reads the playhead and the length: 00:02,2 dari 01:00,6", () => {
  assert.equal(valueText(66, 1815, FPS), "00:02,2 dari 01:00,5");
  assert.equal(valueText(0, 90, [30, 1]), "00:00,0 dari 00:03,0");
  assert.equal(valueText(120, 300, FPS), "00:04,0 dari 00:10,0");
});
