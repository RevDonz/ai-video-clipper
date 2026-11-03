// The session guards stay synchronous (rombak 01 §2.3, 02 §4.4): secureRoute calls authorize(request)
// without await, so an async guard would be a Promise, which is truthy, which is a refusal, or
// worse. Parsed with @babel/parser, and called with a fake request.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "@babel/parser";

import * as auth from "../lib/auth.mjs";
import { identityFixture, sessionCookieFor } from "./support/session.mjs";
import { findUserByUsername } from "../lib/users.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const GUARDS = ["currentUser", "requireAuth", "requireUser", "sessionFromCookieStore", "isAuthorized"];
const SYNC_MODULES = ["lib/db/index.mjs", "lib/sessions.mjs", "lib/users.mjs", "lib/audit.mjs", "lib/instance-settings.mjs"];

function ast(file) {
  return parse(readFileSync(path.join(WEB, file), "utf8"), { sourceType: "module", plugins: ["jsx"] });
}

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value.type === "string") walk(value, visit);
  }
}

function sources() {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(path.join(WEB, dir), { withFileTypes: true })) {
      if (["node_modules", ".next", "__dev__"].includes(entry.name)) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(relative);
      else if (/\.(?:mjs|js|jsx)$/.test(entry.name)) files.push(relative);
    }
  };
  for (const dir of ["lib", "app", "components", "scripts"]) visit(dir);
  return [...files, "proxy.js"];
}

const isAwaitOf = (node, names) => node.type === "AwaitExpression" && node.argument?.type === "CallExpression"
  && node.argument.callee?.type === "Identifier" && names.includes(node.argument.callee.name);

test("no guard in lib/auth.mjs is declared async", () => {
  const found = new Map();
  walk(ast("lib/auth.mjs"), (node) => {
    if (node.type === "FunctionDeclaration" && GUARDS.includes(node.id?.name)) found.set(node.id.name, node.async);
  });
  for (const name of GUARDS) assert.equal(found.get(name), false, `${name} is a sync function declaration`);
});

test("the DB layer the guards read has no async function at all", () => {
  for (const file of SYNC_MODULES) {
    walk(ast(file), (node) => {
      if (/Function/.test(node.type) && node.async) assert.fail(`${file} has an async function at line ${node.loc?.start.line}`);
    });
  }
});

test("nobody awaits a guard, and no authorize( is awaited", () => {
  for (const file of sources()) {
    walk(ast(file), (node) => {
      if (isAwaitOf(node, [...GUARDS, "authorize"])) assert.fail(`${file}:${node.loc?.start.line} awaits a guard`);
      if (node.type === "AwaitExpression" && node.argument?.type === "CallExpression" && node.argument.callee?.type === "MemberExpression"
          && node.argument.callee.property?.name === "authorize") assert.fail(`${file}:${node.loc?.start.line} awaits deps.authorize`);
    });
  }
});

test("secureRoute still calls authorize without await", () => {
  const text = readFileSync(path.join(WEB, "lib/security-headers.mjs"), "utf8");
  assert.match(text, /const denied = authorize\(request\);/);
});

test("a guard returns a value, not a Promise, for a fake request: without a DB", () => {
  const request = new Request("http://local/api/jobs", { headers: { cookie: "potongin_session=x.y" } });
  for (const name of ["currentUser", "isAuthorized", "requireAuth"]) {
    const value = auth[name](request);
    assert.equal(typeof value?.then, "undefined", name);
  }
  assert.throws(() => auth.requireUser(request), auth.AuthError);
  assert.equal(typeof auth.sessionFromCookieStore({ get: () => undefined })?.then, "undefined");
});

test("a guard returns a value, not a Promise: with a DB and a live session", async (t) => {
  await identityFixture(t);
  const { cookie } = sessionCookieFor(findUserByUsername("owner"));
  const request = new Request("http://local/api/jobs", { headers: { cookie } });
  const principal = auth.currentUser(request);
  assert.equal(typeof principal.then, "undefined");
  assert.equal(principal.username, "owner");
  assert.equal(auth.currentUser(request), principal, "cached per request object");
  assert.equal(auth.requireAuth(request), null);
  assert.equal(auth.requireUser(request).id, principal.id);
  assert.equal(auth.isAuthorized(request), true);
  const value = auth.sessionFromCookieStore({ get: (name) => (name === auth.S2_COOKIE ? { value: cookie.split("=")[1] } : undefined) });
  assert.equal(value.id, principal.id);
});
