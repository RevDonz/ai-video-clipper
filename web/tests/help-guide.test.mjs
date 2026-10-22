// The learning half of /bantuan (lib/help-guide.mjs): short topics on how Potongin is used, built
// from the same lists the pages offer, so the guide cannot drift from the product.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CARDS } from "../components/editor/quick/cards.mjs";
import { PANELS } from "../components/editor/panels/index.mjs";
import { CLIP_LIMITS } from "../lib/clip-limits.mjs";
import { CAPTION_STYLE_CHOICES, DURATION_PRESETS, LAYOUT_CHOICES, OPTION_SECTIONS } from "../lib/dashboard-choices.mjs";
import { SHORTCUTS } from "../lib/editor/shortcuts.mjs";
import { HELP_ENTRIES, HELP_GROUPS } from "../lib/help-catalog.mjs";
import { GUIDE_SHORTCUTS, GUIDE_TOPICS } from "../lib/help-guide.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const text = (topic) => JSON.stringify(topic);

test("the guide has its topics in the order a new user meets them, each with a unique anchor", () => {
  assert.deepEqual(GUIDE_TOPICS.map((topic) => topic.id), ["mulai", "pilihan", "riwayat", "editor", "tren", "pengaturan"]);
  const anchors = [...GUIDE_TOPICS.map((topic) => topic.id), ...HELP_ENTRIES.map((entry) => entry.id), ...HELP_GROUPS.map((group) => `grup-${group.id}`)];
  assert.equal(new Set(anchors).size, anchors.length, "no guide anchor collides with an error entry");
  for (const topic of GUIDE_TOPICS) {
    assert.ok(topic.title && topic.intro, topic.id);
    assert.ok((topic.steps?.length ?? 0) + (topic.terms?.length ?? 0) > 0, `${topic.id} says something`);
    assert.doesNotMatch(text(topic), /—|\bV[1-3]\b|versi (lama|baru|\d)|terbaik|viral/i, topic.id);
  }
});

test("every link in the guide goes to a page that exists", async () => {
  for (const topic of GUIDE_TOPICS.filter((entry) => entry.action)) {
    assert.match(topic.action.href, /^\/[a-z]+$/);
    await access(path.join(WEB, "app", topic.action.href.slice(1), "page.jsx"));
  }
});

test("the options topic names what Buat klip really offers, with its real limits", () => {
  const options = text(GUIDE_TOPICS.find((topic) => topic.id === "pilihan"));
  assert.ok(options.includes(`${CLIP_LIMITS.count.min} sampai ${CLIP_LIMITS.count.max} klip`));
  assert.ok(options.includes(`${CLIP_LIMITS.seconds.min}–${CLIP_LIMITS.seconds.max} detik`));
  for (const preset of DURATION_PRESETS) assert.ok(options.includes(preset.name), preset.name);
  for (const layout of LAYOUT_CHOICES) assert.ok(options.includes(layout.name), layout.name);
  for (const section of OPTION_SECTIONS) assert.ok(options.includes(section.title), section.title);
  assert.ok(options.includes(`${CAPTION_STYLE_CHOICES.length} gaya`));
});

test("the editor topic names the real cards and tools, and its keys come from the editor's own map", () => {
  const editor = text(GUIDE_TOPICS.find((topic) => topic.id === "editor"));
  for (const card of CARDS) assert.ok(editor.includes(card.label), card.label);
  for (const panel of PANELS) assert.ok(editor.includes(panel.label), panel.label);
  assert.ok(editor.includes("1024 px"));
  const byId = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));
  assert.ok(GUIDE_SHORTCUTS.length >= 6);
  for (const shortcut of GUIDE_SHORTCUTS) {
    const source = byId.get(shortcut.id);
    assert.ok(source, shortcut.id);
    assert.deepEqual(shortcut.keys, source.keys);
    assert.equal(shortcut.description, source.description);
  }
});

test("the help page shows the guide before the error reference, as sections the error count ignores", async () => {
  const page = await readFile(path.join(WEB, "app", "bantuan", "page.jsx"), "utf8");
  assert.match(page, /GUIDE_TOPICS\.map\(/);
  assert.match(page, /<section [^>]*id=\{topic\.id\}/);
  assert.ok(page.indexOf("GUIDE_TOPICS.map(") < page.indexOf("HELP_GROUPS.map((group) => (\n          <section"), "guide first");
  // e2e/bantuan.spec.mjs counts one <article> per error entry: the guide uses none.
  const guide = page.slice(page.indexOf("function GuideTopic"), page.indexOf("function Entry("));
  assert.doesNotMatch(guide, /<article\b/);
  assert.match(page, /<nav [^>]*aria-label="Topik panduan"/);
  assert.doesNotMatch(page, /—|dangerouslySetInnerHTML/);
});
