// Autosave (web/lib/editor/autosave.mjs, plan §4.5): debounced 1.5 s after the last change, at
// least every 10 s during continuous editing, at most one PUT in flight, a retry of the same
// payload reuses the same Idempotency-Key; 409 hands over to rebase; flush saves now.
import assert from "node:assert/strict";
import test from "node:test";

import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_INTERVAL_MS, createAutosave } from "../lib/editor/autosave.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let now = 0;
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
    get timers() {
      return timers.size;
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A tiny editor: `change()` edits the document; the server accepts every PUT unless told otherwise. */
function harness({ clock = fakeClock(), respond = null } = {}) {
  let version = 0;
  let saved = 0;
  let etag = "e0";
  const puts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let keySeq = 0;
  const events = [];
  const autosave = createAutosave({
    snapshot: () => (version === saved ? null : { doc: { v: version }, etag, count: version - saved }),
    put: async (doc, { etag: expected, key }) => {
      puts.push({ at: clock.now(), doc, etag: expected, key });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (respond) return await respond(doc, { etag: expected, key });
        return { doc, etag: `e${doc.v}`, warnings: [] };
      } finally {
        inFlight -= 1;
      }
    },
    onSaving: (snap, key) => events.push(["saving", snap.doc.v, key]),
    onSaved: (result, snap) => {
      saved += snap.count;
      etag = result.etag;
      events.push(["saved", snap.doc.v]);
    },
    onConflict: (error, snap) => events.push(["conflict", snap.doc.v, error.code]),
    onError: (error, snap, info) => events.push(["error", snap.doc.v, error.code, info.retrying]),
    newKey: () => `key-${(keySeq += 1)}`,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    clock,
    autosave,
    puts,
    events,
    get maxInFlight() {
      return maxInFlight;
    },
    get dirty() {
      return version !== saved;
    },
    change() {
      version += 1;
      autosave.notify();
    },
  };
}

test("the constants are the plan's", () => {
  assert.equal(AUTOSAVE_DEBOUNCE_MS, 1500);
  assert.equal(AUTOSAVE_MAX_INTERVAL_MS, 10000);
});

test("saves 1.5 s after the last change", async () => {
  const h = harness();
  h.change();
  await h.clock.advance(1000);
  h.change();
  await h.clock.advance(1499);
  assert.equal(h.puts.length, 0);
  await h.clock.advance(1);
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0].at, 2500);
  assert.deepEqual(h.puts[0].doc, { v: 2 });
  assert.equal(h.dirty, false);
  await h.clock.advance(20000);
  assert.equal(h.puts.length, 1, "nothing to save, nothing sent");
});

test("continuous editing is saved at least every 10 s", async () => {
  const h = harness();
  const changedAt = [];
  for (let t = 0; t < 30000; t += 700) {
    h.change();
    changedAt.push(h.clock.now());
    await h.clock.advance(700);
  }
  await h.clock.advance(2000);
  assert.ok(h.puts.length >= 3, `${h.puts.length} saves`);
  // Every change reaches the server within 10 s.
  for (const at of changedAt) {
    const put = h.puts.find((entry) => entry.at >= at);
    assert.ok(put && put.at - at <= 10000, `change at ${at} saved at ${put?.at}`);
  }
});

test("at most one PUT is in flight; changes during it are saved afterwards", async () => {
  const gate = [];
  const h = harness({
    respond: (doc) => {
      const wait = deferred();
      gate.push(wait);
      return wait.promise.then(() => ({ doc, etag: `e${doc.v}`, warnings: [] }));
    },
  });
  h.change();
  await h.clock.advance(1500);
  assert.equal(h.puts.length, 1);
  h.change();
  h.change();
  await h.clock.advance(5000);
  assert.equal(h.puts.length, 1, "no second PUT while the first is pending");
  gate[0].resolve();
  await h.clock.advance(1500);
  assert.equal(h.puts.length, 2);
  assert.deepEqual(h.puts[1].doc, { v: 3 });
  assert.equal(h.puts[1].etag, "e1", "the second PUT is based on the first one's etag");
  gate[1].resolve();
  await h.clock.advance(100);
  assert.equal(h.maxInFlight, 1);
  assert.equal(h.dirty, false);
});

test("a failed PUT is retried with the same Idempotency-Key; a new payload gets a new key", async () => {
  let failures = 2;
  const h = harness({
    respond: (doc) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(Object.assign(new Error("down"), { status: 503, code: "backend_unavailable" }));
      }
      return Promise.resolve({ doc, etag: `e${doc.v}`, warnings: [] });
    },
  });
  h.change();
  await h.clock.advance(1500);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.events.at(-1), ["error", 1, "backend_unavailable", true]);
  await h.clock.advance(60000);
  assert.equal(h.puts.length, 3);
  assert.equal(new Set(h.puts.map((put) => put.key)).size, 1, "retries of one payload share the key");
  assert.equal(h.dirty, false);
  h.change();
  await h.clock.advance(1500);
  assert.notEqual(h.puts.at(-1).key, h.puts[0].key);
});

test("a changed payload after a failure is sent with a new key", async () => {
  let failures = 1;
  const h = harness({
    respond: (doc) => (failures-- > 0
      ? Promise.reject(Object.assign(new Error("offline"), { status: 0, code: "network_error" }))
      : Promise.resolve({ doc, etag: `e${doc.v}`, warnings: [] })),
  });
  h.change();
  await h.clock.advance(1500);
  h.change();
  await h.clock.advance(60000);
  assert.equal(h.puts.length, 2);
  assert.notEqual(h.puts[0].key, h.puts[1].key);
  assert.deepEqual(h.puts[1].doc, { v: 2 });
});

test("409 revision_conflict goes to onConflict and autosave waits for resume", async () => {
  let conflict = true;
  const h = harness({
    respond: (doc) => (conflict
      ? Promise.reject(Object.assign(new Error("conflict"), { status: 409, code: "revision_conflict", body: {} }))
      : Promise.resolve({ doc, etag: `e${doc.v}`, warnings: [] })),
  });
  h.change();
  await h.clock.advance(1500);
  assert.deepEqual(h.events.at(-1), ["conflict", 1, "revision_conflict"]);
  assert.equal(h.autosave.state, "paused");
  h.change();
  await h.clock.advance(30000);
  assert.equal(h.puts.length, 1, "paused until the conflict is resolved");
  conflict = false;
  h.autosave.resume();
  await h.clock.advance(1500);
  assert.equal(h.puts.length, 2);
  assert.equal(h.dirty, false);
});

test("a permanent error (422) is reported and not retried", async () => {
  const h = harness({ respond: () => Promise.reject(Object.assign(new Error("bad"), { status: 422, code: "range_invalid" })) });
  h.change();
  await h.clock.advance(1500);
  await h.clock.advance(60000);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.events.at(-1), ["error", 1, "range_invalid", false]);
});

test("flush saves immediately and resolves when everything is saved", async () => {
  const h = harness();
  assert.equal(await h.autosave.flush(), null, "nothing to save");
  h.change();
  const result = await h.autosave.flush();
  assert.equal(h.puts.length, 1);
  assert.equal(h.puts[0].at, 0);
  assert.equal(result.etag, "e1");
  assert.equal(h.clock.timers, 0);
});

test("flush during a PUT waits for it and saves the rest", async () => {
  const gate = [];
  const h = harness({
    respond: (doc) => {
      const wait = deferred();
      gate.push(wait);
      return wait.promise.then(() => ({ doc, etag: `e${doc.v}`, warnings: [] }));
    },
  });
  h.change();
  await h.clock.advance(1500);
  h.change();
  const flushed = h.autosave.flush();
  gate[0].resolve();
  await settle();
  await settle();
  assert.equal(h.puts.length, 2);
  gate[1].resolve();
  const result = await flushed;
  assert.equal(result.etag, "e2");
  assert.equal(h.dirty, false);
});

test("flush rejects when the save fails", async () => {
  const h = harness({ respond: () => Promise.reject(Object.assign(new Error("bad"), { status: 422, code: "range_invalid" })) });
  h.change();
  await assert.rejects(h.autosave.flush(), (error) => error.code === "range_invalid");
});

test("destroy cancels the pending timer", async () => {
  const h = harness();
  h.change();
  h.autosave.destroy();
  await h.clock.advance(20000);
  assert.equal(h.puts.length, 0);
});
