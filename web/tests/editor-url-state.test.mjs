// The one-layout editor's address (rombak 06 §3.6): `?panel=` opens one of the five tabs, and the
// links of the two-view editor (`?mode=`, `?card=`, `?panel=transcript|music`) still land on the
// tab that does the same work, with the old params dropped from the address.
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TAB, LEGACY_VIEW_KEY, TAB_IDS, forgetLegacyView, panelHref, resolveUrlState, urlWithPanel,
} from "../lib/editor/url-state.mjs";

test("five tabs in the panel's order, Teks first", () => {
  assert.deepEqual(TAB_IDS, ["text", "layout", "audio", "logo", "coldopen"]);
  assert.equal(DEFAULT_TAB, "text");
});

test("the §3.6 table: every old param lands on its tab, and the address keeps only ?panel", () => {
  const rows = [
    // [query, panel, transcript view, address after]
    ["", "text", "words", ""],
    ["?mode=cepat", "text", "words", ""],
    ["?mode=lengkap", "text", "words", ""],
    ["?card=hook", "text", "words", "?panel=text"],
    ["?card=caption", "text", "words", "?panel=text"],
    ["?card=lines", "text", "lines", "?panel=text"],
    ["?card=coldopen", "coldopen", "words", "?panel=coldopen"],
    ["?card=layout", "layout", "words", "?panel=layout"],
    ["?card=extras", "logo", "words", "?panel=logo"],
    ["?panel=transcript", "text", "words", "?panel=text"],
    ["?panel=music", "audio", "words", "?panel=audio"],
    ["?panel=text", "text", "words", "?panel=text"],
    ["?panel=layout", "layout", "words", "?panel=layout"],
    ["?panel=audio", "audio", "words", "?panel=audio"],
    ["?panel=logo", "logo", "words", "?panel=logo"],
    ["?panel=coldopen", "coldopen", "words", "?panel=coldopen"],
    ["?mode=lengkap&panel=music", "audio", "words", "?panel=audio"],
    ["?mode=cepat&card=extras", "logo", "words", "?panel=logo"],
  ];
  for (const [query, panel, transcript, search] of rows) {
    const state = resolveUrlState(query);
    assert.deepEqual({ panel: state.panel, transcript: state.transcript, search: state.search }, { panel, transcript, search }, query);
    assert.equal(state.changed, search !== query, `${query}: changed`);
  }
});

test("unknown values fall back to Teks and leave the address; other params and their order stay", () => {
  for (const query of ["?panel=nope", "?card=nope", "?panel=", "?mode=x", "?panel=Text"]) {
    const state = resolveUrlState(query);
    assert.equal(state.panel, "text", query);
    assert.equal(state.search, "", query);
    assert.equal(state.changed, true, query);
  }
  const kept = resolveUrlState("?debug=1&mode=lengkap&panel=logo&x=a%20b");
  assert.equal(kept.panel, "logo");
  assert.equal(kept.search, "?debug=1&panel=logo&x=a+b");
});

test("?panel wins over ?card when both name a tab; a URLSearchParams works as well as a string", () => {
  assert.equal(resolveUrlState("?card=layout&panel=audio").panel, "audio");
  assert.equal(resolveUrlState("?card=layout&panel=bogus").panel, "layout");
  assert.equal(resolveUrlState(new URLSearchParams("panel=coldopen")).panel, "coldopen");
  for (const bad of [undefined, null, 42, {}]) assert.equal(resolveUrlState(bad).panel, "text");
});

test("a fallback panel (the logo harness's initialPanel) counts only when the address names none", () => {
  assert.equal(resolveUrlState("", { fallback: "logo" }).panel, "logo");
  assert.equal(resolveUrlState("", { fallback: "music" }).panel, "audio");
  assert.equal(resolveUrlState("", { fallback: "transcript" }).panel, "text");
  assert.equal(resolveUrlState("?panel=layout", { fallback: "logo" }).panel, "layout");
  assert.equal(resolveUrlState("", { fallback: "nope" }).panel, "text");
});

test("urlWithPanel sets ?panel and keeps the path, other params and the hash", () => {
  assert.equal(urlWithPanel("/projects/a/clips/b/edit?panel=text#x", "audio"), "/projects/a/clips/b/edit?panel=audio#x");
  assert.equal(urlWithPanel("https://host.invalid/p/edit?debug=1", "logo"), "/p/edit?debug=1&panel=logo");
  assert.throws(() => urlWithPanel("/p/edit", "music"), /unknown tab/);
});

test("panelHref: a neighbour clip opens on the same tab, with nothing else from this address", () => {
  assert.equal(panelHref("/projects/j/clips/c/edit?mode=lengkap&card=hook", "layout"), "/projects/j/clips/c/edit?panel=layout");
  assert.equal(panelHref("/projects/j/clips/klip-3/edit", "text"), "/projects/j/clips/klip-3/edit?panel=text");
  assert.equal(panelHref("/projects/j/clips/c/edit", "bogus"), "/projects/j/clips/c/edit");
});

test("the two-view editor's stored view is removed on the first read, and blocked storage never throws", () => {
  assert.equal(LEGACY_VIEW_KEY, "potongin-editor-view");
  const store = new Map([[LEGACY_VIEW_KEY, "lengkap"], ["other", "1"]]);
  const storage = { removeItem: (key) => store.delete(key), getItem: (key) => store.get(key) ?? null };
  assert.equal(forgetLegacyView(storage), true);
  assert.equal(store.has(LEGACY_VIEW_KEY), false);
  assert.equal(store.get("other"), "1");
  assert.equal(forgetLegacyView(storage), true, "removing a missing key is fine");
  assert.equal(forgetLegacyView({ removeItem() { throw new Error("SecurityError"); } }), false);
  assert.equal(forgetLegacyView(null), false);
});
