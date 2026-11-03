// /data/settings is COPIED to /control/settings with a sha check and a marker; the old copy stays
// for an image rollback (rombak 01 §5.2). Temp directories only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bootApp, prepareSettings } from "../lib/db/boot.mjs";
import { importEnvToFile } from "../lib/llm-settings.mjs";
import { closeDb, db } from "../lib/db/index.mjs";
import { MIGRATED_MARKER, SettingsMoveError, moveSettings, purgeLegacySettings, readMarker } from "../lib/db/settings-move.mjs";
import { TEST_ENV, tempControl } from "./support/session.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));

function seedLegacy(control) {
  const from = control.legacySettings;
  mkdirSync(path.join(from, "default-logo"), { recursive: true, mode: 0o700 });
  chmodSync(from, 0o700);
  writeFileSync(path.join(from, "llm-settings.json"), '{"sealed":"keys"}', { mode: 0o600 });
  writeFileSync(path.join(from, "default-logo", "logo.png"), Buffer.from([1, 2, 3]), { mode: 0o600 });
  return from;
}

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("the tree is copied with its modes, the marker names it, and the old copy stays", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  const result = moveSettings({ from, to: control.settingsDir, now: () => 5 });
  assert.equal(result.moved, true);
  assert.equal(result.files, 2);
  for (const name of ["llm-settings.json", "default-logo/logo.png"]) {
    assert.equal(sha(path.join(control.settingsDir, name)), sha(path.join(from, name)), name);
    assert.equal(statSync(path.join(control.settingsDir, name)).mode & 0o777, 0o600, name);
    assert.ok(existsSync(path.join(from, name)), `${name} stays in the old tree`);
  }
  assert.equal(statSync(control.settingsDir).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(control.settingsDir, "default-logo")).mode & 0o777, 0o700);
  const marker = JSON.parse(readFileSync(path.join(control.settingsDir, MIGRATED_MARKER), "utf8"));
  assert.deepEqual({ from: marker.from, files: marker.files, at: marker.at }, { from, files: 2, at: 5 });
  assert.match(marker.sha256, /^[0-9a-f]{64}$/);
  assert.equal(readdirSync(control.root).filter((name) => name.includes(".tmp-") || name.includes(".lock")).length, 0, "no scratch left");
});

test("twice is a no-op: a later change on either side is not copied over", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  moveSettings({ from, to: control.settingsDir });
  const before = readFileSync(path.join(control.settingsDir, MIGRATED_MARKER), "utf8");
  writeFileSync(path.join(control.settingsDir, "llm-settings.json"), "newer");
  writeFileSync(path.join(from, "added-later.json"), "{}");
  const again = moveSettings({ from, to: control.settingsDir });
  assert.equal(again.moved, false);
  assert.equal(readFileSync(path.join(control.settingsDir, "llm-settings.json"), "utf8"), "newer");
  assert.equal(existsSync(path.join(control.settingsDir, "added-later.json")), false);
  assert.equal(readFileSync(path.join(control.settingsDir, MIGRATED_MARKER), "utf8"), before);
});

test("no old settings, or an empty folder: the marker says from null", (t) => {
  const control = tempControl(t);
  assert.equal(moveSettings({ from: control.legacySettings, to: control.settingsDir }).moved, false);
  assert.equal(readMarker(control.settingsDir).from, null);
  const other = tempControl(t);
  mkdirSync(other.legacySettings, { recursive: true });
  moveSettings({ from: other.legacySettings, to: other.settingsDir });
  assert.equal(readMarker(other.settingsDir).from, null);
});

test("a symlink anywhere in the old tree stops the move, and nothing is left behind", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  symlinkSync("/etc/hostname", path.join(from, "default-logo", "evil"));
  assert.throws(() => moveSettings({ from, to: control.settingsDir }), (error) => error instanceof SettingsMoveError && error.code === "not_regular");
  assert.equal(existsSync(control.settingsDir), false);
  assert.equal(readMarker(control.settingsDir), null);
});

test("a symlinked old folder is refused", (t) => {
  const control = tempControl(t);
  mkdirSync(path.dirname(control.legacySettings), { recursive: true });
  symlinkSync(control.root, control.legacySettings);
  assert.throws(() => moveSettings({ from: control.legacySettings, to: control.settingsDir }), SettingsMoveError);
});

test("the target already exists without a marker: only what is missing is copied", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  mkdirSync(control.settingsDir, { mode: 0o700 });
  writeFileSync(path.join(control.settingsDir, "llm-settings.json"), "written-by-old-image-with-new-compose");
  const result = moveSettings({ from, to: control.settingsDir });
  assert.equal(result.moved, true);
  assert.equal(readFileSync(path.join(control.settingsDir, "llm-settings.json"), "utf8"), "written-by-old-image-with-new-compose");
  assert.equal(sha(path.join(control.settingsDir, "default-logo/logo.png")), sha(path.join(from, "default-logo/logo.png")));
});

test("an empty target folder, as the image makes it, is replaced by the copy", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  mkdirSync(control.settingsDir, { mode: 0o700 });
  moveSettings({ from, to: control.settingsDir });
  assert.equal(sha(path.join(control.settingsDir, "llm-settings.json")), sha(path.join(from, "llm-settings.json")));
});

test("the same path on both sides does nothing", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  assert.deepEqual(moveSettings({ from, to: from }), { moved: false, files: 0, marker: null });
  assert.equal(existsSync(path.join(from, MIGRATED_MARKER)), false);
});

test("a stale lock is taken over; a live one waits, then refuses", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  const lock = path.join(control.root, ".settings-move.lock");
  mkdirSync(lock);
  const stale = new Date(Date.now() - 6 * 60_000);
  utimesSync(lock, stale, stale);
  assert.equal(moveSettings({ from, to: control.settingsDir }).moved, true);

  const other = tempControl(t);
  const otherFrom = seedLegacy(other);
  mkdirSync(path.join(other.root, ".settings-move.lock"));
  let clock = Date.now();
  assert.throws(() => moveSettings({ from: otherFrom, to: other.settingsDir, now: () => clock, wait: () => { clock += 30_000; } }),
    (error) => error.code === "locked");
  assert.ok(existsSync(path.join(otherFrom, "llm-settings.json")));
});

test("purge needs the marker and an unchanged old tree", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  assert.throws(() => purgeLegacySettings({ from, to: control.settingsDir }), (error) => error.code === "no_marker");
  assert.ok(existsSync(from));
  moveSettings({ from, to: control.settingsDir });
  writeFileSync(path.join(from, "changed-by-rollback.json"), "{}");
  assert.throws(() => purgeLegacySettings({ from, to: control.settingsDir }), (error) => error.code === "sha_mismatch");
  assert.ok(existsSync(path.join(from, "llm-settings.json")), "nothing removed");
});

test("purge removes the frozen copy when everything matches, and only then", (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  moveSettings({ from, to: control.settingsDir });
  assert.deepEqual(purgeLegacySettings({ from, to: control.settingsDir }), { removed: true });
  assert.equal(existsSync(from), false);
  assert.ok(existsSync(path.join(control.settingsDir, "llm-settings.json")));
  assert.deepEqual(purgeLegacySettings({ from, to: control.settingsDir }), { removed: false });
});

test("a full boot copies the settings, records the move once, and never removes the old tree", async (t) => {
  const control = tempControl(t);
  const from = seedLegacy(control);
  closeDb();
  t.after(closeDb);
  const env = { ...TEST_ENV, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: path.join(control.root, "data", "jobs") };
  await bootApp({ env, log: () => {}, now: 1000 });
  assert.ok(existsSync(path.join(from, "llm-settings.json")));
  assert.ok(existsSync(path.join(control.settingsDir, MIGRATED_MARKER)));
  const audit = () => db().prepare("SELECT code, params_json FROM audit_events WHERE code = 'settings.migrated'").all();
  assert.equal(db().prepare("SELECT value FROM meta WHERE key = 'settings_migrated_at'").get().value, "1000");
  assert.deepEqual(audit().map((row) => JSON.parse(row.params_json)), [{ files: 2 }]);
  await bootApp({ env, log: () => {}, now: 2000 });
  assert.equal(audit().length, 1, "once");
  assert.equal(db().prepare("SELECT value FROM meta WHERE key = 'settings_migrated_at'").get().value, "1000");
});

test("the deploy's --prepare-settings copies before any DB exists, and refuses a bad secret or APP_USERNAME", (t) => {
  const control = tempControl(t);
  seedLegacy(control);
  const run = (extra) => spawnSync(process.execPath, ["scripts/start-app.mjs", "--prepare-settings"], {
    cwd: WEB,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...TEST_ENV, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: path.join(control.root, "data", "jobs"), ...extra },
  });
  const short = run({ POTONGIN_SETTINGS_SECRET: "too-short" });
  assert.equal(short.status, 1);
  assert.match(short.stderr, /POTONGIN_SETTINGS_SECRET/);
  assert.doesNotMatch(short.stderr, /too-short/, "the value never reaches the log");
  assert.equal(run({ APP_USERNAME: "x" }).status, 1);
  assert.equal(existsSync(path.join(control.settingsDir, MIGRATED_MARKER)), false);
  const good = run({});
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^SETTINGS_MOVE=copied:2$/m);
  assert.equal(existsSync(control.dbFile), false, "no DB yet");
  assert.match(run({}).stdout, /^SETTINGS_MOVE=none$/m);
});

const PLANTED = "planted-value";

test("prepareSettings warns, without a value, when the secret cannot open a saved key", async (t) => {
  const control = tempControl(t);
  const env = { ...TEST_ENV, POTONGIN_DB_PATH: control.dbFile, POTONGIN_SETTINGS_DIR: control.settingsDir, JOBS_ROOT: path.join(control.root, "data", "jobs") };
  mkdirSync(control.settingsDir, { mode: 0o700 });
  await importEnvToFile({ env: { ...env, POTONGIN_LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: PLANTED } });
  const lines = [];
  await prepareSettings(env, { log: (line) => lines.push(line) });
  assert.deepEqual(lines, [], "the same secret: nothing to say");
  const other = "another-secret-with-at-least-thirty-two-chars";
  await prepareSettings({ ...env, POTONGIN_SETTINGS_SECRET: other }, { log: (line) => lines.push(line) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /PERINGATAN: 1 key LLM tidak terbuka/);
  assert.doesNotMatch(lines[0], new RegExp(other));
  assert.doesNotMatch(lines[0], new RegExp(PLANTED));
});
