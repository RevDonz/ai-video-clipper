// Message descriptors (lib/i18n/descriptor.mjs): what view modules return instead of text, and
// how the key scanners of i18n-usage and i18n-catalog see their keys.
import assert from "node:assert/strict";
import test from "node:test";

import { d, msg } from "../lib/i18n/descriptor.mjs";
import { parseSource, translatorCalls } from "./support/i18n-scan.mjs";

test("a descriptor carries a key and values only when there are some", () => {
  assert.deepEqual(d("projects.title"), { key: "projects.title" });
  assert.deepEqual(d("projects.title", {}), { key: "projects.title" });
  assert.deepEqual(d("projects.found", { count: 2 }), { key: "projects.found", values: { count: 2 } });
});

test("msg translates a descriptor, its nested descriptors first, and passes plain text through", () => {
  const calls = [];
  const t = (key, values) => {
    calls.push([key, values]);
    return values ? `${key}(${Object.values(values).join(",")})` : key;
  };
  assert.equal(msg(t, d("a.b")), "a.b");
  assert.equal(msg(t, d("a.c", { status: d("s.x"), n: 3 })), "a.c(s.x,3)");
  assert.equal(msg(t, "Podcast 12.mp4"), "Podcast 12.mp4");
  assert.equal(msg(t, null), "");
  assert.equal(msg(t, undefined), "");
  assert.equal(msg(t, { nope: 1 }), "");
});

test("msg shows an API error through its messageId, else the server's own words", () => {
  const known = new Set(["errors.web.unauthorized"]);
  const t = Object.assign((key, values) => `${key}${values && Object.keys(values).length ? JSON.stringify(values) : ""}`, { has: (key) => known.has(key) });
  assert.equal(msg(t, { error: { messageId: "web.unauthorized", code: "unauthorized", legacyText: "Sesi login diperlukan" } }), "errors.web.unauthorized");
  assert.equal(msg(t, { error: { messageId: "web.nope", code: "nope", legacyText: "Teks server" } }), "Teks server");
  assert.equal(msg(t, { error: { messageId: "web.nope" } }), "errors.web.unknown");
});

test("the key scanners see d(\"key\") calls of the descriptor module as full keys", () => {
  const { calls } = translatorCalls(parseSource(`
    import { d } from "./i18n/descriptor.mjs";
    import { d as describe } from "../lib/i18n/descriptor.mjs";
    const a = d("projects.title");
    const b = describe("trends.title", { n: 1 });
    const c = d(name);
    function other(d2) { return d2("not.seen"); }
  `));
  assert.deepEqual(calls.map(({ key, dynamic }) => [key, dynamic]), [
    ["projects.title", false],
    ["trends.title", false],
    [null, true],
  ]);
});
