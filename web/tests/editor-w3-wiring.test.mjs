// Deployment flags in compose.yaml and .env.example: the release defaults of plan §11.4 T4.Z as the
// owner decided them for W4 (the editor, its uploads after QG-SEC, its LLM part after the QG-AI
// hard gates; the auto clips' engine stays legacy until the owner decides the CPU quota). Each flag
// can still be changed in .env without a rebuild; the filler pre-check is not a flag and stays off.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = () => readFile(new URL("../../compose.yaml", import.meta.url), "utf8");
const envExample = () => readFile(new URL("../../.env.example", import.meta.url), "utf8");
const fillerLexicon = async () =>
  JSON.parse(await readFile(new URL("../../resources/lexicon/id-fillers.v1.json", import.meta.url), "utf8"));

function service(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name}`);
  const next = source.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("compose passes the editor flags to the app with the release defaults: editor, uploads and LLM on, and the automatic clips on the editor's engine", async () => {
  const app = service(await compose(), "app");
  assert.match(app, /^ {6}POTONGIN_EDITOR_V3: \$\{POTONGIN_EDITOR_V3:-on\}$/m);
  assert.match(app, /^ {6}POTONGIN_EDITOR_UPLOADS: \$\{POTONGIN_EDITOR_UPLOADS:-on\}$/m);
  assert.match(app, /^ {6}POTONGIN_EDITOR_LLM: \$\{POTONGIN_EDITOR_LLM:-on\}$/m);
  assert.match(app, /^ {6}POTONGIN_LLM_EDITOR_MODELS: \$\{POTONGIN_LLM_EDITOR_MODELS:-\}$/m);
  assert.match(app, /^ {6}POTONGIN_RENDER_ENGINE: \$\{POTONGIN_RENDER_ENGINE:-edit-v2\}$/m);
});

test("only the app serves the editor: the workers get no editor upload or AI flag, and the same engine", async () => {
  const source = await compose();
  for (const name of ["primary-worker", "render-worker"]) {
    const worker = service(source, name);
    assert.doesNotMatch(worker, /POTONGIN_EDITOR_(?:UPLOADS|LLM)|POTONGIN_LLM_EDITOR_MODELS/, name);
    assert.match(worker, /^ {6}POTONGIN_RENDER_ENGINE: \$\{POTONGIN_RENDER_ENGINE:-edit-v2\}$/m, name);
  }
  assert.doesNotMatch(source, /POTONGIN_RENDER_ENGINE:-legacy|POTONGIN_EDITOR_(?:V3|UPLOADS|LLM):-off/);
});

test(".env.example names every flag with its release default and how to switch it off", async () => {
  const text = await envExample();
  for (const [name, value, off] of [
    ["POTONGIN_EDITOR_V3", "on", "off"],
    ["POTONGIN_EDITOR_UPLOADS", "on", "off"],
    ["POTONGIN_EDITOR_LLM", "on", "off"],
    ["POTONGIN_RENDER_ENGINE", "edit-v2", "legacy"],
    ["POTONGIN_AUTO_PAUSE_TRIM", "on", "off"],
  ]) {
    assert.match(text, new RegExp(`^# ${name}=${value}$`, "m"), name);
    assert.match(text, new RegExp(`${name}=${off}\\b`), `${name} names its off value`);
  }
});

test("the primary worker trims the automatic clips' silent pauses unless .env turns it off (CONTRACTS §5.58)", async () => {
  const source = await compose();
  assert.match(service(source, "primary-worker"), /^ {6}POTONGIN_AUTO_PAUSE_TRIM: \$\{POTONGIN_AUTO_PAUSE_TRIM:-on\}$/m);
  for (const name of ["app", "render-worker"]) assert.doesNotMatch(service(source, name), /POTONGIN_AUTO_PAUSE_TRIM/, name);
});

test("the filler pre-check of Rapikan stays off until the owner confirms the labels", async () => {
  assert.equal((await fillerLexicon()).precheck, false);
});

// The one-layout editor's flag (rombak 06 §17, 08 Fase 10): only the app reads it, legacy until
// the phase passes; v2 shows the new shell and legacy rolls it back without a rebuild.
test("compose passes POTONGIN_EDITOR_SHELL to the app only, legacy by default, and .env.example names v2 and the rollback", async () => {
  const source = await compose();
  assert.match(service(source, "app"), /^ {6}POTONGIN_EDITOR_SHELL: \$\{POTONGIN_EDITOR_SHELL:-legacy\}$/m);
  for (const name of ["primary-worker", "render-worker"]) assert.doesNotMatch(service(source, name), /POTONGIN_EDITOR_SHELL/, name);
  const text = await envExample();
  assert.match(text, /^# POTONGIN_EDITOR_SHELL=legacy$/m);
  assert.match(text, /POTONGIN_EDITOR_SHELL=v2\b/);
});
