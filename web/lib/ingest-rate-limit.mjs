// Per-token limits of the agent ingest route (/api/ingest/trends): 60 requests a minute and
// 600 an hour. Fixed windows that start with a token's first request; a refused request does
// not count against either window. In memory, per server process.

export const INGEST_RATE_LIMITS = Object.freeze({ perMinute: 60, perHour: 600 });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ingest rate limit: ${name}`);
  return value;
}

export class IngestRateLimiter {
  constructor({ perMinute = INGEST_RATE_LIMITS.perMinute, perHour = INGEST_RATE_LIMITS.perHour, maximumKeys = 1000 } = {}) {
    this.perMinute = positiveInteger(perMinute, "perMinute");
    this.perHour = positiveInteger(perHour, "perHour");
    this.maximumKeys = positiveInteger(maximumKeys, "maximumKeys");
    this.entries = new Map();
  }

  // Forgets keys whose windows have both ended; if the table is still full, the oldest key.
  #makeRoom(now) {
    if (this.entries.size < this.maximumKeys) return;
    for (const [key, entry] of this.entries) {
      if (now >= entry.minute.resetAt && now >= entry.hour.resetAt) this.entries.delete(key);
    }
    if (this.entries.size >= this.maximumKeys) this.entries.delete(this.entries.keys().next().value);
  }

  /** { allowed, retryAfterSeconds } for one request of `key` (a token id) at `now` (ms). */
  consume(key, now = Date.now()) {
    if (typeof key !== "string" || key === "" || !Number.isFinite(now)) throw new Error("Invalid ingest rate-limit key");
    let entry = this.entries.get(key);
    if (!entry) {
      this.#makeRoom(now);
      entry = { minute: { count: 0, resetAt: now + MINUTE_MS }, hour: { count: 0, resetAt: now + HOUR_MS } };
      this.entries.set(key, entry);
    }
    if (now >= entry.minute.resetAt) entry.minute = { count: 0, resetAt: now + MINUTE_MS };
    if (now >= entry.hour.resetAt) entry.hour = { count: 0, resetAt: now + HOUR_MS };
    const waits = [];
    if (entry.minute.count >= this.perMinute) waits.push(entry.minute.resetAt - now);
    if (entry.hour.count >= this.perHour) waits.push(entry.hour.resetAt - now);
    if (waits.length) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) };
    entry.minute.count += 1;
    entry.hour.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
