// /data/settings -> /control/settings (rombak 01 §5.2): a copy with a sha256 check and a marker,
// not a symlink and not a move. The old tree stays frozen, so an old image with the old compose
// still finds its settings. Only --purge-legacy-settings ever removes it, by hand, after checks.
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";

export const MIGRATED_MARKER = ".migrated-from-data";
const STALE_LOCK_MS = 5 * 60_000;
const LOCK_WAIT_MS = 60_000;

export class SettingsMoveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettingsMoveError";
    this.code = code;
  }
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fsyncFile(file) {
  const fd = openSync(file, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Regular files and directories of `root`, relative and sorted; anything else is refused. */
function walk(root) {
  const entries = [];
  const visit = (relative) => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const info = lstatSync(path.join(root, child));
      if (info.isDirectory()) {
        entries.push({ relative: child, kind: "dir", mode: info.mode & 0o777 });
        visit(child);
      } else if (info.isFile()) {
        entries.push({ relative: child, kind: "file", mode: info.mode & 0o777 });
      } else {
        throw new SettingsMoveError("not_regular", `Pengaturan lama memuat bukan-file: ${child}`);
      }
    }
  };
  visit("");
  return entries;
}

function listDigest(files) {
  const lines = files.map(({ relative, sha }) => `${sha}  ${relative}\n`).join("");
  return createHash("sha256").update(lines).digest("hex");
}

function sourceFiles(from) {
  return walk(from).filter((entry) => entry.kind === "file")
    .map((entry) => ({ relative: entry.relative, sha: sha256File(path.join(from, entry.relative)) }));
}

const isEmptyDirectory = (dir) => readdirSync(dir).length === 0;

function acquireLock(lockDir, now, wait) {
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: now() }), { mode: 0o600 });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let age = 0;
    try { age = now() - statSync(lockDir).mtimeMs; } catch { continue; }
    if (age > STALE_LOCK_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    if (now() > deadline) throw new SettingsMoveError("locked", "Pemindahan pengaturan sedang berjalan di proses lain.");
    wait(200);
  }
}

const sleepSync = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

function copyTree(from, to, entries) {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const target = path.join(to, entry.relative);
    if (entry.kind === "dir") {
      mkdirSync(target, { mode: entry.mode, recursive: true });
      chmodSync(target, entry.mode);
    } else {
      copyFileSync(path.join(from, entry.relative), target, constants.COPYFILE_EXCL);
      chmodSync(target, entry.mode);
      fsyncFile(target);
    }
  }
}

function verifyCopy(from, to, files) {
  for (const { relative } of files) {
    if (sha256File(path.join(from, relative)) !== sha256File(path.join(to, relative))) {
      throw new SettingsMoveError("sha_mismatch", `Salinan pengaturan berbeda: ${relative}`);
    }
  }
}

function writeMarker(to, marker) {
  const file = path.join(to, MIGRATED_MARKER);
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  fsyncFile(temporary);
  renameSync(temporary, file);
}

/**
 * Copies `from` to `to` once. Returns { moved, files, marker }. Throws SettingsMoveError (the app
 * does not start, the old tree is untouched) on a symlink or a sha mismatch. A file already in
 * `to` without a marker is kept: it was written there by an image that ran with the new compose.
 */
export function moveSettings({ from, to, now = () => Date.now(), wait = sleepSync } = {}) {
  if (!from || !to) throw new SettingsMoveError("config", "Path pengaturan tidak lengkap.");
  if (path.resolve(/* turbopackIgnore: true */ from) === path.resolve(/* turbopackIgnore: true */ to)) {
    return { moved: false, files: 0, marker: null };
  }
  const markerFile = path.join(to, MIGRATED_MARKER);
  if (existsSync(markerFile)) return { moved: false, files: 0, marker: JSON.parse(readFileSync(markerFile, "utf8")) };
  const parent = path.dirname(to);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const release = acquireLock(path.join(parent, ".settings-move.lock"), now, wait);
  try {
    if (existsSync(markerFile)) return { moved: false, files: 0, marker: JSON.parse(readFileSync(markerFile, "utf8")) };
    const hasSource = existsSync(from) && lstatSync(from).isDirectory() && !isEmptyDirectory(from);
    if (!hasSource) {
      if (existsSync(from) && lstatSync(from).isSymbolicLink()) throw new SettingsMoveError("not_regular", "Folder pengaturan lama adalah symlink.");
      mkdirSync(to, { recursive: true, mode: 0o700 });
      const marker = { from: null, at: now(), files: 0, sha256: null };
      writeMarker(to, marker);
      return { moved: false, files: 0, marker };
    }
    const entries = walk(from);
    const files = sourceFiles(from);
    const scratch = `${to}.tmp-${process.pid}`;
    rmSync(scratch, { recursive: true, force: true });
    try {
      copyTree(from, scratch, entries);
      verifyCopy(from, scratch, files);
      const hadTarget = existsSync(to);
      if (!hadTarget || isEmptyDirectory(to)) {
        if (hadTarget) rmSync(to, { recursive: true });
        renameSync(scratch, to);
        chmodSync(to, 0o700);
      } else {
        // Only what is not there yet; a newer file in the target wins and is not compared.
        for (const entry of entries) {
          const target = path.join(to, entry.relative);
          if (existsSync(target)) continue;
          if (entry.kind === "dir") {
            mkdirSync(target, { mode: entry.mode, recursive: true });
            chmodSync(target, entry.mode);
          } else {
            mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            renameSync(path.join(scratch, entry.relative), target);
            if (sha256File(path.join(from, entry.relative)) !== sha256File(target)) {
              throw new SettingsMoveError("sha_mismatch", `Salinan pengaturan berbeda: ${entry.relative}`);
            }
          }
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const marker = { from, at: now(), files: files.length, sha256: listDigest(files) };
    writeMarker(to, marker);
    return { moved: true, files: files.length, marker };
  } finally {
    release();
  }
}

/** The marker of `to`, or null. */
export function readMarker(to) {
  try { return JSON.parse(readFileSync(path.join(to, MIGRATED_MARKER), "utf8")); } catch { return null; }
}

/**
 * Removes the frozen copy (01 §5.2): only with a marker, and only while the old tree still hashes
 * to what was copied. Exit codes of admin-reset: 2 no marker, 3 sha differs (nothing removed).
 */
export function purgeLegacySettings({ from, to }) {
  const marker = readMarker(to);
  if (!marker) throw new SettingsMoveError("no_marker", "Penanda pemindahan tidak ada.");
  if (!existsSync(from)) return { removed: false };
  if (marker.from !== null && listDigest(sourceFiles(from)) !== marker.sha256) {
    throw new SettingsMoveError("sha_mismatch", "Isi pengaturan lama berubah sejak disalin.");
  }
  if (marker.from === null && !isEmptyDirectory(from)) {
    throw new SettingsMoveError("sha_mismatch", "Isi pengaturan lama berubah sejak disalin.");
  }
  rmSync(from, { recursive: true, force: true });
  return { removed: true };
}
