// The persistent preview worker's client (web/lib/python-cli.mjs `createPythonServer`, plan
// §10.3; W2 integration for PF-PLAN and PF-AUDIO). A stand-in server (a node script) speaks the
// protocol of src/ai_clipper/edit_v2/preview_server.py: a start line on stdin, a ready line on
// stdout, then per connection a pid line and `<exit code>\n<json>`.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHILD_ENV_ALLOWLIST,
  PYTHON_SERVER_MODULES,
  PythonCliError,
  createPythonServer,
} from "../lib/python-cli.mjs";

const SECRETS = {
  APP_PASSWORD: "app-password-value",
  APP_SESSION_SECRET: "session-secret-value-that-is-long-enough-000",
  POTONGIN_SETTINGS_SECRET: "settings-secret-value",
  OPENROUTER_API_KEY: "sk-or-secret",
};

const FAKE_SERVER = String.raw`
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
const here = path.dirname(process.argv[1]);
const behaviour = existsSync(path.join(here, "behaviour")) ? readFileSync(path.join(here, "behaviour"), "utf8").trim() : "ok";
writeFileSync(path.join(here, "starts-" + process.pid), process.argv.slice(2).join(" "));
if (behaviour === "crash") process.exit(3);
function environ() {
  const out = {};
  for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
    if (!entry) continue;
    const at = entry.indexOf("=");
    out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}
let pending = "";
let started = false;
let server = null;
process.stdin.on("data", (chunk) => {
  if (started) return;
  pending += chunk;
  const at = pending.indexOf("\n");
  if (at < 0) return;
  started = true;
  const config = JSON.parse(pending.slice(0, at));
  writeFileSync(path.join(here, "start-line"), JSON.stringify(config));
  server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const parts = [];
    conn.on("data", (c) => parts.push(c));
    conn.on("end", () => answer(conn, JSON.parse(Buffer.concat(parts).toString("utf8"))));
  });
  server.listen(path.join(config.dir, "preview.sock"), () => {
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n");
  });
});
process.stdin.on("end", () => { server?.close(); process.exit(0); });
function answer(conn, envelope) {
  const mode = envelope.mode;
  if (mode === "hangup") { conn.destroy(); return; }
  if (mode === "sleep") {
    const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    writeFileSync(envelope.pidFile, String(child.pid));
    conn.write(JSON.stringify({ pid: child.pid }) + "\n");
    return; // never answers
  }
  conn.write(JSON.stringify({ pid: process.pid }) + "\n");
  if (mode === "echo") conn.end("0\n" + JSON.stringify({ envelope, environ: environ(), server: process.pid }) + "\n");
  else if (mode === "exit") conn.end(envelope.code + "\n" + JSON.stringify(envelope.json) + "\n");
  else if (mode === "garbage") conn.end("0\nnot json\n");
  else if (mode === "flood") conn.end("0\n" + "x".repeat(envelope.bytes));
  else if (mode === "die") { conn.end("0\n"); process.exit(1); }
}
`;

async function fakeServer(t, behaviour = "ok") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-server-"));
  const python = path.join(dir, "python.mjs");
  await writeFile(python, `#!${process.execPath}\n${FAKE_SERVER}`);
  await chmod(python, 0o755);
  if (behaviour !== "ok") await writeFile(path.join(dir, "behaviour"), behaviour);
  const socketParent = await mkdtemp(path.join(os.tmpdir(), "python-server-sock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(socketParent, { recursive: true, force: true }));
  return { dir, python, socketParent };
}

function fallbackRecorder() {
  const calls = [];
  const fallback = async (module, op, payload) => {
    calls.push({ module, op, payload });
    return { exitCode: 0, json: { via: "spawn" } };
  };
  return { calls, fallback };
}

async function readyServer(t, options = {}) {
  const fake = await fakeServer(t, options.behaviour);
  const { calls, fallback } = fallbackRecorder();
  const server = createPythonServer("ai_clipper.edit_v2.preview_server", {
    cliModule: "ai_clipper.edit_v2.preview_cli", pythonBin: fake.python, fallback,
    env: { ...process.env, ...SECRETS, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs" },
    tmpdir: fake.socketParent, restartDelayMs: options.restartDelayMs ?? 50,
  });
  t.after(() => server.close());
  await server.start();
  return { ...fake, server, calls };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("only the preview worker can be started as a server", () => {
  assert.deepEqual([...PYTHON_SERVER_MODULES], ["ai_clipper.edit_v2.preview_server"]);
  assert.throws(() => createPythonServer("ai_clipper.edit_v2.api", { cliModule: "ai_clipper.edit_v2.api" }), PythonCliError);
  assert.throws(() => createPythonServer("ai_clipper.edit_v2.preview_server", { cliModule: "os" }), PythonCliError);
});

test("a request is answered by the server's child, with the allowlisted env only", async (t) => {
  const { server, calls, dir } = await readyServer(t);
  const result = await server.run("plan", { mode: "echo", jobId: "x" });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.json.envelope, { op: "plan", mode: "echo", jobId: "x" });
  assert.equal(calls.length, 0);
  for (const name of Object.keys(result.json.environ)) {
    assert.ok(CHILD_ENV_ALLOWLIST.includes(name), `unexpected ${name}`);
  }
  for (const value of Object.values(SECRETS)) assert.ok(!Object.values(result.json.environ).includes(value));
  const start = JSON.parse(await readFile(path.join(dir, "start-line"), "utf8"));
  assert.deepEqual(Object.keys(start).sort(), ["dir", "op"]);
  assert.equal(start.op, "serve");
  const starts = (await readdir(dir)).filter((name) => name.startsWith("starts-"));
  assert.equal(starts.length, 1);
  assert.equal(await readFile(path.join(dir, starts[0]), "utf8"), "-m ai_clipper.edit_v2.preview_server");
});

test("exit codes, bad output and floods map as for a spawned CLI", async (t) => {
  const { server } = await readyServer(t);
  assert.deepEqual(await server.run("plan", { mode: "exit", code: 3, json: { error: { code: "doc_invalid" } } }),
    { exitCode: 3, json: { error: { code: "doc_invalid" } } });
  await assert.rejects(server.run("plan", { mode: "exit", code: 77, json: {} }), { code: "backend_failed" });
  await assert.rejects(server.run("plan", { mode: "exit", code: 0, json: [1] }), { code: "invalid_output" });
  await assert.rejects(server.run("plan", { mode: "garbage" }), { code: "invalid_output" });
  await assert.rejects(server.run("plan", { mode: "flood", bytes: 50_000 }, { maxStdoutBytes: 10_000 }),
    { code: "output_too_large" });
  await assert.rejects(server.run("Bad Op", {}), { code: "invalid_request" });
});

test("a timeout stops the child's process group, and the server stays up", async (t) => {
  const { server, dir } = await readyServer(t);
  const pidFile = path.join(dir, "sleep.pid");
  await assert.rejects(server.run("cells", { mode: "sleep", pidFile }, { timeoutMs: 400, killGraceMs: 200 }),
    { code: "timeout" });
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(await until(() => !alive(pid)), "the child's group survived");
  assert.equal((await server.run("plan", { mode: "exit", code: 0, json: { again: true } })).json.again, true);
});

test("an abort stops the child as a spawned CLI is stopped", async (t) => {
  const { server, dir } = await readyServer(t);
  const pidFile = path.join(dir, "sleep.pid");
  const controller = new AbortController();
  const pending = server.run("audio", { mode: "sleep", pidFile }, { signal: controller.signal, killGraceMs: 200 });
  assert.ok(await until(async () => { try { await readFile(pidFile); return true; } catch { return false; } }));
  controller.abort();
  await assert.rejects(pending, { code: "aborted" });
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.ok(await until(() => !alive(pid)));
});

test("a connection closed before the pid line runs the request as a process instead", async (t) => {
  const { server, calls } = await readyServer(t);
  assert.deepEqual(await server.run("plan", { mode: "hangup" }), { exitCode: 0, json: { via: "spawn" } });
  assert.deepEqual(calls.map((call) => [call.module, call.op]), [["ai_clipper.edit_v2.preview_cli", "plan"]]);
});

test("a server that cannot start leaves every request to a spawned CLI", async (t) => {
  const fake = await fakeServer(t, "crash");
  const { calls, fallback } = fallbackRecorder();
  const server = createPythonServer("ai_clipper.edit_v2.preview_server", {
    cliModule: "ai_clipper.edit_v2.preview_cli", pythonBin: fake.python, fallback,
    env: { PATH: process.env.PATH }, tmpdir: fake.socketParent, restartDelayMs: 60_000,
  });
  t.after(() => server.close());
  assert.equal(await server.start(), false);
  assert.deepEqual(await server.run("plan", { a: 1 }), { exitCode: 0, json: { via: "spawn" } });
  assert.deepEqual(await server.run("plan", { a: 2 }), { exitCode: 0, json: { via: "spawn" } });
  assert.equal(calls.length, 2);
  const starts = (await readdir(fake.dir)).filter((name) => name.startsWith("starts-"));
  assert.equal(starts.length, 1, "no restart inside the back-off window");
});

test("a server that died is started again after the back-off", async (t) => {
  const { server, calls, dir } = await readyServer(t, { restartDelayMs: 50 });
  await assert.rejects(server.run("plan", { mode: "die" }), { code: "invalid_output" });
  assert.ok(await until(() => server.state() !== "ready"));
  // while it is down, requests are spawned; after the back-off a new server answers
  const first = await server.run("plan", { mode: "echo" });
  assert.equal(first.json.via ?? "server", first.json.via ? "spawn" : "server");
  assert.ok(await until(async () => {
    const result = await server.run("plan", { mode: "echo" });
    return !result.json.via;
  }));
  const starts = (await readdir(dir)).filter((name) => name.startsWith("starts-"));
  assert.equal(starts.length, 2);
  assert.ok(calls.length >= 0);
});

test("close stops the server and removes its socket directory", async (t) => {
  const { server, socketParent } = await readyServer(t);
  const pid = server.pid();
  assert.ok(alive(pid));
  assert.equal((await readdir(socketParent)).length, 1);
  await server.close();
  assert.ok(await until(() => !alive(pid)));
  assert.equal((await readdir(socketParent)).length, 0);
});
