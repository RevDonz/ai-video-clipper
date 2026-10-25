// The learning half of /bantuan (lib/help-guide.mjs, the words in help.guide and help.shortcuts
// of every locale's catalog): short topics on how Potongin is used and the shortcut table,
// held to the same lists the pages offer, so the guide cannot drift from the product.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTranslator } from "use-intl/core";

import { CARDS } from "../components/editor/quick/cards.mjs";
import { PANELS } from "../components/editor/panels/index.mjs";
import { APP_SHORTCUTS } from "../lib/app-shortcuts.mjs";
import { CLIP_LIMITS } from "../lib/clip-limits.mjs";
import { CAPTION_STYLE_CHOICES, DURATION_PRESETS, LAYOUT_CHOICES, OPTION_SECTIONS } from "../lib/dashboard-choices.mjs";
import { SHORTCUTS } from "../lib/editor/shortcuts.mjs";
import { HELP_ENTRIES, HELP_GROUPS } from "../lib/help-catalog.mjs";
import { GUIDE_APP_SHORTCUTS, GUIDE_SHORTCUTS, GUIDE_TOPICS, KEY_NAMES, SHORTCUTS_ANCHOR, guideValues } from "../lib/help-guide.mjs";
import { guideView, shortcutsView } from "../lib/help-view.mjs";
import { loadNamespace, loadNamespaces } from "../lib/i18n/catalog.mjs";
import { LOCALES } from "../lib/i18n/locales.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const INTL = Object.fromEntries(LOCALES.map((entry) => [entry.code, entry.intl]));
const helpT = (code) => createTranslator({ locale: INTL[code], messages: loadNamespaces(code, ["help"]), namespace: "help" });
const topics = (code) => guideView(helpT(code));
const text = (topic) => JSON.stringify(topic);
const topicOf = (code, id) => topics(code).find((topic) => topic.id === id);

test("the guide has its topics in the order a new user meets them, each with a unique anchor", () => {
  assert.deepEqual(GUIDE_TOPICS.map((topic) => topic.id), ["mulai", "pilihan", "riwayat", "editor", "tren", "pengaturan"]);
  const anchors = [
    ...GUIDE_TOPICS.map((topic) => topic.id), SHORTCUTS_ANCHOR,
    ...HELP_ENTRIES.map((entry) => entry.id), ...HELP_GROUPS.map((group) => `grup-${group.id}`),
  ];
  assert.equal(new Set(anchors).size, anchors.length, "no guide anchor collides with an error entry");
  for (const { code } of LOCALES) {
    assert.deepEqual(Object.keys(loadNamespace(code, "help").guide.topics), GUIDE_TOPICS.map((topic) => topic.id), `${code}: topics`);
    for (const topic of topics(code)) {
      assert.ok(topic.title && topic.intro, `${code}: ${topic.id}`);
      assert.ok(topic.steps.length + topic.terms.length > 0, `${code}: ${topic.id} says something`);
      for (const step of topic.steps) assert.doesNotMatch(step, /\{|\}/, `${code}: ${topic.id} has every value filled in`);
      for (const term of topic.terms) assert.ok(term.title && term.text && !/\{|\}/.test(term.text), `${code}: ${topic.id}.${term.id}`);
      assert.doesNotMatch(text(topic), /—|\bV[1-3]\b|versi (lama|baru|\d)|terbaik|viral|\b(?:old|new) version\b/i, `${code}: ${topic.id}`);
    }
  }
  // The rombak names: Proyek and Tren, not Riwayat and Konteks Tren.
  assert.doesNotMatch(JSON.stringify(topics("id")), /Riwayat|Konteks Tren/);
});

test("every link in the guide goes to a page that exists, labelled in every locale", async () => {
  for (const topic of GUIDE_TOPICS.filter((entry) => entry.action)) {
    assert.match(topic.action.href, /^\/[a-z]+$/);
    await access(path.join(WEB, "app", topic.action.href.slice(1), "page.jsx"));
    for (const { code } of LOCALES) assert.ok(topicOf(code, topic.id).action.label, `${code}: ${topic.id}`);
  }
});

test("the options topic names what Buat klip really offers, with its real limits", () => {
  const options = text(topicOf("id", "pilihan"));
  assert.ok(options.includes(`${CLIP_LIMITS.count.min} sampai ${CLIP_LIMITS.count.max} klip`));
  assert.ok(options.includes(`${CLIP_LIMITS.seconds.min}–${CLIP_LIMITS.seconds.max} detik`));
  for (const preset of DURATION_PRESETS) {
    assert.ok(options.includes(preset.name), preset.name);
    if (preset.min) assert.ok(options.includes(`${preset.name} ${preset.min}–${preset.max} detik`), preset.id);
  }
  for (const layout of LAYOUT_CHOICES) {
    const description = `${layout.description.charAt(0).toLowerCase()}${layout.description.slice(1)}`;
    assert.ok(options.includes(`${layout.name}: ${description}`), layout.name);
  }
  for (const section of OPTION_SECTIONS) assert.ok(options.includes(section.title), section.title);
  assert.ok(options.includes(`${CAPTION_STYLE_CHOICES.length} gaya`));
  // The English topic quotes the same numbers.
  const english = text(topicOf("en", "pilihan"));
  const values = guideValues();
  for (const key of ["countMin", "countMax", "secondsMin", "secondsMax", "autoMin", "longMax", "styles"]) {
    assert.ok(english.includes(String(values[key])), key);
  }
  assert.ok(english.includes(`${CLIP_LIMITS.count.min} to ${CLIP_LIMITS.count.max} clips`));
});

test("the editor topic names the real cards and tools, and its keys come from the editor's own map", () => {
  const editor = text(topicOf("id", "editor"));
  for (const card of CARDS) assert.ok(editor.includes(card.label), card.label);
  for (const panel of PANELS) assert.ok(editor.includes(panel.label), panel.label);
  assert.ok(editor.includes("1024 px"));
  assert.ok(text(topicOf("en", "editor")).includes("1024 px"));
  const byId = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));
  assert.ok(GUIDE_SHORTCUTS.length >= 6);
  for (const shortcut of GUIDE_SHORTCUTS) {
    const source = byId.get(shortcut.id);
    assert.ok(source, shortcut.id);
    assert.deepEqual(shortcut.keys, source.keys);
    assert.equal(shortcut.description, source.description);
  }
});

test("the shortcut table lists the app keys and the editor keys, in the editor's own words in Indonesian", () => {
  assert.deepEqual(GUIDE_APP_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys]), APP_SHORTCUTS.map((shortcut) => [shortcut.id, [shortcut.key]]));
  for (const { code } of LOCALES) {
    const shortcuts = loadNamespace(code, "help").shortcuts;
    assert.deepEqual(Object.keys(shortcuts.appKeys), GUIDE_APP_SHORTCUTS.map((shortcut) => shortcut.id), `${code}: appKeys`);
    assert.deepEqual(Object.keys(shortcuts.editorKeys), GUIDE_SHORTCUTS.map((shortcut) => shortcut.id), `${code}: editorKeys`);
    for (const name of Object.values(KEY_NAMES)) assert.equal(typeof shortcuts[name], "string", `${code}: ${name}`);
    const table = shortcutsView(helpT(code));
    assert.equal(table.anchor, SHORTCUTS_ANCHOR);
    assert.deepEqual(table.groups.map((group) => group.id), ["app", "editor"]);
    for (const group of table.groups) {
      assert.ok(group.title && group.note, `${code}: ${group.id}`);
      for (const row of group.rows) assert.ok(row.text && row.keys.length, `${code}: ${row.id}`);
    }
  }
  const id = shortcutsView(helpT("id")).groups[1].rows;
  for (const row of id) assert.equal(row.text, GUIDE_SHORTCUTS.find((shortcut) => shortcut.id === row.id).description, row.id);
  const en = shortcutsView(helpT("en")).groups[1].rows;
  assert.deepEqual(en.find((row) => row.id === "playPause").keys, ["Space", "K"]);
  assert.deepEqual(id.find((row) => row.id === "playPause").keys, ["Spasi", "K"]);
});

test("the help page shows the guide before the error reference, as sections the error count ignores", async () => {
  const page = await readFile(path.join(WEB, "app", "bantuan", "page.jsx"), "utf8");
  const guide = await readFile(path.join(WEB, "app", "bantuan", "HelpGuide.jsx"), "utf8");
  assert.match(page, /guideView\(t\)/);
  assert.match(page, /<HelpGuide /);
  assert.ok(page.indexOf("<HelpGuide ") < page.indexOf("groups.map((group) => ("), "guide first");
  assert.ok(page.indexOf("<HelpGuide ") < page.indexOf("id={shortcuts.anchor}"), "the shortcuts follow the guide");
  assert.ok(page.indexOf("id={shortcuts.anchor}") < page.indexOf("groups.map((group) => ("), "the errors come last");
  // e2e/bantuan.spec.mjs counts one <article> per error entry: the guide uses none.
  assert.doesNotMatch(guide, /<article\b/);
  assert.match(guide, /<section [^>]*id=\{topic\.id\}/);
  for (const source of [page, guide]) assert.doesNotMatch(source, /—|dangerouslySetInnerHTML/);
});
