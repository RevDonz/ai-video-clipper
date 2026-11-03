// Migrations are additive and idempotent, and old code accepts a newer schema (rombak 01 §3.2-§3.3).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { closeDb, openDb, requireSchema, schemaVersion } from "../lib/db/index.mjs";
import {
  MigrationLintError, MigrationOrderError, MigrationTamperedError, SCHEMA_MIGRATIONS_DDL, defaultMigrationsDir, knownSchemaVersion,
  lintMigrationSql, migrate, pendingMigrations,
} from "../lib/db/migrate.mjs";
import { migratedDb, tempControl } from "./support/session.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = path.join(WEB, "lib/db/migrations");

function tempDir(t, files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "potongin-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

const META = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;\n";

function freshDb(t, role = "test") {
  const control = tempControl(t);
  closeDb();
  t.after(closeDb);
  return openDb({ path: control.dbFile, role, env: { JOBS_ROOT: path.join(control.root, "jobs") } });
}

test("the migration files are numbered 1..N without gaps and pass their own lint", () => {
  const names = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes("0001-identity.sql"));
  names.forEach((name, index) => {
    assert.match(name, /^\d{4}-[a-z0-9-]+\.sql$/);
    assert.equal(Number(name.slice(0, 4)), index + 1);
    lintMigrationSql(readFileSync(path.join(MIGRATIONS, name), "utf8"), name);
  });
  assert.equal(knownSchemaVersion(MIGRATIONS), names.length);
  assert.equal(defaultMigrationsDir(WEB), MIGRATIONS);
});

test("a gap or a duplicate number stops migrate", (t) => {
  const connection = freshDb(t);
  const gap = tempDir(t, { "0001-a.sql": META, "0003-c.sql": "CREATE TABLE c (a INTEGER) STRICT;" });
  assert.throws(() => migrate(connection, gap), MigrationOrderError);
  const duplicate = tempDir(t, { "0001-a.sql": META, "0001-b.sql": "CREATE TABLE b (a INTEGER) STRICT;" });
  assert.throws(() => migrate(connection, duplicate), MigrationOrderError);
});

const REFUSED = [
  ["DROP TABLE users;", /DROP/],
  ["ALTER TABLE users DROP COLUMN locale;", /DROP/],
  ["ALTER TABLE users RENAME TO people;", /RENAME/],
  ["ALTER TABLE users RENAME COLUMN locale TO lang;", /RENAME/],
  ["DELETE FROM users;", /DELETE/],
  ["REPLACE INTO meta (key) VALUES ('a');", /REPLACE/],
  ["INSERT OR REPLACE INTO meta (key) VALUES ('a');", /REPLACE/],
  ["INSERT INTO meta (key) VALUES ('a');", /OR IGNORE/],
  ["PRAGMA foreign_keys=OFF;", /PRAGMA/],
  ["ATTACH DATABASE 'x' AS y;", /ATTACH/],
  ["DETACH DATABASE y;", /DETACH/],
  ["VACUUM;", /VACUUM/],
  ["CREATE TABLE IF NOT EXISTS a (b INTEGER) STRICT;", /IF NOT EXISTS/],
  ["CREATE TABLE a (b INTEGER);", /STRICT/],
  ["CREATE UNIQUE INDEX a ON users(locale);", /tabel baru/],
  ["ALTER TABLE users ADD COLUMN a TEXT NOT NULL;", /DEFAULT/],
  ["UPDATE users SET locale = 'id';", /UPDATE/],
  ["BEGIN;", /transaksi/],
  ["COMMIT;", /transaksi/],
  ["END;", /transaksi/],
  ["ROLLBACK;", /transaksi/],
  ["SAVEPOINT a;", /transaksi/],
  ["RELEASE a;", /transaksi/],
];

for (const [sql, reason] of REFUSED) {
  test(`lint refuses: ${sql}`, () => {
    assert.throws(() => lintMigrationSql(sql), (error) => error instanceof MigrationLintError && reason.test(error.message));
  });
}

test("lint names the file and the line", () => {
  assert.throws(() => lintMigrationSql("CREATE TABLE a (b INTEGER) STRICT;\n\nDROP TABLE a;", "0009-x.sql"), /0009-x\.sql baris 3/);
});

test("lint allows the additive forms, and skips comments and strings", () => {
  lintMigrationSql(`
    -- DROP TABLE users; in a comment
    /* VACUUM; PRAGMA x; */
    CREATE TABLE a (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'DROP TABLE a; PRAGMA x') STRICT, WITHOUT ROWID;
    CREATE UNIQUE INDEX a_note ON a(note);
    CREATE INDEX b_x ON users(locale);
    CREATE VIEW v AS SELECT 1;
    ALTER TABLE users ADD COLUMN c TEXT;
    ALTER TABLE users ADD COLUMN d INTEGER NOT NULL DEFAULT 0 CHECK (d IN (0,1));
    UPDATE users SET c = 'x';
    INSERT OR IGNORE INTO meta (key) VALUES ('a');
  `);
});

test("BEGIN...END of a trigger passes, DELETE and CASE inside its body too", () => {
  lintMigrationSql(`
    CREATE TRIGGER t BEFORE UPDATE ON users BEGIN
      DELETE FROM meta WHERE key = CASE WHEN NEW.locale IS NULL THEN 'a' ELSE 'b' END;
      SELECT RAISE(ABORT, 'x');
    END;
    CREATE TABLE after_it (a INTEGER) STRICT;
  `);
  assert.throws(() => lintMigrationSql("CREATE TRIGGER t BEFORE UPDATE ON users BEGIN DROP TABLE a; END;"), /DROP/);
});

test("migrate twice changes nothing", (t) => {
  const { connection } = migratedDb(t);
  const before = {
    objects: connection.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
    applied: connection.prepare("SELECT version, name, sha256, applied_at FROM schema_migrations").all(),
    meta: connection.prepare("SELECT key, value, updated_at FROM meta").all(),
    settings: connection.prepare("SELECT key, value_json, updated_at FROM instance_settings ORDER BY key").all(),
  };
  assert.equal(before.applied.length, 1);
  assert.deepEqual(migrate(connection), []);
  assert.deepEqual(pendingMigrations(connection), []);
  assert.deepEqual({
    objects: connection.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
    applied: connection.prepare("SELECT version, name, sha256, applied_at FROM schema_migrations").all(),
    meta: connection.prepare("SELECT key, value, updated_at FROM meta").all(),
    settings: connection.prepare("SELECT key, value_json, updated_at FROM instance_settings ORDER BY key").all(),
  }, before);
  assert.equal(schemaVersion(), 1);
  requireSchema(1);
});

for (const role of ["primary", "social", "cli"]) {
  test(`role ${role} may not migrate`, (t) => {
    const connection = freshDb(t, role);
    assert.throws(() => migrate(connection), new RegExp(`migrate: role ${role} dilarang`));
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get().n, 0);
  });
}

test("a file changed after it was applied stops the boot", (t) => {
  const connection = freshDb(t);
  const dir = tempDir(t, { "0001-a.sql": META });
  migrate(connection, dir);
  writeFileSync(path.join(dir, "0001-a.sql"), `${META}-- edited\n`);
  assert.throws(() => migrate(connection, dir), MigrationTamperedError);
});

test("a DB newer than the image is accepted, untouched: the image-rollback rule", (t) => {
  const connection = freshDb(t);
  const logged = [];
  const newer = tempDir(t, { "0001-a.sql": META, "0002-b.sql": "CREATE TABLE b (a INTEGER) STRICT;" });
  migrate(connection, newer);
  const older = tempDir(t, { "0001-a.sql": META });
  assert.deepEqual(migrate(connection, older, { log: (line) => logged.push(line) }), []);
  assert.match(logged.join(), /skema lebih baru/);
  assert.equal(schemaVersion(), 2);
  requireSchema(1);
});

test("a failing statement rolls the whole file back", (t) => {
  const connection = freshDb(t);
  const dir = tempDir(t, {
    "0001-a.sql": META,
    "0002-b.sql": "CREATE TABLE b (a INTEGER) STRICT;\nINSERT OR IGNORE INTO no_such_table (a) VALUES (1);",
  });
  assert.throws(() => migrate(connection, dir));
  assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'b'").get().n, 0);
  assert.deepEqual(connection.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version), [1]);
  assert.equal(schemaVersion(), 1);
});

test("schema_migrations has its fixed DDL and the migrated DB passes foreign_key_check", (t) => {
  const { connection } = migratedDb(t);
  const stored = connection.prepare("SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'").get().sql;
  assert.equal(stored.replace("IF NOT EXISTS ", "").replace(/\s+/g, " "), SCHEMA_MIGRATIONS_DDL.replace("IF NOT EXISTS ", "").replace(/;$/, "").replace(/\s+/g, " "));
  assert.deepEqual(connection.prepare("PRAGMA foreign_key_check").all(), []);
});
