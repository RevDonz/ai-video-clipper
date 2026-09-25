// Token buckets for the editor routes (plan §9.1 "Rate limits"; K13):
//   preview/plan ≤ 10/s and preview/frame ≤ 4/s per session, uploads ≤ 30/min per session,
//   AI suggestions ≤ 30 per job per hour (across sessions: it protects the LLM quota).
// Session buckets are keyed by sha256 of the session token, so the raw token is never kept.
// Memory is bounded: the least recently used key is evicted beyond `maxKeys`.
// In-process state: one app container, so per-process buckets are the whole picture.
import { createHash } from "node:crypto";

export const EDITOR_RATE_LIMITS = Object.freeze({
  plan: Object.freeze({ capacity: 10, refillPerSecond: 10, scope: "session" }),
  frame: Object.freeze({ capacity: 4, refillPerSecond: 4, scope: "session" }),
  ai: Object.freeze({ capacity: 30, refillPerSecond: 30 / 3600, scope: "job" }),
  upload: Object.freeze({ capacity: 30, refillPerSecond: 30 / 60, scope: "session" }),
});

// Sub-microsecond float error must not add a millisecond to a retry time.
const EPSILON_MS = 1e-6;

export class TokenBucketLimiter {
  constructor({ capacity, refillPerSecond, maxKeys = 10_000, now = Date.now }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1
        || typeof refillPerSecond !== "number" || !Number.isFinite(refillPerSecond) || refillPerSecond <= 0
        || !Number.isSafeInteger(maxKeys) || maxKeys < 1 || typeof now !== "function") {
      throw new Error("Invalid token bucket configuration");
    }
    this.capacity = capacity;
    this.msPerToken = 1000 / refillPerSecond;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  get size() {
    return this.buckets.size;
  }

  /** Take one token for `key`: `{allowed, remaining, retryAfterMs}`; a refusal takes nothing. */
  take(key, cost = 1) {
    if (typeof key !== "string" || key === "" || cost !== 1) throw new Error("Invalid rate-limit key");
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key);
      const refilled = (now - bucket.at) / this.msPerToken;
      bucket = { tokens: Math.min(this.capacity, bucket.tokens + Math.max(0, refilled)), at: now };
    } else {
      bucket = { tokens: this.capacity, at: now };
      while (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, bucket);
    if (bucket.tokens + EPSILON_MS / this.msPerToken >= cost) {
      bucket.tokens = Math.max(0, bucket.tokens - cost);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    const retryAfterMs = Math.max(1, Math.ceil((cost - bucket.tokens) * this.msPerToken - EPSILON_MS));
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}

/** The rate-limit key of a session: sha256 hex of its token. */
export function sessionRateKey(token) {
  if (typeof token !== "string" || token === "") throw new Error("Invalid session token");
  return createHash("sha256").update(token).digest("hex");
}

/** One limiter per editor route kind; `check(kind, {sessionToken, jobId})`. */
export function createEditorRateLimits({ now = Date.now, maxKeys = 10_000, limits = EDITOR_RATE_LIMITS } = {}) {
  const limiters = new Map(Object.entries(limits).map(([kind, limit]) => [kind, {
    scope: limit.scope,
    limiter: new TokenBucketLimiter({ capacity: limit.capacity, refillPerSecond: limit.refillPerSecond, maxKeys, now }),
  }]));
  return {
    check(kind, { sessionToken, jobId } = {}) {
      const entry = limiters.get(kind);
      if (!entry) throw new Error("Unknown rate-limit kind");
      if (entry.scope === "job") {
        if (typeof jobId !== "string" || jobId === "") throw new Error("A job id is required");
        return entry.limiter.take(`job:${jobId}`);
      }
      return entry.limiter.take(`session:${sessionRateKey(sessionToken)}`);
    },
  };
}
