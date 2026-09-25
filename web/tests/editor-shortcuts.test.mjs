// T2.6: the editor keyboard map (plan Appendix C.4) in web/lib/editor/shortcuts.mjs.
import assert from "node:assert/strict";
import test from "node:test";

import { SHORTCUTS, globalShortcut, isEditableTarget, shortcutFor } from "../lib/editor/shortcuts.mjs";

function target(tagName = "BODY", { role = null, type = null, editable = false, inside = [] } = {}) {
  const attributes = { role, type };
  const self = {
    tagName,
    isContentEditable: editable,
    getAttribute: (name) => attributes[name] ?? null,
    closest: (selector) => (inside.some((item) => selector.split(",").map((part) => part.trim()).includes(item)) ? {} : null),
  };
  return self;
}

function key(keyName, { ctrl = false, meta = false, shift = false, alt = false, code = null, on = target(), prevented = false, composing = false } = {}) {
  return {
    key: keyName, code: code ?? (keyName === " " ? "Space" : null), ctrlKey: ctrl, metaKey: meta, shiftKey: shift, altKey: alt,
    target: on, defaultPrevented: prevented, isComposing: composing,
  };
}

test("the map covers every row of Appendix C.4 with a visible label", () => {
  const ids = SHORTCUTS.map((entry) => entry.id);
  for (const id of ["playPause", "frameBack", "frameForward", "secondBack", "secondForward", "undo", "redo",
    "removeWords", "editWord", "trimStart", "trimEnd", "coldOpen", "emphasis", "hideWord", "safeZone",
    "truthFrame", "export", "help"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of SHORTCUTS) {
    assert.ok(entry.keys.length > 0, entry.id);
    assert.ok(entry.description.length > 3, entry.id);
    assert.ok(["global", "transcript"].includes(entry.scope), entry.id);
  }
  assert.ok(Object.isFrozen(SHORTCUTS));
});

test("keys resolve to their action", () => {
  assert.equal(shortcutFor(key(" ")), "playPause");
  assert.equal(shortcutFor(key("k")), "playPause");
  assert.equal(shortcutFor(key("K")), "playPause");
  assert.equal(shortcutFor(key("ArrowLeft")), "frameBack");
  assert.equal(shortcutFor(key("ArrowRight")), "frameForward");
  assert.equal(shortcutFor(key("ArrowLeft", { shift: true })), "secondBack");
  assert.equal(shortcutFor(key("ArrowRight", { shift: true })), "secondForward");
  assert.equal(shortcutFor(key("z", { ctrl: true })), "undo");
  assert.equal(shortcutFor(key("z", { meta: true })), "undo");
  assert.equal(shortcutFor(key("Z", { ctrl: true, shift: true })), "redo");
  assert.equal(shortcutFor(key("y", { ctrl: true })), "redo");
  assert.equal(shortcutFor(key("Delete")), "removeWords");
  assert.equal(shortcutFor(key("Backspace")), "removeWords");
  assert.equal(shortcutFor(key("Enter")), "editWord");
  assert.equal(shortcutFor(key("i")), "trimStart");
  assert.equal(shortcutFor(key("o")), "trimEnd");
  assert.equal(shortcutFor(key("H", { ctrl: true, shift: true })), "coldOpen");
  assert.equal(shortcutFor(key("e", { ctrl: true })), "emphasis");
  assert.equal(shortcutFor(key("X", { ctrl: true, shift: true })), "hideWord");
  assert.equal(shortcutFor(key("'")), "safeZone");
  assert.equal(shortcutFor(key("R", { ctrl: true, shift: true })), "truthFrame");
  assert.equal(shortcutFor(key("E", { ctrl: true, shift: true })), "export");
  assert.equal(shortcutFor(key("?", { shift: true })), "help");
});

test("modifiers that are not part of a shortcut do not match", () => {
  assert.equal(shortcutFor(key("k", { ctrl: true })), null);
  assert.equal(shortcutFor(key("i", { alt: true })), null);
  assert.equal(shortcutFor(key("o", { ctrl: true })), null);
  assert.equal(shortcutFor(key("r", { ctrl: true })), null, "Ctrl+R stays the browser's reload");
  assert.equal(shortcutFor(key("e", { ctrl: true, alt: true })), null);
  assert.equal(shortcutFor(key("ArrowLeft", { ctrl: true })), null);
  assert.equal(shortcutFor(key("q")), null);
});

test("editable targets never trigger editor shortcuts", () => {
  assert.equal(isEditableTarget(target("INPUT", { type: "text" })), true);
  assert.equal(isEditableTarget(target("TEXTAREA")), true);
  assert.equal(isEditableTarget(target("SELECT")), true);
  assert.equal(isEditableTarget(target("DIV", { editable: true })), true);
  assert.equal(isEditableTarget(target("BUTTON")), false);
  assert.equal(isEditableTarget(null), false);
  for (const name of [" ", "k", "ArrowLeft", "i", "'", "?"]) {
    assert.equal(globalShortcut(key(name, { on: target("INPUT", { type: "text" }) })), null, name);
  }
  assert.equal(globalShortcut(key("z", { ctrl: true, on: target("TEXTAREA") })), null, "native undo in a field");
  assert.equal(globalShortcut(key("E", { ctrl: true, shift: true, on: target("INPUT") })), null);
});

test("transcript-scope keys are left to the transcript panel", () => {
  for (const [name, mods] of [["Delete", {}], ["Backspace", {}], ["Enter", {}], ["e", { ctrl: true }],
    ["X", { ctrl: true, shift: true }], ["H", { ctrl: true, shift: true }]]) {
    assert.equal(globalShortcut(key(name, mods)), null, name);
  }
});

test("native activation and arrow keys of focused controls win", () => {
  assert.equal(globalShortcut(key(" ", { on: target("BUTTON") })), null, "Space presses a focused button");
  assert.equal(globalShortcut(key(" ", { on: target("A") })), null);
  assert.equal(globalShortcut(key(" ", { on: target("DIV", { role: "slider" }) })), null);
  assert.equal(globalShortcut(key("k", { on: target("BUTTON") })), "playPause", "K works everywhere");
  assert.equal(globalShortcut(key("ArrowLeft", { on: target("DIV", { role: "slider" }) })), null);
  assert.equal(globalShortcut(key("ArrowRight", { on: target("BUTTON", { role: "tab", inside: ['[role="tablist"]'] }) })), null);
  assert.equal(globalShortcut(key("ArrowRight", { on: target("BUTTON") })), "frameForward");
  assert.equal(globalShortcut(key("ArrowLeft")), "frameBack");
});

test("handled, composing and unknown events are ignored", () => {
  assert.equal(globalShortcut(key(" ", { prevented: true })), null);
  assert.equal(globalShortcut(key("k", { composing: true })), null);
  assert.equal(globalShortcut(key("F5")), null);
  assert.equal(globalShortcut(key("R", { ctrl: true, shift: true })), "truthFrame");
  assert.equal(globalShortcut(key("E", { ctrl: true, shift: true })), "export");
  assert.equal(globalShortcut(key("Z", { ctrl: true, shift: true })), "redo");
  assert.equal(globalShortcut(key("?", { shift: true })), "help");
  assert.equal(globalShortcut(key("i")), "trimStart");
  assert.equal(globalShortcut(key("'")), "safeZone");
});
