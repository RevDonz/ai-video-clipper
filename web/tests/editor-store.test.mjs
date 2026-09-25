// The editor store (web/lib/editor/store.mjs, Appendix A.2) and its IO: the API client, the
// preview client and the flags. Plan §4.5: every command goes to the undoable session, the draft
// and autosave; a 409 rebases (auto-merge or the per-part dialog); a draft is restored on open
// (same etag: silently; older etag: rebased); read-only clips offer "Mulai dari versi AI".
import assert from "node:assert/strict";
import test from "node:test";

import { createFakeApiClient } from "../components/editor/__dev__/fakes.mjs";
import { createFakeServer, loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { ApiError, createApiClient } from "../lib/editor/api-client.mjs";
import { CommandRejected } from "../lib/editor/commands.mjs";
import { body, coldOpen, contentJson, hookItem } from "../lib/editor/doc-model.mjs";
import { createMemoryDraftStore } from "../lib/editor/draft-store.mjs";
import { EDITOR_FLAGS, readEditorFlags } from "../lib/editor/flags.mjs";
import { PREVIEW_DEBOUNCE_MS, createPreviewClient } from "../lib/editor/preview-client.mjs";
import { createEditorStore } from "../lib/editor/store.mjs";

const C30 = loadContext("c30");
const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const RENDER = "5b0f9a52-1d2c-4e8f-9a3b-7c6d5e4f3a21";
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock(start = 0) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        for (let i = 0; i < 5; i += 1) await settle();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      for (let i = 0; i < 5; i += 1) await settle();
    },
  };
}

let keys = 0; // one counter for every store of the file: Idempotency-Keys are unique like UUIDs

function setup({ context = C30, server = createFakeServer(context), draftStore = createMemoryDraftStore(), previewClient = null,
  channel = null, lifecycle = null, clock = fakeClock(1_000_000) } = {}) {
  const options = {
    jobId: server.jobId, clipId: server.clipId, api: server.api, previewClient, draftStore, now: clock.now,
    newKey: () => `00000000-0000-4000-8000-${String((keys += 1)).padStart(12, "0")}`,
    timers: { setTimeout: clock.setTimer, clearTimeout: clock.clearTimer }, channel, lifecycle,
  };
  return { store: createEditorStore(options), server, clock, draftStore, options };
}

function bodyWords(context = C30) {
  const seg = body(context.seed);
  return context.ctx.wordList.filter((_word, index) => {
    const mid = context.ctx.midSf(index);
    return mid >= seg.in_sf && mid < seg.out_sf;
  });
}

// --- store ---------------------------------------------------------------------------------

test("opens revision 0 as the seed", async () => {
  const { store, server } = setup();
  assert.equal(store.getState().status, "loading");
  await store.ready;
  const state = store.getState();
  assert.equal(state.status, "ready");
  assert.equal(contentJson(state.doc), contentJson(C30.seed));
  assert.equal(contentJson(state.seed), contentJson(C30.seed));
  assert.equal(state.etag, server.seedEtag);
  assert.equal(state.revision, 0);
  assert.equal(state.words.schema, "potongin.words/1");
  assert.equal(state.save, "saved");
  assert.equal(state.canUndo, false);
  assert.deepEqual(state.commands, []);
  assert.deepEqual(server.gets, [{ seed: false }]);
  store.destroy();
});

test("analysis_missing prepares the clip, then opens it", async () => {
  const server = createFakeServer(C30);
  server.analysisMissing = true;
  const { store } = setup({ server });
  await store.ready;
  assert.equal(server.prepares, 1);
  assert.equal(store.getState().status, "ready");
  store.destroy();
});

test("an edited clip also loads its seed (?seed=1) for 'Kembali ke versi AI'", async () => {
  const server = createFakeServer(C30);
  server.seedInline = false;
  server.otherTab([["SetLayout", { mode: "camera" }]]);
  const { store } = setup({ server });
  await store.ready;
  assert.deepEqual(server.gets, [{ seed: false }, { seed: true }]);
  assert.equal(store.getState().doc.layout.default.mode, "camera");
  assert.equal(contentJson(store.getState().seed), contentJson(C30.seed));
  assert.equal(store.getState().revision, 1);
  store.dispatch("ResetToSeed", {});
  assert.equal(contentJson(store.getState().doc), contentJson(C30.seed));
  store.destroy();
});

test("dispatch, undo and redo update the state; a rejected command changes nothing", async () => {
  const { store } = setup();
  await store.ready;
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state.save));
  store.dispatch("SetLayout", { mode: "camera" });
  let state = store.getState();
  assert.equal(state.doc.layout.default.mode, "camera");
  assert.equal(state.save, "dirty");
  assert.equal(state.canUndo, true);
  assert.equal(state.commands.length, 1);
  assert.throws(() => store.dispatch("SetHookY", { y_e5: 1 }), (error) => error instanceof CommandRejected && error.code === "value_out_of_range");
  assert.equal(store.getState().doc, state.doc);
  store.undo();
  state = store.getState();
  assert.equal(state.doc.layout.default.mode, "fit_blur");
  assert.equal(state.canRedo, true);
  assert.equal(state.save, "saved", "back at the saved document");
  store.redo();
  assert.equal(store.getState().doc.layout.default.mode, "camera");
  assert.ok(seen.includes("dirty"));
  unsubscribe();
  store.destroy();
});

test("autosave PUTs revision + 1 with If-Match and an Idempotency-Key, 1.5 s after the last edit", async () => {
  const { store, server, clock } = setup();
  await store.ready;
  store.dispatch("SetCaptionPack", { id: "bold" });
  await clock.advance(1000);
  store.dispatch("SetHookY", { y_e5: 20000 });
  await clock.advance(1499);
  assert.equal(server.puts.length, 0);
  await clock.advance(1);
  assert.equal(server.puts.length, 1);
  const put = server.puts[0];
  assert.equal(put.etag, server.seedEtag);
  assert.match(put.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(put.doc.revision, 1);
  assert.equal(put.doc.parent_sha256, server.seedEtag);
  let state = store.getState();
  assert.equal(state.save, "saved");
  assert.equal(state.etag, server.etag);
  assert.equal(state.revision, 1);
  assert.equal(state.savedAtMs, clock.now());
  assert.deepEqual(state.commands, []);
  store.dispatch("SetLayout", { mode: "fill_center" });
  await clock.advance(1500);
  assert.equal(server.puts[1].doc.revision, 2);
  assert.equal(server.puts[1].etag, state.etag);
  state = store.getState();
  assert.equal(server.doc.captions.pack.id, "bold");
  assert.equal(server.doc.layout.default.mode, "fill_center");
  store.destroy();
});

test("flush saves at once and resolves with the saved etag", async () => {
  const { store, server } = setup();
  await store.ready;
  store.dispatch("SetLayout", { mode: "camera" });
  const etag = await store.flush();
  assert.equal(server.puts.length, 1);
  assert.equal(etag, server.etag);
  assert.equal(store.getState().save, "saved");
  assert.equal(await store.flush(), server.etag, "nothing pending: the current etag");
  store.destroy();
});

test("a 409 whose edits touch other parts merges automatically and saves", async () => {
  const { store, server, clock } = setup();
  await store.ready;
  store.dispatch("SetHookText", { text: "Hook dari tab ini" });
  server.otherTab([["SetLayout", { mode: "camera" }], ["SetCaptionPack", { id: "box" }]]);
  await clock.advance(1500);
  assert.equal(server.puts.length, 2, "the 409 and the merged save");
  const state = store.getState();
  assert.equal(state.save, "saved");
  assert.deepEqual(state.notice, { code: "merged", message: "Digabung dengan perubahan dari tab lain" });
  assert.equal(hookItem(server.doc).payload.text, "Hook dari tab ini");
  assert.equal(server.doc.layout.default.mode, "camera");
  assert.equal(server.doc.captions.pack.id, "box");
  assert.equal(contentJson(state.doc), contentJson(server.doc));
  store.dismissNotice();
  assert.equal(store.getState().notice, null);
  store.destroy();
});

test("a 409 on the same part opens the per-part dialog; the editor keeps working; the draft is kept", async () => {
  const drafts = createMemoryDraftStore();
  const { store, server, clock } = setup({ draftStore: drafts });
  await store.ready;
  store.dispatch("SetHookText", { text: "Punyaku" });
  server.otherTab([["SetHookText", { text: "Tersimpan" }]]);
  await clock.advance(1500);
  let state = store.getState();
  assert.equal(state.save, "conflict");
  assert.deepEqual(state.conflict.groups.map((group) => [group.id, group.label, group.mine, group.theirs]),
    [["hook", "Teks hook", "Punyaku", "Tersimpan"]]);
  store.dispatch("SetLayout", { mode: "camera" });
  await clock.advance(30000);
  assert.equal(server.puts.length, 1, "no save until the dialog is answered");
  await store.draftWriter.flush();
  assert.equal((await drafts.get(server.clipId)).commands.length, 2);
  await store.resolveConflict({ hook: "theirs" });
  await clock.advance(1500);
  state = store.getState();
  assert.equal(state.save, "saved");
  assert.equal(state.conflict, null);
  assert.equal(hookItem(server.doc).payload.text, "Tersimpan");
  assert.equal(server.doc.layout.default.mode, "camera");
  assert.equal(await drafts.get(server.clipId), null, "draft removed once everything is saved");
  store.destroy();
});

test("resolving with 'mine' saves my version", async () => {
  const { store, server, clock } = setup();
  await store.ready;
  store.dispatch("SetHookText", { text: "Punyaku" });
  server.otherTab([["SetHookText", { text: "Tersimpan" }]]);
  await clock.advance(1500);
  await store.resolveConflict({});
  await clock.advance(1500);
  assert.equal(hookItem(server.doc).payload.text, "Punyaku");
  assert.equal(store.getState().save, "saved");
  store.destroy();
});

test("a draft on an older etag is rebased on open", async () => {
  const drafts = createMemoryDraftStore();
  const server = createFakeServer(C30);
  const first = setup({ server, draftStore: drafts, clock: fakeClock(1_000_000) });
  await first.store.ready;
  first.store.dispatch("SetHookText", { text: "Dari draf" });
  await first.store.draftWriter.flush();
  first.store.destroy();
  server.otherTab([["SetLayout", { mode: "camera" }]]);
  const second = setup({ server, draftStore: drafts });
  await second.store.ready;
  const state = second.store.getState();
  assert.equal(state.notice?.code, "merged");
  assert.equal(hookItem(state.doc).payload.text, "Dari draf");
  assert.equal(state.doc.layout.default.mode, "camera");
  await second.clock.advance(1500);
  assert.equal(hookItem(server.doc).payload.text, "Dari draf");
  second.store.destroy();
});

test("a PUT whose response was lost is not applied twice after a reload", async () => {
  const drafts = createMemoryDraftStore();
  const server = createFakeServer(C30);
  const first = setup({ server, draftStore: drafts });
  await first.store.ready;
  const coIn = coldOpen(C30.seed).in_sf;
  first.store.dispatch("NudgeColdOpen", { edge: "in", words: 1 });
  server.loseResponse = true;
  await first.clock.advance(1500);
  assert.equal(server.puts.length, 1);
  assert.equal(first.store.getState().save, "error");
  first.store.dispatch("SetHookY", { y_e5: 21000 });
  await first.store.draftWriter.flush();
  first.store.destroy();
  const once = coldOpen(server.doc).in_sf;
  assert.notEqual(once, coIn, "the lost PUT was committed");
  const second = setup({ server, draftStore: drafts });
  await second.store.ready;
  const state = second.store.getState();
  assert.equal(coldOpen(state.doc).in_sf, once, "the nudge is not replayed a second time");
  assert.equal(hookItem(state.doc).transform.y_e5, 21000);
  assert.equal(state.commands.length, 1);
  await second.clock.advance(1500);
  assert.equal(coldOpen(server.doc).in_sf, once);
  assert.equal(hookItem(server.doc).transform.y_e5, 21000);
  second.store.destroy();
});

test("a save error keeps the work and retries with the same key", async () => {
  const { store, server, clock } = setup();
  await store.ready;
  server.failures.push(new ApiError(503, "backend_unavailable", {}));
  store.dispatch("SetLayout", { mode: "camera" });
  await clock.advance(1500);
  assert.equal(store.getState().save, "error");
  assert.equal(store.getState().error.message, "Gagal menyimpan; perubahan aman di browser ini");
  await clock.advance(60000);
  assert.equal(server.puts.length, 2);
  assert.equal(server.puts[0].key, server.puts[1].key);
  assert.equal(store.getState().save, "saved");
  store.destroy();
});

test("a read-only clip rejects commands and can start again from the AI version", async () => {
  const server = createFakeServer(C30);
  server.otherTab([["SetLayout", { mode: "camera" }]]);
  server.readOnly = true;
  const { store } = setup({ server });
  await store.ready;
  assert.equal(store.getState().status, "readOnly");
  assert.equal(store.getState().readOnlyReason, "transcript_changed");
  assert.throws(() => store.dispatch("SetLayout", { mode: "fit_blur" }), (error) => error.code === "read_only");
  server.readOnly = false;
  await store.startFromSeed();
  assert.equal(store.getState().status, "ready");
  assert.equal(contentJson(store.getState().doc), contentJson(C30.seed));
  await store.flush();
  assert.equal(contentJson(server.doc), contentJson(C30.seed));
  assert.equal(server.doc.revision, 2);
  store.destroy();
});

test("preview plans follow the document; superseded requests are ignored", async () => {
  const calls = [];
  const previewClient = {
    plan(doc) {
      const entry = { doc };
      entry.promise = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
      calls.push(entry);
      return entry.promise;
    },
    frame: async () => new Blob([]),
  };
  const { store } = setup({ previewClient });
  await store.ready;
  assert.equal(calls.length, 1);
  assert.deepEqual(store.getState().pending, ["text"]);
  calls[0].resolve({ planSha256: "p0", warnings: [], audio: { state: "ready" }, plate: { cells: [{ k: 1, state: "ready" }] } });
  await settle();
  assert.equal(store.getState().plan.planSha256, "p0");
  assert.deepEqual(store.getState().pending, []);
  store.dispatch("SetLayout", { mode: "camera" });
  store.dispatch("SetCaptionPack", { id: "box" });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].doc.captions.pack.id, "box");
  calls[1].reject(Object.assign(new Error("superseded"), { name: "AbortError" }));
  calls[2].resolve({ planSha256: "p2", warnings: [{ code: "tight_cut", ref: "rm_1", f: 4 }], audio: { state: "queued" }, plate: { cells: [{ k: 1, state: "queued" }] } });
  await settle();
  const state = store.getState();
  assert.equal(state.plan.planSha256, "p2");
  assert.deepEqual(state.pending, ["audio", "plate"]);
  assert.deepEqual(state.warnings, [{ code: "tight_cut", ref: "rm_1", f: 4 }]);
  assert.equal(state.previewError, null);
  store.destroy();
});

test("a second tab on the same clip is announced", async () => {
  const bus = new Set();
  const channel = () => {
    const port = {
      onmessage: null,
      postMessage(data) {
        for (const other of bus) if (other !== port) setImmediate(() => other.onmessage?.({ data: structuredClone(data) }));
      },
      close() {
        bus.delete(port);
      },
    };
    bus.add(port);
    return port;
  };
  const server = createFakeServer(C30);
  const one = setup({ server, channel });
  await one.store.ready;
  assert.equal(one.store.getState().otherTab, false);
  const two = setup({ server, channel });
  await two.store.ready;
  await settle();
  await settle();
  assert.equal(one.store.getState().otherTab, true);
  assert.equal(two.store.getState().otherTab, true);
  two.store.destroy();
  await settle();
  assert.equal(one.store.getState().otherTab, false);
  one.store.destroy();
  assert.equal(bus.size, 0);
});

test("unsaved work guards beforeunload; blur and hidden flush the save", async () => {
  const handlers = new Map();
  const target = {
    addEventListener: (type, fn) => handlers.set(type, fn),
    removeEventListener: (type) => handlers.delete(type),
  };
  const lifecycle = { window: target, document: { ...target, visibilityState: "visible" } };
  lifecycle.document.addEventListener = (type, fn) => handlers.set(`doc:${type}`, fn);
  lifecycle.document.removeEventListener = (type) => handlers.delete(`doc:${type}`);
  const { store, server } = setup({ lifecycle });
  await store.ready;
  const unload = () => {
    const event = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
    handlers.get("beforeunload")(event);
    return event.prevented;
  };
  assert.equal(unload(), false);
  store.dispatch("SetLayout", { mode: "camera" });
  assert.equal(unload(), true);
  handlers.get("blur")();
  await settle();
  await settle();
  assert.equal(server.puts.length, 1);
  assert.equal(unload(), false);
  store.dispatch("SetLayout", { mode: "fill_center" });
  lifecycle.document.visibilityState = "hidden";
  handlers.get("doc:visibilitychange")();
  await settle();
  await settle();
  assert.equal(server.puts.length, 2);
  store.destroy();
  assert.equal(handlers.size, 0);
});

test("the store runs on the __dev__ fake API client (the shape T2.6 builds against)", async () => {
  const api = createFakeApiClient();
  const clock = fakeClock(1_000_000);
  const store = createEditorStore({ jobId: JOB, clipId: "clip_9b2e41c07d3a5f18e6c2a0b4", api, draftStore: createMemoryDraftStore(),
    now: clock.now, timers: { setTimeout: clock.setTimer, clearTimeout: clock.clearTimer }, channel: null, lifecycle: null,
    newKey: () => "00000000-0000-4000-8000-000000000001" });
  await store.ready;
  assert.equal(store.getState().status, "ready");
  store.dispatch("SetLayout", { mode: "camera" });
  store.dispatch("SetHookText", { text: "Hook baru" });
  await store.flush();
  const put = api.calls.find((call) => call.name === "putEdit");
  assert.equal(put.args[0].revision, 1);
  assert.equal(store.getState().revision, 1);
  store.destroy();
});

test("commands of the transcript and text panels work through the store", async () => {
  const { store } = setup();
  await store.ready;
  const words = bodyWords();
  store.dispatch("RemoveWords", { wordIds: [words[3].id, words[4].id] });
  store.dispatch("EditWordText", { wordId: words[8].id, text: "Ijal" });
  store.dispatch("SetWordHidden", { wordId: words[9].id, on: true });
  store.dispatch("SetWordEmphasis", { wordId: words[10].id, on: true });
  store.dispatch("TrimEnd", { gapWord: words.at(-3).id });
  store.dispatch("SetColdOpen", null);
  store.setSelection({ words: [words[12].id] });
  const state = store.getState();
  assert.equal(state.doc.main.removals.length, 1);
  assert.equal(Object.keys(state.doc.captions.word_edits).length, 3);
  assert.equal(coldOpen(state.doc), null);
  assert.deepEqual(state.selection, { words: [words[12].id] });
  assert.equal(state.commands.length, 6);
  store.destroy();
});

// --- API client ----------------------------------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const response = await handler(url, init);
    return response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("the API client builds the §4.2 requests", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    if (init.method === "PUT") return json(200, { doc: { revision: 1 }, etag: "b".repeat(64), warnings: [] });
    if (url.endsWith("/renders") && init.method === "POST") return json(202, { renderId: "r1", state: "queued" });
    return json(200, { ok: true, url });
  });
  const api = createApiClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl });
  const root = `/api/jobs/${JOB}`;
  const clip = `${root}/clips/${C30.seed.clip_id}`;
  await api.clips();
  await api.getEdit({});
  await api.getEdit({ seed: true });
  const saved = await api.putEdit({ revision: 1 }, { etag: "a".repeat(64), key: "00000000-0000-4000-8000-000000000001" });
  await api.words(`${clip}/words`);
  await api.prepare({ layout: "camera" });
  await api.createRender({ editEtag: "b".repeat(64) }, "00000000-0000-4000-8000-000000000002");
  await api.getRender(RENDER);
  await api.cancelRender(RENDER);
  await api.cleanup();
  await api.coldOpenSuggestions();
  await api.aiHooks({ revision: 1 });
  await api.aiTask("00000000-0000-4000-8000-000000000003");
  assert.equal(saved.etag, "b".repeat(64));
  const seen = fetchImpl.calls.map(({ url, init }) => [init.method ?? "GET", url]);
  assert.deepEqual(seen, [
    ["GET", `${root}/clips`],
    ["GET", `${clip}/edit`],
    ["GET", `${clip}/edit?seed=1`],
    ["PUT", `${clip}/edit`],
    ["GET", `${clip}/words`],
    ["POST", `${clip}/prepare`],
    ["POST", `${clip}/renders`],
    ["GET", `${root}/renders/${RENDER}`],
    ["DELETE", `${root}/renders/${RENDER}`],
    ["GET", `${clip}/cleanup`],
    ["GET", `${clip}/coldopen-suggestions`],
    ["POST", `${clip}/ai`],
    ["GET", `${clip}/ai/00000000-0000-4000-8000-000000000003`],
  ]);
  const put = fetchImpl.calls[3].init;
  assert.equal(put.headers["If-Match"], `"${"a".repeat(64)}"`);
  assert.equal(put.headers["Idempotency-Key"], "00000000-0000-4000-8000-000000000001");
  assert.equal(put.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(put.body), { revision: 1 });
  assert.equal(fetchImpl.calls[6].init.body, JSON.stringify({ editEtag: "b".repeat(64) }));
  assert.equal(fetchImpl.calls[6].init.headers["Idempotency-Key"], "00000000-0000-4000-8000-000000000002");
  assert.deepEqual(JSON.parse(fetchImpl.calls[5].init.body), { layout: "camera" });
  assert.deepEqual(JSON.parse(fetchImpl.calls[11].init.body), { task: "hooks", doc: { revision: 1 } });
  for (const { init } of fetchImpl.calls) assert.equal(init.credentials, "same-origin");
});

test("the API client maps errors to ApiError with the server's code", async () => {
  const current = { revision: 3 };
  const fetchImpl = fakeFetch((url) => {
    if (url.includes("conflict")) return json(409, { error: "Dokumen edit telah berubah", code: "revision_conflict", current }, { etag: `"${"c".repeat(64)}"` });
    return json(422, { error: { code: "range_invalid", messageId: "edit.range_invalid" }, errors: [{ code: "range_invalid", path: "/x" }] });
  });
  const api = createApiClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl, base: "https://x/conflict" });
  await assert.rejects(api.putEdit({}, { etag: "a".repeat(64), key: "00000000-0000-4000-8000-000000000001" }), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "revision_conflict");
    assert.deepEqual(error.body.current, current);
    assert.equal(error.body.etag, "c".repeat(64), "etag from the ETag header");
    return true;
  });
  const other = createApiClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl });
  await assert.rejects(other.getEdit({}), (error) => error.status === 422 && error.code === "range_invalid" && error.body.errors.length === 1);
  const offline = createApiClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.clips(), (error) => error instanceof ApiError && error.status === 0 && error.code === "network_error");
  assert.throws(() => createApiClient({ jobId: "../etc", clipId: C30.seed.clip_id, fetchImpl }), TypeError);
  assert.throws(() => createApiClient({ jobId: JOB, clipId: "clip_x", fetchImpl }), TypeError);
  await assert.rejects(other.getRender("../x"), TypeError);
  await assert.rejects(other.aiTask("nope"), TypeError);
  await assert.rejects(other.words("https://evil.example/words"), TypeError);
});

// --- preview client ------------------------------------------------------------------------

test("preview plans are debounced 120 ms, latest wins, and reuse the known ASS", async () => {
  assert.equal(PREVIEW_DEBOUNCE_MS, 120);
  const clock = fakeClock();
  const requests = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    const entry = { url, init, body: JSON.parse(init.body), resolve, reject };
    init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    requests.push(entry);
  });
  const preview = createPreviewClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const outcomes = [];
  const track = (promise, label) => promise.then((plan) => outcomes.push([label, plan.planSha256]), (error) => outcomes.push([label, error.name]));
  track(preview.plan({ v: 1 }), "a");
  await clock.advance(60);
  track(preview.plan({ v: 2 }), "b");
  await clock.advance(119);
  assert.equal(requests.length, 0);
  await clock.advance(1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `/api/jobs/${JOB}/clips/${C30.seed.clip_id}/preview/plan`);
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(requests[0].body, { doc: { v: 2 }, known: {} });
  requests[0].resolve(json(200, { planSha256: "p2", text: { assSha256: "s1", ass: "[Script Info]1" } }));
  await settle();
  track(preview.plan({ v: 3 }), "c");
  await clock.advance(120);
  assert.deepEqual(requests[1].body.known, { assSha256: "s1" });
  track(preview.plan({ v: 4 }), "d");
  await clock.advance(120);
  assert.equal(requests.length, 3);
  requests[2].resolve(json(200, { planSha256: "p4", text: { assSha256: "s1" } }));
  await settle();
  await settle();
  assert.deepEqual(outcomes, [["a", "AbortError"], ["b", "p2"], ["c", "AbortError"], ["d", "p4"]]);
});

test("the preview client fills the omitted ASS from its cache", async () => {
  const clock = fakeClock();
  const responses = [
    json(200, { planSha256: "p1", text: { assSha256: "s1", ass: "[Script Info]A" } }),
    json(200, { planSha256: "p2", text: { assSha256: "s1" } }),
    json(422, { errors: [{ code: "range_invalid", path: "/main" }] }),
    json(429, { code: "rate_limited" }, { "retry-after": "1" }),
    json(200, { planSha256: "p5", text: { assSha256: "s2", ass: "[Script Info]B" } }),
  ];
  const fetchImpl = async () => responses.shift();
  const preview = createPreviewClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const run = async (doc) => {
    const outcome = preview.plan(doc).then((value) => ({ value }), (error) => ({ error }));
    await clock.advance(120);
    await clock.advance(1500);
    return outcome;
  };
  assert.equal((await run({ v: 1 })).value.text.ass, "[Script Info]A");
  assert.equal((await run({ v: 2 })).value.text.ass, "[Script Info]A", "omitted ASS filled from the cache");
  const invalid = (await run({ v: 3 })).error;
  assert.equal(invalid.code, "invalid");
  assert.equal(invalid.errors[0].path, "/main");
  assert.equal((await run({ v: 4 })).value.planSha256, "p5", "429 is retried after Retry-After");
});

test("truth frames are POSTed with the document and frame number", async () => {
  const fetchImpl = fakeFetch(() => new Response(new Uint8Array([0x89, 0x50]), { status: 200, headers: { "content-type": "image/png" } }));
  const preview = createPreviewClient({ jobId: JOB, clipId: C30.seed.clip_id, fetchImpl });
  const blob = await preview.frame({ v: 1 }, 12);
  assert.equal(blob.type, "image/png");
  assert.equal(fetchImpl.calls[0].url, `/api/jobs/${JOB}/clips/${C30.seed.clip_id}/preview/frame`);
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), { doc: { v: 1 }, f: 12 });
  await assert.rejects(preview.frame({ v: 1 }, -1), TypeError);
});

// --- flags ---------------------------------------------------------------------------------

test("editor flags are off unless set to on", () => {
  assert.deepEqual(EDITOR_FLAGS, ["POTONGIN_EDITOR_V3", "POTONGIN_EDITOR_UPLOADS", "POTONGIN_EDITOR_LLM", "POTONGIN_RENDER_ENGINE"]);
  assert.deepEqual(readEditorFlags({}), { editorV3: false, uploads: false, llm: false, renderEngine: "legacy" });
  assert.deepEqual(readEditorFlags({ POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_UPLOADS: "ON", POTONGIN_EDITOR_LLM: "on", POTONGIN_RENDER_ENGINE: "edit-v2" }),
    { editorV3: true, uploads: true, llm: true, renderEngine: "edit-v2" });
  assert.equal(readEditorFlags({ POTONGIN_EDITOR_LLM: "on", POTONGIN_LLM: "off" }).llm, false, "POTONGIN_LLM=off wins");
  assert.equal(readEditorFlags({ POTONGIN_EDITOR_V3: "yes" }).editorV3, false);
  assert.equal(readEditorFlags({ POTONGIN_RENDER_ENGINE: "v2" }).renderEngine, "legacy");
});
