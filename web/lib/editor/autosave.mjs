// Autosave (plan §4.5): a save is sent 1.5 s after the last change, and at least every 10 s during
// continuous editing; at most one PUT is in flight; a retry of the same payload reuses the same
// Idempotency-Key (so a PUT whose response was lost is not applied twice); a 409 revision
// conflict pauses autosave and hands over to the store's rebase; `flush()` saves now (blur,
// visibilitychange, export) and resolves once nothing is left to save.
//
// The owner provides `snapshot() → null | { doc, etag, count }` (the body to PUT, the etag it is
// based on and how many pending steps it contains) and `put(doc, { etag, key })`. Timers and the
// clock are injectable for tests.

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_MAX_INTERVAL_MS = 10000;
const RETRYABLE = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export function isRevisionConflict(error) {
  return error?.status === 409 && error?.code === "revision_conflict";
}

export function isRetryable(error) {
  return RETRYABLE.has(error?.status);
}

export function createAutosave({
  snapshot,
  put,
  onSaving = () => {},
  onSaved = () => {},
  onConflict = () => {},
  onError = () => {},
  newKey = () => globalThis.crypto.randomUUID(),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  debounceMs = AUTOSAVE_DEBOUNCE_MS,
  maxIntervalMs = AUTOSAVE_MAX_INTERVAL_MS,
  retryBaseMs = 2000,
  retryMaxMs = 30000,
}) {
  let timer = null;
  let dirtySince = null;
  let lastChange = null;
  let running = null;
  let paused = false;
  let destroyed = false;
  let retrying = false;
  let failures = 0;
  let lastAttempt = null;
  let freshKeyRetried = false;
  let waiters = [];
  let state = "idle";

  const finish = (result) => {
    const list = waiters;
    waiters = [];
    for (const waiter of list) waiter.resolve(result);
  };
  const fail = (error) => {
    const list = waiters;
    waiters = [];
    for (const waiter of list) waiter.reject(error);
  };
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = (at) => {
    cancel();
    timer = setTimer(fire, Math.max(0, at - now()));
    state = retrying ? "retrying" : "scheduled";
  };
  const scheduleNormal = () => {
    const t = now();
    if (dirtySince === null) dirtySince = lastChange ?? t;
    schedule(Math.min((lastChange ?? t) + debounceMs, dirtySince + maxIntervalMs));
  };

  function fire() {
    timer = null;
    if (!paused && !destroyed) run();
  }

  function run() {
    if (running) return running.promise;
    const token = {};
    running = token;
    token.promise = (async () => {
      try {
        for (;;) {
          const snap = snapshot();
          if (!snap) {
            dirtySince = null;
            retrying = false;
            state = "idle";
            finish(null);
            return;
          }
          const json = JSON.stringify(snap.doc);
          const key = lastAttempt && lastAttempt.etag === snap.etag && lastAttempt.json === json ? lastAttempt.key : newKey();
          lastAttempt = { etag: snap.etag, json, key };
          dirtySince = null;
          state = "saving";
          onSaving(snap, key);
          let result;
          try {
            result = await put(snap.doc, { etag: snap.etag, key });
          } catch (error) {
            if (destroyed) return;
            if (error?.status === 409 && error?.code === "idempotency_conflict" && !freshKeyRetried) {
              // The key was used for another payload (never by this client's UUIDs): once more with a new key.
              freshKeyRetried = true;
              lastAttempt = null;
              continue;
            }
            if (isRevisionConflict(error)) {
              paused = true;
              retrying = false;
              lastAttempt = null;
              state = "paused";
              onConflict(error, snap);
              fail(error);
              return;
            }
            if (isRetryable(error)) {
              failures += 1;
              retrying = true;
              const wait = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1));
              onError(error, snap, { retrying: true, retryInMs: wait });
              schedule(now() + wait);
              fail(error);
              return;
            }
            failures = 0;
            retrying = false;
            lastAttempt = null;
            state = "error";
            onError(error, snap, { retrying: false });
            fail(error);
            return;
          }
          if (destroyed) return;
          failures = 0;
          retrying = false;
          lastAttempt = null;
          freshKeyRetried = false;
          onSaved(result, snap, key);
          if (!snapshot()) {
            dirtySince = null;
            state = "idle";
            finish(result);
            return;
          }
          if (waiters.length) continue;
          state = "idle";
          scheduleNormal();
          return;
        }
      } finally {
        if (running === token) running = null;
      }
    })();
    return token.promise;
  }

  return {
    get state() {
      return state;
    },
    get busy() {
      return running !== null;
    },
    /** The document changed. */
    notify() {
      if (destroyed) return;
      const t = now();
      lastChange = t;
      if (dirtySince === null) dirtySince = t;
      if (paused || running || retrying) return;
      scheduleNormal();
    },
    /** Saves now; resolves with the last save result (null when nothing was pending). */
    flush() {
      if (destroyed) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        if (paused) {
          reject(Object.assign(new Error("autosave paused by a conflict"), { code: "revision_conflict", status: 409 }));
          return;
        }
        waiters.push({ resolve, reject });
        if (!running) {
          cancel();
          retrying = false;
          run();
        }
      });
    },
    pause() {
      paused = true;
      cancel();
      state = "paused";
    },
    resume() {
      if (destroyed) return;
      paused = false;
      state = "idle";
      if (snapshot()) scheduleNormal();
    },
    destroy() {
      destroyed = true;
      cancel();
      finish(null);
      state = "idle";
    },
  };
}
