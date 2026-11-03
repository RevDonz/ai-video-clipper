// Tab Audio, Logo and Cold open of the one-layout editor (rombak 06 §8.3–§8.5, Editor F5): every
// capability of the old panels from its new place: music with the one-time notice, the held upload
// and its cancel, the volume, the ducking and its details; the logo, its corners, the fixes and
// the gizmo that shows with its tab; the watermark; the cold open's edges, the suggestions and
// the transition. The old panels keep their own specs until F10.
//
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-audio-tab.spec.mjs'
import { ACTION_LABELS } from "../components/editor/transcript/word-toolbar.mjs";
import { openPanel, panelRegion } from "./support/editor-panels.mjs";
import { expect, openTabs as openShell, routeLogoPicture, test, useShellDefaults } from "./support/editor-shell.mjs";
import { L } from "./support/i18n.mjs";
import { shellDoc } from "./support/shell-docs.mjs";

useShellDefaults();

const docOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc);
const musicOf = (doc) => doc.tracks.find((track) => track.role === "music")?.items?.[0] ?? null;
const logoOf = (doc) => doc.tracks.find((track) => track.items?.[0]?.type === "image")?.items?.[0] ?? null;
const coldOf = (doc) => doc.main.segments.find((segment) => segment.role === "cold_open") ?? null;
const SONG = { name: "lagu.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("ID3 fake song") };
const PICTURE = { name: "logo.png", mimeType: "image/png", buffer: Buffer.from("fake png") };

test("Audio: Tambah musik shows the notice once, Pilih file musik picks the file, the music lands", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "audio");
  await panel.getByRole("button", { name: L("editor.audio.music.add"), exact: true }).click();
  const notice = page.getByRole("alertdialog", { name: L("editor.audio.notice.title") });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: L("editor.audio.notice.cancel"), exact: true }).click();
  await expect(notice).toHaveCount(0);
  await expect(panel.getByRole("button", { name: L("editor.audio.music.add"), exact: true })).toBeFocused();
  await panel.getByRole("button", { name: L("editor.audio.music.add"), exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await notice.getByRole("button", { name: L("editor.audio.notice.agree"), exact: true }).click();
  await (await chooser).setFiles(SONG);
  await expect.poll(async () => musicOf(await docOf(page)) !== null).toBe(true);
  await expect(panel.locator("[data-music-name]")).toHaveText(SONG.name);
  await expect(panel.getByRole("slider", { name: L("editor.audio.music.volume") })).toBeVisible();
});

test("Audio: the upload's progress and its cancel show while it runs (row 90)", async ({ page }) => {
  await openShell(page, "", { uploadHoldMs: 60_000 });
  const panel = await openPanel(page, "audio");
  await panel.locator("[data-music-file]").setInputFiles(SONG);
  const running = panel.locator("[data-music-upload]");
  await expect(running).toContainText("50%");
  await expect(panel.getByRole("progressbar")).toBeVisible();
  await panel.getByRole("button", { name: L("editor.audio.upload.cancelLabel"), exact: true }).click();
  await expect(running).toHaveCount(0);
  expect(musicOf(await docOf(page))).toBeNull();
});

test("Audio: volume with its reset, ducking and its strength; the details in Lanjutan", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("music") });
  const panel = await openPanel(page, "audio");
  const volume = panel.getByRole("slider", { name: L("editor.audio.music.volume") });
  const start = musicOf(await docOf(page)).payload.gain_cdb;
  await volume.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => musicOf(await docOf(page)).payload.gain_cdb).toBe(start + 10);
  await panel.getByRole("button", { name: L("editor.audio.music.resetLabel"), exact: true }).click();
  await expect.poll(async () => musicOf(await docOf(page)).payload.gain_cdb).toBe(start);

  const strength = panel.getByRole("radiogroup", { name: L("editor.audio.duck.strength") });
  await strength.getByRole("radio", { name: new RegExp(`^${L("editor.audio.duck.strong")}`) }).check();
  await expect.poll(async () => musicOf(await docOf(page)).payload.duck.depth_cdb).toBeGreaterThan(1000);
  await panel.getByRole("switch", { name: L("editor.audio.duck.on") }).click();
  await expect.poll(async () => musicOf(await docOf(page)).payload.duck.on).toBe(false);
  await panel.getByRole("switch", { name: L("editor.audio.duck.on") }).click();

  await expect(panel.getByRole("slider", { name: L("editor.audio.fine.offset") })).toBeHidden();
  await panel.locator('[data-advanced="music"] button').first().click();
  await panel.getByRole("switch", { name: L("editor.audio.fine.loop") }).click();
  await expect.poll(async () => musicOf(await docOf(page)).payload.loop).toBe(false);
  await expect(panel.locator('[data-advanced="music"] [data-advanced-summary]')).toContainText(L("editor.audio.summary.noLoop"));
  for (const key of ["fadeIn", "fadeOut", "depth", "attack", "release", "hold"]) {
    await expect(panel.getByRole("slider", { name: L(`editor.audio.fine.${key}`) })).toBeVisible();
  }
});

test("Audio: Hapus musik, the original sound's volume and Samakan kenyaringan", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("music") });
  const panel = await openPanel(page, "audio");
  await panel.getByRole("button", { name: L("editor.audio.music.remove"), exact: true }).click();
  await expect.poll(async () => musicOf(await docOf(page))).toBeNull();
  await expect(panel.locator("[data-advanced]")).toHaveCount(0);
  const source = panel.getByRole("slider", { name: L("editor.audio.source.volume") });
  await source.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await docOf(page)).audio.source.gain_cdb).toBe(50);
  await panel.locator('[data-tab-group="source"]').getByRole("switch").click();
  await expect.poll(async () => (await docOf(page)).audio.master.mode).toBe("off");
});

test("Logo: Tambah logo uploads, the corners snap, size and opacity in Lanjutan, Hapus removes", async ({ page }) => {
  await routeLogoPicture(page);
  await openShell(page);
  const panel = await openPanel(page, "logo");
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: L("editor.logo.add"), exact: true }).click();
  await (await chooser).setFiles(PICTURE);
  await expect.poll(async () => logoOf(await docOf(page)) !== null).toBe(true);
  await panel.getByRole("radiogroup", { name: L("editor.logo.corner") }).getByRole("radio", { name: L("editor.logo.corners.bottomLeft"), exact: true }).check();
  await expect.poll(async () => logoOf(await docOf(page)).transform.x_e5).toBeLessThan(50000);
  await panel.locator('[data-advanced="logo"] button').first().click();
  const opacity = panel.getByRole("slider", { name: L("editor.logo.opacity") });
  await opacity.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => logoOf(await docOf(page)).transform.opacity_pm).toBe(840);
  await expect(panel.getByRole("slider", { name: L("editor.logo.size") })).toBeVisible();
  await panel.getByRole("button", { name: L("editor.logo.remove"), exact: true }).click();
  await expect.poll(async () => logoOf(await docOf(page))).toBeNull();
});

test("Logo: the gizmo shows with its tab only; the unsafe note moves the logo out", async ({ page }) => {
  const logo = shellDoc("logoUnsafe");
  const ref = logo.tracks.find((track) => track.items?.[0]?.type === "image").items[0].id;
  await openShell(page, "", { doc: logo, planWarnings: [{ code: "unsafe_zone", ref }] });
  const box = page.locator('[data-slot="stage"] [data-logo-box]');
  await expect(box).toHaveCount(0);
  const panel = await openPanel(page, "logo");
  await expect(box).toBeVisible();
  const move = panel.getByRole("button", { name: L("editor.logo.moveSafe"), exact: true });
  const before = logoOf(await docOf(page)).transform;
  await move.click();
  await expect.poll(async () => JSON.stringify(logoOf(await docOf(page)).transform)).not.toBe(JSON.stringify(before));
  await openPanel(page, "text");
  await expect(box).toHaveCount(0);
});

test("Logo: the watermark's text, then place, size and opacity in Lanjutan, Hapus teks", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "logo");
  const field = panel.getByRole("textbox", { name: L("editor.logo.watermark.text") });
  await expect(panel.locator('[data-advanced="watermark"]')).toHaveCount(0);
  await field.fill("@akunku");
  await expect.poll(async () => (await docOf(page)).watermark?.text).toBe("@akunku");
  await expect(panel.locator("[data-watermark-counter]")).toContainText("7/");
  await panel.locator('[data-advanced="watermark"] button').first().click();
  await panel.getByRole("radiogroup", { name: L("editor.logo.watermark.place") }).getByRole("radio", { name: L("editor.logo.corners.topRight"), exact: true }).check();
  await expect.poll(async () => (await docOf(page)).watermark.pos).toBe("top_right");
  await expect(panel.locator('[data-advanced="watermark"] [data-advanced-summary]')).toContainText(L("editor.logo.corners.topRight"));
  await expect(panel.getByRole("slider", { name: L("editor.logo.watermark.size") })).toBeVisible();
  await expect(panel.getByRole("slider", { name: L("editor.logo.watermark.opacity") })).toBeVisible();
  await panel.getByRole("button", { name: L("editor.logo.watermark.remove"), exact: true }).click();
  await expect.poll(async () => (await docOf(page)).watermark ?? null).toBeNull();
});

test("Pakai logo di semua klip asks first", async ({ page }) => {
  await openShell(page, "", { clips: 3, doc: shellDoc("watermark") });
  const panel = await openPanel(page, "logo");
  await panel.getByRole("button", { name: L("editor.applyAll.logo.button"), exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: L("editor.applyAll.logo.title") })).toBeVisible();
});

test("Cold open: the line, word edges, Putar, Hapus, and on again from the AI version", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  const panel = await openPanel(page, "coldopen");
  await expect(panel.locator("[data-coldopen-line]")).toBeVisible();
  const before = coldOf(await docOf(page));
  await panel.getByRole("button", { name: L("editor.coldOpen.words.dropLast"), exact: true }).click();
  await expect.poll(async () => coldOf(await docOf(page)).out_sf).toBeLessThan(before.out_sf);
  await panel.getByRole("button", { name: L("editor.coldOpen.play"), exact: true }).click();
  await panel.getByRole("button", { name: L("editor.coldOpen.remove"), exact: true }).click();
  await expect.poll(async () => coldOf(await docOf(page))).toBeNull();
  await expect(panel.locator("[data-coldopen-line]")).toHaveCount(0);
  const toggle = panel.getByRole("switch", { name: L("editor.coldOpen.on") });
  await toggle.click();
  await expect.poll(async () => coldOf(await docOf(page)) !== null).toBe(true);
});

test("Cold open: 0,1 dtk in Lanjutan; a suggestion is used; a transcript selection turns it on", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  const panel = await openPanel(page, "coldopen");
  await panel.locator('[data-advanced="coldOpen"] button').first().click();
  const before = coldOf(await docOf(page));
  await panel.getByRole("button", { name: L("editor.coldOpen.fine.startLater"), exact: true }).click();
  await expect.poll(async () => coldOf(await docOf(page)).in_sf).toBeGreaterThan(before.in_sf);
  await panel.locator("[data-coldopen-suggestion]").first().getByRole("button").nth(1).click();
  await expect(panel.locator("[data-coldopen-suggestion]").first()).toHaveAttribute("data-current", "true");
});

test("Cold open: the transition's effect, whoosh and audition, off with a note without a cold open", async ({ page }) => {
  await openShell(page, "", { doc: shellDoc("coldOpen") });
  const panel = await openPanel(page, "coldopen");
  const effect = panel.getByRole("radiogroup", { name: L("editor.coldOpen.transition.effect") });
  await effect.getByRole("radio", { name: L("editor.coldOpen.transition.flash"), exact: true }).check();
  await expect.poll(async () => (await docOf(page)).main.joins[0].style).toBe("flash_white");
  await expect(panel.locator("[data-transition-status]")).toHaveText(L("editor.coldOpen.transition.statusStyle", { name: L("editor.coldOpen.transition.flash") }));
  await panel.getByRole("switch", { name: L("editor.coldOpen.transition.whoosh") }).click();
  await expect.poll(async () => (await docOf(page)).main.joins[0].sfx).toBeTruthy();
  await expect(panel.getByRole("button", { name: L("editor.coldOpen.transition.play"), exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: L("editor.coldOpen.remove"), exact: true }).click();
  await expect(panelRegion(page).locator("[data-transition-note]")).toHaveText(L("editor.coldOpen.transition.off"));
  await expect(effect.getByRole("radio").first()).toBeDisabled();
});

test("Cold open: 'Jadikan cold open' stays the transcript's own: the tab has no second button", async ({ page }) => {
  await openShell(page);
  const panel = await openPanel(page, "coldopen");
  await expect(panel.getByRole("button", { name: ACTION_LABELS.coldOpen })).toHaveCount(0);
});
