// The IndexedDB draft (web/lib/editor/draft-store.mjs, plan §4.5): `{clipId, baseEtag, commands,
// doc, savedAtMs}` written after every command, so a reload loses at most the time of one
// IndexedDB write (gate: ≤ 2 s). The wrapper is a raw ~60-line IndexedDB helper (no dependency);
// Node has no IndexedDB, so the tests drive it with a small fake of the IDB request API.
import assert from "node:assert/strict";
import test from "node:test";

import { createFakeServer, loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { body, contentJson } from "../lib/editor/doc-model.mjs";
import { DRAFT_DB, DRAFT_STORE, createDraftStore, createDraftWriter, createMemoryDraftStore } from "../lib/editor/draft-store.mjs";
import { createEditorStore } from "../lib/editor/store.mjs";

/** Enough of IndexedDB for the wrapper: open/upgrade, one object store, get/put/delete. */
function fakeIndexedDB({ delayMs = 0 } = {}) {
  const databases = new Map();
  const later = (fn) => (delayMs ? setTimeout(fn, delayMs) : setImmediate(fn));
  const stats = { opens: 0, puts: 0, transactions: 0 };
  function database(version) {
    const stores = new Map();
    return {
      version,
      stores,
      objectStoreNames: { contains: (name) => stores.has(name) },
      createObjectStore(name, { keyPath }) {
        stores.set(name, { keyPath, rows: new Map() });
      },
      transaction(storeName, mode) {
        stats.transactions += 1;
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        let open = 0;
        tx.objectStore = (name) => {
          const target = stores.get(name);
          const op = (run) => {
            open += 1;
            const req = { onsuccess: null, onerror: null, result: undefined, error: null };
            later(() => {
              try {
                req.result = run();
                req.onsuccess?.({ target: req });
                open -= 1;
                if (open === 0) later(() => tx.oncomplete?.({ target: tx }));
              } catch (error) {
                req.error = error;
                tx.error = error;
                req.onerror?.({ target: req });
                tx.onerror?.({ target: tx });
              }
            });
            return req;
          };
          return {
            get: (key) => op(() => structuredClone(target.rows.get(key))),
            put: (value) => op(() => {
              if (mode !== "readwrite") throw new Error("ReadOnlyError");
              stats.puts += 1;
              target.rows.set(value[target.keyPath], structuredClone(value));
              return value[target.keyPath];
            }),
            delete: (key) => op(() => {
              target.rows.delete(key);
            }),
          };
        };
        return tx;
      },
      close() {},
    };
  }
  return {
    stats,
    databases,
    open(name, version) {
      stats.opens += 1;
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null };
      later(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, database(version));
        req.result = databases.get(name);
        if (fresh) req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
      return req;
    },
  };
}

test("the IndexedDB wrapper stores, reads and deletes drafts by clip id", async () => {
  const idb = fakeIndexedDB();
  const store = createDraftStore({ indexedDB: idb });
  assert.equal(await store.get("clip_000000000000000000000001"), null);
  const draft = { clipId: "clip_000000000000000000000001", baseEtag: "a".repeat(64), commands: [{ type: "SetLayout", args: { mode: "camera" } }],
    doc: { v: 1 }, savedAtMs: 5 };
  await store.put(draft);
  draft.doc.v = 2;
  assert.deepEqual((await store.get("clip_000000000000000000000001")).doc, { v: 1 }, "stored by structured clone");
  assert.ok(idb.databases.get(DRAFT_DB).stores.has(DRAFT_STORE));
  await store.delete("clip_000000000000000000000001");
  assert.equal(await store.get("clip_000000000000000000000001"), null);
  assert.equal(idb.stats.opens, 1, "one connection");
});

test("without IndexedDB the draft lives in memory", async () => {
  const store = createDraftStore({ indexedDB: null });
  await store.put({ clipId: "c", commands: [] });
  assert.deepEqual(await store.get("c"), { clipId: "c", commands: [] });
  const memory = createMemoryDraftStore();
  await memory.put({ clipId: "x", doc: { a: 1 } });
  assert.equal(memory.records.size, 1);
});

test("the writer coalesces writes while one is in flight and never loses the last", async () => {
  const idb = fakeIndexedDB({ delayMs: 5 });
  const store = createDraftStore({ indexedDB: idb });
  let clock = 0;
  const writer = createDraftWriter({ store, now: () => clock });
  for (let i = 1; i <= 20; i += 1) {
    clock = i;
    writer.write({ clipId: "clip_x", commands: new Array(i).fill({ type: "X" }), savedAtMs: i });
  }
  await writer.flush();
  const stored = await store.get("clip_x");
  assert.equal(stored.commands.length, 20);
  assert.ok(writer.stats.writes < 20, `${writer.stats.writes} writes for 20 drafts`);
  assert.equal(writer.stats.requested, 20);
  writer.remove("clip_x");
  await writer.flush();
  assert.equal(await store.get("clip_x"), null);
});

test("a draft is written after every command and a reload restores all of them", async () => {
  const context = loadContext("c30");
  const server = createFakeServer(context);
  const idb = fakeIndexedDB();
  const drafts = createDraftStore({ indexedDB: idb });
  let clock = 1_000_000;
  const options = { jobId: server.jobId, clipId: server.clipId, api: server.api, draftStore: drafts, now: () => clock,
    timers: { setTimeout: () => 0, clearTimeout: () => {} }, channel: null, lifecycle: null };
  const store = createEditorStore(options);
  await store.ready;
  const seg = body(context.seed);
  const words = context.ctx.wordList.filter((_word, index) => context.ctx.midSf(index) >= seg.in_sf && context.ctx.midSf(index) < seg.out_sf);
  let maxLagMs = 0;
  let commands = 0;
  for (let i = 0; i < 40; i += 1) {
    clock += 600;
    if (i % 3 === 0) store.dispatch("RemoveWords", { wordIds: [words[5 + i].id] });
    else if (i % 3 === 1) store.dispatch("EditWordText", { wordId: words[5 + i].id, text: `kata${i}` });
    else store.dispatch("SetCaptionOverride", { key: "y_e5", value: 60000 + i * 100 });
    commands += 1;
    const started = performance.now();
    await store.draftWriter.flush();
    maxLagMs = Math.max(maxLagMs, performance.now() - started);
    const draft = await drafts.get(server.clipId);
    assert.equal(draft.commands.length, store.getState().commands.length, `after command ${i}`);
    assert.equal(contentJson(draft.doc), contentJson(store.getState().doc));
    assert.equal(draft.baseEtag, server.etag);
  }
  assert.equal(server.puts.length, 0, "autosave never ran (timers frozen): only the draft holds the work");
  const expected = contentJson(store.getState().doc);
  store.destroy();
  const reloaded = createEditorStore(options);
  await reloaded.ready;
  assert.equal(contentJson(reloaded.getState().doc), expected, "nothing lost on reload");
  assert.equal(reloaded.getState().save, "dirty");
  assert.equal(reloaded.getState().commands.length, commands);
  assert.equal(reloaded.getState().canUndo, true);
  assert.ok(maxLagMs < 2000, `draft write lag ${maxLagMs} ms`);
  reloaded.destroy();
});
