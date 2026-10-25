// The transcript of the one-layout editor (rombak 06 §6, Editor F2): always on screen in the
// centre, with Kata | Baris, the one-layout word toolbar, and Rapikan and Ejaan in one drawer.
// Pure rules of transcript/transcript-view.mjs, and how the files fit together; the browser
// behaviour is e2e/editor-transcript-shell.spec.mjs's and e2e/editor-lines.spec.mjs's.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import {
  REVIEW_TABS, TRANSCRIPT_MODES, hiddenInRow, openReview, reviewCount, reviewTabs, transcriptMode,
} from "../components/editor/transcript/transcript-view.mjs";
import { captionRows } from "../lib/editor/caption-lines.mjs";
import { resolveUrlState } from "../lib/editor/url-state.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => readFileSync(path.join(WEB, ...parts), "utf8");
const TRANSCRIPT = path.join("components", "editor", "transcript");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// --- Kata | Baris ----------------------------------------------------------------------------

test("two transcript views, Kata first; anything else is Kata", () => {
  assert.deepEqual([...TRANSCRIPT_MODES], ["words", "lines"]);
  assert.ok(Object.isFrozen(TRANSCRIPT_MODES));
  assert.equal(transcriptMode("lines"), "lines");
  for (const value of ["words", undefined, null, "", "baris", "LINES", 1]) assert.equal(transcriptMode(value), "words", String(value));
});

test("the old Caption lines card's link opens the transcript in Baris (06 §3.6)", () => {
  assert.equal(transcriptMode(resolveUrlState("?card=lines").transcript), "lines");
  assert.equal(transcriptMode(resolveUrlState("?panel=text").transcript), "words");
  assert.equal(transcriptMode(resolveUrlState("").transcript), "words");
});

test("Baris marks a line whose caption hides words next to it, so the line says so and keeps it", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.captions.word_edits = { [words.words[4].id]: { hidden: true } };
  const model = buildTranscriptModel(words, doc);
  const rows = captionRows({ plan: fakePlan(doc), doc, words, model });
  assert.ok(rows.length >= 2, "the fakes' clip has several caption lines");
  const marked = rows.filter((row) => hiddenInRow(row) > 0);
  assert.ok(marked.length >= 1, "the line around the hidden word is marked");
  for (const row of marked) assert.ok(row.hiddenIds.includes(words.words[4].id));
  const clean = captionRows({ plan: fakePlan(fakeDoc()), doc: fakeDoc(), words, model: buildTranscriptModel(words, fakeDoc()) });
  assert.ok(clean.every((row) => hiddenInRow(row) === 0), "no hidden word, no mark");
  assert.equal(hiddenInRow(null), 0);
  assert.equal(hiddenInRow({}), 0);
});

// --- Rapikan and Ejaan in one drawer -----------------------------------------------------------

test("the drawer has Rapikan, and Ejaan only with the editor's LLM", () => {
  assert.deepEqual([...REVIEW_TABS], ["cleanup", "spelling"]);
  assert.deepEqual(reviewTabs({ llmEnabled: true }), ["cleanup", "spelling"]);
  assert.deepEqual(reviewTabs({ llmEnabled: false }), ["cleanup"]);
  assert.deepEqual(reviewTabs({}), ["cleanup"]);
});

test("one review at a time: the open tab decides which list runs", () => {
  assert.deepEqual(openReview("cleanup", { llmEnabled: true }), { tab: "cleanup", cleanup: true, spelling: false });
  assert.deepEqual(openReview("spelling", { llmEnabled: true }), { tab: "spelling", cleanup: false, spelling: true });
  // Without the LLM, Ejaan does not exist: asking for it opens Rapikan.
  assert.deepEqual(openReview("spelling", { llmEnabled: false }), { tab: "cleanup", cleanup: true, spelling: false });
  assert.deepEqual(openReview(null, { llmEnabled: true }), { tab: null, cleanup: false, spelling: false });
  assert.deepEqual(openReview("other", { llmEnabled: true }), { tab: null, cleanup: false, spelling: false });
});

test("Rapikan n counts the list once it is loaded, Ejaan n once the check is done", () => {
  assert.equal(reviewCount("cleanup", { cleanupEntries: 4 }), 4);
  assert.equal(reviewCount("cleanup", { cleanupEntries: 0 }), 0);
  assert.equal(reviewCount("cleanup", { cleanupEntries: null }), null, "not loaded yet: no number");
  assert.equal(reviewCount("spelling", { spellingPhase: "done", spellingRows: 2 }), 2);
  assert.equal(reviewCount("spelling", { spellingPhase: "running", spellingRows: 0 }), null);
  assert.equal(reviewCount("spelling", { spellingPhase: "idle" }), null);
  assert.equal(reviewCount("nope", {}), null);
});

// --- the files --------------------------------------------------------------------------------

test("the F2 files of 06 §6 exist: LinesView, the drawer and the head", () => {
  for (const file of ["LinesView.jsx", "ReviewDrawer.jsx", "TranscriptHead.jsx", "transcript-view.mjs"]) {
    assert.ok(existsSync(path.join(WEB, TRANSCRIPT, file)), file);
  }
});

test("Kata | Baris is a React Aria ToggleButtonGroup; the drawer a React Aria modal with tabs, not HeroUI's Drawer", () => {
  const head = code(read(TRANSCRIPT, "TranscriptHead.jsx"));
  assert.match(head, /import \{[^}]*\bToggleButtonGroup\b[^}]*\} from "react-aria-components";/);
  assert.match(head, /disallowEmptySelection/);
  const drawer = code(read(TRANSCRIPT, "ReviewDrawer.jsx"));
  for (const name of ["ModalOverlay", "Modal", "Dialog", "Tabs", "TabList", "Tab", "TabPanel", "Heading"]) {
    assert.match(drawer, new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "react-aria-components";`), name);
  }
  assert.match(drawer, /isDismissable/);
  // Its close button is named from the catalog, not HeroUI's English default.
  assert.doesNotMatch(drawer, /@heroui\/react/);
  assert.match(drawer, /useTranslations\("aria"\)/);
  // The transcript hands it the same two lists the old shell shows inline.
  const panel = code(read(TRANSCRIPT, "TranscriptPanel.jsx"));
  const drawn = panel.slice(panel.indexOf("<ReviewDrawer"), panel.indexOf("/>", panel.indexOf("<SpellingReview", panel.indexOf("<ReviewDrawer"))));
  assert.match(drawn, /cleanup=\{cleanupList\}/);
  assert.match(panel, /const cleanupList = \(\s*<CleanupReview\b/);
  assert.match(drawn, /spelling=\{<div[^>]*><SpellingReview\b/);
});

test("the Caption lines card of the old shell now renders LinesView: the lines are moved, not copied", () => {
  const card = code(read("components", "editor", "quick", "CaptionLinesCard.jsx"));
  assert.match(card, /import LinesView from "\.\.\/transcript\/LinesView\.jsx";/);
  assert.match(card, /<LinesView\b/);
  assert.doesNotMatch(card, /commitLine|captionRows|focusAfterRegroup/, "the line logic lives in LinesView only");
  const lines = code(read(TRANSCRIPT, "LinesView.jsx"));
  for (const name of ["captionRows", "commitLine", "focusAfterRegroup", "rowAtFrame"]) assert.match(lines, new RegExp(`\\b${name}\\b`), name);
});

test("the transcript keeps the old shell's look by default and takes the one-layout parts with layout=\"shell\"", () => {
  const panel = code(read(TRANSCRIPT, "TranscriptPanel.jsx"));
  assert.match(panel, /layout = "legacy"/, "the default is the old shell's transcript");
  assert.match(panel, /<TranscriptHead\b/);
  assert.match(panel, /<ReviewDrawer\b/);
  assert.match(panel, /<LinesView\b/);
  assert.match(panel, /<WordToolbar\b[^>]*\blayout=\{/);
  // The harness pages mount the old shell's transcript without the catalog: its path needs none.
  assert.doesNotMatch(panel, /useTranslations/);
});

test("the one-layout editor hands the transcript its view, the frame bus and the drawer's state", () => {
  const app = code(read("components", "editor", "EditorApp.jsx"));
  const v2 = app.slice(app.indexOf("if (oneLayout) {"), app.indexOf("return (", app.indexOf("if (oneLayout) {") + 400));
  assert.match(v2, /<Transcript\b[^>]*\blayout="shell"/);
  assert.match(v2, /\bmode=\{transcriptView\}/);
  assert.match(v2, /\bonModeChange=\{setTranscriptView\}/);
  assert.match(v2, /\bframeBus=\{frameBus\}/);
  assert.match(v2, /\bonReviewChange=\{setReviewOpen\}/);
  assert.match(app, /\[transcriptView, setTranscriptView\] = useState\(\(\) => transcriptMode\(openingState\?\.transcript\)\)/,
    "?card=lines opens Baris");
  // The drawer is a modal: the editor's global keys wait while it is open.
  assert.match(app, /const modalOpen = [^;]*\breviewOpen\b/);
});
