// What the app does before its HTTP server starts (rombak 01 §10): check the environment, copy the
// settings, migrate, make the bootstrap admin and the smoke user. scripts/start-app.mjs runs it;
// deploy/production.sh runs its first half before any container is replaced, so a refusal stops
// the deploy while the old image still serves and /control/settings is complete at every rollback.
import { randomUUID } from "node:crypto";
import path from "node:path";

import { writeAudit } from "../audit.mjs";
import { providerKey, readLlmSettings } from "../llm-settings.mjs";
import { hashPassword, verifyPassword } from "../passwords.mjs";
import {
  bootstrapOwnerId, countUsers, createUser, findUserByUsername, getMeta, isValidUsername, normalizeUsername, setMeta, setUserPassword,
} from "../users.mjs";
import { db, openDb, tx } from "./index.mjs";
import { migrate } from "./migrate.mjs";
import { moveSettings, readMarker } from "./settings-move.mjs";

const SETTINGS_SECRET_MIN = 32;
const USERNAME_RULE = "APP_USERNAME harus 3-32 huruf kecil, angka, titik, garis bawah, atau tanda hubung";

export class BootError extends Error {
  constructor(message) {
    super(message);
    this.name = "BootError";
  }
}

/** Where the settings were before /control: next to JOBS_ROOT, as resolveSettingsPaths does. */
export function legacySettingsDir(env = process.env) {
  return path.join(path.dirname(path.resolve(/* turbopackIgnore: true */ env.JOBS_ROOT || "/data/jobs")), "settings");
}

/** 01 §10 step 1. Throws BootError with a message for the log, never with a value. */
export function validateBootEnv(env = process.env) {
  if (!path.isAbsolute(env.POTONGIN_DB_PATH)) throw new BootError("POTONGIN_DB_PATH harus berupa path absolut.");
  if (typeof env.POTONGIN_SETTINGS_SECRET !== "string" || env.POTONGIN_SETTINGS_SECRET.length < SETTINGS_SECRET_MIN) {
    throw new BootError(`POTONGIN_SETTINGS_SECRET wajib, minimal ${SETTINGS_SECRET_MIN} karakter.`);
  }
  if (!isValidUsername(normalizeUsername(env.APP_USERNAME))) throw new BootError(USERNAME_RULE);
}

// 01 §10 step 1's self-check: a secret that differs from the one that sealed the saved LLM keys
// leaves them unreadable. A warning, as the spec says, without a value: the app still runs, on the
// heuristic selector, and Pengaturan asks for the keys again.
async function warnIfSealedKeysUnreadable(env, log) {
  if (env.POTONGIN_SETTINGS_SECRET === env.APP_SESSION_SECRET) return;
  try {
    const { settings } = await readLlmSettings({ env });
    const unreadable = (settings?.providers ?? []).filter((entry) => {
      const key = providerKey(entry, env);
      return key.present && key.value === null;
    });
    if (unreadable.length) log(`[boot] PERINGATAN: ${unreadable.length} key LLM tidak terbuka dengan POTONGIN_SETTINGS_SECRET; isi nilainya sama dengan APP_SESSION_SECRET lama`);
  } catch {
    log("[boot] PERINGATAN: pengaturan AI tidak terbaca saat cek secret");
  }
}

/** 01 §10 steps 1-2: no DB is opened, so it is safe beside the running old image. */
export async function prepareSettings(env = process.env, { log = console.warn } = {}) {
  validateBootEnv(env);
  const moved = moveSettings({ from: legacySettingsDir(env), to: env.POTONGIN_SETTINGS_DIR });
  await warnIfSealedKeysUnreadable(env, log);
  return moved;
}

function recordSettingsMove(env, now) {
  if (getMeta("settings_migrated_at")) return;
  const marker = readMarker(env.POTONGIN_SETTINGS_DIR);
  if (!marker) return;
  tx(() => {
    setMeta("settings_migrated_at", now, now);
    writeAudit({ code: "settings.migrated", params: { files: marker.files ?? 0 }, now });
  });
}

function ensureInstanceMeta(now) {
  const defaults = { instance_id: randomUUID(), created_at: String(now), min_image_schema: "1", fairness_key_version: "1" };
  tx(() => {
    for (const [key, value] of Object.entries(defaults)) if (getMeta(key) === null) setMeta(key, value, now);
  });
}

async function ensureBootstrapAdmin(env, now) {
  if (countUsers() > 0) return null;
  const passwordHash = await hashPassword(env.APP_PASSWORD);
  return tx(() => {
    if (countUsers() > 0) return null;
    const user = createUser({ username: env.APP_USERNAME, passwordHash, role: "admin", isBootstrap: true, now });
    setMeta("bootstrap_owner_id", user.id, now);
    writeAudit({ code: "bootstrap.admin_created", actorKind: "system", targetUserId: user.id, targetLabel: user.username, now });
    return user.id;
  });
}

/**
 * The read-only deploy user (02 §6.6): a member with the env's password who cannot start a job.
 * Returns "created", "updated", "unchanged" or "skipped". A refusal is logged and does not stop
 * the app: the post-deploy check then fails on its own and the deploy rolls back.
 */
export async function ensureSmokeUser(env = process.env, { now = Date.now(), log = console.warn } = {}) {
  const username = normalizeUsername(env.E2E_SMOKE_USERNAME);
  const password = env.E2E_SMOKE_PASSWORD;
  if (!username || !password) return "skipped";
  if (!isValidUsername(username)) {
    log("[boot] E2E_SMOKE_USERNAME tidak sah; user smoke dilewati");
    return "skipped";
  }
  const existing = findUserByUsername(username);
  if (existing && !existing.is_smoke) {
    log("[boot] E2E_SMOKE_USERNAME dipakai user lain; user smoke dilewati");
    return "skipped";
  }
  const passwordMatches = existing ? (await verifyPassword(password, existing.password_hash)).ok : false;
  if (existing && passwordMatches && existing.status === "active" && existing.max_active_jobs === 0 && existing.jobs_per_hour === 0
      && existing.must_change_password === 0 && existing.role === "member" && getMeta("smoke_user_id") === existing.id) {
    return "unchanged";
  }
  const passwordHash = passwordMatches ? existing.password_hash : await hashPassword(password);
  return tx((connection) => {
    let id = existing?.id;
    const outcome = existing ? "updated" : "created";
    const other = getMeta("smoke_user_id");
    if (existing) {
      connection.prepare(`UPDATE users SET role = 'member', status = 'active', disabled_at = NULL, must_change_password = 0,
        max_active_jobs = 0, jobs_per_hour = 0, password_hash = ?, updated_at = ? WHERE id = ?`).run(passwordHash, now, id);
    } else {
      // One smoke user: after a new E2E_SMOKE_USERNAME the old row is disabled, which ends its sessions.
      if (other) connection.prepare("UPDATE users SET is_smoke = 0, status = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, other);
      id = createUser({ username, passwordHash, role: "member", isSmoke: true, maxActiveJobs: 0, jobsPerHour: 0, now }).id;
    }
    setMeta("smoke_user_id", id, now);
    writeAudit({ code: "smoke.ensured", actorKind: "system", targetUserId: id, targetLabel: username, now });
    return outcome;
  });
}

/**
 * 01 §10 steps 1-5. Returns { mode: "identity" | "single-user" }. POTONGIN_DB_PATH empty (the
 * player and parity apps of CI, a new image started with the old compose) runs the v1 login alone;
 * compose always sets it (tests/deploy-env-contract.test.mjs).
 */
export async function bootApp({ env = process.env, now = Date.now(), log = console.warn } = {}) {
  if (!env.POTONGIN_DB_PATH) {
    log("[boot] POTONGIN_DB_PATH kosong: jalan tanpa database pengguna, hanya login APP_*");
    return { mode: "single-user" };
  }
  await prepareSettings(env, { log });
  openDb({ path: env.POTONGIN_DB_PATH, role: "app", env });
  migrate(db());
  recordSettingsMove(env, now);
  ensureInstanceMeta(now);
  await ensureBootstrapAdmin(env, now);
  if (!bootstrapOwnerId()) throw new BootError("users tidak kosong tetapi bootstrap_owner_id tidak ada.");
  await ensureSmokeUser(env, { now, log });
  return { mode: "identity" };
}
