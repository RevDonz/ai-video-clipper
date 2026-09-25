import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  EDITOR_RATE_LIMITS,
  TokenBucketLimiter,
  createEditorRateLimits,
  sessionRateKey,
} from "../lib/rate-limit.mjs";

function clock(start = 1_000_000) {
  const state = { now: start };
  return { now: () => state.now, advance: (ms) => { state.now += ms; } };
}

test("a bucket allows its capacity in a burst, then refuses with a retry time", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 4, refillPerSecond: 4, now: time.now });
  for (let i = 0; i < 4; i += 1) assert.equal(limiter.take("k").allowed, true);
  const refused = limiter.take("k");
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 250);
  time.advance(249);
  assert.equal(limiter.take("k").allowed, false);
  time.advance(1);
  assert.equal(limiter.take("k").allowed, true);
});

test("tokens refill continuously up to the capacity, never beyond", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 10, now: time.now });
  for (let i = 0; i < 10; i += 1) limiter.take("k");
  time.advance(60_000);
  let allowed = 0;
  while (limiter.take("k").allowed) allowed += 1;
  assert.equal(allowed, 10);
});

test("keys are independent and a refused take does not consume", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("a").allowed, false);
  assert.equal(limiter.take("b").allowed, true);
  time.advance(1000);
  assert.equal(limiter.take("a").allowed, true);
});

test("memory is bounded: the least recently used key is evicted", () => {
  const time = clock();
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0.001, maxKeys: 3, now: time.now });
  for (const key of ["a", "b", "c"]) assert.equal(limiter.take(key).allowed, true);
  assert.equal(limiter.take("a").allowed, false); // a is now the most recently used
  assert.equal(limiter.take("d").allowed, true); // evicts b
  assert.equal(limiter.size, 3);
  assert.equal(limiter.take("b").allowed, true); // b starts full again
  assert.equal(limiter.take("a").allowed, false);
});

test("invalid configuration and keys are rejected", () => {
  for (const options of [{ capacity: 0, refillPerSecond: 1 }, { capacity: 1, refillPerSecond: 0 },
    { capacity: 1.5, refillPerSecond: 1 }, { capacity: 1, refillPerSecond: 1, maxKeys: 0 }]) {
    assert.throws(() => new TokenBucketLimiter(options));
  }
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
  assert.throws(() => limiter.take(""));
  assert.throws(() => limiter.take(42));
  assert.throws(() => limiter.take("k", 2));
});

test("the editor limits follow plan §9.1", () => {
  assert.deepEqual(EDITOR_RATE_LIMITS.plan, { capacity: 10, refillPerSecond: 10, scope: "session" });
  assert.deepEqual(EDITOR_RATE_LIMITS.frame, { capacity: 4, refillPerSecond: 4, scope: "session" });
  assert.deepEqual(EDITOR_RATE_LIMITS.ai, { capacity: 30, refillPerSecond: 30 / 3600, scope: "job" });
  assert.deepEqual(EDITOR_RATE_LIMITS.upload, { capacity: 30, refillPerSecond: 30 / 60, scope: "session" });
});

test("session buckets are keyed by a hash of the session token, never the token", () => {
  const token = "v1.eyJzdWIiOiJhZG1pbiJ9.signature";
  const key = sessionRateKey(token);
  assert.equal(key, createHash("sha256").update(token).digest("hex"));
  assert.ok(!key.includes(token));
  assert.throws(() => sessionRateKey(""));
});

test("plan and frame are per session; AI is per job across sessions", () => {
  const time = clock();
  const limits = createEditorRateLimits({ now: time.now });
  const jobId = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
  for (let i = 0; i < 10; i += 1) assert.equal(limits.check("plan", { sessionToken: "s1", jobId }).allowed, true);
  assert.equal(limits.check("plan", { sessionToken: "s1", jobId }).allowed, false);
  assert.equal(limits.check("plan", { sessionToken: "s2", jobId }).allowed, true);
  for (let i = 0; i < 4; i += 1) assert.equal(limits.check("frame", { sessionToken: "s1", jobId }).allowed, true);
  assert.equal(limits.check("frame", { sessionToken: "s1", jobId }).allowed, false);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(limits.check("ai", { sessionToken: i % 2 ? "s1" : "s2", jobId }).allowed, true);
  }
  const refused = limits.check("ai", { sessionToken: "s3", jobId });
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 120_000);
  assert.equal(limits.check("ai", { sessionToken: "s3", jobId: "0f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55" }).allowed, true);
  assert.throws(() => limits.check("unknown", { sessionToken: "s1", jobId }));
  assert.throws(() => limits.check("ai", { sessionToken: "s1" }));
  assert.throws(() => limits.check("plan", { jobId }));
});
