// Ratchet 0 (rombak 08 Fase 2, i18n M2): no error answer of web/app/api goes out without a code
// and a messageId. Statically: every exported method of every route.js is wrapped in
// withErrorCodes(), every inline error body in a route.js names its code, and no route answers
// a bare text error. At runtime: a request without a session to every method of every route
// answers a success or an error body with a code whose messageId (sent, or "<domain>.<code>"
// for the route's first domain that has it) has a catalog text.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveMessageId } from "../lib/api-error-response.mjs";
import { WEB_ERROR_CODES } from "../lib/error-codes.mjs";
import { loadNamespace } from "../lib/i18n/catalog.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const API = path.join(WEB, "app", "api");
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

async function routeFiles(dir = API) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await routeFiles(full));
    else if (entry.name === "route.js") out.push(full);
  }
  return out.sort();
}

const relative = (file) => path.relative(API, file);

/** Each `{ error: …` object literal of `source`, up to its closing brace (not a query string's). */
function errorLiterals(source) {
  const out = [];
  for (const match of source.matchAll(/\{\s*error\s*:/g)) {
    if (/URLSearchParams\(\s*$/.test(source.slice(Math.max(0, match.index - 40), match.index))) continue;
    let depth = 0;
    for (let i = match.index; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}" && (depth -= 1) === 0) { out.push(source.slice(match.index, i + 1)); break; }
    }
  }
  return out;
}

test("every route lists its methods as withErrorCodes(…) exports", async () => {
  const files = await routeFiles();
  assert.ok(files.length >= 49, `found ${files.length} route files`);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const plain = [...source.matchAll(new RegExp(`^export\\s+(?:async\\s+)?function\\s+(${METHODS.join("|")})\\b`, "gm"))];
    assert.deepEqual(plain.map((m) => m[1]), [], `${relative(file)}: a method exported as a plain function`);
    const exported = [...source.matchAll(new RegExp(`^export\\s+const\\s+(${METHODS.join("|")})\\s*=\\s*(\\S+)`, "gm"))];
    assert.ok(exported.length > 0, `${relative(file)}: no method`);
    // A method may name a constant that is itself withErrorCodes(…) (the 405 handler of /api/locale).
    const wrappedNames = new Set([...source.matchAll(/^const\s+(\w+)\s*=\s*withErrorCodes\(/gm)].map((m) => `${m[1]};`));
    for (const [, name, start] of exported) {
      assert.ok(/^withErrorCodes\(/.test(start) || wrappedNames.has(start), `${relative(file)} ${name}: ${start}`);
    }
  }
});

test("every inline error body of a route names its code, and no route answers bare text", async () => {
  const known = new Set(WEB_ERROR_CODES);
  for (const file of await routeFiles()) {
    const source = await readFile(file, "utf8");
    for (const literal of errorLiterals(source)) {
      assert.match(literal, /\bcode\s*[:,}]/, `${relative(file)}: ${literal.slice(0, 80)}`);
      const named = literal.match(/\bcode\s*:\s*"([a-z0-9_]+)"/);
      if (named && !relative(file).startsWith(`jobs${path.sep}[id]${path.sep}clips`)) assert.ok(known.has(named[1]) || named[1].startsWith("storage_"), `${relative(file)}: ${named[1]} is not a web code`);
    }
    assert.doesNotMatch(source, /new Response\(\s*(?:"|'|`|message\b)/, `${relative(file)}: a text error body`);
  }
});

// Leave the auth configuration unset so every session check refuses; the editor flag off.
async function withoutSession(run) {
  const names = ["APP_USERNAME", "APP_PASSWORD", "APP_SESSION_SECRET", "POTONGIN_EDITOR_V3", "JOBS_ROOT"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.JOBS_ROOT = path.join(WEB, ".no-such-jobs-root");
  try { return await run(); } finally {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
  }
}

const SAMPLE_PARAMS = {
  id: "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", clipId: "clip_0123456789abcdef01234567", taskId: "3d6f0a1e-2b7c-4d8e-9f01-23456789abcd",
  renderId: "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", batchId: "6b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e", sha: "ab".repeat(32),
  kind: "fonts", name: "x.ttf", path: ["output", "clip.mp4"],
};

test("a request without a session to every route method answers with code and messageId", async () => {
  const errors = loadNamespace("id", "errors");
  await withoutSession(async () => {
    for (const file of await routeFiles()) {
      const module = await import(pathToFileURL(file).href);
      for (const method of METHODS.filter((name) => typeof module[name] === "function")) {
        const url = `http://localhost/api/${relative(file).replace(/route\.js$/, "")}`;
        const init = { method, headers: { origin: "http://localhost", host: "localhost" } };
        if (!["GET", "HEAD"].includes(method)) Object.assign(init, { body: "{}", headers: { ...init.headers, "content-type": "application/json" } });
        const response = await module[method](new Request(url, init), { params: Promise.resolve(SAMPLE_PARAMS) });
        const label = `${method} ${relative(file)} ${response.status}`;
        if (response.status < 400 || method === "HEAD") continue;
        const body = await response.json();
        const fields = typeof body.error === "object" && body.error !== null ? body.error : body;
        assert.equal(typeof fields.code, "string", label);
        const messageId = fields.messageId ?? resolveMessageId(fields.code, module[method].errorDomains);
        const [domain, code] = messageId.split(".");
        assert.equal(typeof errors[domain]?.[code.split(":")[0]], "string", `${label}: errors.${messageId}`);
      }
    }
  });
});
