// The parity harness for the player (plan §10.1 P-FRAME in the browser): the barcode frame
// index and the column ruler read back from a canvas (a port of tests/support/edit_v2_media.py
// decode_index / decode_ruler / decode_crop_x), and the fixtures route serving the player media.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SESSION_COOKIE, createSessionToken } from "../lib/auth.mjs";
import { GET } from "../app/api/parity-fixtures/[...path]/route.js";
import {
  INDEX_BANDS,
  decodeCropX,
  decodeIndex,
  decodeRuler,
  grayDecode,
  pattern,
  renderLuma,
} from "../app/parity-harness/player/barcode.mjs";

test("the band geometry follows edit_v2_media.Pattern.for_size", () => {
  assert.deepEqual(pattern(640, 360), { width: 640, height: 360, bandH: 4, rulerBits: 10 });
  assert.deepEqual(pattern(1280, 720), { width: 1280, height: 720, bandH: 10, rulerBits: 11 });
  assert.equal(INDEX_BANDS, 27);
  assert.equal(grayDecode(0b1101), 9);
});

function scaled(plane, src, { width, height, scale, top, cropX = 0 }) {
  // Nearest-neighbour placement (pixel centres, as FFmpeg's scale maps them) of the source at
  // (scale, top), columns shifted by cropX.
  const out = new Uint8Array(width * height).fill(128);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.floor((y - top + 0.5) / scale);
    if (sy < 0 || sy >= src.height) continue;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.floor((x + cropX + 0.5) / scale);
      if (sx >= 0 && sx < src.width) out[y * width + x] = plane[sy * src.width + sx];
    }
  }
  return out;
}

test("frame indices are read back from fit_blur and crop geometries", () => {
  const src = pattern(640, 360);
  for (const index of [0, 1, 2, 359, 1000, 4095, 65_535, 1_000_001]) {
    const plane = renderLuma(src, index);
    assert.equal(decodeIndex(plane, 640, 360, src), index);
    const fitTop = (1280 - 360 * (720 / 640)) / 2;
    const fit = scaled(plane, src, { width: 720, height: 1280, scale: 720 / 640, top: fitTop });
    assert.equal(decodeIndex(fit, 720, 1280, src, { scale: 720 / 640, top: fitTop }), index);
    const crop = scaled(plane, src, { width: 720, height: 1280, scale: 2276 / 640, top: 0, cropX: 777 });
    assert.equal(decodeIndex(crop, 720, 1280, src, { scale: 2276 / 640, top: 0 }), index);
  }
});

test("a broken parity bit or missing sync reads as null", () => {
  const src = pattern(640, 360);
  const plane = renderLuma(src, 12345);
  const flipped = Uint8Array.from(plane);
  const row = (INDEX_BANDS - 1) * src.bandH;
  for (let y = row; y < row + src.bandH; y += 1) {
    for (let x = 0; x < 640; x += 1) flipped[y * 640 + x] = flipped[y * 640 + x] > 128 ? 16 : 235;
  }
  assert.equal(decodeIndex(flipped, 640, 360, src), null);
  assert.equal(decodeIndex(new Uint8Array(640 * 360).fill(128), 640, 360, src), null);
});

test("the ruler gives the source column of every output column, and the crop x", () => {
  const src = pattern(640, 360);
  const plane = renderLuma(src, 7);
  assert.deepEqual(decodeRuler(plane, 640, 360, src).slice(0, 5), [0, 1, 2, 3, 4]);
  // fill_center / camera at 720×1280: the 640×360 source scaled to 2276×1280, then cropped.
  const scale = 2276 / 640;
  for (const cropX of [0, 1, 333, 778, 1555, 1556]) {
    const frame = scaled(plane, src, { width: 720, height: 1280, scale, top: 0, cropX });
    assert.equal(decodeCropX(frame, 720, 1280, src, { scale, top: 0 }), cropX, `crop ${cropX}`);
  }
});

const SECRET_ENV = {
  APP_USERNAME: "tester",
  APP_PASSWORD: "not-a-real-password",
  APP_SESSION_SECRET: "0123456789abcdef0123456789abcdef-test-only",
};

async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(pathname) {
  const headers = new Headers();
  headers.set("cookie", `${SESSION_COOKIE}=${createSessionToken(SECRET_ENV)}`);
  return new Request(`http://127.0.0.1:3999/api/parity-fixtures/${pathname}`, { headers });
}

const context = (pathname) => ({ params: Promise.resolve({ path: pathname.split("/") }) });

test("the fixtures route serves plate cells, mixes, reference PCM and the player manifest", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "player-fixtures-"));
  try {
    mkdirSync(path.join(root, "player", "cfr", "cells"), { recursive: true });
    writeFileSync(path.join(root, "player", "manifest.json"), '{"schema":"potongin.parity-player/1"}');
    writeFileSync(path.join(root, "player", "cfr", "cells", "c0000001.mp4"), Buffer.from("mp4"));
    writeFileSync(path.join(root, "player", "cfr", "mix.flac"), Buffer.from("fLaC"));
    writeFileSync(path.join(root, "player", "cfr", "reference.pcm"), Buffer.from([1, 2, 3, 4]));
    writeFileSync(path.join(root, "player", "cfr", "notes.txt"), "not served");
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      const cases = [
        ["player/manifest.json", "application/json"],
        ["player/cfr/cells/c0000001.mp4", "video/mp4"],
        ["player/cfr/mix.flac", "audio/flac"],
        ["player/cfr/reference.pcm", "application/octet-stream"],
      ];
      for (const [file, type] of cases) {
        const response = await GET(request(file), context(file));
        assert.equal(response.status, 200, file);
        assert.equal(response.headers.get("content-type"), type, file);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
      }
      assert.equal((await GET(request("player/cfr/notes.txt"), context("player/cfr/notes.txt"))).status, 404);
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("the fixtures route answers byte ranges, so a <video> of the auto render can seek", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "player-fixtures-"));
  try {
    mkdirSync(path.join(root, "player", "cfr"), { recursive: true });
    writeFileSync(path.join(root, "player", "cfr", "auto.mp4"), Buffer.from("0123456789"));
    await withEnv({ ...SECRET_ENV, POTONGIN_PARITY_FIXTURES: root, POTONGIN_PARITY_HARNESS: "1" }, async () => {
      const file = "player/cfr/auto.mp4";
      const whole = await GET(request(file), context(file));
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get("accept-ranges"), "bytes");
      const ranged = (range) => {
        const req = request(file);
        const headers = new Headers(req.headers);
        headers.set("range", range);
        return GET(new Request(req.url, { headers }), context(file));
      };
      const part = await ranged("bytes=2-5");
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
      assert.equal(part.headers.get("content-length"), "4");
      assert.equal(await part.text(), "2345");
      const open = await ranged("bytes=7-");
      assert.equal(open.status, 206);
      assert.equal(await open.text(), "789");
      const suffix = await ranged("bytes=-3");
      assert.equal(await suffix.text(), "789");
      const outside = await ranged("bytes=20-30");
      assert.equal(outside.status, 416);
      assert.equal(outside.headers.get("content-range"), "bytes */10");
    });
  } finally {
    rmSync(root, { recursive: true });
  }
});
