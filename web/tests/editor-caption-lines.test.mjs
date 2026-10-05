// The Teks caption rows (docs/plans/2026-10-02-editor-mode-cepat.md §2): one row per plan cue,
// keyed by segment and first word, with the document's hidden words dropped before the next plan
// and the hidden neighbours a retype can bring back (§2.1); a line edit as word edits (§2.3), its
// limits (§2.4), the atomic commit, one undo step, the two-tab merge and the focus rule (§2.5);
// and the fakes' engine-like cues (§2.6).
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import {
  LINE_LIMITS, LINE_MESSAGES, captionRows, checkCommands, commitLine, focusAfterRegroup, lineEdit, linesSummary, rowAtFrame,
} from "../lib/editor/caption-lines.mjs";
import { COMMAND_MESSAGES, CommandRejected, applyCommand } from "../lib/editor/commands.mjs";
import { LIMITS, contentJson, createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";
import { rebase } from "../lib/editor/rebase.mjs";
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

// ---------------------------------------------------------------------------------------------
// The fakes' cues (§2.6): like the engine, in small.

const CTX = createContext({ words: WORDS, seed: fakeDoc() });
const cueIds = (plan) => plan.cues.map((cue) => cue.words);
const segAt = (plan, frame) => plan.pieces.find((piece) => piece.outF0 <= frame && frame < piece.outF0 + piece.frames)?.seg ?? null;

// The fakes' seed with a cold open of "Jadi waktu itu" (ID[6..8]) set by the real command, so the
// document is valid for every command the tests run on it.
function realColdOpenDoc() {
  return applyCommand(fakeDoc(), "SetColdOpen", { firstWord: ID[6], lastWord: ID[8] }, CTX).doc;
}

test("fakePlan groups like the engine: at most 4 words, a break after a sentence end", () => {
  const plan = fakePlan(fakeDoc());
  assert.deepEqual(cueIds(plan), [ID.slice(0, 4), ID.slice(4, 6), ID.slice(6, 10), ID.slice(10, 12)]);
  assert.deepEqual(plan.cues.map((cue) => cue.text), ["Kenapa sutradara ditahan di", "film sendiri?", "Jadi waktu itu kita", "datang subuh"]);
  const edited = withEdits(fakeDoc(), { [ID[1]]: { text: "sutradara." }, [ID[5]]: { text: "sendiri" } });
  assert.deepEqual(cueIds(fakePlan(edited)), [ID.slice(0, 2), ID.slice(2, 6), ID.slice(6, 10), ID.slice(10, 12)],
    "a typed '.' splits a cue and a removed '?' joins two");
  const closer = withEdits(fakeDoc(), { [ID[2]]: { text: "ditahan!\")" } });
  assert.deepEqual(cueIds(fakePlan(closer))[0], ID.slice(0, 3), "trailing closers are ignored");
});

test("fakePlan skips hidden words, so the 4-word groups after them shift", () => {
  const doc = withEdits(fakeDoc(), { [ID[1]]: { hidden: true } });
  assert.deepEqual(cueIds(fakePlan(doc)), [[ID[0], ID[2], ID[3], ID[4]], [ID[5]], ID.slice(6, 10), ID.slice(10, 12)]);
});

test("fakePlan captions a cold-open word in the cold open and in the body, at each piece's frames", () => {
  const doc = realColdOpenDoc();
  const plan = fakePlan(doc);
  assert.deepEqual(cueIds(plan), [ID.slice(6, 9), ID.slice(0, 4), ID.slice(4, 6), ID.slice(6, 10), ID.slice(10, 12)]);
  assert.deepEqual(plan.pieces, piecesOf(doc));
  const co = plan.pieces.find((piece) => piece.role === "cold_open");
  const body = plan.pieces.find((piece) => piece.role === "body");
  const onFrame = (id, piece) => {
    const word = WORDS.words.find((entry) => entry.id === id);
    return piece.outF0 + Math.round((word.s * FPS[0]) / (1000 * FPS[1]) - piece.inSf);
  };
  assert.ok(Math.abs(plan.cues[0].f0 - onFrame(ID[6], co)) <= 1, "the cold-open line starts at its own frame");
  assert.ok(Math.abs(plan.cues[3].f0 - onFrame(ID[6], body)) <= 1, "its body twin starts at the body's frame");
  assert.deepEqual([segAt(plan, plan.cues[0].f0), segAt(plan, plan.cues[3].f0)], [co.seg, body.seg]);
});

test("fakePlan cues start at their first word, end after it, and never overlap within a segment", () => {
  for (const doc of [fakeDoc(), realColdOpenDoc()]) {
    const plan = fakePlan(doc);
    plan.cues.forEach((cue, index) => {
      assert.ok(cue.f1 > cue.f0, `cue ${index} has frames`);
      const next = plan.cues[index + 1];
      if (next && segAt(plan, next.f0) === segAt(plan, cue.f0)) assert.ok(cue.f1 <= next.f0, `cue ${index} ends before the next`);
    });
  }
});

test("fakePlan splits Box cues over 24 characters (a stand-in for the font measure), and shows upper case", () => {
  const box = fakeDoc();
  box.captions.pack = { id: "box", v: 1 };
  const plan = fakePlan(box);
  assert.deepEqual(cueIds(plan), [ID.slice(0, 3), [ID[3]], ID.slice(4, 6), ID.slice(6, 10), ID.slice(10, 12)]);
  assert.equal(plan.cues[0].text, "Kenapa sutradara ditahan");
  assert.equal(plan.cues[0].f1, plan.cues[1].f0, "a split part runs up to the next part");
  const bold = fakeDoc();
  bold.captions.pack = { id: "bold", v: 1 };
  bold.captions.overrides.case = "upper";
  assert.equal(fakePlan(bold).cues[0].text, "KENAPA SUTRADARA DITAHAN DI");
  const off = fakeDoc();
  off.captions.enabled = false;
  assert.deepEqual(fakePlan(off).cues, []);
});

test("captionRows over fakePlan: unique keys for a cold-open line and its body twin", () => {
  const doc = realColdOpenDoc();
  const rows = captionRows({ plan: fakePlan(doc), doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
  assert.equal(rows.length, 5);
  assert.equal(new Set(rows.map((row) => row.key)).size, 5);
  assert.deepEqual(rows.filter((row) => row.text === "Jadi waktu itu").map((row) => [row.seg, row.cold]), [["seg_co", true]]);
  assert.deepEqual(rows[3].wordIds.slice(0, 3), rows[0].wordIds, "the body twin holds the same words");
});

// ---------------------------------------------------------------------------------------------
// A line edit as word edits (§2.3). The spec's row is `mulai aja dulu dari` (w1 w2 w3 w4).

const TABLE_WORDS = (() => {
  const words = fakeWords();
  ["mulai", "aja", "dulu", "dari"].forEach((text, index) => { words.words[index].t = text; });
  return words;
})();
const TABLE_CTX = createContext({ words: TABLE_WORDS, seed: fakeDoc() });
const [W1, W2, W3, W4] = ID;
const edit = (wordId, text) => ({ type: "EditWordText", args: { wordId, text } });
const hide = (wordId, on = true) => ({ type: "SetWordHidden", args: { wordId, on } });

function tableRows(doc, words = TABLE_WORDS) {
  const plan = planOf(doc, [["seg_b1", ID.slice(0, 4)], ["seg_b1", ID.slice(4, 6)], ["seg_b1", ID.slice(6, 12)]]);
  return captionRows({ plan, doc, words, model: buildTranscriptModel(words, doc) });
}

function editRow(doc, draft, { upper = doc.captions.overrides.case === "upper" } = {}) {
  return lineEdit({ row: tableRows(doc)[0], draft, doc, words: TABLE_WORDS, upper });
}

function boldDoc() {
  const doc = fakeDoc();
  doc.captions.pack = { id: "bold", v: 1 };
  doc.captions.overrides.case = "upper";
  return doc;
}

test("§2.3 table: insert, delete, retype a deleted word, change, prepend, two changes, Bold, empty", () => {
  const doc = fakeDoc();
  assert.equal(tableRows(doc)[0].text, "mulai aja dulu dari");
  assert.deepEqual(editRow(doc, "mulai aja dulu ya dari"), { ok: true, commands: [edit(W3, "dulu ya")] });
  assert.deepEqual(editRow(doc, "mulai dulu dari"), { ok: true, commands: [hide(W2)] });
  const w2Hidden = withEdits(fakeDoc(), { [W2]: { hidden: true } });
  assert.equal(tableRows(w2Hidden)[0].text, "mulai dulu dari");
  assert.deepEqual(editRow(w2Hidden, "mulai aja dulu dari"), { ok: true, commands: [hide(W2, false)] });
  assert.deepEqual(editRow(doc, "mulai aja duluan dari"), { ok: true, commands: [edit(W3, "duluan")] });
  assert.deepEqual(editRow(doc, "Yuk mulai aja dulu dari"), { ok: true, commands: [edit(W1, "Yuk mulai")] });
  assert.deepEqual(editRow(doc, "mulai saja deh dari"), { ok: true, commands: [edit(W2, "saja"), edit(W3, "deh")] });
  assert.deepEqual(editRow(boldDoc(), "MULAI AJA DULU DARI"), { ok: true, commands: [] });
  assert.deepEqual(editRow(doc, ""), { ok: true, commands: [hide(W1), hide(W2), hide(W3), hide(W4)] });
});

test("a draft equal to the row's text commits nothing: spaces, Unicode spaces and NFC are normalised", () => {
  const doc = fakeDoc();
  for (const draft of ["mulai aja dulu dari", "  mulai   aja dulu dari ", "mulai aja dulu  dari"]) {
    assert.deepEqual(editRow(doc, draft), { ok: true, commands: [] }, JSON.stringify(draft));
  }
  const accented = withEdits(fakeDoc(), { [W3]: { text: "dulú" } });
  assert.deepEqual(editRow(accented, "mulai aja dulú dari"), { ok: true, commands: [] }, "a decomposed accent is the same word");
  const twoTokenWord = withEdits(fakeDoc(), { [W3]: { text: "dulu ya" } });
  assert.deepEqual(editRow(twoTokenWord, "mulai aja dulu ya dari"), { ok: true, commands: [] }, "a word edited into two tokens");
  assert.deepEqual(editRow(twoTokenWord, "mulai aja dulu dari"), { ok: true, commands: [edit(W3, "dulu")] });
});

test("deleting a word and typing it back unhides it: SetWordHidden off and no EditWordText, the seed's content again", () => {
  const seed = fakeDoc();
  const session = createEditSession({ doc: seed, ctx: TABLE_CTX });
  const run = (commands) => commands.forEach(({ type, args }) => session.dispatch(type, args));
  run(editRow(session.doc, "mulai dulu dari").commands);
  const retyped = editRow(session.doc, "mulai aja dulu dari");
  assert.deepEqual(retyped.commands, [hide(W2, false)]);
  run(retyped.commands);
  assert.equal(contentJson(session.doc), contentJson(seed));
});

test("Bold: the viewer retypes upper case; a case-only difference keeps the stored text", () => {
  const doc = boldDoc();
  assert.deepEqual(editRow(doc, "mulai AJA Dulu dari"), { ok: true, commands: [] });
  assert.deepEqual(editRow(doc, "MULAI AJA DULUAN DARI"), { ok: true, commands: [edit(W3, "DULUAN")] }, "a changed word is stored as typed");
  const hidden = withEdits(boldDoc(), { [W2]: { hidden: true } });
  assert.deepEqual(editRow(hidden, "MULAI AJA DULU DARI"), { ok: true, commands: [hide(W2, false)] });
  assert.deepEqual(editRow(fakeDoc(), "mulai AJA dulu dari", { upper: false }), { ok: true, commands: [edit(W2, "AJA")] },
    "without upper case the match is exact");
});

test("insertions ride on a host: the word before, a preceding anchor, else the first anchor after (both ends at once)", () => {
  const doc = fakeDoc();
  assert.deepEqual(editRow(doc, "mulai saja deh banget dari"), { ok: true, commands: [edit(W2, "saja"), edit(W3, "deh banget")] });
  assert.deepEqual(editRow(doc, "Yuk mulai ya aja dulu dari"), { ok: true, commands: [edit(W1, "Yuk mulai ya")] });
  assert.deepEqual(editRow(doc, "mulai aja dulu dari nih"), { ok: true, commands: [edit(W4, "dari nih")] });
  const w2Hidden = withEdits(fakeDoc(), { [W2]: { hidden: true } });
  assert.deepEqual(editRow(w2Hidden, "mulai aja deh dulu dari"), { ok: true, commands: [hide(W2, false), edit(W2, "aja deh")] },
    "an unhidden anchor hosts an insertion");
  const w1Hidden = withEdits(fakeDoc(), { [W1]: { hidden: true } });
  assert.deepEqual(tableRows(w1Hidden)[0].hiddenIds, [W1]);
  assert.deepEqual(editRow(w1Hidden, "Yuk mulai aja dulu dari"), { ok: true, commands: [hide(W1, false), edit(W1, "Yuk mulai")] });
});

test("a hidden word that is not an anchor stays hidden; among equal anchors the fewest hidden words win", () => {
  const w2Hidden = withEdits(fakeDoc(), { [W2]: { hidden: true } });
  assert.deepEqual(editRow(w2Hidden, "mulai dulu deh dari"), { ok: true, commands: [edit(W3, "dulu deh")] });
  const words = fakeWords();
  ["ya", "ya", "oke", "dong"].forEach((text, index) => { words.words[index].t = text; });
  const doc = withEdits(fakeDoc(), { [W1]: { hidden: true } });
  const row = tableRows(doc, words)[0];
  assert.deepEqual([row.wordIds, row.hiddenIds], [[W2, W3, W4], [W1]]);
  assert.deepEqual(lineEdit({ row, draft: "ya oke deh", doc, words, upper: false }), { ok: true, commands: [edit(W4, "deh")] },
    "the visible 'ya' is the anchor, the hidden one stays hidden");
  assert.deepEqual(lineEdit({ row, draft: "ya ya oke dong", doc, words, upper: false }), { ok: true, commands: [hide(W1, false)] });
});

// ---------------------------------------------------------------------------------------------
// Limits and messages (§2.4).

test("§2.4: more than 40 tokens, a word text over 40 code points, control or lone-surrogate characters", () => {
  const doc = fakeDoc();
  assert.equal(LINE_LIMITS.tokens, 40);
  const nine = Array(9).fill("x").join(" ");
  const forty = `mulai ${nine} aja ${nine} dulu ${nine} dari ${nine}`;
  assert.equal(forty.split(" ").length, 40);
  assert.equal(editRow(doc, forty).ok, true);
  assert.deepEqual(editRow(doc, `${forty} x`), { ok: false, code: "too_many_tokens", message: "Terlalu banyak kata dalam satu baris." });
  assert.equal(LINE_MESSAGES.too_many_tokens, "Terlalu banyak kata dalam satu baris.");

  assert.deepEqual(editRow(doc, "mulai aja dulu satu dua tiga empat lima enam tujuh delapan dari"), {
    ok: false, code: "text_too_long", message: "Teks baru di satu tempat terlalu panjang (maks. 40 huruf). Persingkat tambahannya.",
  });
  const emoji = "\u{1F600}".repeat(LIMITS.wordText - 5);
  assert.equal(editRow(doc, `mulai aja dulu ${emoji} dari`).ok, true, "40 code points fit (code points, not UTF-16 units)");
  assert.equal(editRow(doc, `mulai aja dulu ${emoji}\u{1F600} dari`).code, "text_too_long");

  for (const draft of ["mulai\u0007 aja dulu dari", "mulai\taja dulu dari", "mulai \ud800 aja dulu dari"]) {
    assert.deepEqual(editRow(doc, draft), { ok: false, code: "text_invalid", message: COMMAND_MESSAGES.text_invalid }, JSON.stringify(draft));
  }
});

test("§2.4: over 6000 word edits is refused by the dry run with the command's message", () => {
  const count = LIMITS.wordEdits + 1;
  const big = { ...fakeWords(), words: Array.from({ length: count }, (_, index) => ({
    id: `w${200000 + index}`, s: 1181900 + index * 30, e: 1181920 + index * 30, t: `kata${index}`, p_pm: 900, u: "S0011", z: false,
  })), bounds: [], gaps: [] };
  const ctx = createContext({ words: big, seed: fakeDoc() });
  const doc = fakeDoc();
  doc.captions.word_edits = Object.fromEntries(big.words.slice(0, LIMITS.wordEdits).map((word) => [word.id, { hidden: true }]));
  const last = big.words.at(-1);
  const row = { key: `seg_b1:${last.id}`, seg: "seg_b1", cold: false, f0: 0, f1: 10, wordIds: [last.id], hiddenIds: [], text: last.t, edited: false };
  assert.deepEqual(lineEdit({ row, draft: "baru", doc, words: big, upper: false }), { ok: true, commands: [edit(last.id, "baru")] });
  assert.deepEqual(commitLine({ row, draft: "baru", doc, words: big, upper: false, ctx, mergeKey: "tx:captionLine:1" }),
    { ok: false, code: "too_many_word_edits", message: COMMAND_MESSAGES.too_many_word_edits });
});

// ---------------------------------------------------------------------------------------------
// Atomic commit, one undo step, two tabs (§2.5).

test("checkCommands folds the commands over the document; the first refusal refuses them all", () => {
  const doc = fakeDoc();
  const before = JSON.stringify(doc);
  assert.deepEqual(checkCommands(doc, TABLE_CTX, [edit(W1, "Yuk"), edit("w999999", "x"), hide(W3)]),
    { ok: false, code: "unknown_word", message: COMMAND_MESSAGES.unknown_word });
  assert.equal(JSON.stringify(doc), before, "the document is never changed");
  const good = checkCommands(doc, TABLE_CTX, [edit(W1, "Yuk"), hide(W3)]);
  assert.equal(good.ok, true);
  assert.deepEqual(good.doc.captions.word_edits, { [W1]: { text: "Yuk" }, [W3]: { hidden: true } });
  assert.deepEqual(checkCommands(doc, TABLE_CTX, []), { ok: true, doc });
  assert.throws(() => checkCommands(doc, null, [edit(W1, "Yuk")]), TypeError, "a bug is not a refusal");
  assert.ok(new CommandRejected("text_invalid").message === COMMAND_MESSAGES.text_invalid);
});

test("commitLine: lineEdit, the dry run, one merge key on every command; an empty draft hides the row", () => {
  const doc = fakeDoc();
  const base = { row: tableRows(doc)[0], doc, words: TABLE_WORDS, upper: false, ctx: TABLE_CTX, mergeKey: "tx:captionLine:7" };
  assert.deepEqual(commitLine({ ...base, draft: "mulai saja deh dari" }), { ok: true, hidesRow: false, commands: [
    { ...edit(W2, "saja"), mergeKey: "tx:captionLine:7" }, { ...edit(W3, "deh"), mergeKey: "tx:captionLine:7" },
  ] });
  const empty = commitLine({ ...base, draft: "  " });
  assert.equal(empty.hidesRow, true);
  assert.equal(empty.commands.length, 4);
  assert.ok(empty.commands.every((command) => command.mergeKey === "tx:captionLine:7" && command.args.on === true));
  assert.deepEqual(commitLine({ ...base, draft: "mulai aja dulu dari" }), { ok: true, hidesRow: false, commands: [] });
  assert.deepEqual(commitLine({ ...base, draft: "a\u0000" }), { ok: false, code: "text_invalid", message: COMMAND_MESSAGES.text_invalid });
});

test("one commit is one undo step, inside the history's merge window; the next commit is another", () => {
  let t = 1000;
  const seed = fakeDoc();
  const session = createEditSession({ doc: seed, ctx: TABLE_CTX, now: () => (t += 1) });
  const commit = (draft, mergeKey) => {
    const result = commitLine({ row: tableRows(session.doc)[0], draft, doc: session.doc, words: TABLE_WORDS, upper: false, ctx: TABLE_CTX, mergeKey });
    assert.equal(result.ok, true);
    for (const { type, args, mergeKey: key } of result.commands) session.dispatch(type, args, { mergeKey: key });
    return result.commands.length;
  };
  assert.equal(commit("Yuk mulai saja deh", "tx:captionLine:1"), 4);
  assert.equal(session.history.size, 1, "four commands, one entry");
  const once = contentJson(session.doc);
  assert.equal(commit("Yuk mulai saja", "tx:captionLine:2"), 1);
  assert.equal(session.history.size, 2);
  session.undo();
  assert.equal(contentJson(session.doc), once);
  session.undo();
  assert.equal(contentJson(session.doc), contentJson(seed));
});

test("two tabs editing different words of one row merge (per-word parts)", () => {
  const seed = fakeDoc();
  const row = captionRows({ plan: fakePlan(seed), doc: seed, words: WORDS, model: buildTranscriptModel(WORDS, seed) })[0];
  assert.equal(row.text, "Kenapa sutradara ditahan di");
  const tab = (draft) => {
    const session = createEditSession({ doc: seed, ctx: CTX });
    const result = commitLine({ row, draft, doc: seed, words: WORDS, upper: false, ctx: CTX, mergeKey: "tx:captionLine:1" });
    for (const { type, args, mergeKey } of result.commands) session.dispatch(type, args, { mergeKey });
    return session;
  };
  const mine = tab("sutradara ditahan di sini");
  const theirs = tab("Kenapa sutradaranya ditahan di");
  const merged = rebase({ base: seed, mine: mine.doc, theirs: theirs.doc, steps: mine.pending, ctx: CTX });
  assert.equal(merged.status, "merged");
  assert.deepEqual(merged.doc.captions.word_edits, { [ID[0]]: { hidden: true }, [ID[1]]: { text: "sutradaranya" }, [ID[3]]: { text: "di sini" } });
});

// ---------------------------------------------------------------------------------------------
// Focus across regrouping (§2.5) and the row under the playhead.

function rowsFor(doc) {
  return captionRows({ plan: fakePlan(doc), doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
}
const key = (index, seg = "seg_b1") => `${seg}:${ID[index]}`;

test("focusAfterRegroup keeps a key that survives: a '.' typed in Karaoke, a Box split", () => {
  const seed = rowsFor(fakeDoc());
  const dot = rowsFor(withEdits(fakeDoc(), { [ID[1]]: { text: "sutradara." } }));
  assert.deepEqual(dot.map((row) => row.key), [key(0), key(2), key(6), key(10)]);
  assert.equal(focusAfterRegroup(seed, dot, key(0)), key(0));
  const box = () => {
    const doc = fakeDoc();
    doc.captions.pack = { id: "box", v: 1 };
    return doc;
  };
  const before = rowsFor(box());
  const after = rowsFor(withEdits(box(), { [ID[1]]: { text: "sutradaranya" } }));
  assert.deepEqual(before.slice(0, 2).map((row) => row.text), ["Kenapa sutradara ditahan", "di"]);
  assert.deepEqual(after.slice(0, 2).map((row) => row.text), ["Kenapa sutradaranya", "ditahan di"]);
  assert.equal(focusAfterRegroup(before, after, key(0)), key(0));
  assert.equal(focusAfterRegroup(before, after, key(3)), key(2), "the row that now holds the focused row's first word");
});

test("focusAfterRegroup: a join, a hidden first word, then the next row, the previous row, the status line", () => {
  const seed = rowsFor(fakeDoc());
  const joined = rowsFor(withEdits(fakeDoc(), { [ID[5]]: { text: "sendiri" } }));
  assert.deepEqual(joined.map((row) => row.key), [key(0), key(4), key(8)]);
  assert.equal(focusAfterRegroup(seed, joined, key(6)), key(4));

  const hiding = withEdits(fakeDoc(), { [ID[4]]: { hidden: true } });
  const beforePlan = captionRows({ plan: fakePlan(fakeDoc()), doc: hiding, words: WORDS, model: buildTranscriptModel(WORDS, hiding) });
  assert.deepEqual([beforePlan[1].key, beforePlan[1].wordIds], [key(4), [ID[5]]], "the row drops the word before the next plan, under its old key");
  assert.equal(focusAfterRegroup(beforePlan, rowsFor(hiding), key(4)), key(5));

  const gone = rowsFor(withEdits(fakeDoc(), { [ID[4]]: { hidden: true }, [ID[5]]: { hidden: true } }));
  assert.equal(focusAfterRegroup(seed, gone, key(4)), key(6), "the first row at or after the old start");
  const last = rowsFor(withEdits(fakeDoc(), { [ID[10]]: { hidden: true }, [ID[11]]: { hidden: true } }));
  assert.equal(focusAfterRegroup(seed, last, key(10)), key(6), "else the previous row");
  assert.equal(focusAfterRegroup(seed, [], key(10)), null, "else the status line");
  assert.equal(focusAfterRegroup(seed, seed, null), null);
  assert.equal(focusAfterRegroup(seed, seed, "seg_b1:w000000"), null, "an unknown key");
});

test("focusAfterRegroup stays in the focused row's segment (a cold-open line and its body twin)", () => {
  const before = rowsFor(realColdOpenDoc());
  const hidden = withEdits(realColdOpenDoc(), { [ID[6]]: { hidden: true }, [ID[7]]: { hidden: true }, [ID[8]]: { hidden: true } });
  const after = rowsFor(hidden);
  assert.ok(!after.some((row) => row.cold));
  assert.equal(focusAfterRegroup(before, after, key(6, "seg_co")), null, "the cold open has no row left");
  assert.equal(focusAfterRegroup(before, after, key(6)), key(9), "the body twin moves on in the body");
});

test("rowAtFrame: the row whose frames hold the playhead, none in a gap", () => {
  const rows = rowsFor(fakeDoc());
  assert.ok(rows[0].f0 > 0);
  assert.equal(rowAtFrame(rows, rows[1].f0)?.key, rows[1].key);
  assert.equal(rowAtFrame(rows, rows[1].f1 - 1)?.key, rows[1].key);
  assert.equal(rowAtFrame(rows, rows[1].f1)?.key ?? null, rows[2].f0 === rows[1].f1 ? rows[2].key : null);
  assert.equal(rowAtFrame(rows, rows[0].f0 - 1), null);
  assert.equal(rowAtFrame([], 10), null);
});

// ---------------------------------------------------------------------------------------------
// Property (§9.2): random drafts over random rows with hidden neighbours.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ["ya", "deh", "Yuk", "nih", "banget", "loh", "itu", "di", "Kenapa", "film", "kok.", "gitu?"];
const EDIT_TEXTS = ["kata", "dua kata", "ya.", "Sutradaranya", "itu", "di sini"];

function randomDoc(rng) {
  const doc = rng() < 0.35 ? realColdOpenDoc() : fakeDoc();
  const pack = ["karaoke", "bold", "box", "classic"][Math.floor(rng() * 4)];
  doc.captions.pack = { id: pack, v: 1 };
  doc.captions.overrides.case = pack === "bold" ? "upper" : "asis";
  const edits = {};
  for (const id of ID) {
    const entry = {};
    if (rng() < 0.22) entry.hidden = true;
    if (rng() < 0.15) entry.text = EDIT_TEXTS[Math.floor(rng() * EDIT_TEXTS.length)];
    if (Object.keys(entry).length) edits[id] = entry;
  }
  doc.captions.word_edits = edits;
  return doc;
}

function randomDraft(rng, row, doc, upper) {
  const roll = rng();
  if (roll < 0.05) return { draft: "", unchanged: false };
  const tokens = row.text.split(" ");
  if (roll < 0.1) return { draft: tokens.join(" "), unchanged: true };
  const hiddenTexts = row.hiddenIds.map((id) => doc.captions.word_edits[id]?.text ?? WORDS.words.find((word) => word.id === id).t);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const ops = 1 + Math.floor(rng() * 3);
  for (let op = 0; op < ops; op += 1) {
    const at = Math.floor(rng() * (tokens.length + 1));
    const kind = rng();
    if (kind < 0.25 && tokens.length) tokens.splice(Math.min(at, tokens.length - 1), 1);
    else if (kind < 0.5) tokens.splice(at, 0, pick(VOCAB));
    else if (kind < 0.7 && tokens.length) tokens[Math.min(at, tokens.length - 1)] = pick(VOCAB);
    else if (kind < 0.85 && hiddenTexts.length) tokens.splice(at, 0, ...pick(hiddenTexts).split(" "));
    else if (tokens.length) {
      const index = Math.min(at, tokens.length - 1);
      tokens[index] = upper || rng() < 0.5 ? tokens[index].toLocaleUpperCase("id") : tokens[index].toLocaleLowerCase("id");
    }
  }
  const space = () => (rng() < 0.15 ? " " : rng() < 0.3 ? "  " : " ");
  const draft = tokens.reduce((text, token, index) => (index ? `${text}${space()}${token}` : token), "");
  return { draft: `${rng() < 0.2 ? " " : ""}${draft}${rng() < 0.2 ? " " : ""}`, unchanged: false };
}

test("property: applying a line's commands gives back the draft's tokens; deletions are hidden; frames hold", () => {
  const rng = mulberry32(20261002);
  const order = new Map(ID.map((id, position) => [id, position]));
  let checked = 0;
  let refused = 0;
  for (let round = 0; round < 2000; round += 1) {
    const doc = randomDoc(rng);
    const plan = fakePlan(doc);
    const rows = captionRows({ plan, doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
    if (!rows.length) continue;
    const row = rows[Math.floor(rng() * rows.length)];
    const upper = doc.captions.overrides.case === "upper";
    const canon = (text) => (upper ? text.toLocaleUpperCase("id") : text);
    const { draft, unchanged } = randomDraft(rng, row, doc, upper);
    const label = `round ${round}: ${JSON.stringify({ row: row.text, hidden: row.hiddenIds, draft, upper })}`;
    const result = lineEdit({ row, draft, doc, words: WORDS, upper });
    if (!result.ok) {
      assert.equal(result.code, "text_too_long", label);
      refused += 1;
      continue;
    }
    if (unchanged) assert.deepEqual(result.commands, [], label);
    const ids = [...row.wordIds, ...row.hiddenIds].sort((a, b) => order.get(a) - order.get(b));
    for (const command of result.commands) assert.ok(ids.includes(command.args.wordId), label);
    const check = checkCommands(doc, CTX, result.commands);
    assert.equal(check.ok, true, `${label} ${check.code}`);
    const edits = check.doc.captions.word_edits;
    const textOf = (id) => edits[id]?.text ?? WORDS.words[order.get(id)].t;
    const rebuilt = ids.filter((id) => edits[id]?.hidden !== true).map(textOf).join(" ").split(/\s+/u).filter(Boolean);
    const wanted = draft.normalize("NFC").trim().split(/\s+/u).filter(Boolean);
    assert.deepEqual(rebuilt.map(canon), wanted.map(canon), label);
    const run = `\u0001${wanted.map(canon).join("\u0001")}\u0001`;
    for (const command of result.commands) {
      if (command.type === "SetWordHidden" && command.args.on) assert.equal(edits[command.args.wordId]?.hidden, true, label);
      if (command.type === "EditWordText") {
        assert.ok(run.includes(`\u0001${command.args.text.split(" ").map(canon).join("\u0001")}\u0001`), `${label}: "${command.args.text}"`);
      }
    }
    // AC6: a line edit cuts nothing, and a cue that starts at the same word starts at the same frame.
    const next = fakePlan(check.doc);
    assert.deepEqual(next.pieces, plan.pieces, label);
    assert.equal(next.totalFrames, plan.totalFrames, label);
    const starts = new Map(plan.cues.map((cue) => [`${segAt(plan, cue.f0)}:${cue.words[0]}`, cue.f0]));
    for (const cue of next.cues) {
      const before = starts.get(`${segAt(next, cue.f0)}:${cue.words[0]}`);
      if (before !== undefined) assert.equal(cue.f0, before, label);
    }
    checked += 1;
  }
  assert.ok(checked >= 1800, `checked ${checked}`);
  assert.ok(refused <= 100, `refused ${refused}`);
});
