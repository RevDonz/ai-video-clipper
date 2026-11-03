// Numbered, additive migrations (rombak 01 §3). Only role app or test may run them. One file is
// one BEGIN IMMEDIATE, run whole with one exec; the file's sha256 is kept, so a file that changed
// after it was applied stops the boot. A DB newer than this image is accepted as it is: that is
// what makes an image rollback safe.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { db, dbRole, tx } from "./index.mjs";

export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY CHECK (version >= 1),
  name       TEXT    NOT NULL CHECK (length(name) BETWEEN 6 AND 80),
  sha256     TEXT    NOT NULL CHECK (length(sha256) = 64),
  applied_at INTEGER NOT NULL
) STRICT;`;

const FILE_NAME = /^(\d{4})-[a-z0-9-]+\.sql$/;
const MIGRATING_ROLES = new Set(["app", "test"]);

export class MigrationTamperedError extends Error {
  constructor(name) { super(`Migrasi ${name} berubah setelah diterapkan`); this.name = "MigrationTamperedError"; this.code = "migration_tampered"; }
}
export class MigrationOrderError extends Error {
  constructor(message) { super(message); this.name = "MigrationOrderError"; this.code = "migration_order"; }
}
export class MigrationLintError extends Error {
  constructor(message) { super(message); this.name = "MigrationLintError"; this.code = "migration_lint"; }
}

/** `process.cwd()/lib/db/migrations`: cwd is /app in the image, web/ in dev and tests (01 §2.1). */
export function defaultMigrationsDir(cwd = process.cwd()) {
  return path.join(cwd, "lib/db/migrations");
}

// Words, numbers and punctuation with their line; comments and string literals are skipped, so a
// forbidden word in a comment or a text value is not a finding.
function tokenize(text) {
  const tokens = [];
  let line = 1;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === "\n") { line += 1; at += 1; continue; }
    if (/\s/.test(char)) { at += 1; continue; }
    if (text.startsWith("--", at)) {
      while (at < text.length && text[at] !== "\n") at += 1;
      continue;
    }
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let i = at; i < stop; i += 1) if (text[i] === "\n") line += 1;
      at = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      let i = at + 1;
      while (i < text.length) {
        if (text[i] === char) {
          if (text[i + 1] === char) { i += 2; continue; }
          break;
        }
        if (text[i] === "\n") line += 1;
        i += 1;
      }
      tokens.push({ word: char === "'" ? "'" : text.slice(at + 1, i).toUpperCase(), line, quoted: true });
      at = i + 1;
      continue;
    }
    const word = /^[A-Za-z0-9_]+/.exec(text.slice(at, at + 128));
    if (word) {
      tokens.push({ word: word[0].toUpperCase(), line });
      at += word[0].length;
      continue;
    }
    tokens.push({ word: char, line });
    at += 1;
  }
  return tokens;
}

// One token list per statement. A CREATE TRIGGER runs to its END; the semicolons in its body do
// not end it, and CASE ... END inside the body is counted.
function statements(tokens) {
  const found = [];
  let current = [];
  let trigger = false;
  let depth = 0;
  for (const token of tokens) {
    if (token.word === ";" && !token.quoted && depth === 0) {
      if (current.length) found.push(current);
      current = [];
      trigger = false;
      continue;
    }
    current.push(token);
    if (token.quoted) continue;
    if (current.length <= 3 && token.word === "TRIGGER" && current[0].word === "CREATE") trigger = true;
    if (trigger) {
      if (token.word === "BEGIN" || token.word === "CASE") depth += 1;
      else if (token.word === "END" && depth > 0) depth -= 1;
    }
  }
  if (current.length) found.push(current);
  return found;
}

function hasSequence(statement, ...words) {
  for (let i = 0; i + words.length <= statement.length; i += 1) {
    if (words.every((word, offset) => statement[i + offset].word === word && !statement[i + offset].quoted)) return true;
  }
  return false;
}

const unquoted = (statement) => statement.filter((token) => !token.quoted).map((token) => token.word);

function tableAfter(statement, keyword) {
  const index = statement.findIndex((token) => token.word === keyword && !token.quoted);
  return index < 0 ? null : statement[index + 1]?.word ?? null;
}

function checkCreate(statement, fail, createdHere) {
  const words = unquoted(statement);
  if (words[1] === "TABLE") {
    createdHere.add(statement[2]?.word);
    const close = statement.map((token) => token.word).lastIndexOf(")");
    const tail = statement.slice(close + 1).map((token) => token.word);
    if (!tail.includes("STRICT")) fail(statement[0], "CREATE TABLE wajib STRICT");
    return;
  }
  if (words[1] === "UNIQUE" && words[2] === "INDEX") {
    if (!createdHere.has(tableAfter(statement, "ON"))) fail(statement[0], "CREATE UNIQUE INDEX hanya untuk tabel baru di migrasi ini");
    return;
  }
  if (["INDEX", "TRIGGER", "VIEW"].includes(words[1])) return;
  fail(statement[0], `CREATE ${words[1] ?? ""} tidak diizinkan`);
}

function checkAlter(statement, fail, addedHere) {
  const words = unquoted(statement);
  if (words[1] !== "TABLE" || !hasSequence(statement, "ADD", "COLUMN")) {
    fail(statement[0], "ALTER TABLE hanya boleh ADD COLUMN");
    return;
  }
  const add = statement.findIndex((token) => token.word === "COLUMN" && !token.quoted);
  addedHere.add(statement[add + 1]?.word);
  if (hasSequence(statement, "NOT", "NULL") && !hasSequence(statement, "DEFAULT")) {
    fail(statement[0], "ADD COLUMN NOT NULL wajib DEFAULT");
  }
}

function checkUpdate(statement, fail, addedHere) {
  const set = statement.findIndex((token) => token.word === "SET" && !token.quoted);
  if (set < 0 || !addedHere.has(statement[set + 1]?.word)) fail(statement[0], "UPDATE hanya untuk mengisi kolom yang dibuat di migrasi ini");
}

/** Throws MigrationLintError when `text` is not additive (01 §3.2). */
export function lintMigrationSql(text, fileName = "migrasi") {
  const fail = (token, reason) => {
    throw new MigrationLintError(`${fileName} baris ${token?.line ?? 1}: ${reason}`);
  };
  const createdHere = new Set();
  const addedHere = new Set();
  for (const statement of statements(tokenize(text))) {
    const first = statement[0].word;
    for (const [word, reason] of [
      ["DROP", "DROP dilarang"], ["RENAME", "RENAME dilarang"], ["PRAGMA", "PRAGMA hanya di openDb"],
      ["ATTACH", "ATTACH dilarang"], ["DETACH", "DETACH dilarang"], ["VACUUM", "VACUUM dilarang"],
    ]) {
      const token = statement.find((item) => item.word === word && !item.quoted);
      if (token) fail(token, reason);
    }
    if (hasSequence(statement, "IF", "NOT", "EXISTS")) fail(statement[0], "IF NOT EXISTS menyembunyikan drift");
    if (hasSequence(statement, "REPLACE", "INTO") || hasSequence(statement, "OR", "REPLACE")) fail(statement[0], "REPLACE dilarang");
    if (first === "CREATE") checkCreate(statement, fail, createdHere);
    else if (first === "ALTER") checkAlter(statement, fail, addedHere);
    else if (first === "UPDATE") checkUpdate(statement, fail, addedHere);
    else if (first === "INSERT") {
      if (!hasSequence(statement, "INSERT", "OR", "IGNORE")) fail(statement[0], "INSERT hanya boleh OR IGNORE");
    } else if (first === "DELETE") fail(statement[0], "DELETE FROM dilarang di level statement");
    else if (["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"].includes(first)) fail(statement[0], "statement transaksi dilarang");
    else fail(statement[0], `statement ${first} tidak diizinkan`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function migrationFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const match = FILE_NAME.exec(name);
    if (match) files.push({ version: Number(match[1]), name, file: path.join(dir, name) });
  }
  files.sort((a, b) => a.version - b.version);
  files.forEach((item, index) => {
    if (item.version !== index + 1) throw new MigrationOrderError(`Nomor migrasi harus urut tanpa celah: ${item.name}`);
  });
  return files;
}

function appliedRows(connection) {
  connection.exec(SCHEMA_MIGRATIONS_DDL);
  return connection.prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version").all();
}

/** The files this image has that the DB does not, oldest first. */
export function pendingMigrations(connection = db(), dir = defaultMigrationsDir()) {
  const applied = appliedRows(connection);
  const highest = applied.at(-1)?.version ?? 0;
  return migrationFiles(dir).filter((item) => item.version > highest);
}

/** The highest migration number this image knows (db-restore's min_image_schema check). */
export function knownSchemaVersion(dir = defaultMigrationsDir()) {
  return migrationFiles(dir).at(-1)?.version ?? 0;
}

/** Applies what is pending; running it twice changes nothing. Returns the versions applied. */
export function migrate(connection = db(), dir = defaultMigrationsDir(), { now = () => Date.now(), log = console.warn } = {}) {
  const role = dbRole();
  if (!MIGRATING_ROLES.has(role)) throw new Error(`migrate: role ${role} dilarang`);
  const files = migrationFiles(dir);
  const applied = tx(() => appliedRows(connection));
  const byVersion = new Map(files.map((item) => [item.version, item]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (file && sha256(readFileSync(file.file)) !== row.sha256) throw new MigrationTamperedError(file.name);
  }
  const highest = applied.at(-1)?.version ?? 0;
  if (highest > files.length) log(`[db] skema lebih baru dari image ini (${highest} > ${files.length}); lanjut tanpa migrasi`);
  const done = [];
  for (const item of files.filter((candidate) => candidate.version > highest)) {
    const bytes = readFileSync(item.file);
    const text = bytes.toString("utf8");
    lintMigrationSql(text, item.name);
    tx(() => {
      connection.exec(text);
      const at = now();
      connection.prepare("INSERT INTO schema_migrations (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)")
        .run(item.version, item.name, sha256(bytes), at);
      connection.prepare(`INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(String(item.version), at);
    });
    done.push(item.version);
  }
  const broken = connection.prepare("PRAGMA foreign_key_check").all();
  if (broken.length) throw new Error(`foreign_key_check menemukan ${broken.length} baris`);
  const quick = connection.prepare("PRAGMA quick_check").get();
  if (quick?.quick_check !== "ok") throw new Error("quick_check gagal");
  return done;
}
