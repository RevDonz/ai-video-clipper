import { readFileSync } from "node:fs";

import { expect } from "@playwright/test";

import { LOCALES } from "../lib/i18n/locales.mjs";
import { login, settings, skipWithoutCredentials, test } from "./support/harness.mjs";
import { L, projectLocale } from "./support/i18n.mjs";

// Accessible names come from the catalog (05-ui-dashboard.md §7.1 A11, A4): in Indonesian no
// control is named in English the way HeroUI and React Aria would name it ("Close", "Next" …);
// in English the shell names nothing in Indonesian. The shell is read open and closed: the
// sidebar, the account menu, and on a phone the Menu drawer. The pages' own copy moves to the
// catalog screen by screen (Fase 2, 3), so in English only the shell is held to it for now.

// What HeroUI and React Aria write themselves (A11); glossary words (Hook, Cold open, Logo,
// Audio) are the same in both languages and never listed.
const ENGLISH_DEFAULTS = /\b(?:Close|Clear search|Dismiss|Select all|Select row|Previous|Next|Calendar|Remove|Loading|Notifications|Main menu|Skip to content)\b/;

const catalog = (locale, name) => JSON.parse(readFileSync(new URL(`../messages/${locale}/${name}.json`, import.meta.url), "utf8"));
function strings(node, prefix = "", out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") out.set(`${prefix}${key}`, value);
    else if (value && typeof value === "object") strings(value, `${prefix}${key}.`, out);
  }
  return out;
}
// The Indonesian words of the shell and aria catalogs that English says differently: none of
// them may name anything in the English shell.
function indonesianWords() {
  const words = new Set();
  for (const name of ["shell", "aria"]) {
    const id = strings(catalog("id", name));
    const en = strings(catalog("en", name));
    for (const [key, text] of id) {
      if (en.get(key) === text) continue;
      for (const part of text.split(/\{[^}]*\}/)) {
        const phrase = part.replace(/[·:]/g, " ").trim();
        if (phrase && /\p{L}/u.test(phrase)) words.add(phrase);
      }
    }
  }
  return [...words];
}

// "- button "Tutup"" lines of Playwright's aria snapshot: [role, name].
function names(snapshot) {
  return [...snapshot.matchAll(/^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/gm)].map((match) => [match[1], match[2].replace(/\\"/g, "\"")]);
}

// The language picker names each language in itself ("Bahasa Indonesia", "English"; 07 §9.1):
// those names are the same in every UI language and are not copy to translate.
const ENDONYMS = new Set(LOCALES.map((entry) => entry.label));

function problems(all, locale) {
  const entries = all.filter(([, name]) => !ENDONYMS.has(name));
  if (locale === "en") {
    const words = indonesianWords();
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return entries.filter(([, name]) => words.some((word) => new RegExp(`(?:^|[^\\p{L}])${escape(word)}(?:$|[^\\p{L}])`, "u").test(name)))
      .map(([role, name]) => `${role} "${name}"`);
  }
  return entries.filter(([, name]) => ENGLISH_DEFAULTS.test(name)).map(([role, name]) => `${role} "${name}"`);
}

async function noJobs(page) {
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
  }));
}

const account = (scope) => scope.getByRole("button", { name: L("shell.account.named", { name: settings.username }), exact: true });

test.describe("Accessible names in the UI language", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("laptop: the sidebar and the account menu", async ({ page }) => {
    const locale = projectLocale();
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await login(page, "/bantuan");
    const side = page.locator("header.appSide");
    const found = names(await side.ariaSnapshot());
    expect(found.length).toBeGreaterThanOrEqual(7);
    expect(found).toContainEqual(["navigation", L("aria.mainMenu")]);
    await account(page).click();
    const menu = names(await page.getByRole("menu").ariaSnapshot());
    expect(menu).toContainEqual(["menuitemcheckbox", L("shell.account.shortcuts")]);
    expect(menu).toContainEqual(["menuitem", L("shell.account.logout")]);
    expect(problems([...found, ...menu], locale)).toEqual([]);
  });

  test("phone: the Menu drawer, its close button and the account menu inside it", async ({ page }) => {
    const locale = projectLocale();
    await page.setViewportSize({ width: 390, height: 844 });
    await noJobs(page);
    await login(page, "/bantuan");
    const bar = names(await page.locator("header.appSide").ariaSnapshot());
    await page.getByRole("button", { name: L("shell.menu"), exact: true }).click();
    const drawer = page.getByRole("dialog", { name: L("shell.menu") });
    await expect(drawer).toBeVisible();
    const inside = names(await drawer.ariaSnapshot());
    expect(inside).toContainEqual(["button", L("aria.close")]);
    await account(drawer).click();
    const menu = names(await page.getByRole("menu").ariaSnapshot());
    expect(problems([...bar, ...inside, ...menu], locale)).toEqual([]);
  });

  test("Indonesian: no English default names anywhere on the help page and the login, one h1 and no skipped heading", async ({ page }) => {
    test.skip(projectLocale() !== "id", "the pages' own copy is Indonesian until their screens move to the catalog");
    await page.setViewportSize({ width: 1280, height: 800 });
    await noJobs(page);
    await page.goto("/login");
    expect(problems(names(await page.locator("body").ariaSnapshot()), "id")).toEqual([]);
    await login(page, "/bantuan");
    expect(problems(names(await page.locator("body").ariaSnapshot()), "id")).toEqual([]);
    // A4: one h1, and every heading at most one level below the one before it.
    const levels = await page.evaluate(() => [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => Number(element.tagName.slice(1))));
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    const jumps = levels.slice(1).map((level, index) => [levels[index], level]).filter(([before, level]) => level > before + 1);
    expect(jumps).toEqual([]);
  });
});
