// T2.6: the export dialog's state machine (plan Appendix C.5, §4.2 renders routes, §4.6 states)
// in web/components/editor/export-flow.mjs, driven with a manual clock.
import assert from "node:assert/strict";
import test from "node:test";

import { MESSAGES } from "../components/editor/shell-model.mjs";
import {
  EXPORT_STEPS,
  canStartExport,
  createExportFlow,
  earlierExports,
  exportStepView,
} from "../components/editor/export-flow.mjs";

const ETAG = "e".repeat(64);

function manualTimers() {
  let queue = [];
  return {
    setTimer: (fn, ms) => { const handle = { fn, ms }; queue.push(handle); return handle; },
    clearTimer: (handle) => { queue = queue.filter((item) => item !== handle); },
    pending: () => queue.length,
    async fire() {
      const due = queue;
      queue = [];
      for (const item of due) await item.fn();
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function fakeStore({ save = "dirty", etag = ETAG, revision = 3 } = {}) {
  let state = { save, etag, doc: { revision } };
  return {
    flushes: 0,
    async flush() { this.flushes += 1; state = { ...state, save: state.save === "dirty" ? "saved" : state.save }; },
    getState: () => state,
    set(patch) { state = { ...state, ...patch }; },
  };
}

function dto(fields = {}) {
  return { renderId: "r1", clipId: "clip_9b2e41c07d3a5f18e6c2a0b4", state: "queued", stage: "antre", progressPm: 0,
    revision: 3, errorCode: null, resultUrl: null, srtUrl: null, ...fields };
}

function scriptedApi(sequence, { create = () => dto() } = {}) {
  const calls = [];
  let step = 0;
  return {
    calls,
    async createRender(body, key) { calls.push(["createRender", body, key]); return create(body, key); },
    async getRender(id) {
      calls.push(["getRender", id]);
      const next = sequence[Math.min(step, sequence.length - 1)];
      step += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async cancelRender(id) { calls.push(["cancelRender", id]); return dto({ renderId: id, state: "cancelled", stage: "antre" }); },
  };
}

function flowWith(api, store, timers, keys = ["k-1", "k-2", "k-3"]) {
  const changes = [];
  let index = 0;
  const flow = createExportFlow({
    api, store, pollMs: 1000, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    newKey: () => keys[index++], now: () => 1_790_000_000_000 + index, onChange: (state) => changes.push(state.phase),
  });
  return { flow, changes };
}

test("the steps are Antre, Merender, Memverifikasi, Selesai", () => {
  assert.deepEqual(EXPORT_STEPS.map((step) => step.label), ["Antre", "Merender", "Memverifikasi", "Selesai"]);
});

test("start flushes autosave, then enqueues the saved etag with a fresh key", async () => {
  const timers = manualTimers();
  const store = fakeStore();
  const api = scriptedApi([dto({ state: "rendering", stage: "merender", progressPm: 450 })]);
  const { flow, changes } = flowWith(api, store, timers);
  assert.equal(flow.getState().phase, "idle");
  await flow.start();
  assert.equal(store.flushes, 1);
  assert.deepEqual(api.calls[0], ["createRender", { editEtag: ETAG }, "k-1"]);
  assert.equal(flow.getState().phase, "running");
  assert.deepEqual(changes.slice(0, 3), ["saving", "submitting", "running"]);
  assert.equal(timers.pending(), 1, "polls while running");
});

test("polling follows the stages to completion and records the export", async () => {
  const timers = manualTimers();
  const api = scriptedApi([
    dto({ state: "rendering", stage: "merender", progressPm: 300 }),
    dto({ state: "rendering", stage: "memverifikasi", progressPm: 1000 }),
    dto({ state: "completed", stage: "selesai", progressPm: 1000, resultUrl: "/api/jobs/j/files/output/edits/c/a.mp4", srtUrl: "/api/jobs/j/files/output/edits/c/a.srt" }),
  ]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  assert.equal(exportStepView(flow.getState().render).text, "Antre");
  await timers.fire();
  assert.equal(exportStepView(flow.getState().render).text, "Merender (30%)");
  await timers.fire();
  assert.equal(exportStepView(flow.getState().render).text, "Memverifikasi");
  await timers.fire();
  const state = flow.getState();
  assert.equal(state.phase, "completed");
  assert.equal(timers.pending(), 0, "no polling after a terminal state");
  assert.equal(state.render.resultUrl, "/api/jobs/j/files/output/edits/c/a.mp4");
  assert.equal(state.history.length, 1);
  assert.deepEqual({ ...state.history[0], atMs: 0 }, { renderId: "r1", revision: 3, state: "completed", atMs: 0,
    resultUrl: "/api/jobs/j/files/output/edits/c/a.mp4", srtUrl: "/api/jobs/j/files/output/edits/c/a.srt" });
});

test("an unchanged document completes at once (R10) without polling", async () => {
  const timers = manualTimers();
  const api = scriptedApi([], { create: () => dto({ state: "completed", stage: "selesai", progressPm: 1000, resultUrl: "/a.mp4", srtUrl: "/a.srt" }) });
  const { flow } = flowWith(api, fakeStore({ save: "saved" }), timers);
  await flow.start();
  assert.equal(flow.getState().phase, "completed");
  assert.equal(timers.pending(), 0);
  assert.deepEqual(exportStepView(flow.getState().render).steps.map((step) => step.status), ["done", "done", "done", "done"]);
});

test("cancel while rendering asks the server and stops polling", async () => {
  const timers = manualTimers();
  const api = scriptedApi([dto({ state: "rendering", stage: "merender", progressPm: 200 })]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  await timers.fire();
  await flow.cancel();
  assert.deepEqual(api.calls.at(-1), ["cancelRender", "r1"]);
  assert.equal(flow.getState().phase, "cancelled");
  assert.equal(flow.getState().errorText, MESSAGES.cancelled);
  assert.equal(timers.pending(), 0);
});

test("cancel before the request exists cancels it as soon as it is created", async () => {
  const timers = manualTimers();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = scriptedApi([], { create: async () => { await gate; return dto(); } });
  const { flow } = flowWith(api, fakeStore(), timers);
  const started = flow.start();
  await settle();
  assert.equal(flow.getState().phase, "submitting");
  const cancelled = flow.cancel();
  assert.equal(flow.getState().cancelling, true);
  release();
  await started;
  await cancelled;
  await settle();
  assert.deepEqual(api.calls.map((call) => call[0]), ["createRender", "cancelRender"]);
  assert.equal(flow.getState().phase, "cancelled");
});

test("a verification failure explains itself and a retry is a new request", async () => {
  const timers = manualTimers();
  const api = scriptedApi([dto({ state: "failed", stage: "memverifikasi", errorCode: "verification_failed" })]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  await timers.fire();
  assert.equal(flow.getState().phase, "failed");
  assert.equal(flow.getState().errorCode, "verification_failed");
  assert.equal(flow.getState().errorText, "Hasil render tidak lolos pemeriksaan mutu");
  await flow.retry();
  assert.deepEqual(api.calls.filter((call) => call[0] === "createRender").map((call) => call[2]), ["k-1", "k-2"]);
});

test("a network failure while enqueuing retries with the same idempotency key", async () => {
  const timers = manualTimers();
  let attempts = 0;
  const api = scriptedApi([dto({ state: "rendering", stage: "merender" })], {
    create: () => { attempts += 1; if (attempts === 1) throw new TypeError("fetch failed"); return dto(); },
  });
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  assert.equal(flow.getState().phase, "error");
  assert.equal(flow.getState().errorCode, "network");
  await flow.retry();
  assert.deepEqual(api.calls.filter((call) => call[0] === "createRender").map((call) => call[2]), ["k-1", "k-1"]);
  assert.equal(flow.getState().phase, "running");
});

test("an HTTP error names its code; an unsaved document never exports", async () => {
  const timers = manualTimers();
  const failing = scriptedApi([], { create: () => { const error = new Error("503"); error.status = 503; error.code = "storage_full"; throw error; } });
  const first = flowWith(failing, fakeStore(), timers).flow;
  await first.start();
  assert.equal(first.getState().phase, "error");
  assert.equal(first.getState().errorCode, "storage_full");
  const store = fakeStore({ save: "error" });
  const api = scriptedApi([]);
  const second = flowWith(api, store, timers).flow;
  await second.start();
  assert.equal(second.getState().phase, "error");
  assert.equal(second.getState().errorCode, "save_failed");
  assert.equal(api.calls.length, 0);
  const conflicted = flowWith(api, fakeStore({ save: "conflict" }), timers).flow;
  await conflicted.start();
  assert.equal(conflicted.getState().errorCode, "save_failed");
});

test("transient poll errors keep polling; five in a row stop with a network error", async () => {
  const timers = manualTimers();
  const offline = new TypeError("fetch failed");
  const api = scriptedApi([dto({ state: "rendering" }), offline, dto({ state: "rendering", stage: "merender", progressPm: 500 }),
    offline, offline, offline, offline, offline]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  await timers.fire();
  await timers.fire();
  assert.equal(flow.getState().phase, "running");
  await timers.fire();
  assert.equal(exportStepView(flow.getState().render).text, "Merender (50%)");
  for (let i = 0; i < 5; i += 1) await timers.fire();
  assert.equal(flow.getState().phase, "error");
  assert.equal(flow.getState().errorCode, "network");
  assert.equal(timers.pending(), 0);
});

test("reset returns a finished flow to idle and keeps its history; a running flow is untouched", async () => {
  const timers = manualTimers();
  const api = scriptedApi([dto({ state: "completed", stage: "selesai", resultUrl: "/a.mp4", srtUrl: "/a.srt" })]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  flow.reset();
  assert.equal(flow.getState().phase, "running", "never resets a render in flight");
  await timers.fire();
  assert.equal(flow.getState().phase, "completed");
  flow.reset();
  assert.equal(flow.getState().phase, "idle");
  assert.equal(flow.getState().render, null);
  assert.equal(flow.getState().history.length, 1);
  await flow.start();
  assert.deepEqual(api.calls.filter((call) => call[0] === "createRender").map((call) => call[2]), ["k-1", "k-2"]);
});

test("destroy stops timers and ignores late answers", async () => {
  const timers = manualTimers();
  const api = scriptedApi([dto({ state: "rendering" })]);
  const { flow, changes } = flowWith(api, fakeStore(), timers);
  await flow.start();
  flow.destroy();
  assert.equal(timers.pending(), 0);
  const before = changes.length;
  await timers.fire();
  assert.equal(changes.length, before);
});

test("the step view marks done, current and upcoming stages", () => {
  assert.deepEqual(exportStepView(dto({ state: "queued", stage: "antre" })).steps.map((step) => step.status),
    ["current", "todo", "todo", "todo"]);
  assert.deepEqual(exportStepView(dto({ state: "rendering", stage: "merender", progressPm: 999 })).steps.map((step) => step.status),
    ["done", "current", "todo", "todo"]);
  assert.equal(exportStepView(dto({ state: "rendering", stage: "merender", progressPm: 999 })).text, "Merender (99%)");
  assert.equal(exportStepView(dto({ state: "claimed", stage: null })).text, "Antre");
  assert.equal(exportStepView(dto({ state: "rendering", stage: null, progressPm: 10 })).text, "Merender (1%)");
  assert.equal(exportStepView(null).text, "");
});

test("export starts only when every check is acknowledged and nothing blocks", () => {
  const checks = [{ key: "a", severity: "warning" }, { key: "b", severity: "warning" }];
  assert.equal(canStartExport(checks, new Set()), false);
  assert.equal(canStartExport(checks, new Set(["a"])), false);
  assert.equal(canStartExport(checks, new Set(["a", "b"])), true);
  assert.equal(canStartExport([], new Set()), true);
  assert.equal(canStartExport([{ key: "x", severity: "error" }], new Set(["x"])), false);
});

test("after a cancel or a failure the steps stay where the render stopped (W2 verifier)", async () => {
  const timers = manualTimers();
  const api = scriptedApi([dto({ state: "rendering", stage: "merender", progressPm: 450 })]);
  const { flow } = flowWith(api, fakeStore(), timers);
  await flow.start();
  await timers.fire();
  await flow.cancel();
  const state = flow.getState();
  assert.equal(state.phase, "cancelled");
  assert.equal(state.render.stage, "antre"); // the server's cancelled request
  const view = exportStepView(state.render, state.lastRunning);
  assert.deepEqual(view.steps.map((step) => step.status), ["done", "stopped", "todo", "todo"]);
  assert.equal(view.text, "Merender (45%)");
  assert.equal(view.steps[1].text, "Merender (45%)");
  // a request cancelled before it ran stays at Antre
  assert.deepEqual(exportStepView(dto({ state: "cancelled", stage: "antre" }), null).steps.map((step) => step.status),
    ["stopped", "todo", "todo", "todo"]);
  // a completed render is never "stopped"
  assert.deepEqual(exportStepView(dto({ state: "completed", stage: "selesai", progressPm: 1000 }), state.lastRunning)
    .steps.map((step) => step.status), ["done", "done", "done", "done"]);
});

test("the running export is not listed under earlier exports; a finished one is", () => {
  const running = { renderId: "r2", revision: 4, state: "rendering", atMs: 2, resultUrl: null, srtUrl: null };
  const done = { renderId: "r1", revision: 3, state: "completed", atMs: 1, resultUrl: "/api/x.mp4", srtUrl: null };
  const latest = { renderId: "r0", revision: 1, state: "completed", url: "/api/y.mp4", srtUrl: null };
  assert.deepEqual(earlierExports({ history: [running, done], current: { renderId: "r2", state: "rendering" }, latest })
    .map((item) => item.renderId), ["r1", "r0"]);
  assert.deepEqual(earlierExports({ history: [{ ...running, state: "completed" }, done],
    current: { renderId: "r2", state: "completed" }, latest: null }).map((item) => item.renderId), ["r2", "r1"]);
  assert.deepEqual(earlierExports({ history: [], current: null, latest: { ...latest, renderId: "r0", state: "rendering" } })
    .map((item) => [item.renderId, item.state]), [["r0", "rendering"]]);
  assert.deepEqual(earlierExports({ history: [done], current: null, latest: { ...latest, renderId: "r1" } })
    .map((item) => item.renderId), ["r1"]);
  assert.deepEqual(earlierExports({ history: [], current: { renderId: "r0", state: "queued" }, latest }), []);
});
