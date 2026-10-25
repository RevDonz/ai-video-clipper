// The UI language never reaches the engine, the LLM or the render (rombak 07 §10.4, §11): the
// job's video language is the only content language. Child processes get the same argv and
// environment whatever the UI language, the job form has no UI-language field, nothing on the
// process side reads the i18n layer, and content text operations follow the content language.
// The render half (plan digest, ASS, render_key of one edit document) is
// tests/test_content_language_isolation.py, since only the engine builds them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRewriteRoute } from "../lib/clip-text-api.mjs";
import { contentCompare, contentLang, contentLower, contentUpper } from "../lib/content-text.mjs";
import { createAiRoute, createTaskRegistry } from "../lib/editor-ai.mjs";
import { JOB_FORM_FIELDS, parseJobOptions } from "../lib/jobs.mjs";
import { CHILD_ENV_ALLOWLIST, childEnv, runPythonCli } from "../lib/python-cli.mjs";
import { TokenBucketLimiter } from "../lib/rate-limit.mjs";
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

// --- editor-ai and clip-text-api: the child each route would start ----------------------------

const JOB_ID = "4d2c6b1a-7e3f-4a5b-9c8d-1e2f3a4b5c6d";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const LLM_ENV = Object.freeze({ POTONGIN_LLM: "on", POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: "planted-or-key-for-tests" });

/**
 * A runCli that hands each call to the real runPythonCli with a spawn that records the binary,
 * argv and environment (then refuses to start), and answers the route with an empty success.
 */
function spawnRecorder() {
  const spawned = [];
  const runCli = async (module, op, payload, options = {}) => {
    const spawnImpl = (bin, args, spawnOptions) => {
      spawned.push({ module, op, payload, bin, args, env: spawnOptions.env });
      throw new Error("recorded, not started");
    };
    await runPythonCli(module, op, payload, { ...options, pythonBin: "python", spawnImpl }).catch(() => null);
    return { exitCode: 0, json: op === "heuristic" ? { heuristic: [] } : {} };
  };
  return { spawned, runCli };
}

function jsonRequest(url, body) {
  return new Request(`http://local${url}`, {
    method: "POST",
    headers: { Host: "local", Origin: "http://local", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function editorAiChildren(session, task) {
  const { spawned, runCli } = spawnRecorder();
  const route = createAiRoute({
    env: { ...session, POTONGIN_EDITOR_LLM: "on" }, authorize: () => null, runCli,
    loadLlmEnv: async () => ({ env: { ...LLM_ENV } }), registry: createTaskRegistry(),
    limiter: new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }), newTaskId: () => "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  });
  const response = await route.POST(jsonRequest(`/api/jobs/${JOB_ID}/clips/${CLIP_ID}/ai`, { task, doc: { v: 1 } }),
    { params: Promise.resolve({ id: JOB_ID, clipId: CLIP_ID }) });
  assert.equal(response.status, 202, `${task}: ${await response.clone().text()}`);
  await new Promise((resolve) => setImmediate(resolve));
  return spawned;
}

test("editor-ai starts the same children with the same argv and environment in both sessions", async () => {
  for (const task of ["hooks", "spelling"]) {
    const id = await editorAiChildren(ID_SESSION, task);
    const en = await editorAiChildren(EN_SESSION, task);
    assert.ok(id.some((child) => child.op === "run-task"), `${task}: the LLM task is started`);
    assert.deepEqual(en, id, task);
    for (const child of id) {
      assert.equal([...child.args, ...Object.keys(child.env)].some((part) => UI_LANGUAGE.test(String(part))), false, task);
    }
  }
});

async function rewriteChildren(t, session) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-content-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, JOB_ID), { recursive: true });
  await writeFile(path.join(root, JOB_ID, "job.json"), JSON.stringify({
    id: JOB_ID, status: "completed", options: { selectionMode: "v3", videoLanguage: "id" },
    clips: [{ index: 1, text: "Gue tuh dulu kerja jadi security di mall.", title: "Judul", description: "" }],
  }));
  const { spawned, runCli } = spawnRecorder();
  const route = createRewriteRoute({
    env: session, jobsRoot: root, runCli, loadLlmEnv: async () => ({ env: { ...LLM_ENV } }),
    limiter: new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 }), running: { count: 0 },
  });
  await route.POST(jsonRequest(`/api/jobs/${JOB_ID}/clip-text/rewrite`, { index: 1 }), { params: Promise.resolve({ id: JOB_ID }) });
  return spawned;
}

test("clip-text rewrite starts the same child with the same argv and environment in both sessions", async (t) => {
  const id = await rewriteChildren(t, ID_SESSION);
  const en = await rewriteChildren(t, EN_SESSION);
  assert.equal(id.length, 1, "the rewrite child is started");
  assert.deepEqual(en, id);
  assert.equal([...id[0].args, ...Object.keys(id[0].env)].some((part) => UI_LANGUAGE.test(String(part))), false);
});
