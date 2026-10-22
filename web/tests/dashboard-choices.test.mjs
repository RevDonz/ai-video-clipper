// The dashboard's job options (app/dashboard/page.jsx): duration presets inside the job API's
// limits, the essentials shown open, the three labelled folds with their summaries, and the last
// choices kept per browser (folds included).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPTION_STYLE_CHOICES,
  CHOICES_KEY,
  DEFAULT_CHOICES,
  DURATION_PRESETS,
  LAYOUT_CHOICES,
  OPTION_SECTIONS,
  VIDEO_LANGUAGE_CHOICES,
  choicesSummary,
  normalizeChoices,
  readStoredChoices,
  sectionOfField,
  sectionSummary,
  withDuration,
  withSection,
  writeStoredChoices,
} from "../lib/dashboard-choices.mjs";
import { jobFormProblems, videoFileProblem } from "../lib/dashboard-view.mjs";
import { CAPTION_STYLES, RENDER_MODES, VIDEO_LANGUAGES, parseJobOptions } from "../lib/jobs.mjs";

/** A localStorage stand-in; `fail` makes the named methods throw like blocked site data. */
function memoryStorage(initial = {}, { fail = [] } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = (name) => { if (fail.includes(name)) throw new DOMException("blocked", "SecurityError"); };
  return {
    data,
    getItem: (key) => { guard("getItem"); return data.has(key) ? data.get(key) : null; },
    setItem: (key, value) => { guard("setItem"); data.set(key, String(value)); },
  };
}

const formFields = (choices) => ({
  renderMode: choices.renderMode, limit: choices.limit, minDuration: choices.minDuration, maxDuration: choices.maxDuration,
  coldOpen: String(choices.coldOpen), hookOverlay: String(choices.hookOverlay), captionStyle: choices.captionStyle,
  captionPosition: choices.captionPosition, captionSize: choices.captionSize, videoLanguage: choices.videoLanguage,
});

test("the offered choices are the ones the job API accepts", () => {
  assert.deepEqual(LAYOUT_CHOICES.map((choice) => choice.id).sort(), [...RENDER_MODES].sort());
  assert.deepEqual(CAPTION_STYLE_CHOICES.map((choice) => choice.id), CAPTION_STYLES);
  assert.deepEqual(VIDEO_LANGUAGE_CHOICES.map((choice) => choice.id), VIDEO_LANGUAGES);
  assert.deepEqual(VIDEO_LANGUAGE_CHOICES.map((choice) => choice.name), ["Indonesia", "Inggris", "Deteksi otomatis"]);
  assert.deepEqual(DURATION_PRESETS.map((preset) => preset.name), ["Otomatis", "Pendek", "Sedang", "Panjang", "Atur sendiri"]);
});

test("today's form defaults are the defaults: Otomatis is 20 to 60 seconds, Indonesian, three clips", () => {
  assert.deepEqual(DEFAULT_CHOICES, {
    limit: "3", duration: "auto", minDuration: "20", maxDuration: "60", renderMode: "fit-blur",
    captionStyle: "karaoke", captionPosition: "bottom", captionSize: "medium", ratio: "9:16", resolution: "720p",
    coldOpen: true, hookOverlay: true, videoLanguage: "id", openSections: [],
  });
  assert.deepEqual(normalizeChoices(undefined), DEFAULT_CHOICES);
});

test("every duration preset maps onto min/max fields the form and the job API accept", () => {
  for (const preset of DURATION_PRESETS.filter((entry) => entry.id !== "custom")) {
    const choices = withDuration(DEFAULT_CHOICES, preset.id);
    assert.equal(choices.duration, preset.id);
    assert.deepEqual([choices.minDuration, choices.maxDuration], [String(preset.min), String(preset.max)], preset.id);
    assert.deepEqual(jobFormProblems({ sourceType: "youtube", youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ", ...choices }), {}, preset.id);
    const options = parseJobOptions(formFields(choices));
    assert.deepEqual([options.minDuration, options.maxDuration], [preset.min, preset.max], preset.id);
  }
  // "Atur sendiri" starts from the range in use, so the two fields open filled in.
  const custom = withDuration(withDuration(DEFAULT_CHOICES, "short"), "custom");
  assert.deepEqual([custom.duration, custom.minDuration, custom.maxDuration], ["custom", "15", "30"]);
  assert.equal(withDuration(DEFAULT_CHOICES, "nope"), DEFAULT_CHOICES);
});

test("the summary names the current choices in one short line", () => {
  assert.equal(choicesSummary(DEFAULT_CHOICES), "3 klip · Otomatis 20–60 detik · Latar blur · Karaoke · Bahasa Indonesia");
  const changed = {
    ...withDuration(DEFAULT_CHOICES, "long"), limit: "5", renderMode: "face-track", captionStyle: "classic", videoLanguage: "auto",
    coldOpen: false, hookOverlay: false,
  };
  assert.equal(
    choicesSummary(changed, { focusTerms: 2 }),
    "5 klip · Panjang 60–90 detik · Ikuti wajah · Klasik · Deteksi bahasa · tanpa kalimat pembuka · tanpa teks hook · fokus 2 kata kunci",
  );
  const custom = { ...withDuration(DEFAULT_CHOICES, "custom"), minDuration: "25", maxDuration: "45", videoLanguage: "en" };
  assert.equal(choicesSummary(custom, { focusTerms: 1 }), "3 klip · 25–45 detik · Latar blur · Karaoke · Bahasa Inggris · fokus 1 kata kunci");
  // A value still being typed is left out instead of shown as something it is not.
  assert.equal(choicesSummary({ ...custom, limit: "", minDuration: "2" }), "Latar blur · Karaoke · Bahasa Inggris");
  assert.doesNotMatch(choicesSummary(changed), /—|viral|Hot/);
});

test("stored choices are read back field by field; anything unknown falls back to the default", () => {
  const stored = {
    limit: 7, duration: "custom", minDuration: "25", maxDuration: 45, renderMode: "center-crop", captionStyle: "sorot",
    captionPosition: "top", captionSize: "small", ratio: "1:1", resolution: "1080p", coldOpen: false, hookOverlay: true,
    videoLanguage: "en", openSections: ["format", "look"],
  };
  const storage = memoryStorage({ [CHOICES_KEY]: JSON.stringify(stored) });
  assert.deepEqual(readStoredChoices(storage), {
    limit: "7", duration: "custom", minDuration: "25", maxDuration: "45", renderMode: "center-crop", captionStyle: "sorot",
    captionPosition: "top", captionSize: "small", ratio: "1:1", resolution: "1080p", coldOpen: false, hookOverlay: true,
    videoLanguage: "en", openSections: ["look", "format"],
  });
  // A preset always carries its own range, whatever was stored next to it.
  assert.deepEqual(normalizeChoices({ duration: "short", minDuration: "100", maxDuration: "120" }), withDuration(DEFAULT_CHOICES, "short"));
  for (const bad of [
    { limit: 11 }, { limit: "2.5" }, { limit: "" }, { duration: "forever" }, { renderMode: "split" }, { captionStyle: "neon" },
    { captionPosition: "atas" }, { captionSize: 1200 }, { ratio: "16:9" }, { resolution: "4K" },
    { coldOpen: "false" }, { hookOverlay: 1 }, { videoLanguage: "fr" },
    { duration: "custom", minDuration: "4", maxDuration: "60" }, { duration: "custom", minDuration: "61", maxDuration: "60" },
    { duration: "custom", minDuration: "20", maxDuration: "181" }, { duration: "custom", minDuration: "abc", maxDuration: "60" },
  ]) {
    const key = Object.keys(bad).find((name) => !["minDuration", "maxDuration"].includes(name)) || "duration";
    assert.equal(normalizeChoices({ ...DEFAULT_CHOICES, ...bad })[key], DEFAULT_CHOICES[key], JSON.stringify(bad));
  }
  for (const bad of [{ openSections: "look" }, { openSections: ["nope", 3, null] }, { openSections: { look: true } }, { optionsOpen: "yes" }]) {
    assert.deepEqual(normalizeChoices({ ...DEFAULT_CHOICES, ...bad }).openSections, [], JSON.stringify(bad));
  }
  assert.deepEqual(normalizeChoices({ openSections: ["look", "look", "moments"] }).openSections, ["look", "moments"], "each fold once");
  // A browser that kept the old single fold open sees all three open.
  assert.deepEqual(normalizeChoices({ optionsOpen: true }).openSections, ["look", "moments", "format"]);
  assert.equal("optionsOpen" in normalizeChoices({ optionsOpen: true }), false, "the old key is not carried on");
  for (const raw of [null, "", "not json", "[]", "42", '"text"', "null"]) {
    assert.deepEqual(readStoredChoices(memoryStorage(raw === null ? {} : { [CHOICES_KEY]: raw })), DEFAULT_CHOICES, String(raw));
  }
});

test("blocked or missing storage never breaks the page: defaults are read and writing reports false", () => {
  assert.deepEqual(readStoredChoices(memoryStorage({ [CHOICES_KEY]: "{}" }, { fail: ["getItem"] })), DEFAULT_CHOICES);
  assert.deepEqual(readStoredChoices(null), DEFAULT_CHOICES);
  assert.deepEqual(readStoredChoices(undefined), DEFAULT_CHOICES);
  assert.deepEqual(readStoredChoices({}), DEFAULT_CHOICES, "an object without getItem");
  const refusing = memoryStorage({}, { fail: ["setItem"] });
  assert.equal(writeStoredChoices(refusing, DEFAULT_CHOICES), false);
  assert.equal(refusing.data.size, 0);
  assert.equal(writeStoredChoices(null, DEFAULT_CHOICES), false);
});

test("only the choices are written: never the link, the file or the focus", () => {
  const storage = memoryStorage();
  const choices = { ...withDuration(DEFAULT_CHOICES, "medium"), limit: "4", videoLanguage: "auto", openSections: ["moments"] };
  assert.equal(writeStoredChoices(storage, {
    ...choices, youtubeUrl: "https://youtu.be/rBg0ZcwjVKQ", video: { name: "rahasia.mp4" }, focusTerms: ["jomok"], focusNote: "catatan",
  }), true);
  assert.deepEqual([...storage.data.keys()], [CHOICES_KEY]);
  const written = storage.data.get(CHOICES_KEY);
  assert.doesNotMatch(written, /youtu|rahasia|jomok|catatan/);
  assert.deepEqual(Object.keys(JSON.parse(written)).sort(), Object.keys(DEFAULT_CHOICES).sort());
  assert.deepEqual(readStoredChoices(storage), choices);
});

test("an empty source asks for a link or a file; a dropped file must be a video the server takes", async () => {
  const valid = { sourceType: "youtube", youtubeUrl: "", video: null, limit: "3", minDuration: "20", maxDuration: "60" };
  assert.deepEqual(jobFormProblems(valid), { youtubeUrl: "Tempel link YouTube atau pilih file video." });
  assert.equal(videoFileProblem(null), "Pilih file video dulu.");
  for (const name of ["a.mp4", "B.MOV", "c.mkv", "d.webm", "e.m4v", "rekaman.final.mp4"]) assert.equal(videoFileProblem({ name }), null, name);
  for (const name of ["a.avi", "foto.jpg", "mp4", "", "video.mp4.exe"]) {
    assert.equal(videoFileProblem({ name }), "Format tidak didukung. Pakai MP4, MOV, MKV atau WEBM.", name);
  }
  assert.deepEqual(jobFormProblems({ ...valid, sourceType: "upload", video: { name: "a.avi" } }), {
    video: "Format tidak didukung. Pakai MP4, MOV, MKV atau WEBM.",
  });
  // The same extensions the upload route accepts.
  const route = await readFile(new URL("../app/api/jobs/route.js", import.meta.url), "utf8");
  const accepted = /const VIDEO_EXTENSIONS = new Set\(\[([^\]]+)\]\)/.exec(route)[1].match(/\.\w+/g);
  for (const extension of accepted) assert.equal(videoFileProblem({ name: `x${extension}` }), null, extension);
  assert.equal(videoFileProblem({ name: "x.avi" }) !== null, !accepted.includes(".avi"));
});

// --- The essentials and the three folds -----------------------------------------------------

test("three labelled folds hold the less used options; the essentials stay open", () => {
  assert.deepEqual(OPTION_SECTIONS.map((section) => [section.id, section.title]), [
    ["look", "Subtitle dan hook"],
    ["moments", "Arahkan pilihan momen"],
    ["format", "Bahasa dan resolusi"],
  ]);
  // Fields checked before a job is sent, and where each one lives.
  for (const field of ["youtubeUrl", "video", "subtitle", "limit", "minDuration", "maxDuration"]) assert.equal(sectionOfField(field), null, field);
  assert.equal(sectionOfField("timeRanges"), "moments");
  assert.equal(sectionOfField("focus"), "moments");
  assert.equal(sectionOfField("nope"), null);
});

test("a fold opens and closes on its own and is remembered with the other choices", () => {
  const opened = withSection(DEFAULT_CHOICES, "moments", true);
  assert.deepEqual(opened.openSections, ["moments"]);
  assert.deepEqual(DEFAULT_CHOICES.openSections, [], "the defaults are never changed");
  const both = withSection(opened, "look", true);
  assert.deepEqual(both.openSections, ["look", "moments"], "kept in display order");
  assert.equal(withSection(both, "look", true), both, "opening an open fold changes nothing");
  assert.deepEqual(withSection(both, "look", false).openSections, ["moments"]);
  assert.equal(withSection(both, "nope", true), both);
  const storage = memoryStorage();
  writeStoredChoices(storage, both);
  assert.deepEqual(readStoredChoices(storage).openSections, ["look", "moments"]);
});

test("each closed fold says what is chosen inside it, so nothing hides a default", () => {
  assert.equal(sectionSummary("look", DEFAULT_CHOICES), "Karaoke · Bawah, Sedang · Kalimat terkuat dulu · Teks hook");
  assert.equal(
    sectionSummary("look", { ...DEFAULT_CHOICES, captionStyle: "sorot", captionPosition: "top", captionSize: "large", coldOpen: false, hookOverlay: false }),
    "Sorot · Atas, Besar · Tanpa kalimat pembuka · Tanpa teks hook",
  );
  // The legacy engine draws no spot or size, so the summary does not name one.
  assert.equal(sectionSummary("look", DEFAULT_CHOICES, { engine: "legacy" }), "Karaoke · Kalimat terkuat dulu · Teks hook");
  assert.equal(sectionSummary("moments", DEFAULT_CHOICES), "Otomatis");
  assert.equal(sectionSummary("moments", DEFAULT_CHOICES, { focusTerms: 2, ranges: 1, note: true }), "2 kata kunci · 1 rentang waktu · ada catatan");
  assert.equal(sectionSummary("moments", DEFAULT_CHOICES, { focusTerms: 1 }), "1 kata kunci");
  assert.equal(sectionSummary("format", DEFAULT_CHOICES), "Bahasa Indonesia · 720p");
  assert.equal(sectionSummary("format", { ...DEFAULT_CHOICES, videoLanguage: "auto", resolution: "1080p" }), "Deteksi bahasa · 1080p");
  assert.equal(sectionSummary("nope", DEFAULT_CHOICES), "");
  for (const section of OPTION_SECTIONS) assert.doesNotMatch(sectionSummary(section.id, DEFAULT_CHOICES), /—|undefined|null/);
});
