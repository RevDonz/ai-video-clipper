import assert from "node:assert/strict";
import test from "node:test";

import { POST as login } from "../app/api/auth/login/route.js";
import { AuthRateLimiter, authRateLimitKeys, parseAuthRateLimitConfig, sharedAuthLimiter } from "../lib/request-security.mjs";

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

// With the user database (rombak 02 §6.1, §7.1): the same threshold, keyed by username and IP.
async function freshRoute(t, extra = {}) {
  const { identityFixture } = await import("./support/session.mjs");
  const control = await identityFixture(t, { AUTH_TRUSTED_CLIENT_IP_HEADER: "nginx", ...extra });
  sharedAuthLimiter("login").entries.clear();
  return control;
}

function fromIp(ip, values) {
  const request = loginRequest(values);
  request.headers.set("X-Real-IP", ip);
  return request;
}

test("the threshold is still 8 attempts in 15 minutes", () => {
  assert.deepEqual(parseAuthRateLimitConfig({}), { attempts: 8, windowMs: 900_000 });
});

test("a username is throttled from any IP, an IP on any username, and 8 are allowed before that", async (t) => {
  await freshRoute(t);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const refused = await login(fromIp(`10.0.0.${attempt + 1}`, { username: "owner", password: "wrong" }));
    assert.equal(refused.headers.get("location"), attempt < 7 ? "/login?error=1" : "/login?error=1", `attempt ${attempt + 1}`);
  }
  const elsewhere = await login(fromIp("10.0.1.1", { username: "owner", password: "correct-horse-battery-staple" }));
  assert.equal(elsewhere.headers.get("location"), "/login?error=limit", "the username key blocks a new IP");
  assert.equal(elsewhere.headers.getSetCookie().length, 0);
  sharedAuthLimiter("login").entries.clear();
  for (let attempt = 0; attempt < 8; attempt += 1) await login(fromIp("10.0.2.2", { username: `name${attempt}`, password: "wrong" }));
  const other = await login(fromIp("10.0.2.2", { username: "owner", password: "correct-horse-battery-staple" }));
  assert.equal(other.headers.get("location"), "/login?error=limit", "the IP key blocks another username");
  const freeIp = await login(fromIp("10.0.2.3", { username: "owner", password: "correct-horse-battery-staple" }));
  assert.equal(freeIp.headers.get("location"), "/dashboard", "another IP and an unused username are fine");
});

test("a success resets both keys", async (t) => {
  await freshRoute(t);
  for (let attempt = 0; attempt < 7; attempt += 1) await login(fromIp("10.0.3.1", { username: "owner", password: "wrong" }));
  assert.equal((await login(fromIp("10.0.3.1", { username: "owner", password: "correct-horse-battery-staple" }))).status, 303);
  assert.equal(sharedAuthLimiter("login").blocked(authRateLimitKeys(fromIp("10.0.3.1", {}), "owner", { AUTH_TRUSTED_CLIENT_IP_HEADER: "nginx" })[0]).blocked, false);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    assert.equal((await login(fromIp("10.0.3.1", { username: "owner", password: "wrong" }))).headers.get("location"), "/login?error=1");
  }
});

test("break-glass is throttled like any login, and an unknown name counts too", async (t) => {
  const { env } = await freshRoute(t);
  const { db } = await import("../lib/db/index.mjs");
  const { hashPassword } = await import("../lib/passwords.mjs");
  db().prepare("UPDATE users SET password_hash = ? WHERE username = 'owner'").run(await hashPassword("changed-password-value"));
  for (let attempt = 0; attempt < 8; attempt += 1) await login(fromIp("10.0.4.1", { username: "owner", password: "wrong" }));
  const glass = await login(fromIp("10.0.4.1", { username: "owner", password: env.APP_PASSWORD }));
  assert.equal(glass.headers.get("location"), "/login?error=limit");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE code = 'auth.break_glass'").get().n, 0);
  sharedAuthLimiter("login").entries.clear();
  const open = await login(fromIp("10.0.4.2", { username: "owner", password: env.APP_PASSWORD }));
  assert.equal(open.headers.get("location"), "/dashboard");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE code = 'auth.break_glass'").get().n, 1);
  const via = db().prepare("SELECT via FROM sessions").get().via;
  assert.equal(via, "break_glass");
});

test("a login form with a foreign origin, or a broken body, never reaches the password check", async (t) => {
  await freshRoute(t);
  const foreign = loginRequest({ username: "owner", password: "x" });
  foreign.headers.set("Origin", "https://evil.example");
  assert.equal((await login(foreign)).status, 403);
  assert.equal(sharedAuthLimiter("login").entries.size, 0);
});

test("the wrong password and an unknown username answer the same", async (t) => {
  await freshRoute(t);
  const wrong = await login(fromIp("10.0.5.1", { username: "owner", password: "wrong" }));
  const unknown = await login(fromIp("10.0.5.2", { username: "nobody-here", password: "wrong" }));
  assert.equal(wrong.status, unknown.status);
  assert.equal(wrong.headers.get("location"), unknown.headers.get("location"));
  assert.deepEqual([...wrong.headers.keys()], [...unknown.headers.keys()]);
});

// i18n M6a (rombak 07 §9.4): the account's language on a second device.
function withLanguage(values, { cookie = null, accept = null } = {}) {
  const request = loginRequest(values);
  if (cookie) request.headers.set("Cookie", cookie);
  if (accept) request.headers.set("Accept-Language", accept);
  return request;
}

const localeOf = (response) => response.headers.getSetCookie().find((line) => line.startsWith("potongin_locale="))?.split(/[=;]/)[1] ?? null;

test("login copies users.locale to the cookie: a second device gets the account's language", async (t) => {
  await freshRoute(t, { POTONGIN_LOCALES: "id,en" });
  const { db } = await import("../lib/db/index.mjs");
  const password = "correct-horse-battery-staple";
  db().prepare("UPDATE users SET locale = 'en' WHERE username = 'owner'").run();
  const secondDevice = await login(withLanguage({ username: "owner", password }, { accept: "id-ID" }));
  assert.equal(localeOf(secondDevice), "en");
  assert.equal(db().prepare("SELECT locale FROM users WHERE username = 'owner'").get().locale, "en");
});

test("a NULL locale is filled from the cookie, then Accept-Language, then id, and saved", async (t) => {
  await freshRoute(t, { POTONGIN_LOCALES: "id,en" });
  const { db } = await import("../lib/db/index.mjs");
  const password = "correct-horse-battery-staple";
  const reset = () => db().prepare("UPDATE users SET locale = NULL WHERE username = 'owner'").run();
  const saved = () => db().prepare("SELECT locale FROM users WHERE username = 'owner'").get().locale;
  assert.equal(localeOf(await login(withLanguage({ username: "owner", password }, { cookie: "potongin_locale=en", accept: "id" }))), "en");
  assert.equal(saved(), "en");
  reset();
  assert.equal(localeOf(await login(withLanguage({ username: "owner", password }, { accept: "en-US,en;q=0.9" }))), "en");
  assert.equal(saved(), "en");
  reset();
  assert.equal(localeOf(await login(withLanguage({ username: "owner", password }, {}))), "id");
  assert.equal(saved(), "id");
});

test("a saved language that is switched off changes nothing; one no longer in the registry counts as none", async (t) => {
  await freshRoute(t, { POTONGIN_LOCALES: "id" });
  const { db } = await import("../lib/db/index.mjs");
  const password = "correct-horse-battery-staple";
  db().prepare("UPDATE users SET locale = 'en' WHERE username = 'owner'").run();
  assert.equal(localeOf(await login(withLanguage({ username: "owner", password }, {}))), null);
  assert.equal(db().prepare("SELECT locale FROM users WHERE username = 'owner'").get().locale, "en");
  db().prepare("UPDATE users SET locale = 'zz' WHERE username = 'owner'").run();
  assert.equal(localeOf(await login(withLanguage({ username: "owner", password }, {}))), "id");
  assert.equal(db().prepare("SELECT locale FROM users WHERE username = 'owner'").get().locale, "id");
});

test("a logout leaves the language cookie alone", async (t) => {
  await freshRoute(t);
  const { POST: logout } = await import("../app/api/auth/logout/route.js");
  const { createSession } = await import("../lib/sessions.mjs");
  const { bootstrapOwnerId } = await import("../lib/users.mjs");
  const { S2_COOKIE } = await import("../lib/auth.mjs");
  const { token } = createSession(bootstrapOwnerId(), { via: "password" });
  const out = await logout(new Request("http://0.0.0.0:3000/api/auth/logout", { method: "POST", headers: { Origin: "http://0.0.0.0:3000", Host: "0.0.0.0:3000", Cookie: `${S2_COOKIE}=${token}; potongin_locale=en` } }));
  assert.equal(out.headers.getSetCookie().some((line) => line.startsWith("potongin_locale")), false);
});
