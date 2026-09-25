// The IndexedDB draft (web/lib/editor/draft-store.mjs, plan §4.5): `{clipId, baseEtag, commands,
// doc, savedAtMs}` written after every command, so a reload loses at most the time of one
// IndexedDB write (gate: ≤ 2 s). Drafts are kept per tab (`<clipId>#<tabId>`, the tab id lives in
// sessionStorage and survives a reload), so two tabs of one clip never overwrite each other's
// draft (QG-CONFLICT: "no draft is lost"); a closed tab's unsaved draft is adopted by the next
// tab that opens the clip. The wrapper is a raw IndexedDB helper (no dependency); Node has no
// IndexedDB, so the tests drive it with a small fake of the IDB request API.
import assert from "node:assert/strict";
import test from "node:test";

import { createFakeServer, loadContext, mulberry32, randomCommand } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { ApiError } from "../lib/editor/api-client.mjs";
import { CommandRejected } from "../lib/editor/commands.mjs";
import { body, checkDoc, contentJson, hookItem } from "../lib/editor/doc-model.mjs";
import { replaySteps } from "../lib/editor/rebase.mjs";
import {
  DRAFT_DB,
  DRAFT_STORE,
  createDraftStore,
  createDraftWriter,
  createMemoryDraftStore,
  draftKey,
} from "../lib/editor/draft-store.mjs";
import { createEditorStore } from "../lib/editor/store.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
const keyRange = { bound: (lower, upper) => ({ lower, upper }) };

/** Enough of IndexedDB for the wrapper: open/upgrade, one object store, get/getAll/put/delete. */
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
            getAll: (range) => op(() => [...target.rows.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
              .filter(([key]) => key >= range.lower && key <= range.upper).map(([, value]) => structuredClone(value))),
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

function fakeClock(start = 1_000_000) {
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
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
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

function sessionStorageLike(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function busChannel() {
  const bus = new Set();
  const factory = () => {
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
  factory.bus = bus;
  return factory;
}

const C30 = loadContext("c30");
const SEG = body(C30.seed);
const WORDS = C30.ctx.wordList.filter((_word, index) => C30.ctx.midSf(index) >= SEG.in_sf && C30.ctx.midSf(index) < SEG.out_sf);

/** A tab: a store over the shared server and draft store; autosave off unless `clock` runs it. */
function openTab({ server, drafts, tabStorage = sessionStorageLike(), channel = null, clock = fakeClock(), autosave = false }) {
  const store = createEditorStore({
    jobId: server.jobId, clipId: server.clipId, api: server.api, draftStore: drafts, now: clock.now, tabStorage, channel,
    lifecycle: null, timers: { setTimeout: clock.setTimer, clearTimeout: clock.clearTimer },
    autosave: autosave ? {} : { debounceMs: 1e12, maxIntervalMs: 1e12 },
  });
  return { store, clock, tabStorage };
}

async function opened(tab) {
  const ready = tab.store.ready;
  await tab.clock.advance(1000);
  await ready;
  await tab.store.draftWriter.flush();
  return tab;
}

test("the IndexedDB wrapper stores drafts per tab and lists a clip's drafts", async () => {
  const idb = fakeIndexedDB();
  const store = createDraftStore({ indexedDB: idb, keyRange });
  const clip = "clip_000000000000000000000001";
  const other = "clip_000000000000000000000002";
  assert.equal(draftKey(clip, "tab-a"), `${clip}#tab-a`);
  assert.equal(await store.get(draftKey(clip, "tab-a")), null);
  const draft = { key: draftKey(clip, "tab-a"), clipId: clip, tabId: "tab-a", baseEtag: "a".repeat(64), commands: [{ type: "SetLayout" }], doc: { v: 1 } };
  await store.put(draft);
  await store.put({ ...draft, key: draftKey(clip, "tab-b"), tabId: "tab-b" });
  await store.put({ ...draft, key: draftKey(other, "tab-a"), clipId: other });
  draft.doc.v = 2;
  assert.deepEqual((await store.get(draftKey(clip, "tab-a"))).doc, { v: 1 }, "stored by structured clone");
  assert.deepEqual((await store.list(clip)).map((entry) => entry.tabId), ["tab-a", "tab-b"]);
  assert.ok(idb.databases.get(DRAFT_DB).stores.has(DRAFT_STORE));
  await store.delete(draftKey(clip, "tab-a"));
  assert.deepEqual((await store.list(clip)).map((entry) => entry.tabId), ["tab-b"]);
  assert.equal(idb.stats.opens, 1, "one connection");
});

test("without IndexedDB the drafts live in memory", async () => {
  const store = createDraftStore({ indexedDB: null });
  await store.put({ key: "c#t", clipId: "c", tabId: "t", commands: [] });
  assert.deepEqual(await store.get("c#t"), { key: "c#t", clipId: "c", tabId: "t", commands: [] });
  assert.equal((await store.list("c")).length, 1);
  assert.equal((await store.list("x")).length, 0);
  const memory = createMemoryDraftStore();
  await memory.put({ key: "x#1", clipId: "x", doc: { a: 1 } });
  assert.equal(memory.records.size, 1);
});

test("the writer coalesces writes per draft while one is in flight and never loses the last", async () => {
  const idb = fakeIndexedDB({ delayMs: 5 });
  const store = createDraftStore({ indexedDB: idb, keyRange });
  let clock = 0;
  const writer = createDraftWriter({ store, now: () => clock });
  await store.put({ key: "clip_x#old", clipId: "clip_x", commands: [] });
  for (let i = 1; i <= 20; i += 1) {
    clock = i;
    writer.write({ key: "clip_x#me", clipId: "clip_x", commands: new Array(i).fill({ type: "X" }), savedAtMs: i });
    if (i === 10) writer.remove("clip_x#old");
  }
  await writer.flush();
  assert.equal((await store.get("clip_x#me")).commands.length, 20);
  assert.equal(await store.get("clip_x#old"), null, "a removal of another draft does not cancel this one");
  assert.ok(writer.stats.writes < 21, `${writer.stats.writes} writes for 21 requests`);
  assert.equal(writer.stats.requested, 21);
  writer.remove("clip_x#me");
  await writer.flush();
  assert.equal(await store.get("clip_x#me"), null);
});

test("a write queued just as the previous one finishes is never stranded", async () => {
  for (let delay = 0; delay < 12; delay += 1) {
    const store = createMemoryDraftStore();
    const writer = createDraftWriter({ store });
    writer.write({ key: "clip_x#t", clipId: "clip_x", commands: [1] });
    for (let i = 0; i < delay; i += 1) await Promise.resolve();
    writer.write({ key: "clip_x#t", clipId: "clip_x", commands: [1, 2] });
    await writer.flush();
    assert.deepEqual((await store.get("clip_x#t")).commands, [1, 2], `after ${delay} microtasks`);
  }
});

test("a draft is written after every command and a reload of the tab restores all of them", async () => {
  const server = createFakeServer(C30);
  const drafts = createDraftStore({ indexedDB: fakeIndexedDB(), keyRange });
  const tabStorage = sessionStorageLike();
  const tab = await opened(openTab({ server, drafts, tabStorage }));
  const { store } = tab;
  let maxLagMs = 0;
  let commands = 0;
  for (let i = 0; i < 40; i += 1) {
    if (i % 3 === 0) store.dispatch("RemoveWords", { wordIds: [WORDS[5 + i].id] });
    else if (i % 3 === 1) store.dispatch("EditWordText", { wordId: WORDS[5 + i].id, text: `kata${i}` });
    else store.dispatch("SetCaptionOverride", { key: "y_e5", value: 60000 + i * 100 });
    commands += 1;
    const started = performance.now();
    await store.draftWriter.flush();
    maxLagMs = Math.max(maxLagMs, performance.now() - started);
    const draft = await drafts.get(store.draftKey);
    assert.equal(draft.commands.length, store.getState().commands.length, `after command ${i}`);
    assert.equal(contentJson(draft.doc), contentJson(store.getState().doc));
    assert.equal(draft.baseEtag, server.etag);
  }
  assert.equal(server.puts.length, 0, "autosave never ran: only the draft holds the work");
  const expected = contentJson(store.getState().doc);
  store.destroy();
  const reloaded = await opened(openTab({ server, drafts, tabStorage }));
  const state = reloaded.store.getState();
  assert.equal(reloaded.store.draftKey, store.draftKey, "the tab keeps its id across a reload");
  assert.equal(contentJson(state.doc), expected, "nothing lost on reload");
  assert.equal(state.save, "dirty");
  assert.equal(state.commands.length, commands);
  assert.equal(state.canUndo, true);
  assert.ok(maxLagMs < 2000, `draft write lag ${maxLagMs} ms`);
  reloaded.store.destroy();
});

test("two live tabs keep separate drafts; a reload restores only its own", async () => {
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const channel = busChannel();
  const storageA = sessionStorageLike();
  const a = await opened(openTab({ server, drafts, channel, tabStorage: storageA }));
  const b = await opened(openTab({ server, drafts, channel }));
  a.store.dispatch("SetHookText", { text: "Dari tab A" });
  b.store.dispatch("SetLayout", { mode: "camera" });
  await a.store.draftWriter.flush();
  await b.store.draftWriter.flush();
  assert.notEqual(a.store.draftKey, b.store.draftKey);
  assert.equal((await drafts.list(server.clipId)).length, 2);
  a.store.destroy();
  const again = await opened(openTab({ server, drafts, channel, tabStorage: storageA }));
  const state = again.store.getState();
  assert.equal(hookItem(state.doc).payload.text, "Dari tab A");
  assert.equal(state.doc.layout.default.mode, "fit_blur", "the live tab's draft is not taken");
  assert.equal((await drafts.get(b.store.draftKey)).commands.length, 1);
  again.store.destroy();
  b.store.destroy();
});

test("a closed tab's unsaved draft is adopted by the next tab of the clip", async () => {
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const channel = busChannel();
  const storageA = sessionStorageLike();
  const a = await opened(openTab({ server, drafts, channel, tabStorage: storageA }));
  const b = await opened(openTab({ server, drafts, channel }));
  b.store.dispatch("SetHookText", { text: "Dari tab B yang ditutup" });
  await b.store.draftWriter.flush();
  b.store.destroy();
  a.store.dispatch("SetLayout", { mode: "camera" });
  await a.store.draftWriter.flush();
  a.store.destroy();
  const reopened = await opened(openTab({ server, drafts, channel, tabStorage: storageA }));
  const state = reopened.store.getState();
  assert.equal(state.doc.layout.default.mode, "camera", "own draft restored");
  assert.equal(hookItem(state.doc).payload.text, "Dari tab B yang ditutup", "the orphan draft is merged in");
  assert.equal(state.notice?.code, "merged");
  const left = await drafts.list(server.clipId);
  assert.deepEqual(left.map((draft) => draft.key), [reopened.store.draftKey], "the adopted draft is folded into this tab's");
  assert.equal(left[0].commands.length, 2);
  reopened.store.destroy();
});

test("a new tab with no draft of its own adopts a closed tab's draft", async () => {
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const closed = await opened(openTab({ server, drafts }));
  closed.store.dispatch("SetCaptionPack", { id: "box" });
  await closed.store.draftWriter.flush();
  closed.store.destroy();
  const fresh = await opened(openTab({ server, drafts, channel: busChannel() }));
  assert.equal(fresh.store.getState().doc.captions.pack.id, "box");
  assert.equal(fresh.store.getState().save, "dirty");
  assert.deepEqual((await drafts.list(server.clipId)).map((draft) => draft.key), [fresh.store.draftKey]);
  fresh.store.destroy();
});

test("a duplicated tab (copied sessionStorage) takes a new id instead of sharing a draft", async () => {
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const channel = busChannel();
  const storageA = sessionStorageLike();
  const a = await opened(openTab({ server, drafts, channel, tabStorage: storageA }));
  a.store.dispatch("SetHookText", { text: "Punya tab A" });
  await a.store.draftWriter.flush();
  const copy = sessionStorageLike(Object.fromEntries(storageA.values));
  const c = await opened(openTab({ server, drafts, channel, tabStorage: copy }));
  assert.notEqual(c.store.draftKey, a.store.draftKey);
  assert.equal(hookItem(c.store.getState().doc).payload.text, hookItem(C30.seed).payload.text, "A's live draft is left to A");
  assert.equal(copy.getItem("potongin-editor-tab") === storageA.getItem("potongin-editor-tab"), false);
  assert.equal((await drafts.get(a.store.draftKey)).commands.length, 1);
  a.store.destroy();
  c.store.destroy();
});

test("a closed tab whose last PUT was committed but not confirmed is recognised as saved", async () => {
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const storageA = sessionStorageLike();
  const a = await opened(openTab({ server, drafts, tabStorage: storageA }));
  a.store.dispatch("SetLayout", { mode: "camera" });
  await a.store.draftWriter.flush();
  const clockB = fakeClock();
  const b = await opened(openTab({ server, drafts, clock: clockB, autosave: true }));
  b.store.dispatch("RemoveWords", { wordIds: [WORDS[12].id] });
  server.loseResponse = true;
  await clockB.advance(1500);
  assert.equal(server.puts.length, 1, "committed on the server, response lost");
  await b.store.draftWriter.flush();
  b.store.destroy();
  a.store.destroy();
  const again = await opened(openTab({ server, drafts, tabStorage: storageA }));
  const state = again.store.getState();
  assert.notEqual(state.notice?.code, "draft_conflict");
  assert.equal(state.doc.main.removals.length, 1, "the saved removal is there once");
  assert.equal(state.doc.layout.default.mode, "camera");
  assert.deepEqual(await drafts.list(server.clipId), [], "merged work is saved at once, then no draft is left");
  assert.equal(server.doc.main.removals.length, 1);
  assert.equal(server.doc.layout.default.mode, "camera");
  again.store.destroy();
});

/**
 * QG-CONFLICT at store level: two live tabs of one clip edit at random with autosave, 409 merges
 * and dialogs (answered at random), failed PUTs and reloads. After every operation each tab's
 * unsaved work must be recoverable from its own draft; at the end everything is saved and valid.
 */
export async function twoTabRun(seed, steps = 40) {
  const rng = mulberry32(seed);
  const server = createFakeServer(C30);
  const drafts = createMemoryDraftStore();
  const channel = busChannel();
  const tabs = [];
  const stats = { dispatched: 0, rejected: 0, conflicts: 0, resolved: 0, reloads: 0, failures: 0, merges: 0, draftChecks: 0 };
  const open = async (storage = sessionStorageLike()) => {
    const tab = await opened(openTab({ server, drafts, channel, tabStorage: storage, autosave: true }));
    tab.store.subscribe((state) => {
      if (state.notice?.code === "merged") stats.merges += 1;
    });
    return tab;
  };
  tabs.push(await open(), await open());
  const checkDrafts = async () => {
    for (const tab of tabs) {
      await tab.store.draftWriter.flush();
      const state = tab.store.getState();
      if (!state.commands.length) continue;
      const draft = await drafts.get(tab.store.draftKey);
      assert.ok(draft, `seed ${seed}: unsaved work without a draft`);
      assert.equal(contentJson(replaySteps(draft.baseDoc, draft.commands, C30.ctx).doc), contentJson(state.doc),
        `seed ${seed}: the draft does not rebuild the tab's document`);
      stats.draftChecks += 1;
    }
  };
  for (let step = 0; step < steps; step += 1) {
    const index = rng() < 0.5 ? 0 : 1;
    const tab = tabs[index];
    const roll = rng();
    if (roll < 0.45) {
      const command = randomCommand(rng, tab.store.getState().doc, C30);
      try {
        tab.store.dispatch(command.type, command.args, command.options);
        stats.dispatched += 1;
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
        stats.rejected += 1;
      }
    } else if (roll < 0.65) {
      await tab.clock.advance(200 + Math.floor(rng() * 2800));
    } else if (roll < 0.73) {
      if (tab.store.getState().save === "conflict") {
        stats.conflicts += 1;
        const choices = Object.fromEntries(tab.store.getState().conflict.groups.map((group) => [group.id, rng() < 0.5 ? "mine" : "theirs"]));
        try {
          await tab.store.resolveConflict(choices);
        } catch (error) {
          if (!(error instanceof CommandRejected)) throw error;
          await tab.store.resolveConflict(Object.fromEntries(Object.keys(choices).map((id) => [id, "theirs"])));
        }
        stats.resolved += 1;
      }
    } else if (roll < 0.8) {
      if (rng() < 0.5) tab.store.undo();
      else tab.store.redo();
    } else if (roll < 0.86) {
      tab.store.destroy();
      tabs[index] = await open(tab.tabStorage);
      stats.reloads += 1;
    } else if (roll < 0.9) {
      server.failures.push(new ApiError(503, "backend_unavailable", {}));
      stats.failures += 1;
    } else {
      await tab.store.flush().catch(() => {});
    }
    await checkDrafts();
  }
  // Settle: answer any dialog with "mine" ("theirs" when that combination is invalid), save both tabs in turn.
  for (let round = 0; round < 6; round += 1) {
    for (const tab of tabs) {
      if (tab.store.getState().save === "conflict") {
        await tab.store.resolveConflict({}).catch(async (error) => {
          if (!(error instanceof CommandRejected)) throw error;
          const groups = tab.store.getState().conflict.groups;
          await tab.store.resolveConflict(Object.fromEntries(groups.map((group) => [group.id, "theirs"])));
        });
      }
      await tab.clock.advance(40000);
      await tab.store.flush().catch(() => {});
    }
  }
  for (const tab of tabs) {
    const state = tab.store.getState();
    assert.equal(state.commands.length, 0, `seed ${seed}: work left unsaved (${state.save})`);
  }
  const saved = contentJson(server.doc);
  assert.ok(tabs.some((tab) => contentJson(tab.store.getState().doc) === saved), `seed ${seed}: the tab that saved last holds the server's version`);
  assert.deepEqual(checkDoc(server.doc, C30.ctx), []);
  await checkDrafts();
  assert.deepEqual(await drafts.list(server.clipId), [], `seed ${seed}: drafts left after everything was saved`);
  for (const tab of tabs) tab.store.destroy();
  return stats;
}

test("QG-CONFLICT (store): two live tabs, random edits, saves, conflicts and reloads lose nothing", async () => {
  const total = { runs: 0, dispatched: 0, conflicts: 0, reloads: 0, merges: 0, draftChecks: 0 };
  for (let run = 0; run < 60; run += 1) {
    const stats = await twoTabRun(9000 + run);
    total.runs += 1;
    for (const key of ["dispatched", "conflicts", "reloads", "merges", "draftChecks"]) total[key] += stats[key];
  }
  assert.ok(total.conflicts > 5, `only ${total.conflicts} dialogs`);
  assert.ok(total.merges > 5, `only ${total.merges} merges`);
  assert.ok(total.reloads > 20, `only ${total.reloads} reloads`);
  assert.ok(total.draftChecks > 500, `only ${total.draftChecks} draft checks`);
});
