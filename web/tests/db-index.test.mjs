// The DB module's rules (rombak 01 §2.2): where a DB may live, its modes, sync-only transactions,
// savepoints, the schema floor, and the fail-closed error when no DB is configured.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DB_ROLES, DbBusyError, DbUnavailableError, REQUIRED_SCHEMA_PRIMARY, REQUIRED_SCHEMA_SOCIAL, SchemaTooOldError, closeDb, db, dbRole, openDb,
  requireSchema, schemaVersion, startHeartbeat, stopHeartbeat, tx,
} from "../lib/db/index.mjs";
import { DatabaseSync } from "node:sqlite";
import { migratedDb, tempControl } from "./support/session.mjs";

function open(t, control, extra = {}) {
  closeDb();
  t.after(closeDb);
  return openDb({ path: control.dbFile, role: "test", env: { JOBS_ROOT: control.jobsRoot }, ...extra });
}

test("every connection gets the pragmas of 01 §2.2", (t) => {
  const connection = open(t, tempControl(t));
  const pragma = (name) => Object.values(connection.prepare(`PRAGMA ${name}`).get())[0];
  assert.equal(pragma("journal_mode"), "wal");
  assert.equal(pragma("synchronous"), 1);
  assert.equal(pragma("busy_timeout"), 5000);
  assert.equal(pragma("foreign_keys"), 1);
  assert.equal(pragma("trusted_schema"), 0);
  assert.equal(pragma("cell_size_check"), 1);
});

test("a new DB file is 0600, an existing looser one is corrected", (t) => {
  const control = tempControl(t);
  open(t, control);
  assert.equal(statSync(control.dbFile).mode & 0o777, 0o600);
  closeDb();
  chmodSync(control.dbFile, 0o644);
  t.mock.method(console, "warn", () => {});
  open(t, control);
  assert.equal(statSync(control.dbFile).mode & 0o777, 0o600);
});

test("a relative path, or a parent that is not 0700, is refused", (t) => {
  const control = tempControl(t);
  closeDb();
  assert.throws(() => openDb({ path: "relative.sqlite", role: "test", env: {} }), DbUnavailableError);
  const loose = path.join(control.root, "loose");
  mkdirSync(loose, { mode: 0o755 });
  chmodSync(loose, 0o755);
  assert.throws(() => openDb({ path: path.join(loose, "x.sqlite"), role: "test", env: {} }), /0700/);
  assert.throws(() => openDb({ path: path.join(control.root, "nope", "x.sqlite"), role: "test", env: {} }), DbUnavailableError);
});

test("a path inside JOBS_ROOT or the settings folder is refused, through a symlink too", (t) => {
  const control = tempControl(t);
  closeDb();
  const jobs = path.join(control.root, "jobs");
  const settings = path.join(control.root, "settings");
  mkdirSync(jobs, { mode: 0o700 });
  mkdirSync(settings, { mode: 0o700 });
  const env = { JOBS_ROOT: jobs, POTONGIN_SETTINGS_DIR: settings };
  assert.throws(() => openDb({ path: path.join(jobs, "x.sqlite"), role: "test", env }), /JOBS_ROOT/);
  assert.throws(() => openDb({ path: path.join(settings, "x.sqlite"), role: "test", env }), /pengaturan/);
  const alias = path.join(control.root, "alias");
  symlinkSync(jobs, alias);
  assert.throws(() => openDb({ path: path.join(alias, "x.sqlite"), role: "test", env }), /JOBS_ROOT/);
  assert.equal(db.length, 0);
});

test("a role outside the list is refused; the role is kept in memory", (t) => {
  const control = tempControl(t);
  closeDb();
  assert.throws(() => openDb({ path: control.dbFile, role: "render", env: {} }), /role tidak dikenal/);
  assert.deepEqual([...DB_ROLES], ["app", "primary", "social", "cli", "test"]);
  open(t, control);
  assert.equal(dbRole(), "test");
});

test("one connection per process: the same path returns it, another path throws", (t) => {
  const control = tempControl(t);
  const connection = open(t, control);
  assert.equal(openDb({ path: control.dbFile, role: "test" }), connection);
  assert.equal(db(), connection);
  assert.throws(() => openDb({ path: path.join(control.root, "other.sqlite"), role: "test" }), /file lain/);
});

test("no POTONGIN_DB_PATH: db() fails closed and nothing is created", (t) => {
  closeDb();
  const saved = process.env.POTONGIN_DB_PATH;
  delete process.env.POTONGIN_DB_PATH;
  t.after(() => { if (saved !== undefined) process.env.POTONGIN_DB_PATH = saved; });
  assert.throws(() => db(), (error) => error instanceof DbUnavailableError && error.code === "db_unavailable");
  assert.throws(() => openDb({ role: "app" }), DbUnavailableError);
});

test("readOnly does not create a missing file and refuses writes", (t) => {
  const control = tempControl(t);
  closeDb();
  t.after(closeDb);
  assert.throws(() => openDb({ path: control.dbFile, role: "cli", readOnly: true, env: {} }), /belum ada/);
  writeFileSync(control.dbFile, "", { mode: 0o600 });
  const writer = new DatabaseSync(control.dbFile);
  writer.exec("CREATE TABLE a (b INTEGER) STRICT");
  writer.close();
  const reader = openDb({ path: control.dbFile, role: "cli", readOnly: true, env: {} });
  assert.throws(() => reader.exec("INSERT INTO a VALUES (1)"), /readonly/);
});

test("tx commits, rolls back on a throw, and returns the value", (t) => {
  const connection = open(t, tempControl(t));
  connection.exec("CREATE TABLE a (b INTEGER) STRICT");
  assert.equal(tx((c) => { c.exec("INSERT INTO a VALUES (1)"); return 7; }), 7);
  assert.throws(() => tx((c) => { c.exec("INSERT INTO a VALUES (2)"); throw new Error("no"); }), /no/);
  assert.deepEqual(connection.prepare("SELECT b FROM a").all().map((row) => row.b), [1]);
});

test("tx refuses an async function and rolls it back", async (t) => {
  const connection = open(t, tempControl(t));
  connection.exec("CREATE TABLE a (b INTEGER) STRICT");
  assert.throws(() => tx(async (c) => { c.exec("INSERT INTO a VALUES (1)"); }), (error) => error instanceof TypeError && /async dilarang/.test(error.message));
  assert.throws(() => tx(() => ({ then() {} })), TypeError);
  assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM a").get().n, 0);
  assert.equal(tx(() => 1), 1, "the connection is not stuck in a transaction");
});

test("a nested tx is a savepoint: its throw undoes only itself", (t) => {
  const connection = open(t, tempControl(t));
  connection.exec("CREATE TABLE a (b INTEGER) STRICT");
  tx((c) => {
    c.exec("INSERT INTO a VALUES (1)");
    assert.throws(() => tx((inner) => { inner.exec("INSERT INTO a VALUES (2)"); throw new Error("inner"); }), /inner/);
    tx((inner) => inner.exec("INSERT INTO a VALUES (3)"));
  });
  assert.deepEqual(connection.prepare("SELECT b FROM a ORDER BY b").all().map((row) => row.b), [1, 3]);
});

test("SQLITE_BUSY becomes DbBusyError with code db_busy", (t) => {
  const control = tempControl(t);
  const connection = open(t, control);
  connection.exec("PRAGMA busy_timeout=0");
  connection.exec("CREATE TABLE a (b INTEGER) STRICT");
  const holder = new DatabaseSync(control.dbFile);
  holder.exec("BEGIN IMMEDIATE");
  t.after(() => holder.close());
  assert.throws(() => tx(() => {}), (error) => error instanceof DbBusyError && error.code === "db_busy");
  holder.exec("ROLLBACK");
});

test("requireSchema: older throws, equal or newer passes", (t) => {
  const { connection } = migratedDb(t);
  assert.equal(schemaVersion(), 1);
  requireSchema(1);
  assert.throws(() => requireSchema(2), (error) => error instanceof SchemaTooOldError && error.code === "db_schema_old");
  assert.equal(REQUIRED_SCHEMA_PRIMARY, 1);
  assert.equal(REQUIRED_SCHEMA_SOCIAL, 1);
  connection.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  requireSchema(1);
});

test("schemaVersion of an empty DB is 0", (t) => {
  open(t, tempControl(t));
  assert.equal(schemaVersion(), 0);
  assert.throws(() => requireSchema(1), SchemaTooOldError);
});

test("the heartbeat writes a row for app, primary and social, and removes it on stop", (t) => {
  const { dbFile, connection } = migratedDb(t);
  const rows = () => connection.prepare("SELECT role, pid FROM process_heartbeats").all();
  startHeartbeat({ now: () => 1000 });
  assert.deepEqual(rows(), [], "role test has no heartbeat");
  stopHeartbeat();
  closeDb();
  const app = openDb({ path: dbFile, role: "app" });
  startHeartbeat({ now: () => 1000 });
  assert.deepEqual(app.prepare("SELECT role, pid, beat_at FROM process_heartbeats").all().map((row) => ({ ...row })), [{ role: "app", pid: process.pid, beat_at: 1000 }]);
  stopHeartbeat();
  assert.equal(app.prepare("SELECT COUNT(*) AS n FROM process_heartbeats").get().n, 0);
});
