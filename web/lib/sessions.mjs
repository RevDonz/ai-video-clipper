// Server-side sessions (rombak 02 §4): a row per session, only sha256(secret) stored, revocable.
// Everything is synchronous, because the guards are (authorize-sync-contract).
//
// A v1 cookie upgrades to exactly one row: its sid and secret are an HMAC of the v1 token, so
// parallel requests of one page get the same s2 cookie and no second row, and a logout that
// revokes the row also ends the v1 token (it stays cryptographically valid until 30 days pass).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { db, tx } from "./db/index.mjs";

export const S2_COOKIE = "__Host-potongin_session";
export const LEGACY_COOKIE = "potongin_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_SESSIONS_PER_USER = 20;
export const REVOKE_REASONS = Object.freeze(["logout", "logout_all", "password_changed", "disabled", "admin_revoked", "limit", "deleted"]);
export const SESSION_VIA = Object.freeze(["password", "break_glass", "upgrade_v1", "invite", "reset"]);

const TOKEN = /^s2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const TOUCH_MS = 60_000;
const NON_ACTIVE_ALLOWED = new Set(["break_glass"]);

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (secret, label, value) => createHmac("sha256", secret).update(`${label}\0${value}`).digest();

const SESSION_SELECT = `SELECT s.id, s.user_id, s.secret_sha256, s.created_at, s.expires_at, s.last_seen_at, s.reauth_at,
    s.revoked_at, s.revoke_reason, s.via, u.username, u.role, u.status, u.must_change_password, u.is_smoke, u.display_name, u.locale
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`;

function deviceLabel(userAgent) {
  return typeof userAgent === "string" && userAgent ? userAgent.slice(0, 120) : null;
}

function enforceLimit(connection, userId, now) {
  const live = connection.prepare(`SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
    ORDER BY last_seen_at ASC, created_at ASC`).all(userId, now);
  const excess = live.length - (MAX_SESSIONS_PER_USER - 1);
  for (let index = 0; index < excess; index += 1) {
    connection.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'limit' WHERE id = ?").run(now, live[index].id);
  }
}

export function createSession(userId, { via, userAgent = null, now = Date.now() } = {}) {
  if (!SESSION_VIA.includes(via)) throw new Error(`Sesi: via tidak dikenal: ${via}`);
  const sid = randomBytes(16).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  tx((connection) => {
    enforceLimit(connection, userId, now);
    connection.prepare(`INSERT INTO sessions (id, user_id, secret_sha256, created_at, expires_at, last_seen_at, device_label, via)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sid, userId, sha256Hex(secret), now, expiresAt, now, deviceLabel(userAgent), via);
  });
  return { token: `s2.${sid}.${secret}`, session: { id: sid, userId, createdAt: now, expiresAt, via } };
}

/** { session, user } for a valid token, else null. Never throws, whatever the input or the DB. */
export function sessionFromToken(token, now = Date.now()) {
  try {
    if (typeof token !== "string") return null;
    const match = TOKEN.exec(token);
    if (!match) return null;
    const row = db().prepare(SESSION_SELECT).get(match[1]);
    if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
    const expected = Buffer.from(row.secret_sha256, "hex");
    const supplied = createHash("sha256").update(match[2]).digest();
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    if (row.status !== "active" && !NON_ACTIVE_ALLOWED.has(row.via)) return null;
    return {
      session: {
        id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at,
        reauthAt: row.reauth_at, via: row.via,
      },
      user: {
        id: row.user_id, username: row.username, displayName: row.display_name, role: row.role, status: row.status,
        mustChangePassword: row.must_change_password === 1, isSmoke: row.is_smoke === 1, locale: row.locale,
      },
    };
  } catch {
    return null;
  }
}

export function revokeSession(sid, reason, { now = Date.now() } = {}) {
  if (!REVOKE_REASONS.includes(reason)) throw new Error(`Sesi: alasan tidak dikenal: ${reason}`);
  return Number(db().prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL").run(now, reason, sid).changes);
}

export function revokeUserSessions(userId, reason, { exceptSid = null, now = Date.now() } = {}) {
  if (!REVOKE_REASONS.includes(reason)) throw new Error(`Sesi: alasan tidak dikenal: ${reason}`);
  return Number(db().prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
    .run(now, reason, userId, exceptSid).changes);
}

export function markReauth(sid, now = Date.now()) {
  db().prepare("UPDATE sessions SET reauth_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, sid);
}

/** Writes last_seen_at at most once a minute per session. */
export function touchSession(sid, now = Date.now(), lastSeenAt = null) {
  if (lastSeenAt !== null && now - lastSeenAt < TOUCH_MS) return;
  db().prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at <= ?").run(now, sid, now - TOUCH_MS);
}

/** `Set-Cookie` of an s2 token. `maxAge` shortens it for a v1 upgrade, which keeps the v1 expiry. */
export function sessionCookie(token, { maxAge = SESSION_TTL_SECONDS } = {}) {
  return `${S2_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearS2Cookie() {
  return `${S2_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function clearLegacyCookie() {
  return `${LEGACY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** Two headers: the s2 cookie and the v1 cookie. */
export function clearSessionCookies() {
  return [clearS2Cookie(), clearLegacyCookie()];
}

/** The sid and secret a v1 token upgrades to. */
function upgradeIdentity(v1Token, sessionSecret) {
  return {
    sid: hmac(sessionSecret, "potongin-s2-upgrade-sid", v1Token).subarray(0, 16).toString("base64url"),
    secret: hmac(sessionSecret, "potongin-s2-upgrade-secret", v1Token).toString("base64url"),
  };
}

/** "none" (never upgraded), "live", or "ended" (its row was revoked or has expired). */
export function v1UpgradeState(v1Token, sessionSecret, now = Date.now()) {
  const { sid } = upgradeIdentity(v1Token, sessionSecret);
  const row = db().prepare("SELECT revoked_at, expires_at FROM sessions WHERE id = ?").get(sid);
  if (!row) return "none";
  return row.revoked_at === null && row.expires_at > now ? "live" : "ended";
}

/**
 * The one s2 session of a verified v1 token: created on the first call, the same on every later
 * call, null once it has been revoked. `expiresAtMs` is the v1 token's own expiry.
 */
export function upgradeV1Session(v1Token, sessionSecret, { userId, expiresAtMs, userAgent = null, now = Date.now() }) {
  const { sid, secret } = upgradeIdentity(v1Token, sessionSecret);
  return tx((connection) => {
    const row = connection.prepare("SELECT revoked_at, expires_at FROM sessions WHERE id = ?").get(sid);
    if (row && (row.revoked_at !== null || row.expires_at <= now)) return null;
    if (!row) {
      enforceLimit(connection, userId, now);
      connection.prepare(`INSERT INTO sessions (id, user_id, secret_sha256, created_at, expires_at, last_seen_at, device_label, via)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'upgrade_v1')`).run(sid, userId, sha256Hex(secret), now, expiresAtMs, now, deviceLabel(userAgent));
    }
    return { token: `s2.${sid}.${secret}`, sid, expiresAt: row?.expires_at ?? expiresAtMs };
  });
}

/** Ends a v1 token on the server: its row is created if needed, then revoked. */
export function revokeV1Token(v1Token, sessionSecret, { userId, expiresAtMs, reason = "logout", now = Date.now() }) {
  const upgraded = upgradeV1Session(v1Token, sessionSecret, { userId, expiresAtMs, now });
  if (upgraded) revokeSession(upgraded.sid, reason, { now });
}
