// The editor draft in IndexedDB (plan §4.5): `{ clipId, baseEtag, baseDoc, commands, doc,
// savedAtMs, inflight }` per clip, written after every command, so a reload restores the work
// (same etag: silently; older etag: through rebase). A raw IndexedDB wrapper, no dependency;
// without IndexedDB (private windows of some browsers, Node) the draft lives in memory.

export const DRAFT_DB = "potongin-editor";
export const DRAFT_STORE = "drafts";

export function createMemoryDraftStore() {
  const records = new Map();
  return {
    records,
    async get(clipId) {
      return records.has(clipId) ? structuredClone(records.get(clipId)) : null;
    },
    async put(draft) {
      records.set(draft.clipId, structuredClone(draft));
    },
    async delete(clipId) {
      records.delete(clipId);
    },
    close() {},
  };
}

export function createDraftStore({ indexedDB = globalThis.indexedDB, dbName = DRAFT_DB, storeName = DRAFT_STORE } = {}) {
  if (!indexedDB) return createMemoryDraftStore();
  let opened = null;
  const open = () => {
    opened ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "clipId" });
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
    async get(clipId) {
      return (await transact("readonly", (store) => store.get(clipId))) ?? null;
    },
    async put(draft) {
      await transact("readwrite", (store) => store.put(draft));
    },
    async delete(clipId) {
      await transact("readwrite", (store) => store.delete(clipId));
    },
    close() {
      opened?.then((db) => db.close(), () => {});
      opened = null;
    },
  };
}

/**
 * Serialises draft writes: while one write is in flight only the newest requested draft waits
 * (older ones are superseded), so the stored draft is at most one write behind the editor.
 * `flush()` resolves when the newest request is stored. Write errors are counted, never thrown
 * (the editor keeps working; the server save is the durable copy).
 */
export function createDraftWriter({ store, now = () => Date.now(), onError = () => {} }) {
  let next = null;
  let active = null;
  const stats = { requested: 0, writes: 0, errors: 0, lastWrittenAt: null, maxLagMs: 0 };

  const pump = async () => {
    while (next) {
      const job = next;
      next = null;
      try {
        if (job.remove) await store.delete(job.clipId);
        else await store.put(job.draft);
        stats.writes += 1;
        stats.lastWrittenAt = now();
        stats.maxLagMs = Math.max(stats.maxLagMs, stats.lastWrittenAt - job.at);
      } catch (error) {
        stats.errors += 1;
        onError(error);
      }
    }
  };

  const enqueue = (job) => {
    stats.requested += 1;
    next = { ...job, at: now() };
    if (!active) active = pump().finally(() => {
      active = null;
    });
    return active;
  };

  return {
    stats,
    write(draft) {
      return enqueue({ draft, clipId: draft.clipId });
    },
    remove(clipId) {
      return enqueue({ remove: true, clipId });
    },
    async flush() {
      while (active) await active;
    },
  };
}
