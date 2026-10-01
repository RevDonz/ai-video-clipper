// Logo and watermark (plan §11.3 T3.2, §5.5, §3.3 logo item, §3.4 logo box, §5.9 G5): the gizmo's
// geometry (web/components/editor/gizmos/logo-geometry.mjs), the upload glue
// (gizmos/logo-upload.mjs) and the panel's view model (panels/logo-model.mjs). Every placement is
// checked against the real Appendix B commands, and the TikTok-zone rule against vectors written by
// the Python compiler (scripts/parity/logo_gates.py vectors).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CommandRejected, applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { logoBox } from "../lib/editor/timemap.mjs";
import { FAKE_JOB_ID, FakeApiError, fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  CORNERS,
  LOGO_WIDTH_E5,
  OPACITY_PM,
  anchorFor,
  boxOf,
  cornerOf,
  cornerTransform,
  guideLines,
  handleResize,
  insideFrame,
  logoOf,
  nudged,
  positionFor,
  resizeTo,
  safePlacement,
  snapDrag,
  transformSteps,
  uiZone,
  zoneHits,
} from "../components/editor/gizmos/logo-geometry.mjs";
import {
  LOGO_MAX_BYTES,
  LOGO_TYPES,
  assetThumbUrl,
  createLogoUploads,
  logoUploadError,
  logoUploader,
  provideLogoUploader,
} from "../components/editor/gizmos/logo-upload.mjs";
import { logoPanelView, opacityLabel, sizeLabel } from "../components/editor/panels/logo-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.join(here, "..", "components", "editor", "gizmos", "__dev__", "logo-zone-vectors.json");
const HEX = "5c1f".padEnd(64, "a");

function seedAt(output) {
  const seed = fakeDoc();
  seed.output = { ...seed.output, ...output };
  return seed;
}

function withLogo({ w = 512, h = 512, output = { w: 720, h: 1280 }, hex = HEX } = {}) {
  const seed = seedAt(output);
  const ctx = createContext({ words: fakeWords(), seed });
  const meta = { sha256: hex, kind: "logo", mime: "image/png", w, h, durationMs: null, lufsC: null, peaksUrl: null };
  const doc = applyCommand(seed, "SetLogo", { asset: `sha256:${hex}`, meta }, ctx).doc;
  return { doc, ctx, output: ctx.output };
}

function apply(doc, ctx, steps) {
  let current = doc;
  for (const step of steps) current = applyCommand(current, step.type, step.args, ctx).doc;
  return current;
}

function transformOf(doc) {
  return logoOf(doc).transform;
}

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Square, wide, tall, a hairline and a logo so tall that only the smallest width fits the frame.
const ASSETS = [[512, 512], [1000, 250], [200, 800], [1024, 7], [24, 1024], [640, 360]];

test("the logo of a document: its item, asset metadata and track index", () => {
  assert.equal(logoOf(fakeDoc()), null);
  const { doc } = withLogo();
  const logo = logoOf(doc);
  assert.equal(logo.item.type, "image");
  assert.deepEqual(logo.meta, { kind: "image", mime: "image/png", w: 512, h: 512 });
  assert.deepEqual(logo.transform, { x_e5: 79097, y_e5: 11758, w_e5: 16000, opacity_pm: 850 });
  assert.equal(doc.tracks[logo.index], doc.tracks.find((track) => track.kind === "visual"));
  assert.equal(logo.assetId, `sha256:${HEX}`);
});

test("the box is plan §3.4's integer box at the document's output size", () => {
  const { doc, output } = withLogo();
  const { transform, meta } = logoOf(doc);
  assert.deepEqual(boxOf(transform, meta, output), { x: 512, y: 93, w: 115, h: 115 });
  const [x, y, w, h] = logoBox({ ...transform, asset_w: 512, asset_h: 512, out_w: 1080, out_h: 1920 });
  assert.deepEqual(boxOf(transform, meta, { w: 1080, h: 1920 }), { x, y, w, h });
  assert.equal(insideFrame({ x: 0, y: 0, w: 720, h: 1280 }, output), true);
  assert.equal(insideFrame({ x: -1, y: 0, w: 10, h: 10 }, output), false);
  assert.equal(insideFrame({ x: 711, y: 0, w: 10, h: 10 }, output), false);
});

test("the TikTok UI zone is plan.ui_zone: 93/280/93 px at 720×1280, scaled at other sizes", () => {
  assert.deepEqual(uiZone({ w: 720, h: 1280 }), { top: 93, bottom: 280, right: 93 });
  assert.deepEqual(uiZone({ w: 1080, h: 1920 }), { top: 140, bottom: 420, right: 140 });
  const output = { w: 720, h: 1280 };
  assert.deepEqual(zoneHits({ x: 576, y: 32, w: 115, h: 115 }, output), { top: true, bottom: false, right: true, any: true });
  assert.deepEqual(zoneHits({ x: 512, y: 93, w: 115, h: 115 }, output), { top: false, bottom: false, right: false, any: false });
  assert.equal(zoneHits({ x: 512, y: 92, w: 115, h: 115 }, output).top, true);
  assert.equal(zoneHits({ x: 513, y: 93, w: 115, h: 115 }, output).right, true);
  assert.equal(zoneHits({ x: 0, y: 885, w: 115, h: 115 }, output).any, false);
  assert.equal(zoneHits({ x: 0, y: 886, w: 115, h: 115 }, output).bottom, true);
});

test("the zone rule and the box equal the Python compiler's on every vector (G5 parity)", () => {
  const lines = readFileSync(VECTORS, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const header = lines.shift();
  assert.equal(header.schema, "potongin.logo-zone-vectors/1");
  assert.deepEqual(header.fields, ["out_w", "out_h", "asset_w", "asset_h", "x_e5", "y_e5", "w_e5", "x", "y", "w", "h", "unsafe"]);
  assert.equal(lines.length, header.count);
  assert.ok(lines.length >= 2000, `${lines.length} vectors`);
  for (const [size, zone] of Object.entries(header.zones)) {
    const [w, h] = size.split("x").map(Number);
    assert.deepEqual(uiZone({ w, h }), { top: zone[0], bottom: zone[1], right: zone[2] });
  }
  let unsafe = 0;
  for (const vector of lines) {
    const [outW, outH, assetW, assetH, xE5, yE5, wE5, x, y, w, h, flag] = vector;
    const output = { w: outW, h: outH };
    const box = boxOf({ x_e5: xE5, y_e5: yE5, w_e5: wE5 }, { w: assetW, h: assetH }, output);
    assert.deepEqual(box, { x, y, w, h }, JSON.stringify(vector));
    assert.equal(zoneHits(box, output).any, flag === 1, JSON.stringify(vector));
    unsafe += flag;
  }
  assert.ok(unsafe > 100 && unsafe < lines.length - 100, `both outcomes are covered (${unsafe} unsafe)`);
});

test("a pixel position becomes centre e5 values that give back exactly that box", () => {
  const square = { w: 1, h: 1 };
  for (const output of [{ w: 720, h: 1280 }, { w: 1080, h: 1920 }]) {
    for (let wE5 = LOGO_WIDTH_E5.min; wE5 <= LOGO_WIDTH_E5.max; wE5 += 137) {
      const size = boxOf({ x_e5: 50000, y_e5: 50000, w_e5: wE5 }, square, output);
      for (let x = 0; x <= output.w - size.w; x += 1) {
        assert.equal(boxOf({ ...positionFor(x, 0, size, output), w_e5: wE5 }, square, output).x, x, `x ${x} w_e5 ${wE5}`);
      }
      for (let y = 0; y <= output.h - size.h; y += 3) {
        assert.equal(boxOf({ ...positionFor(0, y, size, output), w_e5: wE5 }, square, output).y, y, `y ${y} w_e5 ${wE5}`);
      }
    }
  }
  const { doc, output } = withLogo();
  const { meta } = logoOf(doc);
  for (let y = 0; y <= output.h - 115; y += 1) {
    const moved = positionFor(512, y, { w: 115, h: 115 }, output);
    assert.deepEqual(boxOf({ ...moved, w_e5: 16000 }, meta, output), { x: 512, y, w: 115, h: 115 });
  }
});

test("the corner presets equal SnapLogo (plan Appendix B) for every asset shape and size", () => {
  for (const output of [{ w: 720, h: 1280 }, { w: 1080, h: 1920 }]) {
    for (const [aw, ah] of ASSETS) {
      const { doc, ctx } = withLogo({ w: aw, h: ah, output });
      for (const wE5 of [4000, 9000, 16000, 27500, 40000]) {
        let sized;
        try {
          sized = apply(doc, ctx, [{ type: "MoveLogo", args: { x_e5: 50000, y_e5: 50000 } }, { type: "ResizeLogo", args: { w_e5: wE5 } }]);
        } catch (error) {
          if (error instanceof CommandRejected) continue; // a tall asset that cannot take this width
          throw error;
        }
        for (const corner of CORNERS) {
          const snapped = applyCommand(sized, "SnapLogo", { corner }, ctx).doc;
          const expected = transformOf(snapped);
          const { transform, meta } = logoOf(sized);
          assert.deepEqual(cornerTransform(transform, meta, ctx.output, corner), { x_e5: expected.x_e5, y_e5: expected.y_e5 },
            `${corner} ${aw}x${ah} w_e5 ${wE5} at ${output.w}`);
          assert.equal(cornerOf(expected, meta, ctx.output), corner);
        }
      }
    }
  }
  const { doc, ctx } = withLogo();
  const { meta } = logoOf(doc);
  const corner = transformOf(apply(doc, ctx, [{ type: "SnapLogo", args: { corner: "bottom_left" } }]));
  assert.equal(cornerOf({ ...corner, x_e5: corner.x_e5 + 200 }, meta, ctx.output), null);
});

test("every corner preset and a new logo's spot sit outside the TikTok zone whenever the logo fits beside it", () => {
  for (const output of [{ w: 720, h: 1280 }, { w: 1080, h: 1920 }]) {
    const zone = uiZone(output);
    const mx = Math.round((4 * output.w) / 100);
    for (const [aw, ah] of ASSETS) {
      const { doc, ctx } = withLogo({ w: aw, h: ah, output });
      const fresh = boxOf(transformOf(doc), logoOf(doc).meta, output);
      const freshFits = fresh.w <= output.w - zone.right && fresh.h <= output.h - zone.top - zone.bottom;
      if (freshFits) {
        assert.equal(zoneHits(fresh, output).any, false, `new ${aw}x${ah} at ${output.w}: ${JSON.stringify(fresh)}`);
        assert.equal(cornerOf(transformOf(doc), logoOf(doc).meta, output), "top_right", `new ${aw}x${ah}`);
      }
      for (const wE5 of [4000, 9000, 16000, 27500, 40000]) {
        let sized;
        try {
          sized = apply(doc, ctx, [{ type: "MoveLogo", args: { x_e5: 50000, y_e5: 50000 } }, { type: "ResizeLogo", args: { w_e5: wE5 } }]);
        } catch (error) {
          if (error instanceof CommandRejected) continue;
          throw error;
        }
        const { meta } = logoOf(sized);
        const size = boxOf(transformOf(sized), meta, output);
        const fits = mx + size.w <= output.w - zone.right && size.h <= output.h - zone.top - zone.bottom;
        for (const corner of CORNERS) {
          const box = boxOf(transformOf(apply(sized, ctx, [{ type: "SnapLogo", args: { corner } }])), meta, output);
          const label = `${corner} ${aw}x${ah} w_e5 ${wE5} at ${output.w}: ${JSON.stringify(box)}`;
          assert.ok(insideFrame(box, output), label);
          if (!fits) continue;
          assert.equal(zoneHits(box, output).any, false, label);
          if (corner.endsWith("left")) assert.equal(box.x, mx, label);
          else assert.equal(box.x + box.w, output.w - zone.right, label);
          if (corner.startsWith("top")) assert.equal(box.y, zone.top, label);
          else assert.equal(box.y + box.h, output.h - zone.bottom, label);
        }
      }
    }
  }
});

test("guides: the corner margins, the TikTok zone edges and the centre lines", () => {
  const output = { w: 720, h: 1280 };
  const guides = guideLines({ w: 115, h: 115 }, output);
  const at = (list, id) => list.find((guide) => guide.id === id)?.at;
  assert.equal(at(guides.x, "margin_left"), 29);
  assert.equal(at(guides.x, "margin_right"), 720 - 29 - 115);
  assert.equal(at(guides.x, "safe_right"), 720 - 93 - 115);
  assert.equal(at(guides.x, "center"), 303, "x_e5 50000: 302.5 rounded half up, as logoBox does");
  assert.equal(at(guides.y, "margin_top"), 32);
  assert.equal(at(guides.y, "margin_bottom"), 1280 - 32 - 115);
  assert.equal(at(guides.y, "safe_top"), 93);
  assert.equal(at(guides.y, "safe_bottom"), 1280 - 280 - 115);
  assert.equal(at(guides.y, "center"), 583);
  for (const guide of [...guides.x, ...guides.y]) assert.ok(["margin", "safe", "center"].includes(guide.kind));
  assert.equal(guides.x.find((guide) => guide.id === "safe_right").line, 627);
  assert.equal(guides.y.find((guide) => guide.id === "safe_bottom").line, 1000);
});

test("dragging snaps to a guide within the threshold, the magnet can be switched off, the frame clamps", () => {
  const output = { w: 720, h: 1280 };
  const size = { w: 115, h: 115 };
  let result = snapDrag({ x: 35.4, y: 26 }, size, output, { threshold: 10 });
  assert.deepEqual([result.x, result.y, result.snapX?.id, result.snapY?.id], [29, 32, "margin_left", "margin_top"]);
  result = snapDrag({ x: 518, y: 99.9 }, size, output, { threshold: 10 });
  assert.deepEqual([result.x, result.y, result.snapX?.id, result.snapY?.id], [512, 93, "safe_right", "safe_top"]);
  result = snapDrag({ x: 518, y: 99.9 }, size, output, { threshold: 10, magnet: false });
  assert.deepEqual([result.x, result.y, result.snapX, result.snapY], [518, 100, null, null]);
  result = snapDrag({ x: 250.2, y: 700 }, size, output, { threshold: 10 });
  assert.deepEqual([result.x, result.y, result.snapX, result.snapY], [250, 700, null, null]);
  result = snapDrag({ x: -80, y: 5000 }, size, output, { threshold: 10, magnet: false });
  assert.deepEqual([result.x, result.y], [0, 1280 - 115]);
  result = snapDrag({ x: 1e6, y: -1e6 }, size, output, { threshold: 10 });
  assert.deepEqual([result.x, result.y], [720 - 115, 0]);
  // The nearest guide wins when two are inside the threshold.
  result = snapDrag({ x: 300, y: 90 }, size, output, { threshold: 40 });
  assert.deepEqual([result.snapX?.id, result.snapY?.id], ["center", "safe_top"]);
});

test("a drag that snaps to the TikTok zone's top and right edges lands exactly on the corner preset", () => {
  const { doc, ctx } = withLogo();
  const { meta, transform } = logoOf(doc);
  const box = boxOf(transform, meta, ctx.output);
  const dropped = snapDrag({ x: box.x + 3, y: box.y - 4 }, box, ctx.output, { threshold: 10 });
  const moved = apply(doc, ctx, [{ type: "MoveLogo", args: positionFor(dropped.x, dropped.y, box, ctx.output) }]);
  const snapped = apply(doc, ctx, [{ type: "SnapLogo", args: { corner: "top_right" } }]);
  assert.deepEqual(transformOf(moved), transformOf(snapped));
});

test("keyboard nudges move 1 or 10 output pixels and stop at the frame", () => {
  const output = { w: 720, h: 1280 };
  assert.deepEqual(nudged({ x: 100, y: 100, w: 115, h: 115 }, output, 1, 0), { x: 101, y: 100 });
  assert.deepEqual(nudged({ x: 100, y: 100, w: 115, h: 115 }, output, 0, -10), { x: 100, y: 90 });
  assert.deepEqual(nudged({ x: 3, y: 100, w: 115, h: 115 }, output, -10, 0), { x: 0, y: 100 });
  assert.equal(nudged({ x: 0, y: 100, w: 115, h: 115 }, output, -1, 0), null);
  assert.equal(nudged({ x: 605, y: 1165, w: 115, h: 115 }, output, 10, 10), null);
  const { doc, ctx } = withLogo();
  const { meta } = logoOf(doc);
  let current = doc;
  for (let step = 0; step < 900; step += 1) {
    const box = boxOf(transformOf(current), meta, ctx.output);
    const next = nudged(box, ctx.output, step % 3 === 0 ? -10 : 1, 10);
    if (!next) continue;
    current = apply(current, ctx, [{ type: "MoveLogo", args: positionFor(next.x, next.y, box, ctx.output) }]);
    assert.deepEqual(boxOf(transformOf(current), meta, ctx.output), { ...box, x: next.x, y: next.y });
  }
});

test("'Geser ke area aman' finds the nearest box outside the TikTok zone", () => {
  const output = { w: 720, h: 1280 };
  assert.deepEqual(safePlacement({ x: 576, y: 32, w: 115, h: 115 }, output), { x: 512, y: 93 });
  assert.deepEqual(safePlacement({ x: 29, y: 1133, w: 115, h: 115 }, output), { x: 29, y: 885 });
  assert.equal(safePlacement({ x: 100, y: 400, w: 115, h: 115 }, output), null);
  assert.equal(safePlacement({ x: 0, y: 0, w: 288, h: 1100 }, output), null, "taller than the safe band");
  assert.equal(safePlacement({ x: 0, y: 200, w: 650, h: 100 }, output), null, "wider than the safe band");
});

test("resizing keeps the edge that rests on a guide, else the centre, and stays in the frame", () => {
  const { doc, ctx } = withLogo();
  const { meta } = logoOf(doc);
  const output = ctx.output;
  // At the top-right corner preset both edges rest on the TikTok zone's edges.
  const cornered = apply(doc, ctx, [{ type: "SnapLogo", args: { corner: "top_right" } }]);
  let box = boxOf(transformOf(cornered), meta, output);
  assert.deepEqual(anchorFor(box, output), { x: "right", y: "top" });
  let target = resizeTo(transformOf(cornered), meta, output, 30000, anchorFor(box, output));
  let next = boxOf(target, meta, output);
  assert.equal(next.w, 216);
  assert.equal(next.x + next.w, box.x + box.w);
  assert.equal(next.y, box.y);
  assert.equal(cornerOf(target, meta, output), "top_right");
  // On the TikTok zone's edges.
  const safe = apply(doc, ctx, [{ type: "MoveLogo", args: positionFor(512, 93, box, output) }]);
  box = boxOf(transformOf(safe), meta, output);
  assert.deepEqual(anchorFor(box, output), { x: "right", y: "top" });
  // Free placement keeps the centre exactly.
  const free = apply(doc, ctx, [{ type: "MoveLogo", args: positionFor(300, 600, box, output) }]);
  box = boxOf(transformOf(free), meta, output);
  assert.deepEqual(anchorFor(box, output), { x: "center", y: "center" });
  target = resizeTo(transformOf(free), meta, output, 9000, anchorFor(box, output));
  assert.equal(target.x_e5, transformOf(free).x_e5);
  assert.equal(target.y_e5, transformOf(free).y_e5);
  // Near the left edge, growing around the centre is clamped into the frame.
  const edge = apply(doc, ctx, [{ type: "MoveLogo", args: positionFor(5, 600, box, output) }]);
  target = resizeTo(transformOf(edge), meta, output, 40000, { x: "center", y: "center" });
  next = boxOf(target, meta, output);
  assert.equal(next.x, 0);
  assert.ok(insideFrame(next, output));
  // Outside the range.
  assert.equal(resizeTo(transformOf(edge), meta, output, 3000, { x: "center", y: "center" }).w_e5, LOGO_WIDTH_E5.min);
  assert.equal(resizeTo(transformOf(edge), meta, output, 90000, { x: "center", y: "center" }).w_e5, LOGO_WIDTH_E5.max);
  assert.deepEqual(OPACITY_PM, { min: 200, max: 1000 });
});

test("a corner handle resizes with the aspect locked and the opposite corner fixed", () => {
  for (const [aw, ah] of ASSETS) {
    const { doc, ctx } = withLogo({ w: aw, h: ah });
    let current = apply(doc, ctx, [{ type: "MoveLogo", args: { x_e5: 50000, y_e5: 50000 } }]);
    const { meta } = logoOf(current);
    const start = boxOf(transformOf(current), meta, ctx.output);
    const target = handleResize(start, meta, ctx.output, "bottom_right", { x: start.x + start.w * 1.5, y: start.y + start.h * 1.5 });
    if (!target) continue;
    const box = boxOf(target, meta, ctx.output);
    assert.equal(box.x, start.x, `${aw}x${ah}`);
    assert.equal(box.y, start.y, `${aw}x${ah}`);
    assert.equal(box.h, Math.floor((2 * box.w * ah + aw) / (2 * aw)), "height follows the asset's aspect");
    assert.ok(box.w >= start.w);
    const steps = transformSteps(transformOf(current), meta, ctx.output, target);
    current = apply(current, ctx, steps);
    assert.deepEqual(transformOf(current), { ...transformOf(current), ...target });
    // The top-left handle keeps the bottom-right corner.
    const second = boxOf(transformOf(current), meta, ctx.output);
    const shrink = handleResize(second, meta, ctx.output, "top_left", { x: second.x + second.w * 0.4, y: second.y + second.h * 0.4 });
    if (!shrink) continue;
    const small = boxOf(shrink, meta, ctx.output);
    assert.equal(small.x + small.w, second.x + second.w, `${aw}x${ah}`);
    assert.equal(small.y + small.h, second.y + second.h, `${aw}x${ah}`);
  }
  // The width stays inside plan §3.3's range and the box inside the frame.
  const { doc, ctx } = withLogo();
  const { meta } = logoOf(doc);
  const start = boxOf(transformOf(doc), meta, ctx.output);
  const huge = handleResize(start, meta, ctx.output, "bottom_left", { x: -5000, y: 5000 });
  assert.ok(huge.w_e5 <= LOGO_WIDTH_E5.max);
  assert.ok(insideFrame(boxOf(huge, meta, ctx.output), ctx.output));
  const tiny = handleResize(start, meta, ctx.output, "bottom_left", { x: start.x + start.w, y: start.y });
  assert.equal(tiny.w_e5, LOGO_WIDTH_E5.min);
});

test("transform steps never leave the frame in between: 3,000 random resizes and moves through the real commands", () => {
  const random = rng(20260930);
  let applied = 0;
  for (let round = 0; round < 3000; round += 1) {
    const [aw, ah] = ASSETS[Math.floor(random() * ASSETS.length)];
    const output = random() < 0.8 ? { w: 720, h: 1280 } : { w: 1080, h: 1920 };
    const { doc, ctx } = withLogo({ w: aw, h: ah, output });
    const { meta } = logoOf(doc);
    const box = boxOf(transformOf(doc), meta, ctx.output);
    const position = snapDrag({ x: random() * output.w, y: random() * output.h }, box, ctx.output, { threshold: 0, magnet: false });
    let start;
    try {
      start = apply(doc, ctx, [{ type: "MoveLogo", args: positionFor(position.x, position.y, box, ctx.output) }]);
    } catch (error) {
      assert.ok(error instanceof CommandRejected);
      continue;
    }
    const startBox = boxOf(transformOf(start), meta, ctx.output);
    const pick = random();
    const target = pick < 0.5
      ? resizeTo(transformOf(start), meta, ctx.output, LOGO_WIDTH_E5.min + Math.floor(random() * 36001), anchorFor(startBox, ctx.output))
      : handleResize(startBox, meta, ctx.output, CORNERS[Math.floor(random() * 4)],
        { x: random() * output.w * 1.2 - output.w * 0.1, y: random() * output.h * 1.2 - output.h * 0.1 });
    if (!target) continue;
    assert.ok(insideFrame(boxOf(target, meta, ctx.output), ctx.output));
    const steps = transformSteps(transformOf(start), meta, ctx.output, target);
    assert.ok(Array.isArray(steps), "a valid target always has an order");
    const end = apply(start, ctx, steps);
    const { opacity_pm: _opacity, ...result } = transformOf(end);
    assert.deepEqual(result, target);
    applied += 1;
  }
  assert.ok(applied > 2000, `${applied} applied`);
});

test("upload errors become the logo panel's messages; a cancel is not an error", () => {
  const uploadError = (status, code, extra = {}) => Object.assign(new Error(extra.message ?? "Unggahan gagal"), { name: "UploadError", status, code, ...extra });
  assert.match(logoUploadError(uploadError(415, "asset_type_unsupported")).message, /PNG, JPEG, atau WebP/);
  assert.match(logoUploadError(new FakeApiError(415, "asset_type_unsupported")).message, /PNG, JPEG, atau WebP/);
  assert.match(logoUploadError(uploadError(413, "asset_too_large")).message, /10 MB/);
  assert.match(logoUploadError(new FakeApiError(413, "asset_too_large")).message, /10 MB/);
  assert.match(logoUploadError(uploadError(422, "asset_rejected", { reason: "dimensions", message: "Gambar terlalu besar (maksimal 4096 × 4096 piksel)" })).message, /4096/);
  assert.match(logoUploadError(uploadError(422, "asset_rejected")).message, /tidak bisa dibaca/);
  assert.match(logoUploadError(uploadError(0, "network_error")).message, /Koneksi/);
  assert.match(logoUploadError(new TypeError("Failed to fetch")).message, /Koneksi/);
  assert.match(logoUploadError(uploadError(404, "uploads_disabled")).message, /belum diaktifkan/);
  assert.match(logoUploadError(uploadError(429, "rate_limited", { message: "Terlalu banyak unggahan; tunggu sebentar lalu coba lagi" })).message, /Terlalu banyak/);
  assert.equal(logoUploadError(uploadError(418, "teapot", { message: "Pesan dari server" })).message, "Pesan dari server");
  assert.equal(logoUploadError(new FakeApiError(500, "boom")).message, "Logo gagal diunggah. Coba lagi.");
  const abort = new DOMException("Unggahan dibatalkan", "AbortError");
  assert.deepEqual(logoUploadError(abort), { code: "cancelled", cancelled: true, message: "Unggahan dibatalkan." });
  const codes = ["asset_type_unsupported", "asset_too_large", "asset_empty", "asset_rejected", "asset_quota_exceeded",
    "uploads_disabled", "editor_disabled", "network_error", "unknown"];
  for (const code of codes) {
    const { message } = logoUploadError(uploadError(400, code, { message: "x" }));
    assert.doesNotMatch(message, /—|\bV[123]\b|Editor V|mesin (lama|baru)/, code);
  }
  assert.deepEqual(LOGO_TYPES, ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(LOGO_MAX_BYTES, 10 * 1024 * 1024);
});

test("an upload outlives the panel: progress, the result, a cancel and a replaced upload", async () => {
  const uploads = createLogoUploads();
  const seen = [];
  const stop = uploads.subscribe(() => seen.push(uploads.getState()));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const upload = async (jobId, file, kind, { onProgress, signal }) => {
    calls.push({ jobId, name: file.name, kind });
    onProgress(0.5, { phase: "upload" });
    onProgress(1, { phase: "processing" });
    await Promise.race([gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))))]);
    return { sha256: HEX, kind: "logo", mime: "image/png", w: 10, h: 10, name: "k.png" };
  };
  const done = [];
  const owner = `${FAKE_JOB_ID}/clip_a`;
  const running = uploads.start({ owner, upload, jobId: FAKE_JOB_ID, file: { name: "k.png" }, onUploaded: (dto) => done.push(dto.sha256) });
  assert.deepEqual(uploads.getState().progress, { owner, name: "k.png", fraction: 1, phase: "processing" });
  assert.ok(seen.some((state) => state.progress?.fraction === 0.5));
  release();
  await running;
  assert.deepEqual(done, [HEX]);
  assert.equal(uploads.getState().progress, null);
  assert.equal(uploads.getState().names[`sha256:${HEX}`], "k.png");
  // A cancel leaves an information message, never an error, and nothing is applied.
  const never = new Promise(() => {});
  const slow = async (jobId, file, kind, { signal }) => {
    await Promise.race([never, new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError"))))]);
  };
  const cancelled = uploads.start({ owner, upload: slow, jobId: FAKE_JOB_ID, file: { name: "b.png" }, onUploaded: () => done.push("no") });
  uploads.cancel();
  await cancelled;
  assert.deepEqual(uploads.getState().message, { owner, tone: "info", text: "Unggahan dibatalkan." });
  // A second upload replaces the first; only the second one lands.
  const first = uploads.start({ owner, upload: slow, jobId: FAKE_JOB_ID, file: { name: "1.png" }, onUploaded: () => done.push("first") });
  const second = uploads.start({ owner, upload: async () => ({ sha256: HEX, kind: "logo", mime: "image/png", w: 1, h: 1 }),
    jobId: FAKE_JOB_ID, file: { name: "2.png" }, onUploaded: () => done.push("second") });
  await Promise.all([first, second]);
  assert.deepEqual(done, [HEX, "second"]);
  assert.equal(uploads.getState().message, null);
  // An error keeps its message for the clip that started the upload.
  await uploads.start({ owner, upload: async () => { throw new FakeApiError(415, "asset_type_unsupported"); }, jobId: FAKE_JOB_ID,
    file: { name: "x.gif" }, onUploaded: () => done.push("no") });
  assert.equal(uploads.getState().message.tone, "error");
  assert.equal(uploads.getState().message.owner, owner);
  uploads.clearMessage();
  assert.equal(uploads.getState().message, null);
  stop();
  assert.equal(calls.length, 1);
});

test("the upload client comes from the panel's prop, else from the registered one", () => {
  assert.equal(logoUploader(), null);
  const upload = async () => ({});
  const unregister = provideLogoUploader(upload);
  assert.equal(logoUploader(), upload);
  unregister();
  assert.equal(logoUploader(), null);
  assert.throws(() => provideLogoUploader("nope"), TypeError);
});

test("the stored asset's URL (the T3.1 route) is built only from a job id and an asset sha", () => {
  assert.equal(assetThumbUrl(FAKE_JOB_ID, `sha256:${HEX}`), `/api/jobs/${FAKE_JOB_ID}/assets/${HEX}`);
  assert.equal(assetThumbUrl(FAKE_JOB_ID, HEX), `/api/jobs/${FAKE_JOB_ID}/assets/${HEX}`);
  assert.equal(assetThumbUrl("../etc", HEX), null);
  assert.equal(assetThumbUrl(FAKE_JOB_ID, "sha256:../../x"), null);
});

test("the panel's view: the logo, its box, the preset it sits on and the server's G5 warning", () => {
  assert.equal(logoPanelView({ status: "loading" }).status, "loading");
  const empty = logoPanelView({ status: "ready", doc: fakeDoc(), plan: fakePlan(), jobId: FAKE_JOB_ID });
  assert.deepEqual([empty.status, empty.logo], ["ready", null]);
  const fresh = withLogo();
  assert.equal(logoPanelView({ status: "ready", doc: fresh.doc, plan: fakePlan(fresh.doc), jobId: FAKE_JOB_ID }).logo.corner, "top_right");
  // Dragged into the zone's top-right corner (the box of the server's plan).
  const doc = apply(fresh.doc, fresh.ctx, [{ type: "MoveLogo", args: { x_e5: 88000, y_e5: 7000 } }]);
  const plan = { ...fakePlan(doc), logo: { box: { x: 576, y: 32, w: 115, h: 115 }, opacityPm: 850, state: "ready" },
    warnings: [{ code: "unsafe_zone", path: "/tracks/1/items/0/transform", ref: logoOf(doc).item.id },
      { code: "unsafe_zone", path: "/tracks/0/items/0/transform/y_e5", ref: "it_hook" }] };
  const view = logoPanelView({ status: "ready", doc, plan, jobId: FAKE_JOB_ID });
  assert.equal(view.logo.assetId, `sha256:${HEX}`);
  assert.deepEqual(view.logo.box, { x: 576, y: 32, w: 115, h: 115 });
  assert.equal(view.logo.corner, null, "the frame corner is not a preset any more");
  assert.equal(view.logo.unsafe, true, "the plan's unsafe_zone for the logo item");
  assert.deepEqual(view.logo.safeTarget, { x: 512, y: 93 });
  assert.equal(view.logo.thumbUrl, `/api/jobs/${FAKE_JOB_ID}/assets/${HEX}`);
  const hookOnly = logoPanelView({ status: "ready", doc, plan: { ...plan, warnings: [plan.warnings[1]] }, jobId: FAKE_JOB_ID });
  assert.equal(hookOnly.logo.unsafe, false, "the hook's warning is not the logo's");
  assert.equal(logoPanelView({ status: "readOnly", doc, plan, jobId: FAKE_JOB_ID }).readOnly, true);
  assert.equal(sizeLabel(16000, { w: 115 }), "16% lebar video · 115 px");
  assert.equal(sizeLabel(4050, { w: 29 }), "4,1% lebar video · 29 px");
  assert.equal(opacityLabel(850), "85%");
  assert.equal(opacityLabel(205), "20,5%");
});
