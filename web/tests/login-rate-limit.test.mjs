import assert from "node:assert/strict";
import test from "node:test";

import { POST as login } from "../app/api/auth/login/route.js";
import { AuthRateLimiter } from "../lib/request-security.mjs";

process.env.APP_USERNAME = "owner";
process.env.APP_PASSWORD = "correct-horse-battery";
process.env.APP_SESSION_SECRET = "a-long-random-session-secret-value-for-tests";

function loginRequest(values) {
  const body = new URLSearchParams(values);
  return new Request("http://0.0.0.0:3000/api/auth/login", {
    method: "POST",
    headers: {
      Origin: "http://0.0.0.0:3000",
      Host: "0.0.0.0:3000",
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": String(Buffer.byteLength(body.toString())),
    },
    body,
  });
}

test("blocked() reports a key at its limit without consuming an attempt", () => {
  const limiter = new AuthRateLimiter({ attempts: 2, windowMs: 60_000 });
  assert.equal(limiter.blocked("k", 0).blocked, false);
  limiter.consume("k", 0);
  limiter.consume("k", 0);
  const state = limiter.blocked("k", 1_000);
  assert.equal(state.blocked, true);
  assert.equal(state.retryAfterSeconds, 59);
  assert.equal(limiter.blocked("k", 1_000).blocked, true, "checking twice does not change the state");
  assert.equal(limiter.blocked("k", 60_000).blocked, false, "the window expires");
});

test("once a username is throttled, even the correct password is refused until the window ends", async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await login(loginRequest({ username: "owner", password: "guess-" + attempt }));
  }
  const correct = await login(loginRequest({ username: "owner", password: "correct-horse-battery" }));
  assert.equal(correct.status, 303);
  assert.equal(correct.headers.get("location"), "/login?error=limit");
  assert.equal(correct.headers.get("set-cookie"), null, "no session for a throttled client");
  assert.match(correct.headers.get("retry-after"), /^\d+$/);
});
