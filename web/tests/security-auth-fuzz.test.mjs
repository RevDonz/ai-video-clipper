// Fuzzing the session cookie (rombak 02 §11.5): every bad cookie gets the same 401 as no cookie at
// all, status, body and headers, so a guess learns nothing. The invite and reset tokens of the same
// section arrive with their routes in Fase 6; ptk_ tokens of a member with MU-M6.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { S2_COOKIE, SESSION_COOKIE, createSessionToken, requireAuth } from "../lib/auth.mjs";
import { db } from "../lib/db/index.mjs";
import { hashPassword } from "../lib/passwords.mjs";
import { createSession, revokeSession } from "../lib/sessions.mjs";
import { bootstrapOwnerId, createUser, setUserStatus } from "../lib/users.mjs";
import { TEST_ENV, identityFixture } from "./support/session.mjs";

const b64 = (bytes) => randomBytes(bytes).toString("base64url");

async function answer(cookie) {
  const headers = cookie === null ? {} : { cookie };
  const response = requireAuth(new Request("http://local/api/jobs", { headers }));
  if (!response) return null;
  return { status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "date") };
}

const v1Payload = (values) => Buffer.from(JSON.stringify(values)).toString("base64url");

test("every forged, revoked or malformed session cookie answers the one 401", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  const baseline = await answer(null);
  assert.equal(baseline.status, 401);
  assert.equal(JSON.parse(baseline.body).code, "unauthorized");

  const a = createSession(owner, { via: "password" }).token.split(".");
  const member = createUser({ username: "member1", passwordHash: await hashPassword("member-password-value") });
  const b = createSession(member.id, { via: "password" }).token.split(".");
  const revoked = createSession(owner, { via: "password" });
  revokeSession(revoked.session.id, "logout");
  const expired = createSession(owner, { via: "password", now: 1000 });
  const disabled = createUser({ username: "member2", passwordHash: await hashPassword("member-password-value") });
  const ofDisabled = createSession(disabled.id, { via: "password" });
  setUserStatus(disabled.id, "disabled");

  const s2 = (value) => `${S2_COOKIE}=${value}`;
  const v1 = (value) => `${SESSION_COOKIE}=${value}`;
  const nowSec = Math.floor(Date.now() / 1000);
  const cases = {
    "s2 random sid": s2(`s2.${b64(16)}.${b64(32)}`),
    "s2 revoked": s2(revoked.token),
    "s2 expired": s2(expired.token),
    "s2 of a disabled user": s2(ofDisabled.token),
    "sid of A + secret of B": s2(`s2.${a[1]}.${b[2]}`),
    "s2 sid only": s2(`s2.${a[1]}`),
    "s2 wrong prefix": s2(`s1.${a[1]}.${a[2]}`),
    "s2 short secret": s2(`s2.${a[1]}.${a[2].slice(0, 42)}`),
    "s2 long secret": s2(`s2.${a[1]}.${a[2]}x`),
    "s2 long sid": s2(`s2.${a[1]}x.${a[2]}`),
    "s2 very long": s2(`s2.${"a".repeat(100_000)}.${"b".repeat(100_000)}`),
    "s2 NUL": s2(`s2.${"a".repeat(21)}%00.${a[2]}`),
    "s2 unicode": s2(`s2.${"é".repeat(22)}.${a[2]}`),
    "s2 path chars": s2(`s2.../../etc/passwd.${a[2]}`),
    "s2 empty": s2(""),
    "v1 garbage": v1("garbage"),
    "v1 no signature": v1(v1Payload({ username: "owner", expiresAt: nowSec + 1000 })),
    "v1 forged signature": v1(`${v1Payload({ username: "owner", expiresAt: nowSec + 1000 })}.${b64(32)}`),
    "v1 signed with another secret": v1(createSessionToken({ ...TEST_ENV, APP_SESSION_SECRET: "another-secret-with-at-least-thirty-two-chars" }, nowSec)),
    "v1 expired": v1(createSessionToken(TEST_ENV, nowSec - 31 * 24 * 60 * 60)),
    "v1 for another username": v1(createSessionToken({ ...TEST_ENV, APP_USERNAME: "someone" }, nowSec)),
    "v1 empty": v1(""),
    "two bad cookies": `${s2(`s2.${b64(16)}.${b64(32)}`)}; ${v1("garbage")}`,
    "a bad s2 twice": `${s2(`s2.${b64(16)}.${b64(32)}`)}; ${s2(`s2.${b64(16)}.${b64(32)}`)}`,
    "no equals": S2_COOKIE,
    "foreign cookie name": `session=${a[2]}`,
    "other-case name": `__host-potongin_session=${a.join(".")}`,
  };
  for (const [name, cookie] of Object.entries(cases)) assert.deepEqual(await answer(cookie), baseline, name);

  assert.equal(await answer(s2(a.join("."))), null, "the real cookie still passes after all of that");
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND user_id = ?").get(owner).n, 2, "the fuzz wrote nothing");
});

test("a bad s2 next to a valid v1 falls back to v1, and a valid s2 wins over a bad v1", async (t) => {
  await identityFixture(t);
  const good = createSession(bootstrapOwnerId(), { via: "password" });
  assert.equal(await answer(`${S2_COOKIE}=s2.bad; ${SESSION_COOKIE}=${createSessionToken()}`), null);
  assert.equal(await answer(`${S2_COOKIE}=${good.token}; ${SESSION_COOKIE}=garbage`), null);
});

test("no DB configured: the same cookies answer 401, a valid v1 still passes", async (t) => {
  await identityFixture(t);
  const valid = createSessionToken();
  const baseline = await answer(null);
  const saved = process.env.POTONGIN_DB_PATH;
  delete process.env.POTONGIN_DB_PATH;
  t.after(() => { process.env.POTONGIN_DB_PATH = saved; });
  assert.deepEqual(await answer(`${S2_COOKIE}=s2.${b64(16)}.${b64(32)}`), baseline);
  assert.deepEqual(await answer(`${SESSION_COOKIE}=garbage`), baseline);
  assert.equal(await answer(`${SESSION_COOKIE}=${valid}`), null);
});
