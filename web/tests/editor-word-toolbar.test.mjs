// The transcript's contextual word toolbar (docs/plans/2026-10-02-editor-mode-cepat.md §6.2):
// the primary action per selection, the buttons and the "Lainnya" menu (every one of the nine
// former chips stays reachable), the keys of the toolbar and where it sits over the selection.
// Pure rules of transcript/word-toolbar.mjs; WordToolbar.jsx is thin over them.
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { selectionActions } from "../components/editor/transcript/actions.mjs";
import { boundsIndex, buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { NO_SELECTION, extendTo, selectOne } from "../components/editor/transcript/selection.mjs";
import {
  ACTION_LABELS,
  MENU_LABEL,
  TOOLBAR_LABEL,
  TOOLBAR_TAB_HELP,
  lineBox,
  menuAlign,
  menuItems,
  primaryAction,
  toolbarButtons,
  toolbarKey,
  toolbarPosition,
} from "../components/editor/transcript/word-toolbar.mjs";

const NINE = ["remove", "restore", "edit", "hide", "emphasis", "trimStart", "trimEnd", "extend", "coldOpen"];

const bound = (words, key, id) => boundsIndex(words)[key].get(id).sf;

function removal(words, first, last, id = "rm_1") {
  const list = words.words;
  return {
    id, seg: "seg_b1", in_sf: bound(words, "before", list[first].id), out_sf: bound(words, "after", list[last].id),
    words: list.slice(first, last + 1).map((word) => word.id), reason: "user", origin: "user",
  };
}

// The fakes' 12 words: the body starts at word 3 (words 0 to 2 are dimmed, before the clip),
// words 6 and 7 are cut, word 9 is hidden from the captions.
function states() {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.main.segments[0].in_sf = bound(words, "before", words.words[3].id);
  doc.main.removals = [removal(words, 6, 7)];
  doc.captions.word_edits = { w048130: { hidden: true } };
  const model = buildTranscriptModel(words, doc);
  const at = (first, last = first, readOnly = false) => selectionActions(model, extendTo(selectOne(first), last), { readOnly });
  return { model, at };
}

// --- the primary action --------------------------------------------------------------------

test("the primary action: Perpanjang ke sini on a dimmed word, Pulihkan on cut words only, else Hapus", () => {
  const { at } = states();
  assert.equal(primaryAction(at(1)), "extend", "a word before the clip");
  assert.equal(primaryAction(at(1, 4)), "extend", "a range that starts before the clip");
  assert.equal(primaryAction(at(6, 7)), "restore", "only cut words");
  assert.equal(primaryAction(at(5, 8)), "remove", "cut and kept words: Hapus cuts the kept ones");
  assert.equal(primaryAction(at(4)), "remove", "a body word");
  assert.equal(primaryAction(at(4, 4, true)), "remove", "read-only: every action is off, Hapus stays first");
});

test("the primary action follows the order of checks of §6.2 on any actions object", () => {
  const on = { enabled: true, reason: null };
  const off = { enabled: false, reason: "x" };
  assert.equal(primaryAction({ extend: on, restore: on, remove: off }), "extend");
  assert.equal(primaryAction({ extend: off, restore: on, remove: off }), "restore");
  assert.equal(primaryAction({ extend: off, restore: on, remove: on }), "remove");
  assert.equal(primaryAction({ extend: off, restore: off, remove: off }), "remove");
});

// --- buttons and menu ----------------------------------------------------------------------

test("the toolbar holds the primary action, Jadikan cold open and Kata kunci, then Lainnya", () => {
  const { at } = states();
  assert.equal(TOOLBAR_LABEL, "Aksi kata terpilih");
  assert.equal(MENU_LABEL, "Lainnya");
  const buttons = toolbarButtons(at(4));
  assert.deepEqual(buttons.map((button) => [button.name, button.label, button.primary]), [
    ["remove", "Hapus", true],
    ["coldOpen", "Jadikan cold open", false],
    ["emphasis", "Kata kunci", false],
  ]);
  assert.deepEqual(toolbarButtons(at(1)).map((button) => button.label), ["Perpanjang ke sini", "Jadikan cold open", "Kata kunci"]);
  assert.deepEqual(toolbarButtons(at(6, 7)).map((button) => button.label), ["Pulihkan", "Jadikan cold open", "Kata kunci"]);
});

test("Jadikan cold open stays in place, off with its reason, when the selection cannot be one", () => {
  const { at } = states();
  const single = toolbarButtons(at(4)).find((button) => button.name === "coldOpen");
  assert.equal(single.enabled, false);
  assert.match(single.reason, /0,5 dtk/);
  const good = toolbarButtons(at(9, 11)).find((button) => button.name === "coldOpen");
  assert.deepEqual([good.enabled, good.reason], [true, null]);
});

test("Kata kunci is pressed when every selected word is a keyword, as the chip was", () => {
  const words = fakeWords();
  const doc = fakeDoc();
  doc.captions.word_edits = { w048121: { emphasis: true }, w048122: { emphasis: true } };
  const model = buildTranscriptModel(words, doc);
  const pressed = (first, last, readOnly = false) => toolbarButtons(selectionActions(model, extendTo(selectOne(first), last), { readOnly }))
    .find((button) => button.name === "emphasis").pressed;
  assert.equal(pressed(0, 1), true);
  assert.equal(pressed(0, 2), false);
  assert.equal(pressed(0, 1, true), undefined, "read-only: no pressed state, as the chip had");
});

test("the menu lists Edit kata, Sembunyikan dari caption, Mulai and Akhiri, then the two other cut actions", () => {
  const { at } = states();
  const items = menuItems(at(4));
  assert.deepEqual(items.map((item) => [item.id, item.label, item.shortcut ?? null]), [
    ["edit", "Edit kata", "Enter"],
    ["hide", "Sembunyikan dari caption", "Ctrl+Shift+X"],
    ["trimStart", "Mulai di sini", "I"],
    ["trimEnd", "Akhiri di sini", "O"],
    ["restore", "Pulihkan", null],
    ["extend", "Perpanjang ke sini", null],
  ]);
  assert.deepEqual(menuItems(at(1)).slice(4).map((item) => item.label), ["Hapus", "Pulihkan"]);
  assert.deepEqual(menuItems(at(6, 7)).slice(4).map((item) => item.label), ["Hapus", "Perpanjang ke sini"]);
  assert.equal(menuItems(at(1)).find((item) => item.id === "remove").shortcut, "Delete");
});

test("unavailable menu items stay in place, off, with their reason", () => {
  const { at } = states();
  const items = menuItems(at(4));
  const restore = items.find((item) => item.id === "restore");
  assert.deepEqual([restore.disabled, restore.reason], [true, "Tidak ada potongan di pilihan ini"]);
  const extend = items.find((item) => item.id === "extend");
  assert.deepEqual([extend.disabled, extend.reason], [true, "Pilih kata di luar klip (redup) untuk memperpanjang"]);
  const edit = items.find((item) => item.id === "edit");
  assert.deepEqual([edit.disabled, edit.reason], [false, null]);
  for (const item of menuItems(at(4, 4, true))) assert.deepEqual([item.disabled, item.reason], [true, "Mode baca-saja"], item.id);
});

test("Sembunyikan dari caption is a checkbox item, checked when every selected word is hidden", () => {
  const { at } = states();
  const hide = (first, last) => menuItems(at(first, last)).find((item) => item.id === "hide").checked;
  assert.equal(hide(9, 9), true);
  assert.equal(hide(8, 9), false);
  assert.equal(hide(4, 4), false);
});

test("every one of the nine former chips is a button or a menu item, exactly once, in every state", () => {
  const { at } = states();
  for (const actions of [at(1), at(4), at(6, 7), at(5, 8), at(4, 4, true)]) {
    const names = [...toolbarButtons(actions).map((button) => button.name), ...menuItems(actions).map((item) => item.id)];
    assert.deepEqual([...names].sort(), [...NINE].sort());
  }
  assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [...NINE].sort());
});

test("without a selection there is nothing to show", () => {
  const { model } = states();
  const none = selectionActions(model, NO_SELECTION, { readOnly: false });
  assert.equal(none.range, null);
  assert.deepEqual(toolbarButtons(none), []);
  assert.deepEqual(menuItems(none), []);
});

// --- keys ----------------------------------------------------------------------------------

const key = (name, mods = {}) => ({ key: name, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test("←/→ move between the buttons, Home and End go to the ends", () => {
  const at = (event, index) => toolbarKey(event, { index, count: 4 });
  assert.deepEqual(at(key("ArrowRight"), 0), { kind: "focus", index: 1 });
  assert.deepEqual(at(key("ArrowRight"), 3), { kind: "focus", index: 0 });
  assert.deepEqual(at(key("ArrowLeft"), 0), { kind: "focus", index: 3 });
  assert.deepEqual(at(key("ArrowLeft"), 2), { kind: "focus", index: 1 });
  assert.deepEqual(at(key("Home"), 2), { kind: "focus", index: 0 });
  assert.deepEqual(at(key("End"), 0), { kind: "focus", index: 3 });
  assert.equal(at(key("ArrowRight", { shiftKey: true }), 0), null);
  assert.equal(at(key("ArrowDown"), 0), null, "↓ is the menu button's");
});

test("Esc and Shift+Tab go back to the words; Tab, Enter, Space and Delete are left alone", () => {
  const at = (event) => toolbarKey(event, { index: 1, count: 4 });
  assert.deepEqual(at(key("Escape")), { kind: "list" });
  assert.deepEqual(at(key("Tab", { shiftKey: true })), { kind: "list" });
  for (const name of ["Tab", "Enter", " ", "Delete", "Backspace", "k", "?"]) assert.equal(at(key(name)), null, name);
});

test("I and O, and the selection's modifier shortcuts, act on the selection from the toolbar", () => {
  const at = (event) => toolbarKey(event, { index: 0, count: 4 });
  assert.deepEqual(at(key("i")), { kind: "action", name: "trimStart" });
  assert.deepEqual(at(key("I", { shiftKey: true })), { kind: "action", name: "trimStart" });
  assert.deepEqual(at(key("o")), { kind: "action", name: "trimEnd" });
  assert.deepEqual(at(key("e", { ctrlKey: true })), { kind: "action", name: "emphasis" });
  assert.deepEqual(at(key("X", { ctrlKey: true, shiftKey: true })), { kind: "action", name: "hide" });
  assert.deepEqual(at(key("H", { ctrlKey: true, shiftKey: true })), { kind: "action", name: "coldOpen" });
  assert.equal(at(key("i", { altKey: true })), null);
  assert.equal(at(key("z", { ctrlKey: true })), null, "Ctrl+Z stays the editor's undo");
});

// --- position ------------------------------------------------------------------------------

const BOX = { top: 100, left: 20, width: 300 };
const SIZE = { width: 200, height: 48 };

test("a word's line box is centred on its span, one line-height tall", () => {
  assert.deepEqual(lineBox({ top: 210, bottom: 230, left: 50, right: 90 }, 26), { top: 207, bottom: 233, left: 50, right: 90 });
  assert.deepEqual(lineBox({ top: 210, bottom: 230, left: 50, right: 90 }, 0), { top: 210, bottom: 230, left: 50, right: 90 });
});

test("above the first selected line, 8 px clear, its left edge on the first word", () => {
  const first = { top: 300, bottom: 326, left: 80 };
  const last = { top: 352, bottom: 378, left: 40 };
  const place = toolbarPosition({ first, last, box: BOX, visibleTop: 120, size: SIZE });
  assert.deepEqual(place, { top: 300 - 8 - 48 - 100, left: 60, placement: "above" });
  // It never covers the selection: its bottom stays 8 px above the first line.
  assert.equal(BOX.top + place.top + SIZE.height, first.top - 8);
});

test("it flips below the last selected line when less than 56 px is free above", () => {
  const last = { top: 352, bottom: 378, left: 40 };
  const free = (space) => toolbarPosition({ first: { top: 120 + space, bottom: 146 + space, left: 80 }, last, box: BOX, visibleTop: 120, size: SIZE });
  assert.equal(free(56).placement, "above");
  const below = free(55);
  assert.deepEqual(below, { top: 378 + 8 - 100, left: 60, placement: "below" });
  assert.ok(BOX.top + below.top >= last.bottom + 8, "below the selection, never over it");
  // A selection scrolled under the sticky header flips too.
  assert.equal(free(-40).placement, "below");
});

test("a taller (wrapped) toolbar needs its own height plus the gap above", () => {
  const tall = { width: 290, height: 96 };
  const at = (space) => toolbarPosition({ first: { top: 120 + space, bottom: 146 + space, left: 80 }, last: { top: 400, bottom: 426, left: 30 },
    box: BOX, visibleTop: 120, size: tall }).placement;
  assert.equal(at(104), "above");
  assert.equal(at(103), "below");
});

test("the toolbar stays inside the panel: clamped left and right", () => {
  const at = (left, size = SIZE) => toolbarPosition({ first: { top: 400, bottom: 426, left }, last: { top: 400, bottom: 426, left },
    box: BOX, visibleTop: 0, size }).left;
  assert.equal(at(20), 0);
  assert.equal(at(5), 0, "a word left of the box");
  assert.equal(at(250), 100, "300 − 200: the right edge stays inside");
  assert.equal(at(250, { width: 340, height: 48 }), 0, "wider than the panel: it starts at the left edge");
});

test("the menu opens toward the side with more room", () => {
  assert.equal(menuAlign({ left: 30, right: 120 }, { left: 0, right: 300 }), "start");
  assert.equal(menuAlign({ left: 200, right: 290 }, { left: 0, right: 300 }), "end");
});

test("the transcript's help names the toolbar's key", () => {
  assert.equal(TOOLBAR_TAB_HELP, "Tab membuka aksi kata terpilih.");
});
