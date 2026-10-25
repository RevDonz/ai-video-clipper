// The per-device UI preference behind "Pintasan satu tombol" (05-ui-dashboard.md §3.9): the
// potongin_shortcuts cookie, on by default, read by the app shell and the editor (one preference).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SHORTCUTS_COOKIE,
  SHORTCUTS_MAX_AGE,
  readShortcutPref,
  shortcutPrefCookie,
  shortcutPrefFromValue,
  writeShortcutPref,
} from "../lib/ui-prefs.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));

test("the cookie is potongin_shortcuts and lives a year", () => {
  assert.equal(SHORTCUTS_COOKIE, "potongin_shortcuts");
  assert.equal(SHORTCUTS_MAX_AGE, 365 * 24 * 60 * 60);
});

test("on and off are read as written; the old 1/0 values too; anything else is the default, on", () => {
  assert.equal(shortcutPrefFromValue("on"), true);
  assert.equal(shortcutPrefFromValue("off"), false);
  assert.equal(shortcutPrefFromValue("1"), true);
  assert.equal(shortcutPrefFromValue("0"), false);
  for (const value of [undefined, null, "", "OFF ", "no", "false", 0, {}, "of"]) {
    assert.equal(shortcutPrefFromValue(value), true, JSON.stringify(value));
  }
});

test("readShortcutPref takes a whole Cookie header or document.cookie", () => {
  assert.equal(readShortcutPref(""), true);
  assert.equal(readShortcutPref(undefined), true);
  assert.equal(readShortcutPref(null), true);
  assert.equal(readShortcutPref("potongin_shortcuts=off"), false);
  assert.equal(readShortcutPref("potongin_locale=id; potongin_shortcuts=off; potongin_session=x.y"), false);
  assert.equal(readShortcutPref("potongin_session=a; potongin_shortcuts=0"), false);
  assert.equal(readShortcutPref("potongin_shortcuts=on"), true);
  assert.equal(readShortcutPref(" potongin_shortcuts = off "), false, "spaces around the pair");
  // Another cookie whose name only ends the same way is not it.
  assert.equal(readShortcutPref("my_potongin_shortcuts=off"), true);
  assert.equal(readShortcutPref("potongin_shortcutsx=off"), true);
  // The first one wins, as browsers send the most specific path first.
  assert.equal(readShortcutPref("potongin_shortcuts=off; potongin_shortcuts=on"), false);
  assert.equal(readShortcutPref("potongin_shortcuts=%6Fff"), false, "an encoded value");
  assert.equal(readShortcutPref("potongin_shortcuts=%E0%A4%A"), true, "a broken encoding is the default");
});

test("the cookie written: Path=/, SameSite=Lax, a year, Secure on https, never HttpOnly", () => {
  assert.equal(shortcutPrefCookie(false, { secure: true }), "potongin_shortcuts=off; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  assert.equal(shortcutPrefCookie(true, { secure: false }), "potongin_shortcuts=on; Path=/; Max-Age=31536000; SameSite=Lax");
  assert.doesNotMatch(shortcutPrefCookie(false, { secure: true }), /HttpOnly/i);
  // Only a real true turns it on: the value read back is exactly what was asked for.
  assert.match(shortcutPrefCookie("yes"), /^potongin_shortcuts=off;/);
});

test("writeShortcutPref sets document.cookie, Secure when the page is https, and reads back", () => {
  const jar = { cookie: "" };
  const page = (protocol) => ({
    get cookie() { return jar.cookie; },
    set cookie(value) { jar.cookie = value.split(";")[0]; jar.last = value; },
    location: { protocol },
  });
  const doc = page("https:");
  assert.equal(writeShortcutPref(false, doc), false);
  assert.match(jar.last, /; Secure$/);
  assert.equal(readShortcutPref(doc.cookie), false);
  assert.equal(writeShortcutPref(true, page("http:")), true);
  assert.doesNotMatch(jar.last, /Secure/);
  assert.equal(readShortcutPref(jar.cookie), true);
  // Without a document (server, tests) nothing is written and the value is still returned.
  assert.equal(writeShortcutPref(false, null), false);
});

test("the module runs in the browser and on the server: no Node built-ins, no React", async () => {
  const source = await readFile(path.join(WEB, "lib", "ui-prefs.mjs"), "utf8");
  assert.doesNotMatch(source, /from "node:|require\(|from "react"|from "next\//);
});

test("the editor page reads the same preference on the server and hands it to the editor", async () => {
  const page = await readFile(path.join(WEB, "app", "projects", "[id]", "clips", "[clipId]", "edit", "page.jsx"), "utf8");
  assert.match(page, /import \{ SHORTCUTS_COOKIE, shortcutPrefFromValue \} from "(\.\.\/)+lib\/ui-prefs\.mjs";/);
  assert.match(page, /shortcutPrefFromValue\(store\.get\(SHORTCUTS_COOKIE\)\?\.value\)/);
  assert.match(page, /singleKeyShortcuts=\{singleKeyShortcuts\}/);
  const app = await readFile(path.join(WEB, "components", "editor", "EditorApp.jsx"), "utf8");
  assert.match(app, /globalShortcut\(event, \{ singleKey: singleKeyRef\.current \}\)/);
});
