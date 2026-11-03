// A snapshot of the control data (rombak 01 §7.1): VACUUM INTO of the live DB plus a tar of the
// settings tree, kept 14 per reason. It never migrates and works on any schema. It prints paths
// only, never content; deploy/production.sh reads DB_BACKUP= and SETTINGS_BACKUP= from stdout.
// exit 0 ok; 2 DB cannot be opened; 3 integrity_check failed; 4 not enough free space; 64 bad args.
import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, statfsSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { DbUnavailableError, closeDb, openDb } from "../lib/db/index.mjs";

export const BACKUP_REASONS = Object.freeze(["deploy", "daily", "manual", "pre-restore"]);
const DEFAULT_KEEP = Object.freeze({ deploy: 14, daily: 14, manual: 5, "pre-restore": 5 });
const SPARE_BYTES = 64 * 1024 * 1024;

export class BackupError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "BackupError";
    this.exitCode = exitCode;
  }
}

export function timestamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const backupPattern = (prefix, extension, reason) => new RegExp(`^${prefix}-\\d{8}T\\d{6}Z-${reason}\\.${extension}$`);

function fsyncPath(target) {
  const fd = openSync(target, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function sizeOf(file) {
  try { return statSync(file).size; } catch { return 0; }
}

function assertFreeSpace(directory, needed, statfs) {
  const info = statfs(directory);
  const free = BigInt(info.bavail) * BigInt(info.bsize);
  if (free < BigInt(needed)) throw new BackupError(4, "Ruang kosong kurang untuk cadangan");
}

// The newest `keep` of this reason stay; only exact names count, symlinks and other files are not touched.
function applyRetention(directory, reason, keep) {
  for (const [prefix, extension] of [["potongin", "sqlite"], ["settings", "tar"]]) {
    const pattern = backupPattern(prefix, extension, reason);
    const names = readdirSync(directory).filter((name) => pattern.test(name)
      && lstatSync(path.join(directory, name)).isFile()).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keep))) rmSync(path.join(directory, name), { force: true });
  }
}

function snapshotDb(dbFile, directory, name, env) {
  const target = path.join(directory, name);
  const temporary = `${target}.tmp`;
  rmSync(temporary, { force: true });
  let connection;
  try {
    connection = openDb({ path: dbFile, role: "cli", readOnly: true, env });
  } catch (error) {
    throw new BackupError(2, error?.message ?? "Database tidak bisa dibuka");
  }
  try {
    connection.prepare("VACUUM INTO ?").run(temporary);
    const check = new DatabaseSync(temporary, { readOnly: true });
    let verdict;
    try { verdict = check.prepare("PRAGMA integrity_check").get()?.integrity_check; } finally { check.close(); }
    if (verdict !== "ok") throw new BackupError(3, "integrity_check cadangan gagal");
    chmodSync(temporary, 0o600);
    fsyncPath(temporary);
    renameSync(temporary, target);
    fsyncPath(directory);
    return target;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(2, `Cadangan database gagal: ${error?.code ?? "error"}`);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(`${temporary}-wal`, { force: true });
    rmSync(`${temporary}-shm`, { force: true });
    closeDb();
  }
}

function archiveSettings(settingsDir, directory, name) {
  if (!settingsDir || !existsSync(settingsDir)) return null;
  const target = path.join(directory, name);
  const temporary = `${target}.tmp`;
  rmSync(temporary, { force: true });
  closeSync(openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  try {
    execFileSync("tar", ["-cf", temporary, "-C", path.dirname(settingsDir), path.basename(settingsDir)], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    fsyncPath(temporary);
    renameSync(temporary, target);
    return target;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Returns { db, settings }: the paths written (db null when there is no DB yet). */
export function runBackup({ env = process.env, reason = "manual", keep = DEFAULT_KEEP[reason], now = Date.now(), statfs = statfsSync } = {}) {
  if (!BACKUP_REASONS.includes(reason)) throw new BackupError(64, "reason tidak dikenal");
  const dbFile = env.POTONGIN_DB_PATH;
  if (!dbFile) throw new DbUnavailableError("POTONGIN_DB_PATH kosong.");
  const control = path.dirname(dbFile);
  const directory = path.join(control, "backups");
  const stamp = timestamp(now);
  const hasDb = existsSync(dbFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertFreeSpace(directory, 2 * (sizeOf(dbFile) + sizeOf(`${dbFile}-wal`)) + SPARE_BYTES, statfs);
  const written = { db: null, settings: null };
  if (hasDb) written.db = snapshotDb(dbFile, directory, `potongin-${stamp}-${reason}.sqlite`, env);
  written.settings = archiveSettings(env.POTONGIN_SETTINGS_DIR, directory, `settings-${stamp}-${reason}.tar`);
  applyRetention(directory, reason, keep);
  return written;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--reason" && BACKUP_REASONS.includes(value)) { options.reason = value; index += 1; continue; }
    if (name === "--keep" && /^[1-9]\d{0,3}$/.test(value ?? "")) { options.keep = Number(value); index += 1; continue; }
    return null;
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (!options) {
    console.error("Pemakaian: db-backup.mjs [--keep N] [--reason deploy|daily|manual|pre-restore]");
    return 64;
  }
  try {
    const written = runBackup({ env, ...options });
    console.log(`DB_BACKUP=${written.db ?? "none"}`);
    console.log(`SETTINGS_BACKUP=${written.settings ?? "none"}`);
    return 0;
  } catch (error) {
    console.error(error?.message ?? "Cadangan gagal");
    return error instanceof BackupError ? error.exitCode : 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
