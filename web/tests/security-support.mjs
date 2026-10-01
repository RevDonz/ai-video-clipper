// Shared fixtures of the security tests (plan §9.1, §10.2 QG-SEC; T4.2): a session, the table of
// every editor route under /api/jobs/:id/clips/** and /api/jobs/:id/assets/**, a stand-in Python
// that records its argv, envelope and /proc/self/environ, and an environment helper.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createSessionToken } from "../lib/auth.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.resolve(HERE, "..");
export const REPO = path.resolve(WEB, "..");

export const AUTH = Object.freeze({
  APP_USERNAME: "owner",
  APP_PASSWORD: "planted-app-password-6b1f",
  APP_SESSION_SECRET: "planted-session-secret-".padEnd(48, "q"),
});
// Planted values: no child but the AI task may hold an LLM one, and no child may hold the rest.
export const DASHBOARD_SECRETS = Object.freeze({
  APP_PASSWORD: AUTH.APP_PASSWORD,
  APP_SESSION_SECRET: AUTH.APP_SESSION_SECRET,
  POTONGIN_SETTINGS_SECRET: "planted-settings-secret-77c2",
});
export const LLM_SECRETS = Object.freeze({
  OPENROUTER_API_KEY: "planted-openrouter-key-91aa",
  POTONGIN_LLM_CUSTOM_API_KEY: "planted-custom-key-4d0e",
});
export const STORAGE_ENV = Object.freeze({
  JOBS_STORAGE_QUOTA_BYTES: "32212254720",
  JOBS_STORAGE_MIN_FREE_BYTES: "0",
  JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "1048576",
  JOBS_STORAGE_SCAN_MAX_ENTRIES: "20000",
  JOBS_STORAGE_SCAN_MAX_DEPTH: "16",
});

export const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
export const CLIP = "clip_0123456789abcdef01234567";
export const TASK = "3d6f0a1e-2b7c-4d8e-9f01-23456789abcd";
export const RENDER = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const SHA = "ab".repeat(32);
export const PLATE16 = "0f1e2d3c4b5a6978"; // a plate cell name prefix

// Each token is signed for a different issue second, so each has its own rate-limit buckets.
const ISSUED = Math.floor(Date.now() / 1000);
let tokens = 0;
export function newSession() {
  tokens += 1;
  return createSessionToken(AUTH, ISSUED - tokens);
}

/** The process environment for a block of the test; restored afterwards. */
export async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// The route table. `params` are the dynamic segments; `mutation` routes check the origin; `limit`
// names the rate-limit bucket that guards the route (null: none); `body` makes a valid body.
const DOC = { schema: "clip-edit-v2", clip_id: CLIP };
const json = (value) => JSON.stringify(value);
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

export const ROUTES = Object.freeze([
  { name: "GET clips", file: "clips/route.js", method: "GET", params: { id: JOB }, limit: "api" },
  { name: "POST clips", file: "clips/route.js", method: "POST", params: { id: JOB }, mutation: true, limit: "api",
    body: () => ({ text: "{}", type: "application/json" }), cap: 1024 },
  { name: "GET edit", file: "clips/[clipId]/edit/route.js", method: "GET", params: { id: JOB, clipId: CLIP }, limit: "api" },
  { name: "PUT edit", file: "clips/[clipId]/edit/route.js", method: "PUT", params: { id: JOB, clipId: CLIP }, mutation: true,
    limit: "api", cap: 1 << 20,
    body: () => ({ text: json(DOC), type: "application/json",
      headers: { "If-Match": `"${SHA}"`, "Idempotency-Key": "00000000-0000-4000-8000-000000000001" } }) },
  { name: "GET words", file: "clips/[clipId]/words/route.js", method: "GET", params: { id: JOB, clipId: CLIP }, limit: "api" },
  { name: "POST prepare", file: "clips/[clipId]/prepare/route.js", method: "POST", params: { id: JOB, clipId: CLIP },
    mutation: true, limit: "api", cap: 1024, body: () => ({ text: json({ layout: "fit_blur" }), type: "application/json" }) },
  { name: "POST preview/plan", file: "clips/[clipId]/preview/plan/route.js", method: "POST", params: { id: JOB, clipId: CLIP },
    mutation: true, limit: "plan", cap: (1 << 20) + 4096, body: () => ({ text: json({ doc: DOC }), type: "application/json" }) },
  { name: "POST preview/frame", file: "clips/[clipId]/preview/frame/route.js", method: "POST", params: { id: JOB, clipId: CLIP },
    mutation: true, limit: "frame", cap: (1 << 20) + 4096, body: () => ({ text: json({ doc: DOC, f: 0 }), type: "application/json" }) },
  { name: "GET media", file: "clips/[clipId]/media/[kind]/[name]/route.js", method: "GET",
    params: { id: JOB, clipId: CLIP, kind: "plates", name: `${PLATE16}-c0000000.mp4` }, limit: null },
  { name: "HEAD media", file: "clips/[clipId]/media/[kind]/[name]/route.js", method: "HEAD",
    params: { id: JOB, clipId: CLIP, kind: "plates", name: `${PLATE16}-c0000000.mp4` }, limit: null },
  { name: "GET renders", file: "clips/[clipId]/renders/route.js", method: "GET", params: { id: JOB, clipId: CLIP }, limit: "api" },
  { name: "POST renders", file: "clips/[clipId]/renders/route.js", method: "POST", params: { id: JOB, clipId: CLIP },
    mutation: true, limit: "api", cap: 1024,
    body: () => ({ text: json({ editEtag: SHA }), type: "application/json",
      headers: { "Idempotency-Key": "00000000-0000-4000-8000-000000000002" } }) },
  { name: "POST ai", file: "clips/[clipId]/ai/route.js", method: "POST", params: { id: JOB, clipId: CLIP }, mutation: true,
    limit: "api", cap: (1 << 20) + 4096, body: () => ({ text: json({ task: "hooks", doc: DOC }), type: "application/json" }) },
  { name: "GET ai task", file: "clips/[clipId]/ai/[taskId]/route.js", method: "GET",
    params: { id: JOB, clipId: CLIP, taskId: TASK }, limit: "api" },
  { name: "GET cleanup", file: "clips/[clipId]/cleanup/route.js", method: "GET", params: { id: JOB, clipId: CLIP }, limit: "api" },
  { name: "GET coldopen", file: "clips/[clipId]/coldopen-suggestions/route.js", method: "GET",
    params: { id: JOB, clipId: CLIP }, limit: "api" },
  { name: "POST assets", file: "assets/route.js", method: "POST", params: { id: JOB }, mutation: true, limit: "upload",
    cap: 10 * 1024 * 1024,
    body: () => ({ bytes: PNG, type: "image/png",
      headers: { "X-Asset-Kind": "logo", "Idempotency-Key": "00000000-0000-4000-8000-000000000003" } }) },
  { name: "GET asset", file: "assets/[sha]/route.js", method: "GET", params: { id: JOB, sha: SHA }, limit: null },
  { name: "HEAD asset", file: "assets/[sha]/route.js", method: "HEAD", params: { id: JOB, sha: SHA }, limit: null },
]);

/** Every route file under the two trees, relative to app/api/jobs/[id]/ (the table must list each). */
export async function routeFiles() {
  const base = path.join(WEB, "app", "api", "jobs", "[id]");
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.js") found.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  for (const tree of ["clips", "assets"]) await walk(path.join(base, tree));
  return found.sort();
}

export async function loadRoute(route) {
  const module = await import(path.join(WEB, "app", "api", "jobs", "[id]", ...route.file.split("/")));
  const handler = module[route.method];
  if (typeof handler !== "function") throw new Error(`${route.file} has no ${route.method}`);
  return handler;
}

/** The URL path of a route with its parameters filled in (raw, not encoded). */
export function routePath(route, params = route.params) {
  const parts = route.file.replace(/\/?route\.js$/, "").split("/").filter(Boolean)
    .map((part) => (part.startsWith("[") ? params[part.slice(1, -1)] : part));
  return `/api/jobs/${params.id}/${parts.join("/")}`;
}

/**
 * A request to `route`: a signed session unless `session: false` (or a string token), a
 * same-origin browser's headers for mutations unless `origin`/`site` say otherwise, and the
 * route's valid body unless `body` is given (`{text|bytes, type, headers}`).
 */
export function routeRequest(route, { session = true, origin, site, params = route.params, body, headers = {}, url } = {}) {
  const all = { Host: "local", ...headers };
  const token = typeof session === "string" ? session : session ? newSession() : null;
  if (token) all.Cookie = `potongin_session=${token}`;
  const sameOrigin = route.mutation;
  const originValue = origin === undefined ? (sameOrigin ? "http://local" : undefined) : origin;
  if (originValue !== null && originValue !== undefined) all.Origin = originValue;
  const siteValue = site === undefined ? (sameOrigin ? "same-origin" : undefined) : site;
  if (siteValue !== null && siteValue !== undefined) all["Sec-Fetch-Site"] = siteValue;
  const init = { method: route.method, headers: all };
  const payload = body === undefined ? route.body?.() : body;
  if (payload && !["GET", "HEAD"].includes(route.method)) {
    const bytes = payload.bytes ?? Buffer.from(payload.text ?? "", "utf8");
    Object.assign(all, { "Content-Type": payload.type, "Content-Length": String(bytes.length), ...payload.headers });
    if (payload.length !== undefined) all["Content-Length"] = String(payload.length);
    if (payload.length === null) delete all["Content-Length"];
    init.body = bytes;
    init.duplex = "half";
  }
  return { request: new Request(url ?? `http://local${routePath(route, params)}`, init), token };
}

export const context = (params) => ({ params: Promise.resolve(params) });

export async function read(response) {
  const text = response.status === 304 || response.body === null ? "" : await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

// A stand-in `python`: records {argv, module, op, envelope, environ} under records/, then answers
// from answers.json by "<module> <op>", "<module>" or "*" (default: exit 4, not_found).
const FAKE_PYTHON = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const here = path.dirname(process.argv[1]);
let input = "";
try { input = readFileSync(0, "utf8"); } catch { /* no stdin */ }
let envelope = null;
try { envelope = JSON.parse(input); } catch { /* not JSON */ }
const environ = {};
for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
  if (!entry) continue;
  const at = entry.indexOf("=");
  environ[entry.slice(0, at)] = entry.slice(at + 1);
}
const module = process.argv[3] ?? null;
const op = envelope && typeof envelope.op === "string" ? envelope.op : null;
writeFileSync(path.join(here, "records", process.pid + "-" + process.hrtime.bigint() + ".json"),
  JSON.stringify({ argv: process.argv.slice(2), module, op, envelope, environ }));
let answers = {};
try { answers = JSON.parse(readFileSync(path.join(here, "answers.json"), "utf8")); } catch { /* defaults */ }
const answer = answers[module + " " + op] ?? answers[module] ?? answers["*"]
  ?? { exit: 4, json: { error: { code: "not_found", path: null, ref: null } } };
process.stdout.write(JSON.stringify(answer.json));
process.exitCode = answer.exit;
`;

export async function fakePython(t, answers = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-python-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "records"));
  const bin = path.join(dir, "python.mjs");
  await writeFile(bin, `#!${process.execPath}\n${FAKE_PYTHON}`);
  await chmod(bin, 0o755);
  await writeFile(path.join(dir, "answers.json"), JSON.stringify(answers));
  return {
    bin,
    async answer(map) { await writeFile(path.join(dir, "answers.json"), JSON.stringify(map)); },
    async records() {
      const out = [];
      for (const name of (await readdir(path.join(dir, "records"))).sort()) {
        out.push(JSON.parse(await readFile(path.join(dir, "records", name), "utf8")));
      }
      return out;
    },
    async clear() {
      for (const name of await readdir(path.join(dir, "records"))) await rm(path.join(dir, "records", name));
    },
  };
}

/** A jobs root with the job and clip directories (and a canary file outside the root). */
export async function jobsRoot(t) {
  const top = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-jobs-"));
  t.after(() => rm(top, { recursive: true, force: true }));
  const root = path.join(top, "jobs");
  const clip = path.join(root, JOB, "analysis", "clips", CLIP);
  for (const dir of ["preview/plates", "preview/audio", "preview/ass", "preview/derived", "preview/frames", "edit", "suggestions"]) {
    await mkdir(path.join(clip, dir), { recursive: true, mode: 0o700 });
  }
  await mkdir(path.join(root, JOB, "analysis", "render-requests"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, JOB, "input"), { recursive: true, mode: 0o700 });
  const canary = "canary-outside-the-jobs-root-5e0b";
  await writeFile(path.join(top, "secret.txt"), canary);
  return { top, root, clip, canary };
}
