// Password hashing, policy and the login check (rombak 02 §5, §6.1, §6.6). scrypt is async so it
// never blocks the event loop; at most 4 run at once and 16 wait, beyond that the caller answers
// 429. An unknown username costs the same scrypt as a known one.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { writeAudit } from "./audit.mjs";
import {
  bootstrapOwnerId, findUserById, findUserByUsername, isValidUsername, normalizeUsername, setUserPassword,
} from "./users.mjs";

const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_WAITING = 16;
const MIN_CODE_POINTS = 12;
const MAX_CODE_POINTS = 128;
const MAX_BYTES = 1024;
const STORED = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

export const ENV_PLACEHOLDER_PASSWORD = "change-this-before-starting";
export const BUSY_RETRY_AFTER_SECONDS = 5;

export class PasswordBusyError extends Error {
  constructor() {
    super("rate_limited");
    this.name = "PasswordBusyError";
    this.code = "rate_limited";
    this.retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS;
  }
}

let active = 0;
const waiting = [];

function withSlot(task) {
  if (active >= MAX_ACTIVE && waiting.length >= MAX_WAITING) return Promise.reject(new PasswordBusyError());
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < MAX_ACTIVE) run();
    else waiting.push(run);
  });
}

function deriveKey(plain, salt, { logN, r, p, keyBytes }) {
  return new Promise((resolve, reject) => {
    scrypt(plain, salt, keyBytes, { N: 2 ** logN, r, p, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

const normalized = (plain) => String(plain).normalize("NFC");

export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  return withSlot(async () => {
    const key = await deriveKey(normalized(plain), salt, { logN: LOG_N, r: R, p: P, keyBytes: KEY_BYTES });
    return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
  });
}

function parseStored(stored) {
  const match = typeof stored === "string" ? STORED.exec(stored) : null;
  if (!match) return null;
  const [logN, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // Bounded: a damaged row must not ask for gigabytes of memory.
  if (logN < 10 || logN > 17 || r < 1 || r > 16 || p < 1 || p > 4) return null;
  const salt = Buffer.from(match[4], "base64url");
  const key = Buffer.from(match[5], "base64url");
  if (salt.length < 8 || key.length < 32) return null;
  return { logN, r, p, salt, key };
}

// Compared against for an unknown username: same work, never a match.
export const DUMMY_HASH = `scrypt$${LOG_N}$${R}$${P}$${randomBytes(SALT_BYTES).toString("base64url")}$${randomBytes(KEY_BYTES).toString("base64url")}`;

/** { ok, needsRehash }; a malformed stored value is compared against the dummy and fails. */
export function verifyPassword(plain, stored) {
  const parsed = parseStored(stored);
  const target = parsed ?? parseStored(DUMMY_HASH);
  return withSlot(async () => {
    const key = await deriveKey(normalized(plain), target.salt, { ...target, keyBytes: target.key.length });
    const ok = parsed !== null && timingSafeEqual(key, target.key);
    return { ok, needsRehash: ok && (target.logN < LOG_N || target.r < R || target.p < P || target.key.length < KEY_BYTES) };
  });
}

let commonPasswords = null;

function commonPasswordsFile(env, cwd) {
  const base = env.POTONGIN_RESOURCES_DIR || path.join(cwd, "resources");
  return path.join(/* turbopackIgnore: true */ base, "auth", "common-passwords.txt");
}

function loadCommonPasswords(env, cwd) {
  if (commonPasswords) return commonPasswords;
  // /app/resources in the image, <repo>/resources next to web/ in dev and tests.
  const candidates = [commonPasswordsFile(env, cwd), path.join(/* turbopackIgnore: true */ cwd, "..", "resources", "auth", "common-passwords.txt")];
  for (const file of candidates) {
    try {
      commonPasswords = new Set(readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => line.toLowerCase()));
      return commonPasswords;
    } catch { /* the next candidate */ }
  }
  throw new Error("Daftar sandi umum tidak ditemukan");
}

/** The policy code a new password breaks, or null (02 §5). No composition rules. */
export function checkPasswordPolicy(plain, username, { env = process.env, cwd = process.cwd() } = {}) {
  const value = normalized(plain);
  const codePoints = Array.from(value).length;
  if (codePoints < MIN_CODE_POINTS) return "password_too_short";
  if (codePoints > MAX_CODE_POINTS || Buffer.byteLength(value, "utf8") > MAX_BYTES) return "password_too_long";
  if (typeof username === "string" && value.toLowerCase() === username.normalize("NFC").toLowerCase()) return "password_same_as_username";
  if (loadCommonPasswords(env, cwd).has(value.toLowerCase())) return "password_common";
  return null;
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function breakGlassMatches(username, password, env) {
  if (!env.APP_USERNAME || !env.APP_PASSWORD || !env.APP_SESSION_SECRET || env.APP_SESSION_SECRET.length < 32) return false;
  if (env.APP_PASSWORD === ENV_PLACEHOLDER_PASSWORD) return false;
  const name = equalText(normalizeUsername(username), normalizeUsername(env.APP_USERNAME));
  const secret = equalText(password, env.APP_PASSWORD);
  return name && secret;
}

/**
 * The account behind a login form: { user, via } or null. The DB user first, then break-glass:
 * APP_USERNAME/APP_PASSWORD open a session for the bootstrap owner even when that user is disabled
 * or has changed their password (02 §6.6, default, bisa diubah). Every break-glass use is audited.
 */
export async function verifyLogin(username, password, env = process.env, { now = Date.now() } = {}) {
  const key = normalizeUsername(username);
  const user = isValidUsername(key) ? findUserByUsername(key) : null;
  const verdict = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (user && verdict.ok && user.status === "active") {
    if (verdict.needsRehash) setUserPassword(user.id, await hashPassword(password), { mustChange: user.must_change_password === 1, now });
    return { user, via: "password" };
  }
  if (breakGlassMatches(username, password, env)) {
    const owner = findUserById(bootstrapOwnerId());
    if (owner) {
      writeAudit({ code: "auth.break_glass", actorKind: "user", actorUserId: owner.id, actorLabel: owner.username, now });
      return { user: owner, via: "break_glass" };
    }
  }
  return null;
}
