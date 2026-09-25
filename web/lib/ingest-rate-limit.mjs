// Per-token limits of the agent ingest route (/api/ingest/trends): 60 requests a minute and
// 600 an hour. Fixed windows that start with a token's first request; a refused request does
// not count against either window. In memory, per server process. The same limiter also
// counts failed token checks per trusted client IP (INGEST_FAILED_AUTH_LIMITS).

export const INGEST_RATE_LIMITS = Object.freeze({ perMinute: 60, perHour: 600 });
// Failed token checks per client IP (only when the IP comes from a trusted proxy header): a
// client that keeps sending wrong tokens is refused before its next check.
export const INGEST_FAILED_AUTH_LIMITS = Object.freeze({ perMinute: 30, perHour: 300 });

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

  #decision(entry, now) {
    const waits = [];
    if (now < entry.minute.resetAt && entry.minute.count >= this.perMinute) waits.push(entry.minute.resetAt - now);
    if (now < entry.hour.resetAt && entry.hour.count >= this.perHour) waits.push(entry.hour.resetAt - now);
    if (waits.length) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1000)) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** { allowed, retryAfterSeconds } for one request of `key` (a token id) at `now` (ms). */
  consume(key, now = Date.now()) {
    checkKey(key, now);
    let entry = this.entries.get(key);
    if (!entry) {
      this.#makeRoom(now);
      entry = { minute: { count: 0, resetAt: now + MINUTE_MS }, hour: { count: 0, resetAt: now + HOUR_MS } };
      this.entries.set(key, entry);
    }
    if (now >= entry.minute.resetAt) entry.minute = { count: 0, resetAt: now + MINUTE_MS };
    if (now >= entry.hour.resetAt) entry.hour = { count: 0, resetAt: now + HOUR_MS };
    const decision = this.#decision(entry, now);
    if (!decision.allowed) return decision;
    entry.minute.count += 1;
    entry.hour.count += 1;
    return decision;
  }

  /** What consume(key, now) would decide, without counting anything. */
  peek(key, now = Date.now()) {
    checkKey(key, now);
    const entry = this.entries.get(key);
    return entry ? this.#decision(entry, now) : { allowed: true, retryAfterSeconds: 0 };
  }
}

function checkKey(key, now) {
  if (typeof key !== "string" || key === "" || !Number.isFinite(now)) throw new Error("Invalid ingest rate-limit key");
}
