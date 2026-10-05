// Screenshots of the two views for the owner (docs/plans/2026-10-02-editor-mode-cepat.md §10 step 4,
// the integrator's): full-page PNGs at 1366×768 and 1920×1080 of Mode Cepat with each card open
// (Teks caption with one line edited, Cold open with Kilat putih) and of Mode Lengkap with the rail
// and the word toolbar. They land in EDITOR_GATES_OUT/screens with a manifest, so a CI run uploads
// them as its artifact. The page is the app on the editor fakes with the real store, so the edits
// are real commands; the fake player draws no video, so the stage itself stays empty.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1. On GitHub Actions:
//   gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e -f command='e2e/editor-screens.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { switchView } from "./support/editor-topbar.mjs";
import { login, settings } from "./support/harness.mjs";

const CEPAT = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=cepat`;
const VIEWPORTS = [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }];
const WORDS = fakeWords();
const ID = WORDS.words.map((word) => word.id); // ID[0] "Kenapa" … ID[11] "subuh"
// The fakes' clip with a cold open ("Jadi waktu itu kita datang subuh"); its join is the auto
// clips' Kilat putih with whoosh.
const DOC = applyCommand(fakeDoc(), "SetColdOpen", { firstWord: ID[6], lastWord: ID[11] },
  createContext({ words: WORDS, seed: fakeDoc() })).doc;

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();

// Browser side (serialised by addInitScript): the fake API opens `config.doc`, and the store is the
// real one over the fakes, so a line edit and a transition choice change the document.
function installScreensScenario(config) {
  window.__potonginEditorScenario = {
    api(_api, fakes) {
      return fakes.createFakeApiClient({ doc: JSON.parse(JSON.stringify(config.doc)) });
    },
    store(store, fakes, parts) {
      store.destroy();
      return fakes.createRealEditorStore({ ...parts });
    },
  };
}

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
    const failures = { console: [], page: [] };
    page.on("console", (message) => { if (message.type() === "error") failures.console.push(message.text()); });
    page.on("pageerror", (error) => failures.page.push(error.stack || error.message));
    await use(page);
    const count = failures.console.length + failures.page.length;
    if (count && testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${JSON.stringify(failures, null, 2)}`);
  },
});

test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, deviceScaleFactor: 1 });
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

const editorState = (page) => page.evaluate(() => {
  const state = window.__potonginEditor.store.getState();
  return { doc: state.doc, cues: state.plan?.cues.map((cue) => cue.text) ?? [] };
});

// Waits until nothing animates for 300 ms (the accordion, the toolbar's fade), with the pointer
// parked on the empty corner of the preview area so no hover shows.
async function settle(page) {
  const box = await page.locator('[data-slot="stage"]').boundingBox();
  if (box) await page.mouse.move(box.x + 4, box.y + box.height - 4);
  await page.evaluate(() => { globalThis.__screensQuietSince = null; });
  return page.waitForFunction(() => {
    const now = performance.now();
    if (document.getAnimations().some((animation) => animation.playState === "running")) globalThis.__screensQuietSince = null;
    else globalThis.__screensQuietSince ??= now;
    return now - globalThis.__screensQuietSince >= 300;
  }, null, { polling: 50, timeout: 10_000 }).then(() => true, () => false);
}

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`screens at ${size}: Mode Cepat with each card open, Mode Lengkap with the rail and the word toolbar`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const dir = path.join(process.env.EDITOR_GATES_OUT || testInfo.outputPath(), "screens");
    mkdirSync(dir, { recursive: true });
    const manifest = [];
    const capture = async (file, view, state, card = null) => {
      const settled = await settle(page);
      await page.screenshot({ path: path.join(dir, file), fullPage: true });
      manifest.push({ file, viewport: size, view, state, settled,
        summary: card ? (await page.locator(`#card-${card}-button`).textContent()).trim() : null,
        status: (await page.getByTestId("stage-badge").textContent()).trim() });
    };

    await page.setViewportSize(viewport);
    await page.addInitScript(installScreensScenario, { doc: DOC });
    await page.goto(CEPAT);
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", "cepat");

    // Hook, with its suggestions listed.
    const hook = await openCard(page, "hook");
    await expect(hook.locator("button[data-suggestion]").first()).toBeVisible({ timeout: 15_000 });
    await capture(`${size}-cepat-1-hook.png`, "cepat", "Hook card", "hook");

    // Caption.
    const caption = await openCard(page, "caption");
    await expect(caption.getByRole("group", { name: "Gaya caption" })).toBeVisible();
    await capture(`${size}-cepat-2-caption.png`, "cepat", "Caption card", "caption");

    // Teks caption, one line edited ("sutradara" → "sutradaranya").
    const lines = await openCard(page, "lines");
    const fields = lines.locator("[data-line-key] input");
    await expect(fields.first()).toBeVisible();
    const at = (await fields.evaluateAll((inputs) => inputs.map((input) => input.value))).indexOf("Kenapa sutradara ditahan di");
    expect(at, "the fakes' first body line").toBeGreaterThanOrEqual(0);
    await fields.nth(at).click();
    await fields.nth(at).fill("Kenapa sutradaranya ditahan di");
    await fields.nth(at).press("Enter");
    await expect.poll(async () => (await editorState(page)).doc.captions.word_edits[ID[1]]?.text ?? null).toBe("sutradaranya");
    await expect.poll(async () => (await editorState(page)).cues).toContain("Kenapa sutradaranya ditahan di");
    await expect(page.locator("#card-lines-button")).toContainText("1 diubah");
    await capture(`${size}-cepat-3-teks-caption.png`, "cepat", "Teks caption card, one line edited", "lines");

    // Cold open, its transition on Kilat putih.
    const coldOpen = await openCard(page, "coldopen");
    await expect(coldOpen.locator("[data-coldopen-line]")).toBeVisible();
    const flash = coldOpen.getByRole("group", { name: "Efek gambar" }).getByRole("radio", { name: "Kilat putih" });
    await flash.check();
    await expect(flash).toBeChecked();
    await expect(page.locator("#card-coldopen-button")).toContainText("Kilat putih");
    await capture(`${size}-cepat-4-cold-open.png`, "cepat", "Cold open card, Kilat putih", "coldopen");

    // Tata letak.
    const layout = await openCard(page, "layout");
    await expect(layout.getByRole("radio").first()).toBeVisible();
    await capture(`${size}-cepat-5-tata-letak.png`, "cepat", "Tata letak card", "layout");

    // Logo & Musik.
    const extras = await openCard(page, "extras");
    await expect(extras.getByRole("button", { name: "Tambah logo" })).toBeVisible();
    await capture(`${size}-cepat-6-logo-musik.png`, "cepat", "Logo & Musik card", "extras");

    // Mode Lengkap: the rail, the transcript and the word toolbar over "ditahan di film".
    await switchView(page, "lengkap");
    await page.getByRole("tab", { name: "Transkrip", exact: true }).click();
    const transcript = page.locator('[data-panel="transcript"]');
    await expect(transcript.locator("[data-w]").first()).toBeVisible();
    await transcript.locator('[data-w="2"]').click();
    await transcript.locator('[data-w="4"]').click({ modifiers: ["Shift"] });
    const toolbar = page.getByRole("toolbar", { name: "Aksi kata terpilih" });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).not.toHaveAttribute("data-placement", "none");
    await expect(page.getByRole("tablist", { name: "Panel editor" })).toBeVisible();
    await capture(`${size}-lengkap-rail-toolbar.png`, "lengkap", "Transkrip panel, three words selected, the word toolbar");

    writeFileSync(path.join(dir, `manifest-${size}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
    expect(manifest).toHaveLength(7);
  });
}
