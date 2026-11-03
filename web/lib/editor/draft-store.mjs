// The editor draft in IndexedDB (plan §4.5): `{ key, clipId, tabId, baseEtag, baseDoc, commands,
// doc, savedAtMs, inflight }`, written after every command, so a reload restores the work (same
// etag: silently; older etag: through rebase). Drafts are kept per user and per tab (`key` =
// `u:<namespace>:<clipId>#<tabId>`, rombak 02 §6.2), so two tabs of one clip never overwrite each
// other's draft and another user on this device never reads it; the store adopts the drafts of
// closed tabs (`list(clipId)`). A raw IndexedDB wrapper, no dependency; without IndexedDB (some
// private windows, Node) the drafts live in memory.

export const DRAFT_DB = "potongin-editor";
export const DRAFT_STORE = "drafts";

// The namespace of a store built without one (tests, the editor fakes); the app always passes the
// server's opaque value.
export const LOCAL_DRAFT_NAMESPACE = "local";

export function draftKey(namespace, clipId, tabId) {
  return `u:${namespace}:${clipId}#${tabId}`;
}

const prefixOf = (namespace, clipId) => `u:${namespace}:${clipId}#`;

/** Removes every draft on this device (the login page after a logout, 02 §6.2). Never throws. */
export function clearAllDrafts({ indexedDB = globalThis.indexedDB, dbName = DRAFT_DB } = {}) {
  return new Promise((resolve) => {
    if (!indexedDB) { resolve(false); return; }
    try {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function createMemoryDraftStore({ namespace = LOCAL_DRAFT_NAMESPACE } = {}) {
  const records = new Map();
  return {
    records,
    async get(key) {
      return records.has(key) ? structuredClone(records.get(key)) : null;
    },
    async list(clipId) {
      return [...records.keys()].filter((key) => key.startsWith(prefixOf(namespace, clipId))).sort()
        .map((key) => structuredClone(records.get(key)));
    },
    async put(draft) {
      records.set(draft.key, structuredClone(draft));
    },
    async delete(key) {
      records.delete(key);
    },
    close() {},
  };
}

export function createDraftStore({ indexedDB = globalThis.indexedDB, keyRange = globalThis.IDBKeyRange, dbName = DRAFT_DB,
  storeName = DRAFT_STORE, namespace = LOCAL_DRAFT_NAMESPACE } = {}) {
  if (!indexedDB || !keyRange) return createMemoryDraftStore({ namespace });
  let opened = null;
  const open = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("draft database blocked"));
    });
    return opened;
  };
  const transact = async (mode, operation) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error("draft transaction aborted"));
    });
  };
  return {
    async get(key) {
      return (await transact("readonly", (store) => store.get(key))) ?? null;
    },
    async list(clipId) {
      const range = keyRange.bound(prefixOf(namespace, clipId), `${prefixOf(namespace, clipId)}￿`);
      return (await transact("readonly", (store) => store.getAll(range))) ?? [];
    },
    async put(draft) {
      await transact("readwrite", (store) => store.put(draft));
    },
    async delete(key) {
      await transact("readwrite", (store) => store.delete(key));
    },
    close() {
      opened?.then((db) => db.close(), () => {});
      opened = null;
    },
  };
}

/**
 * Serialises draft writes per key: while one write is in flight only the newest request of each
 * draft waits (older ones are superseded), so a stored draft is at most one write behind the
 * editor. `flush()` resolves when every request is stored. Write errors are counted, never
 * thrown (the editor keeps working; the server save is the durable copy).
 */
export function createDraftWriter({ store, now = () => Date.now(), onError = () => {} }) {
  const queue = new Map();
  let active = null;
  const stats = { requested: 0, writes: 0, errors: 0, lastWrittenAt: null, maxLagMs: 0 };

  // The pump clears `active` itself, in the same microtask in which it sees the queue empty, so a
  // write queued a moment later always starts a new pump (never waits on a finished one).
  const pump = (token) => (async () => {
    try {
      while (queue.size) {
        const [key, job] = queue.entries().next().value;
        queue.delete(key);
        try {
          if (job.remove) await store.delete(key);
          else await store.put(job.draft);
          stats.writes += 1;
          stats.lastWrittenAt = now();
          stats.maxLagMs = Math.max(stats.maxLagMs, stats.lastWrittenAt - job.at);
        } catch (error) {
          stats.errors += 1;
          onError(error);
        }
      }
    } finally {
      if (active === token) active = null;
    }
  })();

  const enqueue = (key, job) => {
    stats.requested += 1;
    queue.delete(key);
    queue.set(key, { ...job, at: now() });
    if (!active) {
      const token = {};
      active = token;
      token.promise = pump(token);
    }
    return active?.promise ?? Promise.resolve();
  };

  return {
    stats,
    write(draft) {
      return enqueue(draft.key, { draft });
    },
    remove(key) {
      return enqueue(key, { remove: true });
    },
    async flush() {
      while (active) await active.promise;
    },
  };
}
