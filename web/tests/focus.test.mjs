// Fokus klip (docs/plans/2026-09-25-fokus-klip.md): the web side. §1 job options and the
// dashboard's chip input, §3 the project page's focus line and per-clip labels. The engine
// (§2) is faked here with the manifest shape it writes.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { parseJobFormOptions } from "../app/api/jobs/route.js";
import {
  jobOptionInputFromForm,
  parseJobOptions,
  sanitizeManifestClipFields,
  sanitizeSelectionV3Summary,
  sanitizeStoredClip,
  serializePublicJob,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import {
  FOCUS_LIMITS,
  FOCUS_STOPWORDS,
  addFocusTerms,
  clipFocusChip,
  focusFormFields,
  focusSummaryLine,
  focusTermKey,
  focusTermMatchable,
  focusTermsHint,
  formatTimestamp,
  normalizeFocusText,
  pastedFocusTerms,
  removeFocusTerm,
  selectionV3SummaryView,
  selectionWarningLabel,
  splitFocusTerms,
} from "../lib/selection-v3-view.mjs";

const run = promisify(execFile);

function pythonBin() {
  return process.env.PYTHON_BIN || "../.venv/bin/python";
}

const BASE = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 };
const V3 = { ...BASE, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const FORM_V3 = { renderMode: "fit-blur", limit: "3", minDuration: "20", maxDuration: "60", selectionMode: "v3", llmMode: "auto", coldOpen: "true", hookOverlay: "true", captionStyle: "karaoke" };
const JOB_ID = "923e4567-e89b-42d3-a456-426614174000";
const HOSTILE = "<img src=x onerror=alert(1)>";

// --- Text rules -------------------------------------------------------------------------------

test("focus text is normalised like trend items: NFC, no controls, bidi, zero-width or line breaks", () => {
  assert.equal(normalizeFocusText("  jo\u200bmok\u202e  \n kers\t"), "jomok kers");
  assert.equal(normalizeFocusText("cafe\u0301"), "caf\u00e9");
  assert.equal(normalizeFocusText("a\u0000b\u007fc\u00ad\ufeffd\u2066e\u2069"), "abcde");
  assert.equal(normalizeFocusText("️"), "");
  assert.equal(normalizeFocusText(42), "");
  assert.equal(normalizeFocusText(null), "");
  assert.equal(focusTermKey("JÓMOK"), focusTermKey("jomok"));
  assert.notEqual(focusTermKey("jomok"), focusTermKey("jomokers"));
  assert.deepEqual(FOCUS_LIMITS, { terms: 8, termMin: 2, termMax: 40, note: 200 });
});

// --- Dashboard chip input -------------------------------------------------------------------

test("typed text becomes chips on commas and line breaks; blanks are dropped", () => {
  assert.deepEqual(splitFocusTerms(" jomok, jomokers,,\n reza auditore ,"), ["jomok", "jomokers", "reza auditore"]);
  assert.deepEqual(splitFocusTerms(""), []);
  assert.deepEqual(addFocusTerms([], "jomok, jomokers"), { terms: ["jomok", "jomokers"], pending: "", error: "" });
  assert.deepEqual(addFocusTerms(["jomok"], "   "), { terms: ["jomok"], pending: "", error: "" });
});

test("chips are 2..40 characters, unique by case and accents, at most 8; bad text stays in the input", () => {
  const short = addFocusTerms(["jomok"], "a");
  assert.deepEqual(short.terms, ["jomok"]);
  assert.equal(short.pending, "a");
  assert.match(short.error, /terlalu pendek.*minimal 2/);

  const long = addFocusTerms([], "x".repeat(41));
  assert.deepEqual(long.terms, []);
  assert.equal(long.pending, "x".repeat(41));
  assert.match(long.error, /terlalu panjang.*maksimal 40/);
  // Length is counted in code points, not UTF-16 units.
  assert.deepEqual(addFocusTerms([], "😀".repeat(40)).terms, ["😀".repeat(40)]);

  const duplicate = addFocusTerms(["jomok"], "JÓMOK, prank");
  assert.deepEqual(duplicate.terms, ["jomok", "prank"]);
  assert.equal(duplicate.pending, "");
  assert.match(duplicate.error, /sudah ada/);

  const eight = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  const full = addFocusTerms(eight, "a8, a9, a10");
  assert.deepEqual(full.terms, [...eight, "a8"]);
  assert.equal(full.pending, "a9, a10");
  assert.match(full.error, /Maksimal 8 kata kunci/);

  assert.deepEqual(removeFocusTerm(["jomok", "prank"], "jomok"), ["prank"]);
  assert.deepEqual(removeFocusTerm(["jomok"], "lain"), ["jomok"]);
});

test("the dashboard sends nothing when focus is empty, and only well-formed fields otherwise", () => {
  // Invariant: no focus, no fields at all.
  assert.deepEqual(focusFormFields({ terms: [], pending: "", note: "" }).fields, {});
  assert.deepEqual(focusFormFields({ terms: [], pending: "  ", note: " \n " }).fields, {});

  assert.deepEqual(focusFormFields({ terms: ["jomok", "jomokers"], pending: "", note: "" }), {
    terms: ["jomok", "jomokers"], pending: "", error: "", fields: { focusTerms: "jomok,jomokers" },
  });
  // Text still in the input is committed on submit.
  assert.deepEqual(focusFormFields({ terms: ["jomok"], pending: "prank", note: "  momen jomok\nyang lucu " }), {
    terms: ["jomok", "prank"], pending: "", error: "", fields: { focusTerms: "jomok,prank", focusNote: "momen jomok yang lucu" },
  });
  // Blocking problems: invalid pending text, an overlong note, a note without terms.
  const pending = focusFormFields({ terms: ["jomok"], pending: "a", note: "" });
  assert.equal(pending.fields, null);
  assert.match(pending.error, /terlalu pendek/);
  const longNote = focusFormFields({ terms: ["jomok"], pending: "", note: "n".repeat(201) });
  assert.equal(longNote.fields, null);
  assert.match(longNote.error, /Catatan untuk AI maksimal 200 karakter/);
  assert.deepEqual(focusFormFields({ terms: ["jomok"], pending: "", note: "😀".repeat(200) }).fields, { focusTerms: "jomok", focusNote: "😀".repeat(200) });
  const noteOnly = focusFormFields({ terms: [], pending: "", note: "momen lucu" });
  assert.equal(noteOnly.fields, null);
  assert.match(noteOnly.error, /minimal satu kata kunci/);
});

test("a pasted list becomes one chip per line; a single pasted term stays in the input", () => {
  // A single-line <input> turns pasted line breaks into spaces, so the paste is read first.
  assert.equal(pastedFocusTerms("", "jomok\njomokers\nreza", 0, 0), "jomok,jomokers,reza");
  assert.equal(pastedFocusTerms("", "jomok\r\njomokers\t prank; reza", 0, 0), "jomok,jomokers, prank, reza");
  assert.equal(pastedFocusTerms("pre", "\njomok", 3, 3), "pre,jomok");
  assert.equal(pastedFocusTerms("ab", "x\ny", 1, 2), "ax,y");
  assert.equal(pastedFocusTerms("", "jomok", 0, 0), null);
  assert.equal(pastedFocusTerms("", "reza auditore", 0, 0), null);
  assert.deepEqual(addFocusTerms([], pastedFocusTerms("", "jomok\njomokers\nreza", 0, 0)).terms, ["jomok", "jomokers", "reza"]);
});

test("terms that tokenise alike are one term, like the engine's", () => {
  assert.equal(focusTermKey("Jomok!"), focusTermKey("jomok"));
  assert.equal(focusTermKey("K pop"), focusTermKey("k-pop"));
  assert.notEqual(focusTermKey("kpop"), focusTermKey("k-pop"));
  assert.notEqual(focusTermKey("!!"), focusTermKey("??"));  // no words: the text itself
  assert.deepEqual(addFocusTerms(["jomok"], "Jomok!").terms, ["jomok"]);
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: "jomok,Jomok!,k-pop,K pop" }).focus.terms, ["jomok", "k-pop"]);
});

test("terms that can never match the transcript literally get a hint at entry", () => {
  assert.equal(focusTermMatchable("jomok"), true);
  assert.equal(focusTermMatchable("anak kuliah"), true);
  assert.equal(focusTermMatchable("tiktok"), true);
  for (const term of ["AI", "5G", "apa aja", "yang", "wkwk"]) assert.equal(focusTermMatchable(term), false, term);
  assert.equal(focusTermsHint(["jomok", "tiktok"], "auto"), null);
  assert.match(focusTermsHint(["AI", "jomok"], "auto"), /“AI”.*terlalu pendek atau terlalu umum.*AI \(LLM\)/);
  assert.match(focusTermsHint(["AI", "apa aja"], "auto"), /“AI”, “apa aja”/);
  assert.match(focusTermsHint(["AI"], "off"), /Tanpa LLM.*tidak berpengaruh/);
  // Plain text: React renders it escaped.
  assert.equal(focusTermsHint(["<b>AI</b>"], "auto"), "“<b>AI</b>” terlalu pendek atau terlalu umum untuk dicari langsung di transkrip; hanya AI (LLM) yang bisa mengenalinya dari maknanya.");
});

test("the matchable check, the stopwords and the term key agree with the engine", async () => {
  const terms = ["AI", "5G", "jomok", "Jomok!", "apa aja", "anak kuliah", "anak-anak", "tiktok", "yang", "k-pop", "K pop", "ÉTÉ", "ﬁlm", "wkwk", "abc", "!!", "Straße", "ﬀ", "ｊｏｍｏｋ"];
  const script = [
    "import json, sys",
    "from ai_clipper.focus import FOCUS_STOPWORDS, _term_key, focus_term_matchable",
    "terms = json.loads(sys.argv[1])",
    "print(json.dumps({'stopwords': sorted(FOCUS_STOPWORDS),",
    "    'matchable': [focus_term_matchable(t) for t in terms],",
    "    'words': [list(_term_key(t)) for t in terms]}))",
  ].join("\n");
  const { stdout } = await run(pythonBin(), ["-c", script, JSON.stringify(terms)], { env: { PATH: process.env.PATH } });
  const engine = JSON.parse(stdout);
  assert.deepEqual([...FOCUS_STOPWORDS].sort(), engine.stopwords);
  assert.deepEqual(terms.map(focusTermMatchable), engine.matchable);
  terms.forEach((term, index) => {
    if (engine.words[index].length) assert.equal(focusTermKey(term), engine.words[index].join(" "), term);
  });
});

// --- Job options (§1) ---------------------------------------------------------------------

test("focus is parsed into options.focus for V3 jobs; without it the options are unchanged", () => {
  assert.deepEqual(parseJobOptions(FORM_V3), V3);
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: "", focusNote: "" }), V3);
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: null, focusNote: null }), V3);
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: " ,, " }), V3);

  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: "jomok, jomokers", focusNote: "momen jomok yang lucu" }), {
    ...V3, focus: { terms: ["jomok", "jomokers"], note: "momen jomok yang lucu", mode: "prefer" },
  });
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: ["jomok"] }), { ...V3, focus: { terms: ["jomok"], mode: "prefer" } });
  // Normalised and deduplicated (case and accents) like trend keywords.
  assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: "jo\u200bmok,\u202eJOMOK\n jómok, reza  auditore", focusNote: " a\u0000b\n c " }).focus, {
    terms: ["jomok", "reza auditore"], note: "ab c", mode: "prefer",
  });
});

test("focus options are bounded and only valid in V3 mode", () => {
  for (const input of [
    { ...FORM_V3, focusTerms: "a" },
    { ...FORM_V3, focusTerms: "x".repeat(41) },
    { ...FORM_V3, focusTerms: "t1,t2,t3,t4,t5,t6,t7,t8,t9" },
    { ...FORM_V3, focusTerms: ["jomok", 42] },
    { ...FORM_V3, focusTerms: { terms: ["jomok"] } },
    { ...FORM_V3, focusTerms: "jomok", focusNote: "n".repeat(201) },
    { ...FORM_V3, focusTerms: "jomok", focusNote: ["catatan"] },
    { ...FORM_V3, focusNote: "catatan tanpa istilah" },
    { ...BASE, focusTerms: "jomok" },
    { ...BASE, selectionMode: "v1", focusTerms: "jomok" },
    { ...BASE, selectionMode: "v2-shadow", focusNote: "catatan" },
  ]) assert.throws(() => parseJobOptions(input), /focus|selection mode/i, JSON.stringify(input));
  assert.equal(parseJobOptions({ ...FORM_V3, focusTerms: "t1,t2,t3,t4,t5,t6,t7,t8" }).focus.terms.length, 8);
  assert.equal(parseJobOptions({ ...FORM_V3, focusTerms: "jomok", focusNote: "😀".repeat(200) }).focus.note, "😀".repeat(200));
});

test("job forms: focusTerms and focusNote are read beside the other fields", () => {
  const form = new FormData();
  for (const [name, value] of Object.entries(FORM_V3)) form.set(name, value);
  assert.deepEqual(parseJobOptions(jobOptionInputFromForm(form)), V3);
  form.set("focusTerms", "jomok,jomokers");
  form.set("focusNote", "momen jomok yang lucu");
  assert.deepEqual(parseJobOptions(jobOptionInputFromForm(form)).focus, { terms: ["jomok", "jomokers"], note: "momen jomok yang lucu", mode: "prefer" });
});

test("persisted focus is validated strictly and kept; other modes may not carry it", () => {
  const focus = { terms: ["jomok", "jomokers"], note: "momen jomok yang lucu", mode: "prefer" };
  assert.deepEqual(validatePersistedJobOptions({ ...V3, focus }), { ...V3, focus });
  assert.deepEqual(validatePersistedJobOptions({ ...V3, focus: { terms: ["jomok"], mode: "prefer" } }), { ...V3, focus: { terms: ["jomok"], mode: "prefer" } });
  assert.deepEqual(validatePersistedJobOptions(V3), V3);
  assert.equal("focus" in validatePersistedJobOptions(V3), false);
  for (const bad of [
    null, [], "jomok", {}, { terms: [], mode: "prefer" }, { terms: ["jomok"] }, { terms: ["jomok"], mode: "only" },
    { terms: ["a"], mode: "prefer" }, { terms: ["x".repeat(41)], mode: "prefer" }, { terms: ["jomok", "JOMOK"], mode: "prefer" },
    { terms: ["jo\u200bmok"], mode: "prefer" }, { terms: [" jomok"], mode: "prefer" }, { terms: [42], mode: "prefer" },
    { terms: Array.from({ length: 9 }, (_, index) => `t${index}`), mode: "prefer" },
    { terms: ["jomok"], note: "", mode: "prefer" }, { terms: ["jomok"], note: "n".repeat(201), mode: "prefer" },
    { terms: ["jomok"], note: "a\nb", mode: "prefer" }, { terms: ["jomok"], mode: "prefer", extra: true },
  ]) assert.throws(() => validatePersistedJobOptions({ ...V3, focus: bad }), /persisted job options/i, JSON.stringify(bad));
  for (const options of [BASE, { ...BASE, selectionMode: "v1" }, { ...BASE, selectionMode: "v2-shadow", clipProfile: "standard", maxCandidates: 200, maxMediaCandidates: 12, mediaTimeout: 30 }]) {
    assert.throws(() => validatePersistedJobOptions({ ...options, focus }), /persisted job options/i);
  }
});

// --- Engine output (§2 Keluaran) -----------------------------------------------------------

test("manifest clip focus becomes a strict { match, terms, at } field", () => {
  assert.deepEqual(sanitizeManifestClipFields({ focus: { match: "literal", terms: ["jomok"], at: 754.1234 } }).focus, { match: "literal", terms: ["jomok"], at: 754.123 });
  assert.deepEqual(sanitizeManifestClipFields({ focus: { match: "semantic", terms: ["jomok"], at: 12 } }).focus, { match: "semantic", terms: ["jomok"], at: null });
  assert.deepEqual(sanitizeManifestClipFields({ focus: { match: "none", terms: [] } }).focus, { match: "none", terms: [], at: null });
  // A list of occurrence times keeps the earliest.
  assert.deepEqual(sanitizeManifestClipFields({ focus: { match: "literal", terms: ["jomok"], at: [80.5, 70, "x"] } }).focus, { match: "literal", terms: ["jomok"], at: 70 });
  // Terms are cleaned, bounded and deduplicated; hostile text stays text.
  assert.deepEqual(sanitizeManifestClipFields({ focus: {
    match: "literal", terms: ["jo\u200bmok", "JOMOK", HOSTILE, "", 7, "x".repeat(41), ...Array.from({ length: 10 }, (_, index) => `t${index}`)], at: -1,
  } }).focus, { match: "literal", terms: ["jomok", HOSTILE, "t0", "t1", "t2", "t3", "t4", "t5"], at: null });
  for (const bad of [null, "literal", [], { match: "maybe", terms: ["jomok"] }, { terms: ["jomok"] }]) {
    assert.equal("focus" in sanitizeManifestClipFields({ focus: bad }), false, JSON.stringify(bad));
  }
  assert.deepEqual(sanitizeManifestClipFields({ focus: { match: "literal", terms: "jomok", at: Infinity } }).focus, { match: "literal", terms: [], at: null });
  // Clips without focus keep exactly their previous shape.
  assert.equal("focus" in sanitizeManifestClipFields({ title: "Judul", selection_source: "llm" }), false);
});

test("the public job API re-sanitises stored clip focus and the options' focus", () => {
  const clip = {
    index: 1, text: "t", title: "Judul", selectionSource: "llm",
    focus: { match: "literal", terms: ["jomok", "\u202eJOMOK"], at: 12, extra: "x" },
  };
  assert.deepEqual(sanitizeStoredClip(clip, JOB_ID).focus, { match: "literal", terms: ["jomok"], at: 12 });
  assert.equal("focus" in sanitizeStoredClip({ ...clip, focus: { match: "bogus" } }, JOB_ID), false);
  const old = { index: 1, text: "t", title: "Lama", description: "d", hashtags: ["#a"], metadataVersion: 5 };
  assert.equal(sanitizeStoredClip(old, JOB_ID), old);

  const job = { id: JOB_ID, options: { ...V3, focus: { terms: ["jomok", "\u202ejomok", "prank"], note: "catatan\u0000", mode: "prefer", secret: "x" } }, clips: [] };
  assert.deepEqual(serializePublicJob(job).options.focus, { terms: ["jomok", "prank"], note: "catatan", mode: "prefer" });
  assert.equal("focus" in serializePublicJob({ ...job, options: { ...V3, focus: { terms: [] } } }).options, false);
  assert.equal("focus" in serializePublicJob({ ...job, options: { ...V3, focus: "jomok" } }).options, false);
  assert.deepEqual(serializePublicJob({ ...job, options: V3 }).options, V3);
});

test("selection_v3 focus summaries pass as { terms, matched, requested }; without focus the summary is unchanged", () => {
  const raw = { mode: "v3", status: "completed", source: "llm", provider: "groq", model: "m", prompt_version: "llm-select-v2", warnings: ["focus_few_matches:2"], artifact: "analysis/selection.v3.json", transcript_source: "whisper" };
  const plain = sanitizeSelectionV3Summary(raw);
  assert.equal("focus" in plain, false);
  assert.deepEqual(plain.warnings, ["focus_few_matches:2"]);
  assert.deepEqual(sanitizeSelectionV3Summary({ ...raw, focus: { terms: ["jomok", "jomokers"], matched: 2, requested: 5 } }), {
    ...plain, focus: { terms: ["jomok", "jomokers"], matched: 2, requested: 5 },
  });
  assert.deepEqual(sanitizeSelectionV3Summary({ ...raw, focus: { terms: ["jomok"], matched: 0, requested: 3 } }).focus, { terms: ["jomok"], matched: 0, requested: 3 });
  // Counts that do not add up are dropped, the terms kept.
  for (const counts of [{ matched: 6, requested: 5 }, { matched: -1, requested: 5 }, { matched: 1.5, requested: 5 }, { matched: "2", requested: 5 }, { matched: 1 }, { matched: 0, requested: 0 }]) {
    assert.deepEqual(sanitizeSelectionV3Summary({ ...raw, focus: { terms: ["jomok"], ...counts } }).focus, { terms: ["jomok"], matched: null, requested: null }, JSON.stringify(counts));
  }
  for (const bad of [null, "jomok", [], { terms: [] }, { terms: ["a"] }, { matched: 1, requested: 2 }]) {
    assert.equal("focus" in sanitizeSelectionV3Summary({ ...raw, focus: bad }), false, JSON.stringify(bad));
  }
});

// --- Project page (§3) --------------------------------------------------------------------

const focusJob = (summaryFocus, optionsFocus = { terms: ["jomok", "jomokers"], mode: "prefer" }) => ({
  options: { ...V3, ...(optionsFocus ? { focus: optionsFocus } : {}) },
  selectionV3: { mode: "v3", status: "completed", source: "llm", warnings: [], ...(summaryFocus ? { focus: summaryFocus } : {}) },
});

test("the focus line reads 'Fokus: a, b — n dari k klip cocok'; old jobs get none", () => {
  assert.deepEqual(focusSummaryLine(focusJob({ terms: ["jomok", "jomokers"], matched: 5, requested: 8 })), {
    terms: ["jomok", "jomokers"], termsText: "jomok, jomokers", countText: "5 dari 8 klip cocok", text: "Fokus: jomok, jomokers — 5 dari 8 klip cocok",
  });
  // Without engine counts (for example a failed job) only the terms from the options.
  assert.deepEqual(focusSummaryLine(focusJob(null)), { terms: ["jomok", "jomokers"], termsText: "jomok, jomokers", countText: null, text: "Fokus: jomok, jomokers" });
  assert.equal(focusSummaryLine(focusJob({ terms: ["jomok"], matched: null, requested: null })).text, "Fokus: jomok");
  assert.equal(focusSummaryLine(focusJob(null, null)), null);
  assert.equal(focusSummaryLine({ options: V3, selectionV3: { mode: "v3", status: "completed" } }), null);
  assert.equal(focusSummaryLine(null), null);
  assert.equal(focusSummaryLine(focusJob({ terms: [HOSTILE], matched: 1, requested: 3 })).text, `Fokus: ${HOSTILE} — 1 dari 3 klip cocok`);
});

test("per-clip labels: literal with its time, semantic as the AI's claim, the rest 'Di luar fokus'", () => {
  const job = focusJob({ terms: ["jomok", "jomokers"], matched: 2, requested: 3 });
  assert.deepEqual(clipFocusChip({ focus: { match: "literal", terms: ["jomok"], at: 754.4 } }, job), { tone: "literal", label: "Menyebut 'jomok' · 12:34" });
  assert.deepEqual(clipFocusChip({ focus: { match: "literal", terms: ["jomok", "jomokers"], at: null } }, job), { tone: "literal", label: "Menyebut 'jomok', 'jomokers'" });
  assert.deepEqual(clipFocusChip({ focus: { match: "literal", terms: ["a1", "a2", "a3"], at: 5 } }, job), { tone: "literal", label: "Menyebut 'a1', 'a2' +1 · 0:05" });
  assert.deepEqual(clipFocusChip({ focus: { match: "semantic", terms: ["jomok"], at: null } }, job), { tone: "semantic", label: "Terkait 'jomok' (menurut AI)" });
  // A semantic claim without terms names the job's focus.
  assert.deepEqual(clipFocusChip({ focus: { match: "semantic", terms: [] } }, job), { tone: "semantic", label: "Terkait 'jomok', 'jomokers' (menurut AI)" });
  assert.deepEqual(clipFocusChip({ focus: { match: "semantic", terms: [] } }, focusJob({ terms: [], matched: 0, requested: 1 }, null)), { tone: "semantic", label: "Terkait fokus (menurut AI)" });
  assert.deepEqual(clipFocusChip({ focus: { match: "none", terms: [] } }, job), { tone: "none", label: "Di luar fokus" });
  // In a focus job a clip without a label is outside the focus; old jobs get no chip at all.
  assert.deepEqual(clipFocusChip({}, job), { tone: "none", label: "Di luar fokus" });
  assert.equal(clipFocusChip({}, focusJob(null, null)), null);
  assert.equal(clipFocusChip({ focus: { match: "literal", terms: ["jomok"] } }, focusJob(null, null)).tone, "literal");
  assert.equal(clipFocusChip(null, null), null);
});

test("timestamps read m:ss or h:mm:ss", () => {
  assert.equal(formatTimestamp(0), "0:00");
  assert.equal(formatTimestamp(59.99), "0:59");
  assert.equal(formatTimestamp(754), "12:34");
  assert.equal(formatTimestamp(3723), "1:02:03");
  assert.equal(formatTimestamp(-1), null);
  assert.equal(formatTimestamp(Number.NaN), null);
  assert.equal(formatTimestamp("12"), null);
});

test("focus warning codes are explained in Indonesian", () => {
  assert.match(selectionWarningLabel("focus_few_matches:2"), /Hanya 2 klip yang cocok dengan fokus.*Di luar fokus/);
  assert.match(selectionWarningLabel("focus_few_matches:0"), /Tidak ada momen yang cocok dengan fokus/);
  assert.match(selectionWarningLabel("focus_literal_ungrounded:3"), /3 klip.*tidak ditemukan di transkrip/);
  assert.match(selectionWarningLabel("focus_terms_unmatchable:2"), /^2 kata kunci fokus terlalu pendek atau terlalu umum.*hanya pembacaan AI/);
  assert.equal(selectionWarningLabel("focus_literal_ungrounded:0"), null);
  assert.equal(selectionWarningLabel("focus_few_matches:x"), null);
  // Konteks Tren labels are unchanged.
  assert.match(selectionWarningLabel("trend_ref_ungrounded:2"), /^2 tren yang disebut AI dibuang/);
});

// --- Integration seams ----------------------------------------------------------------------

test("the job API route reads focusTerms and focusNote from the form", () => {
  const form = new FormData();
  for (const [name, value] of Object.entries(FORM_V3)) form.set(name, value);
  form.set("youtubeUrl", "https://youtu.be/rBg0ZcwjVKQ");
  assert.deepEqual(parseJobFormOptions(form), V3);
  form.set("focusTerms", "jomok");
  form.set("focusNote", "momen jomok yang lucu");
  assert.deepEqual(parseJobFormOptions(form), { ...V3, focus: { terms: ["jomok"], note: "momen jomok yang lucu", mode: "prefer" } });
  const v1 = new FormData();
  for (const [name, value] of Object.entries({ ...FORM_V3, selectionMode: "v1", llmMode: "", coldOpen: "", hookOverlay: "", captionStyle: "" })) v1.set(name, value);
  v1.set("focusTerms", "jomok");
  assert.throws(() => parseJobFormOptions(v1), /focus/i);
});

test("terms the engine would fold together (Python casefold) are one term here too", () => {
  // The CLI rejects terms that are equal under str.casefold(); the web must never send them.
  for (const [a, b] of [["Straße", "STRASSE"], ["ﬁlm", "FILM"], ["ὈΔΥΣΣΕΎΣ", "ὀδυσσεύς"], ["Σίσυφος", "σίσυφοσ"]]) {
    assert.equal(focusTermKey(a), focusTermKey(b), `${a} / ${b}`);
    assert.deepEqual(addFocusTerms([a], b).terms, [a]);
    assert.deepEqual(parseJobOptions({ ...FORM_V3, focusTerms: `${a},${b}` }).focus.terms, [a]);
    assert.throws(() => validatePersistedJobOptions({ ...V3, focus: { terms: [a, b], mode: "prefer" } }), /focus/);
  }
  assert.notEqual(focusTermKey("jomok"), focusTermKey("jomokers"));
});

test("every focus warning code the engine writes has an Indonesian label", () => {
  assert.match(selectionWarningLabel("focus_packaging_ungrounded:2"), /^2 klip .*judul, hook atau deskripsinya/);
  assert.match(selectionWarningLabel("focus_terms_unmatchable:1"), /^1 kata kunci fokus/);
  // The engine no longer lets heuristic focus matches outrank the LLM: no such code or wording.
  assert.equal(selectionWarningLabel("focus_llm_outranked:4"), null);
});

test("a heuristic run keeps its wording with a focus", () => {
  const summary = {
    mode: "v3", status: "completed", source: "heuristic", provider: null, model: null,
    prompt_version: "heuristic-v1", warnings: ["focus_few_matches:3"], artifact: null,
    transcript_source: "youtube-captions", focus: { terms: ["jomok"], matched: 3, requested: 8 },
  };
  assert.deepEqual(selectionV3SummaryView(summary), selectionV3SummaryView({ ...summary, focus: undefined }));
  assert.match(selectionV3SummaryView(summary).detail, /LLM tidak dipakai/);
});

test("POST /api/jobs stores the focus of a V3 YouTube job; without focus the job has none", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { POST } = await import("../app/api/jobs/route.js");
  const { createSessionToken } = await import("../lib/auth.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "focus-post-"));
  const auth = { APP_USERNAME: "admin", APP_PASSWORD: "secret-value", APP_SESSION_SECRET: "a-long-random-session-secret-value" };
  const env = {
    ...auth, JOBS_ROOT: root, PRIMARY_MAX_ACTIVE_JOBS: "4", PRIMARY_WORKER_CONCURRENCY: "1",
    PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000", MAX_UPLOAD_BYTES: "100000",
    JOBS_STORAGE_QUOTA_BYTES: "100000000", JOBS_STORAGE_MIN_FREE_BYTES: "0",
    JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "1000", JOBS_STORAGE_SCAN_MAX_ENTRIES: "1000", JOBS_STORAGE_SCAN_MAX_DEPTH: "10",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const token = createSessionToken(auth, 2_000_000_000);
  const create = async (fields) => {
    const boundary = "focus-post-boundary";
    const body = Buffer.from(Object.entries(fields).map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") + `--${boundary}--\r\n`);
    const response = await POST(new Request("http://clips.example/api/jobs", {
      method: "POST",
      headers: {
        Cookie: `potongin_session=${token}`, Origin: "http://clips.example", Host: "clips.example",
        "Sec-Fetch-Site": "same-origin", "Content-Length": String(body.length),
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }));
    const payload = await response.json();
    assert.equal(response.status, 202, JSON.stringify(payload));
    return { payload, stored: JSON.parse(await readFile(path.join(root, payload.job.id, "job.json"), "utf8")) };
  };
  try {
    const fields = { ...FORM_V3, limit: "8", maxDuration: "90", youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ" };
    const focused = await create({ ...fields, focusTerms: "jomok", focusNote: "momen jomok yang lucu" });
    const focus = { terms: ["jomok"], note: "momen jomok yang lucu", mode: "prefer" };
    assert.deepEqual(focused.stored.options.focus, focus);
    assert.deepEqual(focused.payload.job.options.focus, focus);
    const plain = await create(fields);
    assert.equal("focus" in plain.stored.options, false);
    assert.equal("focus" in plain.payload.job.options, false);
    assert.deepEqual({ ...focused.stored.options, focus: undefined }, { ...plain.stored.options, focus: undefined });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
