import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHILD_ENV_ALLOWLIST,
  EXIT_CODES,
  PYTHON_CLI_MODULES,
  PythonCliError,
  childEnv,
  httpStatusForExit,
  runPythonCli,
} from "../lib/python-cli.mjs";

const SECRETS = {
  APP_PASSWORD: "app-password-value",
  APP_SESSION_SECRET: "session-secret-value-that-is-long-enough-000",
  APP_USERNAME: "admin",
  POTONGIN_SETTINGS_SECRET: "settings-secret-value",
  POTONGIN_SETTINGS_DIR: "/data/settings",
  OPENROUTER_API_KEY: "sk-or-secret",
  GEMINI_API_KEY: "gemini-secret",
  POTONGIN_LLM: "on",
  POTONGIN_LLM_PROVIDERS: "openrouter",
  POTONGIN_LLM_CUSTOM_API_KEY: "custom-secret",
  NODE_OPTIONS: "--inspect",
  WHISPER_MODEL: "small",
};
const ALLOWED = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/node",
  LANG: "C.UTF-8",
  TZ: "Asia/Jakarta",
  TMPDIR: "/tmp",
  JOBS_ROOT: "/data/jobs",
  FONTCONFIG_FILE: "/app/resources/fontconfig/fonts.conf",
  POTONGIN_RENDER_ENGINE: "legacy",
  POTONGIN_EDITOR_V3: "off",
  POTONGIN_EDITOR_UPLOADS: "off",
  POTONGIN_EDITOR_LLM: "off",
};
const SECRET_NAME = /^(?:APP_|POTONGIN_SETTINGS_|POTONGIN_LLM)|_API_KEY$/;

// A stand-in "python": a node script that obeys its stdin envelope.
const FAKE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const stdin = readFileSync(0, "utf8");
const envelope = JSON.parse(stdin);
let environ = {};
try {
  for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
    if (!entry) continue;
    const at = entry.indexOf("=");
    environ[entry.slice(0, at)] = entry.slice(at + 1);
  }
} catch { environ = { ...process.env }; }
const mode = envelope.mode;
if (mode === "echo") {
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), envelope, environ }));
} else if (mode === "exit") {
  process.stdout.write(JSON.stringify(envelope.json));
  process.exitCode = envelope.code;
} else if (mode === "garbage") {
  process.stdout.write("not json");
} else if (mode === "flood") {
  process.stdout.write("x".repeat(envelope.bytes));
} else if (mode === "sleep") {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  writeFileSync(envelope.pidFile, String(child.pid));
  setTimeout(() => {}, 30_000);
}
`;

async function fakePython() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-cli-"));
  const script = path.join(dir, "fake.mjs");
  const python = path.join(dir, "python");
  await writeFile(script, FAKE);
  await writeFile(python, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(python, 0o755);
  return { dir, python };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("the allowlist is exactly the E11 names plus the non-secret editor flags", () => {
  assert.deepEqual([...CHILD_ENV_ALLOWLIST].sort(), Object.keys(ALLOWED).sort());
  assert.ok(Object.isFrozen(CHILD_ENV_ALLOWLIST));
  for (const name of CHILD_ENV_ALLOWLIST) assert.doesNotMatch(name, SECRET_NAME);
});

test("childEnv keeps only allowlisted names", () => {
  const env = childEnv({ ...ALLOWED, ...SECRETS });
  assert.deepEqual(env, ALLOWED);
  assert.deepEqual(childEnv({ PATH: "/bin", EMPTY: "" }), { PATH: "/bin" });
});

test("childEnv adds only LLM variables for the AI task, never dashboard secrets", () => {
  const llmEnv = { ...SECRETS, PATH: "/evil" };
  const env = childEnv(ALLOWED, { llmEnv });
  assert.equal(env.PATH, ALLOWED.PATH);
  assert.equal(env.OPENROUTER_API_KEY, "sk-or-secret");
  assert.equal(env.POTONGIN_LLM_PROVIDERS, "openrouter");
  assert.equal(env.POTONGIN_LLM_CUSTOM_API_KEY, "custom-secret");
  for (const name of ["APP_PASSWORD", "APP_SESSION_SECRET", "APP_USERNAME", "POTONGIN_SETTINGS_SECRET",
    "POTONGIN_SETTINGS_DIR", "NODE_OPTIONS", "WHISPER_MODEL"]) {
    assert.equal(env[name], undefined, name);
  }
});

test("a spawned child sees no secret in /proc/self/environ", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runPythonCli("ai_clipper.edit_v2.api", "get", { mode: "echo", jobId: "x" }, {
    pythonBin: python, env: { ...process.env, ...ALLOWED, PATH: process.env.PATH, ...SECRETS },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json.argv, ["-m", "ai_clipper.edit_v2.api"]);
  assert.deepEqual(result.json.envelope, { op: "get", mode: "echo", jobId: "x" });
  const names = Object.keys(result.json.environ);
  for (const name of names) assert.ok(CHILD_ENV_ALLOWLIST.includes(name), `unexpected ${name}`);
  for (const value of Object.values(SECRETS)) {
    assert.ok(!Object.values(result.json.environ).includes(value));
  }
  assert.equal(result.json.environ.JOBS_ROOT, "/data/jobs");
});

test("only the AI task child receives LLM keys", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const base = { ...ALLOWED, PATH: process.env.PATH, ...SECRETS };
  const loadLlmEnvImpl = async () => ({ env: { ...base, POTONGIN_LLM: "on", OPENROUTER_API_KEY: "sealed-key" } });
  const ai = await runPythonCli("ai_clipper.editor_ai", "run-task", { mode: "echo" }, {
    pythonBin: python, env: base, withLlmEnv: true, loadLlmEnvImpl,
  });
  assert.equal(ai.json.environ.OPENROUTER_API_KEY, "sealed-key");
  assert.equal(ai.json.environ.APP_PASSWORD, undefined);
  assert.equal(ai.json.environ.POTONGIN_SETTINGS_SECRET, undefined);
  const plain = await runPythonCli("ai_clipper.edit_v2.api", "get", { mode: "echo" }, {
    pythonBin: python, env: base, loadLlmEnvImpl,
  });
  assert.equal(plain.json.environ.OPENROUTER_API_KEY, undefined);
  assert.equal(plain.json.environ.POTONGIN_LLM, undefined);
});

test("module, op and payload are validated before anything is spawned", async () => {
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; throw new Error("must not spawn"); };
  const cases = [
    ["os", "get", {}],
    ["ai_clipper.edit_v2.api;rm", "get", {}],
    ["ai_clipper.edit_v2.api", "GET", {}],
    ["ai_clipper.edit_v2.api", "get;x", {}],
    ["ai_clipper.edit_v2.api", "get", { op: "put" }],
    ["ai_clipper.edit_v2.api", "get", ["not", "an", "object"]],
    ["ai_clipper.edit_v2.api", "get", null],
    ["ai_clipper.edit_v2.api", "get", { big: "x".repeat(64) }],
  ];
  for (const [module, op, payload] of cases) {
    await assert.rejects(runPythonCli(module, op, payload, { spawnImpl, maxStdinBytes: 32 }),
      (error) => error instanceof PythonCliError && error.code === "invalid_request", `${module} ${op}`);
  }
  assert.equal(spawned, 0);
  assert.ok(PYTHON_CLI_MODULES.includes("ai_clipper.edit_v2.api"));
  assert.ok(PYTHON_CLI_MODULES.includes("ai_clipper.edit_v2.preview_cli"));
});

test("a timeout kills the whole process group", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, "grandchild.pid");
  await assert.rejects(
    runPythonCli("ai_clipper.edit_v2.preview_cli", "cells", { mode: "sleep", pidFile }, {
      pythonBin: python, env: { PATH: process.env.PATH }, timeoutMs: 700,
    }),
    (error) => error instanceof PythonCliError && error.code === "timeout",
  );
  const grandchild = Number(await readFile(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(alive(grandchild), false);
});

test("an abort signal kills the child", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const pidFile = path.join(dir, "grandchild.pid");
  const running = runPythonCli("ai_clipper.edit_v2.preview_cli", "cells", { mode: "sleep", pidFile }, {
    pythonBin: python, env: { PATH: process.env.PATH }, signal: controller.signal, timeoutMs: 10_000,
  });
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(running, (error) => error instanceof PythonCliError && error.code === "aborted");
  const already = new AbortController();
  already.abort();
  await assert.rejects(runPythonCli("ai_clipper.edit_v2.api", "get", {}, { signal: already.signal }),
    (error) => error.code === "aborted");
});

test("stdout is bounded", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    runPythonCli("ai_clipper.edit_v2.api", "get", { mode: "flood", bytes: 200_000 }, {
      pythonBin: python, env: { PATH: process.env.PATH }, maxStdoutBytes: 50_000,
    }),
    (error) => error instanceof PythonCliError && error.code === "output_too_large",
  );
});

test("fixed exit codes resolve with their JSON; anything else is a backend failure", async (t) => {
  const { dir, python } = await fakePython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { pythonBin: python, env: { PATH: process.env.PATH } };
  const notFound = await runPythonCli("ai_clipper.edit_v2.api", "get",
    { mode: "exit", code: 4, json: { error: { code: "not_found" } } }, options);
  assert.deepEqual(notFound, { exitCode: 4, json: { error: { code: "not_found" } } });
  for (const code of [1, 2, 13, 99]) {
    await assert.rejects(runPythonCli("ai_clipper.edit_v2.api", "get", { mode: "exit", code, json: {} }, options),
      (error) => error instanceof PythonCliError && error.code === "backend_failed", String(code));
  }
  await assert.rejects(runPythonCli("ai_clipper.edit_v2.api", "get", { mode: "garbage" }, options),
    (error) => error instanceof PythonCliError && error.code === "invalid_output");
  await assert.rejects(runPythonCli("ai_clipper.edit_v2.api", "get", {}, {
    pythonBin: path.join(dir, "missing-python"), env: { PATH: process.env.PATH },
  }), (error) => error instanceof PythonCliError && error.code === "spawn_failed");
});

test("exit codes map to HTTP statuses (CONTRACTS §5.3)", () => {
  assert.deepEqual(Object.keys(EXIT_CODES).map(Number), [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(httpStatusForExit(0), 200);
  assert.equal(httpStatusForExit(3), 422);
  assert.equal(httpStatusForExit(4), 404);
  assert.equal(httpStatusForExit(5), 409);
  assert.equal(httpStatusForExit(6), 422);
  assert.equal(httpStatusForExit(7), 426);
  assert.equal(httpStatusForExit(8), 409);
  assert.equal(httpStatusForExit(9), 409);
  assert.equal(httpStatusForExit(10), 500);
  assert.equal(httpStatusForExit(11), 500);
  assert.equal(httpStatusForExit(12), 409);
  assert.equal(httpStatusForExit(1), 500);
  assert.equal(httpStatusForExit(42), 500);
});
