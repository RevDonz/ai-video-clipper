// Sessions (rombak 02 §4): the state machine, the limit of 20, the one upgrade of a v1 cookie,
// logout that revokes on the server, and a password change that rotates. Temp DB only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { POST as login } from "../app/api/auth/login/route.js";
import { POST as logout } from "../app/api/auth/logout/route.js";
import { POST as changePassword } from "../app/api/account/password/route.js";
import { S2_COOKIE, SESSION_COOKIE, createSessionToken, currentUser, requireAuth, sessionFromCookieStore } from "../lib/auth.mjs";
import { db } from "../lib/db/index.mjs";
import { hashPassword, verifyPassword } from "../lib/passwords.mjs";
import { upgradeLegacyCookie } from "../lib/session-upgrade.mjs";
import {
  MAX_SESSIONS_PER_USER, clearSessionCookies, createSession, markReauth, revokeSession, revokeUserSessions, sessionCookie, sessionFromToken, touchSession, upgradeV1Session,
  v1UpgradeState,
} from "../lib/sessions.mjs";
import { bootstrapOwnerId, createUser, findUserById, setUserStatus } from "../lib/users.mjs";
import { TEST_ENV, identityFixture } from "./support/session.mjs";

const ORIGIN = "http://0.0.0.0:3000";

function request(path, { cookie = null, method = "GET", headers = {}, body = undefined } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    body,
    headers: { Host: "0.0.0.0:3000", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
}

function setCookies(response) {
  return response.headers.getSetCookie();
}

function cookieFrom(response, name) {
  const line = setCookies(response).find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1, line.indexOf(";")) : null;
}

test("the token has the shape of 02 §4.1 and only the secret's sha256 is stored", async (t) => {
  await identityFixture(t);
  const { token, session } = createSession(bootstrapOwnerId(), { via: "password", userAgent: "Agent/1" });
  const match = /^s2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(token);
  assert.ok(match);
  const row = db().prepare("SELECT id, secret_sha256, device_label, via FROM sessions").get();
  assert.equal(row.id, match[1]);
  assert.equal(row.secret_sha256, createHash("sha256").update(match[2]).digest("hex"));
  assert.notEqual(row.secret_sha256, match[2]);
  assert.equal(row.device_label, "Agent/1");
  assert.equal(session.expiresAt - session.createdAt, 30 * 24 * 60 * 60 * 1000);
});

test("the cookie is __Host-, HttpOnly, Secure, SameSite=Lax, 30 days, without a Domain", () => {
  const cookie = sessionCookie("s2.a.b");
  assert.equal(cookie, `${S2_COOKIE}=s2.a.b; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
  assert.equal(S2_COOKIE, "__Host-potongin_session");
  assert.doesNotMatch(cookie, /Domain/i);
  const [s2, v1] = clearSessionCookies();
  assert.match(s2, /^__Host-potongin_session=; .*Max-Age=0/);
  assert.match(v1, /^potongin_session=; .*Max-Age=0/);
});

test("a session is valid until it is revoked or expires, and a revoked one stays revoked", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  const { token, session } = createSession(owner, { via: "password", now: 1000 });
  assert.equal(sessionFromToken(token, 1001).user.id, owner);
  assert.equal(sessionFromToken(token, session.expiresAt), null, "absolute expiry");
  assert.equal(sessionFromToken(token, session.expiresAt - 1).session.id, session.id);
  assert.equal(revokeSession(session.id, "logout", { now: 2000 }), 1);
  assert.equal(revokeSession(session.id, "logout", { now: 3000 }), 0, "idempotent");
  assert.equal(sessionFromToken(token, 2001), null);
  const row = db().prepare("SELECT revoked_at, revoke_reason FROM sessions WHERE id = ?").get(session.id);
  assert.deepEqual({ ...row }, { revoked_at: 2000, revoke_reason: "logout" });
  assert.throws(() => revokeSession(session.id, "because"), /alasan/);
});

test("sessionFromToken never throws, for any input", async (t) => {
  await identityFixture(t);
  for (const value of [null, undefined, 42, {}, "", "s2.", "s2.x.y", `s2.${"a".repeat(22)}.${"b".repeat(43)}`, "s2.\u0000.\u0000", "x".repeat(100_000)]) {
    assert.equal(sessionFromToken(value), null, String(value).slice(0, 20));
  }
});

test("sid of A with the secret of B fails", async (t) => {
  await identityFixture(t);
  const a = createSession(bootstrapOwnerId(), { via: "password" }).token.split(".");
  const b = createSession(bootstrapOwnerId(), { via: "password" }).token.split(".");
  assert.equal(sessionFromToken(`s2.${a[1]}.${b[2]}`), null);
});

test("the 21st session revokes the one seen longest ago", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  const tokens = [];
  for (let i = 0; i < MAX_SESSIONS_PER_USER; i += 1) tokens.push(createSession(owner, { via: "password", now: 1000 + i }));
  assert.equal(MAX_SESSIONS_PER_USER, 20);
  db().prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(5000, tokens[0].session.id);
  const next = createSession(owner, { via: "password", now: 6000 });
  assert.equal(sessionFromToken(tokens[1].token, 6001), null, "the oldest last_seen_at went");
  assert.ok(sessionFromToken(tokens[0].token, 6001), "the recently seen one stayed");
  assert.ok(sessionFromToken(next.token, 6001));
  assert.equal(db().prepare("SELECT revoke_reason FROM sessions WHERE id = ?").get(tokens[1].session.id).revoke_reason, "limit");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL").get().n, 20);
});

test("touch writes at most once a minute; reauth is recorded; revoking a user's sessions can spare one", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  const { session, token } = createSession(owner, { via: "password", now: 1000 });
  const seen = () => db().prepare("SELECT last_seen_at FROM sessions WHERE id = ?").get(session.id).last_seen_at;
  touchSession(session.id, 30_000);
  assert.equal(seen(), 1000);
  touchSession(session.id, 62_000);
  assert.equal(seen(), 62_000);
  markReauth(session.id, 70_000);
  assert.equal(sessionFromToken(token, 70_001).session.reauthAt, 70_000);
  const other = createSession(owner, { via: "password", now: 1000 });
  assert.equal(revokeUserSessions(owner, "logout_all", { exceptSid: session.id, now: 80_000 }), 1);
  assert.ok(sessionFromToken(token, 80_001));
  assert.equal(sessionFromToken(other.token, 80_001), null);
});

test("disabling a user ends the sessions; only a break-glass session survives a disabled user", async (t) => {
  await identityFixture(t);
  const member = createUser({ username: "member1", passwordHash: await hashPassword("member-password-value") });
  const session = createSession(member.id, { via: "password" });
  assert.ok(sessionFromToken(session.token));
  setUserStatus(member.id, "disabled");
  assert.equal(sessionFromToken(session.token), null);
  const owner = bootstrapOwnerId();
  const glass = createSession(owner, { via: "break_glass" });
  const plain = createSession(owner, { via: "password" });
  db().prepare("UPDATE users SET status = 'disabled', disabled_at = 1 WHERE id = ?").run(owner);
  assert.ok(sessionFromToken(glass.token));
  assert.equal(sessionFromToken(plain.token), null);
});

test("a v1 cookie upgrades once: one row, with its expiry, the same s2 for parallel requests", async (t) => {
  await identityFixture(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const v1 = createSessionToken(process.env, nowSec);
  const principal = currentUser(request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` }));
  assert.equal(principal.id, bootstrapOwnerId());
  assert.equal(principal.via, "upgrade_v1");
  assert.equal(principal.sessionId, null, "not upgraded yet");
  const req = request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` });
  const first = upgradeLegacyCookie(req, principal);
  const second = upgradeLegacyCookie(req, principal);
  assert.deepEqual(first, second, "parallel requests of one page get the same cookie");
  assert.equal(first.length, 2);
  assert.match(first[0], /^__Host-potongin_session=s2\./);
  assert.match(first[1], /^potongin_session=; .*Max-Age=0/);
  const rows = db().prepare("SELECT via, expires_at FROM sessions").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, "upgrade_v1");
  assert.equal(rows[0].expires_at, principal.v1ExpiresAt * 1000, "the v1 token's own expiry, not 30 new days");
  const maxAge = Number(/Max-Age=(\d+)/.exec(first[0])[1]);
  assert.ok(maxAge > 2_591_000 && maxAge <= 2_592_000);
  const s2 = /=(s2\.[^;]+);/.exec(first[0])[1];
  const after = currentUser(request("/dashboard", { cookie: `${S2_COOKIE}=${s2}` }));
  assert.equal(after.id, bootstrapOwnerId());
  assert.equal(after.via, "upgrade_v1");
  assert.ok(after.sessionId);
});

test("a v1 token whose session was revoked is dead, also for a fresh upgrade", async (t) => {
  await identityFixture(t);
  const v1 = createSessionToken();
  const req = () => request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` });
  const principal = currentUser(req());
  upgradeLegacyCookie(req(), principal);
  const sid = db().prepare("SELECT id FROM sessions").get().id;
  revokeSession(sid, "logout");
  assert.equal(currentUser(req()), null, "stolen v1 cookie after logout");
  assert.equal(v1UpgradeState(v1, process.env.APP_SESSION_SECRET), "ended");
  assert.equal(upgradeV1Session(v1, process.env.APP_SESSION_SECRET, { userId: bootstrapOwnerId(), expiresAtMs: Date.now() + 1000 }), null);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
});

test("an upgrade that cannot write leaves the v1 cookie alone and the request passes", async (t) => {
  await identityFixture(t);
  const v1 = createSessionToken();
  const req = request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` });
  const principal = currentUser(req);
  t.mock.method(console, "warn", () => {});
  const broken = upgradeLegacyCookie(req, { ...principal, id: "00000000-0000-4000-8000-000000000000" });
  assert.deepEqual(broken, [], "foreign key failure: no cookie change at all");
  assert.equal(currentUser(request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` })).id, bootstrapOwnerId());
});

test("without a usable DB the v1 path alone works, as before the user database", async (t) => {
  await identityFixture(t);
  const v1 = createSessionToken();
  const saved = process.env.POTONGIN_DB_PATH;
  delete process.env.POTONGIN_DB_PATH;
  t.after(() => { process.env.POTONGIN_DB_PATH = saved; });
  const principal = currentUser(request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` }));
  assert.equal(principal.id, null);
  assert.equal(principal.via, "v1");
  assert.equal(principal.role, "admin");
  assert.equal(currentUser(request("/dashboard", { cookie: `${S2_COOKIE}=s2.${"a".repeat(22)}.${"b".repeat(43)}` })), null);
});

test("a schema-less DB counts as no DB: the owner still gets in with v1", async (t) => {
  const { dbFile } = await identityFixture(t);
  assert.ok(dbFile);
  const v1 = createSessionToken();
  db().exec("DELETE FROM meta WHERE key = 'bootstrap_owner_id'");
  const principal = currentUser(request("/dashboard", { cookie: `${SESSION_COOKIE}=${v1}` }));
  assert.equal(principal.via, "v1");
});

function form(values) {
  const body = new URLSearchParams(values);
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body.toString())) },
    body,
  };
}

test("login sets s2, clears v1, and a logout revokes on the server: the next request is 401", async (t) => {
  await identityFixture(t);
  const signedIn = await login(request("/api/auth/login", form({ username: "owner", password: TEST_ENV.APP_PASSWORD, next: "/projects" })));
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("location"), "/projects");
  assert.equal(signedIn.headers.get("cache-control"), "no-store");
  const token = cookieFrom(signedIn, S2_COOKIE);
  assert.match(token, /^s2\./);
  assert.equal(cookieFrom(signedIn, SESSION_COOKIE), "", "the v1 cookie goes");
  const cookie = `${S2_COOKIE}=${token}`;
  assert.equal(requireAuth(request("/api/jobs", { cookie })), null);
  assert.ok(db().prepare("SELECT last_login_at FROM users WHERE username = 'owner'").get().last_login_at);

  const out = await logout(request("/api/auth/logout", { cookie, method: "POST" }));
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), "/login?keluar=1");
  assert.equal(setCookies(out).length, 2, "both cookies are cleared");
  const denied = requireAuth(request("/api/jobs", { cookie }));
  assert.equal(denied.status, 401, "the same cookie, replayed");
  assert.equal((await denied.json()).code, "unauthorized");
  assert.equal(db().prepare("SELECT revoke_reason FROM sessions").get().revoke_reason, "logout");
});

test("logout with a v1 cookie that never upgraded ends that token on the server", async (t) => {
  await identityFixture(t);
  const v1 = createSessionToken();
  const cookie = `${SESSION_COOKIE}=${v1}`;
  assert.equal(requireAuth(request("/api/jobs", { cookie })), null);
  await logout(request("/api/auth/logout", { cookie, method: "POST" }));
  assert.equal(requireAuth(request("/api/jobs", { cookie })).status, 401);
});

test("logout with a live s2 cookie and a leftover v1 cookie ends both", async (t) => {
  await identityFixture(t);
  const v1 = createSessionToken();
  const { token } = createSession(bootstrapOwnerId(), { via: "password" });
  await logout(request("/api/auth/logout", { cookie: `${S2_COOKIE}=${token}; ${SESSION_COOKIE}=${v1}`, method: "POST" }));
  assert.equal(requireAuth(request("/api/jobs", { cookie: `${S2_COOKIE}=${token}` })).status, 401);
  assert.equal(requireAuth(request("/api/jobs", { cookie: `${SESSION_COOKIE}=${v1}` })).status, 401);
});

test("logout refuses a foreign origin and revokes nothing", async (t) => {
  await identityFixture(t);
  const { token } = createSession(bootstrapOwnerId(), { via: "password" });
  const cookie = `${S2_COOKIE}=${token}`;
  const refused = await logout(request("/api/auth/logout", { cookie, method: "POST", headers: { Origin: "https://evil.example" } }));
  assert.equal(refused.status, 403);
  assert.equal(requireAuth(request("/api/jobs", { cookie })), null);
});

test("a failed DB login still lets APP_* in with the v1 cookie: the owner is never locked out", async (t) => {
  await identityFixture(t);
  db().exec("PRAGMA foreign_keys=OFF");
  db().exec("DROP TABLE sessions");
  t.mock.method(console, "warn", () => {});
  const signedIn = await login(request("/api/auth/login", form({ username: "owner", password: TEST_ENV.APP_PASSWORD, next: "/projects" })));
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get("location"), "/projects");
  assert.ok(cookieFrom(signedIn, SESSION_COOKIE), "v1 cookie");
});

test("no DB configured: APP_* signs in with the v1 cookie, a wrong password is refused", async (t) => {
  await identityFixture(t);
  const saved = process.env.POTONGIN_DB_PATH;
  delete process.env.POTONGIN_DB_PATH;
  t.after(() => { process.env.POTONGIN_DB_PATH = saved; });
  const good = await login(request("/api/auth/login", form({ username: "owner", password: TEST_ENV.APP_PASSWORD })));
  assert.equal(good.status, 303);
  assert.equal(good.headers.get("location"), "/dashboard");
  assert.ok(cookieFrom(good, SESSION_COOKIE));
  const bad = await login(request("/api/auth/login", form({ username: "owner", password: "nope" })));
  assert.match(bad.headers.get("location"), /error=1/);
});

test("must_change_password: the guard answers 403 outside the allowlist, the login goes to the change page", async (t) => {
  await identityFixture(t);
  const passwordHash = await hashPassword("temporary-password-1");
  const member = createUser({ username: "mustchange", passwordHash, mustChangePassword: true });
  const signedIn = await login(request("/api/auth/login", form({ username: "mustchange", password: "temporary-password-1", next: "/projects" })));
  assert.equal(signedIn.headers.get("location"), "/akun/kata-sandi");
  const cookie = `${S2_COOKIE}=${cookieFrom(signedIn, S2_COOKIE)}`;
  const denied = requireAuth(request("/api/jobs", { cookie }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "password_change_required");
  assert.equal(requireAuth(request("/api/account/password", { cookie, method: "POST" })), null);
  assert.equal(requireAuth(request("/api/auth/logout", { cookie, method: "POST" })), null);
  assert.equal(requireAuth(request("/api/locale", { cookie, method: "POST" })), null);
  assert.equal(requireAuth(request("/api/account", { cookie })), null);
  assert.equal(requireAuth(request("/api/account", { cookie, method: "POST" })).status, 403);
  assert.equal(member.must_change_password, 1);
});

function json(body, cookie, extra = {}) {
  const text = JSON.stringify(body);
  return request("/api/account/password", { cookie, method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: text });
}

test("changing the password: other sessions revoked, this one rotated, must_change cleared, audited", async (t) => {
  await identityFixture(t);
  const member = createUser({ username: "member1", passwordHash: await hashPassword("old-password-value"), mustChangePassword: true });
  const here = createSession(member.id, { via: "password" });
  const elsewhere = createSession(member.id, { via: "password" });
  const cookie = `${S2_COOKIE}=${here.token}`;
  const done = await changePassword(json({ current: "old-password-value", next: "new-password-value" }, cookie));
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { ok: true });
  const fresh = cookieFrom(done, S2_COOKIE);
  assert.match(fresh, /^s2\./);
  assert.equal(sessionFromToken(here.token), null, "this session rotated");
  assert.equal(sessionFromToken(elsewhere.token), null, "the other device is out");
  assert.ok(sessionFromToken(fresh));
  const stored = findUserById(member.id);
  assert.equal(stored.must_change_password, 0);
  assert.equal((await verifyPassword("new-password-value", stored.password_hash)).ok, true);
  const reasons = db().prepare("SELECT DISTINCT revoke_reason FROM sessions WHERE user_id = ? AND revoked_at IS NOT NULL").all(member.id).map((row) => row.revoke_reason);
  assert.deepEqual(reasons, ["password_changed"]);
  assert.deepEqual(JSON.parse(db().prepare("SELECT params_json FROM audit_events WHERE code = 'user.password_changed'").get().params_json), { via: "self" });
});

test("the password route refuses: wrong current, the policy, bad bodies, foreign origin, no session", async (t) => {
  await identityFixture(t);
  const member = createUser({ username: "member2", passwordHash: await hashPassword("old-password-value") });
  const cookie = `${S2_COOKIE}=${createSession(member.id, { via: "password" }).token}`;
  const wrong = await changePassword(json({ current: "nope", next: "new-password-value" }, cookie));
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).messageId, "account.password_wrong");
  const short = await changePassword(json({ current: "old-password-value", next: "short" }, cookie));
  assert.equal(short.status, 400);
  assert.equal((await short.json()).code, "password_too_short");
  assert.equal((await changePassword(json({ current: "old-password-value", next: "member2" }, cookie))).status, 400);
  assert.equal((await changePassword(json({ next: "x" }, cookie))).status, 400);
  assert.equal((await changePassword(request("/api/account/password", { cookie, method: "POST", body: "not json" }))).status, 400);
  assert.equal((await changePassword(json({ current: "a".repeat(5000), next: "b" }, cookie))).status, 400);
  assert.equal((await changePassword(json({ current: "x", next: "y" }, cookie, { Origin: "https://evil.example" }))).status, 403);
  assert.equal((await changePassword(json({ current: "x", next: "y" }, null))).status, 401);
});

test("five wrong current passwords lock the route for this user", async (t) => {
  await identityFixture(t);
  const member = createUser({ username: "member3", passwordHash: await hashPassword("old-password-value") });
  const cookie = `${S2_COOKIE}=${createSession(member.id, { via: "password" }).token}`;
  for (let i = 0; i < 5; i += 1) assert.equal((await changePassword(json({ current: `guess-${i}`, next: "new-password-value" }, cookie))).status, 403);
  const locked = await changePassword(json({ current: "old-password-value", next: "new-password-value" }, cookie));
  assert.equal(locked.status, 429);
  assert.match(locked.headers.get("retry-after"), /^\d+$/);
});

test("a break-glass session may give APP_PASSWORD as the current password", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("forgotten-password-value"), owner);
  const cookie = `${S2_COOKIE}=${createSession(owner, { via: "break_glass" }).token}`;
  const done = await changePassword(json({ current: TEST_ENV.APP_PASSWORD, next: "new-password-value" }, cookie));
  assert.equal(done.status, 200);
});

test("sessionFromCookieStore reads the same principal for a server component", async (t) => {
  await identityFixture(t);
  const { token, session } = createSession(bootstrapOwnerId(), { via: "password" });
  const store = (values) => ({ get: (name) => (Object.hasOwn(values, name) ? { value: values[name] } : undefined) });
  assert.equal(sessionFromCookieStore(store({ [S2_COOKIE]: token })).sessionId, session.id);
  assert.equal(sessionFromCookieStore(store({})), null);
  assert.equal(sessionFromCookieStore(store({ [SESSION_COOKIE]: createSessionToken() })).via, "upgrade_v1");
});
