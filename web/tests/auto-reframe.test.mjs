// Otomatis behind POTONGIN_AUTO_REFRAME (rombak 04 §0.2, §A8.1, RF-M3 = release 1, the floor):
// new jobs may ask for it only while the flag is on; a stored automatic job is always read.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseJobFormOptions } from "../app/api/jobs/route.js";
import {
  AUTO_LAYOUT_CHOICE,
  DEFAULT_CHOICES,
  LAYOUT_CHOICES,
  choicesSummary,
  layoutChoices,
  normalizeChoices,
  readStoredChoices,
  writeStoredChoices,
  CHOICES_KEY,
} from "../lib/dashboard-choices.mjs";
import { AUTO_REFRAME_FLAG, readAutoReframeFlag } from "../lib/editor/flags.mjs";
import {
  AUTO_RENDER_MODE,
  AutoReframeError,
  RENDER_MODES,
  STORED_RENDER_MODES,
  parseJobOptions,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import { jobStepText } from "../lib/dashboard-view.mjs";
import { lookPreview } from "../lib/look-preview.mjs";

const repoFile = (name) => readFile(new URL(`../../${name}`, import.meta.url), "utf8");

test("the flag is on only for the exact value on", () => {
  assert.equal(AUTO_REFRAME_FLAG, "POTONGIN_AUTO_REFRAME");
  for (const value of ["on", "ON", " on "]) assert.equal(readAutoReframeFlag({ POTONGIN_AUTO_REFRAME: value }), true, value);
  for (const value of [undefined, "", "off", "1", "true", "yes", "onn"]) {
    assert.equal(readAutoReframeFlag({ POTONGIN_AUTO_REFRAME: value }), false, String(value));
  }
  assert.equal(readAutoReframeFlag({}), false);
});

test("a new job asks for Otomatis only while the flag is on", () => {
  assert.deepEqual(RENDER_MODES, ["face-track", "fit-blur", "center-crop"]);
  assert.equal(AUTO_RENDER_MODE, "auto");
  assert.throws(() => parseJobOptions({ renderMode: "auto" }), (error) => {
    assert.ok(error instanceof AutoReframeError);
    assert.equal(error.code, "auto_reframe_off");
    assert.equal(error.messageId, "web.auto_reframe_off");
    return true;
  });
  assert.throws(() => parseJobOptions({ renderMode: "auto" }, { autoReframe: "on" }), AutoReframeError);
  const parsed = parseJobOptions({ renderMode: "auto" }, { autoReframe: true });
  assert.equal(parsed.renderMode, "auto");
  assert.equal(parsed.selectionMode, "v3");
  // the other modes do not depend on the flag
  for (const renderMode of RENDER_MODES) {
    assert.deepEqual(parseJobOptions({ renderMode }, { autoReframe: true }), parseJobOptions({ renderMode }));
  }
  assert.throws(() => parseJobOptions({ renderMode: "split" }, { autoReframe: true }), /Unsupported render mode/);
});

test("the job form reads the flag from the environment", () => {
  const form = new FormData();
  form.set("renderMode", "auto");
  assert.throws(() => parseJobFormOptions(form, {}), AutoReframeError);
  assert.throws(() => parseJobFormOptions(form, { POTONGIN_AUTO_REFRAME: "off" }), AutoReframeError);
  assert.equal(parseJobFormOptions(form, { POTONGIN_AUTO_REFRAME: "on" }).renderMode, "auto");
});

test("the job API refuses Otomatis with its own code and message id", async () => {
  const route = await readFile(new URL("../app/api/jobs/route.js", import.meta.url), "utf8");
  assert.match(route, /error instanceof AutoReframeError[\s\S]{0,200}code: error\.code, messageId: error\.messageId \}, \{ status: 400 \}/);
  for (const locale of ["id", "en"]) {
    const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}/errors.json`, import.meta.url), "utf8"));
    for (const code of ["auto_reframe_off", "auto_reframe_needs_v3"]) {
      assert.equal(typeof catalog.web[code], "string", `${locale} web.${code}`);
      assert.ok(catalog.web[code].trim(), `${locale} web.${code}`);
    }
  }
});

test("a stored automatic job is read whatever the flag says (the floor)", () => {
  assert.deepEqual(STORED_RENDER_MODES, [...RENDER_MODES, "auto"]);
  const stored = { renderMode: "auto", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3",
    llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
  assert.equal(validatePersistedJobOptions(stored).renderMode, "auto");
  // Otomatis exists only with Selection V3
  const { llmMode, coldOpen, hookOverlay, captionStyle, ...v1 } = stored;
  assert.throws(() => validatePersistedJobOptions({ ...v1, selectionMode: "v1" }), /automatic layout requires v3/);
  assert.throws(() => validatePersistedJobOptions({ ...v1, selectionMode: undefined }), /automatic layout requires v3/);
  assert.ok(llmMode && coldOpen && hookOverlay && captionStyle);
});

test("Buat klip offers Otomatis first, only while the flag is on, and never as the default", () => {
  assert.equal(layoutChoices(), LAYOUT_CHOICES);
  assert.equal(layoutChoices({ autoReframe: false }), LAYOUT_CHOICES);
  assert.deepEqual(layoutChoices({ autoReframe: true }), [AUTO_LAYOUT_CHOICE, ...LAYOUT_CHOICES]);
  assert.deepEqual(AUTO_LAYOUT_CHOICE, { id: "auto", name: "Otomatis" });
  assert.equal(DEFAULT_CHOICES.renderMode, "fit-blur");
  assert.equal(normalizeChoices({}, { autoReframe: true }).renderMode, "fit-blur");
  assert.equal(normalizeChoices({ renderMode: "auto" }, { autoReframe: true }).renderMode, "auto");
  // a choice kept from while it was on falls back to the default once it is off
  assert.equal(normalizeChoices({ renderMode: "auto" }).renderMode, "fit-blur");
  assert.ok(!LAYOUT_CHOICES.some((choice) => choice.id === "split"), "Layar terbagi is never a job layout");
});

test("the kept choices keep Otomatis only while the flag is on", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const choices = normalizeChoices({ renderMode: "auto" }, { autoReframe: true });
  assert.equal(writeStoredChoices(storage, choices, { autoReframe: true }), true);
  assert.equal(JSON.parse(store.get(CHOICES_KEY)).renderMode, "auto");
  assert.equal(readStoredChoices(storage, { autoReframe: true }).renderMode, "auto");
  assert.equal(readStoredChoices(storage).renderMode, "fit-blur");
  assert.match(choicesSummary(choices), /· Otomatis ·/);
});

test("the look preview draws Otomatis as a full 9:16 picture", () => {
  const preview = lookPreview({ renderMode: "auto" }, { autoReframe: true });
  assert.deepEqual(preview.picture, { mode: "fill", band: null });
  assert.match(preview.label, /: Otomatis,/);
  assert.equal(lookPreview({ renderMode: "auto" }).picture.mode, "fit", "off: the default, Latar blur");
});

test("the shot analysis counts as the rendering step", () => {
  const job = { status: "processing", source: { type: "upload" } };
  assert.equal(jobStepText({ ...job, stage: "reframe" }), jobStepText({ ...job, stage: "rendering" }));
  assert.notEqual(jobStepText({ ...job, stage: "reframe" }), null);
});

test("the flag reaches the app and both workers, off by default", async () => {
  const compose = await repoFile("compose.yaml");
  const lines = compose.match(/^ {6}POTONGIN_AUTO_REFRAME: \$\{POTONGIN_AUTO_REFRAME:-off\}$/gm) ?? [];
  assert.equal(lines.length, 3);
  for (const service of ["app", "primary-worker", "render-worker"]) {
    const start = compose.indexOf(`\n  ${service}:\n`);
    assert.ok(start >= 0, service);
    const next = compose.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    const block = compose.slice(start, next < 0 ? undefined : start + 1 + next);
    assert.match(block, /POTONGIN_AUTO_REFRAME: \$\{POTONGIN_AUTO_REFRAME:-off\}/, service);
  }
  const example = await repoFile(".env.example");
  assert.match(example, /^# POTONGIN_AUTO_REFRAME=off$/m);
});
