// The flat app sidebar (05-ui-dashboard.md §4.1): one list, the entries shown per role and per
// feature flag, the current page marked; the features computed on the server (lib/ui-features.mjs)
// and the signed-in user as the shell shows it (lib/shell-user.mjs).
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_ICONS } from "../lib/app-icons.mjs";
import { NAV_LINKS, navLinks } from "../lib/app-nav.mjs";
import { shellUser } from "../lib/shell-user.mjs";
import { UI_FEATURES, uiFeatures } from "../lib/ui-features.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ALL = Object.freeze({ social: true, analytics: true, admin: true, performance: true });
const hrefs = (links) => links.map((entry) => entry.href);

test("the list is flat and in 05's order, with catalog keys instead of words", () => {
  assert.deepEqual(NAV_LINKS.map((entry) => [entry.href, entry.labelKey, entry.icon]), [
    ["/dashboard", "shell.nav.create", "create"],
    ["/projects", "shell.nav.projects", "projects"],
    ["/sosial", "shell.nav.social", "social"],
    ["/analitik", "shell.nav.analytics", "analytics"],
    ["/trends", "shell.nav.trends", "trends"],
    ["/settings", "shell.nav.settings", "settings"],
    ["/admin/pengguna", "shell.nav.admin", "admin"],
    ["/bantuan", "shell.nav.help", "help"],
  ]);
  assert.deepEqual(NAV_LINKS.filter((entry) => entry.primary).map((entry) => entry.href), ["/dashboard"]);
  assert.ok(Object.isFrozen(NAV_LINKS) && NAV_LINKS.every((entry) => Object.isFrozen(entry)));
  for (const entry of NAV_LINKS) {
    assert.ok(APP_ICONS[entry.icon], `${entry.href}: icon ${entry.icon}`);
    assert.equal("label" in entry, false, `${entry.href}: words live in the catalog`);
  }
});

test("every label key is in the id and en catalogs, Proyek and Tren as the G0 labels", async () => {
  for (const locale of ["id", "en"]) {
    const shell = JSON.parse(await readFile(path.join(WEB, "messages", locale, "shell.json"), "utf8"));
    for (const entry of NAV_LINKS) {
      const [, ...keyPath] = entry.labelKey.split(".");
      const text = keyPath.reduce((node, part) => node?.[part], shell);
      assert.equal(typeof text, "string", `${locale} ${entry.labelKey}`);
    }
  }
  const id = JSON.parse(await readFile(path.join(WEB, "messages", "id", "shell.json"), "utf8"));
  assert.deepEqual(id.nav, {
    create: "Buat klip", projects: "Proyek", social: "Sosial", analytics: "Analitik", trends: "Tren",
    settings: "Pengaturan", admin: "Admin", help: "Bantuan",
  });
});

test("without flags and as the single-user admin: Buat klip, Proyek, Tren, Pengaturan, Bantuan", () => {
  assert.deepEqual(hrefs(navLinks("/dashboard")), ["/dashboard", "/projects", "/trends", "/settings", "/bantuan"]);
  assert.deepEqual(hrefs(navLinks("/dashboard", { role: "admin", features: {} })), hrefs(navLinks("/dashboard")));
});

test("a feature link shows only when its feature is exactly true", () => {
  assert.deepEqual(hrefs(navLinks("/x", { features: { social: true } })), ["/dashboard", "/projects", "/sosial", "/trends", "/settings", "/bantuan"]);
  assert.deepEqual(hrefs(navLinks("/x", { features: { analytics: true } })), ["/dashboard", "/projects", "/analitik", "/trends", "/settings", "/bantuan"]);
  assert.deepEqual(hrefs(navLinks("/x", { features: { social: "true", analytics: 1, admin: "yes" } })), hrefs(navLinks("/x")));
  assert.deepEqual(hrefs(navLinks("/x", { features: ALL })), NAV_LINKS.map((entry) => entry.href));
});

test("a role link shows only for that role, even with its feature on", () => {
  assert.equal(hrefs(navLinks("/x", { role: "member", features: ALL })).includes("/admin/pengguna"), false);
  assert.deepEqual(hrefs(navLinks("/x", { role: "member", features: ALL })), ["/dashboard", "/projects", "/sosial", "/analitik", "/trends", "/settings", "/bantuan"]);
  assert.equal(hrefs(navLinks("/x", { role: "admin", features: { admin: true } })).includes("/admin/pengguna"), true);
  assert.equal(hrefs(navLinks("/x", { role: "admin", features: {} })).includes("/admin/pengguna"), false, "admin needs its flag too");
  assert.equal(hrefs(navLinks("/x", { role: null, features: ALL })).includes("/admin/pengguna"), false);
});

test("current: the same path or a page under it, Admin under all of /admin", () => {
  const current = (pathname, features = ALL) => navLinks(pathname, { role: "admin", features }).filter((entry) => entry.current).map((entry) => entry.href);
  assert.deepEqual(current("/dashboard"), ["/dashboard"]);
  assert.deepEqual(current("/projects/x"), ["/projects"]);
  assert.deepEqual(current("/projects/job-1/clips/c/edit"), ["/projects"]);
  assert.deepEqual(current("/projectsx"), []);
  assert.deepEqual(current("/admin/job"), ["/admin/pengguna"]);
  assert.deepEqual(current("/admin/pengguna/u-1"), ["/admin/pengguna"]);
  assert.deepEqual(current("/administrator"), []);
  assert.deepEqual(current("/trends"), ["/trends"]);
  assert.deepEqual(current("/bantuan"), ["/bantuan"]);
  assert.deepEqual(current("/login"), []);
  assert.deepEqual(current(undefined), []);
  assert.deepEqual(current(null), []);
  // Each entry carries what the list needs to draw it, nothing else.
  const [first] = navLinks("/dashboard");
  assert.deepEqual(Object.keys(first).sort(), ["current", "href", "icon", "labelKey", "primary"]);
  assert.deepEqual(Object.keys(navLinks("/dashboard")[1]).sort(), ["current", "href", "icon", "labelKey"]);
});

test("uiFeatures: social follows POTONGIN_SOCIAL per role, analytics = social or performance", () => {
  const admin = { role: "admin" };
  const member = { role: "member" };
  const live = { pages: { social: true, analytics: true, admin: true } };
  assert.deepEqual(Object.keys(uiFeatures(admin, {}, live)).sort(), [...UI_FEATURES].sort());
  assert.deepEqual(uiFeatures(admin, {}, live), { social: false, performance: false, analytics: false, admin: false });
  assert.equal(uiFeatures(admin, { POTONGIN_SOCIAL: "on" }, live).social, true);
  assert.equal(uiFeatures(member, { POTONGIN_SOCIAL: "on" }, live).social, true);
  assert.equal(uiFeatures(admin, { POTONGIN_SOCIAL: "admin" }, live).social, true);
  assert.equal(uiFeatures(member, { POTONGIN_SOCIAL: "admin" }, live).social, false);
  assert.equal(uiFeatures(admin, { POTONGIN_SOCIAL: "yes" }, live).social, false, "only on and admin turn it on");
  assert.equal(uiFeatures(member, { POTONGIN_PERFORMANCE: "on" }, live).performance, true);
  assert.equal(uiFeatures(member, { POTONGIN_PERFORMANCE: "on" }, live).analytics, true);
  assert.equal(uiFeatures(member, { POTONGIN_SOCIAL: "on" }, live).analytics, true);
  assert.equal(uiFeatures(null, { POTONGIN_SOCIAL: "admin" }, live).social, false);
  // Admin needs the multi-user database (Fase 6): there is none yet.
  assert.equal(uiFeatures(admin, { POTONGIN_SOCIAL: "on" }, live).admin, false);
});

test("a flag never shows a link to a page that does not exist yet", async () => {
  const exists = async (href) => access(path.join(WEB, "app", href.slice(1), "page.jsx")).then(() => true, () => false);
  const env = { POTONGIN_SOCIAL: "on", POTONGIN_PERFORMANCE: "on" };
  const shown = navLinks("/dashboard", { role: "admin", features: uiFeatures({ role: "admin" }, env) });
  for (const entry of shown) assert.ok(await exists(entry.href), `${entry.href} is linked but has no page`);
  // Every link that is shown today is a real page; the flagged ones come with their phases.
  for (const entry of navLinks("/dashboard")) assert.ok(await exists(entry.href), entry.href);
});

test("shellUser: the env login's name and initials, as the single-user admin", () => {
  assert.deepEqual(shellUser({ APP_USERNAME: "andi" }), { displayName: "andi", initials: "AN", role: "admin" });
  assert.deepEqual(shellUser({ APP_USERNAME: "andi saputra" }), { displayName: "andi saputra", initials: "AS", role: "admin" });
  assert.equal(shellUser({ APP_USERNAME: "andi.saputra" }).initials, "AS");
  assert.equal(shellUser({ APP_USERNAME: "e2e-fakes" }).initials, "EF");
  assert.equal(shellUser({ APP_USERNAME: "a" }).initials, "A");
  assert.equal(shellUser({ APP_USERNAME: "  çağrı  " }).initials, "ÇA");
  assert.equal(shellUser({ APP_USERNAME: "_9" }).initials, "9");
  assert.deepEqual(shellUser({}), { displayName: "", initials: "", role: "admin" });
  assert.equal(shellUser({ APP_USERNAME: "x".repeat(200) }).displayName.length, 64, "a long name is cut for the sidebar");
});

test("the shell data is computed on the server and handed to client pages by their layouts", async () => {
  for (const file of ["app/dashboard/layout.jsx", "app/projects/layout.jsx", "app/settings/layout.jsx", "app/trends/layout.jsx"]) {
    const source = await readFile(path.join(WEB, file), "utf8");
    assert.match(source, /<ShellData \{\.\.\.shellData\(\)\}>/, file);
    assert.doesNotMatch(source, /^"use client"/, file);
  }
  for (const file of ["app/bantuan/page.jsx", "app/licenses/page.jsx"]) {
    const source = await readFile(path.join(WEB, file), "utf8");
    assert.match(source, /<AppShell (?:current="[^"]+" )?\{\.\.\.shellData\(\)\}>/, file);
  }
  const data = await readFile(path.join(WEB, "lib", "shell-data.mjs"), "utf8");
  assert.match(data, /uiFeatures\(user, env\)/);
});
