// Every API route is guarded (rombak 02 §13.1, 07 §9.3), initial form (Fase 1): a route either
// runs behind web/proxy.js, which checks the session, or it is on ALLOWLIST with the reason it
// may skip the proxy and the checks it then makes itself. A route that slips out of the proxy
// without an entry, an entry without a reason, or an entry for a route that no longer skips the
// proxy fails. MU-M3 (Fase 5) tightens this to secureRoute with explicit owner/role per method.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";

import { config } from "../proxy.js";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const API = path.join(WEB, "app", "api");
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// Routes that run without the proxy. `checks` are the guards the route file itself calls.
const ALLOWLIST = Object.freeze({
  health: { reason: "liveness probe for compose and the deploy script; answers no data", checks: [] },
  "auth/login": { reason: "the login form posts here before a session exists; origin checked and attempts rate limited", checks: ["sameOriginMutation", "AuthRateLimiter"] },
  locale: { reason: "cookie preferensi bahasa; tanpa data pengguna; sejak multi-user memeriksa sesi sendiri (07 §9.3)", checks: ["sameOriginMutation", "TokenBucketLimiter"] },
  jobs: { reason: "video uploads are streamed: behind the proxy Next buffers the body at 10 MB", checks: ["requireAuth", "sameOriginMutation"] },
  "jobs/[id]/assets": { reason: "logo and music uploads up to 50 MB are streamed, not buffered by the proxy; wrapped in secureRoute", checks: ["secureRoute"] },
  "settings/logo": { reason: "the default logo upload (10 MB) is streamed; every method is wrapped in secureRoute", checks: ["secureRoute"] },
  "settings/youtube-cookies": { reason: "cookies.txt is read with its own 1 MB cap; every method is wrapped in secureRoute", checks: ["secureRoute"] },
  "ingest/trends": { reason: "the owner's agent has no session cookie: a ptk_ bearer token is checked on every request", checks: ["createIngestTrendsRoute"] },
});

// Compile the matcher with Next's own code, as proxy-matcher.test.mjs does.
const matchers = JSON.parse(execFileSync(process.execPath, ["-e", `
  const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
  process.stdout.write(JSON.stringify(getMiddlewareMatchers(JSON.parse(process.argv[1]), { i18n: null, basePath: "" })));
`, JSON.stringify(config.matcher)], { cwd: WEB, encoding: "utf8" }));

const proxyRuns = (pathname) => matchers.some((matcher) => new RegExp(matcher.regexp).test(pathname));

async function routeFiles(dir = API) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await routeFiles(full));
    else if (entry.name === "route.js") out.push(full);
  }
  return out.sort();
}

// "jobs/[id]/files/[...path]" -> "/api/jobs/x1/files/x2/x3": a concrete URL the route answers.
function samplePath(route) {
  let n = 0;
  const segments = route.split("/").map((segment) => {
    if (/^\[\.\.\..+\]$/.test(segment)) return `x${++n}/x${++n}`;
    if (/^\[.+\]$/.test(segment)) return `x${++n}`;
    return segment;
  });
  return `/api/${segments.join("/")}`;
}

function exportedMethods(source) {
  const ast = parse(source, { sourceType: "module", plugins: ["jsx"] });
  const names = [];
  for (const node of ast.program.body) {
    if (node.type !== "ExportNamedDeclaration" || !node.declaration) continue;
    const declaration = node.declaration;
    if (declaration.type === "FunctionDeclaration") names.push(declaration.id.name);
    if (declaration.type === "VariableDeclaration") for (const item of declaration.declarations) names.push(item.id.name);
  }
  return { ast, methods: names.filter((name) => HTTP_METHODS.has(name)) };
}

function calledNames(ast) {
  const names = new Set();
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      if (node.callee.type === "Identifier") names.add(node.callee.name);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(ast.program);
  return names;
}

const routes = async () => Promise.all((await routeFiles()).map(async (file) => {
  const route = path.relative(API, path.dirname(file)).split(path.sep).join("/");
  const source = await readFile(file, "utf8");
  return { route, file, source, url: samplePath(route), ...exportedMethods(source) };
}));

test("the sample paths are real route URLs", () => {
  assert.equal(samplePath("jobs/[id]/files/[...path]"), "/api/jobs/x1/files/x2/x3");
  assert.equal(samplePath("locale"), "/api/locale");
  assert.equal(proxyRuns("/api/locale"), false);
  assert.equal(proxyRuns("/api/jobs/x1/clips"), true);
});

test("every API route runs behind the proxy or is allowlisted with its reason and its own checks", async () => {
  const all = await routes();
  assert.ok(all.length >= 45, "the scan reaches the routes");
  const missing = [];
  for (const { route, url, methods, ast } of all) {
    assert.ok(methods.length > 0, `${route} exports no HTTP method`);
    if (proxyRuns(url)) continue;
    const entry = ALLOWLIST[route];
    if (!entry) {
      missing.push(`${route} (${url}) skips the proxy without an ALLOWLIST entry`);
      continue;
    }
    const called = calledNames(ast);
    for (const check of entry.checks) assert.ok(called.has(check), `${route} must call ${check} itself`);
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("every ALLOWLIST entry has a reason and names a route that really skips the proxy", async () => {
  const byRoute = new Map((await routes()).map((item) => [item.route, item]));
  for (const [route, entry] of Object.entries(ALLOWLIST)) {
    assert.ok(typeof entry.reason === "string" && entry.reason.trim().length >= 20, `${route}: a reason`);
    assert.ok(Array.isArray(entry.checks), route);
    const item = byRoute.get(route);
    assert.ok(item, `${route}: no such route (remove the entry)`);
    assert.equal(proxyRuns(item.url), false, `${route} runs behind the proxy: the entry is not needed`);
  }
});

test("/api/locale answers POST only; every other method it exports is the 405 handler", async () => {
  const item = (await routes()).find((entry) => entry.route === "locale");
  assert.deepEqual([...item.methods].sort(), ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.match(item.source, new RegExp(`export const ${method} = methodNotAllowed;`), method);
  }
});
