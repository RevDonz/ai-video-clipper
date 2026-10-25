// The landing's media (lib/landing-media.mjs, public/landing): real product pictures and one
// Sebelum/Sesudah clip, at most 4 MB in all, open without a session and nothing else beside them.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LANDING_MEDIA, LANDING_MEDIA_BUDGET_BYTES, LANDING_MEDIA_PATHS, isLandingMediaPath } from "../lib/landing-media.mjs";
import { NextRequest } from "next/server.js";

import { proxy } from "../proxy.js";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = path.join(WEB, "public");
const fileOf = (src) => path.join(PUBLIC, ...src.split("/").filter(Boolean));
const read = (relative) => readFile(path.join(WEB, relative), "utf8");

// Width and height from a WebP header (VP8X, lossy VP8 or lossless VP8L).
function webpSize(buffer) {
  assert.equal(buffer.toString("ascii", 0, 4), "RIFF");
  assert.equal(buffer.toString("ascii", 8, 12), "WEBP");
  const chunk = buffer.toString("ascii", 12, 16);
  if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

// The parts of an MP4 the landing depends on: no sound track, moov before mdat (so preload and
// the first frame need no second request), the length, and the picture size of the video track.
function mp4Facts(buffer) {
  const handlers = [];
  for (let at = buffer.indexOf("hdlr"); at !== -1; at = buffer.indexOf("hdlr", at + 4)) {
    handlers.push(buffer.toString("ascii", at + 12, at + 16));
  }
  const mvhd = buffer.indexOf("mvhd");
  const version = buffer[mvhd + 4];
  const timescale = version === 1 ? buffer.readUInt32BE(mvhd + 24) : buffer.readUInt32BE(mvhd + 16);
  const duration = version === 1 ? Number(buffer.readBigUInt64BE(mvhd + 28)) : buffer.readUInt32BE(mvhd + 20);
  // A box is size(4) type(4) payload; tkhd ends with the width and height (16.16 fixed point).
  const tkhd = buffer.indexOf("tkhd");
  const tkhdEnd = tkhd - 4 + buffer.readUInt32BE(tkhd - 4);
  return {
    handlers,
    moovFirst: buffer.indexOf("moov") < buffer.indexOf("mdat"),
    seconds: duration / timescale,
    width: buffer.readUInt32BE(tkhdEnd - 8) / 65536,
    height: buffer.readUInt32BE(tkhdEnd - 4) / 65536,
  };
}

test("all landing media together stay within the 4 MB budget", async () => {
  assert.equal(LANDING_MEDIA_BUDGET_BYTES, 4_000_000);
  const sizes = await Promise.all(LANDING_MEDIA_PATHS.map(async (src) => (await stat(fileOf(src))).size));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  assert.ok(total <= LANDING_MEDIA_BUDGET_BYTES, `landing media weigh ${total} bytes`);
  // Each picture is compressed; the clip is the heaviest file and stays short.
  for (const [index, src] of LANDING_MEDIA_PATHS.entries()) {
    const limit = src.endsWith(".mp4") ? 1_500_000 : 250_000;
    assert.ok(sizes[index] <= limit, `${src} weighs ${sizes[index]} bytes (limit ${limit})`);
  }
});

test("public/landing holds exactly the listed files", async () => {
  const files = (await readdir(path.join(PUBLIC, "landing"))).map((name) => `/landing/${name}`).sort();
  assert.deepEqual(files, [...LANDING_MEDIA_PATHS].sort());
  assert.equal(new Set(LANDING_MEDIA_PATHS).size, LANDING_MEDIA_PATHS.length);
});

test("every picture's width and height match the file, so nothing shifts while it loads", async () => {
  for (const [name, entry] of Object.entries(LANDING_MEDIA)) {
    const pictures = entry.poster ? [entry.poster] : [entry.src];
    for (const src of pictures) {
      assert.match(src, /^\/landing\/[a-z-]+\.webp$/, name);
      assert.deepEqual(webpSize(await readFile(fileOf(src))), { width: entry.width, height: entry.height }, src);
    }
  }
});

test("the Sesudah clip is a short silent 9:16 MP4 that starts without a second request", async () => {
  const clip = LANDING_MEDIA.sesudah;
  assert.match(clip.src, /^\/landing\/[a-z-]+\.mp4$/);
  const facts = mp4Facts(await readFile(fileOf(clip.src)));
  assert.ok(facts.handlers.includes("vide"));
  assert.ok(!facts.handlers.includes("soun"), "no audio track");
  assert.equal(facts.moovFirst, true, "faststart");
  assert.ok(facts.seconds > 4 && facts.seconds <= 15, `${facts.seconds} s`);
  assert.deepEqual({ width: facts.width, height: facts.height }, { width: clip.width, height: clip.height });
  assert.equal(clip.width * 16, clip.height * 9, "9:16");
  const before = LANDING_MEDIA.sebelum;
  assert.equal(before.width * 9, before.height * 16, "the source picture is 16:9");
});

test("the page and the clip component use every listed picture, and the video plays only when told", async () => {
  const page = await read("app/page.jsx");
  const clip = await read("components/LandingClip.jsx");
  const both = `${page}\n${clip}`;
  const used = new Set([
    ...[...both.matchAll(/LANDING_MEDIA\.([a-z]+)/g)].map((match) => match[1]),
    ...[...both.matchAll(/const \{([^}]+)\} = LANDING_MEDIA;/g)].flatMap((match) => match[1].split(",").map((name) => name.trim())),
  ]);
  assert.deepEqual([...used].sort(), Object.keys(LANDING_MEDIA).sort());
  // Pictures carry their size and a description; the clip starts on its poster and never
  // autoplays by attribute (lib/landing-preview.mjs decides).
  // The descriptions are in the catalog (messages/<locale>/landing.json), long enough to say what the picture shows.
  const alts = [...page.matchAll(/<img[^>]*alt=\{t\("([a-zA-Z.]+)"/g)].map((match) => match[1]);
  assert.ok(alts.length >= 3, "every picture has a description");
  for (const locale of ["id", "en"]) {
    const catalog = JSON.parse(await read(`messages/${locale}/landing.json`));
    for (const key of alts) assert.ok(key.split(".").reduce((node, part) => node?.[part], catalog)?.length >= 20, `${locale}: ${key}`);
  }
  assert.match(clip, /muted/);
  assert.match(clip, /playsInline/);
  assert.match(clip, /loop/);
  assert.match(clip, /preload="none"/);
  assert.match(clip, /poster=\{/);
  assert.doesNotMatch(clip, /autoPlay|autoplay/);
  assert.match(clip, /attachPreview\(/);
  assert.match(clip, /previewButtonLabel\(/);
});

test("the landing media open without a session; every other file still asks for one", () => {
  const request = (pathname) => proxy(new NextRequest(`http://local${pathname}`));
  for (const src of LANDING_MEDIA_PATHS) {
    assert.equal(isLandingMediaPath(src), true, src);
    assert.equal(request(src).headers.get("x-middleware-next"), "1", src);
  }
  for (const pathname of [
    "/landing", "/landing/", "/landing/other.webp", "/landing/hasil.webp/", "/LANDING/hasil.webp",
    "/landing/hasil.webp.map", "/landing/../dashboard", "/landing/%2e%2e/dashboard", "/licenses/web/next-LICENSE.txt",
    "/dashboard", "/projects", "/api/jobs/abc",
  ]) {
    assert.equal(isLandingMediaPath(new URL(`http://local${pathname}`).pathname), false, pathname);
    const response = request(pathname);
    assert.notEqual(response.headers.get("x-middleware-next"), "1", pathname);
  }
  for (const value of [undefined, null, 1, ["/landing/hasil.webp"]]) assert.equal(isLandingMediaPath(value), false);
});

test("the footage is credited on the page and in the docs with its licence", async () => {
  const page = await read("app/page.jsx");
  assert.match(page, /const LICENSE_PAGE = "https:\/\/creativecommons\.org\/licenses\/by\/2\.5\/";/);
  assert.match(page, /t\.rich\("footer\.credits", \{ film, license: \(chunks\) => <a href=\{LICENSE_PAGE\}>\{chunks\}<\/a> \}\)/);
  // The credit is in every locale's catalog, with the film, the licence and its holders.
  for (const locale of ["id", "en"]) {
    const credits = JSON.parse(await read(`messages/${locale}/landing.json`)).footer.credits;
    assert.match(credits, /<film>Elephants Dream<\/film>/, locale);
    assert.match(credits, /<license>CC BY 2\.5<\/license>/, locale);
    assert.match(credits, /Blender Foundation/, locale);
  }
  const docs = await readFile(path.join(WEB, "..", "docs", "design", "LANDING.md"), "utf8");
  for (const src of LANDING_MEDIA_PATHS) assert.ok(docs.includes(src.replace("/landing/", "")), src);
  assert.match(docs, /CC BY 2\.5/);
  assert.match(docs, /Elephants Dream/);
});
