// Output sizes 9:16 and 1:1 at 720p and 1080p (CONTRACTS §5.53): the frame rules shared with the
// edit_v2 package (lib/output-frame.mjs), the job option `outputSize` from the dashboard to the
// engine's argv and the source download, the dashboard's Rasio and Resolusi with their preview,
// and what the editor does at 1:1 (no TikTok zone, logo presets 4 % from every edge, the caption
// box at the 9:16 text size).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { captionBox } from "../components/editor/gizmos/caption-geometry.mjs";
import { cornerTransform, boxOf, zoneHits } from "../components/editor/gizmos/logo-geometry.mjs";
import { LAYOUT_OPTIONS, layoutNote, noteForRatio } from "../components/editor/panels/layout-model.mjs";
import {
  DEFAULT_CHOICES,
  RATIO_CHOICES,
  RESOLUTION_CHOICES,
  choicesSummary,
  normalizeChoices,
  outputSizeOf,
  readStoredChoices,
  writeStoredChoices,
} from "../lib/dashboard-choices.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { JOB_FORM_FIELDS, OUTPUT_SIZE_IDS, parseJobOptions, validatePersistedJobOptions } from "../lib/jobs.mjs";
import { lookPreview } from "../lib/look-preview.mjs";
import {
  DEFAULT_OUTPUT_SIZE,
  EDGE_MARGIN_PM,
  OUTPUT_SIZES,
  UI_ZONE_720,
  frameMargins,
  isPortrait,
  ratioName,
  textHeight,
  uiZone,
} from "../lib/output-frame.mjs";
import { buildClipperInvocation, buildVideoDownload, sourceHeightFor } from "../scripts/run-job.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(path.join(REPO, ...parts), "utf8");

function pythonConstant(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m").exec(source);
  assert.ok(match, `${name} in the Python source`);
  return match[1].split("#")[0].trim();
}

const SQUARE = Object.freeze({ w: 720, h: 720 });
const SQUARE_1080 = Object.freeze({ w: 1080, h: 1080 });
const TALL = Object.freeze({ w: 720, h: 1280 });

// --- the frame rules -----------------------------------------------------------------------------

test("the output sizes, the zone and the edge margin are the edit_v2 package's", () => {
  const init = read("src", "ai_clipper", "edit_v2", "__init__.py");
  const sizes = Object.values(OUTPUT_SIZES).map(({ w, h }) => `(${w}, ${h})`).join(", ");
  assert.equal(pythonConstant(init, "OUTPUT_SIZES"), `(${sizes})`);
  assert.equal(pythonConstant(init, "UI_ZONE_720"), `(${UI_ZONE_720.top}, ${UI_ZONE_720.bottom}, ${UI_ZONE_720.right})`);
  assert.equal(Number(pythonConstant(init, "EDGE_MARGIN_PM")), EDGE_MARGIN_PM);
  assert.equal(DEFAULT_OUTPUT_SIZE, "720x1280");
  assert.deepEqual(OUTPUT_SIZE_IDS, Object.keys(OUTPUT_SIZES));
  // no 2K, 4K or 16:9
  assert.ok(Object.values(OUTPUT_SIZES).every(({ w, h }) => w <= 1080 && h >= w));
});

test("9:16 keeps the TikTok zone; 1:1 has none and keeps 4 % from every edge", () => {
  assert.deepEqual(uiZone(TALL), { top: 93, bottom: 280, right: 93 });
  assert.deepEqual(uiZone({ w: 1080, h: 1920 }), { top: 140, bottom: 420, right: 140 });
  assert.deepEqual(frameMargins(TALL), uiZone(TALL));
  assert.deepEqual(uiZone(SQUARE), { top: 0, bottom: 0, right: 0 });
  assert.deepEqual(frameMargins(SQUARE), { top: 29, bottom: 29, right: 29 });
  assert.deepEqual(frameMargins(SQUARE_1080), { top: 43, bottom: 43, right: 43 });
  assert.equal(isPortrait(TALL), true);
  assert.equal(isPortrait(SQUARE), false);
  assert.equal(ratioName(TALL), "9:16");
  assert.equal(ratioName(SQUARE_1080), "1:1");
});

test("text is sized from the 9:16 frame of the width", () => {
  assert.equal(textHeight(TALL), 1280);
  assert.equal(textHeight(SQUARE), 1280);
  assert.equal(textHeight(SQUARE_1080), 1920);
});

// --- the job option ------------------------------------------------------------------------------

const BASE = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 };
const V3 = { ...BASE, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };

test("a new job takes every output size and refuses any other", () => {
  assert.ok(JOB_FORM_FIELDS.includes("outputSize"));
  assert.equal(parseJobOptions({}).outputSize, undefined);
  for (const outputSize of OUTPUT_SIZE_IDS) {
    assert.equal(parseJobOptions({ outputSize }).outputSize, outputSize);
  }
  for (const outputSize of ["1920x1080", "2160x3840", "1440x2560", "720X1280", "720x1280 ", "toString"]) {
    assert.throws(() => parseJobOptions({ outputSize }), /Unsupported output size/, outputSize);
  }
});

test("a stored job keeps its output size; only a V3 job carries one", () => {
  assert.equal(validatePersistedJobOptions({ ...V3, outputSize: "1080x1080" }).outputSize, "1080x1080");
  assert.equal("outputSize" in validatePersistedJobOptions(V3), false);
  assert.throws(() => validatePersistedJobOptions({ ...V3, outputSize: "1920x1080" }), /output size/);
  assert.throws(() => validatePersistedJobOptions({ ...BASE, selectionMode: "v1", outputSize: "720x720" }), /require v3 mode/);
});

test("the engine renders the job's size; a job without one renders at 720×1280", () => {
  const size = (options) => {
    const { args } = buildClipperInvocation({ options }, "/in/source.mp4", "/j/output", {});
    return `${args[args.indexOf("--width") + 1]}x${args[args.indexOf("--height") + 1]}`;
  };
  assert.equal(size(V3), "720x1280");
  assert.equal(size({ ...BASE, selectionMode: "v1" }), "720x1280");
  for (const outputSize of OUTPUT_SIZE_IDS) assert.equal(size({ ...V3, outputSize }), outputSize);
});

test("a 1080p job downloads a source up to 1080p, every other one up to 720p", () => {
  assert.equal(sourceHeightFor({ ...V3, outputSize: "1080x1920" }), 1080);
  assert.equal(sourceHeightFor({ ...V3, outputSize: "1080x1080" }), 1080);
  assert.equal(sourceHeightFor({ ...V3, outputSize: "720x720" }), 720);
  assert.equal(sourceHeightFor(V3), 720);
  assert.equal(sourceHeightFor({ ...V3, outputSize: "bad" }), 720);
  assert.equal(sourceHeightFor(null), 720);
  const format = (options) => {
    const args = buildVideoDownload("https://youtu.be/abc", "/j/input", options);
    return args[args.indexOf("--format") + 1];
  };
  assert.equal(format(), "bv*[height<=720]+ba/b[height<=720]");
  assert.equal(format({ maxHeight: 1080 }), "bv*[height<=1080]+ba/b[height<=1080]");
  assert.equal(format({ maxHeight: 4320 }), "bv*[height<=720]+ba/b[height<=720]");
});

// --- the dashboard -------------------------------------------------------------------------------

test("Rasio and Resolusi make the job's output size; 9:16 at 720p by default", () => {
  assert.deepEqual(RATIO_CHOICES.map((entry) => entry.id), ["9:16", "1:1"]);
  assert.deepEqual(RESOLUTION_CHOICES.map((entry) => entry.id), ["720p", "1080p"]);
  assert.equal(outputSizeOf(DEFAULT_CHOICES), "720x1280");
  assert.equal(outputSizeOf({ ratio: "9:16", resolution: "1080p" }), "1080x1920");
  assert.equal(outputSizeOf({ ratio: "1:1", resolution: "720p" }), "720x720");
  assert.equal(outputSizeOf({ ratio: "1:1", resolution: "1080p" }), "1080x1080");
  assert.equal(outputSizeOf({ ratio: "16:9", resolution: "4K" }), "720x1280");
  for (const ratio of RATIO_CHOICES) {
    for (const resolution of RESOLUTION_CHOICES) {
      assert.ok(OUTPUT_SIZE_IDS.includes(outputSizeOf({ ratio: ratio.id, resolution: resolution.id })));
    }
  }
});

test("the choices are kept per browser and the summary names only what differs from 9:16 720p", () => {
  assert.deepEqual(normalizeChoices({ ratio: "4:5", resolution: "2K" }), normalizeChoices(null));
  const storage = new Map();
  const browser = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  assert.equal(writeStoredChoices(browser, { ...DEFAULT_CHOICES, ratio: "1:1", resolution: "1080p" }), true);
  const stored = readStoredChoices(browser);
  assert.equal(stored.ratio, "1:1");
  assert.equal(stored.resolution, "1080p");
  assert.doesNotMatch(choicesSummary(DEFAULT_CHOICES), /9:16|720p/);
  assert.match(choicesSummary(stored), /^3 klip · Otomatis 20–60 detik · 1:1 · 1080p · Utuh \+ latar blur/);
});

test("the preview of a 1:1 job is square, without the TikTok zone, with the 9:16 text sizes", () => {
  const tall = lookPreview(DEFAULT_CHOICES);
  const square = lookPreview({ ...DEFAULT_CHOICES, ratio: "1:1" });
  assert.deepEqual(square.frame, { w: 720, h: 720 });
  assert.equal(tall.tiktok, true);
  assert.equal(square.tiktok, false);
  assert.deepEqual(square.zone, { top: 0, bottom: 0, right: 0 });
  assert.equal(square.captionInZone, false);
  assert.equal(square.label, "Pratinjau klip 1:1: Utuh + latar blur, subtitle Karaoke di bawah, teks hook di atas.");
  assert.equal(square.hook.fontSize, tall.hook.fontSize);
  assert.equal(square.hook.box.h, tall.hook.box.h);
  assert.equal(square.hook.box.y, 93.6); // 13 % of 720
  assert.deepEqual([square.caption.image.w, square.caption.image.h], [tall.caption.image.w, tall.caption.image.h]);
  assert.equal(square.caption.bottom, 597.6); // 83 % of 720
  const below = (look) => Math.round((look.caption.image.y + look.caption.image.h - look.caption.bottom) * 100);
  assert.equal(below(square), below(tall)); // the thumbnail sits on the subtitle's bottom as at 9:16
  assert.deepEqual(square.picture, { mode: "fit", band: { x: 0, y: 157.5, w: 720, h: 405 } });
  // 1080p changes nothing the preview draws
  assert.deepEqual(lookPreview({ ...DEFAULT_CHOICES, ratio: "1:1", resolution: "1080p" }), square);
});

test("the dashboard sends the output size and offers Rasio and Resolusi", () => {
  const page = read("web", "app", "dashboard", "page.jsx");
  assert.match(page, /data\.set\("outputSize", outputSizeOf\(choices\)\)/);
  assert.match(page, /<legend className=\{styles\.groupTitle\}>Rasio<\/legend>/);
  assert.match(page, /<legend className=\{styles\.groupTitle\}>Resolusi<\/legend>/);
});

// --- the editor at 1:1 ---------------------------------------------------------------------------

function squareSeed(size = SQUARE) {
  const seed = fakeDoc();
  seed.output = { ...seed.output, w: size.w, h: size.h };
  return seed;
}

test("a new logo on a 1:1 clip sits 4 % from the top and right edges, and never in a zone", () => {
  const seed = squareSeed();
  const ctx = createContext({ words: fakeWords(), seed });
  const hex = "7d2e".padEnd(64, "b");
  const meta = { sha256: hex, kind: "logo", mime: "image/png", w: 512, h: 512 };
  const doc = applyCommand(seed, "SetLogo", { asset: `sha256:${hex}`, meta }, ctx).doc;
  const { transform } = doc.tracks.find((track) => track.kind === "visual").items[0];
  const box = boxOf(transform, meta, SQUARE);
  assert.deepEqual([box.y, SQUARE.w - box.x - box.w], [29, 29]);
  for (const corner of ["top_left", "top_right", "bottom_left", "bottom_right"]) {
    const at = boxOf({ ...transform, ...cornerTransform(transform, meta, SQUARE, corner) }, meta, SQUARE);
    assert.equal(corner.startsWith("top") ? at.y : SQUARE.h - at.y - at.h, 29, corner);
    assert.equal(corner.endsWith("left") ? at.x : SQUARE.w - at.x - at.w, 29, corner);
    assert.equal(zoneHits(at, SQUARE).any, false, corner);
  }
  assert.equal(zoneHits({ x: 0, y: 0, w: 720, h: 720 }, SQUARE).any, false);
});

test("the caption gizmo's box at 1:1 has the 9:16 text size at the 1:1 spot", () => {
  const captions = fakeDoc().captions;
  const tall = captionBox(captions, TALL);
  const square = captionBox(captions, SQUARE);
  assert.equal(square.h, tall.h);
  assert.equal(square.bottom, 720 - Math.round(((100000 - captions.overrides.y_e5) * 720) / 100000));
});

test("the layout notes name the clip's ratio", () => {
  const crop = LAYOUT_OPTIONS.find((entry) => entry.id === "fill_center");
  assert.match(layoutNote(crop, fakeDoc()), /^Potongan 9:16 tetap di tengah/);
  assert.match(layoutNote(crop, squareSeed()), /^Potongan 1:1 tetap di tengah/);
  assert.equal(noteForRatio("Latar blur saja.", squareSeed()), "Latar blur saja.");
});

test("the editor leaves Zona aman out at 1:1 and draws the stage at the clip's ratio", () => {
  const app = read("web", "components", "editor", "EditorApp.jsx");
  assert.match(app, /const hasZone = !frame \|\| isPortrait\(frame\);/);
  assert.match(app, /zone=\{hasZone\}/);
  const controls = read("web", "components", "editor", "StageControls.jsx");
  assert.match(controls, /\{zone && \(\s*<PillToggle pressed=\{safeZone\}/);
  const stage = read("web", "components", "editor", "Stage.jsx");
  assert.match(stage, /\{safeZone && h > w && <SafeZone w=\{w\} h=\{h\} \/>\}/);
});
