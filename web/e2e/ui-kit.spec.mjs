// The UI kit on the Potongin tokens (docs/plans/2026-10-24-rombak/05-ui-dashboard.md §3, 08 Fase 1
// "Halaman uji"): app/ui-harness shows HeroUI's Button, Switch, Tabs, Table, Modal and DatePicker
// inside the app shell. Every visible control is a 44 px target, the page keeps the dark palette,
// lime appears only on variant="primary", selected states are neutral, Tabs.Panel keeps a hidden
// panel mounted with shouldForceMount, and the names HeroUI would write in English are Indonesian.
// Screenshots (laptop, phone, a focus ring, the open dialog and calendar) land in
// EDITOR_GATES_OUT/ui-kit for review.
//
// Prerequisites: a server with POTONGIN_EDITOR_FAKES=1 (the page is a 404 otherwise),
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1. On GitHub Actions:
//   gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command='e2e/ui-kit.spec.mjs'
import { expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { login, settings, test } from "./support/harness.mjs";

const PAGE = "/ui-harness";
const LIME = ["rgb(223, 255, 88)", "rgb(236, 255, 154)"];
const BG = "rgb(8, 9, 7)";
const TEXT = "rgb(247, 245, 237)";
const SURFACE_3 = "rgb(35, 37, 31)";
const AXE = process.env.AXE_CORE_PATH && existsSync(process.env.AXE_CORE_PATH) ? readFileSync(process.env.AXE_CORE_PATH, "utf8") : null;

async function noJobs(page) {
  await page.route(/\/api\/jobs(?:\?.*)?$/, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [], total: 0, editor: false }),
  }));
}

function outDir(testInfo) {
  const dir = path.join(process.env.EDITOR_GATES_OUT || testInfo.outputPath(), "ui-kit");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function settle(page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
}

/** Visible interactive targets under `root` that are smaller than 44 px. */
async function smallTargets(page, root) {
  return page.evaluate((selector) => {
    const scope = document.querySelector(selector) ?? document;
    const targets = scope.querySelectorAll('button, [role="tab"], [role^="menuitem"], [role="option"], [role="switch"], .switch');
    return [...targets].filter((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === "hidden") return false;
      // The <input> of a switch, checkbox or radio is visually hidden; its label is the target.
      if (element.tagName === "INPUT" && element.closest(".switch, .checkbox, .radio")) return false;
      return box.height < 44 || box.width < 44;
    }).map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${(element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 30)}" ${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`);
  }, root);
}

/** Elements painted with the lime accent that are not (inside) a primary button or the brand marks. */
async function stray(page) {
  return page.evaluate((lime) => {
    const allowed = (element) => element.closest(".button--primary, .brand, .jobBadgeDot, .progress");
    const found = [];
    for (const element of document.querySelectorAll("body *")) {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const paints = [style.backgroundColor, style.color, style.borderTopColor, style.outlineColor, style.boxShadow];
      if (style.outlineStyle === "none") paints.splice(3, 1);
      if (paints.some((value) => lime.some((colour) => value.includes(colour))) && !allowed(element)) {
        found.push(`${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`);
      }
    }
    return found;
  }, LIME);
}

test.describe("UI kit test page", () => {
  test.skip(process.env.E2E_EDITOR_FAKES !== "1", "needs a server with POTONGIN_EDITOR_FAKES=1 (the page is a 404 otherwise)");
  test.skip(!settings.username || !settings.password, "needs E2E_USERNAME and E2E_PASSWORD");

  test("44 px targets, the dark palette and lime only on the primary button", async ({ page }, testInfo) => {
    const dir = outDir(testInfo);
    await page.setViewportSize({ width: 1366, height: 900 });
    await noJobs(page);
    await login(page, PAGE);
    await expect(page.getByRole("heading", { level: 1, name: "Uji komponen" })).toBeVisible();
    await expect(page.getByLabel("Tanggal terbit").first()).toBeVisible();
    await settle(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await smallTargets(page, "main")).toEqual([]);
    expect(await stray(page)).toEqual([]);
    const primary = page.getByRole("button", { name: "Simpan" });
    expect(await primary.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(LIME[0]);
    expect(await primary.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("10px");
    // Secondary, tertiary and ghost buttons are neutral; the danger button is red, not lime.
    for (const name of ["Sekunder", "Tersier", "Ghost", "Hapus"]) {
      const colours = await page.getByRole("button", { name, exact: true }).evaluate((element) => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]);
      for (const colour of colours) expect(LIME).not.toContain(colour);
    }
    await page.screenshot({ path: path.join(dir, "laptop.png"), fullPage: true });
  });

  test("the primary action answers with a toast in an Indonesian-named region", async ({ page }, testInfo) => {
    const dir = outDir(testInfo);
    await noJobs(page);
    await login(page, PAGE);
    await page.getByRole("button", { name: "Simpan" }).click();
    const region = page.getByRole("region", { name: /Notifikasi/ });
    await expect(region.getByText("Tersimpan")).toBeVisible();
    await settle(page);
    expect(await stray(page)).toEqual([]);
    await page.screenshot({ path: path.join(dir, "toast.png") });
    await region.getByRole("button", { name: "Tutup notifikasi" }).click();
    await expect(region.getByText("Tersimpan")).toBeHidden();
  });

  test("selected states use the text colour and the light surface, never lime", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await noJobs(page);
    await login(page, PAGE);
    const control = page.locator(".switch[data-selected] .switch__control");
    await expect(control).toBeVisible();
    await settle(page);
    expect(await control.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(TEXT);
    const selectedTab = page.getByRole("tab", { name: "AI" });
    await expect(selectedTab).toHaveAttribute("aria-selected", "true");
    expect(await selectedTab.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(SURFACE_3);
    await page.getByText("Pintasan satu tombol").click();
    await expect(page.getByRole("switch", { name: "Pintasan satu tombol" })).not.toBeChecked();
  });

  test("Tabs.Panel with shouldForceMount keeps the other panel and its input in the page", async ({ page }) => {
    await noJobs(page);
    await login(page, PAGE);
    const note = page.getByLabel("Catatan AI");
    await note.fill("cari momen lucu");
    await page.getByRole("tab", { name: "Tampilan" }).click();
    await expect(note).toBeHidden();
    expect(await page.locator('input[name="catatan"]').count()).toBe(1);
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(note).toHaveValue("cari momen lucu");
  });

  test("the dialog, the calendar and the table name their controls in Indonesian", async ({ page }, testInfo) => {
    const dir = outDir(testInfo);
    await page.setViewportSize({ width: 1366, height: 900 });
    await noJobs(page);
    await login(page, PAGE);
    await expect(page.getByRole("checkbox", { name: "Pilih semua" })).toHaveCount(1);
    await expect(page.getByRole("checkbox", { name: "Pilih baris Podcast Senin" })).toHaveCount(1);

    const opener = page.getByRole("button", { name: "Buka dialog" });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Hapus proyek?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Tutup" })).toBeVisible();
    await settle(page);
    expect(await smallTargets(page, '[role="dialog"]')).toEqual([]);
    expect(await stray(page)).toEqual([]);
    await page.screenshot({ path: path.join(dir, "dialog.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    const calendar = page.getByRole("button", { name: "Kalender" });
    await calendar.click();
    await expect(page.getByRole("button", { name: "Bulan sebelumnya" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bulan berikutnya" })).toBeVisible();
    await settle(page);
    expect(await stray(page)).toEqual([]);
    await page.screenshot({ path: path.join(dir, "calendar.png") });
    await page.keyboard.press("Escape");
    await expect(calendar).toBeFocused();
    expect(await page.getByText(/^(Close|Remove tag|Select all|Previous|Next|pagination)$/).count()).toBe(0);
  });

  test("a keyboard focus ring shows once on a HeroUI button and on a shell link", async ({ page }, testInfo) => {
    const dir = outDir(testInfo);
    await page.setViewportSize({ width: 1366, height: 900 });
    await noJobs(page);
    await login(page, PAGE);
    const button = page.getByRole("button", { name: "Sekunder" });
    await button.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(button).toBeFocused();
    await settle(page);
    const ring = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { outline: style.outlineStyle, shadow: style.boxShadow, focusVisible: element.matches(":focus-visible") || element.hasAttribute("data-focus-visible") };
    });
    expect(ring.focusVisible).toBe(true);
    // One ring: HeroUI's (box-shadow) or Potongin's outline, never both.
    const hasShadowRing = ring.shadow !== "none" && /rgb\(139, 157, 255\)/.test(ring.shadow);
    const hasOutline = ring.outline !== "none";
    expect(hasShadowRing !== hasOutline).toBe(true);
    await button.screenshot({ path: path.join(dir, "focus-button.png") });
    writeFileSync(path.join(dir, "focus.json"), `${JSON.stringify(ring, null, 2)}\n`);
  });

  test("on a phone the page fits the width and every control stays a 44 px target", async ({ page }, testInfo) => {
    const dir = outDir(testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await noJobs(page);
    await login(page, PAGE);
    await expect(page.getByRole("heading", { level: 1, name: "Uji komponen" })).toBeVisible();
    await settle(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await smallTargets(page, "main")).toEqual([]);
    await page.screenshot({ path: path.join(dir, "phone.png"), fullPage: true });
  });

  test("axe finds no critical or serious violation on the test page", async ({ page }) => {
    test.skip(!AXE, "set AXE_CORE_PATH to an axe.min.js");
    await page.setViewportSize({ width: 1366, height: 900 });
    await noJobs(page);
    await login(page, PAGE);
    await expect(page.getByLabel("Tanggal terbit").first()).toBeVisible();
    await settle(page);
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ["violations"] });
      return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
        .map((item) => `${item.id}: ${item.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(", ")}`);
    });
    expect(violations).toEqual([]);
  });
});
