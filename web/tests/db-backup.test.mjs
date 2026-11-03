// The backup script (rombak 01 §7.1): a consistent snapshot of the live DB, integrity_check, 0600,
// retention per reason, exact names only, and its exit codes. Real script, temp directories.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb, openDb } from "../lib/db/index.mjs";
import { migrate } from "../lib/db/migrate.mjs";
import { BackupError, runBackup, timestamp } from "../scripts/db-backup.mjs";
import { tempControl } from "./support/session.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));

function makeDb(control) {
  closeDb();
  const connection = openDb({ path: control.dbFile, role: "test", env: {} });
  migrate(connection);
  connection.exec("CREATE TABLE IF NOT EXISTS backup_probe (a INTEGER) STRICT");
  connection.exec("INSERT INTO backup_probe VALUES (1)");
  closeDb();
}

function envOf(control) {
  return { PATH: process.env.PATH, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: control.jobsRoot };
}

function seedSettings(control) {
  mkdirSync(control.settingsDir, { mode: 0o700 });
  writeFileSync(path.join(control.settingsDir, "llm-settings.json"), "{}", { mode: 0o600 });
}

const backups = (control) => readdirSync(path.join(control.root, "backups")).sort();

function runCli(control, args = []) {
  return spawnSync(process.execPath, ["scripts/db-backup.mjs", ...args], { cwd: WEB, encoding: "utf8", env: envOf(control) });
}

test("the CLI prints both paths, the files are 0600 and the snapshot passes integrity_check", (t) => {
  const control = tempControl(t);
  makeDb(control);
  seedSettings(control);
  const result = runCli(control, ["--reason", "deploy"]);
  assert.equal(result.status, 0, result.stderr);
  const db = /^DB_BACKUP=(.+)$/m.exec(result.stdout)[1];
  const tar = /^SETTINGS_BACKUP=(.+)$/m.exec(result.stdout)[1];
  assert.match(path.basename(db), /^potongin-\d{8}T\d{6}Z-deploy\.sqlite$/);
  assert.match(path.basename(tar), /^settings-\d{8}T\d{6}Z-deploy\.tar$/);
  assert.equal(statSync(db).mode & 0o777, 0o600);
  assert.equal(statSync(tar).mode & 0o777, 0o600);
  const copy = new DatabaseSync(db, { readOnly: true });
  t.after(() => copy.close());
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM backup_probe").get().n, 1);
  assert.deepEqual(readdirSync(path.dirname(db)).filter((name) => name.includes(".tmp")), []);
  assert.doesNotMatch(result.stdout, /scrypt|llm-settings/, "paths only");
});

test("before the DB exists: DB_BACKUP=none and exit 0", (t) => {
  const control = tempControl(t);
  seedSettings(control);
  const result = runCli(control, ["--reason", "deploy"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^DB_BACKUP=none$/m);
  assert.match(result.stdout, /^SETTINGS_BACKUP=.+settings-.+-deploy\.tar$/m);
  assert.equal(existsSync(control.dbFile), false, "a backup never creates the DB");
});

test("the snapshot is consistent while another connection keeps writing", async (t) => {
  const control = tempControl(t);
  makeDb(control);
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL");
    const insert = db.prepare("INSERT INTO backup_probe VALUES (?)");
    process.stdout.write("ready\\n");
    for (let i = 0; ; i += 1) { db.exec("BEGIN IMMEDIATE"); insert.run(i); insert.run(i); db.exec("COMMIT"); }
  `, control.dbFile], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => writer.kill("SIGKILL"));
  await new Promise((resolve) => { writer.stdout.once("data", resolve); });
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/db-backup.mjs", "--reason", "manual"], { cwd: WEB, env: envOf(control), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => resolve({ status, stdout }));
  });
  assert.equal(result.status, 0);
  const copy = new DatabaseSync(/^DB_BACKUP=(.+)$/m.exec(result.stdout)[1], { readOnly: true });
  t.after(() => copy.close());
  assert.equal(copy.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  // The writer inserts two rows per transaction, so a snapshot holds an odd total only from the seed.
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM backup_probe").get().n % 2, 1, "no half transaction");
});

test("retention is per reason: deploys in a row never push out the daily copies", (t) => {
  const control = tempControl(t);
  makeDb(control);
  seedSettings(control);
  const env = envOf(control);
  const base = Date.UTC(2026, 9, 24, 3, 0, 0);
  for (let i = 0; i < 3; i += 1) runBackup({ env, reason: "daily", now: base + i * 1000 });
  for (let i = 0; i < 20; i += 1) runBackup({ env, reason: "deploy", now: base + 60_000 + i * 1000 });
  const names = backups(control);
  const count = (pattern) => names.filter((name) => pattern.test(name)).length;
  assert.equal(count(/^potongin-.*-daily\.sqlite$/), 3);
  assert.equal(count(/^settings-.*-daily\.tar$/), 3);
  assert.equal(count(/^potongin-.*-deploy\.sqlite$/), 14);
  assert.equal(count(/^settings-.*-deploy\.tar$/), 14);
  assert.ok(names.includes(`potongin-${timestamp(base + 60_000 + 19_000)}-deploy.sqlite`), "the newest stays");
  assert.ok(!names.includes(`potongin-${timestamp(base + 60_000)}-deploy.sqlite`), "the oldest goes");
});

test("manual and pre-restore keep 5 by default, --keep overrides", (t) => {
  const control = tempControl(t);
  makeDb(control);
  const env = envOf(control);
  const base = Date.UTC(2026, 9, 24);
  for (let i = 0; i < 7; i += 1) runBackup({ env, reason: "manual", now: base + i * 1000 });
  for (let i = 0; i < 7; i += 1) runBackup({ env, reason: "pre-restore", now: base + i * 1000 });
  assert.equal(backups(control).filter((name) => /-manual\.sqlite$/.test(name)).length, 5);
  assert.equal(backups(control).filter((name) => /-pre-restore\.sqlite$/.test(name)).length, 5);
  runBackup({ env, reason: "manual", keep: 2, now: base + 100_000 });
  assert.equal(backups(control).filter((name) => /-manual\.sqlite$/.test(name)).length, 2);
});

test("names outside the exact pattern and symlinks are not touched", (t) => {
  const control = tempControl(t);
  makeDb(control);
  const dir = path.join(control.root, "backups");
  mkdirSync(dir, { mode: 0o700 });
  const strangers = ["potongin-old.sqlite", "potongin-20200101T000000Z-other.sqlite", "notes.txt", "settings-20200101T000000Z-deploy.tar.keep"];
  for (const name of strangers) writeFileSync(path.join(dir, name), "x");
  const target = path.join(control.root, "outside.sqlite");
  writeFileSync(target, "x");
  symlinkSync(target, path.join(dir, "potongin-20000101T000000Z-deploy.sqlite"));
  runBackup({ env: envOf(control), reason: "deploy", keep: 1, now: Date.UTC(2026, 9, 24) });
  for (const name of strangers) assert.ok(existsSync(path.join(dir, name)), name);
  assert.ok(existsSync(target));
  assert.ok(readdirSync(dir).includes("potongin-20000101T000000Z-deploy.sqlite"), "a symlink is ignored");
});

test("exit 4 when free space is short, and no snapshot is written", (t) => {
  const control = tempControl(t);
  makeDb(control);
  assert.throws(() => runBackup({ env: envOf(control), reason: "manual", statfs: () => ({ bavail: 1n, bsize: 4096n }) }),
    (error) => error instanceof BackupError && error.exitCode === 4);
  assert.deepEqual(backups(control), []);
});

test("exit 2 when the DB cannot be opened, 64 on bad arguments", (t) => {
  const control = tempControl(t);
  makeDb(control);
  assert.equal(runCli(control, ["--reason", "weekly"]).status, 64);
  assert.equal(runCli(control, ["--keep", "0"]).status, 64);
  assert.equal(runCli(control, ["--out", "/tmp/x"]).status, 64);
  const noPath = spawnSync(process.execPath, ["scripts/db-backup.mjs"], { cwd: WEB, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(noPath.status, 2);
  const broken = tempControl(t);
  writeFileSync(broken.dbFile, "this is not a database", { mode: 0o600 });
  assert.equal(runCli(broken, ["--reason", "manual"]).status, 2);
});

test("the script never migrates and works on any schema", (t) => {
  const control = tempControl(t);
  const raw = new DatabaseSync(control.dbFile);
  raw.exec("CREATE TABLE some_future_table (a INTEGER) STRICT");
  raw.close();
  const result = runCli(control, ["--reason", "manual"]);
  assert.equal(result.status, 0, result.stderr);
  const check = new DatabaseSync(control.dbFile, { readOnly: true });
  t.after(() => check.close());
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0);
});
