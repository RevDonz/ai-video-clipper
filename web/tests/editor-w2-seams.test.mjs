// T2.Z (W2 integrator): the seams between the phase-B modules, each tested before it was wired
// (plan §11.2 T2.Z, requests of T2.2, T2.3, T2.4, T2.5 and T2.6; every patch is logged in
// docs/editor/GATES.md).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync } from "node:fs";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE_CLIP_ID, FAKE_JOB_ID, createFakeApiClient, fakePlan } from "../components/editor/__dev__/fakes.mjs";
import * as fakes from "../components/editor/__dev__/fakes.mjs";
import { createEditorRuntime } from "../components/editor/runtime.mjs";
import { MESSAGES, badgeView, conflictParts, messageFor, noticesView } from "../components/editor/shell-model.mjs";
import { CommandRejected } from "../lib/editor/commands.mjs";
import { createPreviewClient } from "../lib/editor/preview-client.mjs";
import { createEditorStore } from "../lib/editor/store.mjs";
import { resourceFile, resourceResponse } from "../lib/clip-media.mjs";
import { descriptorReadableStream } from "../lib/preview-source.mjs";
import { PYTHON_CLI_MODULES, PythonCliError, runPythonCli } from "../lib/python-cli.mjs";
import { bindRenderStorage, reserveRenderStorage } from "../lib/render-storage-admission.mjs";
import { scanJobsStorage } from "../lib/storage-admission.mjs";
import nextConfig from "../next.config.mjs";
import { config as proxyConfig } from "../proxy.js";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "..");

// --- python-cli (T2.2 R1, T2.3) -------------------------------------------------------------------

test("the render queue CLI can be spawned through python-cli (T2.2 R1)", () => {
  assert.ok(PYTHON_CLI_MODULES.includes("ai_clipper.render_queue"));
});

const TERM_FAKE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const envelope = JSON.parse(readFileSync(0, "utf8"));
process.on("SIGTERM", () => {
  if (envelope.mode === "graceful") { writeFileSync(envelope.marker, "term"); process.exit(12); }
  // "stubborn": ignore SIGTERM; only SIGKILL ends it
});
setInterval(() => {}, 1000);
`;

async function termPython() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "python-cli-term-"));
  const python = path.join(dir, "python.mjs");
  await writeFile(python, `#!${process.execPath}\n${TERM_FAKE}`);
  await chmod(python, 0o755);
  return { dir, python };
}

test("a timeout sends SIGTERM first, so preview_cli can stop FFmpeg's own group (T2.3)", async (t) => {
  const { dir, python } = await termPython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "marker");
  await assert.rejects(runPythonCli("ai_clipper.edit_v2.preview_cli", "cells", { mode: "graceful", marker }, {
    pythonBin: python, env: { PATH: process.env.PATH }, timeoutMs: 400, killGraceMs: 5000,
  }), (error) => error instanceof PythonCliError && error.code === "timeout");
  assert.equal(await readFile(marker, "utf8"), "term");
});

test("a child that ignores SIGTERM is killed after the grace period", async (t) => {
  const { dir, python } = await termPython();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const started = Date.now();
  await assert.rejects(runPythonCli("ai_clipper.edit_v2.preview_cli", "cells", { mode: "stubborn" }, {
    pythonBin: python, env: { PATH: process.env.PATH }, timeoutMs: 300, killGraceMs: 300,
  }), (error) => error instanceof PythonCliError && error.code === "timeout");
  assert.ok(Date.now() - started < 4000, "SIGKILL follows the grace period");
});

// --- render storage (T2.2 R2, R3) -------------------------------------------------------------------

const RID = "123e4567-e89b-42d3-a456-426614174000";

for (const state of ["completed", "failed", "cancelled"]) {
  test(`a terminal render-request-v3 (${state}) releases its storage reservation (T2.2 R2)`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "render-storage-v3-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = {
      quotaBytes: 1000n, minimumFreeBytes: 0n, activeReserveBytes: 20n,
      scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000, recheckBytes: 10, recheckIntervalMs: 10,
    };
    const storageOps = { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1000n };
    const reservation = await reserveRenderStorage(root, { reservationId: RID, jobId: RID, declaredBytes: 10n, storageConfig: config, storageOps });
    const renderId = "323e4567-e89b-42d3-a456-426614174000";
    assert.equal(await bindRenderStorage(root, RID, reservation.token, renderId), true);
    const requests = path.join(root, RID, "analysis", "render-requests");
    await mkdir(requests, { recursive: true });
    await writeFile(path.join(requests, `${renderId}.json`), JSON.stringify({
      version: "render-request-v3", render_id: renderId, state,
      storage_reservation_id: RID, storage_reservation_token: reservation.token,
    }));
    await reserveRenderStorage(root, {
      reservationId: "223e4567-e89b-42d3-a456-426614174000", jobId: RID, declaredBytes: 10n, storageConfig: config, storageOps,
    });
    const left = await readFile(path.join(root, ".render-reservations", `${RID}.json`), "utf8").catch((error) => error.code);
    assert.equal(left, "ENOENT");
  });
}

test("the storage scan counts a hard-linked file once (T2.2 R3: R10 exports and source snapshots)", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "job", "output", "edits"), { recursive: true });
  const original = path.join(root, "job", "output", "clip-01.mp4");
  await writeFile(original, Buffer.alloc(256 * 1024, 7));
  const scan = () => scanJobsStorage({ jobsRoot: root, maxEntries: 100, maxDepth: 10, deadlineMs: 10_000 });
  const before = await scan();
  await link(original, path.join(root, "job", "output", "edits", "linked.mp4"));
  const after = await scan();
  const blocks = BigInt((await stat(original)).blocks) * 512n;
  assert.ok(blocks > 0n);
  assert.equal(after.fileCount, before.fileCount + 1);
  // the new directory entry adds nothing: only the second name of the same inode
  assert.equal(after.allocatedBytes, before.allocatedBytes);
});

// --- preview-source (T2.3: a borrowed descriptor is closed exactly once, by its owner) -------------

test("the descriptor stream never closes the borrowed fd itself", async () => {
  const file = path.join(repoRoot, "pyproject.toml");
  const fd = openSync(file, "r");
  let openAtClose = null;
  const stream = descriptorReadableStream(fd, 0, 15, null, {
    closeFd: async (descriptor) => {
      try { fstatSync(descriptor); openAtClose = true; } catch { openAtClose = false; }
      closeSync(descriptor);
    },
  });
  const reader = stream.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(bytes, 16);
  assert.equal(openAtClose, true, "the fd was still open when its owner closed it");
});

// --- resources: the JASSUB worker glue and wasm (T2.4) ---------------------------------------------

test("the jassub resource kind serves the pinned worker glue and wasm byte for byte (T2.4)", async () => {
  const root = path.join(webRoot, "node_modules", "jassub", "dist", "wasm");
  for (const [name, type] of [["jassub-worker.js", "text/javascript; charset=utf-8"], ["jassub-worker.wasm", "application/wasm"]]) {
    const target = resourceFile("jassub", name, undefined, { jassubDir: root });
    assert.ok(target, name);
    assert.equal(target.type, type);
    const response = await resourceResponse(new Request(`http://x/api/resources/jassub/${name}`), { kind: "jassub", name, jassubDir: root });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(path.join(root, name)));
  }
  for (const name of ["jassub-worker.js.map", "jassub-worker-modern.wasm", "../package.json", "jassub-worker.d.ts"]) {
    assert.equal(resourceFile("jassub", name, undefined, { jassubDir: root }), null, name);
  }
});

// --- preview client: playhead and supersede (T2.3 → T2.5) ------------------------------------------

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("plan requests carry the playhead, and a 409 superseded is an abandoned request", async () => {
  const bodies = [];
  let answer = () => jsonResponse(200, fakePlan());
  const client = createPreviewClient({
    jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, debounceMs: 0, playhead: () => 321,
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return answer(); },
  });
  await client.plan(fakes.fakeDoc());
  assert.equal(bodies[0].playhead, 321);
  answer = () => jsonResponse(409, { error: { code: "superseded" } });
  await assert.rejects(client.plan(fakes.fakeDoc()), (error) => error.name === "AbortError" && error.code === "superseded");
});

// --- the store polls the lane until every layer is ready (T2.3 → T2.5) -----------------------------

function manualTimers() {
  let now = 0;
  let seq = 0;
  const queue = new Map();
  return {
    setTimeout(fn, ms) { seq += 1; queue.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { queue.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      now = until;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

test("the store re-requests the plan while cells or the mix are building, and stops when ready", async () => {
  const timers = manualTimers();
  const building = fakePlan();
  building.plate.cells = [{ k: 1, state: "building" }, { k: 2, state: "queued" }];
  const ready = fakePlan();
  ready.plate.cells = [{ k: 1, state: "ready", url: "/a" }, { k: 2, state: "ready", url: "/b" }];
  const answers = [building, building, ready];
  let calls = 0;
  const previewClient = { plan: async () => answers[Math.min(calls++, answers.length - 1)], destroy() {} };
  const store = createEditorStore({
    jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, api: createFakeApiClient(), previewClient,
    draftStore: { list: async () => [], put: async () => {}, delete: async () => {} },
    timers, channel: null, lifecycle: null, tabStorage: null, planPollMs: 500,
  });
  await store.ready;
  await timers.advance(0);
  assert.equal(calls, 1);
  assert.deepEqual(store.getState().pending, ["plate"]);
  await timers.advance(500);
  assert.equal(calls, 2);
  await timers.advance(500);
  assert.equal(calls, 3);
  assert.deepEqual(store.getState().pending, []);
  await timers.advance(5000);
  assert.equal(calls, 3, "no poll once everything is ready");
  store.destroy();
});

test("a store destroyed while it loads never joins the tab channel (no ghost 'other tab')", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = createFakeApiClient();
  const slowApi = { ...api, getEdit: async (options) => { await gate; return api.getEdit(options); } };
  const opened = [];
  const store = createEditorStore({
    jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, api: slowApi, previewClient: null,
    draftStore: { list: async () => [], put: async () => {}, delete: async () => {} },
    channel: (name) => { opened.push(name); return { postMessage() {}, close() {}, onmessage: null }; },
    lifecycle: null, tabStorage: null,
  });
  store.destroy(); // React StrictMode mounts, unmounts and mounts the editor in development
  release();
  await store.ready;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(opened, []);
});

// --- the real runtime (T2.6 → T2.Z wiring) -----------------------------------------------------------

test("the real runtime wires the A.2 modules: API client, preview client, store and player", async () => {
  const requests = [];
  const words = fakes.fakeWords();
  const doc = fakes.fakeDoc();
  const etag = "e".repeat(64);
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ?? null });
    if (String(url).endsWith("/edit")) return jsonResponse(200, { doc, etag, seed: true, words: { sha256: "a".repeat(64), url: `/api/jobs/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/words` } });
    if (String(url).endsWith("/words")) return jsonResponse(200, words);
    if (String(url).endsWith("/preview/plan")) return jsonResponse(200, fakePlan(doc));
    if (String(url).endsWith("/preview/frame")) return new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { "content-type": "image/png" } });
    return jsonResponse(404, { code: "not_found" });
  };
  const created = [];
  const runtime = await createEditorRuntime({
    kind: "real", jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID,
    deps: {
      fetchImpl,
      draftStore: { list: async () => [], put: async () => {}, delete: async () => {} },
      channel: null, lifecycle: null, tabStorage: null,
      createPlayer: (options) => { created.push(options); return { destroy() {} }; },
    },
  });
  assert.equal(runtime.kind, "real");
  await runtime.store.ready;
  assert.equal(runtime.store.getState().status, "ready");
  runtime.setPlayhead(42);
  runtime.createPlayer({ canvas: null, video: null, onState() {}, onFrame() {} });
  assert.equal(typeof created[0].requestTruthFrame, "function");
  const blob = await created[0].requestTruthFrame(3);
  assert.equal(blob.size, 2);
  const frameRequest = requests.find((item) => item.url.endsWith("/preview/frame"));
  assert.equal(JSON.parse(frameRequest.body).f, 3);
  assert.match(runtime.newKey(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  runtime.destroy();
});

// --- shell ↔ store shapes (T2.5 → T2.6) ---------------------------------------------------------------

test("the conflict dialog reads the store's groups (T2.5 shape) and the fakes' parts", () => {
  assert.deepEqual(conflictParts({ groups: [{ id: "g1", label: "Teks hook", parts: ["hook"], mine: "a", theirs: "b" }], error: null }),
    [{ id: "g1", label: "Teks hook" }]);
  assert.deepEqual(conflictParts({ parts: [{ id: "p", label: "Potongan 00:12" }] }), [{ id: "p", label: "Potongan 00:12" }]);
  assert.deepEqual(conflictParts(null), []);
});

test("another tab and the merge notice come from the store", () => {
  const notices = noticesView({ doc: null, playerMode: "live", otherTab: true });
  assert.deepEqual(notices.map((notice) => notice.code), ["other_tab"]);
});

test("the badge claims 'Sesuai hasil akhir' only when the player shows the playhead frame", () => {
  const plan = fakePlan();
  const current = { text: true, plate: true, audio: true, logo: true };
  assert.equal(badgeView({ status: "ready", plan, player: { mode: "live", current, playing: false, exact: true } }).tone, "exact");
  assert.equal(badgeView({ status: "ready", plan, player: { mode: "live", current, playing: false, exact: false } }).tone, "pending");
  assert.equal(badgeView({ status: "ready", plan, player: { mode: "live", current, playing: false } }).tone, "exact");
});

test("an unchanged legacy-engine clip never claims 'Sesuai hasil akhir': its export is the old auto file (R10)", () => {
  const plan = fakePlan();
  const current = { text: true, plate: true, audio: true, logo: true };
  const player = { mode: "live", current, playing: false, exact: true };
  // T2.3: rev0.planSha256 is the new engine's plan of the seed; exact is false for a legacy file.
  const legacyUnchanged = { ...plan, rev0: { planSha256: plan.planSha256, autoRenderUrl: "/api/jobs/x/files/output/clip-01.mp4", exact: false } };
  const view = badgeView({ status: "ready", plan: legacyUnchanged, player });
  assert.equal(view.tone, "legacy");
  assert.equal(view.text, "● Belum diubah: ekspor = klip otomatis (mesin lama)");
  const edited = { ...legacyUnchanged, rev0: { ...legacyUnchanged.rev0, planSha256: "f".repeat(64) } };
  assert.equal(badgeView({ status: "ready", plan: edited, player }).tone, "exact");
  const newEngine = { ...legacyUnchanged, rev0: { ...legacyUnchanged.rev0, exact: true } };
  assert.equal(badgeView({ status: "ready", plan: newEngine, player }).tone, "exact");
});

test("the fakes use the real CommandRejected, so instanceof holds after wiring (T2.5)", () => {
  assert.equal(fakes.CommandRejected, CommandRejected);
});

test("route codes have Indonesian messages mirrored from errors.py", () => {
  for (const code of ["backend_unavailable", "rate_limited", "csrf_rejected", "invalid_request", "superseded",
    "storage_quota_exhausted", "storage_free_space_low", "storage_admission_unavailable", "render_finished", "not_cancellable",
    "editor_disabled"]) {
    assert.ok(MESSAGES[code], code);
    assert.equal(messageFor(code), MESSAGES[code]);
  }
});

// --- headers and the proxy (plan §9.1) ----------------------------------------------------------------

test("the editor page is cross-origin isolated, nosniff and never framed", async () => {
  const rules = await nextConfig.headers();
  const rule = rules.find((entry) => entry.source === "/projects/:id/clips/:clipId/edit");
  assert.ok(rule, "a header rule for the editor page");
  const headers = Object.fromEntries(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
  assert.equal(headers["cross-origin-opener-policy"], "same-origin");
  assert.equal(headers["cross-origin-embedder-policy"], "require-corp");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  const include = nextConfig.outputFileTracingIncludes?.["/api/resources/[kind]/[name]"] ?? [];
  assert.ok(include.some((glob) => glob.includes("jassub/dist/wasm")), "the standalone build carries the JASSUB files");
});

test("every Editor V3 route is behind the proxy; only the job upload route bypasses it", () => {
  // Next's own matcher compilation, in a child (as web/tests/proxy-matcher.test.mjs does).
  const compiled = JSON.parse(execFileSync(process.execPath, ["-e", `
    const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
    process.stdout.write(JSON.stringify(getMiddlewareMatchers(JSON.parse(process.argv[1]), { i18n: null, basePath: "" })));
  `, JSON.stringify(proxyConfig.matcher)], { cwd: webRoot, encoding: "utf8" }));
  const matcher = { test: (pathname) => compiled.some((entry) => new RegExp(entry.regexp).test(pathname)) };
  const job = FAKE_JOB_ID;
  const clip = FAKE_CLIP_ID;
  for (const route of [
    `/projects/${job}/clips/${clip}/edit`,
    `/api/jobs/${job}/clips`, `/api/jobs/${job}/clips/${clip}/edit`, `/api/jobs/${job}/clips/${clip}/words`,
    `/api/jobs/${job}/clips/${clip}/renders`, `/api/jobs/${job}/renders/${RID}`,
    `/api/jobs/${job}/clips/${clip}/prepare`, `/api/jobs/${job}/clips/${clip}/preview/plan`,
    `/api/jobs/${job}/clips/${clip}/preview/frame`, `/api/jobs/${job}/clips/${clip}/media/plates/0123456789abcdef-c0000001.mp4`,
    "/api/resources/fonts/DejaVuSans.ttf", "/api/resources/jassub/jassub-worker.js",
  ]) {
    assert.ok(matcher.test(route), route);
  }
  assert.equal(matcher.test("/api/jobs"), false);
});
