// A clock for lock and lease tests that moves only when the test says so. It has the shape of the
// `clock` option of withPrimaryQueueLock: `now()` in epoch milliseconds and `sleep(ms, signal)`.
//
// `tick()` jumps to the earliest wake-up and wakes everything due by then. Tests call it only
// while every party is asleep on the clock (`asleep(n)`), so work between two wake-ups (file
// I/O, fsync) always finishes before time moves on, however slow the machine is.

// Only a broken test waits this long: a correct run reaches each sleep in milliseconds.
const STUCK_MS = 30_000;

export function manualClock(startMs) {
  let now = startMs;
  const sleepers = new Set();
  const watchers = new Set();

  const notify = () => {
    for (const watcher of [...watchers]) watcher();
  };

  return {
    now: () => now,

    sleep(milliseconds, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const entry = {
          due: now + Math.max(0, milliseconds),
          wake() {
            if (!sleepers.delete(entry)) return;
            signal?.removeEventListener("abort", entry.wake);
            resolve();
          },
        };
        sleepers.add(entry);
        signal?.addEventListener("abort", entry.wake, { once: true });
        notify();
      });
    },

    get sleeping() {
      return sleepers.size;
    },

    /** The earliest wake-up time, or Infinity when nothing sleeps. */
    nextDue() {
      let due = Infinity;
      for (const entry of sleepers) due = Math.min(due, entry.due);
      return due;
    },

    /** Resolves once at least `count` callers sleep on the clock, or once `until` settles. */
    asleep(count, until = null) {
      if (sleepers.size >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          watchers.delete(check);
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => {
          finish(new Error(`expected ${count} sleepers on the clock, ${sleepers.size} after ${STUCK_MS} ms`));
        }, STUCK_MS);
        function check() {
          if (sleepers.size >= count) finish();
        }
        watchers.add(check);
        until?.then(() => finish(), () => finish());
      });
    },

    /** Moves to the earliest wake-up and wakes every sleeper due by then. */
    tick() {
      const due = this.nextDue();
      if (!Number.isFinite(due)) throw new Error("tick() with nothing asleep on the clock");
      now = Math.max(now, due);
      for (const entry of [...sleepers]) if (entry.due <= now) entry.wake();
    },
  };
}

/** Ticks while `sleepers` callers are asleep, until the next wake-up would pass `untilMs`. */
export async function advanceWhileAsleep(clock, untilMs, { sleepers }) {
  for (;;) {
    await clock.asleep(sleepers);
    if (clock.nextDue() > untilMs) return;
    clock.tick();
  }
}

/** Ticks whenever something sleeps on the clock until `promise` settles; returns its value. */
export async function runUntilSettled(clock, promise, { maxTicks = 100_000 } = {}) {
  let settled = false;
  const watched = promise.then(
    (value) => { settled = true; return value; },
    (error) => { settled = true; throw error; },
  );
  const quiet = watched.catch(() => {});
  for (let ticks = 0; ; ticks += 1) {
    await clock.asleep(1, quiet);
    if (settled) return watched;
    if (ticks >= maxTicks) throw new Error(`still pending after ${maxTicks} ticks`);
    clock.tick();
  }
}
