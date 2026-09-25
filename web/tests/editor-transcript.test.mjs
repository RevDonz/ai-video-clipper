// Transcript panel logic (plan §11.2 T2.7, Appendix C.2): the selection model, the transcript
// model (word states, paragraphs, removal chips, cold-open rules, active word) and the mapping
// from a selection and a key to Appendix B commands. The components are thin over these.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { keyAction, selectionActions } from "../components/editor/transcript/actions.mjs";
import {
  activeWordAt,
  boundsIndex,
  buildTranscriptModel,
  coldOpenCheck,
  coldOpenInfo,
  formatDuration,
  outToSrc,
  piecesOf,
  seekFrameOf,
  sfCeil,
  sfFloor,
  wordFrames,
} from "../components/editor/transcript/model.mjs";
import {
  NO_SELECTION,
  clampSelection,
  createSelectionStore,
  extendFocus,
  extendTo,
  includes,
  isEmpty,
  moveFocus,
  selectOne,
  selectionRange,
  selectionStoreFor,
} from "../components/editor/transcript/selection.mjs";

const vectors = JSON.parse(readFileSync(
  new URL("../../tests/fixtures/edit_v2/timemap-vectors.json", import.meta.url), "utf8",
));
const FPS = [30000, 1001];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bound(words, key, id) {
  return boundsIndex(words)[key].get(id).sf;
}

// A regular synthetic transcript: `count` words of 300 ms with 100 ms gaps from 100 s, eight
// words per sentence unit, `bounds` in the middle of every gap (the fakes' rule).
function makeWords(count, { start = 100_000, word = 300, gap = 100, perUnit = 8, fps = FPS } = {}) {
  const sf = (ms) => Math.floor((ms * fps[0]) / (1000 * fps[1]));
  const list = [];
  for (let i = 0, t = start; i < count; i += 1, t += word + gap) {
    list.push({ id: `w${String(i).padStart(6, "0")}`, s: t, e: t + word, t: `kata${i}`, p_pm: i === 3 ? 300 : 900,
      u: `S${String(Math.floor(i / perUnit)).padStart(4, "0")}`, z: false });
  }
  const bounds = [{ after: null, before: list[0].id, sf: sf(list[0].s), tight: false, rms_cdb: null }];
  for (let i = 1; i < count; i += 1) {
    bounds.push({ after: list[i - 1].id, before: list[i].id, sf: sf(Math.floor((list[i - 1].e + list[i].s) / 2)),
      tight: false, rms_cdb: -5000 });
  }
  bounds.push({ after: list.at(-1).id, before: null, sf: sf(list.at(-1).e) + 1, tight: false, rms_cdb: null });
  const units = [];
  for (let u = 0; u * perUnit < count; u += 1) {
    const first = list[u * perUnit];
    const last = list[Math.min(count, (u + 1) * perUnit) - 1];
    units.push({ id: first.u, s: first.s, e: last.e, q: false });
  }
  return { ...fakeWords(), fps, window_ms: [start - 1000, list.at(-1).e + 1000], words: list, units, bounds, gaps: [] };
}

// fakeDoc() with the body on words [first, last] of `words`.
function makeDoc(words, first, last) {
  const doc = fakeDoc();
  doc.base.window_ms = words.window_ms;
  doc.main.segments = [{ id: "seg_b1", role: "body", in_sf: bound(words, "before", words.words[first].id),
    out_sf: bound(words, "after", words.words[last].id) }];
  return doc;
}

// A removal of words [first, last] (inclusive indices) snapped through `bounds`, as RemoveWords
// builds it.
function removal(words, first, last, id = "rm_1") {
  const list = words.words;
  return {
    id, seg: "seg_b1", in_sf: bound(words, "before", list[first].id), out_sf: bound(words, "after", list[last].id),
    words: list.slice(first, last + 1).map((word) => word.id), reason: "user", origin: "user",
  };
}

// --- selection model --------------------------------------------------------------------------

test("a click selects one word and shift+click extends from the anchor", () => {
  assert.ok(isEmpty(NO_SELECTION));
  assert.equal(selectionRange(NO_SELECTION), null);
  const one = selectOne(4);
  assert.deepEqual(selectionRange(one), [4, 4]);
  assert.deepEqual(selectionRange(extendTo(one, 9)), [4, 9]);
  assert.deepEqual(selectionRange(extendTo(extendTo(one, 9), 1)), [1, 4]);
  assert.equal(extendTo(extendTo(one, 9), 1).anchor, 4);
  assert.deepEqual(selectionRange(extendTo(NO_SELECTION, 3)), [3, 3]);
  assert.ok(includes(extendTo(one, 9), 7));
  assert.ok(!includes(extendTo(one, 9), 10));
  assert.ok(!includes(NO_SELECTION, 0));
});

test("arrows collapse and move; shift+arrows extend; both clamp to the word list", () => {
  const count = 12;
  assert.deepEqual(selectionRange(moveFocus(NO_SELECTION, 1, count)), [0, 0]);
  assert.deepEqual(selectionRange(moveFocus(NO_SELECTION, -1, count)), [11, 11]);
  const range = extendTo(selectOne(3), 6);
  assert.deepEqual(selectionRange(moveFocus(range, 1, count)), [7, 7]);
  assert.deepEqual(selectionRange(moveFocus(selectOne(11), 1, count)), [11, 11]);
  assert.deepEqual(selectionRange(moveFocus(selectOne(0), -1, count)), [0, 0]);
  assert.deepEqual(selectionRange(extendFocus(selectOne(3), 2, count)), [3, 5]);
  assert.deepEqual(selectionRange(extendFocus(selectOne(3), -5, count)), [0, 3]);
  assert.deepEqual(selectionRange(extendFocus(NO_SELECTION, 1, count)), [0, 0]);
  assert.equal(moveFocus(NO_SELECTION, 1, 0), NO_SELECTION);
});

test("a selection is clamped when the word list shrinks", () => {
  assert.deepEqual(selectionRange(clampSelection(extendTo(selectOne(2), 20), 10)), [2, 9]);
  assert.equal(clampSelection(selectOne(12), 10), NO_SELECTION);
  assert.equal(clampSelection(NO_SELECTION, 10), NO_SELECTION);
  const kept = selectOne(3);
  assert.equal(clampSelection(kept, 10), kept);
});

test("the selection store notifies on change only and is shared per clip", () => {
  const store = createSelectionStore();
  const seen = [];
  const unsubscribe = store.subscribe((value) => seen.push(selectionRange(value)));
  store.set(selectOne(2));
  store.set(selectOne(2));
  store.set(extendTo(selectOne(2), 5));
  unsubscribe();
  store.set(NO_SELECTION);
  assert.deepEqual(seen, [[2, 2], [2, 5]]);
  assert.equal(store.get(), NO_SELECTION);
  assert.equal(selectionStoreFor("clip_a"), selectionStoreFor("clip_a"));
  assert.notEqual(selectionStoreFor("clip_a"), selectionStoreFor("clip_b"));
});

// --- time map mirror --------------------------------------------------------------------------

test("piecesOf, outToSrc and wordFrames equal every time-map vector", () => {
  assert.ok(vectors.cases.length >= 40);
  let checks = 0;
  for (const vector of vectors.cases) {
    const pieces = piecesOf(vector.doc);
    assert.deepEqual(pieces, vector.pieces, vector.name);
    for (const [n, i, sf] of vector.out_to_src) {
      const [piece, src] = outToSrc(n, pieces);
      assert.deepEqual([piece.i, src], [i, sf], `${vector.name} n=${n}`);
      checks += 1;
    }
    for (const { scope, s_ms: s, e_ms: e, expect } of vector.word_frames) {
      const scoped = scope === null ? pieces : pieces.filter((piece) => piece.seg === scope);
      assert.deepEqual(wordFrames(s, e, scoped, vector.fps), expect, `${vector.name} ${s}-${e}`);
      checks += 1;
    }
  }
  assert.ok(checks > 500, `${checks} checks`);
  for (const { in: [num, den, ms], expect } of vectors.sf_floor) assert.equal(sfFloor(ms, [num, den]), expect);
  for (const { in: [num, den, ms], expect } of vectors.sf_ceil) assert.equal(sfCeil(ms, [num, den]), expect);
});

test("durations are written the Indonesian way", () => {
  assert.equal(formatDuration(42, FPS), "1,4 dtk");
  assert.equal(formatDuration(150, [30, 1]), "5,0 dtk");
  assert.equal(formatDuration(1, [25, 1]), "0,0 dtk");
});

// --- transcript model -------------------------------------------------------------------------

test("revision 0: every word is in the body, grouped by sentence unit", () => {
  const words = fakeWords();
  const model = buildTranscriptModel(words, fakeDoc());
  assert.equal(model.states.length, 12);
  assert.ok(model.states.every((state) => state.zone === "body" && state.removal === null && !state.cold));
  assert.deepEqual(model.paragraphs.map((para) => [para.unit, para.start, para.end]), [["S0011", 0, 6], ["S0012", 6, 12]]);
  assert.equal(model.firstBody, 0);
  assert.equal(model.lastBody, 11);
  assert.equal(model.states[0].text, "Kenapa");
  assert.deepEqual(model.chips, []);
});

test("a removal strikes its words and places one restore chip before them", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.removals = [removal(words, 1, 2)];
  const model = buildTranscriptModel(words, doc);
  assert.deepEqual(model.states.map((state) => state.removal), [null, "rm_1", "rm_1", ...Array(9).fill(null)]);
  assert.equal(model.chips.length, 1);
  const [chip] = model.chips;
  assert.equal(chip.removalId, "rm_1");
  assert.equal(chip.before, 1);
  assert.equal(chip.frames, doc.main.removals[0].out_sf - doc.main.removals[0].in_sf);
  assert.equal(chip.label, `⋯ ${formatDuration(chip.frames, FPS)}`);
  assert.deepEqual(model.paragraphs[0].chips.map((item) => item.removalId), ["rm_1"]);
  assert.deepEqual(model.paragraphs[1].chips, []);
});

test("unchanged word states and paragraphs are reused between models", () => {
  const words = fakeWords();
  const first = buildTranscriptModel(words, fakeDoc());
  const doc = fakeDoc();
  doc.main.removals = [removal(words, 7, 8)];
  const second = buildTranscriptModel(words, doc, first);
  assert.equal(second.paragraphs[0], first.paragraphs[0]);
  assert.notEqual(second.paragraphs[1], first.paragraphs[1]);
  for (let i = 0; i < 12; i += 1) {
    if (i === 7 || i === 8) assert.notEqual(second.states[i], first.states[i]);
    else assert.equal(second.states[i], first.states[i], `word ${i}`);
  }
  const third = buildTranscriptModel(words, clone(doc), second);
  assert.equal(third.paragraphs[1], second.paragraphs[1]);
  assert.ok(third.states.every((state, i) => state === second.states[i]));
});

test("words outside the trimmed body are marked before or after", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.segments[0].in_sf = bound(words, "before", words.words[3].id);
  doc.main.segments[0].out_sf = bound(words, "after", words.words[9].id);
  const model = buildTranscriptModel(words, doc);
  assert.deepEqual(model.states.map((state) => state.zone),
    ["before", "before", "before", "body", "body", "body", "body", "body", "body", "body", "after", "after"]);
  assert.equal(model.firstBody, 3);
  assert.equal(model.lastBody, 9);
});

test("word edits give the display text and the hidden, emphasis and edited flags", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.captions.word_edits = {
    w048121: { text: "Mengapa" }, w048122: { hidden: true }, w048123: { emphasis: true },
  };
  const model = buildTranscriptModel(words, doc);
  assert.deepEqual([model.states[0].text, model.states[0].asr, model.states[0].edited], ["Mengapa", "Kenapa", true]);
  assert.equal(model.states[1].hidden, true);
  assert.equal(model.states[2].emphasis, true);
  assert.equal(model.states[3].edited, false);
});

test("words inside the cold open are marked, and coldOpenInfo describes it", () => {
  const words = makeWords(40);
  const doc = makeDoc(words, 4, 35);
  const list = words.words;
  doc.main.segments.unshift({ id: "seg_co", role: "cold_open", in_sf: bound(words, "before", list[20].id), out_sf: bound(words, "after", list[24].id) });
  doc.main.joins = [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }];
  const model = buildTranscriptModel(words, doc);
  assert.deepEqual(model.states.map((state, i) => (state.cold ? i : -1)).filter((i) => i >= 0), [20, 21, 22, 23, 24]);
  assert.ok(model.states.slice(20, 25).every((state) => state.zone === "body"), "cold-open words stay body words too");
  const info = coldOpenInfo(model);
  assert.equal(info.firstIndex, 20);
  assert.equal(info.lastIndex, 24);
  assert.equal(info.text, "kata20 kata21 kata22 kata23 kata24");
  assert.equal(info.frames, doc.main.segments[0].out_sf - doc.main.segments[0].in_sf);
  for (const nudge of ["inEarlier", "inLater", "outEarlier", "outLater"]) assert.equal(info.nudges[nudge].ok, true, nudge);
  assert.equal(coldOpenInfo(buildTranscriptModel(words, makeDoc(words, 4, 35))), null);
  // Two words: dropping one leaves 0.4 s, under the 0.5 s minimum.
  const two = makeDoc(words, 4, 35);
  two.main.segments.unshift({ id: "seg_co", role: "cold_open", in_sf: bound(words, "before", list[20].id), out_sf: bound(words, "after", list[21].id) });
  two.main.joins = [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }];
  const twoInfo = coldOpenInfo(buildTranscriptModel(words, two));
  assert.equal(twoInfo.nudges.inLater.ok, false);
  assert.match(twoInfo.nudges.inLater.reason, /minimal 0,5 dtk/);
  assert.equal(twoInfo.nudges.outEarlier.ok, false);
  assert.equal(twoInfo.nudges.inEarlier.ok, true);
});

test("coldOpenCheck applies the 0.5–8 s rule and refuses a repeat of the opening", () => {
  const words = makeWords(60);
  const model = buildTranscriptModel(words, makeDoc(words, 4, 55));
  const ok = coldOpenCheck(model, 20, 24);
  assert.equal(ok.ok, true);
  assert.equal(ok.frames, ok.outSf - ok.inSf);
  assert.equal(ok.inSf, bound(words, "before", words.words[20].id));
  assert.equal(ok.outSf, bound(words, "after", words.words[24].id));
  const tiny = coldOpenCheck(model, 20, 20);
  assert.equal(tiny.ok, false);
  assert.equal(tiny.code, "too_short");
  assert.match(tiny.reason, /minimal 0,5 dtk/);
  const opening = coldOpenCheck(model, 4, 8);
  assert.equal(opening.ok, false);
  assert.equal(opening.code, "repeats_opening");
  const tooLong = coldOpenCheck(model, 10, 40);
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, "too_long");
  assert.match(tooLong.reason, /maksimal 8 dtk/);
  assert.equal(coldOpenCheck(model, -1, -1).code, "empty");
});

test("the active word follows the output frame through cuts", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.removals = [removal(words, 1, 2)];
  const model = buildTranscriptModel(words, doc);
  for (const index of [0, 3, 6, 11]) {
    const frame = seekFrameOf(model, index);
    assert.equal(typeof frame, "number");
    assert.equal(activeWordAt(model, frame), index, `word ${index} at frame ${frame}`);
  }
  assert.equal(seekFrameOf(model, 1), null, "a removed word has no output frame");
  assert.equal(activeWordAt(model, -5), -1);
  assert.equal(activeWordAt(model, 10_000_000), -1);
});

test("in a short pause the last word stays active; after a long one nothing is", () => {
  // Words of 300 ms, a 100 ms gap after word 0 and a 2 s pause after word 1.
  const words = makeWords(3);
  words.words[2] = { ...words.words[2], s: words.words[2].s + 2000, e: words.words[2].e + 2000 };
  words.bounds[2] = { ...words.bounds[2], sf: sfFloor(words.words[1].e + 1000, FPS) };
  words.bounds[3] = { ...words.bounds[3], sf: sfFloor(words.words[2].e, FPS) + 1 };
  const doc = makeDoc(words, 0, 2);
  doc.base.window_ms = [words.window_ms[0], words.words[2].e + 1000];
  const model = buildTranscriptModel(words, doc);
  const [, off0] = wordFrames(words.words[0].s, words.words[0].e, model.pieces, FPS);
  const [on1, off1] = wordFrames(words.words[1].s, words.words[1].e, model.pieces, FPS);
  assert.ok(on1 > off0, "a gap frame exists between words 0 and 1");
  assert.equal(activeWordAt(model, off0), 0);
  assert.equal(activeWordAt(model, on1), 1);
  assert.equal(activeWordAt(model, off1 + 3), 1);
  assert.equal(activeWordAt(model, off1 + 30), -1);
});

// --- selection → commands ---------------------------------------------------------------------

test("delete removes each visible run of the selection and skips removed words", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.removals = [removal(words, 4, 5)];
  const model = buildTranscriptModel(words, doc);
  const actions = selectionActions(model, extendTo(selectOne(2), 7), { readOnly: false });
  assert.equal(actions.remove.enabled, true);
  assert.deepEqual(actions.remove.runs, [["w048123", "w048124"], ["w048127", "w048128"]]);
  assert.deepEqual(actions.restore.removalIds, ["rm_1"]);
  assert.equal(actions.restore.enabled, true);
  const none = selectionActions(model, selectOne(4), { readOnly: false });
  assert.equal(none.remove.enabled, false);
  assert.deepEqual(none.restore.removalIds, ["rm_1"]);
  assert.equal(selectionActions(model, NO_SELECTION, { readOnly: false }).remove.enabled, false);
  assert.equal(selectionActions(model, selectOne(0), { readOnly: true }).remove.enabled, false);
});

test("hide and emphasis toggle the whole selection", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.captions.word_edits = { w048121: { hidden: true }, w048122: { hidden: true } };
  const model = buildTranscriptModel(words, doc);
  const both = selectionActions(model, extendTo(selectOne(0), 1), { readOnly: false });
  assert.equal(both.hide.on, false);
  assert.deepEqual(both.hide.ids, ["w048121", "w048122"]);
  const mixed = selectionActions(model, extendTo(selectOne(0), 2), { readOnly: false });
  assert.equal(mixed.hide.on, true);
  assert.equal(mixed.emphasis.on, true);
  assert.deepEqual(mixed.emphasis.ids, ["w048121", "w048122", "w048123"]);
});

test("trim and extend use the first and last selected word as the gap word", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.segments[0].in_sf = bound(words, "before", words.words[3].id);
  const model = buildTranscriptModel(words, doc);
  const inside = selectionActions(model, extendTo(selectOne(5), 7), { readOnly: false });
  assert.deepEqual([inside.trimStart.gapWord, inside.trimStart.extend], ["w048126", false]);
  assert.deepEqual([inside.trimEnd.gapWord, inside.trimEnd.extend], ["w048128", false]);
  const outside = selectionActions(model, selectOne(1), { readOnly: false });
  assert.deepEqual([outside.trimStart.gapWord, outside.trimStart.extend], ["w048122", true]);
  assert.equal(outside.edit.enabled, true);
  assert.equal(outside.edit.index, 1);
});

test("make cold open is enabled only for a selection inside 0.5–8 s", () => {
  const model = buildTranscriptModel(fakeWords(), fakeDoc());
  const good = selectionActions(model, extendTo(selectOne(6), 8), { readOnly: false });
  assert.equal(good.coldOpen.enabled, true);
  assert.deepEqual([good.coldOpen.firstWord, good.coldOpen.lastWord], ["w048127", "w048129"]);
  const tiny = selectionActions(model, selectOne(3), { readOnly: false });
  assert.equal(tiny.coldOpen.enabled, false);
  assert.match(tiny.coldOpen.reason, /0,5 dtk/);
});

test("keys map to transcript actions only without stray modifiers", () => {
  const key = (k, mods = {}) => keyAction({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.equal(key("Delete"), "remove");
  assert.equal(key("Backspace"), "remove");
  assert.equal(key("Enter"), "edit");
  assert.equal(key("x", { ctrlKey: true, shiftKey: true }), "hide");
  assert.equal(key("X", { ctrlKey: true, shiftKey: true }), "hide");
  assert.equal(key("e", { ctrlKey: true }), "emphasis");
  assert.equal(key("E", { metaKey: true }), "emphasis");
  assert.equal(key("i"), "trimStart");
  assert.equal(key("I"), "trimStart");
  assert.equal(key("o"), "trimEnd");
  assert.equal(key("h", { ctrlKey: true, shiftKey: true }), "coldOpen");
  assert.equal(key("Escape"), "clear");
  assert.equal(key("ArrowRight"), "next");
  assert.equal(key("ArrowLeft", { shiftKey: true }), "extendPrev");
  assert.equal(key("ArrowDown"), "lineDown");
  assert.equal(key("ArrowUp", { shiftKey: true }), "extendLineUp");
  assert.equal(key("i", { ctrlKey: true }), null);
  assert.equal(key("e", { ctrlKey: true, shiftKey: true }), null);
  assert.equal(key("Delete", { altKey: true }), null);
  assert.equal(key(" "), null);
  assert.equal(key("z", { ctrlKey: true }), null);
});
