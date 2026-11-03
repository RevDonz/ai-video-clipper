// Accounts and boot (rombak 02 §3.2, §6.6; 01 §10): the bootstrap admin, the smoke user, the rules
// enforced inside tx, the audit list, instance settings, and the CLI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AUDIT_CODES, writeAudit } from "../lib/audit.mjs";
import { BootError, bootApp, ensureSmokeUser } from "../lib/db/boot.mjs";
import { closeDb, db } from "../lib/db/index.mjs";
import { runPrune } from "../lib/db/prune.mjs";
import { INSTANCE_SETTING_KEYS, InstanceSettingError, clearInstanceSettingsCache, getInstanceSetting, setInstanceSettings } from "../lib/instance-settings.mjs";
import { hashPassword, verifyPassword } from "../lib/passwords.mjs";
import { createSession, sessionFromToken } from "../lib/sessions.mjs";
import {
  UserError, bootstrapOwnerId, countUsers, createUser, deleteUser, findUserById, findUserByUsername, getMeta, setUserRole, setUserStatus,
} from "../lib/users.mjs";
import { TEST_ENV, identityFixture, migratedDb, tempControl } from "./support/session.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(86)}`;

function bootEnv(control, extra = {}) {
  return { ...TEST_ENV, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: control.jobsRoot, ...extra };
}

test("the first boot makes the admin from APP_*, with a hash of APP_PASSWORD, audited, and the meta keys", async (t) => {
  await identityFixture(t, { APP_USERNAME: "Pemilik.Satu" });
  const owner = findUserByUsername("pemilik.satu");
  assert.ok(owner, "APP_USERNAME is normalised");
  assert.equal(owner.role, "admin");
  assert.equal(owner.is_bootstrap, 1);
  assert.equal(owner.display_name, "pemilik.satu");
  assert.equal(owner.must_change_password, 0);
  assert.equal((await verifyPassword(TEST_ENV.APP_PASSWORD, owner.password_hash)).ok, true);
  assert.equal(bootstrapOwnerId(), owner.id);
  assert.match(getMeta("instance_id"), /^[0-9a-f-]{36}$/);
  assert.equal(getMeta("min_image_schema"), "1");
  assert.equal(getMeta("fairness_key_version"), "1");
  assert.ok(getMeta("created_at"));
  assert.equal(db().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE code = 'bootstrap.admin_created'").get().n, 1);
});

test("a second boot changes nothing: same owner, same instance id, no new audit", async (t) => {
  const { env } = await identityFixture(t);
  const before = { owner: bootstrapOwnerId(), instance: getMeta("instance_id"), audit: db().prepare("SELECT COUNT(*) AS n FROM audit_events").get().n };
  await bootApp({ env, log: () => {} });
  assert.deepEqual({ owner: bootstrapOwnerId(), instance: getMeta("instance_id"), audit: db().prepare("SELECT COUNT(*) AS n FROM audit_events").get().n }, before);
  assert.equal(countUsers(), 1);
});

test("a changed APP_PASSWORD does not rewrite the user's password; it stays the break-glass value", async (t) => {
  const { env } = await identityFixture(t);
  const before = findUserByUsername("owner").password_hash;
  await bootApp({ env: { ...env, APP_PASSWORD: "a-different-password-now" }, log: () => {} });
  assert.equal(findUserByUsername("owner").password_hash, before);
});

for (const [name, values, pattern] of [
  ["an APP_USERNAME outside the pattern", { APP_USERNAME: "x y" }, /APP_USERNAME harus/],
  ["a short APP_USERNAME", { APP_USERNAME: "ab" }, /APP_USERNAME harus/],
  ["no APP_USERNAME", { APP_USERNAME: undefined }, /APP_USERNAME harus/],
  ["a short secret", { POTONGIN_SETTINGS_SECRET: "short" }, /POTONGIN_SETTINGS_SECRET/],
  ["no secret", { POTONGIN_SETTINGS_SECRET: undefined }, /POTONGIN_SETTINGS_SECRET/],
  ["a relative DB path", { POTONGIN_DB_PATH: "rel/x.sqlite" }, /absolut/],
]) {
  test(`boot refuses ${name}, before it writes anything`, async (t) => {
    const control = tempControl(t);
    closeDb();
    t.after(closeDb);
    await assert.rejects(() => bootApp({ env: bootEnv(control, values), log: () => {} }), (error) => error instanceof BootError && pattern.test(error.message));
  });
}

test("a DB path inside JOBS_ROOT stops the boot", async (t) => {
  const control = tempControl(t);
  closeDb();
  t.after(closeDb);
  mkdirSync(control.jobsRoot, { recursive: true, mode: 0o700 });
  await assert.rejects(() => bootApp({ env: bootEnv(control, { POTONGIN_DB_PATH: path.join(control.jobsRoot, "x.sqlite") }), log: () => {} }), /JOBS_ROOT/);
});

test("without POTONGIN_DB_PATH the boot is single-user: no DB, no settings move", async (t) => {
  const control = tempControl(t);
  closeDb();
  const lines = [];
  const result = await bootApp({ env: { ...TEST_ENV, JOBS_ROOT: control.jobsRoot }, log: (line) => lines.push(line) });
  assert.deepEqual(result, { mode: "single-user" });
  assert.match(lines.join(), /POTONGIN_DB_PATH kosong/);
});

test("the smoke user is a member who cannot start a job, with its own password, and boots stay idempotent", async (t) => {
  const { env } = await identityFixture(t, { E2E_SMOKE_USERNAME: "Smoke-User", E2E_SMOKE_PASSWORD: "smoke-password-value-1234" });
  const smoke = findUserByUsername("smoke-user");
  assert.equal(smoke.role, "member");
  assert.equal(smoke.is_smoke, 1);
  assert.equal(smoke.max_active_jobs, 0);
  assert.equal(smoke.jobs_per_hour, 0);
  assert.equal(smoke.must_change_password, 0);
  assert.equal((await verifyPassword("smoke-password-value-1234", smoke.password_hash)).ok, true);
  assert.equal(getMeta("smoke_user_id"), smoke.id);
  const audits = () => db().prepare("SELECT COUNT(*) AS n FROM audit_events WHERE code = 'smoke.ensured'").get().n;
  assert.equal(audits(), 1);
  assert.equal(await ensureSmokeUser(env), "unchanged");
  assert.equal(audits(), 1, "audit only on a change");
  assert.equal(await ensureSmokeUser({ ...env, E2E_SMOKE_PASSWORD: "another-smoke-password-5678" }), "updated");
  assert.equal(audits(), 2);
  assert.equal((await verifyPassword("another-smoke-password-5678", findUserByUsername("smoke-user").password_hash)).ok, true);
  assert.equal(findUserByUsername("smoke-user").id, smoke.id);
});

test("smoke is skipped without the env, with a bad name, or a name another user holds; the app still boots", async (t) => {
  const { env } = await identityFixture(t);
  const lines = [];
  assert.equal(await ensureSmokeUser(env), "skipped");
  assert.equal(await ensureSmokeUser({ ...env, E2E_SMOKE_USERNAME: "no spaces!", E2E_SMOKE_PASSWORD: "x" }, { log: (line) => lines.push(line) }), "skipped");
  assert.equal(await ensureSmokeUser({ ...env, E2E_SMOKE_USERNAME: "owner", E2E_SMOKE_PASSWORD: "x" }, { log: (line) => lines.push(line) }), "skipped");
  assert.equal(lines.length, 2);
  assert.equal(findUserByUsername("owner").is_smoke, 0, "the admin is not turned into a smoke user");
  assert.equal(findUserByUsername("owner").role, "admin");
});

test("a new smoke username retires the old row and its sessions", async (t) => {
  const { env } = await identityFixture(t, { E2E_SMOKE_USERNAME: "smoke-a", E2E_SMOKE_PASSWORD: "smoke-password-value-1234" });
  const a = findUserByUsername("smoke-a");
  const { token } = createSession(a.id, { via: "password" });
  assert.equal(await ensureSmokeUser({ ...env, E2E_SMOKE_USERNAME: "smoke-b" }), "created");
  assert.equal(findUserByUsername("smoke-a").status, "disabled");
  assert.equal(findUserByUsername("smoke-a").is_smoke, 0);
  assert.equal(sessionFromToken(token), null);
  assert.equal(getMeta("smoke_user_id"), findUserByUsername("smoke-b").id);
});

test("createUser: name rules and uniqueness, the smoke user is never admin", async (t) => {
  migratedDb(t);
  assert.throws(() => createUser({ username: "a", passwordHash: HASH }), (error) => error instanceof UserError && error.code === "username_invalid");
  assert.throws(() => createUser({ username: "-bad-", passwordHash: HASH }), /username_invalid/);
  assert.throws(() => createUser({ username: "smokey", passwordHash: HASH, isSmoke: true, role: "admin" }), /smoke_user_locked/);
  const user = createUser({ username: "Valid.Name", passwordHash: HASH });
  assert.equal(user.username, "valid.name");
  assert.equal(user.display_name, "valid.name");
  assert.throws(() => createUser({ username: "VALID.NAME", passwordHash: HASH }), /username_taken/);
});

test("at least one active admin: demoting, disabling and deleting the last one is refused", async (t) => {
  migratedDb(t);
  const admin = createUser({ username: "admin1", passwordHash: HASH, role: "admin" });
  assert.throws(() => setUserRole(admin.id, "member"), /last_admin/);
  assert.throws(() => setUserStatus(admin.id, "disabled"), /last_admin/);
  assert.throws(() => deleteUser(admin.id), /last_admin/);
  const second = createUser({ username: "admin2", passwordHash: HASH, role: "admin" });
  assert.equal(setUserRole(admin.id, "member").role, "member");
  assert.throws(() => setUserRole(second.id, "member"), /last_admin/);
  assert.equal(setUserRole(admin.id, "admin").role, "admin");
  assert.equal(setUserStatus(second.id, "disabled").status, "disabled");
  assert.throws(() => setUserStatus(admin.id, "disabled"), /last_admin/);
  assert.equal(setUserStatus(second.id, "active").disabled_at, null);
});

test("a smoke user is never promoted, the bootstrap admin is never deleted", async (t) => {
  await identityFixture(t, { E2E_SMOKE_USERNAME: "smoke-a", E2E_SMOKE_PASSWORD: "smoke-password-value-1234" });
  assert.throws(() => setUserRole(findUserByUsername("smoke-a").id, "admin"), /smoke_user_locked/);
  createUser({ username: "another", passwordHash: HASH, role: "admin" });
  assert.throws(() => deleteUser(bootstrapOwnerId()), /self_action_forbidden/);
});

test("deleting a user removes their sessions and writes one audit row", async (t) => {
  await identityFixture(t);
  const member = createUser({ username: "member1", passwordHash: await hashPassword("member-password-value") });
  const { token } = createSession(member.id, { via: "password" });
  deleteUser(member.id, { actor: { userId: bootstrapOwnerId() } });
  assert.equal(findUserById(member.id), null);
  assert.equal(sessionFromToken(token), null);
  assert.equal(db().prepare("SELECT target_label FROM audit_events WHERE code = 'user.deleted'").get().target_label, "member1");
});

test("the audit list refuses unknown codes, and the row holds no prose", async (t) => {
  migratedDb(t);
  assert.throws(() => writeAudit({ code: "user.whatever" }), /tidak dikenal/);
  for (const code of AUDIT_CODES) assert.match(code, /^[a-z_]+\.[a-z_]+$/);
  assert.ok(AUDIT_CODES.includes("auth.break_glass") && AUDIT_CODES.includes("settings.migrated"));
  writeAudit({ code: "smoke.ensured", params: { keys: ["a"] }, now: 5 });
  assert.deepEqual({ ...db().prepare("SELECT at, code, actor_kind, params_json FROM audit_events").get() }, { at: 5, code: "smoke.ensured", actor_kind: "system", params_json: '{"keys":["a"]}' });
});

test("instance settings: the seed reads back, a type error is refused, a save audits names only, the cache is 5 s", async (t) => {
  migratedDb(t);
  clearInstanceSettingsCache();
  t.after(clearInstanceSettingsCache);
  assert.equal(INSTANCE_SETTING_KEYS.length, 14);
  assert.equal(getInstanceSetting("llm_daily_cap", { now: 1000 }), 200);
  assert.equal(getInstanceSetting("member_storage_quota_bytes", { now: 1000 }), null);
  for (const [key, value] of [
    ["signup_mode", "open"], ["llm_share", "yes"], ["llm_daily_cap", 10_001], ["llm_daily_cap", 1.5], ["member_max_active_jobs", -1],
    ["member_max_source_seconds", 0], ["invite_ttl_hours", 721], ["reset_ttl_hours", 169], ["trends_scope", "user"], ["no_such_key", 1],
  ]) assert.throws(() => setInstanceSettings({ [key]: value }), InstanceSettingError, `${key}=${value}`);
  assert.throws(() => getInstanceSetting("no_such_key"), InstanceSettingError);
  setInstanceSettings({ llm_daily_cap: 50, llm_share: false }, { kind: "user", label: "owner" }, { now: 2000 });
  assert.equal(getInstanceSetting("llm_daily_cap", { now: 2001 }), 50);
  assert.deepEqual(JSON.parse(db().prepare("SELECT params_json FROM audit_events WHERE code = 'settings.instance_changed'").get().params_json), { keys: ["llm_daily_cap", "llm_share"] });
  db().prepare("UPDATE instance_settings SET value_json = '7' WHERE key = 'llm_daily_cap'").run();
  assert.equal(getInstanceSetting("llm_daily_cap", { now: 2002 }), 50, "within 5 s");
  assert.equal(getInstanceSetting("llm_daily_cap", { now: 8000 }), 7, "after 5 s");
});

test("prune removes only what is past its age, and never the live rows", async (t) => {
  await identityFixture(t);
  const owner = bootstrapOwnerId();
  const DAY = 86_400_000;
  const now = 400 * DAY;
  const session = (id, values) => db().prepare(`INSERT INTO sessions (id, user_id, secret_sha256, created_at, expires_at, last_seen_at, via, revoked_at, revoke_reason)
    VALUES (?, ?, ?, 0, ?, 0, 'password', ?, ?)`).run(id.padEnd(22, "x"), owner, "0".repeat(64), values.expires, values.revoked ?? null, values.revoked ? "logout" : null);
  session("old-expired", { expires: now - 31 * DAY });
  session("recent-expired", { expires: now - 29 * DAY });
  session("old-revoked", { expires: now + DAY, revoked: now - 31 * DAY });
  session("live", { expires: now + DAY });
  const invite = (id, expires) => db().prepare(`INSERT INTO invites (id, token_sha256, token_prefix, role, locale, created_by, created_at, expires_at) VALUES (?, ?, 'piv_abcdef', 'member', 'id', ?, 0, ?)`)
    .run(id.padEnd(36, "0"), id.padEnd(64, "0"), owner, expires);
  invite("a", now - 8 * DAY);
  invite("b", now - 6 * DAY);
  const reset = (id, expires) => db().prepare(`INSERT INTO password_resets (id, user_id, token_sha256, created_at, expires_at) VALUES (?, ?, ?, 0, ?)`)
    .run(id.padEnd(36, "0"), owner, id.padEnd(64, "0"), expires);
  reset("c", now - 8 * DAY);
  reset("d", now - 6 * DAY);
  db().exec("DELETE FROM audit_events");
  writeAudit({ code: "smoke.ensured", now: now - 181 * DAY });
  writeAudit({ code: "smoke.ensured", now: now - 179 * DAY });
  const beat = (host, at) => db().prepare("INSERT INTO process_heartbeats (role, host, pid, started_at, beat_at) VALUES ('app', ?, 1, 0, ?)").run(host, at);
  beat("gone", now - 2 * DAY);
  beat("here", now - 1000);
  assert.deepEqual(runPrune({ now }), { sessions: 2, invites: 1, password_resets: 1, audit_events: 1, process_heartbeats: 1 });
  assert.deepEqual(db().prepare("SELECT id FROM sessions ORDER BY id").all().map((row) => row.id.replace(/x+$/, "")), ["live", "recent-expired"]);
  assert.deepEqual(runPrune({ now }), { sessions: 0, invites: 0, password_resets: 0, audit_events: 0, process_heartbeats: 0 });
});

function cli(control, args, extra = {}) {
  return spawnSync(process.execPath, ["scripts/admin-reset.mjs", ...args], { cwd: WEB, encoding: "utf8", env: { PATH: process.env.PATH, ...bootEnv(control), ...extra } });
}

test("admin-reset: --admin resets once with must_change, revokes sessions, and never prints a hash", async (t) => {
  const control = await identityFixture(t, { E2E_SMOKE_USERNAME: "smoke-a", E2E_SMOKE_PASSWORD: "smoke-password-value-1234" });
  const owner = findUserByUsername("owner");
  const { token } = createSession(owner.id, { via: "password" });
  closeDb();
  const reset = cli(control, ["--admin", "owner"]);
  assert.equal(reset.status, 0, reset.stderr);
  const password = /^SANDI_SEMENTARA=(.+)$/m.exec(reset.stdout)[1];
  assert.equal(password.length, 20);
  assert.doesNotMatch(reset.stdout, /scrypt/);
  const fresh = findUserByUsername("owner");
  assert.equal(fresh.must_change_password, 1);
  assert.equal((await verifyPassword(password, fresh.password_hash)).ok, true);
  assert.equal(sessionFromToken(token), null);
  assert.equal(JSON.parse(db().prepare("SELECT params_json FROM audit_events WHERE code = 'user.admin_reset'").get().params_json).created, false);
  closeDb();
  assert.match(cli(control, ["--admin", "newadmin"]).stdout, /^DIBUAT newadmin$/m);
  assert.equal(findUserByUsername("newadmin").role, "admin");
  closeDb();
  assert.equal(cli(control, ["--admin", "no spaces"]).status, 64);
  assert.notEqual(cli(control, ["--admin", "smoke-a"]).status, 0, "the smoke user is never an admin");
});

test("admin-reset: --list, --ensure-smoke-user, bad arguments, and a schema floor", async (t) => {
  const control = await identityFixture(t);
  closeDb();
  const list = cli(control, ["--list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^owner\tadmin\tactive\t-$/m);
  assert.equal(cli(control, []).status, 64);
  assert.equal(cli(control, ["--set-setting", "x", "1"]).status, 64);
  assert.equal(cli(control, ["--admin"]).status, 64);
  const smoke = cli(control, ["--ensure-smoke-user"], { E2E_SMOKE_USERNAME: "smoke-a", E2E_SMOKE_PASSWORD: "smoke-password-value-1234" });
  assert.match(smoke.stdout, /^SMOKE=created$/m);
  assert.match(cli(control, ["--list"]).stdout, /^smoke-a\tmember\tactive\tsmoke$/m);
});

test("admin-reset: --purge-legacy-settings exits 2 without a marker, 3 on a changed tree, 0 when it may", async (t) => {
  const control = await identityFixture(t);
  closeDb();
  const legacy = path.join(path.dirname(control.jobsRoot), "settings");
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(legacy, "llm-settings.json"), "{}");
  // The boot wrote a marker saying there was nothing to copy: a tree that appeared since has changed.
  assert.equal(cli(control, ["--purge-legacy-settings"]).status, 3);
  const noMarker = tempControl(t);
  const other = await (async () => {
    closeDb();
    const env = bootEnv(noMarker);
    await bootApp({ env, log: () => {} });
    closeDb();
    return env;
  })();
  const { rmSync } = await import("node:fs");
  rmSync(path.join(other.POTONGIN_SETTINGS_DIR, ".migrated-from-data"));
  assert.equal(spawnSync(process.execPath, ["scripts/admin-reset.mjs", "--purge-legacy-settings"], { cwd: WEB, encoding: "utf8", env: { PATH: process.env.PATH, ...other } }).status, 2);
});
