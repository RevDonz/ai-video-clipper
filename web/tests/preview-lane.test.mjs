// The server preview lane (plan §2.6, §4.2, §4.3, §6; T2.3): request parsing, plan DTO states,
// cell scheduling, the heavy semaphore, supersede cancellation, per-job LRU caps and the routes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SESSION_COOKIE, createSessionToken } from "../lib/auth.mjs";
import { PythonCliError } from "../lib/python-cli.mjs";
import {
  LaneRequestError,
  PREVIEW_MODULE,
  cellOrder,
  createPreviewLane,
  docBytes,
  editorV3Enabled,
  frameResponse,
  parseFrameBody,
  parsePlanBody,
  parsePrepareBody,
  planResponse,
  prepareResponse,
} from "../lib/preview-lane.mjs";
import { createEditorRateLimits } from "../lib/rate-limit.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = "clip_9b2e41c07d3a5f18e6c2a0b4";
const KEY = "ab".repeat(32);
const KEY2 = "cd".repeat(32);
const AUDIO = "ef".repeat(32);
const SECRET_ENV = {
  APP_USERNAME: "tester",
  APP_PASSWORD: "not-a-real-password",
  APP_SESSION_SECRET: "0123456789abcdef0123456789abcdef-test-only",
};
const DOC = { schema: "clip-edit-v2", revision: 0 };

function root() {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-lane-"));
  mkdirSync(path.join(dir, JOB, "analysis", "clips", CLIP), { recursive: true });
  return { dir, clip: path.join(dir, JOB, "analysis", "clips", CLIP), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle(times = 5) { for (let i = 0; i < times; i += 1) await flush(); }

const DOC2 = { ...DOC, revision: 1 };

function planBody(extra = {}, doc = DOC) {
  return Buffer.from(JSON.stringify({ doc, ...extra }));
}

// A plan-op result as preview_cli returns it.
function planResult({ cells = [10, 11, 12, 13, 14, 15, 16, 17], missing = cells, plateKey = KEY, audio = { key: AUDIO, ready: false },
  logo = null, playhead = 0, pieces = null } = {}) {
  const prefix = `/api/jobs/${JOB}/clips/${CLIP}/media`;
  return {
    dto: {
      planSha256: "1".repeat(64), docSha256: "2".repeat(64), compiler: "edit-v2/1", renderSemantics: 1,
      fps: [30000, 1001], totalFrames: cells.length * 60, output: { w: 720, h: 1280 },
      pieces: pieces || [{ i: 0, seg: "seg_b1", role: "body", inSf: cells[0] * 60, outSf: (cells.at(-1) + 1) * 60, outF0: 0, frames: cells.length * 60 }],
      cues: [], hook: null,
      text: { assSha256: "3".repeat(64), ass: "[Script Info]", url: `${prefix}/ass/${"3".repeat(16)}.ass`, fonts: [] },
      plate: { plateKey, cellFrames: 60, w: 720, h: 1280,
        cells: cells.map((k) => (missing.includes(k) ? { k, state: "queued" }
          : { k, state: "ready", url: `${prefix}/plates/${plateKey.slice(0, 16)}-c${String(k).padStart(7, "0")}.mp4` })) },
      logo: logo ? { box: { x: 1, y: 2, w: logo.w, h: logo.h }, opacityPm: logo.opacityPm, state: logo.ready ? "ready" : "queued" } : null,
      audio: { mixSha256: audio.key, state: audio.ready ? "ready" : "queued", samples: 100, musicGainPoints: [], speechSpans: [] },
      rev0: { planSha256: "1".repeat(64), autoRenderUrl: null, exact: false },
      warnings: [], errors: [],
    },
    lane: { playhead, layout: "fit_blur", plateKey, cellFrames: 60, cells, missing, audio, logo, frameKey: "4".repeat(16) },
  };
}

// A scripted stand-in for runPythonCli: every call is recorded and waits until released.
function fakeCli({ auto = false, results = {} } = {}) {
  const calls = [];
  const run = (module, op, payload, options = {}) => {
    let release;
    const promise = new Promise((resolve, reject) => { release = { resolve, reject }; });
    const call = { module, op, payload, options, promise, done: false,
      resolve: (value) => { call.done = true; release.resolve(value); },
      reject: (error) => { call.done = true; release.reject(error); } };
    calls.push(call);
    options.signal?.addEventListener("abort", () => call.reject(new PythonCliError("aborted")), { once: true });
    if (auto) queueMicrotask(() => call.resolve(results[op]?.(payload) ?? { exitCode: 0, json: {} }));
    return promise;
  };
  return { run, calls, pending: (op) => calls.filter((c) => !c.done && (!op || c.op === op)) };
}

// The lane trusts the disk: a mix or a cell that the plan reports ready must exist.
function readyAudio(clip, key = AUDIO) {
  mkdirSync(path.join(clip, "preview", "audio"), { recursive: true });
  writeFileSync(path.join(clip, "preview", "audio", `${key.slice(0, 16)}.flac`), "fLaC");
}

function readyCell(clip, k, key = KEY) {
  mkdirSync(path.join(clip, "preview", "plates"), { recursive: true });
  writeFileSync(path.join(clip, "preview", "plates", `${key.slice(0, 16)}-c${String(k).padStart(7, "0")}.mp4`), "cell");
}

function cellsResult(payload) {
  return { exitCode: 0, json: { plateKey: KEY, built: payload.cells, present: [] } };
}

test("request bodies are checked before anything is spawned", () => {
  assert.deepEqual(parsePlanBody(planBody()), { playhead: 0, known: null });
  assert.deepEqual(parsePlanBody(planBody({ known: { assSha256: "a".repeat(64) }, playhead: 42 })),
    { playhead: 42, known: "a".repeat(64) });
  assert.deepEqual(parsePlanBody(planBody({ known: {} })), { playhead: 0, known: null });
  for (const bad of [
    Buffer.from("not json"), Buffer.from("[]"), Buffer.from("{}"), Buffer.from('{"doc": 1}'),
    Buffer.from('{"doc": []}'), planBody({ extra: 1 }), planBody({ known: [] }),
    planBody({ known: { assSha256: "A".repeat(64) } }), planBody({ known: { other: 1 } }),
    planBody({ playhead: -1 }), planBody({ playhead: 1.5 }), planBody({ playhead: true }),
    planBody({ f: 1 }), Buffer.alloc(0),
  ]) {
    assert.throws(() => parsePlanBody(bad), LaneRequestError, bad.toString().slice(0, 40));
  }
  assert.deepEqual(parseFrameBody(Buffer.from(JSON.stringify({ doc: DOC, f: 12 }))), { f: 12 });
  for (const bad of [{ doc: DOC }, { doc: DOC, f: -1 }, { doc: DOC, f: "1" }, { doc: DOC, f: 1, playhead: 1 }, { f: 1 }]) {
    assert.throws(() => parseFrameBody(Buffer.from(JSON.stringify(bad))), LaneRequestError);
  }
  assert.deepEqual(parsePrepareBody(Buffer.alloc(0)), { layout: null });
  assert.deepEqual(parsePrepareBody(Buffer.from("{}")), { layout: null });
  assert.deepEqual(parsePrepareBody(Buffer.from('{"layout":"camera"}')), { layout: "camera" });
  for (const bad of ['{"layout":"split"}', '{"layout":null,"x":1}', "[]", "nope"]) {
    assert.throws(() => parsePrepareBody(Buffer.from(bad)), LaneRequestError);
  }
});

test("cells are ordered from the playhead, then in playback order", () => {
  const pieces = [
    { inSf: 600, outSf: 780, outF0: 0, frames: 180 }, // cells 10, 11, 12
    { inSf: 120, outSf: 240, outF0: 180, frames: 120 }, // cells 2, 3
    { inSf: 900, outSf: 1000, outF0: 300, frames: 100 }, // cells 15, 16
  ];
  const cells = [10, 11, 12, 2, 3, 15, 16];
  assert.deepEqual(cellOrder(cells, pieces, 60, 0), [10, 11, 12, 2, 3, 15, 16]);
  assert.deepEqual(cellOrder(cells, pieces, 60, 200), [2, 3, 15, 16, 10, 11, 12]); // frame 200 = sf 140
  assert.deepEqual(cellOrder(cells, pieces, 60, 399), [16, 10, 11, 12, 2, 3, 15]);
  assert.deepEqual(cellOrder(cells, pieces, 60, 10_000), [16, 10, 11, 12, 2, 3, 15]);
  assert.deepEqual(cellOrder([], [], 60, 0), []);
});

test("a plan runs the plan op once and schedules cells, audio and the logo", async () => {
  const { dir, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  try {
    const pending = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 130 }) });
    await settle();
    const [call] = cli.pending("plan");
    assert.equal(call.module, PREVIEW_MODULE);
    assert.deepEqual(Object.keys(call.payload).sort(), ["clipId", "jobId", "requestRaw"]);
    assert.equal(Buffer.from(call.payload.requestRaw, "base64").toString(), `{"doc":${JSON.stringify(DOC)}}`);
    call.resolve({ exitCode: 0, json: planResult({ playhead: 130, logo: { asset: `sha256:${"9".repeat(64)}`, w: 20, h: 10, opacityPm: 850, name: `${"8".repeat(16)}@20x10a850.png`, ready: false } }) });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.json.planSha256, "1".repeat(64));
    assert.ok(!("lane" in response.json));
    await settle();
    // two heavy slots: the audio mix (priority) and the playhead cell alone
    const running = cli.pending().filter((c) => c.op !== "plan");
    assert.deepEqual(running.map((c) => c.op).sort(), ["audio", "derive"]);
    assert.equal(running.find((c) => c.op === "audio").payload.cancelToken.length, 32);
    running.find((c) => c.op === "audio").resolve({ exitCode: 0, json: { audioKey: AUDIO, name: `${AUDIO.slice(0, 16)}.flac`, built: true, samples: 100, gainCdb: 0, warnings: [] } });
    running.find((c) => c.op === "derive").resolve({ exitCode: 0, json: { name: `${"8".repeat(16)}@20x10a850.png`, built: true } });
    await settle();
    const first = cli.pending("cells");
    assert.equal(first.length, 2);
    assert.deepEqual(first[0].payload.cells, [12]); // frame 130 = sf 730 = cell 12, alone
    assert.deepEqual(first[0].payload.layout, "fit_blur");
    assert.deepEqual(first[1].payload.cells, [13, 14, 15, 16]); // then a batch in playback order
    for (const c of first) c.resolve(cellsResult(c.payload));
    await settle();
    const second = cli.pending("cells");
    assert.deepEqual(second.map((c) => c.payload.cells), [[17], [10, 11]]);
    for (const c of second) c.resolve(cellsResult(c.payload));
    await lane.idle();
    assert.equal(cli.pending().length, 0);
  } finally {
    lane.close();
    cleanup();
  }
});

test("the same body shares one plan op and later polls are answered from the cache", async () => {
  const { dir, clip, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 0 });
  try {
    const a = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    const b = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    await settle();
    assert.equal(cli.pending("plan").length, 1);
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ cells: [10, 11], missing: [10, 11] }) });
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    // a cell appears on disk: the cached answer now reports it ready, without a new plan op
    mkdirSync(path.join(clip, "preview", "plates"), { recursive: true });
    writeFileSync(path.join(clip, "preview", "plates", `${KEY.slice(0, 16)}-c0000011.mp4`), "cell");
    const polled = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    assert.equal(cli.calls.filter((c) => c.op === "plan").length, 1);
    assert.deepEqual(polled.json.plate.cells, [
      { k: 10, state: "queued" },
      { k: 11, state: "ready", url: `/api/jobs/${JOB}/clips/${CLIP}/media/plates/${KEY.slice(0, 16)}-c0000011.mp4` },
    ]);
  } finally {
    lane.close();
    cleanup();
  }
});

test("polls of the same document hit the cache whatever their known sha or playhead", async () => {
  const { dir, clip, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 0 });
  try {
    const first = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    await settle();
    const [call] = cli.pending("plan");
    // Python always gets the document alone, byte for byte, and returns the ASS
    assert.equal(Buffer.from(call.payload.requestRaw, "base64").toString(), `{"doc":${JSON.stringify(DOC)}}`);
    call.resolve({ exitCode: 0, json: planResult({ cells: [10, 11, 12], missing: [10, 11, 12] }) });
    const answer = await first;
    assert.equal(answer.json.text.ass, "[Script Info]");
    const known = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ known: { assSha256: "3".repeat(64) }, playhead: 130 }) });
    assert.equal(cli.calls.length, 1, "no new plan op for a poll");
    assert.equal(known.status, 200);
    assert.ok(!("ass" in known.json.text), "the client already has this ASS");
    const other = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ known: { assSha256: "4".repeat(64) } }) });
    assert.equal(other.json.text.ass, "[Script Info]");
    // a document with other bytes (here a different key order) is planned again
    const reordered = Buffer.from(`{"doc":{"revision":0,"schema":"clip-edit-v2"}}`);
    const again = lane.plan({ jobId: JOB, clipId: CLIP, body: reordered });
    await settle();
    assert.equal(cli.pending("plan").length, 1);
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult() });
    assert.equal((await again).status, 200);
    assert.ok(!existsSync(path.join(clip, "preview", ".cancel")));
  } finally {
    lane.close();
    cleanup();
  }
});

test("a doc member is found byte for byte, and a doubled one is refused", () => {
  assert.equal(docBytes(Buffer.from(' { "known" : {"assSha256": null}, "doc" : {"a":[1,{"b":"}"}]} , "playhead": 3 }')).toString(),
    '{"a":[1,{"b":"}"}]}');
  assert.equal(docBytes(Buffer.from('{"doc":{"t":"\\"quoted\\" and ] brace"},"playhead":0}')).toString(),
    '{"t":"\\"quoted\\" and ] brace"}');
  assert.equal(docBytes(Buffer.from('{"doc":{"n":8.0}}')).toString(), '{"n":8.0}'); // Python judges floats
  assert.throws(() => docBytes(Buffer.from('{"doc":{},"doc":{}}')), LaneRequestError);
  assert.throws(() => docBytes(Buffer.from('{"known":{}}')), LaneRequestError);
});

test("a newer plan for the clip cancels the superseded one", async () => {
  const { dir, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 0 });
  try {
    const old = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 1 }) });
    await settle();
    const newer = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 2 }, DOC2) });
    await settle();
    const [first, second] = cli.calls;
    assert.equal(first.options.signal.aborted, true);
    const superseded = await old;
    assert.equal(superseded.status, 409);
    assert.equal(superseded.json.error.code, "superseded");
    second.resolve({ exitCode: 0, json: planResult() });
    assert.equal((await newer).status, 200);
  } finally {
    lane.close();
    cleanup();
  }
});

test("plan errors keep their fixed codes and never leak details", async () => {
  const { dir, cleanup } = root();
  const cases = [
    [{ exitCode: 3, json: { error: { code: "float_not_allowed", path: "/main/cut_fade_ms", ref: null, messageId: "edit.float_not_allowed" }, errors: [{ code: "float_not_allowed", path: "/main/cut_fade_ms" }] } }, 422],
    [{ exitCode: 6, json: { error: { code: "base_changed", path: "/base", ref: null, messageId: "edit.base_changed" }, errors: [{ code: "base_changed", path: "/base" }] } }, 422],
    [{ exitCode: 8, json: { error: { code: "analysis_missing", path: "/layout/default/mode", ref: "camera", messageId: "edit.analysis_missing" } } }, 409],
    [{ exitCode: 4, json: { error: { code: "not_found", path: null, ref: null, messageId: "edit.not_found" } } }, 404],
    [{ exitCode: 7, json: { error: { code: "schema_too_new", path: null, ref: null, messageId: "edit.schema_too_new" } } }, 426],
  ];
  try {
    for (const [result, status] of cases) {
      const lane = createPreviewLane({ jobsRoot: dir, runCli: async () => result, heavySlots: 0 });
      const response = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
      assert.equal(response.status, status);
      assert.deepEqual(response.json, result.json);
      lane.close();
    }
    const failing = createPreviewLane({ jobsRoot: dir, runCli: async () => { throw new PythonCliError("backend_failed"); }, heavySlots: 0 });
    const unavailable = await failing.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(unavailable.json, { error: { code: "backend_unavailable", messageId: "edit.backend_unavailable" } });
    failing.close();
  } finally {
    cleanup();
  }
});

test("a new plate key cancels the old cells through a cancel marker", async () => {
  const { dir, clip, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  readyAudio(clip);
  try {
    const one = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 1 }) });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ audio: { key: AUDIO, ready: true } }) });
    await one;
    await settle();
    const running = cli.pending("cells");
    assert.equal(running.length, 2);
    const two = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 2 }, DOC2) });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ plateKey: KEY2, audio: { key: AUDIO, ready: true } }) });
    await two;
    await settle();
    for (const call of running) {
      const marker = path.join(clip, "preview", ".cancel", call.payload.cancelToken);
      assert.ok(existsSync(marker), "a cancel marker per superseded cell job");
      call.resolve({ exitCode: 12, json: { error: { code: "cancelled", path: null, ref: null, messageId: "edit.cancelled" } } });
    }
    await settle();
    for (const call of running) {
      assert.ok(!existsSync(path.join(clip, "preview", ".cancel", call.payload.cancelToken)), "markers are removed afterwards");
    }
    const next = cli.pending("cells");
    assert.ok(next.length > 0);
    assert.ok(next.every((c) => c.payload.cells.every((k) => k >= 10)));
    const keys = new Set(next.map((c) => c.payload.layout));
    assert.deepEqual([...keys], ["fit_blur"]);
    for (const c of cli.pending()) c.resolve(cellsResult(c.payload));
    await settle(20);
    for (const c of cli.pending()) c.resolve(cellsResult(c.payload));
  } finally {
    lane.close();
    cleanup();
  }
});

test("an interactive job preempts the newest cell job when every slot is busy", async () => {
  const { dir, clip, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  readyAudio(clip);
  try {
    const planned = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ audio: { key: AUDIO, ready: true } }) });
    await planned;
    await settle();
    const [older, newer] = cli.pending("cells");
    assert.deepEqual(older.payload.cells, [10]);
    const frame = lane.frame({ jobId: JOB, clipId: CLIP, body: Buffer.from(JSON.stringify({ doc: DOC, f: 5 })) });
    await settle();
    assert.ok(existsSync(path.join(clip, "preview", ".cancel", newer.payload.cancelToken)));
    assert.ok(!existsSync(path.join(clip, "preview", ".cancel", older.payload.cancelToken)));
    newer.resolve({ exitCode: 12, json: { error: { code: "cancelled" } } });
    await settle();
    const [frameCall] = cli.pending("frame");
    assert.equal(frameCall.payload.requestRaw, Buffer.from(JSON.stringify({ doc: DOC, f: 5 })).toString("base64"));
    mkdirSync(path.join(clip, "preview", "frames"), { recursive: true });
    const name = `${"4".repeat(16)}-5-720.png`;
    writeFileSync(path.join(clip, "preview", "frames", name), "png");
    frameCall.resolve({ exitCode: 0, json: { name, planSha256: "1".repeat(64), built: true } });
    const result = await frame;
    assert.equal(result.status, 200);
    assert.equal(result.path, path.join(clip, "preview", "frames", name));
    await settle();
    // the preempted cells go back to the queue
    const requeued = cli.pending("cells").map((c) => c.payload.cells).flat();
    assert.ok(requeued.includes(newer.payload.cells[0]));
    for (const c of cli.pending()) c.resolve(cellsResult(c.payload));
    await settle(20);
    for (const c of cli.pending()) c.resolve(cellsResult(c.payload));
  } finally {
    lane.close();
    cleanup();
  }
});

test("a new audio mix for the clip replaces the one being built", async () => {
  const { dir, clip, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  readyCell(clip, 10);
  try {
    const first = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 1 }) });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ cells: [10], missing: [] }) });
    await first;
    await settle();
    const [audio] = cli.pending("audio");
    const second = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 2 }, DOC2) });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ cells: [10], missing: [], audio: { key: "12".repeat(32), ready: false } }) });
    await second;
    await settle();
    assert.ok(existsSync(path.join(clip, "preview", ".cancel", audio.payload.cancelToken)));
    audio.resolve({ exitCode: 12, json: { error: { code: "cancelled" } } });
    await settle();
    const [next] = cli.pending("audio");
    assert.equal(Buffer.from(next.payload.requestRaw, "base64").toString(), `{"doc":${JSON.stringify(DOC2)}}`);
    next.resolve({ exitCode: 0, json: { audioKey: "12".repeat(32), name: "x.flac", built: true, samples: 1, gainCdb: -80, warnings: [{ code: "peak_reduced:-0.80 dB", path: "/audio" }] } });
    await lane.idle();
    // the measured warning joins the next answer for the same document
    const polled = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody({ playhead: 2 }, DOC2) });
    assert.ok(polled.json.warnings.some((w) => w.code === "peak_reduced:-0.80 dB"));
  } finally {
    lane.close();
    cleanup();
  }
});

test("running jobs are reported as building in the plan answer", async () => {
  const { dir, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  try {
    const planned = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ cells: [10, 11], missing: [10, 11] }) });
    await planned;
    await settle();
    const polled = await lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    assert.equal(polled.json.audio.state, "building");
    assert.deepEqual(polled.json.plate.cells.map((c) => c.state), ["building", "queued"]);
    for (const c of cli.pending()) c.resolve(c.op === "cells" ? cellsResult(c.payload) : { exitCode: 0, json: {} });
    await settle(20);
    for (const c of cli.pending()) c.resolve(c.op === "cells" ? cellsResult(c.payload) : { exitCode: 0, json: {} });
  } finally {
    lane.close();
    cleanup();
  }
});

test("prepare returns the artifact states and queues the first cells", async () => {
  const { dir, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 1 });
  try {
    const pending = lane.prepare({ jobId: JOB, clipId: CLIP, layout: "camera" });
    await settle();
    const [call] = cli.pending("prepare");
    assert.deepEqual(call.payload, { jobId: JOB, clipId: CLIP, layout: "camera" });
    call.resolve({ exitCode: 0, json: { words: "ready", camera: "ready", layout: "camera", plateKey: KEY, cellFrames: 60, cells: [4, 5, 6], ready: [5] } });
    const response = await pending;
    assert.equal(response.status, 202);
    assert.deepEqual(response.json, { words: "ready", camera: "ready", plate: { state: "building", ready: 1, total: 3 } });
    await settle();
    const [cells] = cli.pending("cells");
    assert.deepEqual(cells.payload.cells, [4]);
    assert.equal(cells.payload.layout, "camera");
    cells.resolve(cellsResult(cells.payload));
    await settle();
    cli.pending("cells")[0].resolve(cellsResult(cli.pending("cells")[0].payload));
    await lane.idle();
    const done = createPreviewLane({ jobsRoot: dir, runCli: async () => ({ exitCode: 0, json: { words: "ready", camera: "not_needed", layout: "fit_blur", plateKey: KEY, cellFrames: 60, cells: [1], ready: [1] } }), heavySlots: 1 });
    assert.deepEqual((await done.prepare({ jobId: JOB, clipId: CLIP, layout: null })).json.plate, { state: "ready", ready: 1, total: 1 });
    done.close();
  } finally {
    lane.close();
    cleanup();
  }
});

test("at most two heavy processes run, whatever is queued", async () => {
  const { dir, cleanup } = root();
  const cli = fakeCli();
  const lane = createPreviewLane({ jobsRoot: dir, runCli: cli.run, heavySlots: 2 });
  try {
    const cells = Array.from({ length: 40 }, (_, i) => 100 + i);
    const planned = lane.plan({ jobId: JOB, clipId: CLIP, body: planBody() });
    await settle();
    cli.pending("plan")[0].resolve({ exitCode: 0, json: planResult({ cells, missing: cells }) });
    await planned;
    let peak = 0;
    let built = [];
    for (let round = 0; round < 60; round += 1) {
      await settle();
      const running = cli.pending();
      if (!running.length) break;
      peak = Math.max(peak, running.length);
      for (const c of running) {
        if (c.op === "cells") built = built.concat(c.payload.cells);
        c.resolve(c.op === "cells" ? cellsResult(c.payload) : { exitCode: 0, json: {} });
      }
    }
    await lane.idle();
    assert.equal(peak, 2);
    assert.deepEqual([...built].sort((a, b) => a - b), cells);
    assert.ok(cli.calls.filter((c) => c.op === "cells").every((c) => c.payload.cells.length <= 4));
    assert.ok(cli.calls.every((c) => c.op === "plan" || c.options.timeoutMs >= 30_000));
  } finally {
    lane.close();
    cleanup();
  }
});

function writeSized(file, bytes, ageMs) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes));
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(file, at, at);
}

test("preview caches are held under the per-job cap, least recently used first", async () => {
  const { dir, clip, cleanup } = root();
  const other = path.join(dir, JOB, "analysis", "clips", "clip_" + "1".repeat(24));
  const lane = createPreviewLane({ jobsRoot: dir, runCli: async () => ({ exitCode: 0, json: {} }), cacheCapBytes: 10_000, protectMs: 1_000 });
  try {
    const plates = path.join(clip, "preview", "plates");
    writeSized(path.join(plates, `${KEY.slice(0, 16)}-c0000001.mp4`), 4000, 60_000); // oldest
    writeSized(path.join(plates, `${KEY.slice(0, 16)}-c0000002.mp4`), 4000, 50_000);
    writeSized(path.join(other, "preview", "audio", `${AUDIO.slice(0, 16)}.flac`), 4000, 40_000);
    writeSized(path.join(clip, "preview", "ass", `${"3".repeat(16)}.ass`), 1000, 500); // protected: just written
    writeSized(path.join(clip, "preview", "plates", `.${KEY.slice(0, 16)}-c0000009.mp4.1234.tmp`), 100, 3_600_000);
    writeSized(path.join(clip, "seed.json"), 50_000, 90_000); // not a cache: never counted or evicted
    lane.touch(path.join(plates, `${KEY.slice(0, 16)}-c0000001.mp4`)); // used just now
    const result = await lane.enforceCacheCap(JOB);
    assert.ok(result.totalBytes <= 10_000, JSON.stringify(result));
    assert.ok(existsSync(path.join(plates, `${KEY.slice(0, 16)}-c0000001.mp4`)));
    assert.ok(!existsSync(path.join(plates, `${KEY.slice(0, 16)}-c0000002.mp4`)));
    assert.ok(existsSync(path.join(clip, "preview", "ass", `${"3".repeat(16)}.ass`)));
    assert.ok(existsSync(path.join(clip, "seed.json")));
    assert.ok(!readdirSync(plates).some((name) => name.endsWith(".tmp")), "stale temporary files are removed");
    assert.equal(statSync(path.join(clip, "seed.json")).size, 50_000);
  } finally {
    lane.close();
    cleanup();
  }
});

// --- routes ---------------------------------------------------------------------------------------

function mutation(url, bodyBytes, { origin = "http://127.0.0.1:3999", session = true, type = "application/json" } = {}) {
  const headers = new Headers({ host: "127.0.0.1:3999", origin, "sec-fetch-site": "same-origin" });
  if (type) headers.set("content-type", type);
  if (session) headers.set("cookie", `${SESSION_COOKIE}=${createSessionToken(SECRET_ENV)}`);
  return new Request(`http://127.0.0.1:3999${url}`, { method: "POST", headers, body: bodyBytes, duplex: "half" });
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

test("the plan route checks the flag, session, ids, origin, size and rate before the lane", async () => {
  const { dir, cleanup } = root();
  let calls = 0;
  const lane = createPreviewLane({ jobsRoot: dir, runCli: async () => { calls += 1; return { exitCode: 0, json: planResult({ cells: [1], missing: [] }) }; }, heavySlots: 0 });
  const limits = createEditorRateLimits({ now: () => 0 });
  const url = `/api/jobs/${JOB}/clips/${CLIP}/preview/plan`;
  const params = { id: JOB, clipId: CLIP };
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_EDITOR_V3: "off" }, async () => {
      assert.equal(editorV3Enabled(), false);
      assert.equal((await planResponse(mutation(url, planBody()), params, { lane, limits })).status, 404);
    });
    await withEnv({ ...SECRET_ENV, POTONGIN_EDITOR_V3: "on" }, async () => {
      assert.equal((await planResponse(mutation(url, planBody(), { session: false }), params, { lane, limits })).status, 401);
      assert.equal((await planResponse(mutation(url, planBody()), { ...params, id: "x" }, { lane, limits })).status, 400);
      assert.equal((await planResponse(mutation(url, planBody()), { ...params, clipId: "clip_1" }, { lane, limits })).status, 400);
      assert.equal((await planResponse(mutation(url, planBody(), { origin: "https://evil.example" }), params, { lane, limits })).status, 403);
      assert.equal((await planResponse(mutation(url, planBody(), { type: "text/plain" }), params, { lane, limits })).status, 415);
      assert.equal((await planResponse(mutation(url, Buffer.alloc((1 << 20) + 8192, 32)), params, { lane, limits })).status, 413);
      assert.equal((await planResponse(mutation(url, Buffer.from('{"doc":1}')), params, { lane, limits })).status, 400);
      assert.equal(calls, 0);
      const ok = await planResponse(mutation(url, planBody()), params, { lane, limits });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("cache-control"), "no-store");
      assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
      assert.equal((await ok.json()).planSha256, "1".repeat(64));
      let limited;
      for (let i = 0; i < 12; i += 1) {
        const response = await planResponse(mutation(url, planBody({ playhead: i })), params, { lane, limits });
        if (response.status === 429) { limited = response; break; }
      }
      assert.ok(limited, "more than 10 plans per second are refused");
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    });
  } finally {
    lane.close();
    cleanup();
  }
});

test("the frame route streams the truth frame PNG and the prepare route answers 202", async () => {
  const { dir, clip, cleanup } = root();
  const name = `${"4".repeat(16)}-5-720.png`;
  mkdirSync(path.join(clip, "preview", "frames"), { recursive: true });
  writeFileSync(path.join(clip, "preview", "frames", name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const lane = createPreviewLane({
    jobsRoot: dir,
    runCli: async (_module, op) => (op === "frame"
      ? { exitCode: 0, json: { name, planSha256: "1".repeat(64), built: false } }
      : { exitCode: 0, json: { words: "ready", camera: "not_needed", layout: "fit_blur", plateKey: KEY, cellFrames: 60, cells: [1], ready: [1] } }),
    heavySlots: 1,
  });
  const limits = createEditorRateLimits({ now: () => 0 });
  const params = { id: JOB, clipId: CLIP };
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_EDITOR_V3: "on" }, async () => {
      const url = `/api/jobs/${JOB}/clips/${CLIP}/preview/frame`;
      const frame = await frameResponse(mutation(url, Buffer.from(JSON.stringify({ doc: DOC, f: 5 }))), params, { lane, limits });
      assert.equal(frame.status, 200);
      assert.equal(frame.headers.get("content-type"), "image/png");
      assert.equal(frame.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual([...Buffer.from(await frame.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
      assert.equal((await frameResponse(mutation(url, Buffer.from(JSON.stringify({ doc: DOC }))), params, { lane, limits })).status, 400);
      const prepareUrl = `/api/jobs/${JOB}/clips/${CLIP}/prepare`;
      const prepared = await prepareResponse(mutation(prepareUrl, Buffer.from("{}")), params, { lane });
      assert.equal(prepared.status, 202);
      assert.deepEqual(await prepared.json(), { words: "ready", camera: "not_needed", plate: { state: "ready", ready: 1, total: 1 } });
      assert.equal((await prepareResponse(mutation(prepareUrl, Buffer.alloc(2000, 32)), params, { lane })).status, 413);
      assert.equal((await prepareResponse(mutation(prepareUrl, Buffer.from("{}"), { origin: "http://other" }), params, { lane })).status, 403);
    });
  } finally {
    lane.close();
    cleanup();
  }
});

test("the routes spawn the real CLI module through python-cli with the allowlisted env", async () => {
  // A stand-in "python" (a node script) answers the plan op and records its environment.
  const { dir, cleanup } = root();
  const bin = path.join(dir, "fake-python.mjs");
  const envOut = path.join(dir, "env.json");
  writeFileSync(bin, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const envelope = JSON.parse(readFileSync(0, "utf8"));
writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, op: envelope.op }));
process.stdout.write(JSON.stringify(${JSON.stringify(planResult({ cells: [1], missing: [] }))}));
`, { mode: 0o755 });
  try {
    await withEnv({ ...SECRET_ENV, POTONGIN_EDITOR_V3: "on", JOBS_ROOT: dir, PYTHON_BIN: bin, OPENROUTER_API_KEY: "sk-secret" }, async () => {
      const { POST } = await import("../app/api/jobs/[id]/clips/[clipId]/preview/plan/route.js");
      const response = await POST(mutation(`/api/jobs/${JOB}/clips/${CLIP}/preview/plan`, planBody()), { params: Promise.resolve({ id: JOB, clipId: CLIP }) });
      assert.equal(response.status, 200);
      const seen = JSON.parse((await import("node:fs")).readFileSync(envOut, "utf8"));
      assert.deepEqual(seen.argv, ["-m", PREVIEW_MODULE]);
      assert.equal(seen.op, "plan");
      for (const name of Object.keys(seen.env)) {
        assert.ok(!/^(APP_|POTONGIN_SETTINGS_|POTONGIN_LLM)|_API_KEY$/.test(name), name);
      }
      assert.equal(seen.env.JOBS_ROOT, dir);
    });
  } finally {
    cleanup();
  }
});
