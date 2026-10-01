// E11 for the older Python helpers (W2 verifier finding): the render queue (legacy requests and
// the source estimate) spawns its Python child with python-cli's allowlisted environment, so no
// child ever holds APP_*, POTONGIN_SETTINGS_*, POTONGIN_LLM* or an *_API_KEY. (The candidate
// editor's helpers, which this test also covered, were retired on main with that editor; main's
// project-view.test.mjs checks that they are gone.)
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CHILD_ENV_ALLOWLIST } from "../lib/python-cli.mjs";
import { estimateRenderSourceBytes, runRenderQueuePython } from "../lib/render-requests.mjs";

const SECRETS = {
  APP_USERNAME: "owner",
  APP_PASSWORD: "app-password-value",
  APP_SESSION_SECRET: "session-secret-value-that-is-long-enough-000",
  POTONGIN_SETTINGS_SECRET: "settings-secret-value",
  POTONGIN_SETTINGS_DIR: "/data/settings",
  OPENROUTER_API_KEY: "sk-or-secret",
  GEMINI_API_KEY: "gemini-secret",
  POTONGIN_LLM_CUSTOM_API_KEY: "custom-secret",
};

// A stand-in "python": records its argv and environment next to itself, then fails.
const FAKE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
try { readFileSync(0); } catch { /* no stdin */ }
const environ = {};
for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
  if (!entry) continue;
  const at = entry.indexOf("=");
  environ[entry.slice(0, at)] = entry.slice(at + 1);
}
writeFileSync(path.join(path.dirname(process.argv[1]), "env-" + process.pid + ".json"),
  JSON.stringify({ argv: process.argv.slice(2), environ }));
process.exit(1);
`;

test("the older Python helpers give their child the allowlisted environment only", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-spawn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const python = path.join(dir, "python.mjs");
  await writeFile(python, `#!${process.execPath}\n${FAKE}`);
  await chmod(python, 0o755);
  const saved = {};
  for (const [name, value] of Object.entries({ ...SECRETS, JOBS_ROOT: "/data/jobs", MAX_UPLOAD_BYTES: "1048576" })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const options = { pythonBin: python, timeoutMs: 10_000 };
  const calls = [
    ["ai_clipper.render_queue", () => runRenderQueuePython("/data/jobs/x", { operation: "get" }, options)],
    ["ai_clipper.render_queue", () => estimateRenderSourceBytes("/data/jobs/x", options)],
  ];
  for (const [, call] of calls) await assert.rejects(call());
  const records = [];
  for (const name of (await readdir(dir)).filter((entry) => entry.startsWith("env-"))) {
    records.push(JSON.parse(await readFile(path.join(dir, name), "utf8")));
  }
  assert.deepEqual(records.map((record) => record.argv[1]).sort(), calls.map(([module]) => module).sort());
  for (const record of records) {
    for (const name of Object.keys(record.environ)) {
      assert.ok(CHILD_ENV_ALLOWLIST.includes(name), `${record.argv[1]}: unexpected ${name}`);
    }
    for (const value of Object.values(SECRETS)) {
      assert.ok(!Object.values(record.environ).includes(value), `${record.argv[1]} holds a secret`);
    }
    assert.equal(record.environ.JOBS_ROOT, "/data/jobs");
    // the render queue's source snapshot limit (not a secret) still reaches the child
    assert.equal(record.environ.MAX_UPLOAD_BYTES, "1048576");
  }
});
