// The dashboard's 9:16 preview under "Tampilan klip" (lib/look-preview.mjs): it draws only what the
// job options change in the automatic render (layout, subtitle pack, spot and size, hook text), at
// the spots the engine uses, with the TikTok button zone over them (spot and size: caption-look.test.mjs). The engine numbers are read from the Python
// sources and the pack files, so the preview cannot drift from the output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CAPTION_STYLE_CHOICES, DEFAULT_CHOICES } from "../lib/dashboard-choices.mjs";
import { PREVIEW_BACKDROP } from "../lib/editor/content-colours.mjs";
import { CAPTION_STYLES } from "../lib/jobs.mjs";
import {
  AUTO_TEXT,
  LOOK_NOTES,
  PREVIEW_FRAME,
  THUMB_CROP,
  TIKTOK_ZONE,
  lookPreview,
} from "../lib/look-preview.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(WEB, "..");
const read = (...parts) => readFileSync(path.join(REPO, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

/** A Python module-level constant's literal text (`NAME = <value>` up to the end of the line). */
function pythonConstant(source, name) {
  const match = new RegExp(`^${name}\\s*=\\s*(.+)$`, "m").exec(source);
  assert.ok(match, `${name} in the Python source`);
  return match[1].trim();
}

const choices = (patch = {}) => ({ ...DEFAULT_CHOICES, ...patch });

test("today's defaults: Karaoke at the bottom, the hook at the top, the landscape picture whole in the middle", () => {
  const look = lookPreview(choices());
  assert.deepEqual(look.frame, { w: 720, h: 1280 });
  assert.deepEqual(look.picture, { mode: "fit", band: { x: 0, y: 437.5, w: 720, h: 405 } });
  assert.deepEqual(look.caption, { pack: "karaoke", name: "Karaoke", position: "bottom", size: "medium", image: { x: 80, y: 950, w: 560, h: 140 }, bottom: 1062.4 });
  assert.equal(look.hook.text, "Teks hook");
  assert.equal(look.hook.box.y, 166.4);
  assert.equal(look.hook.fontSize, 58.88);
  assert.deepEqual(look.zone, { top: 93, bottom: 280, right: 93 });
});

test("the hook bar is centred and stays inside the side margins of the automatic render", () => {
  const { hook, frame } = lookPreview(choices());
  const side = AUTO_TEXT.side * frame.w;
  assert.ok(hook.box.x >= side && hook.box.x + hook.box.w <= frame.w - side, JSON.stringify(hook.box));
  assert.ok(Math.abs(hook.box.x + hook.box.w / 2 - frame.w / 2) < 0.01, "centred");
  assert.ok(hook.box.h > hook.fontSize, "the text fits the bar's height");
});

test("the layout choice decides the picture: whole with a blurred fill, or cropped to fill the frame", () => {
  assert.equal(lookPreview(choices({ renderMode: "fit-blur" })).picture.mode, "fit");
  for (const renderMode of ["face-track", "center-crop"]) {
    assert.deepEqual(lookPreview(choices({ renderMode })).picture, { mode: "fill", band: null }, renderMode);
  }
});

test("the subtitle style picks the thumbnail; the hook switch adds or removes the hook bar", () => {
  assert.equal(lookPreview(choices({ captionStyle: "classic" })).caption.pack, "classic");
  assert.equal(lookPreview(choices({ captionStyle: "classic" })).caption.name, "Klasik");
  assert.equal(lookPreview(choices({ hookOverlay: false })).hook, null);
  // The layout, the pack and the hook never move the subtitle: only its spot and size do.
  const spots = new Set(["fit-blur", "face-track", "center-crop"].flatMap((renderMode) => CAPTION_STYLES.flatMap((captionStyle) => [true, false].map((hookOverlay) => (
    JSON.stringify(lookPreview(choices({ renderMode, captionStyle, hookOverlay })).caption.image)
  )))));
  assert.equal(spots.size, 1);
});

test("unknown or retired values fall back like the stored choices do", () => {
  const look = lookPreview({ renderMode: "split", captionStyle: "neon", hookOverlay: "ya" });
  assert.equal(look.picture.mode, "fit");
  assert.equal(look.caption.pack, "karaoke");
  assert.ok(look.hook, "hook on by default");
  assert.deepEqual(lookPreview(undefined), lookPreview(DEFAULT_CHOICES));
});

test("the TikTok zone: the subtitle's bottom is inside it, the hook is clear of it", () => {
  const look = lookPreview(choices());
  assert.equal(look.captionInZone, true, "1062.4 px is below the zone's top edge at 1000 px");
  assert.equal(look.hookInZone, false, "166.4 px is below the zone's 93 px");
  assert.equal(lookPreview(choices({ hookOverlay: false })).hookInZone, false);
});

test("the note says where the subtitle sits, and that Edit klip changes it per clip only while the editor is on", () => {
  assert.equal(lookPreview(choices()).note, LOOK_NOTES.zone);
  assert.equal(lookPreview(choices(), { editor: true }).note, `${LOOK_NOTES.zone} ${LOOK_NOTES.editor}`);
  assert.equal(lookPreview(choices(), { editor: "on" }).note, LOOK_NOTES.zone, "only a real true turns the hint on");
  assert.equal(LOOK_NOTES.zone, "Subtitle ada di bawah, dekat area tombol TikTok.");
  assert.equal(LOOK_NOTES.editor, "Per klip bisa diubah lagi lewat Edit klip.");
  for (const text of Object.values(LOOK_NOTES)) {
    assert.doesNotMatch(text, /—|\bV[1-3]\b|baru|viral|Hot/);
  }
});

test("the preview's accessible name reads what it shows", () => {
  assert.equal(lookPreview(choices()).label, "Pratinjau klip 9:16: Utuh + latar blur, subtitle Karaoke di bawah, teks hook di atas.");
  assert.equal(
    lookPreview(choices({ renderMode: "center-crop", captionStyle: "classic", hookOverlay: false })).label,
    "Pratinjau klip 9:16: Crop tengah, subtitle Klasik di bawah, tanpa teks hook.",
  );
});

test("the preview's numbers are the engine's: render size, text spots, zone and thumbnail crop", () => {
  const ass = read("src", "ai_clipper", "captions_ass.py");
  assert.equal(Number(pythonConstant(ass, "_CAPTION_MARGIN_BOTTOM_RATIO")), AUTO_TEXT.captionBottom);
  assert.equal(Number(pythonConstant(ass, "_CAPTION_SIDE_MARGIN_RATIO")), AUTO_TEXT.side);
  assert.equal(Number(pythonConstant(ass, "_HOOK_MARGIN_TOP_RATIO")), AUTO_TEXT.hookTop);
  assert.equal(Number(pythonConstant(ass, "_HOOK_SIDE_MARGIN_RATIO")), AUTO_TEXT.side);
  assert.equal(Number(pythonConstant(ass, "_HOOK_BOX_PADDING_RATIO")), AUTO_TEXT.hookPadding);
  assert.equal(Number(/^\(([\d.]+),/.exec(pythonConstant(ass, "_HOOK_FONT_RATIOS"))[1]), AUTO_TEXT.hookFont);

  // The zone lives in the edit_v2 package (the plan and the text watermark's layout share it).
  const editV2 = read("src", "ai_clipper", "edit_v2", "__init__.py");
  assert.equal(pythonConstant(editV2, "UI_ZONE_720"), `(${TIKTOK_ZONE.top}, ${TIKTOK_ZONE.bottom}, ${TIKTOK_ZONE.right})`);
  const plan = read("src", "ai_clipper", "edit_v2", "plan.py");
  assert.match(plan, /^from \. import [^\n]*\bui_zone\b/m, "the plan uses the package's zone");
  assert.doesNotMatch(plan, /^UI_ZONE_720\s*=|^def ui_zone/m, "the plan has no zone of its own");
  // The editor's Zona aman is the shared zone (lib/output-frame.mjs, output-size.test.mjs).
  const stage = read("web", "components", "editor", "Stage.jsx");
  assert.match(stage, /^import \{ uiZone \} from "\.\.\/\.\.\/lib\/output-frame\.mjs";$/m, "the editor's Zona aman");
  assert.match(stage, /const \{ top, bottom, right \} = uiZone\(\{ w, h \}\);/);

  const seed = read("src", "ai_clipper", "edit_v2", "seed.py");
  assert.equal(pythonConstant(seed, "DEFAULT_RENDER_SIZE").split("#")[0].trim(), `(${PREVIEW_FRAME.w}, ${PREVIEW_FRAME.h})`);

  // The editor opens an automatic clip with its pack at the same spot (CONTRACTS §3.5).
  for (const pack of CAPTION_STYLES) {
    assert.equal(json("resources", "caption-packs", pack, "v1.json").defaults.y_e5, Math.round((1 - AUTO_TEXT.captionBottom) * 100_000), pack);
  }
  assert.equal(json("resources", "hook-designs", "legacy-bar", "v1.json").default_y_e5, Math.round(AUTO_TEXT.hookTop * 100_000));

  const thumbs = json("web", "components", "editor", "panels", "pack-thumbs", "manifest.json");
  assert.deepEqual(thumbs.crop, [THUMB_CROP.x, THUMB_CROP.y, THUMB_CROP.w, THUMB_CROP.h]);
  assert.equal(thumbs.size[0] / thumbs.size[1], THUMB_CROP.w / THUMB_CROP.h, "the thumbnail keeps the crop's shape");
  assert.equal(PREVIEW_BACKDROP.toLowerCase(), thumbs.background.toLowerCase(), "the thumbnails sit seamlessly on the frame");
});

test("the dashboard offers every caption pack the automatic render draws, each with a thumbnail and a pack", () => {
  const python = /^PACK_IDS = \(([^)]*)\)/m.exec(read("src", "ai_clipper", "edit_v2", "__init__.py"))[1];
  const engine = [...python.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  const offered = CAPTION_STYLE_CHOICES.map((choice) => choice.id);
  assert.deepEqual(offered, engine);
  assert.deepEqual(offered, CAPTION_STYLES);

  // The seed takes a job's caption style as its pack id (CONTRACTS §5.48).
  assert.equal(pythonConstant(read("src", "ai_clipper", "edit_v2", "seed.py"), "PACK_BY_CAPTION_STYLE").split("#")[0].trim(), "{pack: pack for pack in PACK_IDS}");
  const thumbs = json("web", "components", "editor", "panels", "pack-thumbs", "manifest.json");
  for (const style of offered) assert.ok(thumbs.packs[style], `${style} has a rendered thumbnail`);
});

test("the page shows the preview beside the styles: a thumbnail on every style, the note under them", () => {
  const page = read("web", "app", "dashboard", "page.jsx");
  assert.match(page, /const look = lookPreview\(choices, \{ editor: editorOn, engine: renderEngine \}\);/);
  assert.match(page, /<LookPreview look=\{look\} \/>/);
  assert.match(page, /setEditorOn\(payload\.editor === true\)/);
  assert.match(page, /src=\{imageSrc\(PACK_IMAGES\[style\.id\]\)\}/);
  assert.match(page, /<fieldset className=\{styles\.group\} aria-describedby=\{look\.note \? "caption-style-help" : undefined\}>/);
  assert.match(page, /\{look\.note && <p id="caption-style-help" className=\{styles\.help\}>\{look\.note\}<\/p>\}/);
  const preview = read("web", "app", "dashboard", "LookPreview.jsx");
  assert.match(preview, /role="img"/);
  assert.match(preview, /aria-label=\{look\.label\}/);
  assert.match(preview, /viewBox=\{`0 0 \$\{look\.frame\.w\} \$\{look\.frame\.h\}`\}/);
  assert.match(preview, /Area tombol TikTok/);
  assert.doesNotMatch(preview, /—/);
});
