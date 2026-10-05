// Work that outlives a card (docs/plans/2026-10-02-editor-mode-cepat.md §4.1, AC16): the face
// analysis of `layoutAnalysisFor(clipId)` and the music upload of `musicUploadFor(clipId)` are
// per-clip stores, so closing a card or switching views never drops them. A finished run applies
// its command through the dispatch it was started with, whoever is subscribed; a newer run or
// choice supersedes it; a failure sets the message and sends no command.
import assert from "node:assert/strict";
import test from "node:test";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  analysisBusy,
  analysisForView,
  createLayoutAnalysis,
  layoutAnalysisFor,
} from "../components/editor/panels/layout-analysis.mjs";
import { musicCommands } from "../components/editor/panels/music-model.mjs";
import {
  MUSIC_NAMES_KEY,
  MUSIC_NOTICE_KEY,
  createMusicUpload,
  markMusicNoticeRead,
  musicNoticeRead,
  musicUploadFor,
  storedMusicNames,
} from "../components/editor/panels/music-upload.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

/** Manual timers: `advance(ms)` runs what is due, in order. */
function clock() {
  let now = 1_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await tick();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A store stand-in: the document, and every command dispatched to it. */
function shellStore(doc = fakeDoc()) {
  const state = { status: "ready", jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, doc };
  const sent = [];
  return {
    sent,
    getState: () => state,
    dispatch(type, args, options = {}) {
      sent.push({ type, args, mergeKey: options.mergeKey ?? null });
      if (type === "SetLayout") state.doc = { ...state.doc, layout: { ...state.doc.layout, default: { ...state.doc.layout.default, mode: args.mode } } };
    },
  };
}

function cameraApi({ progress = null } = {}) {
  const calls = [];
  const runs = [];
  const api = {
    calls,
    runs,
    prepare(options) {
      calls.push(["prepare", options]);
      const run = deferred();
      runs.push(run);
      return run.promise;
    },
  };
  if (progress) {
    api.cameraProgress = async () => {
      calls.push(["cameraProgress"]);
      return progress();
    };
  }
  return api;
}

function analysis(timers) {
  return createLayoutAnalysis({ now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
}

// --- layoutAnalysisFor -----------------------------------------------------------------------------

test("one analysis store per clip, kept for the page", () => {
  const first = layoutAnalysisFor("clip_a");
  assert.equal(layoutAnalysisFor("clip_a"), first);
  assert.notEqual(layoutAnalysisFor("clip_b"), first);
  assert.equal(layoutAnalysisFor(null), null);
  assert.equal(layoutAnalysisFor(""), null);
  assert.deepEqual(first.get(), {
    phase: "idle", startedAt: null, done: null, total: null, target: null, message: null, code: null, range: null, cameraReady: false,
  });
});

test("a run that finishes with no subscriber applies SetLayout once, through the dispatch it was started with", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const seen = [];
  const unsubscribe = store.subscribe(() => seen.push(store.get().phase));
  const done = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(store.get().phase, "starting");
  assert.equal(store.get().target, "camera");
  assert.ok(analysisBusy(store.get()));
  assert.deepEqual(store.get().range, { minMs: 5000, maxMs: 15000 }, "the usual length of this clip's window (189 s)");
  await timers.advance(250);
  assert.equal(store.get().phase, "running", "shown after 250 ms, so an existing plan does not flicker");
  unsubscribe(); // the card closes, the view switches: nobody listens
  api.runs[0].resolve({ camera: "ready" });
  await done;
  assert.deepEqual(shell.sent, [{ type: "SetLayout", args: { mode: "camera" }, mergeKey: null }]);
  assert.equal(store.get().phase, "idle");
  assert.equal(store.get().target, null);
  assert.equal(store.get().cameraReady, true);
  assert.deepEqual(seen, ["starting", "running"]);
  assert.deepEqual(api.calls, [["prepare", { layout: "camera" }]]);
  assert.equal(timers.pending(), 0, "no timer outlives the run");
});

test("the server's progress fills done/total while the run is on", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  let done = 0;
  const api = cameraApi({ progress: () => ({ state: "building", done, total: 240 }) });
  const finished = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  done = 60;
  await timers.advance(250);
  assert.deepEqual([store.get().done, store.get().total], [60, 240]);
  done = 180;
  await timers.advance(500);
  assert.deepEqual([store.get().done, store.get().total], [180, 240]);
  assert.deepEqual(analysisForView(store.get()), { state: "running", startedAt: 1_000, done: 180, total: 240, range: store.get().range });
  api.runs[0].resolve({ camera: "ready" });
  await finished;
  assert.equal(analysisForView(store.get()), null);
  const polls = api.calls.filter((call) => call[0] === "cameraProgress").length;
  await timers.advance(2_000);
  assert.equal(api.calls.filter((call) => call[0] === "cameraProgress").length, polls, "the poll ends with the run");
});

test("a newer choice supersedes the switch: the run finishes in the background and sends nothing", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const finished = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  await timers.advance(250);
  store.cancelSwitch();
  assert.equal(store.get().phase, "idle");
  assert.equal(store.get().target, null);
  api.runs[0].resolve({ camera: "ready" });
  await finished;
  assert.deepEqual(shell.sent, []);
  assert.equal(store.get().cameraReady, true, "the plan exists now, so the next face-track choice needs no analysis");
});

test("a newer run supersedes the older one: only the newer applies", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const first = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  store.cancelSwitch();
  const second = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  api.runs[0].resolve({ camera: "ready" });
  await first;
  assert.deepEqual(shell.sent, [], "the older run's answer is not the newer run's");
  assert.equal(store.get().phase, "starting");
  api.runs[1].resolve({ camera: "ready" });
  await second;
  assert.deepEqual(shell.sent, [{ type: "SetLayout", args: { mode: "camera" }, mergeKey: null }]);
});

test("choosing face-track again while it is on its way starts nothing new", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const first = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  const again = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(api.calls.length, 1);
  api.runs[0].resolve({ camera: "ready" });
  await Promise.all([first, again]);
  assert.equal(shell.sent.length, 1);
});

test("a failure sets the message and no command; Coba lagi starts a fresh run", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const failed = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  api.runs[0].reject(Object.assign(new Error("down"), { code: "backend_unavailable" }));
  await failed;
  assert.equal(store.get().phase, "failed");
  assert.equal(store.get().code, "backend_unavailable");
  assert.match(store.get().message, /^Analisis wajah gagal: /);
  assert.deepEqual(analysisForView(store.get()), { state: "failed", code: "backend_unavailable" });
  assert.deepEqual(shell.sent, []);
  assert.equal(analysisBusy(store.get()), false);
  const retry = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(store.get().message, null);
  api.runs[1].resolve({ camera: "ready" });
  await retry;
  assert.deepEqual(shell.sent.map((entry) => entry.type), ["SetLayout"]);
});

test("a camera that is not ready, or no prepare at all, is a failure", async () => {
  const timers = clock();
  const shell = shellStore();
  const notReady = analysis(timers);
  const api = cameraApi();
  const run = notReady.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  api.runs[0].resolve({ camera: "building" });
  await run;
  assert.equal(notReady.get().code, "analysis_missing");
  const none = analysis(timers);
  await none.start({ api: null, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(none.get().code, "backend_unavailable");
  assert.deepEqual(shell.sent, []);
});

test("without switchAfter (a face-track document missing its plan) the run applies nothing and runs once per clip", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore({ ...fakeDoc(), layout: { default: { mode: "camera", no_face: "center" } } });
  const api = cameraApi();
  const run = store.start({ api, dispatch: shell.dispatch, getState: shell.getState, switchAfter: false, auto: true });
  assert.equal(store.get().target, null);
  await store.start({ api, dispatch: shell.dispatch, getState: shell.getState, switchAfter: false, auto: true });
  assert.equal(api.calls.length, 1, "the automatic analysis is tried once");
  api.runs[0].resolve({ camera: "ready" });
  await run;
  assert.deepEqual(shell.sent, []);
  assert.equal(store.get().cameraReady, true);
});

test("a document already on face-track when the run ends gets no second SetLayout", async () => {
  const timers = clock();
  const store = analysis(timers);
  const shell = shellStore();
  const api = cameraApi();
  const run = store.start({ api, dispatch: shell.dispatch, getState: shell.getState });
  shell.dispatch("SetLayout", { mode: "camera" }); // e.g. Ulangi brought it back meanwhile
  api.runs[0].resolve({ camera: "ready" });
  await run;
  assert.deepEqual(shell.sent.map((entry) => entry.args.mode), ["camera"]);
});

test("a refused switch keeps the layout and says why", async () => {
  const timers = clock();
  const store = analysis(timers);
  const api = cameraApi();
  const state = { status: "ready", doc: fakeDoc() };
  const dispatch = () => { throw Object.assign(new Error("read only"), { code: "read_only" }); };
  const run = store.start({ api, dispatch, getState: () => state });
  api.runs[0].resolve({ camera: "ready" });
  await run;
  assert.equal(store.get().phase, "idle");
  assert.equal(typeof store.get().message, "string");
  assert.ok(store.get().message.length > 0);
  store.clearMessage();
  assert.equal(store.get().message, null);
});

// --- musicUploadFor --------------------------------------------------------------------------------

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

const throwingStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

function musicFile(name = "lagu.m4a", { size = 4096, type = "audio/mp4" } = {}) {
  return { name, size, type };
}

/** An upload the test drives: `steps` are the progress values it reports before answering. */
function scriptedUpload() {
  const calls = [];
  let current = null;
  const upload = (jobId, file, kind, { onProgress, signal }) => {
    calls.push({ jobId, name: file.name, kind });
    current = { onProgress, signal, run: deferred() };
    signal?.addEventListener?.("abort", () => current.run.reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    return current.run.promise;
  };
  return { upload, calls, progress: (value) => current.onProgress(value), answer: (dto) => current.run.resolve(dto),
    fail: (error) => current.run.reject(error) };
}

const MUSIC_DTO = { sha256: "c".repeat(64), kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 95_000, lufsC: -1620,
  peaksUrl: `/api/jobs/${FAKE_JOB_ID}/assets/${"c".repeat(64)}?part=peaks` };
const OTHER_DTO = { ...MUSIC_DTO, sha256: "d".repeat(64), peaksUrl: `/api/jobs/${FAKE_JOB_ID}/assets/${"d".repeat(64)}?part=peaks` };

test("one music upload store per clip, kept for the page", () => {
  const first = musicUploadFor("clip_a");
  assert.equal(musicUploadFor("clip_a"), first);
  assert.notEqual(musicUploadFor("clip_b"), first);
  assert.equal(musicUploadFor(undefined), null);
  assert.equal(first.get().phase, "idle");
});

test("music: progress, then the finished upload applies SetMusic once, with no subscriber", async () => {
  const storage = memoryStorage();
  const store = createMusicUpload({ storage });
  const shell = shellStore();
  const script = scriptedUpload();
  const phases = [];
  const unsubscribe = store.subscribe(() => phases.push([store.get().phase, store.get().progress]));
  const done = store.start({ file: musicFile(), jobId: FAKE_JOB_ID, upload: script.upload, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(store.get().phase, "uploading");
  assert.equal(store.get().name, "lagu.m4a");
  assert.ok(store.busy());
  await tick();
  script.progress(0.5);
  assert.deepEqual([store.get().phase, store.get().progress], ["uploading", 0.5]);
  script.progress(1);
  assert.equal(store.get().phase, "processing");
  unsubscribe(); // the card closes before the server answers
  script.answer(MUSIC_DTO);
  await done;
  assert.deepEqual(shell.sent, musicCommands.add(MUSIC_DTO).map(({ type, args, mergeKey }) => ({ type, args, mergeKey })));
  assert.equal(shell.sent.length, 1);
  assert.equal(store.get().phase, "idle");
  assert.equal(store.get().message, null);
  assert.equal(store.get().names[`sha256:${"c".repeat(64)}`], "lagu.m4a");
  assert.deepEqual(JSON.parse(storage.data.get(MUSIC_NAMES_KEY)), { [`sha256:${"c".repeat(64)}`]: "lagu.m4a" });
  assert.deepEqual(script.calls, [{ jobId: FAKE_JOB_ID, name: "lagu.m4a", kind: "music" }]);
  assert.deepEqual(phases.slice(0, 3), [["uploading", 0], ["uploading", 0.5], ["processing", 1]]);
});

test("music: a replacement applies to the document as it is when the file arrives", async () => {
  const store = createMusicUpload({ storage: memoryStorage() });
  const shell = shellStore();
  const script = scriptedUpload();
  const done = store.start({ file: musicFile("baru.mp3", { type: "audio/mpeg" }), jobId: FAKE_JOB_ID, upload: script.upload,
    dispatch: shell.dispatch, getState: shell.getState, replace: true });
  // Meanwhile the clip got music with its loop off: the replacement keeps that loop.
  const ctx = createContext({ words: fakeWords(), seed: fakeDoc() });
  const apply = (doc, commands) => commands.reduce((current, command) => applyCommand(current, command.type, command.args, ctx).doc, doc);
  const later = apply(apply(fakeDoc(), musicCommands.add(OTHER_DTO)), musicCommands.loop(false));
  shell.getState().doc = later;
  script.answer(MUSIC_DTO);
  await done;
  const expected = musicCommands.replace(later, MUSIC_DTO);
  assert.deepEqual(shell.sent.map(({ type, args }) => ({ type, args })), expected.map(({ type, args }) => ({ type, args })));
  assert.deepEqual(shell.sent.map((entry) => entry.type), ["SetMusic", "SetMusicLoop"]);
  assert.equal(new Set(shell.sent.map((entry) => entry.mergeKey)).size, 1, "one undo step");
});

test("music: cancel stops the upload, applies nothing and says so", async () => {
  const store = createMusicUpload({ storage: memoryStorage() });
  const shell = shellStore();
  const script = scriptedUpload();
  const done = store.start({ file: musicFile(), jobId: FAKE_JOB_ID, upload: script.upload, dispatch: shell.dispatch, getState: shell.getState });
  await tick();
  store.cancel();
  await done;
  assert.deepEqual(shell.sent, []);
  assert.equal(store.get().phase, "idle");
  assert.deepEqual(store.get().message, { tone: "info", text: "Unggahan dibatalkan." });
  assert.equal(store.busy(), false);
});

test("music: a file the browser can refuse never starts; a server refusal is an error message", async () => {
  const store = createMusicUpload({ storage: memoryStorage() });
  const shell = shellStore();
  const script = scriptedUpload();
  await store.start({ file: musicFile("lagu.txt", { type: "text/plain" }), jobId: FAKE_JOB_ID, upload: script.upload,
    dispatch: shell.dispatch, getState: shell.getState });
  assert.deepEqual(store.get().message, { tone: "error", text: "Format ini tidak didukung. Pakai MP3, M4A, WAV, OGG atau FLAC." });
  assert.deepEqual(script.calls, []);
  const done = store.start({ file: musicFile(), jobId: FAKE_JOB_ID, upload: script.upload, dispatch: shell.dispatch, getState: shell.getState });
  assert.equal(store.get().message, null);
  script.fail(Object.assign(new Error("too long"), { status: 422, code: "asset_too_long" }));
  await done;
  assert.deepEqual(store.get().message, { tone: "error", text: "Musik paling panjang 15 menit. Potong lagunya lalu unggah lagi." });
  assert.deepEqual(shell.sent, []);
});

test("music: one upload at a time; a refused SetMusic is the message", async () => {
  const store = createMusicUpload({ storage: memoryStorage() });
  const script = scriptedUpload();
  const state = { status: "ready", doc: fakeDoc() };
  const dispatch = () => { throw Object.assign(new Error("Klip ini hanya bisa dibaca."), { code: "read_only" }); };
  const done = store.start({ file: musicFile(), jobId: FAKE_JOB_ID, upload: script.upload, dispatch, getState: () => state });
  assert.equal(await store.start({ file: musicFile("dua.m4a"), jobId: FAKE_JOB_ID, upload: script.upload, dispatch, getState: () => state }), false);
  assert.equal(script.calls.length, 1);
  script.answer(MUSIC_DTO);
  await done;
  assert.deepEqual(store.get().message, { tone: "error", text: "Klip ini hanya bisa dibaca." });
  assert.deepEqual(store.get().names, {}, "no name for music that was not applied");
});

test("the copyright notice and the file names are per viewer and survive blocked storage", () => {
  const storage = memoryStorage({ [MUSIC_NAMES_KEY]: JSON.stringify({ "sha256:aa": "lama.mp3" }) });
  assert.equal(MUSIC_NOTICE_KEY, "potongin-editor-music-notice");
  assert.equal(musicNoticeRead(storage), false);
  markMusicNoticeRead(storage);
  assert.equal(musicNoticeRead(storage), true);
  assert.deepEqual(storedMusicNames(storage), { "sha256:aa": "lama.mp3" });
  assert.deepEqual(createMusicUpload({ storage }).get().names, { "sha256:aa": "lama.mp3" });
  assert.equal(musicNoticeRead(throwingStorage), false);
  assert.doesNotThrow(() => markMusicNoticeRead(throwingStorage));
  assert.deepEqual(storedMusicNames(throwingStorage), {});
  assert.deepEqual(storedMusicNames(memoryStorage({ [MUSIC_NAMES_KEY]: "not json" })), {});
  assert.deepEqual(storedMusicNames(null), {});
});
