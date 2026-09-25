// Media and resource serving of the preview lane (plan §4.2 "media" and "resources", §9.1; T2.3).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SESSION_COOKIE, createSessionToken } from "../lib/auth.mjs";
import {
  MEDIA_KINDS,
  RESOURCE_KINDS,
  clipMediaResponse,
  fileHandleStream,
  openClipFile,
  mediaFile,
  resourceFile,
  resourceResponse,
  resourcesDir,
} from "../lib/clip-media.mjs";
import { GET as mediaGET, HEAD as mediaHEAD } from "../app/api/jobs/[id]/clips/[clipId]/media/[kind]/[name]/route.js";
import { GET as resourceGET } from "../app/api/resources/[kind]/[name]/route.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOURCES = path.resolve(HERE, "..", "..", "resources");
const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = "clip_9b2e41c07d3a5f18e6c2a0b4";
const KEY16 = "0123456789abcdef";
const SECRET_ENV = {
  APP_USERNAME: "tester",
  APP_PASSWORD: "not-a-real-password",
  APP_SESSION_SECRET: "0123456789abcdef0123456789abcdef-test-only",
};

function jobsRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "clip-media-"));
  const clip = path.join(root, JOB, "analysis", "clips", CLIP);
  for (const kind of ["plates", "audio", "ass", "derived", "frames"]) {
    mkdirSync(path.join(clip, "preview", kind), { recursive: true, mode: 0o700 });
  }
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  writeFileSync(path.join(clip, "preview", "plates", `${KEY16}-c0000620.mp4`), bytes);
  writeFileSync(path.join(clip, "preview", "audio", `${KEY16}.flac`), Buffer.from("fLaC-audio"));
  writeFileSync(path.join(clip, "preview", "ass", `${KEY16}.ass`), "[Script Info]\n<script>");
  writeFileSync(path.join(clip, "preview", "derived", `${KEY16}@115x58a850.png`), Buffer.from([0x89, 0x50]));
  writeFileSync(path.join(clip, `peaks.${KEY16}.bin`), Buffer.from([1, 2, 3, 4]));
  const outside = mkdtempSync(path.join(tmpdir(), "clip-media-outside-"));
  writeFileSync(path.join(outside, "secret.flac"), "secret");
  symlinkSync(path.join(outside, "secret.flac"), path.join(clip, "preview", "audio", `${"f".repeat(16)}.flac`));
  return { root, clip, bytes, cleanup: () => { rmSync(root, { recursive: true }); rmSync(outside, { recursive: true }); } };
}

function request(url, { headers = {}, method = "GET", session = true } = {}) {
  const all = new Headers(headers);
  if (session) all.set("cookie", `${SESSION_COOKIE}=${createSessionToken(SECRET_ENV)}`);
  return new Request(`http://127.0.0.1:3999${url}`, { method, headers: all });
}

async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await run(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("media names are content-hash names of a fixed kind", () => {
  assert.deepEqual(Object.keys(MEDIA_KINDS).sort(), ["ass", "audio", "derived", "peaks", "plates"]);
  const good = [
    ["plates", `${KEY16}-c0000620.mp4`, "preview/plates"],
    ["audio", `${KEY16}.flac`, "preview/audio"],
    ["ass", `${KEY16}.ass`, "preview/ass"],
    ["derived", `${KEY16}@115x58a850.png`, "preview/derived"],
    ["derived", `${KEY16}@4096x1a1000.png`, "preview/derived"],
    ["peaks", `peaks.${KEY16}.bin`, ""],
  ];
  for (const [kind, name, dir] of good) {
    assert.equal(mediaFile(kind, name)?.dir, dir, `${kind}/${name}`);
  }
  const bad = [
    ["plates", `${KEY16}-c620.mp4`], ["plates", `${KEY16.toUpperCase()}-c0000620.mp4`],
    ["plates", `../${KEY16}-c0000620.mp4`], ["audio", `${KEY16}.json`], ["audio", `${KEY16}.loudness.json`],
    ["ass", `${KEY16}.ass/..`], ["derived", `${KEY16}@0x58a850.png`], ["derived", `${KEY16}@115x58a50.png`],
    ["derived", `${KEY16}@115x58a1001.png`], ["peaks", `words.${KEY16}.json`], ["frames", `${KEY16}-1-720.png`],
    ["seed", "seed.json"], ["plates", ""], ["plates", null], ["__proto__", "x"],
  ];
  for (const [kind, name] of bad) assert.equal(mediaFile(kind, name), null, `${kind}/${name}`);
});

test("a plate cell is served with immutable caching, nosniff, CORP and ranges", async () => {
  const { root, bytes, cleanup } = jobsRoot();
  try {
    const url = `/api/jobs/${JOB}/clips/${CLIP}/media/plates/${KEY16}-c0000620.mp4`;
    const served = [];
    const full = await clipMediaResponse(request(url), {
      jobsRoot: root, jobId: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4`,
      onServed: (file) => served.push(file),
    });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(full.headers.get("x-content-type-options"), "nosniff");
    assert.equal(full.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("content-length"), String(bytes.length));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    assert.equal(served.length, 1);
    assert.ok(served[0].endsWith(`${KEY16}-c0000620.mp4`));

    const part = await clipMediaResponse(request(url, { headers: { range: "bytes=10-19" } }), {
      jobsRoot: root, jobId: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4`,
    });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 10-19/${bytes.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));

    const suffix = await clipMediaResponse(request(url, { headers: { range: "bytes=-5" } }), {
      jobsRoot: root, jobId: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4`,
    });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 5));

    const unsatisfiable = await clipMediaResponse(request(url, { headers: { range: "bytes=5000-" } }), {
      jobsRoot: root, jobId: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4`,
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${bytes.length}`);

    const head = await clipMediaResponse(request(url, { method: "HEAD" }), {
      jobsRoot: root, jobId: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4`, head: true,
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(bytes.length));
    assert.equal(await head.text(), "");
  } finally {
    cleanup();
  }
});

test("a streamed file is closed exactly once: at the end, on cancel and on abort", async () => {
  const { root, bytes, cleanup } = jobsRoot();
  const spec = MEDIA_KINDS.plates;
  const name = `${KEY16}-c0000620.mp4`;
  try {
    const whole = await openClipFile(root, JOB, CLIP, spec, name);
    const read = Buffer.from(await new Response(fileHandleStream(whole.handle, 0, bytes.length - 1)).arrayBuffer());
    assert.deepEqual(read, bytes);
    assert.equal(whole.handle.fd, -1, "closed after the last byte");

    const part = await openClipFile(root, JOB, CLIP, spec, name);
    const middle = Buffer.from(await new Response(fileHandleStream(part.handle, 100, 199)).arrayBuffer());
    assert.deepEqual(middle, bytes.subarray(100, 200));
    assert.equal(part.handle.fd, -1);

    const cancelled = await openClipFile(root, JOB, CLIP, spec, name);
    const reader = fileHandleStream(cancelled.handle, 0, bytes.length - 1).getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(cancelled.handle.fd, -1, "closed on cancel");

    const aborted = await openClipFile(root, JOB, CLIP, spec, name);
    const controller = new AbortController();
    const stream = fileHandleStream(aborted.handle, 0, bytes.length - 1, controller.signal);
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted.handle.fd, -1, "closed on abort");
    await assert.rejects(new Response(stream).arrayBuffer());
  } finally {
    cleanup();
  }
});

test("ASS is plain text in a CSP sandbox; the other kinds have their own types", async () => {
  const { root, cleanup } = jobsRoot();
  try {
    const serve = (kind, name) => clipMediaResponse(request(`/x/${name}`), { jobsRoot: root, jobId: JOB, clipId: CLIP, kind, name });
    const ass = await serve("ass", `${KEY16}.ass`);
    assert.equal(ass.status, 200);
    assert.equal(ass.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(ass.headers.get("content-security-policy"), "sandbox");
    assert.equal(await ass.text(), "[Script Info]\n<script>");
    assert.equal((await serve("audio", `${KEY16}.flac`)).headers.get("content-type"), "audio/flac");
    assert.equal((await serve("derived", `${KEY16}@115x58a850.png`)).headers.get("content-type"), "image/png");
    const peaks = await serve("peaks", `peaks.${KEY16}.bin`);
    assert.equal(peaks.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual([...Buffer.from(await peaks.arrayBuffer())], [1, 2, 3, 4]);
  } finally {
    cleanup();
  }
});

test("missing files, symlinks and symlinked directories are 404", async () => {
  const { root, clip, cleanup } = jobsRoot();
  try {
    const serve = (kind, name, jobId = JOB, clipId = CLIP) => clipMediaResponse(request(`/x/${name}`), { jobsRoot: root, jobId, clipId, kind, name });
    assert.equal((await serve("audio", `${"f".repeat(16)}.flac`)).status, 404); // a symlink out
    assert.equal((await serve("audio", `${"e".repeat(16)}.flac`)).status, 404);
    assert.equal((await serve("plates", `${KEY16}-c0000620.mp4`, JOB, "clip_" + "0".repeat(24))).status, 404);
    assert.equal((await serve("plates", `${KEY16}-c0000620.mp4`, "not-a-job")).status, 404);
    assert.equal((await serve("frames", `${KEY16}-1-720.png`)).status, 404);
    // a preview directory replaced by a symlink is refused
    const moved = mkdtempSync(path.join(tmpdir(), "clip-media-moved-"));
    rmSync(path.join(clip, "preview", "derived"), { recursive: true });
    writeFileSync(path.join(moved, `${KEY16}@115x58a850.png`), "x");
    symlinkSync(moved, path.join(clip, "preview", "derived"));
    assert.equal((await serve("derived", `${KEY16}@115x58a850.png`)).status, 404);
    rmSync(moved, { recursive: true });
  } finally {
    cleanup();
  }
});

test("resources are the pinned font files and pack JSON, byte for byte", async () => {
  assert.deepEqual([...RESOURCE_KINDS].sort(), ["caption-packs", "fonts", "hook-designs"]);
  const manifest = JSON.parse(readFileSync(path.join(RESOURCES, "fonts", "fonts.json"), "utf8"));
  for (const font of manifest.fonts) {
    const response = await resourceResponse(request(`/api/resources/fonts/${font.file}`), {
      kind: "fonts", name: font.file, dir: RESOURCES,
    });
    assert.equal(response.status, 200, font.file);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash("sha256").update(bytes).digest("hex"), font.sha256, font.file);
    assert.equal(response.headers.get("content-type"), "font/ttf");
    assert.equal(response.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  }
  const pack = await resourceResponse(request("/api/resources/caption-packs/karaoke.v1.json"), {
    kind: "caption-packs", name: "karaoke.v1.json", dir: RESOURCES,
  });
  assert.equal(pack.status, 200);
  assert.equal(pack.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(Buffer.from(await pack.arrayBuffer()), readFileSync(path.join(RESOURCES, "caption-packs", "karaoke", "v1.json")));
  const hook = await resourceResponse(request("/x"), { kind: "hook-designs", name: "legacy-bar.v1.json", dir: RESOURCES });
  assert.deepEqual(Buffer.from(await hook.arrayBuffer()), readFileSync(path.join(RESOURCES, "hook-designs", "legacy-bar", "v1.json")));
  for (const [kind, name] of [
    ["fonts", "fonts.json"], ["fonts", "OFL.txt"], ["fonts", "../fonts/DejaVuSans.ttf"], ["fonts", "Missing.ttf"],
    ["caption-packs", "karaoke.v2.json"], ["caption-packs", "karaoke.json"], ["caption-packs", "../karaoke.v1.json"],
    ["fontconfig", "fonts.conf"], ["toolchain", "toolchain.json"], ["hook-designs", "legacy-bar.v1.JSON"],
  ]) {
    assert.equal(resourceFile(kind, name, RESOURCES), null, `${kind}/${name}`);
    assert.equal((await resourceResponse(request("/x"), { kind, name, dir: RESOURCES })).status, 404, `${kind}/${name}`);
  }
});

test("a font whose bytes differ from fonts.json is not served", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clip-media-resources-"));
  try {
    mkdirSync(path.join(dir, "fonts"));
    writeFileSync(path.join(dir, "fonts", "fonts.json"), JSON.stringify({
      fonts: [{ file: "DejaVuSans.ttf", family: "DejaVu Sans", sha256: "0".repeat(64) }],
    }));
    writeFileSync(path.join(dir, "fonts", "DejaVuSans.ttf"), "not the pinned bytes");
    const response = await resourceResponse(request("/x"), { kind: "fonts", name: "DejaVuSans.ttf", dir });
    assert.equal(response.status, 404);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("the resources directory comes from the environment, else next to the app", () => {
  assert.equal(resourcesDir({ POTONGIN_RESOURCES_DIR: "/opt/res" }, "/app"), "/opt/res");
  assert.equal(resourcesDir({}, RESOURCES.replace(/\/resources$/, "")), RESOURCES);
  assert.equal(resourcesDir({}, path.join(RESOURCES, "..", "web")), RESOURCES);
});

test("the media and resource routes are editor-only and need a session", async () => {
  const { root, bytes, cleanup } = jobsRoot();
  try {
    const params = { id: JOB, clipId: CLIP, kind: "plates", name: `${KEY16}-c0000620.mp4` };
    const url = `/api/jobs/${JOB}/clips/${CLIP}/media/plates/${KEY16}-c0000620.mp4`;
    const context = (value) => ({ params: Promise.resolve(value) });
    await withEnv({ ...SECRET_ENV, JOBS_ROOT: root, POTONGIN_EDITOR_V3: "off", POTONGIN_RESOURCES_DIR: RESOURCES }, async () => {
      assert.equal((await mediaGET(request(url), context(params))).status, 404);
      assert.equal((await resourceGET(request("/x"), context({ kind: "fonts", name: "DejaVuSans.ttf" }))).status, 404);
    });
    await withEnv({ ...SECRET_ENV, JOBS_ROOT: root, POTONGIN_EDITOR_V3: "on", POTONGIN_RESOURCES_DIR: RESOURCES }, async () => {
      assert.equal((await mediaGET(request(url, { session: false }), context(params))).status, 401);
      assert.equal((await mediaGET(request(url), context({ ...params, id: "../../etc" }))).status, 400);
      assert.equal((await mediaGET(request(url), context({ ...params, clipId: "clip_x" }))).status, 400);
      assert.equal((await mediaGET(request(url), context({ ...params, name: "../seed.json" }))).status, 404);
      const response = await mediaGET(request(url), context(params));
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      const head = await mediaHEAD(request(url, { method: "HEAD" }), context(params));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await resourceGET(request("/x", { session: false }), context({ kind: "fonts", name: "DejaVuSans.ttf" }))).status, 401);
      const font = await resourceGET(request("/x"), context({ kind: "fonts", name: "DejaVuSans.ttf" }));
      assert.equal(font.status, 200);
    });
  } finally {
    cleanup();
  }
});
