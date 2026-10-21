// "Tampilan klip" at job creation (CONTRACTS §5.47): the caption pack, its spot (Atas, Tengah,
// Bawah) and its size are job options the automatic render honours. The ids and numbers are the
// engine's (edit_v2/__init__.py) and the editor's presets, so the automatic file equals what the
// editor opens. With the legacy engine (the rollback switch) the dashboard offers only Klasik and
// Karaoke at the bottom, the one look that engine draws.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPTION_PACKS, CAPTION_POSITIONS as EDITOR_POSITIONS, CAPTION_SIZES as EDITOR_SIZES } from "../components/editor/panels/caption-model.mjs";
import {
  CAPTION_POSITION_CHOICES,
  CAPTION_SIZE_CHOICES,
  CAPTION_STYLE_CHOICES,
  DEFAULT_CHOICES,
  choicesSummary,
  lookChoices,
  normalizeChoices,
  readStoredChoices,
} from "../lib/dashboard-choices.mjs";
import { PACK_IDS } from "../lib/editor/doc-model.mjs";
import { jobListFlags } from "../lib/editor/flags.mjs";
import {
  CAPTION_POSITIONS,
  CAPTION_SIZES,
  CAPTION_STYLES,
  JOB_FORM_FIELDS,
  LEGACY_CAPTION_STYLES,
  jobOptionInputFromForm,
  parseJobOptions,
  validatePersistedJobOptions,
} from "../lib/jobs.mjs";
import { CAPTION_KEY, LOOK_NOTES, lookPreview } from "../lib/look-preview.mjs";
import { buildClipperInvocation } from "../scripts/run-job.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(path.join(REPO, ...parts), "utf8");

/** A Python MappingProxyType({...}) constant of edit_v2/__init__.py as a plain object. */
function pythonMapping(name) {
  const match = new RegExp(`^${name} = MappingProxyType\\(\\{([^}]*)\\}\\)`, "m").exec(read("src", "ai_clipper", "edit_v2", "__init__.py"));
  assert.ok(match, name);
  return Object.fromEntries([...match[1].matchAll(/"([a-z]+)":\s*(\d+)/g)].map((entry) => [entry[1], Number(entry[2])]));
}

const STORED = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const V3_OPTIONS = { ...STORED };

// --- the option ids -------------------------------------------------------------------------

test("every caption pack is a job option, and the spots and sizes are the engine's and the editor's", () => {
  const python = /^PACK_IDS = \(([^)]*)\)/m.exec(read("src", "ai_clipper", "edit_v2", "__init__.py"))[1];
  assert.deepEqual(CAPTION_STYLES, [...python.matchAll(/"([a-z]+)"/g)].map((entry) => entry[1]));
  assert.deepEqual(CAPTION_STYLES, [...PACK_IDS]);
  assert.deepEqual(LEGACY_CAPTION_STYLES, ["karaoke", "classic"]);

  const positions = pythonMapping("CAPTION_POSITIONS");
  const sizes = pythonMapping("CAPTION_SIZES");
  assert.deepEqual(CAPTION_POSITIONS, Object.keys(positions));
  assert.deepEqual(CAPTION_SIZES, Object.keys(sizes));
  // Atas / Tengah / Bawah and Kecil / Sedang / Besar are the editor's own presets.
  assert.deepEqual(EDITOR_POSITIONS.map((entry) => entry.value), CAPTION_POSITIONS.map((id) => positions[id]));
  assert.deepEqual(EDITOR_SIZES.map((entry) => entry.value), CAPTION_SIZES.map((id) => sizes[id]));
  assert.deepEqual(CAPTION_POSITION_CHOICES.map((entry) => [entry.id, entry.name]), [["top", "Atas"], ["middle", "Tengah"], ["bottom", "Bawah"]]);
  assert.deepEqual(CAPTION_SIZE_CHOICES.map((entry) => [entry.id, entry.name]), [["small", "Kecil"], ["medium", "Sedang"], ["large", "Besar"]]);
  assert.deepEqual(CAPTION_POSITION_CHOICES.map((entry) => entry.y_e5), CAPTION_POSITIONS.map((id) => positions[id]));
  assert.deepEqual(CAPTION_SIZE_CHOICES.map((entry) => entry.size_pm), CAPTION_SIZES.map((id) => sizes[id]));

  // The dashboard names a pack as the editor does.
  assert.deepEqual(CAPTION_STYLE_CHOICES.map((entry) => entry.id), CAPTION_STYLES);
  assert.deepEqual(CAPTION_STYLE_CHOICES.map((entry) => entry.name), CAPTION_STYLES.map((id) => CAPTION_PACKS.find((pack) => pack.id === id).name));
  for (const entry of [...CAPTION_STYLE_CHOICES, ...CAPTION_POSITION_CHOICES, ...CAPTION_SIZE_CHOICES]) {
    assert.doesNotMatch(`${entry.name} ${entry.description ?? ""}`, /—|\bV[1-3]\b|baru|viral|Hot/, entry.id);
  }
});

// --- the job API ----------------------------------------------------------------------------

test("a new job takes any pack, spot and size, and stores the spot and size only when given", () => {
  for (const captionStyle of CAPTION_STYLES) assert.equal(parseJobOptions({ captionStyle }).captionStyle, captionStyle);
  const plain = parseJobOptions({ captionStyle: "bold" });
  assert.ok(!("captionPosition" in plain) && !("captionSize" in plain), "an older client's job is the pack's own spot");
  for (const captionPosition of CAPTION_POSITIONS) {
    for (const captionSize of CAPTION_SIZES) {
      const parsed = parseJobOptions({ captionStyle: "sorot", captionPosition, captionSize });
      assert.deepEqual([parsed.captionPosition, parsed.captionSize], [captionPosition, captionSize]);
      assert.deepEqual(validatePersistedJobOptions(parsed), parsed, "what is stored reads back");
    }
  }
  assert.deepEqual(parseJobOptions({ captionPosition: "", captionSize: null }), parseJobOptions({}), "an empty field is not given");
});

test("an unknown caption look is refused before anything is stored", () => {
  for (const captionStyle of ["neon", "Karaoke", "glow-x", 7]) {
    assert.throws(() => parseJobOptions({ captionStyle }), /Unsupported caption style/, String(captionStyle));
  }
  for (const captionPosition of ["atas", "Top", "38000", 38000, "left"]) {
    assert.throws(() => parseJobOptions({ captionPosition }), /Unsupported caption position/, String(captionPosition));
  }
  for (const captionSize of ["besar", "Large", "1200", 1200]) {
    assert.throws(() => parseJobOptions({ captionSize }), /Unsupported caption size/, String(captionSize));
  }
});

test("stored jobs: old ones keep working, a stored look is checked, and only V3 jobs carry one", () => {
  assert.deepEqual(validatePersistedJobOptions(STORED), STORED, "a job from before this option");
  for (const captionStyle of CAPTION_STYLES) {
    assert.equal(validatePersistedJobOptions({ ...STORED, captionStyle }).captionStyle, captionStyle);
  }
  const look = { ...STORED, captionStyle: "box", captionPosition: "middle", captionSize: "small" };
  assert.deepEqual(validatePersistedJobOptions(look), look);
  for (const bad of [{ captionPosition: "atas" }, { captionPosition: null }, { captionSize: "huge" }, { captionSize: 850 }, { captionStyle: "neon" }]) {
    assert.throws(() => validatePersistedJobOptions({ ...STORED, ...bad }), /Invalid persisted job options/, JSON.stringify(bad));
  }
  const v1 = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v1" };
  for (const extra of [{ captionPosition: "top" }, { captionSize: "large" }]) {
    assert.throws(() => validatePersistedJobOptions({ ...v1, ...extra }), /require v3 mode/, JSON.stringify(extra));
  }
});

test("the form fields carry the spot and size to the job API", () => {
  assert.deepEqual(JOB_FORM_FIELDS.filter((field) => /caption/i.test(field)), ["captionStyle", "captionPosition", "captionSize"]);
  const values = new Map([["captionStyle", "bold"], ["captionPosition", "top"], ["captionSize", "large"]]);
  const input = jobOptionInputFromForm({ get: (name) => values.get(name) ?? null });
  const parsed = parseJobOptions(input);
  assert.deepEqual([parsed.captionStyle, parsed.captionPosition, parsed.captionSize], ["bold", "top", "large"]);
});

test("the runner passes the spot and size to the CLI only when the job has them", () => {
  const tail = (options) => {
    const { args } = buildClipperInvocation({ options }, "/in/source.mp4", "/j/output", {});
    return args.slice(args.indexOf("--selection-mode"));
  };
  assert.deepEqual(tail(V3_OPTIONS), ["--selection-mode", "v3", "--llm", "auto", "--cold-open", "--hook-overlay", "--caption-style", "karaoke"]);
  assert.deepEqual(tail({ ...V3_OPTIONS, captionStyle: "sorot", captionPosition: "middle", captionSize: "large" }), [
    "--selection-mode", "v3", "--llm", "auto", "--cold-open", "--hook-overlay", "--caption-style", "sorot",
    "--caption-position", "middle", "--caption-size", "large",
  ]);
  assert.deepEqual(tail({ ...V3_OPTIONS, captionSize: "small" }).slice(-2), ["--caption-size", "small"]);
  assert.ok(!tail({ ...V3_OPTIONS, captionSize: "small" }).includes("--caption-position"));
  const cli = read("src", "ai_clipper", "cli.py");
  for (const flag of ["--caption-position", "--caption-size"]) assert.match(cli, new RegExp(`"${flag}"`), flag);
});

// --- the engine the dashboard reads ---------------------------------------------------------

test("GET /api/jobs names the automatic clips' engine: edit-v2 unless the rollback switch says legacy", () => {
  assert.deepEqual(jobListFlags({}), { editor: false, renderEngine: "edit-v2" });
  assert.deepEqual(jobListFlags({ POTONGIN_EDITOR_V3: "on", POTONGIN_RENDER_ENGINE: "edit-v2" }), { editor: true, renderEngine: "edit-v2" });
  assert.deepEqual(jobListFlags({ POTONGIN_RENDER_ENGINE: " legacy " }), { editor: false, renderEngine: "legacy" });
  const route = read("web", "app", "api", "jobs", "route.js");
  assert.match(route, /\.\.\.jobListFlags\(process\.env\)/);
});

// --- the dashboard's choices ----------------------------------------------------------------

test("the new engine offers every pack, spot and size; the legacy engine only what it draws", () => {
  const full = lookChoices("edit-v2");
  assert.deepEqual(full.styles.map((entry) => entry.id), CAPTION_STYLES);
  assert.deepEqual(full.positions.map((entry) => entry.id), CAPTION_POSITIONS);
  assert.deepEqual(full.sizes.map((entry) => entry.id), CAPTION_SIZES);
  assert.deepEqual(lookChoices(undefined), full, "the release default before the jobs list answers");
  const legacy = lookChoices("legacy");
  assert.deepEqual(legacy.styles.map((entry) => entry.id), LEGACY_CAPTION_STYLES);
  assert.equal(legacy.positions, null);
  assert.equal(legacy.sizes, null);
});

test("stored choices keep a look the engine offers and fall back from one it does not", () => {
  assert.equal(DEFAULT_CHOICES.captionPosition, "bottom");
  assert.equal(DEFAULT_CHOICES.captionSize, "medium");
  const picked = { captionStyle: "sorot", captionPosition: "top", captionSize: "large" };
  const kept = normalizeChoices(picked);
  assert.deepEqual([kept.captionStyle, kept.captionPosition, kept.captionSize], ["sorot", "top", "large"]);
  const rolledBack = normalizeChoices(picked, { engine: "legacy" });
  assert.deepEqual([rolledBack.captionStyle, rolledBack.captionPosition, rolledBack.captionSize], ["karaoke", "bottom", "medium"]);
  assert.equal(normalizeChoices({ captionStyle: "classic" }, { engine: "legacy" }).captionStyle, "classic");
  const stored = readStoredChoices({ getItem: () => JSON.stringify({ captionPosition: "atas", captionSize: 1200 }) });
  assert.deepEqual([stored.captionPosition, stored.captionSize], ["bottom", "medium"]);
});

test("the folded summary names a spot or size only when it is not the pack's own", () => {
  assert.doesNotMatch(choicesSummary(DEFAULT_CHOICES), /subtitle/);
  const summary = choicesSummary({ ...DEFAULT_CHOICES, captionStyle: "bold", captionPosition: "top", captionSize: "large" });
  assert.match(summary, / · Bold · subtitle atas · subtitle besar · /);
  assert.match(choicesSummary({ ...DEFAULT_CHOICES, captionPosition: "middle" }), / · Karaoke · subtitle tengah · /);
});

// --- the 9:16 preview -----------------------------------------------------------------------

const look = (patch = {}, options = {}) => lookPreview({ ...DEFAULT_CHOICES, ...patch }, options);

test("the preview moves the subtitle to the spot and size the job will render", () => {
  const bottom = look();
  assert.equal(bottom.caption.bottom, 1062.4);
  assert.deepEqual(bottom.caption.image, { x: 80, y: 950, w: 560, h: 140 });
  const top = look({ captionPosition: "top" });
  assert.equal(top.caption.bottom, 486.4, "38% of 1280");
  assert.deepEqual(top.caption.image, { x: 80, y: 374, w: 560, h: 140 });
  assert.equal(look({ captionPosition: "middle" }).caption.bottom, 768);
  // A size scales the subtitle about the middle of its bottom edge, like the engine's size_pm.
  const large = look({ captionSize: "large" });
  assert.deepEqual(large.caption.image, { x: 24, y: 927.52, w: 672, h: 168 });
  const small = look({ captionSize: "small" });
  assert.deepEqual(small.caption.image, { x: 122, y: 966.86, w: 476, h: 119 });
  for (const entry of [bottom, top, large, small]) {
    const { image } = entry.caption;
    assert.ok(Math.abs(image.x + image.w / 2 - 360) < 0.01, "centred");
    assert.equal(image.w / image.h, 4, "the thumbnail keeps its shape");
  }
  assert.deepEqual([top.caption.position, top.caption.size], ["top", "medium"]);
});

test("only a subtitle at the bottom sits in the TikTok zone, and the note says so", () => {
  assert.equal(look().captionInZone, true);
  assert.equal(look().note, LOOK_NOTES.zone);
  for (const captionPosition of ["top", "middle"]) {
    assert.equal(look({ captionPosition }).captionInZone, false, captionPosition);
    assert.equal(look({ captionPosition }).note, null, captionPosition);
  }
  assert.equal(look({ captionPosition: "middle" }, { editor: true }).note, LOOK_NOTES.editor);
  assert.equal(LOOK_NOTES.editor, "Per klip bisa diubah lagi lewat Edit klip.");
  // The subtitle at Atas stays clear of the hook bar.
  const top = look({ captionPosition: "top", captionSize: "large" });
  assert.ok(top.caption.image.y > top.hook.box.y + top.hook.box.h, JSON.stringify([top.caption.image, top.hook.box]));
});

test("the preview's accessible name reads the spot and size", () => {
  assert.equal(look({ captionStyle: "bold", captionPosition: "top", captionSize: "large" }).label,
    "Pratinjau klip 9:16: Utuh + latar blur, subtitle Bold besar di atas, teks hook di atas.");
  assert.equal(look({ captionPosition: "middle" }).label, "Pratinjau klip 9:16: Utuh + latar blur, subtitle Karaoke di tengah, teks hook di atas.");
});

test("with the legacy engine the preview shows the one spot and size that engine draws", () => {
  const legacy = look({ captionStyle: "box", captionPosition: "top", captionSize: "large" }, { engine: "legacy", editor: true });
  assert.deepEqual([legacy.caption.pack, legacy.caption.position, legacy.caption.size], ["karaoke", "bottom", "medium"]);
  assert.equal(legacy.note, `${LOOK_NOTES.zone} ${LOOK_NOTES.legacyEditor}`);
  assert.equal(LOOK_NOTES.legacyEditor, "Geser atau ubah ukurannya per klip lewat Edit klip.");
});

test("the thumbnail's backdrop turns transparent, so a subtitle over the picture shows no box", () => {
  // One alpha row per side of the backdrop's luminance; their sum masks the thumbnail.
  assert.match(CAPTION_KEY.brighter, /^0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 [\d.]+ [\d.]+ [\d.]+ 0 -[\d.]+$/);
  assert.match(CAPTION_KEY.darker, /^0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -[\d.]+ -[\d.]+ -[\d.]+ 0 [\d.]+$/);
  const alpha = (row, [r, g, b]) => {
    const n = row.split(" ").map(Number).slice(15);
    return Math.min(1, Math.max(0, n[0] * r + n[1] * g + n[2] * b + n[4]));
  };
  const both = (rgb) => Math.min(1, alpha(CAPTION_KEY.brighter, rgb) + alpha(CAPTION_KEY.darker, rgb));
  const backdrop = [0x4b / 255, 0x55 / 255, 0x63 / 255];
  assert.ok(both(backdrop) < 0.02, "the backdrop vanishes");
  for (const ink of [[1, 1, 1], [0, 0, 0], [1, 0xe1 / 255, 0x4d / 255], [1, 0x5c / 255, 0x8a / 255]]) {
    assert.ok(both(ink) > 0.99, `ink ${ink} stays`);
  }
  const preview = read("web", "app", "dashboard", "LookPreview.jsx");
  assert.match(preview, /<feColorMatrix[^>]*values=\{CAPTION_KEY\.brighter\}/);
  assert.match(preview, /<feColorMatrix[^>]*values=\{CAPTION_KEY\.darker\}/);
  assert.match(preview, /data-position=\{caption\.position\}/);
  assert.match(preview, /data-size=\{caption\.size\}/);
});

test("the page offers the spot and size only while the engine draws them, and sends them only then", () => {
  const page = read("web", "app", "dashboard", "page.jsx");
  assert.match(page, /setRenderEngine\(payload\.renderEngine === "legacy" \? "legacy" : "edit-v2"\)/);
  assert.match(page, /const offered = lookChoices\(renderEngine\);/);
  assert.match(page, /\{offered\.positions && \(/);
  assert.match(page, /\{offered\.sizes && \(/);
  assert.match(page, /if \(offered\.positions\) data\.set\("captionPosition", captionPosition\);/);
  assert.match(page, /if \(offered\.sizes\) data\.set\("captionSize", captionSize\);/);
  assert.match(page, /offered\.styles\.map\(/);
  assert.doesNotMatch(page, /CAPTION_STYLE_CHOICES\.map\(/, "the styles come from what the engine offers");
});
