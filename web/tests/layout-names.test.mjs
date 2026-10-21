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
