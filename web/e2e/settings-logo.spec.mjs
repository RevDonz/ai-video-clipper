// Pengaturan → Tampilan → Logo (docs/editor/CONTRACTS.md §5.36). /api/settings/logo and the image are
// faked in the browser (page.route), so nothing on the server changes; the AI form keeps talking
// to the server.
import { expect } from "@playwright/test";
import zlib from "node:zlib";

import { expectFailedRequest, skipWithoutCredentials, test } from "./support/harness.mjs";
import { openSettingsTab } from "./support/settings.mjs";

const SHA = "5c".repeat(32);
const LOGO = {
  sha256: SHA, kind: "logo", mime: "image/png", w: 300, h: 100, durationMs: null, lufsC: null,
  name: "Logo Toko.png", peaksUrl: null, url: `/api/settings/logo/${SHA}`, updatedAtMs: 1_790_000_000_000,
};

function chunk(kind, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(kind, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(kind, "latin1"), body])) >>> 0, 8 + body.length);
  return out;
}

function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(4 * width, 0xcc)]);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Fakes the settings logo API: GET answers `state`, POST and DELETE change it. */
async function fakeLogo(page, state, { post = { status: 201, body: LOGO } } = {}) {
  const seen = { posts: [], deletes: 0, gets: 0 };
  await page.route("**/api/settings/logo", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      seen.posts.push(route.request().headers());
      if (post.status < 300) state.logo = post.body;
      return route.fulfill({ status: post.status, contentType: "application/json", body: JSON.stringify(post.body) });
    }
    if (method === "DELETE") {
      seen.deletes += 1;
      state.logo = null;
    } else {
      seen.gets += 1;
    }
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify(state) });
  });
  await page.route(`**/api/settings/logo/${SHA}`, (route) => route.fulfill({ status: 200, contentType: "image/png", body: png(300, 100) }));
  return seen;
}

const card = (page) => page.getByRole("region", { name: "Logo", exact: true });

test.describe("Logo bawaan", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("upload, see, replace and remove the logo", async ({ page }) => {
    const seen = await fakeLogo(page, { logo: null, enabled: true, autoClips: false });
    await openSettingsTab(page, "appearance");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByText("Belum ada logo")).toBeVisible();
    await expect(section).toContainText("File klip otomatis tetap tanpa logo");
    await section.locator('input[type="file"]').setInputFiles({ name: "Logo Toko.png", mimeType: "image/png", buffer: png(300, 100) });
    await expect(section.getByRole("status")).toHaveText("Logo bawaan tersimpan.");
    await expect(section.getByRole("img", { name: "Pratinjau logo bawaan" })).toBeVisible();
    await expect(section).toContainText("Logo Toko.png");
    await expect(section).toContainText("300 × 100 px");
    expect(seen.posts).toHaveLength(1);
    expect(seen.posts[0]["x-asset-kind"]).toBe("logo");
    expect(seen.posts[0]["content-type"]).toBe("image/png");
    await expect(section.getByRole("button", { name: "Ganti logo" })).toBeEnabled();
    const remove = section.getByRole("button", { name: "Hapus" });
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect(section.getByText("Belum ada logo")).toBeVisible();
    expect(seen.deletes).toBe(1);
  });

  test("a file the editor would refuse is refused before it is sent", async ({ page }) => {
    const seen = await fakeLogo(page, { logo: null, enabled: true, autoClips: false });
    await openSettingsTab(page, "appearance");
    const section = card(page);
    await section.locator('input[type="file"]').setInputFiles({ name: "logo.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
    await expect(section.getByRole("alert")).toHaveText("Format ini tidak didukung. Pakai PNG, JPEG, atau WebP.");
    expect(seen.posts).toHaveLength(0);
  });

  test("with automatic clips on the editor's engine the copy says the clips carry it", async ({ page }) => {
    await fakeLogo(page, { logo: LOGO, enabled: true, autoClips: true });
    await openSettingsTab(page, "appearance");
    await expect(card(page)).toContainText("Ikut di file klip otomatis");
    await expect(card(page)).not.toContainText("tanpa logo");
  });

  test("with uploads off the card says so and keeps the logo removable", async ({ page }) => {
    await fakeLogo(page, { logo: LOGO, enabled: false, autoClips: false });
    await openSettingsTab(page, "appearance");
    const section = card(page);
    await expect(section).toContainText("Unggah logo belum diaktifkan di server ini.");
    await expect(section.getByRole("button", { name: "Ganti logo" })).toBeDisabled();
    await expect(section.getByRole("button", { name: "Hapus" })).toBeEnabled();
  });
});

test.describe("Logo bawaan after a failed load", () => {
  test.beforeEach(() => skipWithoutCredentials(test));

  test("says so, and Coba lagi loads the card", async ({ page }) => {
    expectFailedRequest(page, 503, "GET", "/api/settings/logo"); // the first load fails on purpose
    let calls = 0;
    await page.route("**/api/settings/logo", (route) => {
      calls += 1;
      const body = calls === 1 ? { error: "x", code: "settings_unavailable" } : { logo: null, enabled: true, autoClips: false };
      return route.fulfill({ status: calls === 1 ? 503 : 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await openSettingsTab(page, "appearance");
    const section = card(page);
    await expect(section.getByRole("alert")).toHaveText(/Logo bawaan tidak bisa dimuat\./);
    await section.getByRole("button", { name: "Coba lagi" }).click();
    await expect(section.getByText("Belum ada logo")).toBeVisible();
    expect(calls).toBe(2);
  });
});

test.describe("Logo bawaan at 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test.beforeEach(() => skipWithoutCredentials(test));

  test("fits the phone: no horizontal scroll, buttons at least 44 px tall", async ({ page }) => {
    await fakeLogo(page, { logo: { ...LOGO, name: `${"logo-toko-panjang-".repeat(4)}.png` }, enabled: true, autoClips: false });
    await openSettingsTab(page, "appearance");
    const section = card(page);
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole("button", { name: "Hapus" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    for (const box of await section.getByRole("button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.right).toBeLessThanOrEqual(390);
    }
  });
});
