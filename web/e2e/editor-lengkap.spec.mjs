// Mode Lengkap's icon rail and the transcript's contextual word toolbar, in the editor on its
// fakes (docs/plans/2026-10-02-editor-mode-cepat.md §6.1, §6.2, §9.4: AC9, AC10, the toolbar by
// keyboard only, U1 and U2 scripted through the toolbar). The fakes' store records every command
// without applying the transcript ones, so each check reads the command the editor sent; the
// transcript harness spec (editor-transcript.spec.mjs) replays the real commands.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1; AXE_CORE_PATH=<axe.min.js> for the axe check;
// EDITOR_GATES_OUT=<dir> receives the rail measurements and the U1/U2 timings (numbers only).
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-lengkap.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { selectionActions } from "../components/editor/transcript/actions.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { extendTo, selectOne } from "../components/editor/transcript/selection.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { wordAction } from "./support/editor-words.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=lengkap`;
const PANEL_TABS = [["transcript", "Transkrip"], ["text", "Teks"], ["coldopen", "Cold open"], ["layout", "Tata letak"],
  ["logo", "Logo"], ["music", "Musik"]];
const RAIL_VIEWPORTS = [{ width: 1366, height: 650 }, { width: 1920, height: 960 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }];
const gatesOut = process.env.EDITOR_GATES_OUT || "";

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

function writeGate(name, value) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  writeFileSync(path.join(gatesOut, name), `${JSON.stringify(value, null, 2)}\n`);
}

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();
const AXE = axeSource();

// The fakes' 12 words. TRIMMED clips the first two ("Kenapa sutradara" before the clip, dimmed);
// CUT also cuts "film sendiri?" (words 4 and 5). Both come from the real commands.
const WORDS = fakeWords().words;
const CTX = createContext({ words: fakeWords(), seed: fakeDoc() });
const TRIMMED = applyCommand(fakeDoc(), "TrimStart", { gapWord: WORDS[2].id }, CTX).doc;
const CUT = applyCommand(TRIMMED, "RemoveWords", { wordIds: [WORDS[4].id, WORDS[5].id], reason: "user", origin: "user" }, CTX).doc;
const CUT_REMOVAL = CUT.main.removals[0].id;
const ids = (first, last) => WORDS.slice(first, last + 1).map((word) => word.id);

/** A selection of CUT whose "Jadikan cold open" is available, found with the panel's own rules. */
function coldOpenRange() {
  const model = buildTranscriptModel(fakeWords(), CUT);
  for (let first = 6; first < WORDS.length; first += 1) {
    for (let last = WORDS.length - 1; last >= first; last -= 1) {
      if (selectionActions(model, extendTo(selectOne(first), last)).coldOpen.enabled) return [first, last];
    }
  }
  throw new Error("no cold-open selection in the fakes");
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
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

// Browser side (serialised by addInitScript): the fake API opens `config.doc` instead of its seed.
function installDoc(config) {
  window.__potonginEditorScenario = {
    api(client) {
      const getEdit = client.getEdit.bind(client);
      client.getEdit = async (options) => ({ ...(await getEdit(options)), doc: JSON.parse(JSON.stringify(config.doc)) });
      return client;
    },
  };
}

async function openEditor(page, doc = null) {
  if (doc) await page.addInitScript(installDoc, { doc });
  await page.goto(EDITOR);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-panel="transcript"] [data-w]').first()).toBeVisible();
}

const rail = (page) => page.getByRole("tablist", { name: "Panel editor" });
const transcript = (page) => page.locator('[data-panel="transcript"]');
const word = (page, index) => transcript(page).locator(`[data-w="${index}"]`);
const wordList = (page) => transcript(page).locator("[data-transcript-words]");
const toolbar = (page) => page.getByRole("toolbar", { name: "Aksi kata terpilih" });
const commands = (page) => page.evaluate(() => window.__potonginEditor.store.getState().commands
  .map(({ type, args, mergeKey }) => ({ type, args, mergeKey })));
const focused = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return { role: element?.getAttribute("role") ?? element?.tagName.toLowerCase(), text: element?.textContent?.trim() ?? "",
    words: element?.hasAttribute("data-transcript-words") ?? false };
});

// The toolbar floats over the words next to the last selection, as a user sees it: Esc on the
// words clears that selection first, and a held Shift lets the Shift+click through the toolbar.
async function selectRange(page, first, last) {
  if (await toolbar(page).count()) {
    await wordList(page).focus();
    await page.keyboard.press("Escape");
  }
  await word(page, first).click();
  if (last !== first) {
    await page.keyboard.down("Shift");
    await word(page, last).click();
    await page.keyboard.up("Shift");
  }
}

// ---------------------------------------------------------------------------------------------
// AC9: the icon rail

test.describe("rail", () => {
  for (const viewport of RAIL_VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`one column of six tabs, 44 to 64 px each, all in view at ${size}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openEditor(page);
      const tabs = rail(page).getByRole("tab");
      await expect(tabs).toHaveText(PANEL_TABS.map(([, name]) => name));
      const railBox = await rail(page).boundingBox();
      expect(railBox.width).toBe(84);
      const boxes = [];
      for (let i = 0; i < PANEL_TABS.length; i += 1) {
        const box = await tabs.nth(i).boundingBox();
        boxes.push(box);
        await expect(tabs.nth(i)).toBeInViewport({ ratio: 1 });
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeLessThanOrEqual(64.5);
        expect(Math.abs(box.x - boxes[0].x)).toBeLessThanOrEqual(0.5);
        if (i > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height);
      }
      const scroll = await rail(page).evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
      expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight);
      // The panel still opens beside the rail.
      await expect(page.locator('[data-panel="transcript"]')).toBeInViewport();
      const panelBox = await page.locator("#editor-panel").boundingBox();
      expect(panelBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 0.5);
      writeGate(`D-AC9-rail-${size}.json`, {
        gate: "AC9 rail: one column, rows 44-64 px, no scroll", viewport, rail_px: { w: railBox.width, h: railBox.height },
        rows_px: boxes.map((box) => Number(box.height.toFixed(2))), scroll, pass: true,
      });
    });
  }

  test("every panel's tab keeps its id, name and panel; one tab stop; the selected tab is a neutral surface", async ({ page }) => {
    await openEditor(page);
    await expect(rail(page)).toHaveAttribute("aria-orientation", "vertical");
    for (const [id, name] of PANEL_TABS) {
      const tab = page.getByRole("tab", { name });
      await expect(tab).toHaveAttribute("id", `editor-tab-${id}`);
      await expect(tab).toHaveAttribute("aria-controls", "editor-panel");
      await expect(tab).toHaveAttribute("tabindex", id === "transcript" ? "0" : "-1");
    }
    const selected = page.getByRole("tab", { name: "Transkrip" });
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveCSS("background-color", "rgb(35, 37, 31)");
    await expect(selected).toHaveCSS("color", "rgb(247, 245, 237)");
    await expect(page.getByRole("tab", { name: "Teks" })).toHaveCSS("color", "rgb(165, 166, 157)");
    await expect(selected.locator("svg")).toHaveCount(1);
    await page.getByRole("tab", { name: "Musik" }).click();
    await expect(page.locator("#editor-panel")).toHaveAttribute("aria-labelledby", "editor-tab-music");
  });

  test("↑/↓ move and select, Home and End go to the ends, and focus follows", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("tab", { name: "Transkrip" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Teks" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Teks" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Teks" })).toHaveAttribute("tabindex", "0");
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: "Musik" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Transkrip" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("tab", { name: "Musik" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-panel="transcript"]')).toBeVisible();
    // The arrows are the rail's: no frame step went to the player.
    expect(await page.evaluate(() => window.__potonginEditor.player.frame())).toBe(0);
  });

  test("forced colours: a focused rail tab keeps a visible outline", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    await openEditor(page);
    await page.getByRole("tab", { name: "Transkrip" }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("tab", { name: "Teks" })).toBeFocused();
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    expect(outline).not.toBe("none");
  });
});

// ---------------------------------------------------------------------------------------------
// AC10: the contextual word toolbar

test.describe("word toolbar", () => {
  test("no chip row; with a selection the toolbar shows next to it and never covers it", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole("toolbar", { name: "Aksi kata", exact: true })).toHaveCount(0);
    await expect(toolbar(page)).toHaveCount(0);
    await expect(transcript(page).getByRole("button")).toHaveText([/^Rapikan/]);
    await selectRange(page, 6, 8);
    await expect(toolbar(page)).toBeVisible();
    await expect(toolbar(page).getByRole("button")).toHaveText(["Hapus", "Jadikan cold open", "Kata kunci", "Lainnya"]);
    const bar = await toolbar(page).boundingBox();
    const placement = await toolbar(page).getAttribute("data-placement");
    const selected = [];
    for (let i = 6; i <= 8; i += 1) selected.push(await word(page, i).boundingBox());
    for (const box of selected) {
      const overlap = bar.x < box.x + box.width && box.x < bar.x + bar.width && bar.y < box.y + box.height && box.y < bar.y + bar.height;
      expect(overlap).toBe(false);
    }
    if (placement === "above") expect(bar.y + bar.height).toBeLessThanOrEqual(selected[0].y - 8 + 0.5);
    else expect(bar.y).toBeGreaterThanOrEqual(Math.max(...selected.map((box) => box.y + box.height)) + 8 - 0.5);
    // Inside the panel, every control a 44 px target.
    const panel = await page.locator("#editor-panel").boundingBox();
    expect(bar.x).toBeGreaterThanOrEqual(panel.x - 0.5);
    expect(bar.x + bar.width).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
    for (const control of await toolbar(page).getByRole("button").all()) {
      expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
    }
    await toolbar(page).getByRole("button", { name: "Lainnya", exact: true }).click();
    const items = toolbar(page).getByRole("menu", { name: "Lainnya" }).locator('[role^="menuitem"]');
    await expect(items).toHaveCount(6);
    for (const item of await items.all()) expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
    // Holding Shift (focus on the words) fades the toolbar and lets a Shift+click through it.
    await page.keyboard.press("Escape");
    await wordList(page).focus();
    await page.keyboard.down("Shift");
    await expect(toolbar(page)).toHaveAttribute("data-pass-through", "");
    await expect(toolbar(page)).toHaveCSS("pointer-events", "none");
    await page.keyboard.up("Shift");
    await expect(toolbar(page)).not.toHaveAttribute("data-pass-through", /.*/);
    await expect(toolbar(page)).toHaveCSS("pointer-events", "auto");
  });

  test("the primary action follows the selection: Perpanjang ke sini, Pulihkan, Hapus", async ({ page }) => {
    await openEditor(page, CUT);
    const primary = () => toolbar(page).locator("[data-primary]");
    await word(page, 0).click();
    await expect(primary()).toHaveText("Perpanjang ke sini");
    await selectRange(page, 4, 5);
    await expect(primary()).toHaveText("Pulihkan");
    await selectRange(page, 3, 6);
    await expect(primary()).toHaveText("Hapus");
  });

  test("keyboard only: Tab in, arrows across, Lainnya by ↓ and Enter, Esc and Shift+Tab back with the selection kept", async ({ page }) => {
    await openEditor(page);
    await page.getByRole("tab", { name: "Transkrip" }).focus();
    for (let i = 0; i < 6 && !(await focused(page)).words; i += 1) await page.keyboard.press("Tab");
    await expect(wordList(page)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(3);
    await page.keyboard.press("Tab");
    await expect(toolbar(page).getByRole("button", { name: "Hapus", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(toolbar(page).getByRole("button", { name: "Jadikan cold open" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(toolbar(page).getByRole("button", { name: "Lainnya", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(toolbar(page).getByRole("button", { name: "Hapus", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(toolbar(page).getByRole("button", { name: "Kata kunci" })).toBeFocused();
    await page.keyboard.press("Enter");
    expect((await commands(page)).slice(-3)).toEqual(ids(0, 2).map((wordId) =>
      ({ type: "SetWordEmphasis", args: { wordId, on: true }, mergeKey: expect.stringMatching(/^tx:emphasis:/) })));
    await expect(wordList(page)).toBeFocused();
    // Lainnya: ↓ opens the menu on its first item, Enter runs one, focus goes back to the words.
    await page.keyboard.press("Tab");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    const menu = toolbar(page).getByRole("menu", { name: "Lainnya" });
    await expect(menu.getByRole("menuitem", { name: /^Edit kata/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemcheckbox", { name: /^Sembunyikan dari caption/ })).toBeFocused();
    await page.keyboard.press("Enter");
    expect((await commands(page)).slice(-3).map((entry) => [entry.type, entry.args.wordId, entry.args.on]))
      .toEqual(ids(0, 2).map((wordId) => ["SetWordHidden", wordId, true]));
    await expect(wordList(page)).toBeFocused();
    // Esc in the menu closes it back to its button; Esc on the toolbar returns to the words.
    await page.keyboard.press("Tab");
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(toolbar(page).getByRole("button", { name: "Lainnya", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(wordList(page)).toBeFocused();
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(3);
    await page.keyboard.press("Tab");
    await expect(toolbar(page).getByRole("button", { name: "Hapus", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(wordList(page)).toBeFocused();
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(3);
  });

  test("I and O pressed on the toolbar act on the selection", async ({ page }) => {
    await openEditor(page);
    await selectRange(page, 7, 9);
    await toolbar(page).getByRole("button", { name: "Kata kunci" }).focus();
    await page.keyboard.press("i");
    expect((await commands(page)).at(-1)).toEqual({ type: "TrimStart", args: { gapWord: WORDS[7].id }, mergeKey: null });
    await toolbar(page).getByRole("button", { name: "Lainnya", exact: true }).focus();
    await page.keyboard.press("o");
    expect((await commands(page)).at(-1)).toEqual({ type: "TrimEnd", args: { gapWord: WORDS[9].id }, mergeKey: null });
  });

  test("every former chip runs with the mouse", async ({ page }) => {
    await openEditor(page, CUT);
    const [coFirst, coLast] = coldOpenRange();
    const run = async (first, last, name) => {
      await selectRange(page, first, last);
      await wordAction(page, name);
      return (await commands(page)).at(-1);
    };
    expect(await run(0, 0, "Perpanjang ke sini")).toEqual({ type: "TrimStart", args: { gapWord: WORDS[0].id }, mergeKey: null });
    expect(await run(4, 5, "Pulihkan")).toMatchObject({ type: "RestoreRemoval", args: { removalId: CUT_REMOVAL } });
    expect(await run(6, 7, "Hapus")).toMatchObject({ type: "RemoveWords", args: { wordIds: ids(6, 7), reason: "user", origin: "user" } });
    expect(await run(3, 3, "Kata kunci")).toMatchObject({ type: "SetWordEmphasis", args: { wordId: WORDS[3].id, on: true } });
    expect(await run(3, 3, "Sembunyikan")).toMatchObject({ type: "SetWordHidden", args: { wordId: WORDS[3].id, on: true } });
    expect(await run(8, 9, "Mulai di sini")).toEqual({ type: "TrimStart", args: { gapWord: WORDS[8].id }, mergeKey: null });
    expect(await run(8, 9, "Akhiri di sini")).toEqual({ type: "TrimEnd", args: { gapWord: WORDS[9].id }, mergeKey: null });
    expect(await run(coFirst, coLast, "Jadikan cold open")).toEqual({ type: "SetColdOpen",
      args: { firstWord: WORDS[coFirst].id, lastWord: WORDS[coLast].id }, mergeKey: null });
    await run(10, 10, "Edit kata");
    const editor = transcript(page).locator("input[data-word-editor]");
    await expect(editor).toBeFocused();
    await expect(toolbar(page)).toHaveCount(0);
    await editor.fill("datangnya");
    await editor.press("Enter");
    expect((await commands(page)).at(-1)).toEqual({ type: "EditWordText", args: { wordId: WORDS[10].id, text: "datangnya" },
      mergeKey: `word:${WORDS[10].id}` });
  });

  test("every former chip runs with the keyboard", async ({ page }) => {
    await openEditor(page, CUT);
    const [coFirst, coLast] = coldOpenRange();
    await page.getByRole("tab", { name: "Transkrip" }).focus();
    for (let i = 0; i < 6 && !(await focused(page)).words; i += 1) await page.keyboard.press("Tab");
    await expect(wordList(page)).toBeFocused();
    const select = async (first, last) => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("ArrowRight");
      for (let i = 0; i < first; i += 1) await page.keyboard.press("ArrowRight");
      for (let i = first; i < last; i += 1) await page.keyboard.press("Shift+ArrowRight");
      await expect(transcript(page).locator("[data-selected]")).toHaveCount(last - first + 1);
    };
    const run = async (first, last, label) => {
      await select(first, last);
      await page.keyboard.press("Tab");
      await expect(toolbar(page).getByRole("button").first()).toBeFocused();
      for (let i = 0; i < 3; i += 1) {
        if ((await focused(page)).text === label) break;
        await page.keyboard.press("ArrowRight");
      }
      if ((await focused(page)).text !== label) {
        await page.keyboard.press("End");
        await page.keyboard.press("ArrowDown");
        for (let i = 0; i < 6 && !(await focused(page)).text.startsWith(label); i += 1) await page.keyboard.press("ArrowDown");
        expect((await focused(page)).text.startsWith(label)).toBe(true);
      }
      await page.keyboard.press("Enter");
      return (await commands(page)).at(-1);
    };
    expect(await run(0, 0, "Perpanjang ke sini")).toEqual({ type: "TrimStart", args: { gapWord: WORDS[0].id }, mergeKey: null });
    expect(await run(4, 5, "Pulihkan")).toMatchObject({ type: "RestoreRemoval", args: { removalId: CUT_REMOVAL } });
    expect(await run(6, 7, "Hapus")).toMatchObject({ type: "RemoveWords", args: { wordIds: ids(6, 7) } });
    await wordList(page).focus();
    expect(await run(3, 3, "Kata kunci")).toMatchObject({ type: "SetWordEmphasis", args: { wordId: WORDS[3].id } });
    expect(await run(3, 3, "Sembunyikan dari caption")).toMatchObject({ type: "SetWordHidden", args: { wordId: WORDS[3].id } });
    expect(await run(8, 9, "Mulai di sini")).toMatchObject({ type: "TrimStart", args: { gapWord: WORDS[8].id } });
    expect(await run(8, 9, "Akhiri di sini")).toMatchObject({ type: "TrimEnd", args: { gapWord: WORDS[9].id } });
    expect(await run(coFirst, coLast, "Jadikan cold open")).toMatchObject({ type: "SetColdOpen" });
    await run(10, 10, "Edit kata");
    const editor = transcript(page).locator("input[data-word-editor]");
    await expect(editor).toBeFocused();
    await page.keyboard.type("subuhnya");
    await page.keyboard.press("Enter");
    expect((await commands(page)).at(-1)).toMatchObject({ type: "EditWordText", args: { wordId: WORDS[10].id, text: "subuhnya" } });
  });

  test("QG-A11Y: axe finds no critical or serious violation with the toolbar and its menu open", async ({ page }) => {
    test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
    await openEditor(page, CUT);
    await selectRange(page, 3, 6);
    await toolbar(page).getByRole("button", { name: "Lainnya", exact: true }).click();
    await expect(toolbar(page).getByRole("menu", { name: "Lainnya" })).toBeVisible();
    await page.addScriptTag({ content: AXE });
    const blocking = await page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ["violations"] });
      return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
        .map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
    });
    expect(blocking).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// U1 and U2 of UJI-PENERIMAAN, scripted through the toolbar (§9.6). The fakes' clip is about
// 5 s long, so U2 cuts its second sentence (about 2 s) instead of a 5 s ramble; the transcript
// harness runs U2 on a long transcript.

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  test.describe(`scripted U-tests at ${size}`, () => {
    test.use({ viewport });

    test("U1 (scripted): a clipped first word comes back with the toolbar's Perpanjang ke sini ≤ 20 s", async ({ page }) => {
      await openEditor(page, TRIMMED);
      const started = Date.now();
      await expect(word(page, 0)).toHaveAttribute("data-zone", "before");
      await word(page, 0).click();
      await toolbar(page).getByRole("button", { name: "Perpanjang ke sini" }).click();
      const elapsedMs = Date.now() - started;
      expect((await commands(page)).at(-1)).toEqual({ type: "TrimStart", args: { gapWord: WORDS[0].id }, mergeKey: null });
      expect(elapsedMs).toBeLessThanOrEqual(20_000);
      writeGate(`D-U1-${size}.json`, { gate: "U1 scripted (toolbar)", viewport, limit_s: 20, elapsed_s: elapsedMs / 1000,
        user_actions: { clicks: 2 }, pass: elapsedMs <= 20_000 });
    });

    test("U2 (scripted): a sentence goes with the toolbar's Hapus ≤ 20 s", async ({ page }) => {
      await openEditor(page);
      const started = Date.now();
      await selectRange(page, 6, 11);
      await toolbar(page).getByRole("button", { name: "Hapus", exact: true }).click();
      const elapsedMs = Date.now() - started;
      expect((await commands(page)).at(-1)).toMatchObject({ type: "RemoveWords", args: { wordIds: ids(6, 11), reason: "user", origin: "user" } });
      await expect(wordList(page)).toBeFocused();
      expect(elapsedMs).toBeLessThanOrEqual(20_000);
      writeGate(`D-U2-${size}.json`, { gate: "U2 scripted (toolbar)", viewport, limit_s: 20, elapsed_s: elapsedMs / 1000,
        removed_ms: WORDS[11].e - WORDS[6].s, user_actions: { clicks: 3 }, pass: elapsedMs <= 20_000 });
    });
  });
}
