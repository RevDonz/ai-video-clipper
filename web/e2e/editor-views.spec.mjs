// The editor's two views (docs/plans/2026-10-02-editor-mode-cepat.md §1, §4, §5, §9.4) on the
// editor fakes: the default and the remembered view (AC1), one editor under both (AC2), deep links
// (AC3), the keyboard (AC4), the top bar, the stage overlays, the removed texts (AC11), lime only on
// Ekspor (AC12), and the shell's targets, focus and axe (AC13). The cards' contents are task B's
// (editor-quick.spec.mjs), the rail and the scrubber task D's.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1; AXE_CORE_PATH=<axe.min.js> for the axe checks.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-views.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { CARD_IDS, PANEL_IDS, VIEW_KEY } from "../lib/editor/view-mode.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { openChecks, openShortcutHelp, resetToAi, safeZone, switchView } from "./support/editor-topbar.mjs";
import { login, settings } from "./support/harness.mjs";

const BASE = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const CARD_LABELS = ["Hook", "Caption", "Teks caption", "Cold open", "Tata letak", "Logo & Musik"];
const PANEL_TABS = ["Transkrip", "Teks", "Cold open", "Tata letak", "Logo", "Musik"];
const LEGACY_HELP = "Klip ini belum diubah, jadi ekspor memakai file klip otomatis apa adanya. File itu dibuat sebelum editor "
  + "dibuka, jadi bisa sedikit berbeda dari pratinjau ini (misalnya posisi video, warna teks). Setelah Anda mengubah apa "
  + "saja, hasil ekspor sama dengan pratinjau ini.";

// A document with a cold open, so the Transisi section of the Cold open panel is on.
const COLD_OPEN_DOC = applyCommand(fakeDoc(), "SetColdOpen", { firstWord: "w048127", lastWord: "w048132" },
  createContext({ words: fakeWords(), seed: fakeDoc() })).doc;

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  if (explicit && existsSync(explicit)) return readFileSync(explicit, "utf8");
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();
const AXE = axeSource();

const test = base.extend({
  workerStorageState: [async ({ browser }, use) => {
    const context = await browser.newContext({ baseURL: settings.baseURL });
    const page = await context.newPage();
    await login(page, "/projects");
    const state = await context.storageState();
    await context.close();
    await use(state);
  }, { scope: "worker" }],
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
  page: async ({ page }, use, testInfo) => {
    const failures = { console: [], page: [], requests: [] };
    page.on("console", (message) => { if (message.type() === "error") failures.console.push(message.text()); });
    page.on("pageerror", (error) => failures.page.push(error.stack || error.message));
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText || "failed";
      const benign = reason === "net::ERR_ABORTED" && ["media", "other", "document"].includes(request.resourceType());
      if (!benign) failures.requests.push(`${request.method()} ${request.url()} ${reason}`);
    });
    await use(page);
    const count = Object.values(failures).reduce((total, list) => total + list.length, 0);
    if (count) {
      if (testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${JSON.stringify(failures, null, 2)}`);
      process.stderr.write(`Browser diagnostics for ${testInfo.title}:\n${JSON.stringify(failures, null, 2)}\n`);
    }
  },
});

test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1366, height: 650 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

// Browser-side hooks of the fake runtime (window.__potonginEditorScenario), serialised by
// addInitScript: a counter of created players, extra plan warnings, a legacy auto file, a document.
function installViewsScenario(config) {
  window.__playersCreated = 0;
  let loadedSha = null;
  window.__potonginEditorScenario = {
    api(api, fakes) {
      return config.doc ? fakes.createFakeApiClient({ doc: config.doc }) : api;
    },
    previewClient(client) {
      return {
        ...client,
        async plan(doc) {
          const dto = await client.plan(doc);
          if (config.planWarnings) dto.warnings = config.planWarnings;
          if (config.legacyAuto) {
            loadedSha ??= dto.planSha256;
            dto.rev0 = { planSha256: loadedSha, autoRenderUrl: config.autoRenderUrl, exact: false };
          }
          return dto;
        },
      };
    },
    player(player) {
      window.__playersCreated += 1;
      return player;
    },
  };
}

async function openEditor(page, target, config = null) {
  if (config) await page.addInitScript(installViewsScenario, config);
  await page.goto(target);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

const root = (page) => page.locator("[data-editor-root]");
const cards = (page) => page.getByRole("complementary", { name: "Pengaturan klip" });
const header = (page, id) => page.locator(`#card-${id}-button`);
const viewRadio = (page, name) => page.getByRole("radiogroup", { name: "Tampilan editor" }).getByRole("radio", { name, exact: true });
const editorState = (page) => page.evaluate(() => {
  const state = window.__potonginEditor.store.getState();
  return { doc: state.doc, canUndo: state.canUndo, canRedo: state.canRedo, commands: state.commands ?? [] };
});
const storedView = (page) => page.evaluate((key) => window.localStorage.getItem(key), VIEW_KEY);
const playerFrame = (page) => page.evaluate(() => window.__potonginEditor.player.frame());
// Play / pause of the bottom region (panels have "Putar" buttons of their own).
const playButton = (page, name) => page.locator('[data-slot="bottom"]').getByRole("button", { name, exact: true });

// ---------------------------------------------------------------------------------------------
// AC1: the default view and the preference

test("AC1: a fresh profile opens Mode Cepat with the Caption card open, no tabs and no timeline", async ({ page }) => {
  await openEditor(page, BASE);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(viewRadio(page, "Cepat")).toBeChecked();
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator('[data-slot="timeline"]')).toHaveCount(0);
  expect(await storedView(page)).toBeNull();
  expect(new URL(page.url()).search, "opening never rewrites the address").toBe("");
});

test("AC1: a switch to Lengkap is remembered across a reload; a deep link wins and never writes it", async ({ page }) => {
  await openEditor(page, BASE);
  await switchView(page, "lengkap");
  expect(await storedView(page)).toBe("lengkap");
  expect(new URL(page.url()).searchParams.get("mode")).toBe("lengkap");
  await openEditor(page, BASE);
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await openEditor(page, `${BASE}?card=hook`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(header(page, "hook")).toHaveAttribute("aria-expanded", "true");
  expect(await storedView(page), "a deep link never writes the preference").toBe("lengkap");
  await openEditor(page, `${BASE}?mode=cepat`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  expect(await storedView(page)).toBe("lengkap");
  // Using the switch writes it again.
  await switchView(page, "lengkap");
  await switchView(page, "cepat");
  expect(await storedView(page)).toBe("cepat");
  await openEditor(page, BASE);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
});

test("AC1: with storage that throws, the editor opens in Cepat and the switch still works", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = function getItem() { throw new DOMException("blocked", "SecurityError"); };
    Storage.prototype.setItem = function setItem() { throw new DOMException("blocked", "QuotaExceededError"); };
  });
  await openEditor(page, BASE);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await switchView(page, "lengkap");
  await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
  await switchView(page, "cepat");
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
});

// ---------------------------------------------------------------------------------------------
// AC2: one editor under both views

test("AC2: ten switches keep the canvas and the player, lose no undo step, and undo across views", async ({ page }) => {
  await openEditor(page, BASE, {});
  await page.evaluate(() => { document.querySelector('[data-stage="canvas"]').dataset.probe = "same"; });
  const players = await page.evaluate(() => window.__playersCreated);
  expect(players).toBe(1);
  // One edit in each view.
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await switchView(page, "lengkap");
  await page.getByRole("tab", { name: "Teks" }).click();
  const pack = (await editorState(page)).doc.captions.pack.id;
  const other = pack === "bold" ? "classic" : "bold";
  await page.locator(`[data-pack="${other}"] input`).check();
  await expect.poll(async () => (await editorState(page)).doc.captions.pack.id).toBe(other);
  for (let i = 0; i < 10; i += 1) await switchView(page, i % 2 === 0 ? "cepat" : "lengkap");
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.locator('[data-stage="canvas"][data-probe="same"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.__playersCreated)).toBe(players);
  // The Lengkap edit undoes from Cepat, the Cepat edit from Lengkap.
  await switchView(page, "cepat");
  await page.getByRole("button", { name: "Urungkan" }).click();
  expect((await editorState(page)).doc.captions.pack.id).toBe(pack);
  await switchView(page, "lengkap");
  await page.getByRole("button", { name: "Urungkan" }).click();
  const after = await editorState(page);
  expect(after.doc.captions.enabled).toBe(true);
  expect(after.canUndo).toBe(false);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// AC3: deep links (a logged-in viewer)

test("AC3: ?mode, ?panel and ?card open as §4.4 says; unknown values fall back", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=lengkap`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await openEditor(page, `${BASE}?mode=cepat`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
  for (const id of PANEL_IDS) {
    await openEditor(page, `${BASE}?panel=${id}`);
    await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
    await expect(page.locator(`#editor-tab-${id}`)).toHaveAttribute("aria-selected", "true");
  }
  for (const id of CARD_IDS) {
    await openEditor(page, `${BASE}?card=${id}`);
    await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
    await expect(header(page, id)).toHaveAttribute("aria-expanded", "true");
    await expect(cards(page).locator('[aria-expanded="true"]')).toHaveCount(1);
  }
  await openEditor(page, `${BASE}?mode=lama&panel=timeline&card=ekspor`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
  expect(await storedView(page)).toBeNull();
});

test("AC3: a switch replaces the address with ?mode and drops ?panel and ?card", async ({ page }) => {
  await openEditor(page, `${BASE}?card=lines&ref=proyek#catatan`);
  await switchView(page, "lengkap");
  const url = new URL(page.url());
  expect(url.pathname).toBe(BASE);
  expect(url.searchParams.get("mode")).toBe("lengkap");
  expect(url.searchParams.get("card")).toBeNull();
  expect(url.searchParams.get("ref")).toBe("proyek");
  expect(url.hash).toBe("#catatan");
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  // Back in Cepat after a switch, Caption opens, not the deep-linked card.
  await switchView(page, "cepat");
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
});

// ---------------------------------------------------------------------------------------------
// AC4: the keyboard

test("AC4: the view switch works by Tab and ←/→, keeps focus, and the live region names the view", async ({ page }) => {
  await openEditor(page, BASE);
  await page.getByRole("link", { name: "← Proyek" }).focus();
  await page.keyboard.press("Tab");
  await expect(viewRadio(page, "Cepat")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(viewRadio(page, "Lengkap")).toBeFocused();
  await expect(viewRadio(page, "Lengkap")).toBeChecked();
  await expect(page.getByTestId("view-announcement")).toHaveText("Tampilan Lengkap");
  expect(await playerFrame(page), "the arrow stayed with the switch, not the frame step").toBe(0);
  await page.keyboard.press("ArrowLeft");
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(viewRadio(page, "Cepat")).toBeFocused();
  await expect(page.getByTestId("view-announcement")).toHaveText("Tampilan Cepat");
  // Tab from the switch moves on to Urungkan's neighbours: the unchecked radio is no tab stop.
  await page.keyboard.press("Tab");
  await expect(viewRadio(page, "Lengkap")).not.toBeFocused();
});

test("AC4: after a click on a pack pill or a swatch, Ctrl+Z, ', ? and K still work; Space and arrows stay with the control", async ({ page }) => {
  await openEditor(page, `${BASE}?panel=text`);
  const start = (await editorState(page)).doc.captions;
  const pack = page.locator('[data-pack="bold"] input');
  await pack.click();
  await expect.poll(async () => (await editorState(page)).doc.captions.pack.id).toBe("bold");
  await expect(pack).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await editorState(page)).doc.captions.pack.id).toBe(start.pack.id);
  await page.keyboard.press("'");
  await expect(safeZone(page)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("'");
  await expect(safeZone(page)).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("k");
  await expect(playButton(page, "Jeda")).toBeVisible();
  await page.keyboard.press("k");
  await expect(playButton(page, "Putar")).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Pintasan keyboard" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  // Focus is back on the pill: the arrows move the native radio group, not the playhead.
  await expect(pack).toBeFocused();
  const before = await playerFrame(page);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await editorState(page)).doc.captions.pack.id).not.toBe("bold");
  expect(await playerFrame(page)).toBe(before);
  // Space on the focused radio is the radio's: nothing plays.
  await page.keyboard.press(" ");
  await expect(playButton(page, "Putar")).toBeVisible();
  // A swatch: Ctrl+Z undoes it from the swatch itself.
  const swatches = page.getByRole("group", { name: "Warna sorot" }).getByRole("radio");
  const highlight = (await editorState(page)).doc.captions.overrides.highlight;
  const target = (await swatches.count()) > 1 && (await swatches.nth(0).isChecked()) ? swatches.nth(1) : swatches.nth(0);
  await target.click();
  await expect.poll(async () => (await editorState(page)).doc.captions.overrides.highlight).not.toBe(highlight);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await editorState(page)).doc.captions.overrides.highlight).toBe(highlight);
});

test("AC4: after a click on a transition style or the whoosh switch, Ctrl+Z and K still work; Space toggles the switch", async ({ page }) => {
  await openEditor(page, `${BASE}?panel=coldopen`, { doc: COLD_OPEN_DOC });
  const section = page.locator("[data-coldopen-transition]");
  const style = section.locator('[data-transition-style="dip_black"] input');
  await style.click();
  await expect.poll(async () => (await editorState(page)).commands.at(-1)?.type).toBe("SetJoinStyle");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await editorState(page)).canUndo).toBe(false);
  await page.keyboard.press("k");
  await expect(playButton(page, "Jeda")).toBeVisible();
  await page.keyboard.press("k");
  await expect(playButton(page, "Putar")).toBeVisible();
  const whoosh = section.getByRole("switch", { name: "Suara whoosh" });
  await whoosh.click();
  await expect.poll(async () => (await editorState(page)).commands.at(-1)?.type).toBe("SetJoinSfx");
  await expect(whoosh).toBeFocused();
  const sfx = (await editorState(page)).commands.filter((command) => command.type === "SetJoinSfx").length;
  await page.keyboard.press(" ");
  await expect.poll(async () => (await editorState(page)).commands.filter((command) => command.type === "SetJoinSfx").length).toBe(sfx + 1);
  await expect(playButton(page, "Putar")).toBeVisible();
  expect((await editorState(page)).canRedo).toBe(false);
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await editorState(page)).canRedo, "Ctrl+Z from the switch undid a step").toBe(true);
  await page.keyboard.press("'");
  await expect(safeZone(page)).toHaveAttribute("aria-pressed", "true");
});

// ---------------------------------------------------------------------------------------------
// The top bar and the stage overlays (§5.1, §5.2)

test("the ⋯ Lainnya menu holds 'Kembali ke versi AI' and 'Pintasan keyboard'; Esc returns to its button", async ({ page }) => {
  await openEditor(page, BASE);
  const bar = page.locator('[data-slot="topBar"]');
  await expect(bar.getByRole("button", { name: "Kembali ke versi AI" })).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Pintasan keyboard" })).toHaveCount(0);
  const more = bar.getByRole("button", { name: "Lainnya", exact: true });
  await expect(more).toHaveAttribute("aria-haspopup", "menu");
  await more.focus();
  await page.keyboard.press("Enter");
  const menu = bar.getByRole("menu", { name: "Lainnya" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Kembali ke versi AI", /^Pintasan keyboard\s*\?$/]);
  await expect(menu.getByRole("menuitem", { name: "Kembali ke versi AI" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: /Pintasan keyboard/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  await openShortcutHelp(page);
  const help = page.getByRole("dialog", { name: "Pintasan keyboard" });
  await expect(help).toBeVisible();
  // The scrubber's own keys are listed (spec §4.5).
  await expect(help.getByRole("row").filter({ hasText: "PageUp" })).toContainText("(di bilah posisi)");
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
  // "Kembali ke versi AI" from the menu is one undoable command.
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await resetToAi(page);
  expect((await editorState(page)).commands.at(-1).type).toBe("ResetToSeed");
});

test("the top bar: the switch, Urungkan and Ulangi as 44 px icon buttons, Perlu dicek neutral at 0 and edged above", async ({ page }) => {
  await openEditor(page, BASE);
  const undo = page.getByRole("button", { name: "Urungkan" });
  await expect(undo).toHaveAttribute("aria-keyshortcuts", "Control+Z");
  await expect(undo).toHaveAttribute("title", /Ctrl\+Z/);
  await expect(page.getByRole("button", { name: "Ulangi" })).toHaveAttribute("aria-keyshortcuts", "Control+Shift+Z Control+Y");
  const checks = page.getByRole("button", { name: "Perlu dicek (0)", exact: true });
  await expect(checks).toBeVisible();
  const colours = (locator) => locator.evaluate((element) => {
    const probe = document.createElement("i");
    element.append(probe);
    const resolve = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const tokens = { warning: resolve("--warning"), strong: resolve("--border-strong") };
    probe.remove();
    return { border: getComputedStyle(element).borderTopColor, ...tokens };
  });
  const quiet = await colours(checks);
  expect(quiet.border).toBe(quiet.strong);
  const button = await openChecks(page, 0);
  await page.keyboard.press("Escape");
  await expect(button).toBeFocused();

  await openEditor(page, BASE, { planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }] });
  const edged = await colours(page.getByRole("button", { name: "Perlu dicek (1)", exact: true }));
  expect(edged.border).toBe(edged.warning);
});

for (const view of ["cepat", "lengkap"]) {
  test(`the stage overlays in ${view}: the status and '?' at the top left, Frame akhir and Zona aman at the top right`, async ({ page }) => {
    await openEditor(page, `${BASE}?mode=${view}`);
    const start = page.locator('[data-stage-overlay="start"]');
    const end = page.locator('[data-stage-overlay="end"]');
    await expect(start.getByTestId("stage-badge")).toHaveText("Sesuai hasil akhir");
    await expect(start.getByTestId("stage-badge")).toHaveAttribute("role", "status");
    await expect(start.getByTestId("stage-badge")).toHaveAttribute("aria-live", "polite");
    const help = start.getByRole("button", { name: "Apa artinya?" });
    await help.click();
    await expect(page.getByRole("note")).toContainText("Frame, teks, logo dan audio sama dengan hasil akhir");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("note")).toHaveCount(0);
    await expect(help).toBeFocused();
    const truth = end.getByRole("button", { name: "Frame akhir" });
    await expect(truth).toHaveAttribute("aria-pressed", "false");
    await truth.click();
    await expect(truth).toHaveAttribute("aria-pressed", "true");
    await expect(start.getByTestId("stage-badge")).toHaveText("Frame akhir");
    await truth.click();
    await expect(start.getByTestId("stage-badge")).toHaveText("Sesuai hasil akhir");
    await end.getByRole("button", { name: "Zona aman" }).click();
    await expect(page.locator("[data-safe-zone]")).toBeVisible();
    await expect(safeZone(page)).toHaveAttribute("aria-pressed", "true");
    // Beside the 9:16 frame, never over the video.
    const stage = await page.getByRole("img", { name: "Pratinjau klip" }).boundingBox();
    for (const box of [await start.getByTestId("stage-badge").boundingBox(), await help.boundingBox(), await truth.boundingBox()]) {
      expect(box.x + box.width <= stage.x + 0.5 || box.x >= stage.x + stage.width - 0.5).toBe(true);
    }
    // Only one bottom region: the transport row in Lengkap, the scrubber bar in Cepat.
    await expect(page.getByTestId("stage-time")).toHaveCount(1);
    await expect(page.getByTestId("stage-time")).toHaveText(/^00:00,0 \/ 00:10,0$/);
    await expect(page.getByRole("button", { name: "Frame sebelumnya" })).toHaveCount(view === "lengkap" ? 1 : 0);
  });
}

// AC11: the two legacy texts leave the screen in every state and both views.
for (const view of ["cepat", "lengkap"]) {
  test(`AC11 (${view}): an auto file from before the editor shows no legacy text; the status is empty with today's help`, async ({ page }) => {
    const legacy = structuredClone(fakeDoc());
    legacy.base.engine.compiler = "legacy";
    await openEditor(page, `${BASE}?mode=${view}`, { doc: legacy, legacyAuto: true,
      autoRenderUrl: `/api/jobs/${FAKE_JOB_ID}/files/output/clip-01.mp4` });
    await expect(page.locator("[data-badge-tone]")).toHaveAttribute("data-badge-tone", "legacy");
    await expect(page.getByTestId("stage-badge")).toHaveText("");
    for (const removed of [/Klip otomatis ini dibuat sebelum editor dibuka/, /Belum diubah/, /ekspor = klip otomatis/,
      /Ubah apa saja agar ekspor/, /^●/]) {
      await expect(page.getByText(removed)).toHaveCount(0);
    }
    await page.getByRole("button", { name: "Apa artinya?" }).click();
    await expect(page.getByRole("note")).toHaveText(LEGACY_HELP);
  });
}

// ---------------------------------------------------------------------------------------------
// Z0's scaffold checks, kept: the cards, the tabs, the scrubber and the ways between the views

test("?mode=cepat mounts the six cards with Caption open, the scrubber, and no tabs or timeline", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "cepat");
  await expect(page.getByRole("tablist")).toHaveCount(0);
  await expect(page.locator('[data-slot="timeline"]')).toHaveCount(0);
  const headers = cards(page).getByRole("heading", { level: 2 }).getByRole("button");
  await expect(headers).toHaveCount(CARD_LABELS.length);
  for (const [index, label] of CARD_LABELS.entries()) await expect(headers.nth(index)).toContainText(label);
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
  await expect(cards(page).locator('[aria-expanded="true"]')).toHaveCount(1);
  // Closed bodies are inert and hidden; the open one is a region named by its header.
  await expect(page.locator("#card-hook-region")).toHaveAttribute("inert", "");
  await expect(page.locator("#card-hook-region")).toBeHidden();
  await expect(page.getByRole("region", { name: /^Caption/ })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Posisi putar" })).toBeVisible();
});

test("?mode=lengkap shows the panel tabs, the panel and the timeline, no cards", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=lengkap`);
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  const tabs = page.getByRole("tablist", { name: "Panel editor" }).getByRole("tab");
  await expect(tabs).toHaveText(PANEL_TABS);
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
  await expect(page.locator('[data-slot="timeline"]')).toBeVisible();
  await expect(page.locator('[data-slot="cards"]')).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Posisi putar" })).toHaveCount(0);
});

test("the tabs keep their keys: the arrows of their orientation move and select, Home and End go to the ends", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=lengkap`);
  const vertical = (await page.getByRole("tablist", { name: "Panel editor" }).getAttribute("aria-orientation")) === "vertical";
  const next = vertical ? "ArrowDown" : "ArrowRight";
  await page.getByRole("tab", { name: "Transkrip" }).focus();
  await page.keyboard.press(next);
  await expect(page.getByRole("tab", { name: "Teks" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Teks" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Musik" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Transkrip" })).toBeFocused();
  expect(await playerFrame(page), "the tab keys never step the playhead").toBe(0);
});

test("one card open at a time: opening another closes Caption, and the open header closes its card", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  const lines = await openCard(page, "lines");
  await expect(lines).toBeVisible();
  await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#card-caption-region")).toHaveAttribute("inert", "");
  await header(page, "lines").click();
  await expect(cards(page).locator('[aria-expanded="true"]')).toHaveCount(0);
});

test("the bottom bar: play, the time and the scrubber; the scrubber seeks and follows the playhead", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  const bar = page.locator('[data-slot="bottom"]');
  await expect(bar.getByRole("button", { name: "Putar" })).toBeVisible();
  await expect(bar.getByTestId("stage-time")).toHaveText("00:00,0 / 00:10,0");
  const slider = page.getByRole("slider", { name: "Posisi putar" });
  await slider.fill("45");
  await expect.poll(() => playerFrame(page)).toBe(45);
  await page.evaluate(() => window.__potonginEditor.player.seek(120));
  await expect(slider).toHaveValue("120");
  await expect(slider).toHaveAttribute("aria-valuetext", /^00:04,0 dari \d\d:\d\d,\d$/);
  await expect(bar.getByTestId("stage-time")).toHaveText("00:04,0 / 00:10,0");
  await bar.getByRole("button", { name: "Putar" }).click();
  await expect(bar.getByRole("button", { name: "Jeda" })).toBeVisible();
});

test("a card's way to Mode Lengkap keeps the stage, the player and the undo history, and writes no preference", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const before = await page.evaluate(() => {
    document.querySelector('[data-stage="canvas"]').dataset.probe = "same";
    return window.__potonginEditor.store.getState().canUndo;
  });
  expect(before).toBe(true);
  // Logo & Musik's way to its full panels ("Atur detail di Mode Lengkap"; spec §1.4).
  const extras = await openCard(page, "extras");
  await extras.getByRole("button", { name: /Mode Lengkap/ }).first().click();
  await expect(root(page)).toHaveAttribute("data-editor-view", "lengkap");
  await expect(page.getByRole("tab", { name: "Logo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-stage="canvas"][data-probe="same"]')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get("mode")).toBe("lengkap");
  expect(await storedView(page)).toBeNull();
  await page.getByRole("button", { name: "Urungkan" }).click();
  expect(await page.evaluate(() => window.__potonginEditor.store.getState().doc.captions.enabled)).toBe(true);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
});

test("the bottom bar's link opens the transcript in Mode Lengkap", async ({ page }) => {
  await openEditor(page, `${BASE}?mode=cepat`);
  await page.getByRole("button", { name: "Potong per kata di Mode Lengkap →" }).click();
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
});

// ---------------------------------------------------------------------------------------------
// AC12: lime only on Ekspor (and transient progress fills, none at rest)

// The lime colours shown in `scope` (an element, or the whole editor when null), as computed: text,
// background, visible borders and outline, SVG fill and stroke. Ekspor and dialogs are skipped.
// Self-contained: Playwright runs it in the page.
function limeScan(scope) {
  const root = document.querySelector("[data-editor-root]");
  const probe = document.createElement("i");
  root.append(probe);
  const resolve = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
  const lime = new Set(["--accent", "--accent-hover", "--accent-ink"].map(resolve));
  probe.remove();
  const exportButton = [...root.querySelectorAll("button")].find((button) => button.textContent.trim() === "Ekspor");
  const elements = scope ? [scope, ...scope.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  const found = [];
  for (const element of elements) {
    if (element.closest("dialog") || exportButton?.contains(element)) continue;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const props = ["color", "background-color", "fill", "stroke"];
    for (const side of ["top", "right", "bottom", "left"]) {
      if (style.getPropertyValue(`border-${side}-style`) !== "none" && parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) {
        props.push(`border-${side}-color`);
      }
    }
    if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) props.push("outline-color");
    for (const prop of props) {
      if (lime.has(style.getPropertyValue(prop))) {
        const label = element.closest("button, a, label, [role]");
        found.push({ prop, tag: element.tagName.toLowerCase(),
          name: (label?.getAttribute("aria-label") || label?.textContent || "").trim().slice(0, 60),
          panel: Boolean(element.closest("#editor-panel")) });
      }
    }
  }
  return found;
}

async function limeAtRest(page) {
  return page.evaluate(limeScan, null);
}

// Hovers every visible, enabled control of the editor (Ekspor aside) and scans it while hovered.
// The sweep holds each control's element, so a control that leaves the page while it runs (a list
// that finished loading) is skipped at once instead of awaited by index; controls that appeared
// meanwhile are swept in a further round, until none is new.
async function limeOnHover(page) {
  const found = [];
  const controls = page.locator('[data-editor-root] :is(button, a[href], [role="tab"], label:has(input[type="radio"]), '
    + 'label:has(input[type="checkbox"])):not([data-lime-swept]):visible');
  for (let round = 0; round < 5; round += 1) {
    const handles = await controls.elementHandles();
    if (!handles.length) break;
    for (const handle of handles) {
      const skip = await handle.evaluate((element) => {
        element.setAttribute("data-lime-swept", "");
        return !element.isConnected || element.disabled === true || Boolean(element.closest("dialog"))
          || element.textContent.trim() === "Ekspor";
      }).catch(() => true);
      if (skip) continue;
      await handle.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
      await handle.hover({ force: true, timeout: 2_000 }).catch(() => {});
      found.push(...(await handle.evaluate(limeScan).catch(() => [])));
    }
  }
  await page.evaluate(() => document.querySelectorAll("[data-lime-swept]").forEach((element) => element.removeAttribute("data-lime-swept")));
  await page.mouse.move(1, 1);
  return found;
}

test("AC12: lime only on Ekspor, at rest and hovered, with every card and every panel open", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1920, height: 960 });
  const rest = [];
  const hover = [];
  const record = async (state) => {
    rest.push(...(await limeAtRest(page)).map((hit) => ({ state, ...hit })));
    hover.push(...(await limeOnHover(page)).map((hit) => ({ state, ...hit })));
  };
  await openEditor(page, `${BASE}?mode=cepat`);
  for (const id of CARD_IDS) {
    await openCard(page, id);
    await record(`card ${id}`);
  }
  await switchView(page, "lengkap");
  for (const name of PANEL_TABS) {
    await page.getByRole("tab", { name }).click();
    await record(`panel ${name}`);
  }
  // Ekspor itself is lime (the one lime control).
  const exportBg = await page.getByRole("button", { name: "Ekspor", exact: true }).evaluate((element) => {
    const probe = document.createElement("i");
    element.append(probe);
    probe.style.color = "var(--accent)";
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(element).backgroundColor, accent];
  });
  expect(exportBg[0]).toBe(exportBg[1]);
  expect(rest, "lime at rest").toEqual([]);
  expect(hover, "lime on hover").toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// AC13: 44 px targets, focus in forced colours, axe

async function smallTargets(page, selector) {
  return page.locator(selector).evaluateAll((elements) => elements.flatMap((element) => {
    const target = element.matches('input[type="radio"]') ? element.closest("label") : element;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const name = target.getAttribute("aria-label") || target.textContent.trim();
    return rect.width >= 43.5 && rect.height >= 43.5 ? [] : [`${name}: ${Math.round(rect.width)}×${Math.round(rect.height)}`];
  }));
}

for (const viewport of [{ width: 1366, height: 650 }, { width: 1920, height: 960 }]) {
  test(`AC13 at ${viewport.width}×${viewport.height}: the top bar, the stage overlays and both bottom regions are 44 px targets`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEditor(page, `${BASE}?mode=cepat`);
    const controls = ':is(a[href], button, input[type="radio"], input[type="range"], [role="slider"])';
    expect(await smallTargets(page, `[data-slot="topBar"] ${controls}`), "top bar").toEqual([]);
    expect(await smallTargets(page, `[data-stage-overlay] ${controls}`), "stage overlays").toEqual([]);
    expect(await smallTargets(page, `[data-slot="bottom"] ${controls}`), "Cepat bottom bar").toEqual([]);
    const bottom = await page.locator('[data-slot="bottom"]').boundingBox();
    expect(bottom.height).toBe(96);
    expect(await page.locator('[data-slot="topBar"]').evaluate((element) => element.getBoundingClientRect().height)).toBe(64);
    // The page never scrolls; the cards column scrolls inside itself.
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight
      && document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await switchView(page, "lengkap");
    expect(await smallTargets(page, `[data-slot="transport"] ${controls}`), "Lengkap transport").toEqual([]);
    expect(await smallTargets(page, `[data-stage-overlay] ${controls}`), "stage overlays (Lengkap)").toEqual([]);
    expect(await page.locator('[data-slot="transport"]').evaluate((element) => element.getBoundingClientRect().height)).toBe(56);
  });
}

test("AC13: under forced colours a focused pill, card header and rail tab keep a visible outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openEditor(page, `${BASE}?mode=cepat`);
  const outline = (locator) => locator.evaluate((element) => {
    const target = element.matches('input[type="radio"]') ? element.closest("label") : element;
    return getComputedStyle(target).outlineStyle;
  });
  await page.keyboard.press("Tab");
  const pill = safeZone(page);
  await pill.focus();
  expect(await outline(pill)).not.toBe("none");
  const card = header(page, "hook");
  await card.focus();
  expect(await outline(card)).not.toBe("none");
  const segment = viewRadio(page, "Cepat");
  await segment.focus();
  expect(await outline(segment)).not.toBe("none");
  await switchView(page, "lengkap");
  // The switch was clicked: a key press puts the page back in keyboard modality (:focus-visible).
  await page.getByRole("button", { name: "Ekspor", exact: true }).focus();
  await page.keyboard.press("Tab");
  const tab = page.getByRole("tab", { name: "Transkrip" });
  await expect(tab).toBeFocused();
  expect(await outline(tab)).not.toBe("none");
});

async function axeBlocking(page) {
  // Cards open and pills fade over var(--dur-*): axe reads the colours once the transitions end.
  await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition)
    || animation.playState !== "running"));
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
      .map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
  });
}

for (const viewport of [{ width: 1366, height: 650 }, { width: 1920, height: 960 }]) {
  test(`QG-A11Y at ${viewport.width}×${viewport.height}: axe finds no critical or serious violation in Cepat with each card open, nor in Lengkap`, async ({ page }) => {
    test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    await openEditor(page, `${BASE}?mode=cepat`);
    const results = [];
    for (const id of CARD_IDS) {
      await openCard(page, id);
      results.push({ state: `card ${id}`, blocking: await axeBlocking(page) });
    }
    await page.locator('[data-slot="topBar"]').getByRole("button", { name: "Lainnya" }).click();
    results.push({ state: "menu Lainnya open", blocking: await axeBlocking(page) });
    await page.keyboard.press("Escape");
    await switchView(page, "lengkap");
    results.push({ state: "Lengkap", blocking: await axeBlocking(page) });
    for (const item of results) expect(item.blocking, item.state).toEqual([]);
  });
}
