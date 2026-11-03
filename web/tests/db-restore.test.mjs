// Restore (rombak 01 §7.3): refused while the DB is in use or the source is unsound, a pre-restore
// copy before anything is replaced, a settings tar without links or parent paths. Real script.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb, openDb } from "../lib/db/index.mjs";
import { migrate } from "../lib/db/migrate.mjs";
import { tempControl } from "./support/session.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));

function envOf(control) {
  return { PATH: process.env.PATH, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: control.jobsRoot };
}

function run(control, args) {
  return spawnSync(process.execPath, ["scripts/db-restore.mjs", ...args], { cwd: WEB, encoding: "utf8", env: envOf(control) });
}

function makeDb(file, marker) {
  closeDb();
  const connection = openDb({ path: file, role: "test", env: {} });
  migrate(connection);
  connection.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('probe', ?, 0)").run(marker);
  closeDb();
}

function probe(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM meta WHERE key = 'probe'").get()?.value; } finally { db.close(); }
}

function setup(t) {
  const control = tempControl(t);
  t.after(closeDb);
  makeDb(control.dbFile, "current");
  const backups = path.join(control.root, "backups");
  mkdirSync(backups, { mode: 0o700 });
  const from = path.join(backups, "potongin-20261024T031500Z-manual.sqlite");
  makeDb(from, "restored");
  // The backup is a plain file, as VACUUM INTO writes it.
  for (const suffix of ["-wal", "-shm"]) try { execFileSync("rm", ["-f", `${from}${suffix}`]); } catch { /* not there */ }
  return { control, from, backups };
}

test("restore replaces the DB, keeps a pre-restore copy first, and prints the schema", (t) => {
  const { control, from, backups } = setup(t);
  const result = run(control, ["--from", from, "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^RESTORED=${control.dbFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} SCHEMA=1$`, "m"));
  assert.equal(probe(control.dbFile), "restored");
  assert.equal(statSync(control.dbFile).mode & 0o777, 0o600);
  const preRestore = readdirSync(backups).filter((name) => /^potongin-.*-pre-restore\.sqlite$/.test(name));
  assert.equal(preRestore.length, 1);
  assert.equal(probe(path.join(backups, preRestore[0])), "current", "the DB as it was before");
  assert.equal(existsSync(`${control.dbFile}.restore-tmp`), false);
});

test("--yes and --from are required", (t) => {
  const { control, from } = setup(t);
  assert.equal(run(control, ["--from", from]).status, 64);
  assert.equal(run(control, ["--yes"]).status, 64);
  assert.equal(run(control, ["--from", "/no/such/file", "--yes"]).status, 64);
  assert.equal(probe(control.dbFile), "current");
});

test("exit 5 with a heartbeat newer than 30 s; an old one does not block", (t) => {
  const { control, from } = setup(t);
  const db = new DatabaseSync(control.dbFile);
  t.after(() => db.close());
  const insert = (at) => db.prepare(`INSERT INTO process_heartbeats (role, host, pid, started_at, beat_at) VALUES ('app', 'h', 1, 0, ?)
    ON CONFLICT (role, host) DO UPDATE SET beat_at = excluded.beat_at`).run(at);
  insert(Date.now());
  const refused = run(control, ["--from", from, "--yes"]);
  assert.equal(refused.status, 5);
  assert.match(refused.stderr, /masih dipakai/);
  assert.equal(probe(control.dbFile), "current");
  insert(Date.now() - 31_000);
  assert.equal(run(control, ["--from", from, "--yes"]).status, 0);
});

test("exit 5 while a reader holds the WAL open", (t) => {
  const { control, from, backups } = setup(t);
  const writer = new DatabaseSync(control.dbFile);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('w', '1', 0)").run();
  const reader = new DatabaseSync(control.dbFile);
  t.after(() => reader.close());
  reader.exec("BEGIN");
  reader.prepare("SELECT COUNT(*) AS n FROM meta").get();
  writer.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('w2', '1', 0)").run();
  const result = run(control, ["--from", from, "--yes"]);
  assert.equal(result.status, 5, result.stderr);
  assert.deepEqual(readdirSync(backups).filter((name) => name.includes("pre-restore")), [], "nothing written");
  reader.exec("COMMIT");
});

test("exit 3 when the source is not a sound database, and the DB is untouched", (t) => {
  const { control, backups } = setup(t);
  const bad = path.join(backups, "potongin-20261024T031500Z-manual.sqlite");
  writeFileSync(bad, "garbage that is no sqlite file at all, long enough to fail the header check of the format");
  assert.equal(run(control, ["--from", bad, "--yes"]).status, 3);
  assert.equal(probe(control.dbFile), "current");
});

test("exit 6 when the backup needs a newer image", (t) => {
  const { control, from } = setup(t);
  const db = new DatabaseSync(from);
  db.prepare("INSERT INTO meta (key, value, updated_at) VALUES ('min_image_schema', '999', 0)").run();
  db.close();
  assert.equal(run(control, ["--from", from, "--yes"]).status, 6);
  assert.equal(probe(control.dbFile), "current");
});

function makeTar(control, name, build) {
  const dir = path.join(control.root, `tar-${name}`);
  mkdirSync(path.join(dir, "settings"), { recursive: true, mode: 0o700 });
  build(dir);
  const file = path.join(control.root, `${name}.tar`);
  return { dir, file };
}

test("--settings puts the tree back and keeps the old one aside", (t) => {
  const { control, from } = setup(t);
  mkdirSync(control.settingsDir, { mode: 0o700 });
  writeFileSync(path.join(control.settingsDir, "old.json"), "old");
  const { dir, file } = makeTar(control, "ok", (root) => writeFileSync(path.join(root, "settings", "llm-settings.json"), "new"));
  execFileSync("tar", ["-cf", file, "-C", dir, "settings"]);
  const result = run(control, ["--from", from, "--settings", file, "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(control.settingsDir, "llm-settings.json"), "utf8"), "new");
  assert.equal(existsSync(path.join(control.settingsDir, "old.json")), false);
  const aside = readdirSync(control.root).find((name) => name.startsWith("settings.pre-restore-"));
  assert.equal(readFileSync(path.join(control.root, aside, "old.json"), "utf8"), "old");
});

test("a tar with a symlink, a hard link, a parent path or a stray member is refused before anything changes", (t) => {
  const { control, from, backups } = setup(t);
  mkdirSync(control.settingsDir, { mode: 0o700 });
  const cases = {
    symlink: (dir, file) => {
      symlinkSync("/etc/passwd", path.join(dir, "settings", "evil"));
      execFileSync("tar", ["-cf", file, "-C", dir, "settings"]);
    },
    hardlink: (dir, file) => {
      writeFileSync(path.join(dir, "settings", "a"), "x");
      execFileSync("ln", [path.join(dir, "settings", "a"), path.join(dir, "settings", "b")]);
      execFileSync("tar", ["-cf", file, "-C", dir, "settings"]);
    },
    parent: (dir, file) => {
      writeFileSync(path.join(dir, "settings", "a"), "x");
      execFileSync("tar", ["-cf", file, "-P", "-C", dir, "settings/../settings/a"]);
    },
    stray: (dir, file) => {
      writeFileSync(path.join(dir, "other"), "x");
      execFileSync("tar", ["-cf", file, "-C", dir, "other"]);
    },
  };
  for (const [name, build] of Object.entries(cases)) {
    const { dir, file } = makeTar(control, name, () => {});
    build(dir, file);
    const result = run(control, ["--from", from, "--settings", file, "--yes"]);
    assert.equal(result.status, 3, `${name}: ${result.stderr}`);
    assert.equal(probe(control.dbFile), "current", name);
    assert.deepEqual(readdirSync(backups).filter((entry) => entry.includes("pre-restore")), [], name);
  }
});

test("a restored older backup migrates forward on the next boot, a restore needs no DB to exist", (t) => {
  const { control, from } = setup(t);
  for (const suffix of ["", "-wal", "-shm"]) try { execFileSync("rm", ["-f", `${control.dbFile}${suffix}`]); } catch { /* not there */ }
  const result = run(control, ["--from", from, "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(probe(control.dbFile), "restored");
  const connection = openDb({ path: control.dbFile, role: "test", env: {} });
  assert.deepEqual(migrate(connection), []);
});
