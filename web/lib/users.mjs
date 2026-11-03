// Accounts (rombak 02 §3.2, §6.6). Everything here is synchronous; the password hash is computed
// by the caller before the transaction (lib/passwords.mjs). Enforced inside tx: at least one active
// admin, the smoke user is never admin, the bootstrap admin cannot be deleted.
import { randomUUID } from "node:crypto";

import { writeAudit } from "./audit.mjs";
import { db, tx } from "./db/index.mjs";
import { revokeUserSessions } from "./sessions.mjs";

export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
export const SMOKE_LOCKED_LIMITS = Object.freeze({ max_active_jobs: 0, jobs_per_hour: 0 });

const USER_COLUMNS = `id, username, display_name, role, status, password_hash, must_change_password, is_bootstrap, is_smoke,
  locale, storage_quota_bytes, max_active_jobs, max_running_jobs, jobs_per_hour, max_source_seconds, llm_share, trends_enabled,
  password_changed_at, last_login_at, created_at, updated_at, disabled_at, created_by`;

export class UserError extends Error {
  constructor(code) {
    super(code);
    this.name = "UserError";
    this.code = code;
  }
}

export function normalizeUsername(value) {
  return typeof value === "string" ? value.normalize("NFC").toLowerCase() : "";
}

export function isValidUsername(value) {
  return USERNAME_PATTERN.test(value);
}

export function getMeta(key) {
  return db().prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(key, value, now = Date.now()) {
  db().prepare(`INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, String(value), now);
}

export function bootstrapOwnerId() {
  return getMeta("bootstrap_owner_id");
}

export function countUsers() {
  return Number(db().prepare("SELECT COUNT(*) AS n FROM users").get().n);
}

export function listUsers() {
  return db().prepare("SELECT username, role, status, is_smoke FROM users ORDER BY username").all();
}

export function findUserById(id) {
  return db().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) ?? null;
}

export function findUserByUsername(username) {
  return db().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ?`).get(username) ?? null;
}

function activeAdmins(connection, exceptId = null) {
  return Number(connection.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND id IS NOT ?").get(exceptId).n);
}

/** A new user; `passwordHash` is already hashed. Throws UserError username_invalid|username_taken. */
export function createUser({
  username, passwordHash, role = "member", displayName = null, isBootstrap = false, isSmoke = false, mustChangePassword = false,
  locale = null, createdBy = null, maxActiveJobs = null, jobsPerHour = null, now = Date.now(),
}) {
  const key = normalizeUsername(username);
  if (!isValidUsername(key)) throw new UserError("username_invalid");
  if (isSmoke && role === "admin") throw new UserError("smoke_user_locked");
  return tx((connection) => {
    if (connection.prepare("SELECT 1 FROM users WHERE username = ?").get(key)) throw new UserError("username_taken");
    const id = randomUUID();
    connection.prepare(`INSERT INTO users
      (id, username, display_name, role, password_hash, must_change_password, is_bootstrap, is_smoke, locale,
       max_active_jobs, jobs_per_hour, password_changed_at, created_at, updated_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, key, displayName || key, role, passwordHash, mustChangePassword ? 1 : 0, isBootstrap ? 1 : 0, isSmoke ? 1 : 0, locale,
        maxActiveJobs, jobsPerHour, now, now, now, createdBy);
    return findUserById(id);
  });
}

export function setUserRole(userId, role, { now = Date.now(), actor = {} } = {}) {
  return tx((connection) => {
    const user = findUserById(userId);
    if (!user) throw new UserError("not_found");
    if (user.is_smoke && role === "admin") throw new UserError("smoke_user_locked");
    if (user.role === role) return user;
    if (user.role === "admin" && user.status === "active" && activeAdmins(connection, userId) === 0) throw new UserError("last_admin");
    connection.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?").run(role, now, userId);
    writeAudit({ code: "user.role_changed", actorKind: actor.kind ?? "user", actorUserId: actor.userId ?? null, targetUserId: userId, targetLabel: user.username, params: { from: user.role, to: role }, now });
    return findUserById(userId);
  });
}

/** Disabling also revokes the user's sessions in the same tx. */
export function setUserStatus(userId, status, { now = Date.now(), actor = {} } = {}) {
  return tx((connection) => {
    const user = findUserById(userId);
    if (!user) throw new UserError("not_found");
    if (user.status === status) return user;
    if (status === "disabled") {
      if (user.role === "admin" && activeAdmins(connection, userId) === 0) throw new UserError("last_admin");
      connection.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, userId);
      revokeUserSessions(userId, "disabled", { now });
    } else {
      connection.prepare("UPDATE users SET status = 'active', disabled_at = NULL, updated_at = ? WHERE id = ?").run(now, userId);
    }
    writeAudit({ code: status === "disabled" ? "user.disabled" : "user.enabled", actorKind: actor.kind ?? "user", actorUserId: actor.userId ?? null, targetUserId: userId, targetLabel: user.username, params: { role: user.role }, now });
    return findUserById(userId);
  });
}

export function deleteUser(userId, { now = Date.now(), actor = {} } = {}) {
  return tx((connection) => {
    const user = findUserById(userId);
    if (!user) throw new UserError("not_found");
    if (user.is_bootstrap) throw new UserError("self_action_forbidden");
    if (user.role === "admin" && user.status === "active" && activeAdmins(connection, userId) === 0) throw new UserError("last_admin");
    writeAudit({ code: "user.deleted", actorKind: actor.kind ?? "user", actorUserId: actor.userId ?? null, targetLabel: user.username, params: { role: user.role }, now });
    connection.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
}

export function setUserPassword(userId, passwordHash, { mustChange = false, now = Date.now() } = {}) {
  db().prepare("UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, mustChange ? 1 : 0, now, now, userId);
}

export function setUserLocale(userId, locale, now = Date.now()) {
  tx((connection) => {
    connection.prepare("UPDATE users SET locale = ?, updated_at = ? WHERE id = ?").run(locale, now, userId);
  });
}

export function markLogin(userId, now = Date.now()) {
  db().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId);
}
