// W3 integration seams (plan §11.3 T3.Z): the deployment flags in compose.yaml and their defaults.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const compose = () => readFile(new URL("../../compose.yaml", import.meta.url), "utf8");

function service(source, name) {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `service ${name}`);
  const next = source.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

test("compose passes the editor flags to the app, off by default, and the engine stays legacy", async () => {
  const app = service(await compose(), "app");
  assert.match(app, /^ {6}POTONGIN_EDITOR_V3: \$\{POTONGIN_EDITOR_V3:-off\}$/m);
  assert.match(app, /^ {6}POTONGIN_EDITOR_UPLOADS: \$\{POTONGIN_EDITOR_UPLOADS:-off\}$/m);
  assert.match(app, /^ {6}POTONGIN_EDITOR_LLM: \$\{POTONGIN_EDITOR_LLM:-off\}$/m);
  assert.match(app, /^ {6}POTONGIN_LLM_EDITOR_MODELS: \$\{POTONGIN_LLM_EDITOR_MODELS:-\}$/m);
  assert.match(app, /^ {6}POTONGIN_RENDER_ENGINE: \$\{POTONGIN_RENDER_ENGINE:-legacy\}$/m);
});

test("only the app serves the editor: the workers get no editor upload or AI flag", async () => {
  const source = await compose();
  for (const name of ["primary-worker", "render-worker"]) {
    const worker = service(source, name);
    assert.doesNotMatch(worker, /POTONGIN_EDITOR_(?:UPLOADS|LLM)|POTONGIN_LLM_EDITOR_MODELS/, name);
    assert.match(worker, /POTONGIN_RENDER_ENGINE: \$\{POTONGIN_RENDER_ENGINE:-legacy\}/, name);
  }
});
