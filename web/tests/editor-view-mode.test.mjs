// The editor's two views (docs/plans/2026-10-02-editor-mode-cepat.md §4): the per-viewer
// preference, the URL params and how they resolve, in web/lib/editor/view-mode.mjs. Pure; the
// storage is a fake passed in, as the app passes window.localStorage.
import assert from "node:assert/strict";
import test from "node:test";

import { PANELS } from "../components/editor/panels/index.mjs";
import { CARDS } from "../components/editor/quick/cards.mjs";
import {
  CARD_IDS,
  PANEL_IDS,
  VIEWS,
  VIEW_KEY,
  readStoredView,
  resolveView,
  urlWithView,
  viewFromUrl,
  writeStoredView,
} from "../lib/editor/view-mode.mjs";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

const throwing = {
  getItem() { throw new DOMException("blocked", "SecurityError"); },
  setItem() { throw new DOMException("quota", "QuotaExceededError"); },
};

test("two views, one storage key", () => {
  assert.deepEqual([...VIEWS], ["cepat", "lengkap"]);
  assert.ok(Object.isFrozen(VIEWS));
  assert.equal(VIEW_KEY, "potongin-editor-view");
});

test("the stored preference reads back only a known view", () => {
  assert.equal(readStoredView(memoryStorage({ [VIEW_KEY]: "lengkap" })), "lengkap");
  assert.equal(readStoredView(memoryStorage({ [VIEW_KEY]: "cepat" })), "cepat");
  for (const value of ["Lengkap", "lama", "", " cepat", "null"]) {
    assert.equal(readStoredView(memoryStorage({ [VIEW_KEY]: value })), null, value);
  }
  assert.equal(readStoredView(memoryStorage()), null);
  assert.equal(readStoredView(null), null);
  assert.equal(readStoredView(undefined), null);
});

test("storage that throws on get or on set never throws out of the module", () => {
  assert.equal(readStoredView(throwing), null);
  assert.equal(writeStoredView(throwing, "lengkap"), false);
  assert.equal(writeStoredView(null, "lengkap"), false);
  // A getter that throws, as `window.localStorage` does with blocked site data.
  const hostile = Object.defineProperty({}, "getItem", { get() { throw new Error("no access"); } });
  assert.equal(readStoredView(hostile), null);
});

test("writing stores a known view and refuses anything else", () => {
  const storage = memoryStorage();
  assert.equal(writeStoredView(storage, "lengkap"), true);
  assert.equal(storage.data.get(VIEW_KEY), "lengkap");
  assert.equal(writeStoredView(storage, "cepat"), true);
  assert.equal(storage.data.get(VIEW_KEY), "cepat");
  for (const value of ["", "lama", null, undefined, 1]) {
    assert.equal(writeStoredView(storage, value), false, String(value));
  }
  assert.equal(storage.data.get(VIEW_KEY), "cepat");
});

test("the URL names a view, a Lengkap panel or a Cepat card; unknown values are null", () => {
  assert.deepEqual(viewFromUrl(""), { view: null, panel: null, card: null });
  assert.deepEqual(viewFromUrl("?mode=lengkap"), { view: "lengkap", panel: null, card: null });
  assert.deepEqual(viewFromUrl("mode=cepat"), { view: "cepat", panel: null, card: null });
  assert.deepEqual(viewFromUrl("?panel=transcript"), { view: null, panel: "transcript", card: null });
  assert.deepEqual(viewFromUrl("?card=lines"), { view: null, panel: null, card: "lines" });
  assert.deepEqual(viewFromUrl("?mode=LENGKAP&panel=Teks&card=caption-lines"), { view: null, panel: null, card: null });
  assert.deepEqual(viewFromUrl("?mode=lama&panel=timeline&card=export"), { view: null, panel: null, card: null });
  assert.deepEqual(viewFromUrl("?mode=cepat&card=hook&x=1"), { view: "cepat", panel: null, card: "hook" });
  assert.deepEqual(viewFromUrl(null), { view: null, panel: null, card: null });
  assert.deepEqual(viewFromUrl(new URLSearchParams("panel=music")), { view: null, panel: "music", card: null });
});

test("viewFromUrl accepts exactly the PANELS ids and the card ids", () => {
  assert.deepEqual([...PANEL_IDS], PANELS.map((entry) => entry.id));
  assert.deepEqual([...CARD_IDS], CARDS.map((entry) => entry.id));
  for (const id of PANEL_IDS) assert.equal(viewFromUrl(`?panel=${id}`).panel, id);
  for (const id of CARD_IDS) assert.equal(viewFromUrl(`?card=${id}`).card, id);
  // The ids of one list are not valid in the other ("extras" is a card, "logo" a panel).
  assert.equal(viewFromUrl("?panel=extras").panel, null);
  assert.equal(viewFromUrl("?card=logo").card, null);
});

test("resolveView: the URL, else the stored preference, else Cepat", () => {
  const url = (view = null, panel = null, card = null) => ({ view, panel, card });
  const rows = [
    // [url, stored, expected]
    [url(), null, "cepat"],
    [url(), "lengkap", "lengkap"],
    [url(), "cepat", "cepat"],
    [url("lengkap"), null, "lengkap"],
    [url("lengkap"), "cepat", "lengkap"],
    [url("cepat"), "lengkap", "cepat"],
    [url(null, "text"), null, "lengkap"],
    [url(null, "text"), "cepat", "lengkap"],
    [url(null, null, "lines"), "lengkap", "cepat"],
    [url(null, "text", "lines"), "cepat", "lengkap"],
    [url("cepat", "text"), "lengkap", "cepat"],
    [url("lengkap", null, "hook"), "cepat", "lengkap"],
  ];
  for (const [given, stored, expected] of rows) {
    assert.equal(resolveView({ url: given, stored }), expected, JSON.stringify({ given, stored }));
  }
  assert.equal(resolveView({}), "cepat");
  assert.equal(resolveView({ url: null, stored: "lama" }), "cepat", "an unknown stored value is ignored");
});

test("urlWithView sets ?mode, keeps the other params and the hash, drops panel and card", () => {
  assert.equal(urlWithView("https://potongin.test/projects/j/clips/c/edit", "lengkap"), "/projects/j/clips/c/edit?mode=lengkap");
  assert.equal(urlWithView("https://potongin.test/p/edit?mode=lengkap&panel=text&x=1#catatan", "cepat"), "/p/edit?mode=cepat&x=1#catatan");
  assert.equal(urlWithView("/p/edit?card=lines&utm=a", "lengkap"), "/p/edit?utm=a&mode=lengkap");
  assert.equal(urlWithView("/p/edit?panel=music&card=hook", "cepat"), "/p/edit?mode=cepat");
  assert.throws(() => urlWithView("/p/edit", "lama"), /unknown view/);
});
