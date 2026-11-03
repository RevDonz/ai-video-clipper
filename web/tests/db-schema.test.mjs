// Every CHECK, UNIQUE and FK of 0001-identity.sql refuses a bad row (rombak 01 §11.1), the audit
// table is append-only, and the seed equals 02 §3.3.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { migratedDb } from "./support/session.mjs";

const HASH = `scrypt$15$8$1$${"s".repeat(22)}$${"h".repeat(86)}`;
const NOW = 1_800_000_000_000;

function insertUser(connection, values = {}) {
  const row = {
    id: randomUUID(), username: `user${Math.floor(Math.random() * 1e9)}`, display_name: "U", role: "member", status: "active",
    password_hash: HASH, must_change_password: 0, is_bootstrap: 0, is_smoke: 0, locale: null, password_changed_at: NOW,
    created_at: NOW, updated_at: NOW, disabled_at: null, ...values,
  };
  const names = Object.keys(row);
  connection.prepare(`INSERT INTO users (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
  return row;
}

function insertSession(connection, userId, values = {}) {
  const row = {
    id: "a".repeat(22), user_id: userId, secret_sha256: "0".repeat(64), created_at: NOW, expires_at: NOW + 1, last_seen_at: NOW,
    via: "password", ...values,
  };
  const names = Object.keys(row);
  connection.prepare(`INSERT INTO sessions (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
}

const CHECK = /CHECK constraint failed|constraint failed/;

test("users refuses each bad value", (t) => {
  const { connection } = migratedDb(t);
  const bad = [
    { username: "ab" }, { username: "a".repeat(33) }, { username: "Upper" }, { username: "with space" }, { username: "ünicode" },
    { display_name: "" }, { display_name: "x".repeat(61) }, { role: "owner" }, { status: "gone" }, { password_hash: "plain" },
    { must_change_password: 2 }, { is_bootstrap: 2 }, { is_smoke: 2 }, { locale: "x" }, { locale: "ID" }, { locale: "a".repeat(17) },
    { storage_quota_bytes: -1 }, { max_active_jobs: -1 }, { max_running_jobs: -1 }, { jobs_per_hour: -1 }, { max_source_seconds: 0 },
    { llm_share: 2 }, { trends_enabled: 2 }, { id: "short" },
    { status: "disabled" }, { status: "active", disabled_at: NOW },
    { is_smoke: 1, role: "admin" }, { is_smoke: 1, is_bootstrap: 1 },
  ];
  for (const values of bad) assert.throws(() => insertUser(connection, values), CHECK, JSON.stringify(values));
  insertUser(connection, { username: "ok.name-1_a", locale: "id", status: "disabled", disabled_at: NOW });
});

test("usernames are unique without regard to case, and bootstrap and smoke are single", (t) => {
  const { connection } = migratedDb(t);
  insertUser(connection, { username: "same" });
  assert.throws(() => insertUser(connection, { username: "same" }), /UNIQUE/);
  insertUser(connection, { is_bootstrap: 1, role: "admin" });
  assert.throws(() => insertUser(connection, { is_bootstrap: 1, role: "admin" }), /UNIQUE/);
  insertUser(connection, { is_smoke: 1 });
  assert.throws(() => insertUser(connection, { is_smoke: 1 }), /UNIQUE/);
});

test("sessions refuses each bad value and needs a user", (t) => {
  const { connection } = migratedDb(t);
  const user = insertUser(connection);
  for (const values of [
    { id: "short" }, { secret_sha256: "x" }, { expires_at: NOW }, { via: "magic" }, { device_label: "x".repeat(121) },
    { revoked_at: NOW }, { revoke_reason: "logout" }, { revoked_at: NOW, revoke_reason: "x".repeat(33) },
  ]) assert.throws(() => insertSession(connection, user.id, values), CHECK, JSON.stringify(values));
  assert.throws(() => insertSession(connection, randomUUID()), /FOREIGN KEY/);
  insertSession(connection, user.id, { revoked_at: NOW, revoke_reason: "logout" });
});

test("deleting a user cascades to their sessions and tokens, and clears audit references", (t) => {
  const { connection } = migratedDb(t);
  const user = insertUser(connection);
  insertSession(connection, user.id);
  connection.prepare(`INSERT INTO api_tokens (id, user_id, label, prefix, sha256, scopes, created_at) VALUES (?, ?, 'x', 'ptk_abcdef', ?, '["trends:read"]', ?)`)
    .run(randomUUID(), user.id, "1".repeat(64), NOW);
  connection.prepare(`INSERT INTO password_resets (id, user_id, token_sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(randomUUID(), user.id, "2".repeat(64), NOW, NOW + 1);
  connection.prepare(`INSERT INTO audit_events (at, code, actor_kind, actor_user_id) VALUES (?, 'user.created', 'user', ?)`).run(NOW, user.id);
  connection.prepare("DELETE FROM users WHERE id = ?").run(user.id);
  for (const table of ["sessions", "api_tokens", "password_resets"]) {
    assert.equal(connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(connection.prepare("SELECT actor_user_id FROM audit_events").get().actor_user_id, null);
});

test("the other tables refuse their bad values", (t) => {
  const { connection } = migratedDb(t);
  const user = insertUser(connection);
  const invite = (values = {}) => {
    const row = {
      id: randomUUID(), token_sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"), token_prefix: "piv_abcdef", role: "member", locale: "id",
      created_by: user.id, created_at: NOW, expires_at: NOW + 1, ...values,
    };
    const names = Object.keys(row);
    connection.prepare(`INSERT INTO invites (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
  };
  for (const values of [{ token_prefix: "piv_" }, { role: "x" }, { locale: "x" }, { expires_at: NOW }, { used_at: NOW, revoked_at: NOW }, { note: "x".repeat(81) }, { username_hint: "x".repeat(33) }]) {
    assert.throws(() => invite(values), CHECK, JSON.stringify(values));
  }
  invite();
  const token = (values = {}) => {
    const row = {
      id: randomUUID(), user_id: user.id, label: "agen", prefix: "ptk_abcdef", sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      scopes: '["trends:read"]', created_at: NOW, ...values,
    };
    const names = Object.keys(row);
    connection.prepare(`INSERT INTO api_tokens (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...Object.values(row));
  };
  for (const values of [{ label: "" }, { label: "x".repeat(41) }, { prefix: "bad_abcdef" }, { prefix: "ptk_" }, { scopes: "[]" }, { scopes: "{}" }, { scopes: "nope" }, { imported_from: "other" }]) {
    assert.throws(() => token(values), CHECK, JSON.stringify(values));
  }
  token();
  assert.throws(() => connection.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('BAD KEY', 'x', 0)").run(), CHECK);
  assert.throws(() => connection.prepare("INSERT INTO instance_settings (key, value_json, updated_at) VALUES ('a', 'not json', 0)").run(), CHECK);
  assert.throws(() => connection.prepare("INSERT INTO process_heartbeats (role, host, pid, started_at, beat_at) VALUES ('render', 'h', 1, 0, 0)").run(), CHECK);
  assert.throws(() => connection.prepare("INSERT INTO process_heartbeats (role, host, pid, started_at, beat_at) VALUES ('app', 'h', 0, 0, 0)").run(), CHECK);
});

test("audit_events is append-only, keeps a valid shape, and may lose its user references", (t) => {
  const { connection } = migratedDb(t);
  const user = insertUser(connection);
  const add = (code = "user.created", kind = "user", params = "{}") => connection.prepare(`INSERT INTO audit_events (at, code, actor_kind, actor_user_id, params_json) VALUES (?, ?, ?, ?, ?)`)
    .run(NOW, code, kind, user.id, params);
  add();
  for (const update of ["at = 1", "code = 'x.y'", "actor_kind = 'cli'", "actor_label = 'x'", "target_label = 'x'", "params_json = '{\"a\":1}'", "request_id = 'x'"]) {
    assert.throws(() => connection.exec(`UPDATE audit_events SET ${update}`), /audit_append_only/, update);
  }
  assert.throws(() => add("nodot"), CHECK);
  assert.throws(() => add("user.created", "robot"), CHECK);
  assert.throws(() => add("user.created", "user", "[]"), CHECK);
  assert.throws(() => add("user.created", "user", `{"a":"${"x".repeat(2048)}"}`), CHECK);
  connection.exec("UPDATE audit_events SET actor_user_id = NULL");
  connection.exec("DELETE FROM audit_events");
});

test("the seed of instance_settings equals 02 §3.3", (t) => {
  const { connection } = migratedDb(t);
  const seed = Object.fromEntries(connection.prepare("SELECT key, value_json FROM instance_settings").all().map((row) => [row.key, JSON.parse(row.value_json)]));
  assert.deepEqual(seed, {
    signup_mode: "invite", llm_share: true, llm_daily_cap: 200, groq_share: false, youtube_cookies_share: true, member_llm_keys_allowed: true,
    trends_scope: "instance", member_max_active_jobs: 3, member_max_running_jobs: 1, member_jobs_per_hour: 30, member_max_source_seconds: 14400,
    member_storage_quota_bytes: null, invite_ttl_hours: 168, reset_ttl_hours: 24,
  });
});

test("every table is STRICT", (t) => {
  const { connection } = migratedDb(t);
  const tables = connection.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  assert.deepEqual(tables.map((row) => row.name).sort(), [
    "api_tokens", "audit_events", "instance_settings", "invites", "meta", "password_resets", "process_heartbeats", "schema_migrations", "sessions", "users",
  ]);
  for (const { name, sql } of tables) assert.match(sql, /\bSTRICT\b/, name);
});
