// The UI language never reaches the engine, the LLM or the render (rombak 07 §10.4, §11): the
// job's video language is the only content language. Child processes get the same argv and
// environment whatever the UI language, the job form has no UI-language field, nothing on the
// process side reads the i18n layer, and content text operations follow the content language.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { contentCompare, contentLang, contentLower, contentUpper } from "../lib/content-text.mjs";
import { JOB_FORM_FIELDS, parseJobOptions } from "../lib/jobs.mjs";
import { CHILD_ENV_ALLOWLIST, childEnv } from "../lib/python-cli.mjs";
import { buildClipperInvocation, downloaderEnv } from "../scripts/run-job.mjs";
import { WEB, parseSource, walk } from "./support/i18n-scan.mjs";

const REPO = path.join(WEB, "..");
// The app's environment in a session of each language: the flag is on, the e2e strict switch too.
const BASE = Object.freeze({ PATH: "/usr/bin", HOME: "/home/app", WHISPER_MODEL: "small", POTONGIN_EDITOR_V3: "on" });
const ID_SESSION = Object.freeze({ ...BASE, POTONGIN_LOCALES: "id" });
const EN_SESSION = Object.freeze({ ...BASE, POTONGIN_LOCALES: "id,en", POTONGIN_I18N_STRICT: "1" });
// The parts of the i18n layer that know the viewer's language (format.mjs only formats).
const UI_LANGUAGE = /POTONGIN_LOCALES|POTONGIN_I18N|potongin_locale|accept-language|i18n\/(?:server|cookie|resolve|client)\b/i;

test("the Python children's environment is the same in an Indonesian and an English session", () => {
  assert.deepEqual(childEnv(EN_SESSION), childEnv(ID_SESSION));
  assert.equal(Object.keys(childEnv(EN_SESSION)).some((name) => UI_LANGUAGE.test(name)), false);
  assert.equal(CHILD_ENV_ALLOWLIST.some((name) => UI_LANGUAGE.test(name)), false);
});

test("the engine argv depends on the job's video language, never on the UI language", () => {
  for (const videoLanguage of ["id", "en", "auto"]) {
    const job = { options: parseJobOptions({ selectionMode: "v3", videoLanguage }) };
    const id = buildClipperInvocation(job, "/in/source.mp4", "/j/output", ID_SESSION);
    const en = buildClipperInvocation(job, "/in/source.mp4", "/j/output", EN_SESSION);
    assert.deepEqual(en, id, videoLanguage);
    assert.equal(id.args[id.args.indexOf("--language") + 1], videoLanguage);
    assert.equal(id.args.some((arg) => UI_LANGUAGE.test(String(arg))), false);
  }
});

test("the worker never gets the UI flag, so its downloader cannot pass it on", async () => {
  // compose.yaml gives POTONGIN_LOCALES to the app service only (env-example.test.mjs).
  const worker = { ...BASE, JOBS_ROOT: "/data/jobs" };
  assert.deepEqual(downloaderEnv(worker), worker);
  const compose = await readFile(path.join(REPO, "compose.yaml"), "utf8");
  assert.equal((compose.match(/POTONGIN_LOCALES/g) ?? []).length, 2, "one line in the app service");
});

test("a job carries no UI language: the form has no such field and options ignore one", () => {
  assert.equal(JOB_FORM_FIELDS.some((name) => /locale|uiLanguage/i.test(name)), false);
  const plain = parseJobOptions({});
  const withLocale = parseJobOptions({ locale: "en", uiLocale: "en", potongin_locale: "en" });
  assert.deepEqual(withLocale, plain);
});

async function filesUnder(dir, pattern) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "__pycache__"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full, pattern));
    else if (pattern.test(entry.name)) out.push(full);
  }
  return out;
}

// The files that start or feed a child process (security-child-env.test.mjs lists the spawn
// sites), and the routes whose children get text: none of them imports or reads the i18n layer.
const PROCESS_SIDE = Object.freeze([
  "lib/python-cli.mjs", "lib/clip-renders.mjs", "lib/llm-settings-actions.mjs", "lib/editor-ai.mjs", "lib/clip-text-api.mjs",
  "lib/primary-job-queue.mjs", "lib/preview-lane.mjs", "scripts/primary-worker.mjs", "scripts/run-job.mjs", "scripts/run-render.mjs",
]);

test("nothing on the process side imports the i18n layer or reads the UI language", async () => {
  for (const file of PROCESS_SIDE) {
    const source = await readFile(path.join(WEB, file), "utf8");
    const imports = [];
    walk(parseSource(source, file).program, (node) => {
      if (node.type === "ImportDeclaration") imports.push(node.source.value);
    });
    assert.equal(imports.some((name) => UI_LANGUAGE.test(name)), false, `${file} imports the i18n layer`);
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /POTONGIN_LOCALES|potongin_locale|getLocale\(/, file);
  }
  const python = await filesUnder(path.join(REPO, "src", "ai_clipper"), /\.py$/);
  assert.ok(python.length > 20, "the engine sources are read");
  for (const file of python) {
    assert.doesNotMatch(await readFile(file, "utf8"), /POTONGIN_LOCALES|potongin_locale|POTONGIN_I18N/, path.relative(REPO, file));
  }
});

test("content text follows the content language: the job's video language, else Indonesian", () => {
  assert.equal(contentLang({ options: { videoLanguage: "en" } }), "en");
  assert.equal(contentLang({ options: { videoLanguage: "id" } }), "id");
  assert.equal(contentLang({ options: { videoLanguage: "auto" } }), "id");
  assert.equal(contentLang({ options: {} }), "id");
  assert.equal(contentLang(null), "id");
  // The same as the literal calls they replace.
  for (const text of ["Ini Judul", "ISTANBUL", "Çağrı", "straße", "Ǆ"]) {
    assert.equal(contentLower(text), text.toLocaleLowerCase("id-ID"));
    assert.equal(contentUpper(text), text.toLocaleUpperCase("id"));
  }
  assert.equal(contentUpper("i", "en"), "I");
  assert.equal(contentUpper("i", "xx"), "i".toLocaleUpperCase("id"));
  assert.equal(contentCompare("apel", "Apel"), 0);
  assert.ok(contentCompare("apel", "jeruk") < 0);
  assert.ok(contentCompare("zebra", "apel", "en") > 0);
});
