// The one way editor routes spawn Python (plan §4.2, §9.1, E11; Appendix A.2).
//
// - No shell: `spawn(python, ["-m", <module>])` with the module from a fixed list.
// - stdin is one JSON envelope `{"op": <op>, ...payload}`, bounded; stdout is one JSON object,
//   bounded; stderr is drained (bounded) and never returned, so no path or text leaks.
// - The child gets an allowlisted environment: `CHILD_ENV_ALLOWLIST`, never APP_*,
//   POTONGIN_SETTINGS_*, POTONGIN_LLM* or *_API_KEY. Only the AI task (`withLlmEnv`) adds the
//   LLM variables of `engineProcessEnv(await loadLlmEnv())`, as run-job.mjs does for the engine.
// - The child leads its own process group; a timeout or an abort sends SIGTERM to the whole
//   group, then SIGKILL after `killGraceMs` (2 s). SIGTERM first lets `preview_cli` kill FFmpeg,
//   which runs in a session of its own (execute.run), before it exits with 12 (T2.3).
// - Exit codes are the fixed map of docs/editor/CONTRACTS.md §5.3: a mapped code resolves with
//   `{exitCode, json}`; 1 (unexpected), 2 (usage: our bug) and anything else reject.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { engineProcessEnv, isLlmVariable, loadLlmEnv } from "./llm-settings.mjs";

export const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH", "HOME", "LANG", "TZ", "TMPDIR", "JOBS_ROOT", "FONTCONFIG_FILE",
  // non-secret feature flags (plan §11.0)
  "POTONGIN_RENDER_ENGINE", "POTONGIN_EDITOR_V3", "POTONGIN_EDITOR_UPLOADS", "POTONGIN_EDITOR_LLM",
]);

// The CLIs of Appendix A.1 ("CLIs"): nothing else can be started through this helper.
export const PYTHON_CLI_MODULES = Object.freeze([
  "ai_clipper.edit_v2.api",
  "ai_clipper.edit_v2.preview_cli",
  "ai_clipper.edit_v2.assets",
  "ai_clipper.edit_v2.cleanup",
  "ai_clipper.edit_v2.coldopen",
  "ai_clipper.editor_ai",
  // Editor V3 exports: the render-request-v3 envelope (CONTRACTS §5.17; T2.2 request R1).
  "ai_clipper.render_queue",
]);

// CONTRACTS §5.3: CLI exit code → [code name, HTTP status].
export const EXIT_CODES = Object.freeze({
  0: Object.freeze(["ok", 200]),
  3: Object.freeze(["invalid", 422]),
  4: Object.freeze(["not_found", 404]),
  5: Object.freeze(["revision_conflict", 409]),
  6: Object.freeze(["semantic", 422]),
  7: Object.freeze(["schema_too_new", 426]),
  8: Object.freeze(["analysis_missing", 409]),
  9: Object.freeze(["idempotency_conflict", 409]),
  10: Object.freeze(["render_failed", 500]),
  11: Object.freeze(["verification_failed", 500]),
  12: Object.freeze(["cancelled", 409]),
});

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_STDIN_BYTES = 3 * 1024 * 1024; // a 1 MiB document travels base64-encoded
export const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const OP = /^[a-z][a-z0-9_-]{0,31}$/;

export class PythonCliError extends Error {
  constructor(code) {
    super(`python cli: ${code}`);
    this.name = "PythonCliError";
    this.code = code; // invalid_request | spawn_failed | timeout | aborted | output_too_large |
    //                  invalid_output | backend_failed
  }
}

export function httpStatusForExit(exitCode) {
  return EXIT_CODES[exitCode]?.[1] ?? 500;
}

/** The environment of a child: allowlisted names only, plus LLM variables for the AI task. */
export function childEnv(baseEnv = process.env, { llmEnv = null } = {}) {
  const env = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = baseEnv?.[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  if (llmEnv) {
    for (const [name, value] of Object.entries(engineProcessEnv(llmEnv))) {
      if (isLlmVariable(name) && typeof value === "string" && value !== "") env[name] = value;
    }
  }
  return env;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new PythonCliError("invalid_request");
  return Math.min(value, maximum);
}

function envelopeBytes(op, payload, maxStdinBytes) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload) || "op" in payload) {
    throw new PythonCliError("invalid_request");
  }
  let raw;
  try { raw = Buffer.from(JSON.stringify({ op, ...payload }), "utf8"); } catch {
    throw new PythonCliError("invalid_request");
  }
  if (raw.length > maxStdinBytes) throw new PythonCliError("invalid_request");
  return raw;
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Run `python -m <module>` with `{"op": op, ...payload}` on stdin.
 * Resolves `{exitCode, json}` for the mapped exit codes; rejects `PythonCliError` otherwise.
 */
export async function runPythonCli(module, op, payload, options = {}) {
  const {
    timeoutMs, maxStdoutBytes, maxStdinBytes, withLlmEnv = false, signal, killGraceMs = DEFAULT_KILL_GRACE_MS,
    env = process.env, pythonBin = process.env.PYTHON_BIN || "python",
    spawnImpl = spawn, loadLlmEnvImpl = loadLlmEnv,
  } = options;
  if (!PYTHON_CLI_MODULES.includes(module) || typeof op !== "string" || !OP.test(op)) {
    throw new PythonCliError("invalid_request");
  }
  const timeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const stdoutLimit = positiveInteger(maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
  const stdin = envelopeBytes(op, payload, positiveInteger(maxStdinBytes, DEFAULT_MAX_STDIN_BYTES));
  if (signal?.aborted) throw new PythonCliError("aborted");
  const llmEnv = withLlmEnv ? (await loadLlmEnvImpl(env)).env : null;
  const childEnvironment = childEnv(env, { llmEnv });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(/* turbopackIgnore: true */ pythonBin, ["-m", module], {
        env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false,
        windowsHide: true,
      });
    } catch {
      reject(new PythonCliError("spawn_failed"));
      return;
    }
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let settled = false;

    let killTimer = null;
    const fail = (code) => {
      if (failure) return;
      failure = code;
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), Math.max(0, killGraceMs));
    };
    const timer = setTimeout(() => fail("timeout"), timeout);
    const onAbort = () => fail("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        signalGroup(child, "SIGKILL"); // whatever of the group outlived its leader
      }
      signal?.removeEventListener("abort", onAbort);
      settle();
    };

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > stdoutLimit) fail("output_too_large");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderrBytes = Math.min(stderrBytes + chunk.length, MAX_STDERR_BYTES); });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure = failure || "spawn_failed";
      finish(() => reject(new PythonCliError(failure)));
    });
    child.on("close", (code) => {
      finish(() => {
        if (failure) {
          reject(new PythonCliError(failure));
          return;
        }
        if (!(code in EXIT_CODES)) {
          reject(new PythonCliError("backend_failed"));
          return;
        }
        let json;
        try {
          json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          reject(new PythonCliError("invalid_output"));
          return;
        }
        if (json === null || typeof json !== "object" || Array.isArray(json)) {
          reject(new PythonCliError("invalid_output"));
          return;
        }
        resolve({ exitCode: code, json });
      });
    });
    child.stdin.end(stdin);
  });
}

// --- the persistent preview worker (plan §10.3; W2 integration for PF-PLAN and PF-AUDIO) ------
//
// `createPythonServer` starts `python -m ai_clipper.edit_v2.preview_server` once, with the same
// allowlisted environment (E11), and runs requests on it: the server forks one child per
// connection on a Unix socket in a private directory (mkdtemp, 0700), and the child is exactly
// one CLI process as before (its own process group; SIGTERM cancels it) without the interpreter
// start-up and imports. `run` has runPythonCli's contract (exit codes, bounded output, timeout
// and abort stop the child's group with SIGTERM, then SIGKILL after `killGraceMs`). While the
// server is not up (starting, crashed, inside the restart back-off) or when a connection ends
// before the child named itself, the request runs as a spawned CLI (`fallback`) instead.
export const PYTHON_SERVER_MODULES = Object.freeze(["ai_clipper.edit_v2.preview_server"]);
export const DEFAULT_READY_TIMEOUT_MS = 15_000;
export const DEFAULT_RESTART_DELAY_MS = 5_000;
const MAX_READY_BYTES = 4096;
const MAX_PID_LINE_BYTES = 256;
const EXIT_LINE = /^\d{1,3}$/;

function signalProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) return;
  try { process.kill(-pid, signal); } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

export function createPythonServer(module, options = {}) {
  const {
    cliModule, env = process.env, pythonBin = process.env.PYTHON_BIN || "python", spawnImpl = spawn,
    fallback = runPythonCli, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    restartDelayMs = DEFAULT_RESTART_DELAY_MS, tmpdir = os.tmpdir(), now = Date.now,
  } = options;
  if (!PYTHON_SERVER_MODULES.includes(module) || !PYTHON_CLI_MODULES.includes(cliModule)) {
    throw new PythonCliError("invalid_request");
  }
  let state = "idle"; // idle | starting | ready | down | closed
  let server = null;
  let directory = null;
  let failedAt = -Infinity;
  let starting = null;

  function stop() {
    const current = server;
    server = null;
    if (current?.pid) {
      signalProcessGroup(current.pid, "SIGTERM");
      setTimeout(() => signalProcessGroup(current.pid, "SIGKILL"), 2_000).unref?.();
    }
    try { current?.stdin?.destroy(); } catch { /* closed */ }
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = null;
  }

  function down() {
    if (state === "closed") return;
    state = "down";
    failedAt = now();
    stop();
  }

  /** Start the server (once, or again after the back-off); resolves true when it is ready. */
  function start() {
    if (state === "ready") return Promise.resolve(true);
    if (state === "starting") return starting;
    if (state === "closed" || now() - failedAt < restartDelayMs) return Promise.resolve(false);
    state = "starting";
    starting = new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok && state === "starting") state = "ready";
        else if (state !== "closed") down();
        // Held while starting (a caller may await start()); afterwards the app never waits for
        // its worker, which exits when its stdin closes.
        if (child) {
          child.unref();
          for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.();
        }
        resolve(ok && state === "ready");
      };
      let child = null;
      try {
        directory = mkdtempSync(path.join(tmpdir, "potongin-preview-"));
        child = spawnImpl(/* turbopackIgnore: true */ pythonBin, ["-m", module], {
          env: childEnv(env), stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false,
          windowsHide: true,
        });
      } catch {
        done(false);
        return;
      }
      server = child;
      let ready = "";
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        ready += chunk.toString("utf8");
        const at = ready.indexOf("\n");
        if (at < 0) {
          if (ready.length > MAX_READY_BYTES) done(false);
          return;
        }
        let line = null;
        try { line = JSON.parse(ready.slice(0, at)); } catch { /* not a ready line */ }
        done(line?.ready === true && line.pid === child.pid);
      });
      child.stderr.on("data", () => {}); // drained, never returned (no path or text leaks)
      child.stdin.on("error", () => {});
      child.on("error", () => { if (server === child) done(false); });
      child.on("exit", () => {
        if (server !== child) return;
        if (settled) down();
        else done(false);
      });
      timer = setTimeout(() => done(false), readyTimeoutMs);
      child.stdin.write(`${JSON.stringify({ op: "serve", dir: directory })}\n`);
    });
    return starting;
  }

  function request(stdin, { timeout, stdoutLimit, signal, killGraceMs }) {
    return new Promise((resolve) => {
      const conn = net.createConnection(path.join(directory, "preview.sock"));
      let pid = null;
      let head = Buffer.alloc(0);
      const chunks = [];
      let bytes = 0;
      let failure = null;
      let settled = false;
      let killTimer = null;
      let refused = false;
      let timer = null;
      const onAbort = () => fail("aborted");
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (killTimer) {
          clearTimeout(killTimer);
          signalProcessGroup(pid, "SIGKILL"); // whatever of the group outlived its leader
        }
        conn.destroy();
        resolve(outcome);
      };
      function fail(code) {
        if (failure || settled) return;
        failure = code;
        if (pid === null) {
          settle({ error: new PythonCliError(code) });
          return;
        }
        signalProcessGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => settle({ error: new PythonCliError(failure) }), Math.max(0, killGraceMs));
      }
      timer = setTimeout(() => fail("timeout"), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      const keep = (chunk) => {
        bytes += chunk.length;
        if (bytes > stdoutLimit + 16) fail("output_too_large");
        else chunks.push(chunk);
      };
      conn.on("connect", () => conn.end(stdin));
      conn.on("data", (chunk) => {
        if (failure) return;
        if (pid !== null) {
          keep(chunk);
          return;
        }
        head = Buffer.concat([head, chunk]);
        const at = head.indexOf(0x0a);
        if (at < 0) {
          if (head.length > MAX_PID_LINE_BYTES) fail("invalid_output");
          return;
        }
        let line = null;
        try { line = JSON.parse(head.subarray(0, at).toString("utf8")); } catch { /* checked below */ }
        if (!Number.isSafeInteger(line?.pid) || line.pid < 2 || line.pid === process.pid) {
          fail("invalid_output");
          return;
        }
        pid = line.pid;
        if (head.length > at + 1) keep(head.subarray(at + 1));
      });
      conn.on("error", (error) => {
        refused = pid === null && ["ENOENT", "ECONNREFUSED"].includes(error?.code);
      });
      conn.on("close", () => {
        if (settled) return;
        if (failure) {
          settle({ error: new PythonCliError(failure) });
          return;
        }
        if (pid === null) {
          settle({ retry: true, refused }); // no child named itself: nothing ran the envelope
          return;
        }
        const output = Buffer.concat(chunks);
        const at = output.indexOf(0x0a);
        const codeText = at < 0 ? "" : output.subarray(0, at).toString("ascii");
        if (!EXIT_LINE.test(codeText)) {
          settle({ error: new PythonCliError("invalid_output") });
          return;
        }
        if (!(Number(codeText) in EXIT_CODES)) {
          settle({ error: new PythonCliError("backend_failed") });
          return;
        }
        let json;
        try {
          json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.subarray(at + 1)));
        } catch {
          settle({ error: new PythonCliError("invalid_output") });
          return;
        }
        if (json === null || typeof json !== "object" || Array.isArray(json)) {
          settle({ error: new PythonCliError("invalid_output") });
          return;
        }
        settle({ value: { exitCode: Number(codeText), json } });
      });
    });
  }

  async function run(op, payload, runOptions = {}) {
    const { timeoutMs, maxStdoutBytes, maxStdinBytes, signal, killGraceMs = DEFAULT_KILL_GRACE_MS } = runOptions;
    if (typeof op !== "string" || !OP.test(op)) throw new PythonCliError("invalid_request");
    const timeout = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const stdoutLimit = positiveInteger(maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
    const stdin = envelopeBytes(op, payload, positiveInteger(maxStdinBytes, DEFAULT_MAX_STDIN_BYTES));
    if (signal?.aborted) throw new PythonCliError("aborted");
    if (state !== "ready") {
      start();
      return fallback(cliModule, op, payload, runOptions);
    }
    const outcome = await request(stdin, { timeout, stdoutLimit, signal, killGraceMs });
    if (outcome.retry) {
      if (outcome.refused) down();
      return fallback(cliModule, op, payload, runOptions);
    }
    if (outcome.error) throw outcome.error;
    return outcome.value;
  }

  return {
    run,
    start,
    state: () => state,
    pid: () => server?.pid ?? null,
    async close() {
      state = "closed";
      stop();
    },
  };
}
