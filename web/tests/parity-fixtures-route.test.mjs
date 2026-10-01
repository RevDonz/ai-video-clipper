import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SESSION_COOKIE, createSessionToken } from "../lib/auth.mjs";
import { GET, HEAD, parityHarnessAllowed } from "../app/api/parity-fixtures/[...path]/route.js";

const SECRET_ENV = {
  APP_USERNAME: "tester",
  APP_PASSWORD: "not-a-real-password",
  APP_SESSION_SECRET: "0123456789abcdef0123456789abcdef-test-only",
};

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(run).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fixtures() {
  const root = mkdtempSync(path.join(tmpdir(), "parity-fixtures-"));
  mkdirSync(path.join(root, "ass"));
  mkdirSync(path.join(root, "bg", "classic-10", "gbrp"), { recursive: true });
  writeFileSync(path.join(root, "manifest.json"), '{"schema":"potongin.parity-text/1"}');
  writeFileSync(path.join(root, "ass", "classic-10.ass"), "[Script Info]\n");
  writeFileSync(path.join(root, "bg", "classic-10", "gbrp", "12.png"), Buffer.from([0x89, 0x50]));
  writeFileSync(path.join(root, "notes.txt"), "not served");
  const outside = mkdtempSync(path.join(tmpdir(), "parity-outside-"));
  writeFileSync(path.join(outside, "secret.json"), "{}");
  symlinkSync(path.join(outside, "secret.json"), path.join(root, "linked.json"));
  return { root, cleanup: () => { rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }); } };
}

function request(pathname, { session = true } = {}) {
  const headers = new Headers();
  if (session) headers.set("cookie", `${SESSION_COOKIE}=${createSessionToken(SECRET_ENV)}`);
  return new Request(`http://127.0.0.1:3999/api/parity-fixtures/${pathname}`, { headers });
}

const context = (pathname) => ({ params: Promise.resolve({ path: pathname.split("/") }) });

test("the fixtures route is a 404 unless the harness flag is on and the user is logged in", async () => {
  const { root, cleanup } = fixtures();
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: undefined }, async () => {
      assert.equal((await GET(request("manifest.json"), context("manifest.json"))).status, 404);
    });
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "0" }, async () => {
      assert.equal((await GET(request("manifest.json"), context("manifest.json"))).status, 404);
    });
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      const anonymous = await GET(request("manifest.json", { session: false }), context("manifest.json"));
      assert.equal(anonymous.status, 404);
      const response = await GET(request("manifest.json"), context("manifest.json"));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { schema: "potongin.parity-text/1" });
      const head = await HEAD(request("manifest.json"), context("manifest.json"));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    });
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: undefined, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      assert.equal((await GET(request("manifest.json"), context("manifest.json"))).status, 404);
    });
  } finally {
    cleanup();
  }
});

test("parityHarnessAllowed needs both the flag and a valid session", async () => {
  const token = createSessionToken(SECRET_ENV);
  assert.equal(parityHarnessAllowed(token, { ...SECRET_ENV, POTONGIN_PARITY_HARNESS: "1" }), true);
  assert.equal(parityHarnessAllowed(token, { ...SECRET_ENV }), false);
  assert.equal(parityHarnessAllowed("forged.token", { ...SECRET_ENV, POTONGIN_PARITY_HARNESS: "1" }), false);
  assert.equal(parityHarnessAllowed(null, { ...SECRET_ENV, POTONGIN_PARITY_HARNESS: "1" }), false);
});

test("only allowlisted fixture files inside the root are served, with their types", async () => {
  const { root, cleanup } = fixtures();
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      const ass = await GET(request("ass/classic-10.ass"), context("ass/classic-10.ass"));
      assert.equal(ass.status, 200);
      assert.equal(ass.headers.get("content-type"), "text/plain; charset=utf-8");
      const png = await GET(request("bg/classic-10/gbrp/12.png"), context("bg/classic-10/gbrp/12.png"));
      assert.equal(png.headers.get("content-type"), "image/png");
      for (const bad of ["notes.txt", "linked.json", "../manifest.json", "ass/../manifest.json",
        ".hidden.json", "ass/missing.ass", "a/b/c/d/e/f/g.json", "jassub/other.js"]) {
        const response = await GET(request(bad), context(bad));
        assert.equal(response.status, 404, bad);
      }
    });
  } finally {
    cleanup();
  }
});

test("the pinned JASSUB worker files are served from the installed package", async () => {
  const { root, cleanup } = fixtures();
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      const glue = await GET(request("jassub/jassub-worker.js"), context("jassub/jassub-worker.js"));
      assert.equal(glue.status, 200);
      assert.equal(glue.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.match(await glue.text(), /em-pthread/);
      const wasm = await GET(request("jassub/jassub-worker.wasm"), context("jassub/jassub-worker.wasm"));
      assert.equal(wasm.status, 200);
      assert.equal(wasm.headers.get("content-type"), "application/wasm");
      const bytes = new Uint8Array(await wasm.arrayBuffer());
      assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x00, 0x61, 0x73, 0x6d]);
    });
  } finally {
    cleanup();
  }
});
