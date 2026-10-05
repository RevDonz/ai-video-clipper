// The Teks caption rows (docs/plans/2026-10-02-editor-mode-cepat.md §2.1, §1.3): one row per plan
// cue, keyed by segment and first word, with the document's hidden words dropped before the next
// plan and the hidden neighbours a retype can bring back. Z0 lands `captionRows` and
// `linesSummary`; task C adds the line diff (§2.3) and its tests here.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { captionRows, linesSummary } from "../lib/editor/caption-lines.mjs";
import { pieces as piecesOf, sfFloor } from "../lib/editor/timemap.mjs";

const WORDS = fakeWords();
const ID = WORDS.words.map((word) => word.id); // ID[0] "Kenapa" … ID[11] "subuh"
const FPS = WORDS.fps;

// A clip with a cold open of "Jadi waktu itu" (ID[6..8]) played before the body.
function coldOpenDoc() {
  const doc = fakeDoc();
  doc.main.segments = [
    { id: "seg_co", role: "cold_open", in_sf: 37320, out_sf: 37350 },
    { id: "seg_b1", role: "body", in_sf: 37215, out_sf: 37515 },
  ];
  return doc;
}

function withEdits(doc, edits) {
  doc.captions.word_edits = { ...doc.captions.word_edits, ...edits };
  return doc;
}

// The plan's cues as the engine groups them: per segment, at most 4 words, a break after "?".
function planOf(doc, groups) {
  const list = piecesOf(doc);
  const at = (seg, id) => {
    const word = WORDS.words.find((entry) => entry.id === id);
    const sf = sfFloor(word.s, FPS);
    const piece = list.find((entry) => entry.seg === seg && entry.inSf <= sf && sf < entry.outSf)
      ?? list.find((entry) => entry.seg === seg);
    return piece.outF0 + Math.max(0, sf - piece.inSf);
  };
  const cues = groups.map(([seg, ids]) => ({
    f0: at(seg, ids[0]), f1: at(seg, ids.at(-1)) + 8, text: "ignored by the rows", words: ids,
  }));
  return { fps: FPS, pieces: list, totalFrames: list.reduce((sum, piece) => sum + piece.frames, 0), cues };
}

const COLD_GROUPS = [
  ["seg_co", ID.slice(6, 9)],
  ["seg_b1", ID.slice(0, 4)],
  ["seg_b1", ID.slice(4, 6)],
  ["seg_b1", ID.slice(6, 10)],
  ["seg_b1", ID.slice(10, 12)],
];

function rowsOf(doc, groups = COLD_GROUPS) {
  return captionRows({ plan: planOf(doc, groups), doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
}

test("one row per cue in plan order, keyed by segment and first word, with a cold-open line and its body twin", () => {
  const rows = rowsOf(coldOpenDoc());
  assert.deepEqual(rows.map((row) => row.key), [
    `seg_co:${ID[6]}`, `seg_b1:${ID[0]}`, `seg_b1:${ID[4]}`, `seg_b1:${ID[6]}`, `seg_b1:${ID[10]}`,
  ]);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
  assert.deepEqual(rows.map((row) => [row.seg, row.cold]), [
    ["seg_co", true], ["seg_b1", false], ["seg_b1", false], ["seg_b1", false], ["seg_b1", false],
  ]);
  assert.deepEqual(rows.map((row) => row.text), [
    "Jadi waktu itu", "Kenapa sutradara ditahan di", "film sendiri?", "Jadi waktu itu kita", "datang subuh",
  ]);
  assert.deepEqual(rows[1].wordIds, ID.slice(0, 4));
  assert.ok(rows.every((row) => row.hiddenIds.length === 0 && row.edited === false));
});

test("f0 and f1 are the cue's own frames, and the segment comes from the piece holding f0", () => {
  const doc = coldOpenDoc();
  const plan = planOf(doc, COLD_GROUPS);
  const rows = captionRows({ plan, doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
  assert.deepEqual(rows.map((row) => [row.f0, row.f1]), plan.cues.map((cue) => [cue.f0, cue.f1]));
  assert.ok(rows[0].f0 < 30 && rows[1].f0 >= 30, "the cold open is output frames [0, 30)");
});

test("the text is the stored word text (edits applied, punctuation kept), and edited marks a changed visible word", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[1]]: { text: "sutradaranya," }, [ID[5]]: { text: "sendiri?" } });
  const rows = rowsOf(doc);
  assert.equal(rows[1].text, "Kenapa sutradaranya, ditahan di");
  assert.equal(rows[1].edited, true);
  assert.equal(rows[2].text, "film sendiri?");
  assert.equal(rows[2].edited, false, "an edit equal to the ASR text is no change");
});

test("upper case shows through CSS only: the row keeps the stored case", () => {
  const doc = coldOpenDoc();
  doc.captions.pack = { id: "bold", v: 1 };
  doc.captions.overrides.case = "upper";
  assert.equal(rowsOf(doc)[1].text, "Kenapa sutradara ditahan di");
});

test("a word the document hides leaves its row at once, before the next plan, and the key stays", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[1]]: { hidden: true } });
  const rows = rowsOf(doc);
  assert.equal(rows[1].key, `seg_b1:${ID[0]}`);
  assert.deepEqual(rows[1].wordIds, [ID[0], ID[2], ID[3]]);
  assert.equal(rows[1].text, "Kenapa ditahan di");
  assert.deepEqual(rows[1].hiddenIds, [ID[1]]);
});

test("a row whose words are all hidden is dropped", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[4]]: { hidden: true }, [ID[5]]: { hidden: true } });
  const rows = rowsOf(doc);
  assert.equal(rows.length, 4);
  assert.ok(!rows.some((row) => row.key === `seg_b1:${ID[4]}`));
  assert.deepEqual(rows[1].hiddenIds, [ID[4], ID[5]], "the previous row offers them back, up to the next visible word");
});

test("hidden neighbours reach to the visible word on each side, in word order", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[3]]: { hidden: true }, [ID[4]]: { hidden: true } });
  const rows = rowsOf(doc);
  assert.deepEqual(rows[1].wordIds, ID.slice(0, 3));
  assert.deepEqual(rows[1].hiddenIds, [ID[3], ID[4]]);
  assert.deepEqual(rows[2].wordIds, [ID[5]]);
  assert.deepEqual(rows[2].hiddenIds, [ID[3], ID[4]]);
});

test("a cold-open row offers only words the cold open keeps; its body twin offers its own neighbours", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[7]]: { hidden: true }, [ID[9]]: { hidden: true } });
  const rows = rowsOf(doc);
  assert.deepEqual(rows[0].wordIds, [ID[6], ID[8]]);
  assert.deepEqual(rows[0].hiddenIds, [ID[7]], "kita is not in the cold open");
  assert.deepEqual(rows[3].wordIds, [ID[6], ID[8]]);
  assert.deepEqual(rows[3].hiddenIds, [ID[7], ID[9]]);
});

test("a hidden word that a cut removes is not offered back", () => {
  const doc = withEdits(fakeDoc(), { [ID[2]]: { hidden: true } });
  doc.main.removals = [{ id: "rm_1", seg: "seg_b1", in_sf: 37250, out_sf: 37258 }];
  const groups = [["seg_b1", [ID[0], ID[1], ID[3], ID[4]]], ["seg_b1", [ID[5]]]];
  const rows = rowsOf(doc, groups);
  assert.deepEqual(rows[0].wordIds, [ID[0], ID[1], ID[3], ID[4]]);
  assert.deepEqual(rows[0].hiddenIds, []);
  const uncut = withEdits(fakeDoc(), { [ID[2]]: { hidden: true } });
  assert.deepEqual(rowsOf(uncut, [["seg_b1", ID.slice(0, 4)]])[0].hiddenIds, [ID[2]]);
});

test("without a plan or words there are no rows; without the transcript model no word is offered back", () => {
  const doc = withEdits(coldOpenDoc(), { [ID[1]]: { hidden: true } });
  assert.deepEqual(captionRows({ plan: null, doc, words: WORDS }), []);
  assert.deepEqual(captionRows({ plan: planOf(doc, COLD_GROUPS), doc, words: null }), []);
  const rows = captionRows({ plan: planOf(doc, COLD_GROUPS), doc, words: WORDS });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((row) => row.hiddenIds.length === 0));
});

test("linesSummary: rows, changed rows, captions off, and not ready yet", () => {
  const doc = coldOpenDoc();
  const plan = planOf(doc, COLD_GROUPS);
  assert.equal(linesSummary({ plan, doc, words: WORDS }), "5 baris");
  const edited = withEdits(coldOpenDoc(), { [ID[1]]: { text: "sutradaranya" }, [ID[11]]: { text: "pagi" } });
  assert.equal(linesSummary({ plan, doc: edited, words: WORDS }), "5 baris · 2 diubah");
  const hidden = withEdits(coldOpenDoc(), { [ID[10]]: { hidden: true }, [ID[11]]: { hidden: true } });
  assert.equal(linesSummary({ plan, doc: hidden, words: WORDS }), "4 baris");
  const off = coldOpenDoc();
  off.captions.enabled = false;
  assert.equal(linesSummary({ plan: { ...plan, cues: [] }, doc: off, words: WORDS }), "Caption mati");
  assert.equal(linesSummary({ plan: null, doc: off, words: WORDS }), "Caption mati");
  assert.equal(linesSummary({ plan: null, doc, words: WORDS }), "Menyiapkan…");
  assert.equal(linesSummary({ plan, doc, words: null }), "Menyiapkan…");
  assert.equal(linesSummary({ plan, doc: null, words: WORDS }), "Menyiapkan…");
});
