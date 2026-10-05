// Teks caption in Mode Cepat (docs/plans/2026-10-02-editor-mode-cepat.md §2, AC6, U8) on the
// editor fakes. The page runs the real store (commands, undo merging, autosave, the two-tab merge)
// over a fake server that the tabs of one browser context share through localStorage, and the
// fakes' engine-like cues (§2.6), so lines regroup as they do on the real stack.
//
// Prerequisites: a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1,
// E2E_USERNAME/E2E_PASSWORD, E2E_EDITOR_FAKES=1; AXE_CORE_PATH=<axe.min.js> for the axe check;
// EDITOR_GATES_OUT=<dir> receives the U8 timing and the axe result.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-quick-lines.spec.mjs'
import { expect, test as base } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { formatClock, frameToMs } from "../components/editor/shell-model.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { captionRows } from "../lib/editor/caption-lines.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { openCard } from "./support/editor-cards.mjs";
import { login, settings } from "./support/harness.mjs";

const LINES_URL = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=cepat`;
const SERVER_KEY = "potongin-e2e-caption-lines-server";
const WORDS = fakeWords();
const ID = WORDS.words.map((word) => word.id); // ID[0] "Kenapa" … ID[11] "subuh"
const CTX = createContext({ words: WORDS, seed: fakeDoc() });
const gatesOut = process.env.EDITOR_GATES_OUT || "";
const HIDDEN_NOTE = "Baris disembunyikan dari caption.";
const TOO_LONG = "Teks baru di satu tempat terlalu panjang (maks. 40 huruf). Persingkat tambahannya.";

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

function writeGate(name, value) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  writeFileSync(path.join(gatesOut, name), `${JSON.stringify(value, null, 2)}\n`);
}

// The clips the tests open, and their lines as the card should list them.
const boxDoc = () => {
  const doc = fakeDoc();
  doc.captions.pack = { id: "box", v: 1 };
  return doc;
};
const boldDoc = () => {
  const doc = fakeDoc();
  doc.captions.pack = { id: "bold", v: 1 };
  doc.captions.overrides.case = "upper";
  return doc;
};
const coldOpenDoc = () => applyCommand(fakeDoc(), "SetColdOpen", { firstWord: ID[6], lastWord: ID[8] }, CTX).doc;
const rowsOf = (doc) => captionRows({ plan: fakePlan(doc), doc, words: WORDS, model: buildTranscriptModel(WORDS, doc) });
const key = (index, seg = "seg_b1") => `${seg}:${ID[index]}`;

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The fake runtime passes its
// objects through window.__potonginEditorScenario: the API reads and writes one shared server in
// localStorage (so two tabs conflict and merge), and the store is the real one over the fakes.
function installLinesScenario(config) {
  const SERVER = "potongin-e2e-caption-lines-server";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  window.__potonginEditorScenario = {
    api(api, fakes) {
      const read = () => JSON.parse(window.localStorage.getItem(SERVER) ?? "null");
      const write = (value) => window.localStorage.setItem(SERVER, JSON.stringify(value));
      if (!read()) {
        const seed = config.doc ?? fakes.fakeDoc();
        const etag = fakes.fakeSha256(JSON.stringify(seed));
        write({ seed, seedEtag: etag, doc: seed, etag, receipts: {} });
      }
      return {
        ...api,
        async getEdit({ seed: wantSeed = false } = {}) {
          const server = read();
          const isSeed = wantSeed || server.doc.revision === 0;
          return {
            doc: clone(isSeed ? server.seed : server.doc), etag: isSeed ? server.seedEtag : server.etag, seed: isSeed,
            words: { sha256: server.seed.base.words.sha256, url: `/api/jobs/${fakes.FAKE_JOB_ID}/clips/${fakes.FAKE_CLIP_ID}/words` },
            readOnly: config.readOnly === true, readOnlyReason: config.readOnly === true ? "transcript_changed" : null,
          };
        },
        async putEdit(next, { etag, key }) {
          const server = read();
          if (server.receipts[key]) return clone(server.receipts[key]);
          if (etag !== server.etag || next.revision !== server.doc.revision + 1 || next.parent_sha256 !== server.etag) {
            throw new fakes.FakeApiError(409, "revision_conflict", { current: clone(server.doc), etag: server.etag });
          }
          const doc = clone(next);
          const result = { doc, etag: fakes.fakeSha256(JSON.stringify(doc)), warnings: [] };
          write({ ...server, doc, etag: result.etag, receipts: { ...server.receipts, [key]: result } });
          return clone(result);
        },
      };
    },
    store(store, fakes, parts) {
      store.destroy();
      // A long autosave keeps the pending steps inspectable; `flush()` saves on demand.
      const wait = config.autosaveMs;
      const autosave = wait ? { debounceMs: wait, maxIntervalMs: Math.max(wait, 10_000) } : {};
      return fakes.createRealEditorStore({ ...parts, autosave });
    },
  };
}

// ---------------------------------------------------------------------------------------------

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

async function openLines(page, config = {}) {
  await page.addInitScript(installLinesScenario, { autosaveMs: 600_000, ...config });
  await page.goto(LINES_URL);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const card = await openCard(page, "lines");
  await expect(card.locator("[data-line-key]").first()).toBeVisible();
  return card;
}

const field = (card, rowKey) => card.locator(`[data-line-key="${rowKey}"] input`);
const lineKeys = (card) => card.locator("[data-line-key]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-line-key")));
const lineTexts = (card) => card.locator("[data-line-key] input").evaluateAll((inputs) => inputs.map((input) => input.value));
const editor = (page) => page.evaluate(() => {
  const state = window.__potonginEditor.store.getState();
  return { status: state.status, save: state.save, revision: state.revision, canUndo: state.canUndo, edits: state.doc.captions.word_edits,
    cues: state.plan?.cues.map((cue) => cue.text) ?? [], steps: (state.commands ?? []).map(({ type, args }) => ({ type, args })) };
});
const undoButton = (page) => page.getByRole("button", { name: /^Urungkan/ });

async function commitLine(card, rowKey, text, keyName = "Enter") {
  const input = field(card, rowKey);
  await input.click();
  await input.fill(text);
  await input.press(keyName);
}

// ---------------------------------------------------------------------------------------------

test("every caption line of the plan is a field labelled by its time; the header counts them", async ({ page }) => {
  const card = await openLines(page);
  const rows = rowsOf(fakeDoc());
  const fps = fakeDoc().output.fps;
  expect(await lineKeys(card)).toEqual(rows.map((row) => row.key));
  expect(await lineTexts(card)).toEqual(["Kenapa sutradara ditahan di", "film sendiri?", "Jadi waktu itu kita", "datang subuh"]);
  for (const row of rows) {
    const input = card.getByLabel(formatClock(frameToMs(row.f0, fps)), { exact: true });
    await expect(input).toHaveValue(row.text);
    await expect(input).toHaveAttribute("maxlength", "160");
    await expect(input).toHaveAttribute("spellcheck", "false");
  }
  await expect(card.getByText("Ketik langsung untuk membetulkan kata. Waktunya tetap pas.")).toBeVisible();
  await expect(page.locator("#card-lines-button")).toContainText("4 baris");
});

test("U8: fix one word, Enter; the preview's caption shows it and Tersimpan follows", async ({ page }) => {
  const card = await openLines(page, { autosaveMs: 0 });
  const started = Date.now();
  await commitLine(card, key(0), "Kenapa sutradaranya ditahan di");
  await expect.poll(async () => (await editor(page)).cues[0]).toBe("Kenapa sutradaranya ditahan di");
  const previewMs = Date.now() - started;
  await expect.poll(async () => (await editor(page)).revision, { timeout: 20_000 }).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: /^Tersimpan/ })).toBeVisible();
  const savedMs = Date.now() - started;
  const state = await editor(page);
  expect(state.edits).toEqual({ [ID[1]]: { text: "sutradaranya" } });
  await expect(field(card, key(0))).toBeFocused();
  await expect(page.locator("#card-lines-button")).toContainText("4 baris · 1 diubah");
  expect(savedMs).toBeLessThan(20_000);
  writeGate("C-U8.json", {
    test: "U8 fix one caption word (Mode Cepat, Teks caption card)", limit_ms: 20_000, viewport: page.viewportSize(),
    preview_ms: previewMs, saved_ms: savedMs, autosave_debounce_ms: 1500, browser: page.context().browser()?.version() ?? null,
    note: "Scripted on the editor fakes with the real store; the owner's stopwatch run stays in UJI-PENERIMAAN.",
  });
});

test("insert, delete, and retype a deleted word: it comes back unhidden with its own timing", async ({ page }) => {
  const card = await openLines(page);
  await commitLine(card, key(6), "Jadi waktu itu kita ya");
  await expect.poll(async () => (await editor(page)).edits).toEqual({ [ID[9]]: { text: "kita ya" } });
  await commitLine(card, key(6), "Jadi itu kita ya");
  await expect.poll(async () => (await editor(page)).edits[ID[7]]).toEqual({ hidden: true });
  // The hidden word shifts the 4-word groups after it, so the line takes in "datang".
  await expect.poll(() => lineTexts(card)).toEqual(["Kenapa sutradara ditahan di", "film sendiri?", "Jadi itu kita ya datang", "subuh"]);
  await commitLine(card, key(6), "Jadi waktu itu kita ya datang");
  await expect.poll(async () => (await editor(page)).edits).toEqual({ [ID[9]]: { text: "kita ya" } });
  expect((await editor(page)).steps.at(-1)).toEqual({ type: "SetWordHidden", args: { wordId: ID[7], on: false } });
  expect((await editor(page)).steps.filter((step) => step.args?.wordId === ID[7]).map((step) => step.type),
    "no EditWordText for the retyped word").toEqual(["SetWordHidden", "SetWordHidden"]);
  await expect.poll(() => lineTexts(card)).toEqual(["Kenapa sutradara ditahan di", "film sendiri?", "Jadi waktu itu kita ya", "datang subuh"]);
});

test("an empty line hides it: the status says so, focus moves to a neighbour, one Urungkan brings it back", async ({ page }) => {
  const card = await openLines(page);
  await commitLine(card, key(10), "");
  await expect(card.locator(`[data-line-key="${key(10)}"]`)).toHaveCount(0);
  await expect(card.getByRole("status").filter({ hasText: HIDDEN_NOTE })).toBeVisible();
  await expect(field(card, key(6))).toBeFocused();
  expect((await editor(page)).edits).toEqual({ [ID[10]]: { hidden: true }, [ID[11]]: { hidden: true } });
  await undoButton(page).click();
  await expect(field(card, key(10))).toHaveValue("datang subuh");
  expect((await editor(page)).canUndo).toBe(false);
});

test("one commit is one Urungkan, however many words it changed", async ({ page }) => {
  const card = await openLines(page);
  await commitLine(card, key(0), "Yuk Kenapa sutradara ditahan");
  await expect.poll(async () => (await editor(page)).edits).toEqual({ [ID[0]]: { text: "Yuk Kenapa" }, [ID[3]]: { hidden: true } });
  await undoButton(page).click();
  await expect.poll(async () => (await editor(page)).edits).toEqual({});
  expect((await editor(page)).canUndo).toBe(false);
  await expect(field(card, key(0))).toHaveValue("Kenapa sutradara ditahan di");
});

test("a refusal keeps the draft, marks the field and dispatches nothing; Esc restores the line and keeps focus", async ({ page }) => {
  const card = await openLines(page);
  const input = field(card, key(0));
  const draft = "Kenapa sutradara ditahan di satu dua tiga empat lima enam tujuh delapan";
  await commitLine(card, key(0), draft);
  await expect(card.getByRole("alert")).toHaveText(TOO_LONG);
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAttribute("aria-describedby", /error$/);
  await expect(input).toHaveValue(draft);
  await expect(input).toBeFocused();
  const state = await editor(page);
  expect([state.edits, state.canUndo, state.steps]).toEqual([{}, false, []]);
  await input.press("Escape");
  await expect(input).toHaveValue("Kenapa sutradara ditahan di");
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(input).toBeFocused();
  await input.fill("Kenapa sutradara ditahan sini");
  await input.press("Escape");
  await input.blur();
  expect((await editor(page)).steps).toEqual([]);
});

test("Karaoke regrouping: a typed '.' splits the line and focus stays on it; a hidden first word moves focus to its line", async ({ page }) => {
  const card = await openLines(page);
  await commitLine(card, key(0), "Kenapa sutradara. ditahan di");
  await expect.poll(() => lineTexts(card)).toEqual(["Kenapa sutradara.", "ditahan di film sendiri?", "Jadi waktu itu kita", "datang subuh"]);
  await expect(field(card, key(0))).toBeFocused();
  await commitLine(card, key(2), "di film sendiri?");
  await expect.poll(() => lineKeys(card)).toEqual([key(0), key(3), key(6), key(10)]);
  await expect(field(card, key(3))).toBeFocused();
  await expect(field(card, key(3))).toHaveValue("di film sendiri?");
});

test("Box regrouping: Tab commits and moves on, and focus follows the next line's words when it splits", async ({ page }) => {
  const card = await openLines(page, { doc: boxDoc() });
  expect(await lineTexts(card)).toEqual(rowsOf(boxDoc()).map((row) => row.text));
  expect((await lineTexts(card)).slice(0, 2)).toEqual(["Kenapa sutradara ditahan", "di"]);
  await commitLine(card, key(0), "Kenapa sutradaranya ditahan", "Tab");
  await expect.poll(() => lineTexts(card)).toEqual(["Kenapa sutradaranya", "ditahan di", "film sendiri?", "Jadi waktu itu kita", "datang subuh"]);
  await expect(field(card, key(2))).toBeFocused();
  expect((await editor(page)).edits).toEqual({ [ID[1]]: { text: "sutradaranya" } });
});

test("a cold-open line and its body twin: editing either changes both", async ({ page }) => {
  const doc = coldOpenDoc();
  const card = await openLines(page, { doc });
  expect(await lineKeys(card)).toEqual(rowsOf(doc).map((row) => row.key));
  const cold = card.locator(`[data-line-key="${key(6, "seg_co")}"]`);
  await expect(cold).toContainText("Cold open");
  await expect(card.getByText("Cold open", { exact: true })).toHaveCount(1);
  await commitLine(card, key(6, "seg_co"), "Jadi waktu itu ya");
  await expect(field(card, key(6, "seg_co"))).toHaveValue("Jadi waktu itu ya");
  await expect(field(card, key(6))).toHaveValue("Jadi waktu itu ya kita");
  expect((await editor(page)).edits).toEqual({ [ID[8]]: { text: "itu ya" } });
});

test("Bold: the field shows the caption's upper case, and retyping it in capitals commits nothing", async ({ page }) => {
  const card = await openLines(page, { doc: boldDoc() });
  const input = field(card, key(0));
  await expect(input).toHaveCSS("text-transform", "uppercase");
  await expect(input).toHaveValue("Kenapa sutradara ditahan di");
  await commitLine(card, key(0), "KENAPA SUTRADARA DITAHAN DI");
  await input.blur();
  const state = await editor(page);
  expect([state.edits, state.canUndo]).toEqual([{}, false]);
});

test("focusing a line seeks the paused preview to it, and the line under the playhead is marked", async ({ page }) => {
  const card = await openLines(page);
  const rows = rowsOf(fakeDoc());
  await field(card, rows[2].key).focus();
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(rows[2].f0);
  await expect(card.locator(`[data-line-key="${rows[2].key}"]`)).toHaveAttribute("data-current", "true");
  await field(card, rows[2].key).blur();
  await page.evaluate((frame) => window.__potonginEditor.player.seek(frame), rows[1].f0 + 1);
  await expect(card.locator(`[data-line-key="${rows[1].key}"]`)).toHaveAttribute("data-current", "true");
  await expect(card.locator('[data-current="true"]')).toHaveCount(1);
});

test("two tabs editing different words of one line merge", async ({ page, context }) => {
  const cardA = await openLines(page);
  const second = await context.newPage();
  const cardB = await openLines(second);
  await commitLine(cardA, key(0), "Kenapa sutradaranya ditahan di");
  await page.evaluate(() => window.__potonginEditor.store.flush());
  await commitLine(cardB, key(0), "Kenapa sutradara ditahan di sini");
  await second.evaluate(() => window.__potonginEditor.store.flush().catch(() => null));
  const merged = { [ID[1]]: { text: "sutradaranya" }, [ID[3]]: { text: "di sini" } };
  await expect.poll(async () => {
    const state = await editor(second);
    return [state.save, state.edits];
  }, { timeout: 15_000 }).toEqual(["saved", merged]);
  await expect(field(cardB, key(0))).toHaveValue("Kenapa sutradaranya ditahan di sini");
  const server = await page.evaluate((name) => JSON.parse(window.localStorage.getItem(name)), SERVER_KEY);
  expect([server.doc.revision, server.doc.captions.word_edits]).toEqual([2, merged]);
  await second.close();
});

test("read-only: lines still seek, but they cannot be edited", async ({ page }) => {
  const card = await openLines(page, { readOnly: true });
  const rows = rowsOf(fakeDoc());
  const input = field(card, rows[1].key);
  await expect(input).toHaveAttribute("readonly", "");
  await input.focus();
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(rows[1].f0);
  await input.press("Backspace");
  await input.press("Enter");
  await expect(input).toHaveValue(rows[1].text);
  expect((await editor(page)).steps).toEqual([]);
});

test("captions off: the card says where to turn them on", async ({ page }) => {
  const card = await openLines(page);
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await expect(card.getByText("Caption mati. Nyalakan di kartu Caption.")).toBeVisible();
  await expect(card.locator("[data-line-key]")).toHaveCount(0);
});

for (const viewport of [{ width: 1366, height: 650 }, { width: 1920, height: 960 }]) {
  test(`QG-A11Y at ${viewport.width}×${viewport.height}: 44 px fields, a visible focus ring, no critical or serious axe finding`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const card = await openLines(page, { doc: coldOpenDoc() });
    const heights = await card.locator("[data-line-key] input").evaluateAll((inputs) => inputs.map((input) => input.getBoundingClientRect().height));
    expect(heights.length).toBe(5);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    await field(card, key(0)).focus();
    const ring = await card.locator(`[data-line-key="${key(0)}"]`).evaluate((row) => getComputedStyle(row).outlineStyle);
    expect(ring).not.toBe("none");
    test.skip(!AXE, "axe-core is not a web dependency: set AXE_CORE_PATH to an axe.min.js");
    await page.addScriptTag({ content: AXE });
    const blocking = await page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ["violations"] });
      return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
        .map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
    });
    writeGate(`C-QG-A11Y-${viewport.width}x${viewport.height}.json`, { viewport, card: "lines", fields: heights.length, min_height: Math.min(...heights), blocking });
    expect(blocking).toEqual([]);
  });
}
