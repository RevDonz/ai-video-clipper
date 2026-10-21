// Mode Lengkap's small edits (CONTRACTS §5.52), in the editor on its fakes: the 0.1 s nudge of a
// trim edge (handle keys and the timeline header's buttons) and of a cold-open edge, the
// "di sumber mm:ss" readout in the transport row, and Ctrl+click on a transcript word for Kata
// kunci. The fakes' store records every command it is sent, so each check reads that command.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-nudge.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { sourceClockAt } from "../components/editor/shell-model.mjs";
import { selectionActions } from "../components/editor/transcript/actions.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { extendTo, selectOne } from "../components/editor/transcript/selection.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=lengkap`;
const WORDS = fakeWords().words;

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.EDITOR_CHROME || process.env.PARITY_CHROME || defaultChrome();

/** The fakes' document with a cold open, from the real commands and the panel's own rules. */
function withColdOpen() {
  const doc = fakeDoc();
  const model = buildTranscriptModel(fakeWords(), doc);
  for (let first = 0; first < WORDS.length; first += 1) {
    for (let last = WORDS.length - 1; last >= first; last -= 1) {
      const actions = selectionActions(model, extendTo(selectOne(first), last));
      if (actions.coldOpen.enabled) {
        const ctx = createContext({ words: fakeWords(), seed: doc });
        return applyCommand(doc, "SetColdOpen", { firstWord: actions.coldOpen.firstWord, lastWord: actions.coldOpen.lastWord }, ctx).doc;
      }
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
    const failures = [];
    page.on("console", (message) => { if (message.type() === "error") failures.push(message.text()); });
    page.on("pageerror", (error) => failures.push(error.stack || error.message));
    await use(page);
    if (failures.length && testInfo.status === testInfo.expectedStatus) throw new Error(`Browser errors:\n${failures.join("\n")}`);
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

const lastCommand = (page) => page.evaluate(() => {
  const entry = window.__potonginEditor.store.getState().commands.at(-1);
  return entry ? { type: entry.type, args: entry.args } : null;
});
const commandCount = (page) => page.evaluate(() => window.__potonginEditor.store.getState().commands.length);
const word = (page, index) => page.locator(`[data-panel="transcript"] [data-w="${index}"]`);

test("the transport row shows the playhead's time in the source video", async ({ page }) => {
  await openEditor(page);
  const readout = page.getByTestId("stage-source-time");
  await expect(readout).toHaveText(`di sumber ${sourceClockAt(0, fakePlan(fakeDoc()))}`);
  await expect(readout).toHaveText(/^di sumber \d{2}:\d{2}$/);
  const before = await readout.textContent();
  await page.locator("[data-slot='transport']").getByRole("button", { name: "Putar" }).focus();
  await page.keyboard.press("Shift+ArrowRight"); // one second forward (a focused button keeps only Space)
  await expect(readout).not.toHaveText(before);
  // the clip time keeps its own testid and text
  await expect(page.getByTestId("stage-time")).toHaveText(/^00:01,\d \/ /);
});

test("Shift+arrows on a trim handle and the header's buttons nudge the selected edge by 0.1 s", async ({ page }) => {
  await openEditor(page);
  const nudge = page.getByRole("group", { name: "Geser tepi klip 0,1 detik" });
  await expect(nudge.getByRole("button", { name: "Pilih awal klip" })).toHaveAttribute("aria-pressed", "true");

  const end = page.getByRole("slider", { name: "Akhir klip" });
  await end.focus();
  await expect(nudge.getByRole("button", { name: "Pilih akhir klip" })).toHaveAttribute("aria-pressed", "true");
  await expect(end).toHaveAttribute("data-selected", "");
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "body", edge: "out", ms: -100 } });
  await page.keyboard.press("Shift+ArrowRight");
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "body", edge: "out", ms: 100 } });

  await nudge.getByRole("button", { name: "+0,1 dtk akhir klip" }).click();
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "body", edge: "out", ms: 100 } });
  await nudge.getByRole("button", { name: "Pilih awal klip" }).click();
  await nudge.getByRole("button", { name: "−0,1 dtk awal klip" }).click();
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "body", edge: "in", ms: -100 } });
  await expect(page.getByRole("slider", { name: "Awal klip" })).toHaveAttribute("data-selected", "");
  await expect(end).not.toHaveAttribute("data-selected", "");
});

test("the cold open's edges move by 0.1 s from the Cold open panel", async ({ page }) => {
  await openEditor(page, withColdOpen());
  await page.getByRole("tab", { name: "Cold open" }).click();
  const fine = page.getByRole("group", { name: "Geser tepi cold open 0,1 detik" });
  await fine.getByRole("button", { name: "Awal +0,1 dtk" }).click();
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "cold_open", edge: "in", ms: 100 } });
  await fine.getByRole("button", { name: "Akhir −0,1 dtk" }).click();
  expect(await lastCommand(page)).toEqual({ type: "NudgeEdge", args: { seg: "cold_open", edge: "out", ms: -100 } });
});

test("Ctrl+click on a word toggles Kata kunci without selecting it; a plain click still selects", async ({ page }) => {
  await openEditor(page);
  const target = word(page, 2);
  await expect(target).toHaveAttribute("title", /Ctrl\+klik: jadikan kata kunci/);
  await expect(page.locator('[data-panel="transcript"]')).toContainText("Ctrl+klik untuk kata kunci");
  const count = await commandCount(page);
  await target.click({ modifiers: ["Control"] });
  expect(await lastCommand(page)).toEqual({ type: "SetWordEmphasis", args: { wordId: WORDS[2].id, on: true } });
  expect(await commandCount(page)).toBe(count + 1);
  await expect(target).not.toHaveAttribute("data-selected", "");

  await target.click();
  await expect(target).toHaveAttribute("data-selected", "");
  expect(await commandCount(page), "a plain click sends no command").toBe(count + 1);
});
