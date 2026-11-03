// Password hashing and policy (rombak 02 §5) and the login check (§6.1, §6.6).
import assert from "node:assert/strict";
import { randomBytes, scrypt } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { db } from "../lib/db/index.mjs";
import {
  BUSY_RETRY_AFTER_SECONDS, DUMMY_HASH, ENV_PLACEHOLDER_PASSWORD, PasswordBusyError, checkPasswordPolicy, hashPassword, verifyLogin, verifyPassword,
} from "../lib/passwords.mjs";
import { createUser, findUserByUsername, setUserStatus } from "../lib/users.mjs";
import { TEST_ENV, identityFixture } from "./support/session.mjs";

test("the hash has the format of 01 §4.1 and 16 byte salt, 64 byte hash", async () => {
  const stored = await hashPassword("correct horse battery");
  const match = /^scrypt\$15\$8\$1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  assert.ok(match, stored);
  assert.equal(Buffer.from(match[1], "base64url").length, 16);
  assert.equal(Buffer.from(match[2], "base64url").length, 64);
  assert.notEqual(stored, await hashPassword("correct horse battery"), "a new salt each time");
});

test("verify: right, wrong, NFC, malformed", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.deepEqual(await verifyPassword("correct horse battery", stored), { ok: true, needsRehash: false });
  assert.deepEqual(await verifyPassword("Correct horse battery", stored), { ok: false, needsRehash: false });
  const composed = await hashPassword("café-long-enough-password");
  assert.equal((await verifyPassword("café-long-enough-password", composed)).ok, true, "NFC before hashing");
  for (const bad of ["", "plain", "scrypt$", "scrypt$99$8$1$aaaaaaaaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
    assert.deepEqual(await verifyPassword("x", bad), { ok: false, needsRehash: false }, bad);
  }
  assert.equal((await verifyPassword("anything", DUMMY_HASH)).ok, false);
});

test("a hash with weaker parameters verifies and asks for a rehash", async () => {
  const salt = randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    scrypt("old-password-value", salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => (error ? reject(error) : resolve(value)));
  });
  const weak = `scrypt$14$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
  assert.deepEqual(await verifyPassword("old-password-value", weak), { ok: true, needsRehash: true });
});

test("the policy of 02 §5, without composition rules", () => {
  assert.equal(checkPasswordPolicy("short", "user"), "password_too_short");
  assert.equal(checkPasswordPolicy("x".repeat(11), "user"), "password_too_short");
  assert.equal(checkPasswordPolicy("\u{1F600}".repeat(11), "user"), "password_too_short", "code points, not UTF-16 units");
  assert.equal(checkPasswordPolicy("x".repeat(129), "user"), "password_too_long");
  assert.equal(checkPasswordPolicy("\u{1F600}".repeat(128), "user"), null);
  assert.equal(checkPasswordPolicy("ࠀ".repeat(128), "user"), null, "384 bytes is under the byte limit");
  assert.equal(checkPasswordPolicy("Username.Long.Enough", "username.long.enough"), "password_same_as_username");
  assert.equal(checkPasswordPolicy("all lowercase no digits at all", "user"), null);
  assert.equal(checkPasswordPolicy("x".repeat(12), "user"), null);
});

test("the common list is the shipped 10,000-line file and matches without regard to case", () => {
  const lines = readFileSync(new URL("../../resources/auth/common-passwords.txt", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 10_000);
  const long = lines.filter((line) => Array.from(line).length >= 12);
  assert.ok(long.length > 0, "the list has entries long enough to reach this check");
  for (const entry of long) {
    assert.equal(checkPasswordPolicy(entry, "user"), "password_common", entry);
    assert.equal(checkPasswordPolicy(entry.toUpperCase(), "user"), "password_common", entry);
  }
  assert.equal(checkPasswordPolicy("sayangku-bukan-di-daftar", "user"), null);
});

test("a full queue answers 429 with Retry-After: 4 running, 16 waiting, the rest refused", async () => {
  const tasks = Array.from({ length: 24 }, () => hashPassword("correct horse battery"));
  const settled = await Promise.allSettled(tasks);
  const refused = settled.filter((entry) => entry.status === "rejected");
  assert.equal(refused.length, 4);
  for (const { reason } of refused) {
    assert.ok(reason instanceof PasswordBusyError);
    assert.equal(reason.code, "rate_limited");
    assert.equal(reason.retryAfterSeconds, BUSY_RETRY_AFTER_SECONDS);
    assert.equal(BUSY_RETRY_AFTER_SECONDS, 5);
  }
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 20);
});

test("verifyLogin: the DB user, any case of the name, and the same work for an unknown name", async (t) => {
  await identityFixture(t);
  const hits = await verifyLogin("OWNER", TEST_ENV.APP_PASSWORD);
  assert.equal(hits.via, "password");
  assert.equal(hits.user.username, "owner");
  assert.equal(await verifyLogin("owner", "wrong-password-value"), null);
  const started = Date.now();
  assert.equal(await verifyLogin("nobody-here", "whatever"), null);
  assert.ok(Date.now() - started >= 5, "scrypt ran for an unknown username");
  assert.equal(await verifyLogin("Bad Name!", "whatever"), null);
  assert.equal(await verifyLogin("", ""), null);
});

test("verifyLogin: a disabled user cannot sign in with their own password", async (t) => {
  await identityFixture(t);
  const passwordHash = await hashPassword("member-password-value");
  const member = createUser({ username: "member1", passwordHash });
  assert.equal((await verifyLogin("member1", "member-password-value")).via, "password");
  setUserStatus(member.id, "disabled");
  assert.equal(await verifyLogin("member1", "member-password-value"), null);
});

test("break-glass: APP_* opens the owner's session after a password change and while disabled, audited each time", async (t) => {
  await identityFixture(t);
  const owner = findUserByUsername("owner");
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("changed-password-value"), owner.id);
  assert.equal((await verifyLogin("owner", "changed-password-value")).via, "password");
  const glass = await verifyLogin("owner", TEST_ENV.APP_PASSWORD);
  assert.equal(glass.via, "break_glass");
  assert.equal(glass.user.id, owner.id);
  db().prepare("UPDATE users SET status = 'disabled', disabled_at = 1 WHERE id = ?").run(owner.id);
  assert.equal((await verifyLogin("owner", "changed-password-value")), null);
  assert.equal((await verifyLogin("owner", TEST_ENV.APP_PASSWORD)).via, "break_glass", "open issue: break-glass ignores disabled (02 §17 #4)");
  const audited = db().prepare("SELECT code, actor_kind, actor_label FROM audit_events WHERE code = 'auth.break_glass'").all().map((row) => ({ ...row }));
  assert.equal(audited.length, 2);
  assert.deepEqual(audited[0], { code: "auth.break_glass", actor_kind: "user", actor_label: "owner" });
});

test("break-glass: refused with the .env.example placeholder, without a secret, or for a wrong name", async (t) => {
  await identityFixture(t);
  const owner = findUserByUsername("owner");
  db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await hashPassword("changed-password-value"), owner.id);
  assert.equal(await verifyLogin("owner", ENV_PLACEHOLDER_PASSWORD, { ...process.env, APP_PASSWORD: ENV_PLACEHOLDER_PASSWORD }), null);
  assert.equal(await verifyLogin("owner", TEST_ENV.APP_PASSWORD, { ...process.env, APP_SESSION_SECRET: "short" }), null);
  assert.equal(await verifyLogin("someone", TEST_ENV.APP_PASSWORD), null);
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE code = 'auth.break_glass'").get().n, 0);
});

test("a login with weaker stored parameters rewrites the hash", async (t) => {
  await identityFixture(t);
  const salt = randomBytes(16);
  const key = await new Promise((resolve, reject) => {
    scrypt("member-password-value", salt, 64, { N: 2 ** 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => (error ? reject(error) : resolve(value)));
  });
  createUser({ username: "weakhash", passwordHash: `scrypt$14$8$1$${salt.toString("base64url")}$${key.toString("base64url")}` });
  assert.equal((await verifyLogin("weakhash", "member-password-value")).via, "password");
  assert.match(findUserByUsername("weakhash").password_hash, /^scrypt\$15\$/);
  assert.equal((await verifyLogin("weakhash", "member-password-value")).via, "password");
});
