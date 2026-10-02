// The cold-open transition in the player (spec 2026-10-02 §5.2): the plan DTO's joins become a
// full-frame colour fill per output frame, drawn over the plate frame with globalAlpha = a/1000.
import assert from "node:assert/strict";
import test from "node:test";

import { drawOverlay, joinOverlays, joinsValid, overlayAt } from "../lib/editor/player/join-layer.mjs";

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

function recordingContext() {
  const calls = [];
  const ctx = {
    calls,
    globalAlpha: 1,
    globalCompositeOperation: "copy",
    fillStyle: "#000000",
    save() { calls.push(["save"]); },
    restore() { calls.push(["restore"]); },
    fillRect(x, y, w, h) {
      calls.push(["fillRect", x, y, w, h, { alpha: ctx.globalAlpha, op: ctx.globalCompositeOperation, fill: ctx.fillStyle }]);
    },
  };
  return ctx;
}

test("drawOverlay fills the whole canvas at a/1000 between save and restore", () => {
  const ctx = recordingContext();
  drawOverlay(ctx, overlayAt(joinOverlays([FLASH]), 58), 720, 1280);
  assert.deepEqual(ctx.calls, [
    ["save"],
    ["fillRect", 0, 0, 720, 1280, { alpha: 0.333, op: "source-over", fill: "rgb(255, 255, 255)" }],
    ["restore"],
  ]);
  const peak = recordingContext();
  drawOverlay(peak, overlayAt(joinOverlays([FLASH]), 60), 720, 1280);
  assert.equal(peak.calls[1][5].alpha, 1);
  const dip = recordingContext();
  drawOverlay(dip, overlayAt(joinOverlays([DIP]), 57), 1080, 1920);
  assert.deepEqual(dip.calls[1], ["fillRect", 0, 0, 1080, 1920, { alpha: 0.333, op: "source-over", fill: "rgb(0, 0, 0)" }]);
});

test("drawOverlay without an overlay touches nothing", () => {
  const ctx = recordingContext();
  drawOverlay(ctx, null, 720, 1280);
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
