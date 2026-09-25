// Logo layer (plan §5.5, §6.2): the derived PNG (exact pixel box, opacity baked in) is drawn 1:1
// at (x0, y0): no scaling, no globalAlpha. A bitmap whose size is not the box is refused.
import assert from "node:assert/strict";
import test from "node:test";

import { createLogoLayer } from "../lib/editor/player/logo-layer.mjs";

function layer({ size = [115, 58] } = {}) {
  const fetches = [];
  const decodes = [];
  const closed = [];
  const logo = createLogoLayer({
    fetchImpl: async (url) => { fetches.push(url); return { ok: true, status: 200, blob: async () => ({ url }) }; },
    decode: async (blob, options) => {
      decodes.push([blob.url, options]);
      return { width: size[0], height: size[1], url: blob.url, close() { closed.push(blob.url); } };
    },
  });
  return { logo, fetches, decodes, closed };
}

const DTO = { box: { x: 560, y: 61, w: 115, h: 58 }, opacityPm: 850, url: "/media/derived/abc@115x58.png" };

function fakeContext() {
  const calls = [];
  return { calls, globalAlpha: 1, globalCompositeOperation: "source-over",
    drawImage(...args) { calls.push({ args, alpha: this.globalAlpha, op: this.globalCompositeOperation }); } };
}

test("the derived PNG is decoded without colour conversion and drawn 1:1 at the box origin", async () => {
  const { logo, fetches, decodes } = layer();
  assert.equal(logo.readyFor(DTO), false);
  await logo.load(DTO);
  assert.equal(logo.readyFor(DTO), true);
  assert.deepEqual(fetches, [DTO.url]);
  assert.deepEqual(decodes[0][1], { colorSpaceConversion: "none", premultiplyAlpha: "default" });
  const ctx = fakeContext();
  logo.draw(ctx);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(ctx.calls[0].args.slice(1), [560, 61]);
  assert.equal(ctx.calls[0].args.length, 3, "drawImage(bitmap, x, y): never scaled");
  assert.equal(ctx.calls[0].alpha, 1);
  assert.equal(ctx.calls[0].op, "source-over");
});

test("no logo in the plan draws nothing and is always ready", async () => {
  const { logo } = layer();
  await logo.load(null);
  assert.equal(logo.readyFor(null), true);
  const ctx = fakeContext();
  logo.draw(ctx);
  assert.equal(ctx.calls.length, 0);
});

test("a bitmap that is not exactly the box is refused", async () => {
  const { logo, closed } = layer({ size: [116, 58] });
  await assert.rejects(logo.load(DTO), /logo_size_mismatch/);
  assert.equal(logo.readyFor(DTO), false);
  assert.deepEqual(closed, [DTO.url]);
});

test("the same URL is not fetched again; a new one replaces and closes the old bitmap", async () => {
  const { logo, fetches, closed } = layer();
  await logo.load(DTO);
  await logo.load({ ...DTO });
  assert.equal(fetches.length, 1);
  const moved = { box: { x: 10, y: 20, w: 115, h: 58 }, opacityPm: 850, url: "/media/derived/abc@115x58.png" };
  await logo.load(moved);
  assert.equal(fetches.length, 1, "same bytes, new position: no fetch");
  const ctx = fakeContext();
  logo.draw(ctx);
  assert.deepEqual(ctx.calls[0].args.slice(1), [10, 20]);
  await logo.load({ box: { x: 0, y: 0, w: 115, h: 58 }, opacityPm: 500, url: "/media/derived/abc-2@115x58.png" });
  assert.deepEqual(closed, ["/media/derived/abc@115x58.png"]);
  await logo.load(null);
  assert.deepEqual(closed, ["/media/derived/abc@115x58.png", "/media/derived/abc-2@115x58.png"]);
});

test("a failed fetch leaves the layer not ready", async () => {
  const logo = createLogoLayer({ fetchImpl: async () => ({ ok: false, status: 404 }), decode: async () => ({}) });
  await assert.rejects(logo.load(DTO), /logo_fetch_failed/);
  assert.equal(logo.readyFor(DTO), false);
});
