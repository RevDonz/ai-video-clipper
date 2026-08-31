import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthRateLimiter,
  authRateLimitKeys,
  parseAuthRateLimitConfig,
  readBoundedUrlEncodedForm,
  sameOriginMutation,
} from "../lib/request-security.mjs";

function request(url = "https://potongin.example/api", headers = {}) {
  return new Request(url, { method: "POST", headers });
}

test("same-origin mutation validation is exact and proxy-safe", () => {
  assert.equal(sameOriginMutation(request(undefined, { origin: "https://potongin.example", host: "potongin.example", "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOriginMutation(request(undefined, { origin: "https://evil.example", host: "potongin.example", "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOriginMutation(request(undefined, { origin: "https://potongin.example", host: "evil.example" })), false);
  assert.equal(sameOriginMutation(request(undefined, { host: "potongin.example" })), false);
  assert.equal(sameOriginMutation(request("http://0.0.0.0:3000/api", { origin: "https://clips.example", host: "clips.example", "sec-fetch-site": "same-origin" })), true);
});

test("bounded login form reads URL-encoded bytes and rejects oversized or wrong content types", async () => {
  const body = new URLSearchParams({ username: "admin", password: "secret", next: "/dashboard" });
  const parsed = await readBoundedUrlEncodedForm(new Request("https://potongin.example/api/auth/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body.toString())) }, body,
  }), 1024);
  assert.equal(parsed.get("username"), "admin");
  await assert.rejects(readBoundedUrlEncodedForm(new Request("https://potongin.example/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}",
  }), 1024));
  await assert.rejects(readBoundedUrlEncodedForm(new Request("https://potongin.example/api/auth/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "9999" }, body: "x=1",
  }), 1024));
  for (const malformed of ["username=%FF", "username=%ZZ", "username=%E0%A4%A"]) {
    await assert.rejects(readBoundedUrlEncodedForm(new Request("https://potongin.example/api/auth/login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: malformed,
    }), 1024));
  }
});

test("auth rate-limit config fails closed and limiter bounds username and client attempts", () => {
  assert.deepEqual(parseAuthRateLimitConfig({ AUTH_RATE_LIMIT_ATTEMPTS: "3", AUTH_RATE_LIMIT_WINDOW_MS: "60000" }), { attempts: 3, windowMs: 60000 });
  assert.throws(() => parseAuthRateLimitConfig({ AUTH_RATE_LIMIT_ATTEMPTS: "NaN", AUTH_RATE_LIMIT_WINDOW_MS: "60000" }));
  const limiter = new AuthRateLimiter({ attempts: 2, windowMs: 1000, maximumKeys: 8 });
  assert.equal(limiter.consume("user:admin", 100).allowed, true);
  assert.equal(limiter.consume("user:admin", 200).allowed, true);
  const denied = limiter.consume("user:admin", 300);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);
  assert.equal(limiter.consume("user:admin", 1200).allowed, true);
  limiter.reset("user:admin");
  assert.equal(limiter.consume("user:admin", 1201).allowed, true);

  const pinned = new AuthRateLimiter({ attempts: 1, windowMs: 10_000, maximumKeys: 2 });
  pinned.consume("target", 0);
  assert.equal(pinned.consume("target", 1).allowed, false);
  pinned.consume("junk", 2);
  assert.equal(pinned.consume("more-junk", 3).allowed, false);
  assert.equal(pinned.consume("target", 4).allowed, false);

  const spoofed = new Request("https://clips.example/login", { headers: { "cf-connecting-ip": "1.2.3.4", "x-real-ip": "5.6.7.8" } });
  assert.equal(authRateLimitKeys(spoofed, "admin", {})[0], authRateLimitKeys(new Request("https://clips.example/login"), "admin", {})[0]);
  assert.notEqual(authRateLimitKeys(spoofed, "admin", { AUTH_TRUSTED_CLIENT_IP_HEADER: "cloudflare" })[0], authRateLimitKeys(new Request("https://clips.example/login"), "admin", {})[0]);
});
