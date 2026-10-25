// The app pages' single-key shortcuts (05-ui-dashboard.md §3.9, §8.1, A12; WCAG 2.1.4): N opens
// Buat klip and / goes to the page's search, only with the preference on, never from a field,
// never while an overlay is open, never with a modifier.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_SHORTCUTS, OVERLAY_SELECTOR, PAGE_SEARCH_SELECTOR, appShortcut, isFieldTarget, overlayOpenIn } from "../lib/app-shortcuts.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));

function element(tagName = "BODY", { role = null, editable = false } = {}) {
  return { tagName, isContentEditable: editable, getAttribute: (name) => (name === "role" ? role : null) };
}

function key(name, { ctrl = false, meta = false, alt = false, shift = false, on = element(), prevented = false, composing = false, repeat = false } = {}) {
  return { key: name, ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift, target: on, defaultPrevented: prevented, isComposing: composing, repeat };
}

const ON = { enabled: true, overlayOpen: false };

test("two shortcuts: N for Buat klip and / for the page's search", () => {
  assert.deepEqual(APP_SHORTCUTS.map((entry) => [entry.id, entry.key]), [["create", "N"], ["search", "/"]]);
  assert.equal(APP_SHORTCUTS.find((entry) => entry.id === "create").href, "/dashboard");
  assert.ok(Object.isFrozen(APP_SHORTCUTS));
  assert.equal(appShortcut(key("n"), ON), "create");
  assert.equal(appShortcut(key("N"), ON), "create", "caps lock");
  assert.equal(appShortcut(key("/"), ON), "search");
  // Layouts that need Shift for "/" still type "/".
  assert.equal(appShortcut(key("/", { shift: true }), ON), "search");
});

test("j, k and every other key do nothing", () => {
  for (const name of ["j", "k", "m", "1", "?", " ", "Enter", "Escape", "ArrowLeft", "Tab", "Dead", "", undefined]) {
    assert.equal(appShortcut(key(name), ON), null, String(name));
  }
});

test("with the preference off nothing fires", () => {
  assert.equal(appShortcut(key("n"), { enabled: false, overlayOpen: false }), null);
  assert.equal(appShortcut(key("/"), { enabled: false, overlayOpen: false }), null);
  assert.equal(appShortcut(key("n"), {}), null, "a missing preference is not consent");
});

test("a modifier, Shift+N, a repeat, a composition or a handled event never fires", () => {
  for (const modifier of ["ctrl", "meta", "alt"]) {
    assert.equal(appShortcut(key("n", { [modifier]: true }), ON), null, modifier);
    assert.equal(appShortcut(key("/", { [modifier]: true }), ON), null, `${modifier}+/`);
  }
  assert.equal(appShortcut(key("N", { shift: true }), ON), null);
  assert.equal(appShortcut(key("n", { repeat: true }), ON), null);
  assert.equal(appShortcut(key("n", { composing: true }), ON), null);
  assert.equal(appShortcut(key("n", { prevented: true }), ON), null);
  assert.equal(appShortcut(null, ON), null);
});

test("nothing fires from a field: input, textarea, select, contenteditable, a textbox role", () => {
  const fields = [
    element("INPUT"), element("TEXTAREA"), element("SELECT"), element("DIV", { editable: true }),
    element("DIV", { role: "textbox" }), element("DIV", { role: "searchbox" }), element("DIV", { role: "combobox" }),
    element("input"),
  ];
  for (const on of fields) {
    assert.equal(isFieldTarget(on), true, `${on.tagName} ${on.getAttribute("role")}`);
    assert.equal(appShortcut(key("n", { on }), ON), null);
    assert.equal(appShortcut(key("/", { on }), ON), null);
  }
  for (const on of [element("BODY"), element("A"), element("BUTTON"), element("DIV", { role: "button" }), null]) {
    assert.equal(isFieldTarget(on), false);
    assert.equal(appShortcut(key("n", { on }), ON), "create");
  }
});

test("nothing fires while a dialog, a menu or a listbox is open", () => {
  assert.equal(appShortcut(key("n"), { enabled: true, overlayOpen: true }), null);
  assert.equal(appShortcut(key("/"), { enabled: true, overlayOpen: true }), null);
  for (const role of ["dialog", "alertdialog", "menu", "listbox"]) assert.match(OVERLAY_SELECTOR, new RegExp(`\\[role="${role}"\\]`));
  const doc = (found) => ({ querySelector: (selector) => (selector === OVERLAY_SELECTOR ? found : null) });
  assert.equal(overlayOpenIn(doc({})), true);
  assert.equal(overlayOpenIn(doc(null)), false);
  assert.equal(overlayOpenIn(null), false);
});

test("/ looks for a search field inside the page, not in the sidebar", () => {
  assert.match(PAGE_SEARCH_SELECTOR, /^#konten /);
  assert.match(PAGE_SEARCH_SELECTOR, /input\[type="search"\]/);
  assert.match(PAGE_SEARCH_SELECTOR, /\[role="searchbox"\]/);
});

test("the shell listens only through appShortcut and reads the preference, never a key on its own", async () => {
  const shell = await readFile(path.join(WEB, "components", "AppShell.jsx"), "utf8");
  assert.match(shell, /appShortcut\(event, \{ enabled: shortcutsRef\.current, overlayOpen: overlayOpenIn\(document\) \}\)/);
  assert.doesNotMatch(shell, /event\.key === "[a-z/]"/i);
});
