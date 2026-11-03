// The control database (rombak 01 §2): node:sqlite, synchronous, one connection per process. Next
// bundles this module apart from scripts/start-app.mjs, and the proxy apart from the routes, so
// the connection lives on globalThis: they all share the one that was opened first.
//
// POTONGIN_DB_PATH empty = the process has no DB. Whoever needs it then fails closed
// (DbUnavailableError, 503), except the APP_* login in lib/auth.mjs, which must outlive the DB.
import { chmodSync, closeSync, constants, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_ROLES = Object.freeze(["app", "primary", "social", "cli", "test"]);
// May only go up. A newer schema than a process knows is always accepted (01 §2.4).
export const REQUIRED_SCHEMA_APP = 1;
export const REQUIRED_SCHEMA_PRIMARY = 1;
export const REQUIRED_SCHEMA_SOCIAL = 1;

const HEARTBEAT_ROLES = new Set(["app", "primary", "social"]);
const HEARTBEAT_MS = 10_000;
const BUSY_CODES = new Set([5, 6, 261, 262, 517]);

export class DbUnavailableError extends Error {
  constructor(message = "Database kontrol tidak tersedia") {
    super(message);
    this.name = "DbUnavailableError";
    this.code = "db_unavailable";
  }
}

export class SchemaTooOldError extends Error {
  constructor(found, required) {
    super(`Skema database terlalu lama: ${found} < ${required}`);
    this.name = "SchemaTooOldError";
    this.code = "db_schema_old";
  }
}

export class DbBusyError extends Error {
  constructor() {
    super("Database kontrol sedang sibuk");
    this.name = "DbBusyError";
    this.code = "db_busy";
  }
}

const STATE = Symbol.for("potongin.db.state");
function state() {
  globalThis[STATE] ??= { connection: null, role: null, path: null, depth: 0, heartbeat: null };
  return globalThis[STATE];
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolvedOrSelf(target) {
  try { return realpathSync(target); } catch { return path.resolve(/* turbopackIgnore: true */ target); }
}

function checkLocation(file, env) {
  if (!file || !path.isAbsolute(file)) throw new DbUnavailableError("POTONGIN_DB_PATH harus berupa path absolut.");
  const directory = path.dirname(file);
  let info;
  try { info = statSync(directory); } catch { throw new DbUnavailableError("Folder database belum ada."); }
  if (!info.isDirectory()) throw new DbUnavailableError("Folder database bukan folder.");
  if ((info.mode & 0o077) !== 0) throw new DbUnavailableError("Folder database wajib bermode 0700.");
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new DbUnavailableError("Folder database bukan milik proses ini.");
  }
  const real = resolvedOrSelf(directory);
  const jobs = env.JOBS_ROOT || "/data/jobs";
  if (isInside(real, resolvedOrSelf(jobs))) throw new DbUnavailableError("Database tidak boleh berada di dalam JOBS_ROOT.");
  const settings = env.POTONGIN_SETTINGS_DIR;
  if (settings && isInside(real, resolvedOrSelf(settings))) {
    throw new DbUnavailableError("Database tidak boleh berada di dalam folder pengaturan.");
  }
}

function prepareFile(file, readOnly) {
  let info = null;
  try { info = lstatSync(file); } catch { /* not there yet */ }
  if (info === null) {
    if (readOnly) throw new DbUnavailableError("File database belum ada.");
    closeSync(openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    return;
  }
  if (!info.isFile()) throw new DbUnavailableError("Path database bukan file biasa.");
  if ((info.mode & 0o077) !== 0 && !readOnly) {
    chmodSync(file, 0o600);
    console.warn("[db] mode file database dikoreksi ke 0600");
  }
}

/** The process's one connection; a second call with the same path returns it. */
export function openDb({ path: file = process.env.POTONGIN_DB_PATH, role, readOnly = false, env = process.env } = {}) {
  if (!DB_ROLES.includes(role)) throw new Error(`openDb: role tidak dikenal: ${role}`);
  const current = state();
  if (current.connection) {
    if (current.path === file) return current.connection;
    throw new Error("openDb: proses ini sudah memegang koneksi ke file lain");
  }
  if (!file) throw new DbUnavailableError("POTONGIN_DB_PATH kosong.");
  checkLocation(file, env);
  prepareFile(file, readOnly);
  let connection;
  try {
    connection = new DatabaseSync(file, { readOnly });
    // busy_timeout before journal_mode: two services opening a new file at boot race on the
    // switch to WAL, and without a timeout the loser fails at once.
    connection.exec("PRAGMA busy_timeout=5000");
    if (!readOnly) {
      connection.exec("PRAGMA journal_mode=WAL");
      connection.exec("PRAGMA synchronous=NORMAL");
    }
    connection.exec("PRAGMA foreign_keys=ON");
    connection.exec("PRAGMA trusted_schema=OFF");
    connection.exec("PRAGMA cell_size_check=ON");
  } catch (error) {
    try { connection?.close(); } catch { /* the original error says more */ }
    if (isBusyError(error)) throw new DbBusyError();
    throw new DbUnavailableError(`Database tidak bisa dibuka: ${error?.code ?? "error"}`);
  }
  Object.assign(current, { connection, role, path: file, depth: 0 });
  return connection;
}

/** The connection; opened on first use with POTONGIN_DB_PATH when nobody opened it yet. */
export function db() {
  const current = state();
  if (current.connection) return current.connection;
  if (!process.env.POTONGIN_DB_PATH) throw new DbUnavailableError("POTONGIN_DB_PATH kosong.");
  return openDb({ role: "app" });
}

export function dbRole() {
  return state().role;
}

export function isDbOpen() {
  return state().connection !== null;
}

export function closeDb() {
  const current = state();
  stopHeartbeat();
  try { current.connection?.close(); } catch { /* closing twice is fine */ }
  Object.assign(current, { connection: null, role: null, path: null, depth: 0 });
}

export function isBusyError(error) {
  return BUSY_CODES.has(error?.errcode);
}

/**
 * Runs `fn` in BEGIN IMMEDIATE ... COMMIT; a nested tx is a savepoint. `fn` must be synchronous:
 * no network or file wait ever runs inside a transaction (01 §2.2).
 */
export function tx(fn) {
  const connection = db();
  const current = state();
  const nested = current.depth > 0;
  const name = `tx_${current.depth}`;
  try {
    connection.exec(nested ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusyError(error)) throw new DbBusyError();
    throw error;
  }
  current.depth += 1;
  const undo = () => {
    current.depth -= 1;
    connection.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
  };
  let result;
  try {
    result = fn(connection);
  } catch (error) {
    undo();
    if (isBusyError(error)) throw new DbBusyError();
    throw error;
  }
  if (typeof result?.then === "function") {
    undo();
    Promise.resolve(result).catch(() => {});
    throw new TypeError("tx: fungsi async dilarang");
  }
  current.depth -= 1;
  try {
    connection.exec(nested ? `RELEASE ${name}` : "COMMIT");
  } catch (error) {
    if (isBusyError(error)) throw new DbBusyError();
    throw error;
  }
  return result;
}

/** meta.schema_version, or 0 on a DB without it. */
export function schemaVersion() {
  try {
    const row = db().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch (error) {
    if (/no such table/.test(error?.message ?? "")) return 0;
    throw error;
  }
}

export function requireSchema(min) {
  const found = schemaVersion();
  if (found < min) throw new SchemaTooOldError(found, min);
}

/** The heartbeat of a process holding the DB (01 §2.2 rule 6): every 10 s; the row goes on exit. */
export function startHeartbeat({ intervalMs = HEARTBEAT_MS, env = process.env, now = () => Date.now() } = {}) {
  const current = state();
  if (current.heartbeat || !HEARTBEAT_ROLES.has(current.role)) return;
  const role = current.role;
  const host = os.hostname().slice(0, 64) || "unknown";
  const imageSha = env.POTONGIN_APP_COMMIT ? String(env.POTONGIN_APP_COMMIT).slice(0, 64) : null;
  const startedAt = now();
  const beat = () => {
    try {
      db().prepare(`INSERT INTO process_heartbeats (role, host, pid, image_sha, started_at, beat_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (role, host) DO UPDATE SET pid = excluded.pid, image_sha = excluded.image_sha,
          started_at = excluded.started_at, beat_at = excluded.beat_at`)
        .run(role, host, process.pid, imageSha, startedAt, now());
    } catch (error) {
      console.warn(`[db] detak gagal: ${error?.code ?? "error"}`);
    }
  };
  const remove = () => {
    try { db().prepare("DELETE FROM process_heartbeats WHERE role = ? AND host = ?").run(role, host); } catch { /* exiting */ }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  process.on("exit", remove);
  current.heartbeat = { timer, remove };
}

export function stopHeartbeat() {
  const current = state();
  if (!current.heartbeat) return;
  clearInterval(current.heartbeat.timer);
  process.removeListener("exit", current.heartbeat.remove);
  current.heartbeat.remove();
  current.heartbeat = null;
}
