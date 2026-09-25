// The one way editor routes spawn Python (plan §4.2, §9.1, E11; Appendix A.2).
//
// - No shell: `spawn(python, ["-m", <module>])` with the module from a fixed list.
// - stdin is one JSON envelope `{"op": <op>, ...payload}`, bounded; stdout is one JSON object,
//   bounded; stderr is drained (bounded) and never returned, so no path or text leaks.
// - The child gets an allowlisted environment: `CHILD_ENV_ALLOWLIST`, never APP_*,
//   POTONGIN_SETTINGS_*, POTONGIN_LLM* or *_API_KEY. Only the AI task (`withLlmEnv`) adds the
//   LLM variables of `engineProcessEnv(await loadLlmEnv())`, as run-job.mjs does for the engine.
// - The child leads its own process group; a timeout or an abort kills the whole group
//   (FFmpeg included) with SIGKILL.
// - Exit codes are the fixed map of docs/editor/CONTRACTS.md §5.3: a mapped code resolves with
//   `{exitCode, json}`; 1 (unexpected), 2 (usage: our bug) and anything else reject.
import { spawn } from "node:child_process";
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

function killGroup(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Run `python -m <module>` with `{"op": op, ...payload}` on stdin.
 * Resolves `{exitCode, json}` for the mapped exit codes; rejects `PythonCliError` otherwise.
 */
export async function runPythonCli(module, op, payload, options = {}) {
  const {
    timeoutMs, maxStdoutBytes, maxStdinBytes, withLlmEnv = false, signal,
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

    const fail = (code) => {
      if (failure) return;
      failure = code;
      killGroup(child);
    };
    const timer = setTimeout(() => fail("timeout"), timeout);
    const onAbort = () => fail("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
