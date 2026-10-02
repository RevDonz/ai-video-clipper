// The cold-open transition in the player (spec 2026-10-02 §5.2): the plan DTO's joins become a
// full-frame blend toward a colour per output frame, applied to the plate frame with the export's
// lutrgb arithmetic (§2.3), so the canvas equals the server composite before the text.
import assert from "node:assert/strict";
import test from "node:test";

import {
  blendPixels,
  blendTable,
  drawOverlay,
  joinOverlays,
  joinsValid,
  overlayAt,
} from "../lib/editor/player/join-layer.mjs";

// The §1.6 example: 30000/1001, J = 60, flash_white with the whoosh.
const FLASH = {
  after: "seg_co", style: "flash_white", atF: 60, rgb: [255, 255, 255],
  alphaPm: [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
  sfx: { id: "whoosh", v: 1, startSmp: 84576, hitSmp: 96096, samples: 20160 },
};
const DIP = {
  after: "seg_co", style: "dip_black", atF: 60, rgb: [0, 0, 0],
  alphaPm: [[56, 111], [57, 333], [58, 556], [59, 778], [60, 1000], [61, 778], [62, 556], [63, 333], [64, 111]],
  sfx: null,
};
const CUT = { after: "seg_co", style: "cut", atF: 60, rgb: null, alphaPm: [], sfx: null };

test("the overlays of the §1.6 example cover exactly its alpha frames", () => {
  const overlays = joinOverlays([FLASH]);
  assert.deepEqual([...overlays.keys()], [58, 59, 60, 61, 62]);
  assert.deepEqual(overlayAt(overlays, 58), { rgb: [255, 255, 255], alphaPm: 333 });
  assert.deepEqual(overlayAt(overlays, 60), { rgb: [255, 255, 255], alphaPm: 1000 });
  assert.deepEqual(overlayAt(overlays, 62), { rgb: [255, 255, 255], alphaPm: 333 });
  for (const n of [0, 57, 63, 299]) assert.equal(overlayAt(overlays, n), null, `frame ${n}`);
});

test("a cut join, an empty list and missing joins give no overlay", () => {
  for (const joins of [[CUT], [], undefined]) {
    const overlays = joinOverlays(joins);
    assert.equal(overlays.size, 0);
    assert.equal(overlayAt(overlays, 60), null);
  }
});

test("the dip uses its own colour and alphas", () => {
  const overlays = joinOverlays([DIP]);
  assert.equal(overlays.size, 9);
  assert.deepEqual(overlayAt(overlays, 56), { rgb: [0, 0, 0], alphaPm: 111 });
  assert.deepEqual(overlayAt(overlays, 60), { rgb: [0, 0, 0], alphaPm: 1000 });
});

test("overlays are frozen copies: a later change to the DTO does not move the fill", () => {
  const dto = structuredClone(FLASH);
  const overlays = joinOverlays([dto]);
  dto.rgb[0] = 0;
  dto.alphaPm[2][1] = 1;
  assert.deepEqual(overlayAt(overlays, 60), { rgb: [255, 255, 255], alphaPm: 1000 });
  assert.ok(Object.isFrozen(overlayAt(overlays, 60)));
  assert.ok(Object.isFrozen(overlayAt(overlays, 60).rgb));
});

// §2.3, the export's lutrgb: out = ⌊(p·(1000 − a) + C·a + 500) / 1000⌋.
const lutrgb = (p, colour, a) => Math.floor((p * (1000 - a) + colour * a + 500) / 1000);

// The §2.2 alphas of every supported rate, both styles.
const TABLE_ALPHAS = [111, 110, 166, 167, 200, 333, 444, 467, 555, 556, 583, 600, 666, 667, 722, 733, 778, 1000];

test("the blend table is the export's lutrgb for every level and every table alpha", () => {
  for (const colour of [0, 255]) {
    for (const a of TABLE_ALPHAS) {
      const table = blendTable(colour, a);
      for (let p = 0; p < 256; p += 1) assert.equal(table[p], lutrgb(p, colour, a), `C ${colour}, a ${a}, p ${p}`);
    }
  }
  assert.deepEqual([...blendTable(255, 1000)], new Array(256).fill(255));
  assert.deepEqual([...blendTable(0, 1000)], new Array(256).fill(0));
});

test("blendPixels blends R, G and B toward the colour and leaves alpha alone", () => {
  const rgba = Uint8ClampedArray.from([0, 100, 200, 255, 16, 128, 235, 7]);
  blendPixels(rgba, { rgb: [255, 255, 255], alphaPm: 333 });
  assert.deepEqual([...rgba], [
    lutrgb(0, 255, 333), lutrgb(100, 255, 333), lutrgb(200, 255, 333), 255,
    lutrgb(16, 255, 333), lutrgb(128, 255, 333), lutrgb(235, 255, 333), 7,
  ]);
  const dark = Uint8ClampedArray.from([16, 17, 235, 255]);
  blendPixels(dark, { rgb: [0, 0, 0], alphaPm: 733 });
  assert.deepEqual([...dark], [4, 5, 63, 255]);
});

function pixelContext(width, height, level) {
  const calls = [];
  const data = new Uint8ClampedArray(width * height * 4).map((_, i) => (i % 4 === 3 ? 255 : level));
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    getImageData(x, y, w, h) { calls.push(["getImageData", x, y, w, h]); return { data, width: w, height: h }; },
    putImageData(image, x, y) { calls.push(["putImageData", x, y, [...image.data.slice(0, 4)]]); },
    fillRect() { calls.push(["fillRect"]); },
  };
  return ctx;
}

test("drawOverlay blends the whole canvas with the export's arithmetic, in place", () => {
  const ctx = pixelContext(4, 2, 100);
  drawOverlay(ctx, overlayAt(joinOverlays([FLASH]), 58), 4, 2);
  const flash = lutrgb(100, 255, 333);
  assert.deepEqual(ctx.calls, [["getImageData", 0, 0, 4, 2], ["putImageData", 0, 0, [flash, flash, flash, 255]]]);
  assert.equal(flash, 152);
  const peak = pixelContext(4, 2, 100);
  drawOverlay(peak, overlayAt(joinOverlays([FLASH]), 60), 4, 2);
  assert.deepEqual(peak.calls[1][3], [255, 255, 255, 255]);
  const dip = pixelContext(3, 3, 16);
  drawOverlay(dip, overlayAt(joinOverlays([DIP]), 58), 3, 3);
  assert.deepEqual(dip.calls[1][3], [7, 7, 7, 255]);
  assert.equal(lutrgb(16, 0, 556), 7);
  for (const context of [ctx, peak, dip]) {
    assert.equal(context.globalAlpha, 1);
    assert.equal(context.globalCompositeOperation, "source-over");
  }
});

test("drawOverlay without an overlay touches nothing", () => {
  const ctx = pixelContext(2, 2, 50);
  drawOverlay(ctx, null, 2, 2);
  assert.deepEqual(ctx.calls, []);
});

test("joinsValid accepts the DTO shapes and refuses malformed joins", () => {
  const total = 300;
  assert.equal(joinsValid(undefined, total), true);
  assert.equal(joinsValid([], total), true);
  assert.equal(joinsValid([FLASH], total), true);
  assert.equal(joinsValid([DIP], total), true);
  assert.equal(joinsValid([CUT], total), true);
  assert.equal(joinsValid([{ ...CUT, atF: total }], total), true);
  const { sfx: _sfx, ...noSfx } = FLASH;
  assert.equal(joinsValid([noSfx], total), true, "sfx is informational: absent reads as null");
  const bad = {
    "null joins": null,
    "not an array": { 0: FLASH },
    "an entry that is not an object": [null],
    "an unknown style": [{ ...FLASH, style: "fade" }],
    "xfade": [{ ...FLASH, style: "xfade" }],
    "atF past the end": [{ ...FLASH, atF: total + 1 }],
    "atF negative": [{ ...FLASH, atF: -1 }],
    "atF not an integer": [{ ...FLASH, atF: 60.5 }],
    "rgb of two values": [{ ...FLASH, rgb: [255, 255] }],
    "rgb above 255": [{ ...FLASH, rgb: [256, 255, 255] }],
    "rgb not integers": [{ ...FLASH, rgb: [255, 254.5, 255] }],
    "rgb on a cut": [{ ...CUT, rgb: [255, 255, 255], alphaPm: [[60, 1000]] }],
    "no rgb on a flash": [{ ...FLASH, rgb: null, alphaPm: [] }],
    "alphas on a cut": [{ ...CUT, alphaPm: [[60, 1000]] }],
    "rgb with alphas missing": [{ ...FLASH, alphaPm: [] }],
    "alphaPm missing": [{ ...FLASH, alphaPm: undefined }],
    "unsorted frames": [{ ...FLASH, alphaPm: [[59, 666], [58, 333], [60, 1000]] }],
    "a repeated frame": [{ ...FLASH, alphaPm: [[58, 333], [58, 666]] }],
    "alpha 0": [{ ...FLASH, alphaPm: [[58, 0], [60, 1000]] }],
    "alpha 1001": [{ ...FLASH, alphaPm: [[58, 333], [60, 1001]] }],
    "a frame at totalFrames": [{ ...FLASH, alphaPm: [[299, 1000], [300, 500]] }],
    "a negative frame": [{ ...FLASH, alphaPm: [[-1, 333], [0, 1000]] }],
    "a pair of three": [{ ...FLASH, alphaPm: [[58, 333, 1]] }],
    "sfx a string": [{ ...FLASH, sfx: "whoosh" }],
    "sfx an array": [{ ...FLASH, sfx: [] }],
    "a frame claimed by two joins": [FLASH, { ...DIP, after: "seg_x" }],
  };
  for (const [name, joins] of Object.entries(bad)) assert.equal(joinsValid(joins, total), false, name);
});
