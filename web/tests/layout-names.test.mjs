// One name per layout on the dashboard and in the editor (lib/layout-names.mjs): the job form's
// Layout choices, the editor's Tata letak and the Mode Cepat card read the same Indonesian words.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LAYOUT_OPTIONS } from "../components/editor/panels/layout-model.mjs";
import { CARD_LAYOUTS } from "../components/editor/quick/quick-model.mjs";
import { LAYOUT_CHOICES } from "../lib/dashboard-choices.mjs";
import { LAYOUT_MODES } from "../lib/editor/doc-model.mjs";
import { RENDER_MODES } from "../lib/jobs.mjs";
import { LAYOUT_NAMES, RENDER_MODE_LAYOUTS, renderModeName } from "../lib/layout-names.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every layout has one name, and every job render mode is one of the layouts", () => {
  assert.deepEqual(Object.keys(LAYOUT_NAMES).sort(), [...LAYOUT_MODES].sort());
  assert.deepEqual(LAYOUT_NAMES, { fit_blur: "Latar blur", camera: "Ikuti wajah", fill_center: "Potong tengah", split: "Layar terbagi" });
  assert.deepEqual(Object.keys(RENDER_MODE_LAYOUTS).sort(), [...RENDER_MODES].sort());
  for (const layout of Object.values(RENDER_MODE_LAYOUTS)) assert.ok(LAYOUT_MODES.includes(layout), layout);
  assert.equal(renderModeName("center-crop"), "Potong tengah");
  assert.equal(renderModeName("vertical"), null);
});

test("the dashboard and the editor name each layout the same way", () => {
  for (const choice of LAYOUT_CHOICES) assert.equal(choice.name, LAYOUT_NAMES[RENDER_MODE_LAYOUTS[choice.id]], choice.id);
  for (const option of LAYOUT_OPTIONS) assert.equal(option.name, LAYOUT_NAMES[option.id], option.id);
  for (const card of CARD_LAYOUTS) assert.equal(card.name, LAYOUT_NAMES[card.id], card.id);
});

function sources(directory) {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return name === "__dev__" ? [] : sources(full);
    return /\.(mjs|jsx|js)$/.test(name) ? [full] : [];
  });
}

test("the old dashboard names are gone from the app", () => {
  const old = /Utuh \+ latar blur|Ikuti pembicara|Crop tengah/;
  for (const file of ["app", "components", "lib"].flatMap((dir) => sources(path.join(WEB, dir)))) {
    assert.doesNotMatch(readFileSync(file, "utf8"), old, path.relative(WEB, file));
  }
});

// The catalog's layout.names (rombak 07 §7.1): one key per layout mode plus Otomatis, the same
// Indonesian words as LAYOUT_NAMES, and the glossary's English (docs/glosarium.md).
test("every layout has a layout.names key in every locale, and the Indonesian text is LAYOUT_NAMES", async () => {
  const { loadNamespace } = await import("../lib/i18n/catalog.mjs");
  const { LAYOUT_NAME_MODES, renderModeLayout } = await import("../lib/layout-names.mjs");
  assert.deepEqual([...LAYOUT_NAME_MODES].sort(), [...LAYOUT_MODES, "auto"].sort());
  const id = loadNamespace("id", "layout").names;
  const en = loadNamespace("en", "layout").names;
  for (const [mode, name] of Object.entries(LAYOUT_NAMES)) assert.equal(id[mode], name, mode);
  assert.equal(id.auto, "Otomatis");
  assert.deepEqual(en, { auto: "Auto", camera: "Follow face", fill_center: "Center crop", fit_blur: "Blurred background", split: "Split screen" });
  assert.equal(renderModeLayout("face-track"), "camera");
  assert.equal(renderModeLayout("fit-blur"), "fit_blur");
  assert.equal(renderModeLayout("nope"), null);
});

test("the dashboard and the project page read layout names through one hook with literal keys", () => {
  const source = readFileSync(path.join(WEB, "components", "layout-names.jsx"), "utf8");
  assert.match(source, /^"use client";/);
  for (const mode of ["auto", "camera", "fill_center", "fit_blur", "split"]) assert.match(source, new RegExp(`t\\("names\\.${mode}"\\)`), mode);
});
