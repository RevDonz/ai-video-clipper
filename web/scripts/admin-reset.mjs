// Break-glass account commands (rombak 02 §6.6), run inside the app container. Never prints a hash;
// --admin prints a generated password once.
//   --admin <username>         make or restore an admin; new random password, must change at login
//   --ensure-smoke-user        the deploy's read-only user from E2E_SMOKE_*
//   --list                     username, role, status, smoke
//   --purge-legacy-settings    remove the frozen /data/settings (exit 2 no marker, 3 sha differs)
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeAudit } from "../lib/audit.mjs";
import { ensureSmokeUser, legacySettingsDir } from "../lib/db/boot.mjs";
import { REQUIRED_SCHEMA_APP, closeDb, openDb, requireSchema, tx } from "../lib/db/index.mjs";
import { SettingsMoveError, purgeLegacySettings } from "../lib/db/settings-move.mjs";
import { hashPassword } from "../lib/passwords.mjs";
import { revokeUserSessions } from "../lib/sessions.mjs";
import {
  createUser, findUserByUsername, isValidUsername, listUsers, normalizeUsername, setMeta,
} from "../lib/users.mjs";

const USAGE = "Pemakaian: admin-reset.mjs --admin <username> | --ensure-smoke-user | --list | --purge-legacy-settings";

function randomPassword() {
  // 20 characters of base64url: 120 bits, nothing to quote in a shell.
  return randomBytes(15).toString("base64url");
}

async function resetAdmin(username, { now = Date.now(), out = console.log } = {}) {
  const key = normalizeUsername(username);
  if (!isValidUsername(key)) {
    console.error("Nama pengguna tidak sah.");
    return 64;
  }
  const password = randomPassword();
  const passwordHash = await hashPassword(password);
  const created = tx((connection) => {
    const existing = findUserByUsername(key);
    if (existing?.is_smoke) throw new Error("User smoke tidak bisa dijadikan admin.");
    if (existing) {
      connection.prepare(`UPDATE users SET role = 'admin', status = 'active', disabled_at = NULL, password_hash = ?,
        must_change_password = 1, password_changed_at = ?, updated_at = ? WHERE id = ?`).run(passwordHash, now, now, existing.id);
      revokeUserSessions(existing.id, "admin_revoked", { now });
      writeAudit({ code: "user.admin_reset", actorKind: "cli", targetUserId: existing.id, targetLabel: existing.username, params: { created: false }, now });
      return false;
    }
    const user = createUser({ username: key, passwordHash, role: "admin", mustChangePassword: true, now });
    writeAudit({ code: "user.admin_reset", actorKind: "cli", targetUserId: user.id, targetLabel: user.username, params: { created: true }, now });
    return true;
  });
  out(`${created ? "DIBUAT" : "DIRESET"} ${key}`);
  out(`SANDI_SEMENTARA=${password}`);
  return 0;
}

function purgeSettings(env, { now = Date.now() } = {}) {
  try {
    const { removed } = purgeLegacySettings({ from: legacySettingsDir(env), to: env.POTONGIN_SETTINGS_DIR });
    if (removed) {
      tx(() => {
        setMeta("legacy_settings_purged_at", now, now);
        writeAudit({ code: "settings.instance_changed", actorKind: "cli", params: { keys: ["legacy_settings_purged"] }, now });
      });
    }
    console.log(removed ? "PURGED=1" : "PURGED=0");
    return 0;
  } catch (error) {
    if (error instanceof SettingsMoveError) {
      console.error(error.message);
      return error.code === "no_marker" ? 2 : 3;
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const command = argv[0];
  if (!command || !["--admin", "--ensure-smoke-user", "--list", "--purge-legacy-settings"].includes(command)
      || (command === "--admin" && argv.length !== 2) || (command !== "--admin" && argv.length !== 1)) {
    console.error(USAGE);
    return 64;
  }
  openDb({ role: "cli", env });
  try {
    requireSchema(REQUIRED_SCHEMA_APP);
    if (command === "--admin") return await resetAdmin(argv[1]);
    if (command === "--ensure-smoke-user") {
      console.log(`SMOKE=${await ensureSmokeUser(env)}`);
      return 0;
    }
    if (command === "--list") {
      for (const row of listUsers()) console.log(`${row.username}\t${row.role}\t${row.status}\t${row.is_smoke ? "smoke" : "-"}`);
      return 0;
    }
    return purgeSettings(env);
  } finally {
    closeDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error?.message ?? "Gagal");
    process.exitCode = 1;
  }
}
