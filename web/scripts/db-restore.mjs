// Offline restore of the control data (rombak 01 §7.3); the runbook stops app and primary-worker
// first, and this script refuses when the DB still looks in use.
//   node scripts/db-restore.mjs --from <backup.sqlite> [--settings <settings.tar>] --yes
// exit 0 ok; 3 the source failed its check; 5 the DB is in use; 6 the source is newer than this
// image allows; 64 bad arguments. Nothing is written before every check has passed.
import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { knownSchemaVersion } from "../lib/db/migrate.mjs";
import { runBackup, timestamp } from "./db-backup.mjs";

const HEARTBEAT_WINDOW_MS = 30_000;
const TAR_ENV = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" });

class RestoreError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

function checkSource(from, migrationsDir) {
  let source;
  try {
    source = new DatabaseSync(from, { readOnly: true });
    const verdict = source.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (verdict !== "ok") throw new RestoreError(3, "integrity_check sumber gagal");
    const row = source.prepare("SELECT value FROM meta WHERE key = 'min_image_schema'").get();
    const required = row ? Number(row.value) : 0;
    if (required > knownSchemaVersion(migrationsDir)) throw new RestoreError(6, "Cadangan butuh image yang lebih baru");
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(3, "Sumber bukan database yang bisa dibaca");
  } finally {
    try { source?.close(); } catch { /* it never opened */ }
  }
}

// Heartbeats newer than 30 s, or a checkpoint that a reader or writer blocks, mean a live process.
function checkOffline(dbFile, now) {
  if (!existsSync(dbFile)) return;
  let current;
  try {
    current = new DatabaseSync(dbFile);
    current.exec("PRAGMA busy_timeout=0");
    let beating = [];
    try {
      beating = current.prepare("SELECT role FROM process_heartbeats WHERE beat_at > ?").all(now - HEARTBEAT_WINDOW_MS);
    } catch (error) {
      if (!/no such table/.test(error?.message ?? "")) throw error;
    }
    if (beating.length) throw new RestoreError(5, `DB masih dipakai: ${beating.map((row) => row.role).join(", ")}`);
    const checkpoint = current.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new RestoreError(5, "DB masih dipakai: checkpoint terhalang");
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(5, `DB masih dipakai: ${error?.code ?? "error"}`);
  } finally {
    try { current?.close(); } catch { /* it never opened */ }
  }
}

// Only regular members and directories, relative and under settings/. `tar -tv` lists the type
// first; a symlink or hard link is refused before anything is extracted.
function checkSettingsTar(tarFile) {
  let listing;
  try {
    listing = execFileSync("tar", ["-tvf", tarFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: TAR_ENV() });
    const names = execFileSync("tar", ["-tf", tarFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: TAR_ENV() });
    for (const name of names.split("\n").filter(Boolean)) {
      if (path.isAbsolute(name) || name.split("/").includes("..") || (name !== "settings/" && !name.startsWith("settings/"))) {
        throw new RestoreError(3, "Arsip pengaturan memuat path terlarang");
      }
    }
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    throw new RestoreError(3, "Arsip pengaturan tidak terbaca");
  }
  for (const line of listing.split("\n").filter(Boolean)) {
    if (!["-", "d"].includes(line[0])) throw new RestoreError(3, "Arsip pengaturan memuat link");
  }
}

function fsyncFile(file) {
  const fd = openSync(file, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function restoreSettings(tarFile, settingsDir, now) {
  const scratch = `${settingsDir}.restore-tmp`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { mode: 0o700 });
  execFileSync("tar", ["-xf", tarFile, "-C", scratch, "--strip-components=1", "--no-same-owner"], { stdio: ["ignore", "ignore", "pipe"], env: TAR_ENV() });
  if (existsSync(settingsDir)) renameSync(settingsDir, `${settingsDir}.pre-restore-${timestamp(now)}`);
  renameSync(scratch, settingsDir);
}

/** Returns the restored schema version. Throws RestoreError with the script's exit code. */
export function runRestore({ from, settings = null, env = process.env, now = Date.now(), migrationsDir } = {}) {
  const dbFile = env.POTONGIN_DB_PATH;
  if (!dbFile || !path.isAbsolute(dbFile)) throw new RestoreError(64, "POTONGIN_DB_PATH kosong");
  if (!from || !existsSync(from)) throw new RestoreError(64, "--from tidak ada");
  checkSource(from, migrationsDir);
  if (settings) {
    if (!existsSync(settings)) throw new RestoreError(64, "--settings tidak ada");
    checkSettingsTar(settings);
  }
  checkOffline(dbFile, now);

  const temporary = `${dbFile}.restore-tmp`;
  rmSync(temporary, { force: true });
  copyFileSync(from, temporary);
  chmodSync(temporary, 0o600);
  fsyncFile(temporary);
  if (existsSync(dbFile)) runBackup({ env, reason: "pre-restore", now });
  rmSync(`${dbFile}-wal`, { force: true });
  rmSync(`${dbFile}-shm`, { force: true });
  renameSync(temporary, dbFile);
  fsyncFile(path.dirname(dbFile));

  const restored = new DatabaseSync(dbFile);
  let schema = 0;
  try {
    if (restored.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new RestoreError(3, "quick_check gagal setelah restore");
    schema = Number(restored.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0);
  } finally {
    restored.close();
  }
  if (settings) restoreSettings(settings, env.POTONGIN_SETTINGS_DIR, now);
  return schema;
}

function parseArgs(argv) {
  const options = { yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--yes") { options.yes = true; continue; }
    if ((name === "--from" || name === "--settings") && argv[index + 1]) {
      options[name.slice(2)] = argv[index + 1];
      index += 1;
      continue;
    }
    return null;
  }
  return options.yes && options.from ? options : null;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (!options) {
    console.error("Pemakaian: db-restore.mjs --from <cadangan.sqlite> [--settings <settings.tar>] --yes");
    return 64;
  }
  try {
    const schema = runRestore({ from: options.from, settings: options.settings ?? null, env });
    console.log(`RESTORED=${env.POTONGIN_DB_PATH} SCHEMA=${schema}`);
    return 0;
  } catch (error) {
    console.error(error?.message ?? "Restore gagal");
    return Number.isInteger(error?.exitCode) ? error.exitCode : 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
